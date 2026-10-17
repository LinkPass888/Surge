/*
 * Raccoon OpenAI Proxy for Surge
 * 把商汤小浣熊包装成 OpenAI 兼容 API
 * 主链路：/api/web/llm/v2（官方 LLM 网关，标准 OpenAI 格式，参考 Agent2API 实现）
 * 回退链路：/api/web/office/v3/chat-completions（网页版老接口，自定义 SSE）
 * by LinkPass888
 *
 * $argument: nation=86&phone=...&password=...&token=...
 * 填了 token 则跳过登录；否则用 phone+password 自动登录并缓存。
 */
const A = parseArg(typeof $argument === "string" ? $argument : "");
const AUTH = "https://xiaohuanxiong.com/api/web/auth/v1";
const LLM = "https://xiaohuanxiong.com/api/web/llm/v2";           // 新：官方 LLM 网关
const LEGACY = "https://xiaohuanxiong.com/api/web/office/v3/chat-completions"; // 老：网页版
const ENC_KEY = "senseraccoon2023";
const TS_KEY = "raccoon_openai_tokens";
const CAT_KEY = "raccoon_openai_catalog";
const CAT_TTL = 10 * 60 * 1000; // Agent2API 同款：10 分钟

// 静态兜底模型（来自 Agent2API FALLBACK_MODELS + 实测）
const FALLBACK_MODELS = [
  { id: "raccoon-8c4485", name: "Raccoon-Work" },
  { id: "raccoon-chat-ml-5-5", name: "Raccoon Chat (默认)" },
  { id: "raccoon-19b265", name: "Raccoon-Work-260817-A" },
  { id: "raccoon-405a1c", name: "Raccoon-Work-260817-B" },
  { id: "sn-sensenova-6-8-flash-lite", name: "SenseNova 6.8 Flash Lite" },
  { id: "sn-glm-5-3-flash", name: "GLM-5.3 Flash" },
];

/* ---------------- AES-128 加密（登录参数用，等价 CryptoJS AES-CFB） ---------------- */
function gfMul(a, b) {
  let r = 0;
  while (b) {
    if (b & 1) r ^= a;
    const hi = a & 0x80;
    a = (a << 1) & 0xff;
    if (hi) a ^= 0x1b;
    b >>= 1;
  }
  return r;
}
function gfInv(x) {
  if (!x) return 0;
  let r = 1;
  for (let e = 0; e < 8; e++) {
    if ((254 >> e) & 1) r = gfMul(r, x);
    x = gfMul(x, x);
  }
  return r;
}
function rotl(x, n) { return ((x << n) | (x >> (8 - n))) & 0xff; }
const SBOX = (function () {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const v = gfInv(i);
    s[i] = v ^ rotl(v, 1) ^ rotl(v, 2) ^ rotl(v, 3) ^ rotl(v, 4) ^ 0x63;
  }
  return s;
})();
function expandKey(k) {
  const w = new Uint8Array(176);
  w.set(k);
  let rcon = 1;
  for (let i = 16; i < 176; i += 4) {
    let t0 = w[i - 4], t1 = w[i - 3], t2 = w[i - 2], t3 = w[i - 1];
    if (i % 16 === 0) {
      const t = t0;
      t0 = SBOX[t1] ^ rcon; t1 = SBOX[t2]; t2 = SBOX[t3]; t3 = SBOX[t];
      rcon = gfMul(rcon, 2);
    }
    w[i] = w[i - 16] ^ t0; w[i + 1] = w[i - 15] ^ t1;
    w[i + 2] = w[i - 14] ^ t2; w[i + 3] = w[i - 13] ^ t3;
  }
  return w;
}
function encBlock(w, b) {
  for (let j = 0; j < 16; j++) b[j] ^= w[j];
  for (let round = 1; round <= 10; round++) {
    for (let j = 0; j < 16; j++) b[j] = SBOX[b[j]];
    let t = b[1]; b[1] = b[5]; b[5] = b[9]; b[9] = b[13]; b[13] = t;
    t = b[2]; b[2] = b[10]; b[10] = t; t = b[6]; b[6] = b[14]; b[14] = t;
    t = b[15]; b[15] = b[11]; b[11] = b[7]; b[7] = b[3]; b[3] = t;
    if (round < 10) {
      for (let c = 0; c < 4; c++) {
        const i = c * 4;
        const a0 = b[i], a1 = b[i + 1], a2 = b[i + 2], a3 = b[i + 3];
        const x = a0 ^ a1 ^ a2 ^ a3;
        b[i] ^= x ^ gfMul(a0 ^ a1, 2);
        b[i + 1] ^= x ^ gfMul(a1 ^ a2, 2);
        b[i + 2] ^= x ^ gfMul(a2 ^ a3, 2);
        b[i + 3] ^= x ^ gfMul(a3 ^ a0, 2);
      }
    }
    for (let j = 0; j < 16; j++) b[j] ^= w[round * 16 + j];
  }
}
function randomBytes(n) {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256);
  return a;
}
function utf8Bytes(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = s.charCodeAt(++i);
      c = 0x10000 | ((c - 0xd800) << 10) | (c2 - 0xdc00);
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}
// base64(iv || ciphertext)，等价 CryptoJS + pad.NoPadding
function encryptField(plain) {
  const key = expandKey(utf8Bytes(ENC_KEY));
  const pt = utf8Bytes(plain);
  const iv = randomBytes(16);
  const out = new Uint8Array(16 + pt.length);
  out.set(iv);
  let prev = iv;
  for (let off = 0; off < pt.length; off += 16) {
    const ks = prev.slice(0);
    encBlock(key, ks);
    const n = Math.min(16, pt.length - off);
    const ctBlock = new Uint8Array(16);
    for (let i = 0; i < n; i++) {
      ctBlock[i] = pt[off + i] ^ ks[i];
      out[16 + off + i] = ctBlock[i];
    }
    prev = ctBlock;
  }
  return b64(out);
}

/* ---------------- 工具 ---------------- */
function parseArg(s) {
  const o = {};
  s.split(/[&|]/).forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) {
      const k = p.slice(0, i).trim();
      const v = (p.slice(i + 1) || "").trim();
      if (v && v !== "none" && v !== "REPLACE_ME") o[k] = v;
    }
  });
  return o;
}
const B64T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function b64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    out += B64T[(n >> 18) & 63] + B64T[(n >> 12) & 63] +
      (i + 1 < bytes.length ? B64T[(n >> 6) & 63] : "=") +
      (i + 2 < bytes.length ? B64T[n & 63] : "=");
  }
  return out;
}
function jsonResp(status, obj) {
  $done({
    response: {
      status: status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(obj),
    },
  });
}
function errResp(status, message, type) {
  jsonResp(status, { error: { message: message, type: type || "raccoon_proxy_error" } });
}
function loadTokens() {
  try { return JSON.parse($persistentStore.read(TS_KEY) || "null"); } catch (e) { return null; }
}
function saveTokens(access, refresh) {
  $persistentStore.write(JSON.stringify({ access: access, refresh: refresh, at: Date.now() }), TS_KEY);
}

/* ---------------- 登录 / 刷新 ---------------- */
function login(cb) {
  if (!A.phone || !A.password) {
    cb(new Error("模块未配置 phone/password（或直接填 token）"), null);
    return;
  }
  const body = JSON.stringify({
    nation_code: A.nation || "86",
    phone: encryptField(A.phone),
    password: encryptField(A.password),
  });
  $httpClient.post(
    { url: AUTH + "/login_with_password", headers: { "Content-Type": "application/json" }, body: body },
    function (err, resp, data) {
      if (err) return cb(new Error("登录请求失败: " + err), null);
      let j;
      try { j = JSON.parse(data); } catch (e) { return cb(new Error("登录响应解析失败"), null); }
      if (!j.data || !j.data.access_token) {
        return cb(new Error("登录失败 " + (j.code || "") + ": " + (j.message || j.details || "未知错误")), null);
      }
      saveTokens(j.data.access_token, j.data.refresh_token || "");
      cb(null, j.data.access_token);
    }
  );
}
function refreshToken(cb) {
  const t = loadTokens();
  if (!t || !t.refresh) return login(cb);
  $httpClient.post(
    {
      url: AUTH + "/refresh",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: t.refresh }),
    },
    function (err, resp, data) {
      if (err) return login(cb);
      let j;
      try { j = JSON.parse(data); } catch (e) { return login(cb); }
      if (!j.data || !j.data.access_token) return login(cb);
      saveTokens(j.data.access_token, j.data.refresh_token || t.refresh);
      cb(null, j.data.access_token);
    }
  );
}
function ensureToken(cb) {
  if (A.token) return cb(null, A.token.replace(/^Bearer\s+/i, ""));
  const t = loadTokens();
  if (t && t.access) return cb(null, t.access);
  login(cb);
}

/* ---------------- 模型目录（llm/v2/model_catalog，参考 Agent2API models.rs） ---------------- */
function loadCatalog() {
  try { return JSON.parse($persistentStore.read(CAT_KEY) || "null"); } catch (e) { return null; }
}
// 解析目录：{data:{categories:[{models:[{name,displayName,...}]}]}}，name 是模型 id
function parseCatalog(payload) {
  const data = payload && payload.data && typeof payload.data === "object" ? payload.data : payload;
  const out = [];
  const seen = {};
  const cats = (data && data.categories) || [];
  for (const cat of cats) {
    for (const m of (cat && cat.models) || []) {
      const id = String((m && (m.name || m.model_name)) || "").trim();
      if (!id || seen[id]) continue;
      seen[id] = 1;
      out.push({ id: id, name: String((m && (m.displayName || m.description)) || id).slice(0, 64) });
    }
  }
  return out;
}
// cb(err, models)：缓存新鲜直接回，否则在线拉，失败回退缓存/静态兜底
function getCatalog(token, cb) {
  const cached = loadCatalog();
  if (cached && cached.models && cached.models.length && Date.now() - cached.at < CAT_TTL) {
    return cb(null, cached.models);
  }
  $httpClient.get(
    { url: LLM + "/model_catalog", headers: { Authorization: "Bearer " + token, Accept: "application/json" }, timeout: 15 },
    function (err, resp, data) {
      let models = [];
      if (!err && resp && resp.status === 200) {
        try { models = parseCatalog(JSON.parse(data)); } catch (e) { models = []; }
      }
      if (models.length) {
        $persistentStore.write(JSON.stringify({ models: models, at: Date.now() }), CAT_KEY);
        return cb(null, models);
      }
      // 拉取失败：有缓存用缓存，没有用静态兜底
      if (cached && cached.models && cached.models.length) return cb(null, cached.models);
      cb(null, FALLBACK_MODELS);
    }
  );
}

/* ---------------- 对话：llm/v2 主链路（标准 OpenAI 格式） ---------------- */
// 解析上游 SSE，兼容两种格式：
//   OpenAI（llm/v2）: data:{choices:[{delta:{content,reasoning_content},finish_reason}]}
//   老版（office/v3）: data:{status:{code},data:{choices:[{delta:"str",type:"text"|"think"}]}}
function parseUpstreamSSE(data) {
  const r = { content: "", reasoning: "", finish: "stop", usage: null, bizErr: null };
  for (const raw of (data || "").split("\n")) {
    const line = raw.trim();
    if (!line || line.indexOf("data:") !== 0) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") continue;
    let j;
    try { j = JSON.parse(payload); } catch (e) { continue; }
    if (j.usage) r.usage = j.usage;
    if (j.status && j.status.code) {
      r.bizErr = "上游业务错误 " + j.status.code + ": " + (j.message || j.status.msg || "");
      break;
    }
    const choice = (j.choices && j.choices[0]) || (j.data && j.data.choices && j.data.choices[0]);
    if (!choice) continue;
    const d = choice.delta;
    if (typeof d === "string") {
      if (choice.type === "think") r.reasoning += d;
      else r.content += d;
    } else if (d && typeof d === "object") {
      if (typeof d.content === "string") r.content += d.content;
      if (typeof d.reasoning_content === "string") r.reasoning += d.reasoning_content;
      if (typeof d.reasoning === "string") r.reasoning += d.reasoning;
    }
    if (choice.finish_reason) r.finish = choice.finish_reason === "sensitive" ? "content_filter" : choice.finish_reason;
  }
  return r;
}
// 组装 OpenAI 响应（model 回写成客户端请求值，参考 Agent2API sse_model_rewrite）
function emitResult(reqBody, parsed) {
  const id = "chatcmpl-raccoon-" + Date.now();
  const modelName = reqBody.model || "Office-Raccoon-Default";
  if (reqBody.stream) {
    const chunks = [];
    const push = (delta, fr) => {
      chunks.push("data: " + JSON.stringify({
        id: id, object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000), model: modelName,
        choices: [{ index: 0, delta: delta, finish_reason: fr || null }],
      }));
    };
    push({ role: "assistant", content: "" });
    if (parsed.reasoning) push({ reasoning_content: parsed.reasoning });
    const size = 48;
    for (let i = 0; i < parsed.content.length; i += size) push({ content: parsed.content.slice(i, i + size) });
    push({}, parsed.finish);
    if (parsed.usage) chunks.push("data: " + JSON.stringify({
      id: id, object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000), model: modelName,
      choices: [], usage: parsed.usage,
    }));
    chunks.push("");
    $done({
      response: {
        status: 200,
        headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "Connection": "keep-alive" },
        body: chunks.join("\n\n") + "\n\n",
      },
    });
  } else {
    jsonResp(200, {
      id: id, object: "chat.completion",
      created: Math.floor(Date.now() / 1000), model: modelName,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: parsed.content,
          reasoning_content: parsed.reasoning || undefined,
        },
        finish_reason: parsed.finish,
      }],
      usage: parsed.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }
}
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((p) => p && (p.type === "text" || typeof p.text === "string")).map((p) => p.text || "").join("\n");
  }
  return "";
}
// 主链路：llm/v2，OpenAI 兼容，body 原样透传（只强制 stream:true 由本脚本聚合）
function chatViaLLM(token, reqBody, retried, cb) {
  const upstream = {};
  for (const k in reqBody) upstream[k] = reqBody[k];
  upstream.stream = true;
  if (typeof upstream.max_tokens === "number") upstream.max_tokens = Math.min(upstream.max_tokens, 100000);
  $httpClient.post(
    {
      url: LLM + "/chat/completions",
      headers: { "Content-Type": "application/json", Accept: "*/*", Authorization: "Bearer " + token },
      body: JSON.stringify(upstream),
      timeout: 600,
    },
    function (err, resp, data) {
      if (err) return cb({ netErr: err });
      const status = resp ? resp.status : 0;
      if (status === 401 && !retried) return cb({ needRefresh: true });
      if (status !== 200) return cb({ httpErr: status, data: data });
      const parsed = parseUpstreamSSE(data);
      if (parsed.bizErr) return cb({ httpErr: 400, data: JSON.stringify({ message: parsed.bizErr }) });
      cb(null, parsed);
    }
  );
}
// 回退链路：office/v3 老接口（自定义 SSE + X-Org-Code）
function mapLegacyModel(m) {
  const k = (m || "").toLowerCase().replace(/[^a-z0-9.]/g, "");
  if (k.indexOf("glm") >= 0) return "glm5.3";
  if (k.indexOf("kimi") >= 0) return "kimi-k3";
  if (k.indexOf("deepseek") >= 0) return "DeepSeek4.1";
  if (k.indexOf("sensechat5vision") >= 0) return "SenseChat-5-Vision";
  if (k.indexOf("sensechat5") >= 0) return "SenseChat-5";
  return "Office-Raccoon-Default";
}
function chatViaLegacy(token, reqBody, cb) {
  const msgs = (reqBody.messages || [])
    .map((m) => ({ role: m.role, type: "text", content: textOf(m.content) }))
    .filter((m) => m.content.length > 0);
  if (!msgs.length) return cb({ httpErr: 400, data: '{"message":"messages 为空"}' });
  const upstream = {
    stream: true,
    max_new_tokens: Math.min(parseInt(reqBody.max_tokens, 10) || 2000, 8000),
    temperature: typeof reqBody.temperature === "number" ? reqBody.temperature : 0.6,
    messages: msgs,
    verbose: true,
    model: mapLegacyModel(reqBody.model),
  };
  $httpClient.post(
    {
      url: LEGACY,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token, "X-Org-Code": "" },
      body: JSON.stringify(upstream),
      timeout: 300,
    },
    function (err, resp, data) {
      if (err) return cb({ netErr: err });
      const status = resp ? resp.status : 0;
      if (status !== 200) return cb({ httpErr: status, data: data });
      cb(null, parseUpstreamSSE(data));
    }
  );
}
function describeErr(err) {
  if (err.netErr) return "网络错误 " + err.netErr;
  if (err.httpErr) return "HTTP " + err.httpErr;
  return "未知错误";
}
function chatCompletion(reqBody, stage, retried) {
  ensureToken(function (e, token) {
    if (e) return errResp(401, "小浣熊代理: " + e.message);
    chatViaLLM(token, reqBody, stage === "llm", function (err, parsed) {
      if (!err) return emitResult(reqBody, parsed);
      if (err.needRefresh) {
        return refreshToken(function (e2, t2) {
          if (e2) return errResp(401, "小浣熊代理: token 刷新失败，" + e2.message);
          chatCompletion(reqBody, "llm", true);
        });
      }
      // llm/v2 失败 → 回退老接口（业务配额错误除外：回退无意义且烧额度）
      const quotaHit = err.httpErr && /exceed_error|count_exceed|daily/i.test(err.data || "");
      if (stage !== "legacy" && !quotaHit) {
        chatViaLegacy(token, reqBody, function (e2, p2) {
          if (!e2) return emitResult(reqBody, p2);
          if (e2.httpErr) {
            let msg = e2.data || "";
            try { const j = JSON.parse(e2.data); msg = (j.error && (j.error.message || j.error.details)) || j.message || msg; } catch (x) {}
            return errResp(502, "llm/v2 " + describeErr(err) + "；office/v3 " + describeErr(e2) + ": " + msg);
          }
          errResp(502, "上游请求失败: " + describeErr(err) + " / " + describeErr(e2));
        });
        return;
      }
      if (err.httpErr) {
        let msg = err.data || "";
        try { const j = JSON.parse(err.data); msg = (j.error && (j.error.message || j.error.details)) || j.message || msg; } catch (x) {}
        return errResp(502, "上游 " + err.httpErr + ": " + msg);
      }
      errResp(502, "上游请求失败: " + describeErr(err));
    });
  });
}

/* ---------------- 签到（cron / GET /v1/checkin 触发，参考 Agent2API raccoon/balance.rs） ---------------- */
// 北京时间今天（上游自然日=UTC+8 零点，不跟设备时区）
function beijingToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
// 桌面客户端身份头（Agent2API desktop_client_headers 同款）
function desktopHeaders() {
  return { "X-Client-Platform": "desktop-windows", "X-Client-Version": "v1.0.0", "X-Raccoon-Language": "zh" };
}
function toastText(data) {
  if (!data) return "";
  const parts = [];
  for (const key of ["point_grant_toast", "point_grant_popups"]) {
    const v = data[key];
    if (v === undefined || v === null) continue;
    try { parts.push(typeof v === "string" ? v : JSON.stringify(v).slice(0, 200)); } catch (e) {}
  }
  return parts.join(" | ");
}
// 解包 {code,message,data} 的 GET/POST
function requestJson(method, path2, token, headers, timeout, cb) {
  const h = { Accept: "application/json", Authorization: "Bearer " + token };
  for (const k in headers) h[k] = headers[k];
  const opt = { url: "https://xiaohuanxiong.com" + path2, headers: h, timeout: timeout || 20 };
  const fn = method === "POST" ? $httpClient.post : $httpClient.get;
  fn(opt, function (err, resp, data) {
    if (err) return cb(new Error("网络失败: " + err), null);
    if (resp && resp.status === 401) return cb(new Error("登录态已过期（401）"), null);
    if (!resp || resp.status !== 200) return cb(new Error("HTTP " + (resp ? resp.status : 0)), null);
    let j;
    try { j = JSON.parse(data); } catch (e) { return cb(new Error("响应解析失败"), null); }
    if (typeof j.code === "number" && j.code !== 0) return cb(new Error(j.message || ("code=" + j.code)), null);
    cb(null, j.data !== undefined && j.data !== null ? j.data : j);
  });
}
// 每日签到：① setting_info 触发发放（按天幂等）② bills 核对今日入账 ③ balance 查总余额
function runCheckin(cb) {
  ensureToken(function (e, token) {
    if (e) return cb({ ok: false, title: "小浣熊签到失败", subtitle: e.message, body: "" });
    requestJson("GET", "/api/web/office/v3/setting_info", token, desktopHeaders(), 20, function (err1, info) {
      const grantNote = err1 ? ("发放接口: " + err1.message) : toastText(info);
      requestJson("GET", "/api/web/points/v1/bills?paging.limit=20&paging.offset=0", token, {}, 25, function (err2, bills) {
      let sum = 0;
      const names = [];
      const today = beijingToday();
      for (const it of (bills && bills.items) || []) {
        const pts = Number(it.points || 0);
        const createdAt = String(it.created_at || "");
        if (pts > 0 && createdAt.slice(0, 10) === today) {
          sum += pts;
          names.push((it.event_name || "积分") + " +" + pts);
        }
      }
      // ③ 总余额（失败降级，不影响签到结果）
      requestJson("GET", "/api/web/points/v1/balance", token, {}, 20, function (err3, bal) {
        const wallets = [];
        if (bal && typeof bal === "object") {
          for (const pair of [["daily_points", "每日"], ["monthly_points", "会员"], ["reward_points", "奖励"], ["topup_points", "充值"]]) {
            const v = Number(bal[pair[0]]);
            if (!isNaN(v)) wallets.push(pair[1] + " " + v);
          }
        }
        const avail = bal ? Number(bal.available_points) : NaN;
        const balanceLine = isNaN(avail)
          ? (err3 ? "余额查询失败: " + err3.message : "")
          : ("总余额 " + avail + "（" + wallets.join(" / ") + "）");
        const r = { ok: sum > 0, today: today, sum: sum, entries: names, balance: isNaN(avail) ? null : avail, wallets: wallets, grant_note: grantNote, err_grant: err1 && err1.message, err_bills: err2 && err2.message, err_balance: err3 && err3.message };
        if (sum > 0) {
          r.title = "小浣熊签到成功"; r.subtitle = "今日 +" + sum + " · " + (isNaN(avail) ? "余额未知" : "余额 " + avail);
          r.body = (names.join("；") + (balanceLine ? "；" + balanceLine : "")) + (grantNote ? "（" + grantNote + "）" : "");
        } else if (err1 && err2) {
          r.title = "小浣熊签到失败"; r.subtitle = "发放与账单查询均失败"; r.body = r.err_grant + "；" + r.err_bills;
        } else {
          r.title = "小浣熊签到"; r.subtitle = "账单未见今日入账" + (isNaN(avail) ? "" : " · 余额 " + avail);
          r.body = grantNote || (err2 ? "账单: " + r.err_bills : "可能今日已领过或发放延迟");
        }
        cb(r);
      });
      });
    });
  });
}

/* ---------------- 入口 ---------------- */
// cron / generic 手动运行：签到 + 系统通知（无 $request 环境）
if (typeof $request === "undefined" || !$request || !$request.url) {
  runCheckin(function (r) {
    $notification.post(r.title, r.subtitle, r.body || "");
    console.log("[raccoon-checkin] " + JSON.stringify(r));
    $done({});
  });
} else {
  const path = $request.url.split("?")[0];
  if (/\/checkin\/?$/.test(path)) {
    // 手动签到端点：GET /v1/checkin
    runCheckin(function (r) { jsonResp(200, r); });
  } else if (/\/models\/?$/.test(path)) {
  ensureToken(function (e, token) {
    if (e) {
      return jsonResp(200, {
        object: "list",
        data: FALLBACK_MODELS.map((m) => ({ id: m.id, object: "model", owned_by: "sensetime" })),
      });
    }
    getCatalog(token, function (e2, models) {
      jsonResp(200, {
        object: "list",
        data: (models.length ? models : FALLBACK_MODELS).map((m) => ({
          id: m.id, object: "model", owned_by: "sensetime",
          display_name: m.name || m.id,
        })),
      });
    });
  });
} else if (/\/chat\/completions\/?$/.test(path)) {
  let reqBody = null;
  try { reqBody = JSON.parse($request.body || "{}"); } catch (e) { reqBody = null; }
  if (!reqBody) errResp(400, "请求体不是合法 JSON");
  else chatCompletion(reqBody, "llm", false);
} else if (/\/probe\/?$/.test(path)) {
  ensureToken(function (e, token) {
    if (e) return errResp(401, "token: " + e.message);
    $httpClient.get(
      { url: LLM + "/model_catalog", headers: { Authorization: "Bearer " + token, Accept: "application/json" }, timeout: 15 },
      function (err, resp, data) {
        $done({
          response: {
            status: 200,
            headers: { "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify({
              http: resp ? resp.status : 0,
              token_head: token.slice(0, 12),
              body_head: String(data || err || "").slice(0, 3000),
            }),
          },
        });
      }
    );
  });
  } else {
    errResp(404, "Raccoon OpenAI Proxy: 支持 /v1/models、/v1/chat/completions、/v1/checkin、/v1/probe");
  }
}

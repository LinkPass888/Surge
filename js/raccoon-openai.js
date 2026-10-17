/*
 * Raccoon OpenAI Proxy for Surge (v3 · 真流式透传版)
 * 架构：http-request 脚本只改写请求（URL / Authorization / 模型名），
 * 上游 llm/v2 的标准 OpenAI SSE 流原生透传给客户端 —— 真流式，无聚合延迟。
 * /v1/models、/v1/checkin、/v1/probe 为本地应答（不需要流式）。
 * 参考 Agent2API（aimod-cc/Agent2API）racoon 适配器。
 * by LinkPass888
 *
 * $argument: nation=86&phone=...&password=...&token=...
 */
const A = parseArg(typeof $argument === "string" ? $argument : "");
const AUTH = "https://xiaohuanxiong.com/api/web/auth/v1";
const LLM = "https://xiaohuanxiong.com/api/web/llm/v2";
const ENC_KEY = "senseraccoon2023";
const TS_KEY = "raccoon_openai_tokens";
const CAT_KEY = "raccoon_openai_catalog";
const CAT_TTL = 10 * 60 * 1000;

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

/* ---------------- 登录 / 刷新 / 过期预检 ---------------- */
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
      timeout: 20,
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
// 解 JWT exp（不验签，仅读过期时间）；解析失败返回 0
function jwtExp(token) {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return 0;
    const b = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = b + "===".slice((b.length + 3) % 4);
    const json = decodeURIComponent(atob(pad).split("").map(function (c) {
      return "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(""));
    return Number(JSON.parse(json).exp || 0) * 1000;
  } catch (e) { return 0; }
}
// 确保有未过期的 token：直填 token 原样用；缓存 token 距过期 <2 分钟则先 refresh
function ensureToken(cb) {
  if (A.token) return cb(null, A.token.replace(/^Bearer\s+/i, ""));
  const t = loadTokens();
  if (!t || !t.access) return login(cb);
  const exp = jwtExp(t.access);
  if (exp && exp < Date.now() + 120000) return refreshToken(cb);
  cb(null, t.access);
}

/* ---------------- 模型目录（llm/v2/model_catalog） ---------------- */
function loadCatalog() {
  try { return JSON.parse($persistentStore.read(CAT_KEY) || "null"); } catch (e) { return null; }
}
function parseCatalog(payload) {
  const data = payload && payload.data && typeof payload.data === "object" ? payload.data : payload;
  const out = [];
  const seen = {};
  for (const cat of (data && data.categories) || []) {
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
      if (cached && cached.models && cached.models.length) return cb(null, cached.models);
      cb(null, FALLBACK_MODELS);
    }
  );
}
// 模型名归一化：友好名 → 真实 id；已在目录里的 id 原样透传
function mapModel(m) {
  const k = (m || "").toLowerCase().replace(/[^a-z0-9.]/g, "");
  if (!k) return "raccoon-chat-ml-5-5";
  if (k.indexOf("glm") >= 0) return "sn-glm-5-3-flash";
  if (k.indexOf("raccoon") >= 0 || k.indexOf("office") >= 0) {
    const cat = loadCatalog();
    if (cat && cat.models) {
      for (const mm of cat.models) if (mm.id.toLowerCase() === (m || "").toLowerCase()) return mm.id;
    }
    if (k === "officeraccoondefault") return "raccoon-chat-ml-5-5";
  }
  return m; // 其余原样透传（目录 id、kimi-k3 等由上游裁决）
}

/* ---------------- 签到（cron / GET /v1/checkin，参考 Agent2API raccoon/balance.rs） ---------------- */
function beijingToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
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
  if (/\/chat\/completions\/?$/.test(path)) {
    // ★ 真流式：只改写请求（URL → llm/v2 网关、Bearer token、模型名归一化），
    //   不返回 response —— 上游的标准 OpenAI SSE 流由 Surge 原生透传给客户端。
    //   token 过期在请求前预检（ensureToken），保证转发出去的一定有效。
    ensureToken(function (e, token) {
      if (e) return errResp(401, "小浣熊代理: " + e.message);
      let reqBody;
      try { reqBody = JSON.parse($request.body || "{}"); } catch (err) { return errResp(400, "请求体不是合法 JSON"); }
      reqBody.model = mapModel(reqBody.model);
      // stream 原样透传：客户端要流式给流式，要 JSON 给 JSON（llm/v2 是标准 OpenAI 网关）
      const headers = { "Content-Type": "application/json", Accept: "*/*", Authorization: "Bearer " + token };
      $done({
        url: LLM + "/chat/completions",
        headers: headers,
        body: JSON.stringify(reqBody),
      });
    });
  } else if (/\/models\/?$/.test(path)) {
    ensureToken(function (e, token) {
      if (e) {
        return jsonResp(200, {
          object: "list",
          data: FALLBACK_MODELS.map(function (m) { return { id: m.id, object: "model", owned_by: "sensetime" }; }),
        });
      }
      getCatalog(token, function (e2, models) {
        jsonResp(200, {
          object: "list",
          data: (models.length ? models : FALLBACK_MODELS).map(function (m) {
            return { id: m.id, object: "model", owned_by: "sensetime" };
          }),
        });
      });
    });
  } else if (/\/checkin\/?$/.test(path)) {
    runCheckin(function (r) { jsonResp(200, r); });
  } else if (/\/probe\/?$/.test(path)) {
    ensureToken(function (e, token) {
      if (e) return errResp(401, "token: " + e.message);
      $httpClient.get(
        { url: LLM + "/model_catalog", headers: { Authorization: "Bearer " + token, Accept: "application/json" }, timeout: 15 },
        function (err, resp, data) {
          jsonResp(200, {
            http: resp ? resp.status : 0,
            token_head: token.slice(0, 12),
            body_head: String(data || err || "").slice(0, 3000),
          });
        }
      );
    });
  } else {
    errResp(404, "Raccoon OpenAI Proxy: 支持 /v1/models、/v1/chat/completions、/v1/checkin、/v1/probe");
  }
}

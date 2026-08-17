/**
 * IKUUU 自动签到 + Cookie 自动更新 + 剩余流量通知
 */
const COOKIE_KEYS = ["email", "expire_in", "ip", "key", "uid", "_ga", "lang"];
const BASE_URL = "https://ikuuu.win";
const CHECKIN_URL = `${BASE_URL}/user/checkin`;
const USER_URL = `${BASE_URL}/user`;
const COOKIE_STORAGE_KEY = "IKU_COOKIE";
const EXPIRE_KEY = "IKU_EXPIRE";
const DEBUG = true;
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/27.0 Mobile/15E148 Safari/604.1";

const isRequest = typeof $request !== "undefined";

function parseCookie(header) {
  const result = {};
  String(header || "").split(";").forEach(pair => {
    const index = pair.indexOf("=");
    if (index < 0) return;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (COOKIE_KEYS.includes(key)) result[key] = value;
  });
  return result;
}

function debug(message) {
  if (DEBUG) console.log(`[IKUUU] ${message}`);
}

function decodePageBody(html) {
  if (!html || typeof html !== "string") return html;
  const match = html.match(/var\s+originBody\s*=\s*["']([^"']+)["']/i);
  if (!match) return html;
  try {
    return atob(match[1]);
  } catch (e) {
    debug(`originBody 解码失败: ${String(e)}`);
    return html;
  }
}

function getRemainingTraffic(html, resp) {
  html = decodePageBody(html);
  // IKUUU 页面还会调用 trafficDountChat(已用, 今日用, 剩余, ...)，第三个参数就是剩余流量
  const chart = html.match(/trafficDountChat\s*\(\s*["']([^"']+)["']\s*,\s*["'][^"']*["']\s*,\s*["']([^"']+)["']/i);
  if (chart) {
    debug(`通过 trafficDountChat 解析剩余流量: ${chart[2]}`);
    return chart[2];
  }
  if (!html || typeof html !== "string") {
    debug(`用户中心响应为空或类型错误: ${typeof html}`);
    return "获取失败";
  }
  debug(`用户中心响应: status=${resp ? resp.status : "unknown"}, bytes=${html.length}`);
  debug(`登录判定: ${/登录|login|auth\/login/i.test(html) ? "疑似未登录" : "已进入用户页"}`);
  debug(`流量关键词数量: ${(html.match(/剩余流量/g) || []).length}`);
  const match = html.match(/剩余流量[\s\S]{0,1500}?<span\s+[^>]*class\s*=\s*["'][^"']*\bcounter\b[^"']*["'][^>]*>\s*([0-9]+(?:\.[0-9]+)?)\s*<\/span>\s*([A-Za-z]+)?/i);
  if (!match) debug(`流量正则未匹配，片段: ${html.slice(Math.max(0, html.indexOf("剩余流量") - 50), html.indexOf("剩余流量") + 500)}`);
  return match ? `${match[1]} ${match[2] || "GB"}` : "获取失败";
}

function getCookieMessage() {
  const expire = Number($persistentStore.read(EXPIRE_KEY));
  if (!expire) return "未找到 Cookie 过期时间";
  const diff = expire * 1000 - Date.now();
  return diff < 0 ? "Cookie 已过期，请重新获取" : `Cookie 剩余 ${Math.ceil(diff / 3600000)} 小时`;
}

function commonHeaders(cookie) {
  return {
    "Cookie": cookie,
    "Referer": USER_URL,
    "Origin": BASE_URL,
    "User-Agent": UA,
    "X-Requested-With": "XMLHttpRequest",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
  };
}

if (isRequest) {
  const cookieHeader = $request.headers["Cookie"] || $request.headers["cookie"] || "";
  const cookieObj = parseCookie(cookieHeader);
  if (cookieObj.expire_in) $persistentStore.write(cookieObj.expire_in, EXPIRE_KEY);
  const cookie = Object.entries(cookieObj).map(([key, value]) => `${key}=${value}`).join("; ");
  if (cookie) {
    $persistentStore.write(cookie, COOKIE_STORAGE_KEY);
    $notification.post("IKUUU Cookie 已更新", "", cookie);
  }
  $done({});
} else {
  const cookie = $persistentStore.read(COOKIE_STORAGE_KEY);
  if (!cookie) {
    $notification.post("IKUUU 签到信息", "未找到 Cookie", "请访问一次 https://ikuuu.win/user 以自动抓取 Cookie");
    $done();
  }

  const headers = commonHeaders(cookie);
  const cookieMsg = getCookieMessage();

  function notify(checkinMsg, trafficMsg) {
    // 无论签到成功、已签到、失败，都统一包含当前剩余流量
    $notification.post("IKUUU 签到信息", checkinMsg, `${trafficMsg}\n${cookieMsg}`);
    $done();
  }

  function fetchTraffic(checkinMsg) {
    debug(`开始请求用户中心: ${USER_URL}`);
    debug(`Cookie 字段: ${cookie.split(";").map(x => x.split("=")[0]).join(",")}`);
    $httpClient.get({ url: USER_URL, headers }, (err, resp, html) => {
      if (err) debug(`用户中心请求错误: ${String(err)}`);
      if (resp) debug(`用户中心响应状态: ${resp.status}, headers=${JSON.stringify(resp.headers || {})}`);
      const traffic = err ? "获取失败（网络错误）" : getRemainingTraffic(html, resp);
      const trafficMsg = `剩余流量：${traffic}`;
      debug(`最终流量结果: ${trafficMsg}`);
      notify(checkinMsg, trafficMsg);
    });
  }

  $httpClient.post({ url: CHECKIN_URL, headers, body: "" }, (err, resp, data) => {
    debug(`签到请求: error=${err ? String(err) : "none"}, status=${resp ? resp.status : "unknown"}, response=${String(data || "").slice(0, 500)}`);
    let checkinMsg;
    if (err) {
      checkinMsg = "签到失败：网络错误";
    } else {
      try {
        const obj = JSON.parse(data);
        checkinMsg = obj.msg || JSON.stringify(obj);
      } catch (_) {
        checkinMsg = "签到失败：返回解析错误";
      }
    }
    // 签到请求结束后始终请求用户中心，避免遗漏“已签到”场景
    fetchTraffic(checkinMsg);
  });
}

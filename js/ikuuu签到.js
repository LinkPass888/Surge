/**
 * IKUUU 自动签到 + Cookie 自动更新 + 剩余流量通知
 */
const COOKIE_KEYS = ["email", "expire_in", "ip", "key", "uid", "_ga", "lang"];
const BASE_URL = "https://ikuuu.win";
const CHECKIN_URL = `${BASE_URL}/user/checkin`;
const USER_URL = `${BASE_URL}/user`;
const COOKIE_STORAGE_KEY = "IKU_COOKIE";
const EXPIRE_KEY = "IKU_EXPIRE";
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

function decodePageBody(html) {
  if (!html || typeof html !== "string") return html;
  const match = html.match(/var\s+originBody\s*=\s*["']([^"']+)["']/i);
  if (!match) return html;
  try {
    return atob(match[1]);
  } catch (_) {
    return html;
  }
}

function getRemainingTraffic(html) {
  html = decodePageBody(html);
  const chart = html.match(/trafficDountChat\s*\(\s*["'][^"']*["']\s*,\s*["'][^"']*["']\s*,\s*["']([^"']+)["']/i);
  if (chart) return chart[1];
  if (!html || typeof html !== "string") return "获取失败";
  const match = html.match(/剩余流量[\s\S]{0,1500}?<span\s+[^>]*class\s*=\s*["'][^"']*\bcounter\b[^"']*["'][^>]*>\s*([0-9]+(?:\.[0-9]+)?)\s*<\/span>\s*([A-Za-z]+)?/i);
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
    $httpClient.get({ url: USER_URL, headers }, (err, resp, html) => {
      const traffic = err ? "获取失败（网络错误）" : getRemainingTraffic(html);
      notify(checkinMsg, `剩余流量：${traffic}`);
    });
  }

  $httpClient.post({ url: CHECKIN_URL, headers, body: "" }, (err, resp, data) => {
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

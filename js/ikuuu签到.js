/**
 * IKUUU 自动签到 + Cookie 自动更新 + 剩余流量通知
 * 
 * 策略通过模块参数配置，在模块设置中编辑 policy 值
 */
const COOKIE_KEYS = ["email", "expire_in", "ip", "key", "uid", "session_version", "_ga", "lang"];
const BASE_URL = "https://ikuuu.bar";
const CHECKIN_URL = `${BASE_URL}/user/checkin`;
const USER_URL = `${BASE_URL}/user`;
const COOKIE_STORAGE_KEY = "IKU_COOKIE";
const EXPIRE_KEY = "IKU_EXPIRE";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/27.0 Mobile/15E148 Safari/604.1";

// 从模块参数读取策略名，默认"香港节点"
const POLICY_NAME = (typeof $argument !== "undefined" && $argument) ? $argument : "香港节点";

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
  const chart = html.match(/trafficDountChat\s*\(\s*["']([^"']+)["']\s*,\s*["'][^"']*["']\s*,\s*["']([^"']+)["']/i);
  if (chart) return chart[2];
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
    "Accept": "application/json, text/javascript, */*; q=0.01"
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
    $notification.post("IKUUU 签到信息", "未找到 Cookie", "请访问一次 https://ikuuu.bar/user 以自动抓取 Cookie");
    $done();
  }

  const headers = commonHeaders(cookie);
  const cookieMsg = getCookieMessage();

  function notify(checkinMsg, trafficMsg) {
    $notification.post("IKUUU 签到信息", checkinMsg, `${trafficMsg}\n${cookieMsg}`);
    $done();
  }

  function doCheckin() {
    const opts = { url: CHECKIN_URL, headers, body: "", timeout: 30, policy: POLICY_NAME };
    $httpClient.post(opts, (err, resp, data) => {
      let checkinMsg;
      if (err) {
        checkinMsg = "签到失败：网络错误";
      } else {
        const dataStr = String(data || "");
        if (dataStr.indexOf("<!DOCTYPE") >= 0 || dataStr.indexOf("<html") >= 0) {
          checkinMsg = "⚠️ Cookie 已失效，请重新访问 /user 页面";
        } else {
          try {
            const obj = JSON.parse(dataStr);
            checkinMsg = obj.msg || JSON.stringify(obj);
          } catch (_) {
            checkinMsg = "签到失败：返回解析错误";
          }
        }
      }
      fetchTraffic(checkinMsg);
    });
  }

  function fetchTraffic(checkinMsg) {
    const opts = { url: USER_URL, headers, timeout: 30, policy: POLICY_NAME };
    $httpClient.get(opts, (err, resp, html) => {
      const traffic = err ? "获取失败（网络错误）" : getRemainingTraffic(html);
      notify(checkinMsg, `剩余流量：${traffic}`);
    });
  }

  doCheckin();
}
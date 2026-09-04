/**
 * IKUUU 自动签到 + Cookie 自动更新 + 剩余流量通知
 */
const COOKIE_KEYS = ["email", "expire_in", "ip", "key", "uid", "session_version", "_ga", "lang"];
const BASE_URL = "https://ikuuu.bar";
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

// 动态获取 ikuuu.bar 的代理策略名
function getPolicyForIkuuu(callback) {
  // 方法1: 从最近请求中查找
  $httpAPI("GET", "/v1/requests/recent", null, function(result) {
    if (result && result.requests) {
      for (let i = 0; i < result.requests.length; i++) {
        const req = result.requests[i];
        if (req.URL && req.URL.indexOf("ikuuu.bar") >= 0 && req.policyName) {
          callback(req.policyName);
          return;
        }
      }
    }
    // 方法2: 从 select group decisions 中查找包含国外/代理关键词的策略组
    try {
      const details = $surge.selectGroupDetails();
      if (details && details.decisions) {
        const keywords = ["国外", "国际", "代理", "Proxy", "proxy", "GLOBAL"];
        const groups = Object.keys(details.decisions);
        for (let i = 0; i < groups.length; i++) {
          const groupName = groups[i];
          for (let j = 0; j < keywords.length; j++) {
            if (groupName.indexOf(keywords[j]) >= 0) {
              callback(details.decisions[groupName]);
              return;
            }
          }
        }
        // 方法3: 使用第一个非 DIRECT 的策略组
        for (let i = 0; i < groups.length; i++) {
          const policy = details.decisions[groups[i]];
          if (policy && policy !== "DIRECT" && policy !== "REJECT") {
            callback(policy);
            return;
          }
        }
      }
    } catch (_) {}
    callback(null);
  });
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

  function doCheckin(policyName) {
    const opts = { url: CHECKIN_URL, headers, body: "", timeout: 30 };
    if (policyName) opts.policy = policyName;

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
      fetchTraffic(checkinMsg, policyName);
    });
  }

  function fetchTraffic(checkinMsg, policyName) {
    const opts = { url: USER_URL, headers, timeout: 30 };
    if (policyName) opts.policy = policyName;

    $httpClient.get(opts, (err, resp, html) => {
      const traffic = err ? "获取失败（网络错误）" : getRemainingTraffic(html);
      notify(checkinMsg, `剩余流量：${traffic}`);
    });
  }

  getPolicyForIkuuu(function(policyName) {
    doCheckin(policyName);
  });
}
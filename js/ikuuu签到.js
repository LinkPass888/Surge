/**
 * IKUUU 自动签到 + Cookie 自动更新 + Cookie过期（小时）提醒（单通知整合）
 */

// ----------- 配置区 -----------
const COOKIE_KEYS = ["email", "expire_in", "ip", "key", "uid", "_ga", "lang"];
const CHECKIN_URL = "https://ikuuu.win/user/checkin";
const COOKIE_STORAGE_KEY = "IKU_COOKIE";
const EXPIRE_KEY = "IKU_EXPIRE";
// --------------------------------

const isRequest = typeof $request !== "undefined";

if (isRequest) {
  // ========【1. 捕获 Cookie】========
  let cookieHeader = $request.headers["Cookie"] || $request.headers["cookie"] || "";

  if (cookieHeader) {
    let cookieObj = {};
    cookieHeader.split(";").forEach(pair => {
      let [key, value] = pair.trim().split("=");
      if (COOKIE_KEYS.includes(key)) cookieObj[key] = value;
    });

    if (cookieObj.expire_in) {
      $persistentStore.write(cookieObj.expire_in, EXPIRE_KEY);
    }

    let cookieStr = Object.entries(cookieObj)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");

    if (cookieStr) {
      $persistentStore.write(cookieStr, COOKIE_STORAGE_KEY);
      $notification.post("IKUUU Cookie 已更新", "", cookieStr);
    }
  }
  $done({});
} else {
  // ========【2. 定时签到任务】========

  const cookie = $persistentStore.read(COOKIE_STORAGE_KEY);
  if (!cookie) {
    $notification.post("IKUUU 签到信息", "未找到 Cookie", "请访问一次 https://ikuuu.nl/user 以自动抓取 Cookie");
    $done();
  }

  // 计算 Cookie 剩余小时
  let cookieMsg = "";
  const expire = $persistentStore.read(EXPIRE_KEY);
  if (expire) {
    const expireTime = parseInt(expire, 10) * 1000;
    const now = Date.now();
    const diff = expireTime - now;

    if (diff < 0) {
      cookieMsg = "Cookie 已过期，请点击链接https://ikuuu.nl重新获取！";
    } else {
      const hours = Math.ceil(diff / 3600 / 1000);
      cookieMsg = `距离 Cookie 过期还有 ${hours} 小时！`;
    }
  } else {
    cookieMsg = "（未找到 Cookie 过期时间）";
  }

  // ========【3. 签到请求】========
  let headers = {
    "Cookie": cookie,
    "Referer": "https://ikuuu.win/user",
    "Origin": "https://ikuuu.win",
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)",
    "X-Requested-With": "XMLHttpRequest",
    "Accept": "application/json, text/javascript, */*; q=0.01"
  };

  $httpClient.post(
    {
      url: CHECKIN_URL,
      headers: headers,
      body: ""
    },
    function (err, resp, data) {
      let checkinMsg = "";

      if (err) {
        checkinMsg = "签到失败：网络错误";
      } else {
        try {
          const obj = JSON.parse(data);
          checkinMsg = obj.msg || JSON.stringify(obj);
        } catch (e) {
          checkinMsg = "签到失败：返回解析错误";
        }
      }

      // ==== 单条通知 ====
      $notification.post(
        "IKUUU 签到信息",
        checkinMsg,
        cookieMsg
      );

      $done();
    }
  );
}
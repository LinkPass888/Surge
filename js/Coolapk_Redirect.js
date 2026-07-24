const match = $request.url.match(/[?&](url|target)=([^&]+)/);

if (match) {
  // 返回 302 重定向到真正目标链接
  $done({
    status: 302,
    headers: {
      "Location": decodeURIComponent(match[2]),
      "Cache-Control": "no-cache"
    }
  });
} else {
  $done({});
}
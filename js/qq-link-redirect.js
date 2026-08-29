function decodeAll(s) {
    var cur = s, i = 0;
    while (i < 5) {
        var next;
        try { next = decodeURIComponent(cur); } catch (e) { break; }
        if (next === cur) break;
        cur = next; i++;
    }
    return cur;
}

var url = $request.url;
var target = null;
var m;

// 格式1：直接路径 c.pc.qq.com/<encoded_url>
m = /^https?:\/\/c\.pc\.qq\.com\/(https?%3A%2F%2F.+)$/i.exec(url);
if (m) target = decodeAll(m[1]);

// 格式2：参数格式 pfurl= / url=
if (!target) {
    m = /[?&](?:pfurl|url)=([^&]+)/.exec(url);
    if (m) target = decodeAll(m[1]);
}

if (target && /^https?:\/\//i.test(target)) {
    $done({
        response: {
            status: 302,
            headers: { Location: target }
        }
    });
} else {
    $done({}); // 放行
}
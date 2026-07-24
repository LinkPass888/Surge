// Sky: Children of the Light / 光·遇 排队响应修改脚本
// 作用：把排队接口返回的 "queue" 状态改为 "ok"，让客户端以为排队已通过
// 注意：这仅修改客户端看到的响应，实际能否进入游戏取决于服务器是否校验队列状态

let body = $response.body;

try {
    let obj = JSON.parse(body);

    if (obj && obj.text === "queue") {
        obj.ret = 0;
        obj.text = "ok";
        obj.pos = 0;
        obj.wait_time = 0;
        // seg_id 和 req_sn 保持原样，避免客户端校验失败
        console.log(`[Sky Queue Bypass] 已把排队响应改为通过：seg_id=${obj.seg_id}, req_sn=${obj.req_sn}`);
    }

    $done({ body: JSON.stringify(obj) });
} catch (e) {
    console.log("[Sky Queue Bypass] 解析响应失败：" + e.message);
    $done({});
}

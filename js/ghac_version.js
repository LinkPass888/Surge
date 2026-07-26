// 获取原始响应体
let body = $response.body;
let obj = JSON.parse(body);

// 修改 versionType 字段
if (obj.data && obj.data.versionType) {
    obj.data.versionType = "1"; 
    // 额外保险：如果你想彻底一点，可以把版本号改低或者清空下载链接
    obj.data.versionNo = "3.1.2";
    // obj.data.downloadUrl = "";
}

// 将修改后的对象转回字符串并返回
$done({ body: JSON.stringify(obj) });

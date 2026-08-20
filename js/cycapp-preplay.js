// CycApp pre_play response rewrite
// Only removes the server-provided pre-play advert configuration.
// It does not alter account privileges, payment status, or reward callbacks.

(function () {
  let body = $response.body;
  if (!body) {
    $done({});
    return;
  }

  try {
    const obj = JSON.parse(body);
    if (obj && obj.code === 0 && obj.data && Array.isArray(obj.data.list)) {
      obj.data.list = [];
      $done({ body: JSON.stringify(obj) });
    } else {
      $done({});
    }
  } catch (e) {
    $done({});
  }
})();

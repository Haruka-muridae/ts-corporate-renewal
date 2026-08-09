/*
 * Http.gs — 外部への HTTP
 *
 * ==================================================================
 * UrlFetchApp を触る唯一のファイル
 * ==================================================================
 * `Sheets.gs` が SpreadsheetApp を1か所に閉じているのと同じ理由。
 * その外は **`fetch` という関数**に対して書く。
 *
 * おかげで Threads.gs / X.gs は **実キー・実通信なしで検証できる。**
 * 投稿の失敗（401・429・5xx）は実物では起こしにくいので、
 * **差し替えられないと「失敗したときの振る舞い」を確かめられない。**
 *
 * ==================================================================
 * 返す形
 * ==================================================================
 *   { status: number, body: string, headers: object }
 *
 * **例外にしない。** 4xx・5xx も呼び出し側が読む。
 * `muteHttpExceptions: true` にしてあるのはそのため。
 * 投稿が失敗した理由を `posts.error` に残したいので、
 * 本文を読めないまま落とされると原因が分からなくなる。
 * ==================================================================
 */

/** 実際に通信する `fetch`。入口はこれを渡す。 */
function IssoHttp_fetch() {
  return function (request) {
    var options = {
      method: request.method || 'get',
      muteHttpExceptions: true,
      followRedirects: false
    };

    if (request.headers) {
      options.headers = request.headers;
    }

    if (request.payload !== undefined && request.payload !== null) {
      options.payload = request.payload;
    }

    if (request.contentType) {
      options.contentType = request.contentType;
    }

    var response = UrlFetchApp.fetch(request.url, options);

    return {
      status: response.getResponseCode(),
      body: response.getContentText(),
      headers: response.getAllHeaders()
    };
  };
}

/**
 * RFC 3986 のパーセントエンコード。
 *
 * **`encodeURIComponent` そのままでは足りない。**
 * `!` `*` `'` `(` `)` を残してしまうが、OAuth 1.0a の署名では
 * これらも符号化しなければならない（RFC 5849 §3.6）。
 * **1文字ずれるだけで署名が合わず、401 になる。**
 */
function IssoHttp_encode(value) {
  return encodeURIComponent(String(value === undefined || value === null ? '' : value))
    .replace(/[!'()*]/g, function (c) {
      return '%' + c.charCodeAt(0).toString(16).toUpperCase();
    });
}

/**
 * オブジェクトを `a=1&b=2` にする。
 *
 * **符号化してから並べ替える**（RFC 5849 §3.4.1.3.2）。
 * 生のキーで並べ替えると、符号化で順序が変わる文字（`~` や日本語）が
 * 混ざったときに署名が合わなくなる。**符号化前と後で順序が違いうる。**
 */
function IssoHttp_buildQuery(params) {
  var pairs = [];
  var key;

  for (key in params) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      pairs.push([IssoHttp_encode(key), IssoHttp_encode(params[key])]);
    }
  }

  pairs.sort(function (a, b) {
    if (a[0] !== b[0]) {
      return a[0] < b[0] ? -1 : 1;
    }

    if (a[1] === b[1]) {
      return 0;
    }

    return a[1] < b[1] ? -1 : 1;
  });

  var parts = [];

  for (var i = 0; i < pairs.length; i++) {
    parts.push(pairs[i][0] + '=' + pairs[i][1]);
  }

  return parts.join('&');
}

/**
 * JSON として読む。**読めなければ本文をそのまま返す。**
 *
 * 相手が HTML のエラーページを返すことがある（プロキシ・メンテナンス画面）。
 * そこで例外にすると、**本当の原因（HTMLが返ってきた）が見えなくなる。**
 */
function IssoHttp_json(body) {
  try {
    return JSON.parse(body);
  } catch (error) {
    return null;
  }
}

/**
 * 応答から人が読める失敗理由を作る。
 *
 * `posts.error` に入り、そのまま画面に出る。
 * **相手のエラー本文を捨てない**——言い換えるより原文のほうが直しやすい。
 */
function IssoHttp_errorMessage(response) {
  var data = IssoHttp_json(response.body);
  var detail = '';

  if (data) {
    /* Meta 系は error.message、X 系は detail / title に入る。 */
    if (data.error && data.error.message) {
      detail = data.error.message;
    } else if (data.detail) {
      detail = data.detail;
    } else if (data.title) {
      detail = data.title;
    } else if (data.errors && data.errors.length && data.errors[0].message) {
      detail = data.errors[0].message;
    }
  }

  if (detail === '') {
    /* 本文が長いことがあるので頭だけ。**全部捨てはしない。** */
    detail = String(response.body || '').slice(0, 300);
  }

  return 'HTTP ' + response.status + ': ' + detail;
}

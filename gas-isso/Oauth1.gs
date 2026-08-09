/*
 * Oauth1.gs — X 用の OAuth 1.0a 署名（RFC 5849）
 *
 * ==================================================================
 * なぜ OAuth 1.0a なのか
 * ==================================================================
 * X には OAuth 2.0（PKCE）もあるが、**認可のリダイレクトを受けるページと
 * リフレッシュトークンの管理**が要る。一想は GAS 上の個人ツールなので、
 * どちらも持ちたくない。
 *
 * OAuth 1.0a なら、**自分のアカウントのアクセストークンを開発者コンソールで
 * その場で発行でき、期限が無い**（手順書 §E-3）。
 * 署名は `Utilities.computeHmacSignature` で足りるため、
 * **外部ライブラリを足さずに済む**（[AGENTS.md](../AGENTS.md)）。
 *
 * ==================================================================
 * ここは1文字ずれると 401 になる
 * ==================================================================
 * 署名は「文字列をどう組み立てたか」がすべてで、**間違えても
 * 「署名が違う」としか言われない。** どこが違うかは教えてもらえない。
 *
 * したがって**組み立ての各段階を個別に検証できるよう関数を分けてある。**
 * まとめて1つにすると、401 が出たときに切り分けようがない。
 * ==================================================================
 */

/**
 * 署名の材料となる文字列（RFC 5849 §3.4.1.1）。
 *
 *   METHOD & encode(URL) & encode(パラメータをキー順に並べたもの)
 *
 * **URL のクエリと oauth_* をまとめて並べ替える。**
 * 本文が JSON の場合、本文は署名に含めない（X API v2 の投稿がこれ）。
 */
function IssoOauth1_baseString(method, url, params) {
  return [
    String(method).toUpperCase(),
    IssoHttp_encode(url),
    IssoHttp_encode(IssoHttp_buildQuery(params))
  ].join('&');
}

/**
 * 署名鍵。
 *
 * **どちらの秘密も符号化してから `&` で繋ぐ。**
 * トークン秘密が無い段階（リクエストトークンの取得）でも `&` は必要
 * ——空文字を繋ぐのであって、`&` を省くのではない。
 */
function IssoOauth1_signingKey(consumerSecret, tokenSecret) {
  return IssoHttp_encode(consumerSecret) + '&' + IssoHttp_encode(tokenSecret);
}

/**
 * 署名する。
 *
 * `Utilities.computeHmacSignature` はバイト配列を返すので base64 にする。
 * テストから差し替えられるよう、署名関数を引数で受けられるようにしてある。
 */
function IssoOauth1_sign(baseString, signingKey, hmacFn) {
  if (hmacFn) {
    return hmacFn(baseString, signingKey);
  }

  var bytes = Utilities.computeHmacSignature(
    Utilities.MacAlgorithm.HMAC_SHA_1, baseString, signingKey,
  );

  return Utilities.base64Encode(bytes);
}

/**
 * `Authorization` ヘッダーを作る。
 *
 * @param {string} method
 * @param {string} url           クエリを含まない URL
 * @param {object} queryParams   クエリ（無ければ {}）。**署名に含める**
 * @param {object} creds         apiKey / apiSecret / accessToken / accessTokenSecret
 * @param {{ nonce?: function, timestamp?: function, hmac?: function }} [deps]
 */
function IssoOauth1_header(method, url, queryParams, creds, deps) {
  deps = deps || {};

  var oauth = {
    oauth_consumer_key: creds.apiKey,
    oauth_token: creds.accessToken,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_version: '1.0',
    oauth_timestamp: deps.timestamp
      ? String(deps.timestamp())
      : String(Math.floor(new Date().getTime() / 1000)),
    /*
     * nonce は「同じ署名の使い回し」を防ぐための一度きりの値。
     * **時刻だけだと同じ秒に2回投稿したときに衝突する**ので UUID を使う。
     */
    oauth_nonce: deps.nonce ? deps.nonce() : Utilities.getUuid().replace(/-/g, '')
  };

  /* 署名の材料にはクエリも混ぜる（RFC 5849 §3.4.1.3）。 */
  var all = {};
  var key;

  for (key in queryParams) {
    if (Object.prototype.hasOwnProperty.call(queryParams, key)) {
      all[key] = queryParams[key];
    }
  }

  for (key in oauth) {
    if (Object.prototype.hasOwnProperty.call(oauth, key)) {
      all[key] = oauth[key];
    }
  }

  oauth.oauth_signature = IssoOauth1_sign(
    IssoOauth1_baseString(method, url, all),
    IssoOauth1_signingKey(creds.apiSecret, creds.accessTokenSecret),
    deps.hmac,
  );

  /*
   * ヘッダーには **oauth_* だけ**を入れる（クエリは入れない）。
   * 値は二重引用符で囲み、符号化する。
   */
  var names = [];

  for (key in oauth) {
    if (Object.prototype.hasOwnProperty.call(oauth, key)) {
      names.push(key);
    }
  }

  names.sort();

  var parts = [];

  for (var i = 0; i < names.length; i++) {
    parts.push(IssoHttp_encode(names[i]) + '="' + IssoHttp_encode(oauth[names[i]]) + '"');
  }

  return 'OAuth ' + parts.join(', ');
}

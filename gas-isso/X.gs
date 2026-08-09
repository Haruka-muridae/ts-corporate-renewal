/*
 * X.gs — X への投稿（手順書 §E）
 *
 * ==================================================================
 * 投稿ごとに発注者へ課金される
 * ==================================================================
 * **止められる場所を2つ持つ。**
 *   1. X 側の支出上限（手順書 §E-4。金額で止まる）
 *   2. 一想側の月次上限（`x.monthlyPostLimit`。**件数で止まる**）
 *
 * 2 を持つのは、**単価が変わっても件数の見込みは変わらない**ため、
 * および**外部サービスの設定だけに頼らない**ため。
 * 判定は `IssoPosts_requirePostable` が投稿前に行う。
 *
 * ==================================================================
 * 認証は OAuth 1.0a
 * ==================================================================
 * 理由は Oauth1.gs の冒頭。**本文は JSON で送るので署名には含めない**
 * （RFC 5849 は本文を含めるのを `application/x-www-form-urlencoded` の
 * ときに限っている）。ここを間違えると 401 になる。
 * ==================================================================
 */

var ISSO_X_API = 'https://api.x.com/2/tweets';

/**
 * X の本文上限。
 *
 * **日本語1文字も1として数えている。** X の実際の数え方（重み付け）とは
 * 違うが、**厳しい側に倒してある**ので、これを通れば実際にも通る。
 * 長すぎて弾かれるより、送る前に気づけるほうがよい。
 */
var ISSO_X_MAX_LENGTH = 280;

/**
 * 投稿する。
 *
 * @param {object} store
 * @param {string} versionId
 * @param {{ fetch: function, now?: function, uuid?: function, credentials?: object,
 *           nonce?: function, timestamp?: function, hmac?: function }} deps
 * @returns {object} posts の行
 */
function IssoX_post(store, versionId, deps) {
  deps = deps || {};

  var version = IssoPosts_requirePostable(store, versionId, ISSO_PLATFORM.X, deps);
  var text = String(version.body || '').replace(/^\s+|\s+$/g, '');

  if (text === '') {
    throw new Error('本文が空です。');
  }

  if (text.length > ISSO_X_MAX_LENGTH) {
    throw new Error(
      '本文が長すぎます（' + text.length + '字。上限 ' + ISSO_X_MAX_LENGTH + '字）。'
    );
  }

  var creds = deps.credentials || IssoX_credentials();

  var response = deps.fetch({
    method: 'post',
    url: ISSO_X_API,
    contentType: 'application/json',
    /* クエリは無いので、署名に混ぜるものも無い。 */
    headers: { Authorization: IssoOauth1_header('POST', ISSO_X_API, {}, creds, deps) },
    payload: JSON.stringify({ text: text })
  });

  if (response.status < 200 || response.status >= 300) {
    return IssoPosts_record(store, {
      theme_id: version.theme_id,
      version_id: versionId,
      platform: ISSO_PLATFORM.X,
      status: ISSO_STATUS.POST_FAILED,
      error: IssoX_explain(response)
    }, deps);
  }

  var data = IssoHttp_json(response.body);
  var id = data && data.data && data.data.id ? String(data.data.id) : '';

  return IssoPosts_record(store, {
    theme_id: version.theme_id,
    version_id: versionId,
    platform: ISSO_PLATFORM.X,
    status: ISSO_STATUS.POST_OK,
    /*
     * 自分のユーザー名を知らなくても開ける形。
     * X 側が正しい URL へ転送する。
     */
    url: id === '' ? '' : 'https://x.com/i/web/status/' + id
  }, deps);
}

/**
 * 失敗の理由に、**この道具でよくある原因**を添える。
 *
 * X のエラー本文は短く、原因が読み取りにくい。
 * とくに 403 は「権限を Read and write に変えた後にトークンを取り直していない」
 * ことがほとんどで、**手順書のどこへ戻ればよいかまで書く**と早く直せる。
 */
function IssoX_explain(response) {
  var message = IssoHttp_errorMessage(response);

  if (response.status === 401) {
    return message + '\n【よくある原因】キーとトークンの組み合わせ、'
      + 'または前後の空白。手順書 §E-3 を確認してください。';
  }

  if (response.status === 403) {
    return message + '\n【よくある原因】アプリの権限が Read only のままです。'
      + '手順書 §E-2 で Read and write に変えたうえで、**トークンを取り直して**ください'
      + '（権限変更前のトークンは読み取り専用のままです）。';
  }

  if (response.status === 429) {
    return message + '\n【よくある原因】投稿の頻度制限です。時間をおいてください。';
  }

  return message;
}

/** 今月の投稿状況（画面に出す）。 */
function IssoX_usage(store, deps) {
  deps = deps || {};

  var now = IssoConfig_now(deps.now);

  return {
    used: IssoPosts_countMonth(store, ISSO_PLATFORM.X, now),
    limit: IssoPosts_monthlyLimit(store),
    month: IssoPosts_monthKey(now)
  };
}

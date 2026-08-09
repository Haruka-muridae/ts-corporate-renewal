/*
 * Threads.gs — Threads への投稿（手順書 §D）
 *
 * ==================================================================
 * 開発モードのまま、自分のアカウントへ投稿する
 * ==================================================================
 * 第1段は App Review を通さない。**ロールを持つ自分のアカウントへは
 * 審査なしで投稿できる**という前提に立っている
 * （[docs/pipeline/threads-dev-mode-check.md] の D-4 で検証）。
 *
 * ==================================================================
 * 投稿は2段階
 * ==================================================================
 *   1. コンテナを作る   POST /{userId}/threads
 *   2. 公開する         POST /{userId}/threads_publish
 *
 * **1 で成功して 2 で失敗することがある。** そのときコンテナだけが残るが、
 * 公開されていないので実害は無い。**どちらで失敗したかを `posts.error` に残す**
 * ——「投稿できない」だけでは、権限の問題か本文の問題か切り分けられない。
 *
 * ==================================================================
 * トークンは60日で切れる
 * ==================================================================
 * 長期トークンでも期限がある。**投稿のたびに残りを気にしたくない**ので、
 * `IssoThreads_refreshToken()` を用意し、Script Properties を書き換える。
 * ==================================================================
 */

var ISSO_THREADS_API = 'https://graph.threads.net/v1.0';

/** Threads の本文上限。**送る前に弾く**（無駄な往復と課金を作らない）。 */
var ISSO_THREADS_MAX_LENGTH = 500;

/**
 * 投稿する。
 *
 * @param {object} store
 * @param {string} versionId
 * @param {{ fetch: function, now?: function, uuid?: function, credentials?: object }} deps
 * @returns {object} posts の行
 */
function IssoThreads_post(store, versionId, deps) {
  deps = deps || {};

  var version = IssoPosts_requirePostable(store, versionId, ISSO_PLATFORM.THREADS, deps);
  var text = String(version.body || '').replace(/^\s+|\s+$/g, '');

  if (text === '') {
    throw new Error('本文が空です。');
  }

  if (text.length > ISSO_THREADS_MAX_LENGTH) {
    throw new Error(
      '本文が長すぎます（' + text.length + '字。上限 ' + ISSO_THREADS_MAX_LENGTH + '字）。'
    );
  }

  var creds = deps.credentials || IssoThreads_credentials();
  var fetch = deps.fetch;

  /* --- 1. コンテナを作る --- */
  var created = fetch({
    method: 'post',
    url: ISSO_THREADS_API + '/' + encodeURIComponent(creds.userId) + '/threads',
    payload: {
      media_type: 'TEXT',
      text: text,
      access_token: creds.accessToken
    }
  });

  if (created.status < 200 || created.status >= 300) {
    return IssoPosts_record(store, {
      theme_id: version.theme_id,
      version_id: versionId,
      platform: ISSO_PLATFORM.THREADS,
      status: ISSO_STATUS.POST_FAILED,
      error: 'コンテナの作成に失敗しました。' + IssoHttp_errorMessage(created)
    }, deps);
  }

  var container = IssoHttp_json(created.body);

  if (container === null || !container.id) {
    return IssoPosts_record(store, {
      theme_id: version.theme_id,
      version_id: versionId,
      platform: ISSO_PLATFORM.THREADS,
      status: ISSO_STATUS.POST_FAILED,
      error: 'コンテナIDを受け取れませんでした。' + String(created.body).slice(0, 200)
    }, deps);
  }

  /* --- 2. 公開する --- */
  var published = fetch({
    method: 'post',
    url: ISSO_THREADS_API + '/' + encodeURIComponent(creds.userId) + '/threads_publish',
    payload: {
      creation_id: container.id,
      access_token: creds.accessToken
    }
  });

  if (published.status < 200 || published.status >= 300) {
    return IssoPosts_record(store, {
      theme_id: version.theme_id,
      version_id: versionId,
      platform: ISSO_PLATFORM.THREADS,
      status: ISSO_STATUS.POST_FAILED,
      /* **どちらで失敗したかを残す。** 権限の問題はここで出ることが多い。 */
      error: '公開に失敗しました（コンテナは作成済み）。' + IssoHttp_errorMessage(published)
    }, deps);
  }

  var result = IssoHttp_json(published.body) || {};

  return IssoPosts_record(store, {
    theme_id: version.theme_id,
    version_id: versionId,
    platform: ISSO_PLATFORM.THREADS,
    status: ISSO_STATUS.POST_OK,
    url: IssoThreads_permalink(result.id, creds, deps)
  }, deps);
}

/**
 * 投稿のURLを取る。**取れなくても投稿は成功している。**
 *
 * URL は「あとで見に行く」ためのものなので、
 * ここで失敗して投稿全体を失敗扱いにしない。
 */
function IssoThreads_permalink(mediaId, creds, deps) {
  if (!mediaId) {
    return '';
  }

  try {
    var response = deps.fetch({
      method: 'get',
      url: ISSO_THREADS_API + '/' + encodeURIComponent(mediaId)
        + '?fields=permalink&access_token=' + encodeURIComponent(creds.accessToken)
    });

    if (response.status < 200 || response.status >= 300) {
      return '';
    }

    var data = IssoHttp_json(response.body);

    return data && data.permalink ? String(data.permalink) : '';
  } catch (error) {
    return '';
  }
}

/**
 * 長期トークンを更新する（有効期限を延ばす）。
 *
 * **成功したら Script Properties を書き換える。**
 * 返り値は残り日数の目安。手順書 §D-3 の「60日」を自分で管理しないで済むようにする。
 *
 * > **60日を過ぎたトークンは更新できない。** その場合は手順書 §D-3 の
 * > 交換からやり直す（ここでは例外にして、その旨を伝える）。
 */
function IssoThreads_refreshToken(deps) {
  deps = deps || {};

  var creds = deps.credentials || IssoThreads_credentials();

  var response = deps.fetch({
    method: 'get',
    url: 'https://graph.threads.net/refresh_access_token'
      + '?grant_type=th_refresh_token'
      + '&access_token=' + encodeURIComponent(creds.accessToken)
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      'トークンを更新できませんでした。' + IssoHttp_errorMessage(response)
      + ' 期限が切れている場合は、手順書 §D-3 の交換からやり直してください。'
    );
  }

  var data = IssoHttp_json(response.body);

  if (data === null || !data.access_token) {
    throw new Error('新しいトークンを受け取れませんでした。');
  }

  var setProp = deps.setProp || IssoConfig_setProp;

  setProp('THREADS_ACCESS_TOKEN', data.access_token);

  return {
    refreshed: true,
    /* Meta は秒で返す。日に直しておくほうが判断しやすい。 */
    expiresInDays: data.expires_in ? Math.floor(Number(data.expires_in) / 86400) : 0
  };
}

/*
 * Threads / X への投稿の検証（実装順序7）。
 *
 * ==================================================================
 * 実キーも実通信も使わない
 * ==================================================================
 * `deps.fetch` を差し替える。おかげで**実物では起こしにくい失敗**
 * （401・403・429・コンテナは作れたが公開で失敗）まで確かめられる。
 *
 * ハーネスは `UrlFetchApp` を**用意していない**ので、差し替え忘れは
 * ReferenceError になって気づける。
 *
 * ==================================================================
 * 署名だけは本物を使う
 * ==================================================================
 * `Utilities.computeHmacSignature` はハーネスが Node の crypto で
 * 実装している。**偽物にすると「自分で決めた答えと一致するか」に
 * なってしまい、何も確かめられない。**
 *
 * ここで確かめたいのは HMAC そのものではなく、
 * **署名の材料をどう組み立てたか**（1文字ずれると 401 になる）。
 * ==================================================================
 */

import { createHmac } from 'node:crypto';

import { check, section, finish } from '../../public/apps/tests/helpers/assert.mjs';
import { loadIssoGas, createIssoStore } from '../helpers/isso-gas-harness.mjs';

function throws(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

function fixedDeps(prefix, isoNow) {
  let n = 0;

  return {
    uuid: () => `${prefix}${(n += 1)}`,
    now: () => isoNow || '2026-08-09T01:00:00.000Z',
    nonce: () => 'nonce123',
    timestamp: () => 1786000000,
  };
}

/** 応答を順に返す偽の fetch。送った内容も記録する。 */
function fakeFetch(responses) {
  const sent = [];
  let i = 0;

  const fetch = (request) => {
    sent.push(request);

    const next = responses[i];

    i += 1;

    if (next === undefined) {
      throw new Error(`想定より多く通信しました（${sent.length}回目）`);
    }

    return {
      status: next.status,
      body: typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {}),
      headers: {},
    };
  };

  fetch.sent = sent;

  return fetch;
}

const CREDS = {
  apiKey: 'consumer-key',
  apiSecret: 'consumer-secret',
  accessToken: 'access-token',
  accessTokenSecret: 'token-secret',
};

const THREADS_CREDS = {
  userId: '17841400000000000',
  accessToken: 'threads-token',
  appId: 'app-id',
  appSecret: 'app-secret',
};

const gas = loadIssoGas({ properties: { ISSO_SPREADSHEET_ID: 'sheet-abc' } });

/** 採用済みの版を1つ持つテーマを作る。 */
function themeWith(stage, body, deps) {
  const { store } = createIssoStore(gas);
  const theme = gas.IssoThemes_create(store, { source_text: '着想' }, deps);
  const order = ['threads', 'x', 'note', 'script', 'metadata'];

  /* 目的の段階まで、前段を採用しながら進む（採用しないと次段へ行けない）。 */
  for (const id of order) {
    const v = gas.IssoVersions_create(
      store, { theme_id: theme.theme_id, stage: id, body: id === stage ? body : id }, deps,
    );

    gas.IssoVersions_adopt(store, v.version_id);

    if (id === stage) {
      break;
    }
  }

  return { store, theme, version: gas.IssoVersions_getAdopted(store, theme.theme_id, stage) };
}

/* ================================================================ */
section('パーセントエンコード（RFC 3986）');

check('空白は %20', gas.IssoHttp_encode('a b') === 'a%20b');
check('**`!*\'()` も符号化する**（encodeURIComponent は残す）',
  gas.IssoHttp_encode("!*'()") === '%21%2A%27%28%29', gas.IssoHttp_encode("!*'()"));
check('**`~` は符号化しない**（非予約文字）', gas.IssoHttp_encode('~') === '~');
check('`-._` は符号化しない', gas.IssoHttp_encode('-._') === '-._');
check('`&` `=` は符号化する', gas.IssoHttp_encode('a&b=c') === 'a%26b%3Dc');
check('日本語も通る', gas.IssoHttp_encode('あ') === '%E3%81%82');
check('null は空', gas.IssoHttp_encode(null) === '');

/* ================================================================ */
section('クエリの組み立て');

check('キー順に並ぶ',
  gas.IssoHttp_buildQuery({ b: '2', a: '1' }) === 'a=1&b=2');

check('値も符号化される',
  gas.IssoHttp_buildQuery({ a: 'x y' }) === 'a=x%20y');

{
  /*
   * **符号化後の順序で並べる。** 生のキーだと `~` (0x7E) が `a` より後ろ、
   * 符号化しても `~` のままなので順序は変わらない——が、
   * `!` のように符号化で `%21` になる文字は順序が変わる。
   */
  const query = gas.IssoHttp_buildQuery({ '!a': '1', '0b': '2' });

  check('**符号化してから並べ替える**', query === '%21a=1&0b=2', query);
}

check('空なら空文字', gas.IssoHttp_buildQuery({}) === '');

/* ================================================================ */
section('OAuth 1.0a の署名');

{
  const base = gas.IssoOauth1_baseString('post', 'https://api.x.com/2/tweets', {
    oauth_consumer_key: 'ck',
    oauth_nonce: 'n',
  });

  check('**メソッドは大文字**', base.indexOf('POST&') === 0, base);
  check('URL が符号化される',
    base.indexOf('https%3A%2F%2Fapi.x.com%2F2%2Ftweets') > 0, base);
  check('パラメータは二重に符号化される（`=` が %3D）',
    base.indexOf('oauth_consumer_key%3Dck') > 0, base);
  check('区切りは3つ', base.split('&').length === 3, base);
}

{
  const key = gas.IssoOauth1_signingKey('cs', 'ts');

  check('秘密を & で繋ぐ', key === 'cs&ts');
  check('**トークン秘密が空でも & は残る**',
    gas.IssoOauth1_signingKey('cs', '') === 'cs&');
  check('秘密も符号化される', gas.IssoOauth1_signingKey('a b', 'c') === 'a%20b&c');
}

{
  /*
   * **独立に計算した署名と一致するか。**
   * 期待値はテスト側で「基準文字列を文字列リテラルで書き」、
   * Node の crypto で署名して作る。実装の組み立てを写していないので、
   * **組み立てを間違えれば落ちる。**
   */
  const url = 'https://api.x.com/2/tweets';

  const expectedBase = [
    'POST',
    encodeURIComponent(url),
    encodeURIComponent([
      'oauth_consumer_key=consumer-key',
      'oauth_nonce=nonce123',
      'oauth_signature_method=HMAC-SHA1',
      'oauth_timestamp=1786000000',
      'oauth_token=access-token',
      'oauth_version=1.0',
    ].join('&')),
  ].join('&');

  const expected = createHmac('sha1', 'consumer-secret&token-secret')
    .update(expectedBase, 'utf8')
    .digest('base64');

  const header = gas.IssoOauth1_header('POST', url, {}, CREDS, fixedDeps('s'));

  check('**独立に計算した署名と一致する**',
    header.indexOf('oauth_signature="' + encodeURIComponent(expected).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`) + '"') > 0,
    header);

  check('OAuth で始まる', header.indexOf('OAuth ') === 0);
  check('署名方式が入る', header.indexOf('oauth_signature_method="HMAC-SHA1"') > 0);
  check('版が入る', header.indexOf('oauth_version="1.0"') > 0);
  check('**クエリはヘッダーに入れない**', header.indexOf('text=') === -1);
}

{
  /* 1つでも変われば署名は変わる。**変わらなければ署名になっていない。** */
  const url = 'https://api.x.com/2/tweets';
  const base = gas.IssoOauth1_header('POST', url, {}, CREDS, fixedDeps('a'));

  check('同じ入力なら同じ署名',
    gas.IssoOauth1_header('POST', url, {}, CREDS, fixedDeps('b')) === base);

  check('**nonce が変われば署名も変わる**',
    gas.IssoOauth1_header('POST', url, {}, CREDS, {
      ...fixedDeps('c'), nonce: () => 'other',
    }) !== base);

  check('**時刻が変われば署名も変わる**',
    gas.IssoOauth1_header('POST', url, {}, CREDS, {
      ...fixedDeps('d'), timestamp: () => 1786000001,
    }) !== base);

  check('**秘密が変われば署名も変わる**',
    gas.IssoOauth1_header('POST', url, {}, { ...CREDS, apiSecret: 'x' }, fixedDeps('e')) !== base);

  check('**URL が変われば署名も変わる**',
    gas.IssoOauth1_header('POST', url + '2', {}, CREDS, fixedDeps('f')) !== base);

  check('**クエリがあれば署名に混ざる**',
    gas.IssoOauth1_header('POST', url, { a: '1' }, CREDS, fixedDeps('g')) !== base);
}

/* ================================================================ */
section('X へ投稿する');

{
  const deps = fixedDeps('x');
  const { store, version } = themeWith('x', 'X への投稿本文', deps);
  const fetch = fakeFetch([{ status: 201, body: { data: { id: '1900000000' } } }]);

  const post = gas.IssoX_post(store, version.version_id, {
    ...deps, fetch, credentials: CREDS,
  });

  check('成功が記録される', post.status === gas.ISSO_STATUS.POST_OK);
  check('URL が入る', post.url === 'https://x.com/i/web/status/1900000000', post.url);
  check('版に結び付く', post.version_id === version.version_id);
  check('テーマにも結び付く', post.theme_id !== '');

  const sent = fetch.sent[0];

  check('1回だけ通信する', fetch.sent.length === 1);
  check('POST する', sent.method === 'post');
  check('**本文は JSON で送る**', JSON.parse(sent.payload).text === 'X への投稿本文');
  check('Authorization が付く', sent.headers.Authorization.indexOf('OAuth ') === 0);
}

{
  const deps = fixedDeps('x4');
  const { store, version } = themeWith('x', '本文', deps);
  const fetch = fakeFetch([{
    status: 403,
    body: { detail: 'Your client app is not configured with the appropriate oauth1 app permissions' },
  }]);

  const post = gas.IssoX_post(store, version.version_id, { ...deps, fetch, credentials: CREDS });

  check('**失敗は例外にせず記録する**', post.status === gas.ISSO_STATUS.POST_FAILED);
  check('相手の理由をそのまま残す',
    post.error.indexOf('oauth1 app permissions') > 0, post.error);
  check('**403 は原因の心当たりを添える**',
    post.error.indexOf('Read and write') > 0, post.error);
  check('手順書のどこへ戻るかを書く', post.error.indexOf('§E-2') > 0, post.error);
  check('URL は空', post.url === '');
}

{
  const deps = fixedDeps('x1');
  const { store, version } = themeWith('x', '本文', deps);
  const fetch = fakeFetch([{ status: 401, body: { title: 'Unauthorized' } }]);
  const post = gas.IssoX_post(store, version.version_id, { ...deps, fetch, credentials: CREDS });

  check('401 にも心当たりを添える', post.error.indexOf('§E-3') > 0, post.error);
}

{
  const deps = fixedDeps('x9');
  const { store, version } = themeWith('x', '本文', deps);
  const fetch = fakeFetch([{ status: 429, body: {} }]);
  const post = gas.IssoX_post(store, version.version_id, { ...deps, fetch, credentials: CREDS });

  check('429 は頻度制限だと伝える', post.error.indexOf('頻度') > 0, post.error);
}

{
  const deps = fixedDeps('x5');
  const { store, version } = themeWith('x', '本文', deps);
  const fetch = fakeFetch([{ status: 500, body: '<html>メンテナンス中</html>' }]);
  const post = gas.IssoX_post(store, version.version_id, { ...deps, fetch, credentials: CREDS });

  check('**JSON でない応答でも落ちない**', post.status === gas.ISSO_STATUS.POST_FAILED);
  check('本文を捨てない', post.error.indexOf('メンテナンス中') > 0, post.error);
}

{
  const deps = fixedDeps('x6');
  const { store, version } = themeWith('x', 'あ'.repeat(281), deps);
  const fetch = fakeFetch([]);

  const error = throws(() => gas.IssoX_post(store, version.version_id, {
    ...deps, fetch, credentials: CREDS,
  }));

  check('**長すぎるものは送る前に弾く**', error instanceof Error);
  check('字数を伝える', String(error.message).indexOf('281字') > 0, String(error?.message));
  check('**通信していない**', fetch.sent.length === 0);
}

/* ================================================================ */
section('送る前に止める');

{
  const deps = fixedDeps('p1');
  const { store, theme } = themeWith('x', '本文', deps);

  /* 採用していない版を足す */
  const draft = gas.IssoVersions_create(
    store, { theme_id: theme.theme_id, stage: 'x', body: '下書き' }, deps,
  );

  const error = throws(() => gas.IssoX_post(store, draft.version_id, {
    ...deps, fetch: fakeFetch([]), credentials: CREDS,
  }));

  check('**採用していない案は投稿できない**', error instanceof Error);
  check('理由が分かる', String(error.message).includes('採用'), String(error?.message));
}

{
  const deps = fixedDeps('p2');
  const { store, version } = themeWith('threads', '本文', deps);

  const error = throws(() => gas.IssoX_post(store, version.version_id, {
    ...deps, fetch: fakeFetch([]), credentials: CREDS,
  }));

  check('**別の段階の版は投稿できない**', error instanceof Error);
  check('段階を伝える', String(error.message).indexOf('threads') > 0, String(error?.message));
}

{
  const deps = fixedDeps('p3');
  const { store, version } = themeWith('x', '本文', deps);
  const fetch = fakeFetch([
    { status: 201, body: { data: { id: '1' } } },
    { status: 201, body: { data: { id: '2' } } },
  ]);

  gas.IssoX_post(store, version.version_id, { ...deps, fetch, credentials: CREDS });

  const error = throws(() => gas.IssoX_post(store, version.version_id, {
    ...deps, fetch, credentials: CREDS,
  }));

  check('**同じ版を二度投稿しない**（二度押しの事故）', error instanceof Error);
  check('いつ投稿したかを伝える',
    String(error.message).indexOf('投稿済み') > 0, String(error?.message));
  check('**2回目は通信しない**', fetch.sent.length === 1);
}

check('無い版は落ちる', throws(() => {
  const { store } = createIssoStore(gas);
  gas.IssoX_post(store, 'ver_none', { fetch: fakeFetch([]), credentials: CREDS });
}) instanceof Error);

/* ================================================================ */
section('X の月次上限（課金の歯止め）');

check('既定は60件', gas.ISSO_DEFAULT_SETTINGS['x.monthlyPostLimit'] === '60');

{
  const { store } = createIssoStore(gas);

  check('設定から読める', gas.IssoPosts_monthlyLimit(store) === 60);

  gas.IssoSettings_set(store, 'x.monthlyPostLimit', '5');
  check('変えられる', gas.IssoPosts_monthlyLimit(store) === 5);

  gas.IssoSettings_set(store, 'x.monthlyPostLimit', '1,000');
  check('桁区切りも読める', gas.IssoPosts_monthlyLimit(store) === 1000);

  gas.IssoSettings_set(store, 'x.monthlyPostLimit', '0');
  check('**0 にすると投稿を止められる**', gas.IssoPosts_monthlyLimit(store) === 0);

  gas.IssoSettings_set(store, 'x.monthlyPostLimit', 'むせいげん');
  check('**読めない値は0として扱う**（課金に関わる値は緩む側へ倒さない）',
    gas.IssoPosts_monthlyLimit(store) === 0);

  gas.IssoSettings_set(store, 'x.monthlyPostLimit', '-5');
  check('負の値も0', gas.IssoPosts_monthlyLimit(store) === 0);
}

check('月を取り出せる', gas.IssoPosts_monthKey('2026-08-09T01:00:00.000Z') === '2026-08');
check('読めなければ空', gas.IssoPosts_monthKey('なにか') === '');

{
  const deps = fixedDeps('l');
  const { store, theme, version } = themeWith('x', '本文', deps);

  gas.IssoSettings_set(store, 'x.monthlyPostLimit', '2');

  /* 先月の投稿は数えない */
  gas.IssoPosts_record(store, {
    theme_id: theme.theme_id, version_id: 'ver_old', platform: 'x',
    status: gas.ISSO_STATUS.POST_OK,
  }, { ...deps, now: () => '2026-07-31T23:59:59.000Z' });

  check('**先月の分は数えない**',
    gas.IssoPosts_countMonth(store, 'x', '2026-08-09T00:00:00.000Z') === 0);

  /* 今月の失敗も数える */
  gas.IssoPosts_record(store, {
    theme_id: theme.theme_id, version_id: 'ver_a', platform: 'x',
    status: gas.ISSO_STATUS.POST_FAILED, error: 'なにか',
  }, deps);

  check('**失敗も数える**（課金はリクエストで発生しうる）',
    gas.IssoPosts_countMonth(store, 'x', '2026-08-09T00:00:00.000Z') === 1);

  gas.IssoPosts_record(store, {
    theme_id: theme.theme_id, version_id: 'ver_b', platform: 'x',
    status: gas.ISSO_STATUS.POST_OK,
  }, deps);

  const fetch = fakeFetch([]);
  const error = throws(() => gas.IssoX_post(store, version.version_id, {
    ...deps, fetch, credentials: CREDS,
  }));

  check('**上限に達したら投稿できない**', error instanceof Error);
  check('残数を伝える', String(error.message).indexOf('2/2件') > 0, String(error?.message));
  check('設定名を伝える',
    String(error.message).indexOf('x.monthlyPostLimit') > 0, String(error?.message));
  check('**通信していない**', fetch.sent.length === 0);
}

{
  /* Helper への引き渡しは外部通信ではないので数えない。 */
  const deps = fixedDeps('h');
  const { store, theme } = themeWith('x', '本文', deps);

  gas.IssoPosts_record(store, {
    theme_id: theme.theme_id, version_id: 'ver_n', platform: 'note',
    status: gas.ISSO_STATUS.POST_HANDED_TO_HELPER,
  }, deps);

  check('**note の引き渡しは X の件数に入らない**',
    gas.IssoPosts_countMonth(store, 'x', '2026-08-09T00:00:00.000Z') === 0);
}

{
  const deps = fixedDeps('t2');
  const { store, version } = themeWith('threads', '本文', deps);
  const fetch = fakeFetch([
    { status: 200, body: { id: 'c1' } },
    { status: 200, body: { id: 'm1' } },
    { status: 200, body: { permalink: 'https://www.threads.net/@me/post/abc' } },
  ]);

  gas.IssoSettings_set(store, 'x.monthlyPostLimit', '0');

  const post = gas.IssoThreads_post(store, version.version_id, {
    ...deps, fetch, credentials: THREADS_CREDS,
  });

  check('**X の上限は Threads を止めない**（課金が発生するのは X だけ）',
    post.status === gas.ISSO_STATUS.POST_OK);
}

/* ================================================================ */
section('Threads へ投稿する');

{
  const deps = fixedDeps('t');
  const { store, version } = themeWith('threads', 'Threads への投稿', deps);
  const fetch = fakeFetch([
    { status: 200, body: { id: 'container-1' } },
    { status: 200, body: { id: 'media-1' } },
    { status: 200, body: { permalink: 'https://www.threads.net/@me/post/abc' } },
  ]);

  const post = gas.IssoThreads_post(store, version.version_id, {
    ...deps, fetch, credentials: THREADS_CREDS,
  });

  check('成功が記録される', post.status === gas.ISSO_STATUS.POST_OK);
  check('パーマリンクが入る',
    post.url === 'https://www.threads.net/@me/post/abc', post.url);

  check('**3回通信する**（コンテナ・公開・URL取得）', fetch.sent.length === 3);
  check('1回目はコンテナ', fetch.sent[0].url.indexOf('/threads') > 0);
  check('本文を渡す', fetch.sent[0].payload.text === 'Threads への投稿');
  check('種別は TEXT', fetch.sent[0].payload.media_type === 'TEXT');
  check('2回目は公開', fetch.sent[1].url.indexOf('/threads_publish') > 0);
  check('**コンテナIDを渡す**', fetch.sent[1].payload.creation_id === 'container-1');
}

{
  const deps = fixedDeps('t3');
  const { store, version } = themeWith('threads', '本文', deps);
  const fetch = fakeFetch([{ status: 400, body: { error: { message: '権限がありません' } } }]);

  const post = gas.IssoThreads_post(store, version.version_id, {
    ...deps, fetch, credentials: THREADS_CREDS,
  });

  check('コンテナ作成の失敗を記録する', post.status === gas.ISSO_STATUS.POST_FAILED);
  check('**どちらで失敗したかを残す**',
    post.error.indexOf('コンテナの作成に失敗') === 0, post.error);
  check('相手の理由も残す', post.error.indexOf('権限がありません') > 0, post.error);
  check('**公開までは進まない**', fetch.sent.length === 1);
}

{
  const deps = fixedDeps('t4');
  const { store, version } = themeWith('threads', '本文', deps);
  const fetch = fakeFetch([
    { status: 200, body: { id: 'container-2' } },
    { status: 403, body: { error: { message: 'publishing limit' } } },
  ]);

  const post = gas.IssoThreads_post(store, version.version_id, {
    ...deps, fetch, credentials: THREADS_CREDS,
  });

  check('公開の失敗を記録する', post.status === gas.ISSO_STATUS.POST_FAILED);
  check('**コンテナは作れていたと分かる**',
    post.error.indexOf('コンテナは作成済み') > 0, post.error);
}

{
  const deps = fixedDeps('t5');
  const { store, version } = themeWith('threads', '本文', deps);
  const fetch = fakeFetch([
    { status: 200, body: { id: 'c' } },
    { status: 200, body: { id: 'm' } },
    { status: 500, body: {} },
  ]);

  const post = gas.IssoThreads_post(store, version.version_id, {
    ...deps, fetch, credentials: THREADS_CREDS,
  });

  check('**URL が取れなくても投稿は成功**', post.status === gas.ISSO_STATUS.POST_OK);
  check('URL は空になる', post.url === '');
}

{
  const deps = fixedDeps('t6');
  const { store, version } = themeWith('threads', 'あ'.repeat(501), deps);
  const fetch = fakeFetch([]);

  const error = throws(() => gas.IssoThreads_post(store, version.version_id, {
    ...deps, fetch, credentials: THREADS_CREDS,
  }));

  check('**上限500字を超えたら送る前に弾く**', error instanceof Error);
  check('通信していない', fetch.sent.length === 0);
}

{
  const deps = fixedDeps('t7');
  const { store, version } = themeWith('threads', '   ', deps);

  const error = throws(() => gas.IssoThreads_post(store, version.version_id, {
    ...deps, fetch: fakeFetch([]), credentials: THREADS_CREDS,
  }));

  check('空白だけの本文は弾く', error instanceof Error);
}

/* ================================================================ */
section('Threads のトークン更新');

{
  const saved = {};
  const fetch = fakeFetch([{
    status: 200, body: { access_token: 'new-token', expires_in: 5184000 },
  }]);

  const result = gas.IssoThreads_refreshToken({
    fetch,
    credentials: THREADS_CREDS,
    setProp: (name, value) => { saved[name] = value; },
  });

  check('更新できる', result.refreshed === true);
  check('**残り日数が分かる**（60日）', result.expiresInDays === 60, String(result.expiresInDays));
  check('**Script Properties を書き換える**', saved.THREADS_ACCESS_TOKEN === 'new-token');
  check('更新の要求を送る', fetch.sent[0].url.indexOf('th_refresh_token') > 0);
}

{
  const fetch = fakeFetch([{ status: 400, body: { error: { message: 'expired' } } }]);

  const error = throws(() => gas.IssoThreads_refreshToken({
    fetch, credentials: THREADS_CREDS, setProp: () => {},
  }));

  check('失敗すれば例外', error instanceof Error);
  check('**やり直し方を伝える**',
    String(error.message).indexOf('§D-3') > 0, String(error?.message));
}

/* ================================================================ */
section('画面へ渡す形');

{
  const deps = fixedDeps('v');
  const { store, theme, version } = themeWith('x', '本文', deps);
  const fetch = fakeFetch([{ status: 201, body: { data: { id: '99' } } }]);

  let ws = gas.IssoApi_workspace(store, theme.theme_id, deps);
  let x = ws.stages.filter((s) => s.id === 'x')[0];

  check('投稿前は posted が null', x.versions[0].posted === null);
  check('**使用量が常に返る**', ws.xUsage.limit === 60 && ws.xUsage.used === 0);
  check('月も返る', ws.xUsage.month === '2026-08', ws.xUsage.month);

  gas.IssoApi_post(store, version.version_id, 'x', { ...deps, fetch, credentials: CREDS });

  ws = gas.IssoApi_workspace(store, theme.theme_id, deps);
  x = ws.stages.filter((s) => s.id === 'x')[0];

  check('**投稿済みが画面に出る**', x.versions[0].posted.ok === true);
  check('URL も出る', x.versions[0].posted.url.indexOf('99') > 0);
  check('使用量が増える', ws.xUsage.used === 1);
  check('履歴も返る', ws.posts.length === 1);

  const note = ws.stages.filter((s) => s.id === 'note')[0];

  check('**投稿しない段階には posted を付けない**',
    note.versions.length === 0 || note.versions[0].posted === undefined);
}

{
  /* 失敗のあと成功したら、成功として見える。 */
  const deps = fixedDeps('v2');
  const { store, theme, version } = themeWith('x', '本文', deps);

  gas.IssoPosts_record(store, {
    theme_id: theme.theme_id, version_id: version.version_id, platform: 'x',
    status: gas.ISSO_STATUS.POST_FAILED, error: '一度失敗した',
  }, deps);

  let ws = gas.IssoApi_workspace(store, theme.theme_id, deps);
  let x = ws.stages.filter((s) => s.id === 'x')[0];

  check('失敗が出る', x.versions[0].posted.ok === false);
  check('理由も出る', x.versions[0].posted.error === '一度失敗した');

  gas.IssoPosts_record(store, {
    theme_id: theme.theme_id, version_id: version.version_id, platform: 'x',
    status: gas.ISSO_STATUS.POST_OK,
  }, deps);

  ws = gas.IssoApi_workspace(store, theme.theme_id, deps);
  x = ws.stages.filter((s) => s.id === 'x')[0];

  check('**成功が失敗より優先される**', x.versions[0].posted.ok === true);
}

check('投稿できない段階は落ちる', throws(() => {
  const deps = fixedDeps('v3');
  const { store, version } = themeWith('threads', '本文', deps);
  gas.IssoApi_post(store, version.version_id, 'note', { fetch: fakeFetch([]) });
}) instanceof Error);

finish();

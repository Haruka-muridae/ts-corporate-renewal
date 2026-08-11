/**
 * ライセンスゲート（notifier-gate）のクライアント。
 *
 * 通知するかどうかの判定と、Push に必要な VAPID JWT の発行は運営の Workers が行う。
 * このファイルはその窓口で、次の3つを呼ぶ。
 *
 *   /v1/evaluate     … 予定の骨格を渡し、通知の予定表を受け取る（5分ごと）
 *   /v1/vapid        … 公開鍵と JWT を受け取る（期限まで使い回す）
 *   /v1/test-notify  … テスト通知を出してよいかの確認
 *
 * **予定名・説明・参加者・メールアドレスをここから送らない。**
 * 送ってよい項目は buildEventSkeleton_（CalendarSync.gs）が決めており、
 * Workers 側もそれ以外を含む要求を拒否する。理由は docs/notifier-design-notes.md §3。
 */

/**
 * ゲートの公開オリジン。
 *
 * **直書きしないこと。** 同じURLが Workers の設定・この定数・録音アプリの
 * notifier-config.js・index.html の CSP の4か所に現れる。正本は
 * workers/notifier-gate/origin.mjs で、一致は tests/unit/notifier-gate.mjs が検査する。
 */
var NOTIFIER_GATE_ORIGIN = 'https://notifier-gate.potenitas-lp.workers.dev';

/** ゲートへの1回の呼び出しで待つ上限に近い件数。24時間ぶんとしては十分に多い。 */
var GATE_MAX_EVENTS = 500;

/**
 * 鍵の取得に失敗したあと、次に試すまで空ける時間。
 *
 * ------------------------------------------------------------------
 * 「失敗したらすぐ再試行」が事故になった
 * ------------------------------------------------------------------
 * 鍵が取れないと保存もされないので、次の操作でまた取りに行く。
 * 利用者は当然もう一度［接続テスト］を押す。tick も呼ぶ。
 * この増幅でゲートの上限（1時間20回）を使い切り、以後すべて
 * RATE_LIMITED になって**成功しないと減らないのに呼べない**という
 * 抜け出せない状態になった（2026-08-11）。
 *
 * 失敗したら少し黙る。上限に当たったときはゲートが「窓が明けるまでの
 * 秒数」を返すので、それに従う（当てずっぽうで待たない）。
 * ------------------------------------------------------------------
 */
var GATE_RETRY_BACKOFF_MS = 60 * 1000;

/** 上限に当たったが、秒数が分からないとき（古いゲート）に空ける時間。 */
var GATE_RETRY_RATE_LIMIT_MS = 10 * 60 * 1000;

/** どれだけ長い秒数を告げられても、これ以上は待たない。 */
var GATE_RETRY_MAX_MS = 60 * 60 * 1000;

/** ライセンスの状態（Workers が返す語）。 */
var LICENSE_STATE = {
  ACTIVE: 'active',
  GRACE: 'grace',
  EXPIRED: 'expired',
  UNKNOWN: 'unknown'
};

/** ゲートへ POST する。戻り値は { ok, status, body, error }。例外は投げない。 */
function gateFetch_(path, payload) {
  var licenseKey = getProperty_(PROP.LICENSE_KEY);

  if (licenseKey === '') {
    return { ok: false, status: 0, body: null, error: 'NO_LICENSE' };
  }

  var body = { licenseKey: licenseKey };
  var keys = Object.keys(payload || {});

  for (var i = 0; i < keys.length; i++) {
    body[keys[i]] = payload[keys[i]];
  }

  var response;

  try {
    response = UrlFetchApp.fetch(NOTIFIER_GATE_ORIGIN + path, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
  } catch (err) {
    /* ライセンスキーが例外メッセージへ混ざらないよう、内容は転記しない。 */
    Logger.log('gate fetch failed: ' + path);
    return { ok: false, status: 0, body: null, error: 'NETWORK' };
  }

  var status = response.getResponseCode();
  var parsed = null;

  try {
    parsed = JSON.parse(response.getContentText());
  } catch (err) {
    parsed = null;
  }

  if (status < 200 || status >= 300 || !parsed || parsed.ok !== true) {
    var code = (parsed && parsed.error && parsed.error.code) ? String(parsed.error.code) : ('HTTP_' + status);

    return gateFailure_(path, code, status, parsed);
  }

  clearGateError_(path);

  return { ok: true, status: status, body: parsed, error: '' };
}

/**
 * この path について記録されている失敗だけを消す。
 *
 * ------------------------------------------------------------------
 * 「どれか成功したら消す」では読めない
 * ------------------------------------------------------------------
 * 以前は成功のたびに記録を空にしていた。ところが実機では
 * **evaluate は1分ごとに成功し、vapid だけが失敗し続ける**状態になった。
 * 記録は tick のたびに消え、鍵を取りに行くたびに書かれる。
 * 画面に出たり消えたりし、「いま何が壊れているのか」が読めなかった
 * （2026-08-11）。
 *
 * 記録の置き場所は1つ（最後の失敗）のままでよいが、消すのは
 * **その失敗を出した相手が成功したとき**に限る。
 * ------------------------------------------------------------------
 */
function clearGateError_(path) {
  if (getProperty_(PROP.LAST_GATE_ERROR).indexOf(path + ' -> ') === 0) {
    setProperty_(PROP.LAST_GATE_ERROR, '');
  }
}

/**
 * 失敗を記録して返す。
 *
 * ------------------------------------------------------------------
 * 「なぜ鍵が無いのか」を画面から辿れるようにする
 * ------------------------------------------------------------------
 * 実機で、録音アプリの「通知の鍵」が × のまま直らない状態になった。
 * ゲート側のログには成功が並んでいたが、**テンプレート側では何が
 * 起きたのかを誰も持っていなかった**（実行ログを開かない限り分からない）。
 *
 * 最後の失敗だけを Script Property に置き、health から読めるようにする。
 * **応答本文も鍵も入れない。** 入れるのは path と符号だけ。
 * ------------------------------------------------------------------
 */
function gateFailure_(path, code, status, parsed) {
  Logger.log('gate ' + path + ' -> ' + code);
  setProperty_(PROP.LAST_GATE_ERROR, path + ' -> ' + code);

  return { ok: false, status: status, body: parsed, error: code };
}

/**
 * 判定を依頼する。
 *
 * @param {Object} request { settings, events, sentDigest }
 * @return {{ok: boolean, notify: Array, remove: Array, licenseState: string, error: string}}
 */
function gateEvaluate_(request) {
  var result = gateFetch_('/v1/evaluate', {
    settings: request.settings,
    events: (request.events || []).slice(0, GATE_MAX_EVENTS),
    sentDigest: request.sentDigest || []
  });

  if (!result.ok) {
    return { ok: false, notify: [], remove: [], licenseState: LICENSE_STATE.UNKNOWN, error: result.error };
  }

  return {
    ok: true,
    notify: result.body.notify || [],
    remove: result.body.remove || [],
    licenseState: String(result.body.licenseState || LICENSE_STATE.UNKNOWN),
    error: ''
  };
}

/**
 * VAPID の公開鍵と JWT を取り出す。
 *
 * 期限内ならキャッシュ（Script Properties）を返し、ゲートを呼ばない。
 * audiences に未取得の相手が混ざっていれば取り直す。
 */
function gateVapid_(audiences, nowMs) {
  var wanted = [];

  for (var i = 0; i < (audiences || []).length; i++) {
    var audience = String(audiences[i] || '');

    if (audience !== '' && wanted.indexOf(audience) === -1) {
      wanted.push(audience);
    }
  }

  if (wanted.length === 0) {
    return { ok: true, publicKey: getProperty_(PROP.VAPID_PUBLIC), jwts: {}, error: '' };
  }

  var cached = readVapidCache_();
  var expiresAt = toMs_(getProperty_(PROP.VAPID_EXPIRES_AT));
  var fresh = isFinite(expiresAt) && expiresAt > nowMs;

  if (fresh && hasAllAudiences_(cached, wanted)) {
    /* 手持ちで足りている＝いま鍵は取れている。過去の失敗の記録は残さない。 */
    clearGateError_('/v1/vapid');

    return { ok: true, publicKey: getProperty_(PROP.VAPID_PUBLIC), jwts: cached, error: '' };
  }

  /*
   * 直前に失敗している間は、呼ばずに前回の理由を返す。
   * **押し直しても呼び出しが増えない**ようにするための関門である
   * （GATE_RETRY_BACKOFF_MS の説明を参照）。
   */
  var retryAt = toMs_(getProperty_(PROP.VAPID_RETRY_AT));

  if (isFinite(retryAt) && retryAt > nowMs) {
    return {
      ok: false,
      publicKey: '',
      jwts: {},
      error: getProperty_(PROP.VAPID_RETRY_CODE) || 'RATE_LIMITED',
      retryAt: retryAt
    };
  }

  var result = gateFetch_('/v1/vapid', { audiences: wanted });

  if (!result.ok) {
    /*
     * 取り直せなかった。期限内のキャッシュがあるならそれで送る
     * （ゲートが一時的に不調でも、手持ちの JWT が切れるまでは通知が続く）。
     */
    if (fresh && hasAllAudiences_(cached, wanted)) {
      return { ok: true, publicKey: getProperty_(PROP.VAPID_PUBLIC), jwts: cached, error: '' };
    }

    setVapidRetry_(result, nowMs);

    return { ok: false, publicKey: '', jwts: {}, error: result.error };
  }

  var publicKey = String(result.body.publicKey || '');
  var jwts = result.body.jwts || {};

  /*
   * ------------------------------------------------------------------
   * 200 でも中身が使えないことがある
   * ------------------------------------------------------------------
   * ゲートとテンプレートは別々に書かれており、応答の形は2か所にある。
   * 片方だけ変わると、**通信は成功しているのに何も取り出せない**という
   * 静かな壊れ方になる。同じ組み合わせの事故が Phase 2 に起きている
   * （gas-auth は success、Workers は ok を見ていた）。
   *
   * ここで気づけるようにしておく。既定値を書いて成功として返すと、
   * 「鍵が無い」という結果だけが残り、原因が消える。
   * ------------------------------------------------------------------
   */
  if (publicKey === '' || !hasAllAudiences_(jwts, wanted)) {
    var bad = gateFailure_('/v1/vapid', 'BAD_PAYLOAD', result.status, result.body);

    setVapidRetry_(bad, nowMs);

    return { ok: false, publicKey: '', jwts: {}, error: 'BAD_PAYLOAD' };
  }

  setProperty_(PROP.VAPID_PUBLIC, publicKey);
  setProperty_(PROP.VAPID_JWTS, JSON.stringify(jwts));
  setProperty_(PROP.VAPID_EXPIRES_AT, String(toMs_(Date.parse(String(result.body.expiresAt || ''))) || 0));
  clearVapidRetry_();

  return { ok: true, publicKey: publicKey, jwts: jwts, error: '' };
}

/**
 * 次に鍵を取りに行ってよい時刻を決めて記録する。
 *
 * 上限に当たったとき（RATE_LIMITED）は、ゲートが返した窓の残り秒数に従う。
 * それ以外の失敗は一時的なことが多いので短く空ける。
 *
 * **ライセンス未設定は記録しない。** その場合ゲートを呼んでもいない
 * （gateFetch_ が手前で返す）ので、待たせる理由が無い。むしろ待たせると、
 * 録音アプリからライセンスが届いた直後に鍵を取りに行けなくなる。
 */
function setVapidRetry_(result, nowMs) {
  var code = String(result.error || '');

  if (code === '' || code === 'NO_LICENSE') {
    return;
  }

  setProperty_(PROP.VAPID_RETRY_AT, String(nowMs + gateRetryDelayMs_(code, result.body)));
  setProperty_(PROP.VAPID_RETRY_CODE, code);
}

function gateRetryDelayMs_(code, body) {
  if (code !== 'RATE_LIMITED') {
    return GATE_RETRY_BACKOFF_MS;
  }

  var seconds = Number(body && body.retryAfterSec);

  if (!isFinite(seconds) || seconds <= 0) {
    return GATE_RETRY_RATE_LIMIT_MS;
  }

  return Math.min(seconds * 1000, GATE_RETRY_MAX_MS);
}

function clearVapidRetry_() {
  setProperty_(PROP.VAPID_RETRY_AT, '0');
  setProperty_(PROP.VAPID_RETRY_CODE, '');
}

function readVapidCache_() {
  try {
    var parsed = JSON.parse(getProperty_(PROP.VAPID_JWTS) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {};
  }
}

function hasAllAudiences_(jwts, audiences) {
  for (var i = 0; i < audiences.length; i++) {
    if (typeof jwts[audiences[i]] !== 'string' || jwts[audiences[i]] === '') {
      return false;
    }
  }

  return true;
}

/**
 * キャッシュを捨てる。ライセンスを入れ直したときに古い JWT を残さない。
 *
 * **待ち時間も一緒に捨てる。** 別のライセンスになったのなら、前のキーで
 * 断られたことは無関係であり、そのまま待たせると原因を直したのに
 * 何も起きない時間ができてしまう。
 */
function clearVapidCache_() {
  setProperty_(PROP.VAPID_JWTS, '{}');
  setProperty_(PROP.VAPID_EXPIRES_AT, '0');
  clearVapidRetry_();
}

/** テスト通知を出してよいか。ゲートが 1日1回に制限している。 */
function gateTestNotify_() {
  var result = gateFetch_('/v1/test-notify', {});

  return { ok: result.ok, error: result.error };
}

/** エンドポイントURLの origin。JWT の aud に使う。 */
function endpointOrigin_(endpoint) {
  var match = String(endpoint).match(/^(https?:\/\/[^\/?#]+)/);

  if (!match) {
    throw new Error('Push エンドポイントの形式が不正です。');
  }

  return match[1];
}

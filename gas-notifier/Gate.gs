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
    Logger.log('gate ' + path + ' -> ' + code);
    return { ok: false, status: status, body: parsed, error: code };
  }

  return { ok: true, status: status, body: parsed, error: '' };
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
    return { ok: true, publicKey: getProperty_(PROP.VAPID_PUBLIC), jwts: cached, error: '' };
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

    return { ok: false, publicKey: '', jwts: {}, error: result.error };
  }

  setProperty_(PROP.VAPID_PUBLIC, String(result.body.publicKey || ''));
  setProperty_(PROP.VAPID_JWTS, JSON.stringify(result.body.jwts || {}));
  setProperty_(PROP.VAPID_EXPIRES_AT, String(toMs_(Date.parse(String(result.body.expiresAt || ''))) || 0));

  return {
    ok: true,
    publicKey: String(result.body.publicKey || ''),
    jwts: result.body.jwts || {},
    error: ''
  };
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

/** キャッシュを捨てる。ライセンスを入れ直したときに古い JWT を残さない。 */
function clearVapidCache_() {
  setProperty_(PROP.VAPID_JWTS, '{}');
  setProperty_(PROP.VAPID_EXPIRES_AT, '0');
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

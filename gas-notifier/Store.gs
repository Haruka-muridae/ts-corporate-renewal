/**
 * シート I/O と定数。
 *
 * 上位（Api.gs / CalendarSync.gs / Push.gs / Gate.gs / Setup.gs）は、
 * ここだけを通してシートと Script Properties へ触る。
 *
 * このスクリプトは利用者自身のスプレッドシートに紐づく（`getActive()` 1つで足りる）。
 *
 * 設計の理由は docs/notifier-design-notes.md §2。
 */

/** health で返す版。 */
var NOTIFIER_VERSION = '2.0.0';

var SHEET = {
  SETTINGS: 'settings',
  SUBSCRIPTIONS: 'subscriptions',
  QUEUE: 'notify_queue',
  SENT_LOG: 'sent_log'
};

/**
 * 各シートの列。**順序がそのまま列順**で、途中へ挿入しない（末尾へ足す）。
 * 時刻はすべてエポックミリ秒の数値で持つ（理由は design-notes §2-1）。
 */
var HEADERS = {
  settings: ['key', 'value'],
  subscriptions: ['subId', 'endpoint', 'p256dh', 'auth', 'createdAt', 'lastSuccessAt', 'lastErrorAt', 'lastError'],
  notify_queue: ['key', 'eid', 'eventId', 'feature', 'timing', 'title', 'startTime', 'notifyAt', 'updatedAt', 'openUrl'],
  sent_log: ['key', 'eid', 'eventId', 'feature', 'timing', 'title', 'startTime', 'sentAt', 'purpose', 'fetchedBy', 'openUrl']
};

var SHEET_ORDER = [SHEET.SETTINGS, SHEET.SUBSCRIPTIONS, SHEET.QUEUE, SHEET.SENT_LOG];

/**
 * Script Properties のキー。
 * **接続キー・ライセンスキー・EID の鍵はここにしか無い。シートへ書かない。**
 */
var PROP = {
  CONNECT_KEY: 'CONNECT_KEY',
  LICENSE_KEY: 'LICENSE_KEY',
  /** 予定IDを運営へ渡す前にハッシュ化する鍵（design-notes §3）。 */
  EID_HMAC_KEY: 'EID_HMAC_KEY',
  LAST_TICK_AT: 'LAST_TICK_AT',
  LAST_SYNC_AT: 'LAST_SYNC_AT',
  /** deployWebApp() が保存する公開URL。 */
  WEBAPP_URL: 'WEBAPP_URL',
  /**
   * 作ったが、まだデプロイに結びついていないバージョン番号。
   * 再試行でバージョンが増え続けるのを防ぐ（design-notes §9-2）。
   */
  PENDING_VERSION: 'PENDING_VERSION',
  /** 実際に公開されているバージョン番号（記録用）。 */
  DEPLOYED_VERSION: 'DEPLOYED_VERSION',
  /** ゲートが最後に返したライセンスの状態と、その時刻（画面表示用）。 */
  LICENSE_STATE: 'LICENSE_STATE',
  LICENSE_CHECKED_AT: 'LICENSE_CHECKED_AT',
  /**
   * ゲートとの最後のやり取りの結果（画面と切り分け用）。
   * **値は状態だけで、応答本文も鍵も入れない。**
   */
  LAST_GATE_ERROR: 'LAST_GATE_ERROR',
  /* ゲートから受け取った VAPID 情報のキャッシュ（Gate.gs）。 */
  VAPID_PUBLIC: 'VAPID_PUBLIC_B64URL',
  VAPID_JWTS: 'VAPID_JWTS_JSON',
  VAPID_EXPIRES_AT: 'VAPID_EXPIRES_AT',
  /**
   * 鍵の取得に失敗したあと、次に試してよい時刻とその理由。
   *
   * **失敗したときこそ呼び出しを減らす**ためにある。失敗すると鍵が保存されず、
   * 次の操作でまた取りに行く……を繰り返してゲートの上限を使い切り、
   * 二度と抜け出せなくなった（Gate.gs の gateVapid_）。
   */
  VAPID_RETRY_AT: 'VAPID_RETRY_AT',
  VAPID_RETRY_CODE: 'VAPID_RETRY_CODE'
};

/* 設定の既定値（要件 FR-06 / FR-07 / FR-11）。 */
var DEFAULT_SETTINGS = {
  accepted: true,
  tentative: true,
  needsAction: true,
  declined: false,
  timedOnly: true,
  timing: 5,

  /*
   * カレンダーURL通知（feature: openurl）を出すか。
   * **既定は false。** このテンプレートは録音アプリの通知として配ってあり、
   * コピー済みのシートで勝手に通知が2倍にならないようにする。
   * URL通知アプリの設定画面が ON にする。
   */
  openUrlEnabled: false
};

/* 通知タイミングの選択肢（分前）。0 は「開始時刻」。FR-10。 */
var ALLOWED_TIMINGS = [0, 5, 10, 15];

/* 出欠の状態。Google Calendar API の responseStatus と同じ語。 */
var RESPONSE_STATUSES = ['accepted', 'tentative', 'needsAction', 'declined'];

/* 録音アプリの場所。引き継ぎリンクの組み立てに使う。 */
var RECORDER_APP_URL = 'https://tsam-ai.com/production-app/voice-recorder/';

/* ---------- 値の変換 ---------- */

/** セルの値をエポックミリ秒へ寄せる。読めない値は NaN。 */
function toMs_(value) {
  if (value instanceof Date) {
    return value.getTime();
  }

  if (value === '' || value === null || value === undefined) {
    return NaN;
  }

  var number = Number(value);

  return isFinite(number) ? number : NaN;
}

/** エポックミリ秒を ISO 8601 文字列にする。API の応答でだけ使う。 */
function toIsoOrEmpty_(ms) {
  var value = toMs_(ms);
  return isFinite(value) ? new Date(value).toISOString() : '';
}

/* ---------- Script Properties ---------- */

function getProperty_(key) {
  var value = PropertiesService.getScriptProperties().getProperty(key);
  return value === null || value === undefined ? '' : String(value);
}

function setProperty_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, String(value));
}

/* ---------- シート ---------- */

function getBook_() {
  var book = SpreadsheetApp.getActive();

  if (!book) {
    throw new Error('このスクリプトはスプレッドシートに紐づいていません。テンプレートのコピーから開いてください。');
  }

  return book;
}

/** シートを用意する。何度呼んでも重複して作らず、データ行には触らない。 */
function ensureSheet_(name) {
  var header = HEADERS[name];

  if (!header) {
    throw new Error('未知のシート名: ' + name);
  }

  var book = getBook_();
  var sheet = book.getSheetByName(name);

  if (!sheet) {
    sheet = book.insertSheet(name);
  }

  sheet.getRange(1, 1, 1, header.length).setValues([header]);
  sheet.setFrozenRows(1);

  return sheet;
}

/**
 * 表を読む。1行1オブジェクトにし、`__row` に読んだ時点の行番号を入れる。
 * 削除は必ず deleteRowsByNumbers_ を使う（行番号がずれるため）。
 */
function tableRead_(name) {
  var sheet = ensureSheet_(name);
  var header = HEADERS[name];
  var last = sheet.getLastRow();

  if (last < 2) {
    return [];
  }

  var values = sheet.getRange(2, 1, last - 1, header.length).getValues();
  var out = [];

  for (var i = 0; i < values.length; i++) {
    var row = { __row: i + 2 };

    for (var c = 0; c < header.length; c++) {
      row[header[c]] = values[i][c];
    }

    out.push(row);
  }

  return out;
}

function tableAppend_(name, obj) {
  var sheet = ensureSheet_(name);
  var header = HEADERS[name];
  var line = [];

  for (var c = 0; c < header.length; c++) {
    var value = obj[header[c]];
    line.push(value === undefined || value === null ? '' : value);
  }

  sheet.appendRow(line);
  return sheet.getLastRow();
}

function tableUpdate_(name, rowNumber, obj) {
  var sheet = ensureSheet_(name);
  var header = HEADERS[name];
  var line = [];

  for (var c = 0; c < header.length; c++) {
    var value = obj[header[c]];
    line.push(value === undefined || value === null ? '' : value);
  }

  sheet.getRange(rowNumber, 1, 1, header.length).setValues([line]);
}

/** 行番号の配列をまとめて削除する。**大きい番号から消す。** */
function deleteRowsByNumbers_(name, rowNumbers) {
  if (!rowNumbers || rowNumbers.length === 0) {
    return 0;
  }

  var sheet = ensureSheet_(name);
  var sorted = rowNumbers.slice().sort(function (a, b) { return b - a; });

  for (var i = 0; i < sorted.length; i++) {
    sheet.deleteRow(sorted[i]);
  }

  return sorted.length;
}

/* ---------- settings ---------- */

/** 設定を読む。壊れた値・未設定は既定値へ落とす（design-notes §2-2）。 */
function readSettings_() {
  var rows = tableRead_(SHEET.SETTINGS);
  var raw = {};

  for (var i = 0; i < rows.length; i++) {
    raw[String(rows[i].key).trim()] = rows[i].value;
  }

  return normalizeSettings_(raw);
}

/** 任意の入力を設定オブジェクトへ正規化する（純関数）。 */
function normalizeSettings_(input) {
  var source = input && typeof input === 'object' ? input : {};
  var out = {};

  for (var i = 0; i < RESPONSE_STATUSES.length; i++) {
    var key = RESPONSE_STATUSES[i];
    out[key] = toBool_(source[key], DEFAULT_SETTINGS[key]);
  }

  out.timedOnly = toBool_(source.timedOnly, DEFAULT_SETTINGS.timedOnly);
  out.timing = toTiming_(source.timing);
  out.openUrlEnabled = toBool_(source.openUrlEnabled, DEFAULT_SETTINGS.openUrlEnabled);

  return out;
}

/** 真偽値へ寄せる。文字列 'false' を Boolean() に渡すと true になるため明示的に見る。 */
function toBool_(value, fallback) {
  if (value === true || value === false) {
    return value;
  }

  var text = String(value === undefined || value === null ? '' : value).trim().toLowerCase();

  if (text === 'true' || text === '1' || text === 'on' || text === 'yes') {
    return true;
  }

  if (text === 'false' || text === '0' || text === 'off' || text === 'no') {
    return false;
  }

  return fallback;
}

/** 通知タイミング（分前）。選択肢に無い値は既定へ戻す。 */
function toTiming_(value) {
  var number = Number(value);

  if (!isFinite(number)) {
    return DEFAULT_SETTINGS.timing;
  }

  var rounded = Math.round(number);

  return ALLOWED_TIMINGS.indexOf(rounded) === -1 ? DEFAULT_SETTINGS.timing : rounded;
}

/** 設定を書く。渡されなかった項目は現在値を残す。 */
function writeSettings_(patch) {
  var current = readSettings_();
  var source = patch && typeof patch === 'object' ? patch : {};
  var merged = {};
  var keys = RESPONSE_STATUSES.concat(['timedOnly', 'timing', 'openUrlEnabled']);

  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    merged[key] = Object.prototype.hasOwnProperty.call(source, key) ? source[key] : current[key];
  }

  var normalized = normalizeSettings_(merged);
  var sheet = ensureSheet_(SHEET.SETTINGS);
  var rows = tableRead_(SHEET.SETTINGS);
  var index = {};

  for (var r = 0; r < rows.length; r++) {
    index[String(rows[r].key).trim()] = rows[r].__row;
  }

  for (var k = 0; k < keys.length; k++) {
    var name = keys[k];
    var value = normalized[name];

    if (index[name]) {
      sheet.getRange(index[name], 2).setValue(value);
    } else {
      sheet.appendRow([name, value]);
    }
  }

  return normalized;
}

/* ---------- subscriptions ---------- */

/**
 * Push 購読を upsert する。endpoint が同一なら鍵だけ更新し、subId は保つ。
 * subId は「どの端末が通知を取りに来たか」の記録に使う（design-notes §5）。
 */
function upsertSubscription_(subscription, nowMs) {
  var endpoint = String(subscription && subscription.endpoint ? subscription.endpoint : '').trim();

  if (endpoint.indexOf('https://') !== 0) {
    throw new Error('endpoint が https ではありません。');
  }

  var keys = subscription.keys || {};
  var p256dh = String(keys.p256dh || '').trim();
  var auth = String(keys.auth || '').trim();

  if (p256dh === '' || auth === '') {
    throw new Error('購読の鍵（p256dh / auth）がありません。');
  }

  var rows = tableRead_(SHEET.SUBSCRIPTIONS);

  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].endpoint) === endpoint) {
      var existingId = String(rows[i].subId || '') || randomBase64Url_(9);

      tableUpdate_(SHEET.SUBSCRIPTIONS, rows[i].__row, {
        subId: existingId,
        endpoint: endpoint,
        p256dh: p256dh,
        auth: auth,
        createdAt: rows[i].createdAt || nowMs,
        lastSuccessAt: rows[i].lastSuccessAt || '',
        lastErrorAt: '',
        lastError: ''
      });

      return { created: false, subId: existingId, endpoint: endpoint };
    }
  }

  var subId = randomBase64Url_(9);

  tableAppend_(SHEET.SUBSCRIPTIONS, {
    subId: subId,
    endpoint: endpoint,
    p256dh: p256dh,
    auth: auth,
    createdAt: nowMs,
    lastSuccessAt: '',
    lastErrorAt: '',
    lastError: ''
  });

  return { created: true, subId: subId, endpoint: endpoint };
}

function findSubscriptionByEndpoint_(endpoint) {
  var target = String(endpoint === undefined || endpoint === null ? '' : endpoint).trim();

  if (target === '') {
    return null;
  }

  var rows = tableRead_(SHEET.SUBSCRIPTIONS);

  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].endpoint) === target) {
      return rows[i];
    }
  }

  return null;
}

function removeSubscriptionByEndpoint_(endpoint) {
  var rows = tableRead_(SHEET.SUBSCRIPTIONS);
  var targets = [];

  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].endpoint) === String(endpoint)) {
      targets.push(rows[i].__row);
    }
  }

  return deleteRowsByNumbers_(SHEET.SUBSCRIPTIONS, targets);
}

/* ---------- notify_queue ---------- */

/**
 * キューの行キー。eid と timing の組で1件とする。
 *
 * feature を末尾へ足すのは calendar 以外だけにしてある。
 * 全機能に足すと、**すでに配布済みのシートにある行と形が変わり**、
 * 更新直後の同期で同じ予定が「新しい行」として積み直される。
 * 既存の形を保てば、増えるのは新機能ぶんの行だけで済む。
 */
function queueKey_(eid, timing, feature) {
  var base = String(eid) + '|' + String(timing);
  var name = String(feature || 'calendar');

  return name === 'calendar' ? base : base + '|' + name;
}

/* ---------- sent_log の取得済み（購読単位） ---------- */

/**
 * `fetchedBy` 列を subId の配列として読む。
 * 空欄・壊れた値は「誰も取っていない」として扱う（design-notes §5）。
 */
function parseFetchedBy_(value) {
  var text = String(value === undefined || value === null ? '' : value).trim();

  if (text === '') {
    return [];
  }

  var parts = text.split(',');
  var out = [];

  for (var i = 0; i < parts.length; i++) {
    var id = parts[i].trim();

    if (id !== '' && out.indexOf(id) === -1) {
      out.push(id);
    }
  }

  return out;
}

function formatFetchedBy_(list) {
  return (list || []).join(',');
}

/**
 * シート I/O と定数。
 *
 * 上位（Api.gs / CalendarSync.gs / Push.gs / Setup.gs）は、
 * ここだけを通してシートと Script Properties へ触る。
 *
 * ------------------------------------------------------------------
 * このスクリプトは「利用者自身のスプレッドシート」に貼られる
 * ------------------------------------------------------------------
 * gas-auth/ と違い、ID で別のファイルを開くことはしない。
 * スコープが spreadsheets.currentonly（このスプレッドシートだけ）であり、
 * 運営はデータを一切預からないという設計（要件 DR-01〜04）による。
 * したがってファイルの特定は SpreadsheetApp.getActive() ひとつで足りる。
 * ------------------------------------------------------------------
 */

/** health で返す版。ロジックを変えたら上げる（利用者の再コピー判断に使う）。 */
var NOTIFIER_VERSION = '1.0.0';

var SHEET = {
  SETTINGS: 'settings',
  SUBSCRIPTIONS: 'subscriptions',
  QUEUE: 'notify_queue',
  SENT_LOG: 'sent_log'
};

/**
 * 各シートの列。**順序がそのまま列順**であり、途中へ挿入しないこと。
 * 列を足すときは必ず末尾へ足す（既存データの列がずれる）。
 *
 * ------------------------------------------------------------------
 * 時刻はすべて「エポックミリ秒の数値」で持つ
 * ------------------------------------------------------------------
 * ISO 8601 の文字列をセルへ書くと、Google スプレッドシートが日時として
 * 解釈し、読み戻したときに Date オブジェクトや別書式の文字列になる。
 * そうなると `sentAt >= now - 10分` のような比較が静かに壊れる。
 * 表示用の整形は API の応答を作る時点（Api.gs）で行う。
 * 空欄は '' とする。
 * ------------------------------------------------------------------
 */
var HEADERS = {
  settings: ['key', 'value'],
  subscriptions: ['endpoint', 'p256dh', 'auth', 'createdAt', 'lastSuccessAt', 'lastErrorAt', 'lastError'],
  notify_queue: ['key', 'eventId', 'timing', 'title', 'startTime', 'notifyAt', 'updatedAt'],
  sent_log: ['key', 'eventId', 'timing', 'title', 'startTime', 'sentAt', 'purpose', 'fetchedAt']
};

var SHEET_ORDER = [SHEET.SETTINGS, SHEET.SUBSCRIPTIONS, SHEET.QUEUE, SHEET.SENT_LOG];

/**
 * Script Properties のキー。
 *
 * **秘密鍵と接続キーはここにしか無い。** シートへ書かないこと。
 * シートは「リンクを知っている全員／閲覧者」で共有される想定であり、
 * 書けば第三者に渡る（要件 NFR-01）。
 */
var PROP = {
  VAPID_PRIVATE: 'VAPID_PRIVATE_PEM',
  VAPID_PUBLIC: 'VAPID_PUBLIC_B64URL',
  CONNECT_KEY: 'CONNECT_KEY',
  LAST_TICK_AT: 'LAST_TICK_AT',
  LAST_SYNC_AT: 'LAST_SYNC_AT'
};

/* 設定の既定値（FR-06 / FR-07 / FR-11）。 */
var DEFAULT_SETTINGS = {
  accepted: true,
  tentative: true,
  needsAction: true,
  declined: false,
  timedOnly: true,
  timing: 5
};

/* 通知タイミングの選択肢（分前）。0 は「開始時刻」。FR-10。 */
var ALLOWED_TIMINGS = [0, 5, 10, 15];

/* 出欠の状態。Google Calendar API の responseStatus と同じ語をそのまま使う。 */
var RESPONSE_STATUSES = ['accepted', 'tentative', 'needsAction', 'declined'];

/* ---------- 値の変換 ---------- */

/**
 * セルの値をエポックミリ秒へ寄せる。読めない値は NaN を返す。
 * 利用者がシートを手で編集して日時セルに変えてしまった場合も拾えるよう、
 * Date オブジェクトと数値文字列の両方を受ける。
 */
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

/**
 * シートを用意する。何度呼んでも重複して作らない（優等設計）。
 * すでにある場合はヘッダーだけ整え、データ行には触らない。
 */
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
 * 表を読む。1行1オブジェクトにし、`__row` に実際の行番号を入れる。
 *
 * `__row` は**読んだ時点の行番号**である。行を消すと後ろがずれるため、
 * 削除は必ず行番号の大きいほうから行うこと（deleteRowsByNumbers_ を使う）。
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

/** 行番号の配列をまとめて削除する。**大きい番号から消す**（消すたびに後ろがずれるため）。 */
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

/**
 * 設定を読む。**壊れた値・未設定は既定値へ落とす。**
 *
 * 画面（notifier-panel.js）は保存前に検証するが、シートは利用者が
 * 直接編集できる。ここで丸めておかないと、`timing` に文字列が入っただけで
 * 通知が一切出ない状態になる。
 */
function readSettings_() {
  var rows = tableRead_(SHEET.SETTINGS);
  var raw = {};

  for (var i = 0; i < rows.length; i++) {
    raw[String(rows[i].key).trim()] = rows[i].value;
  }

  return normalizeSettings_(raw);
}

/** 任意の入力を設定オブジェクトへ正規化する（純関数。テストはここを見る）。 */
function normalizeSettings_(input) {
  var source = input && typeof input === 'object' ? input : {};
  var out = {};

  for (var i = 0; i < RESPONSE_STATUSES.length; i++) {
    var key = RESPONSE_STATUSES[i];
    out[key] = toBool_(source[key], DEFAULT_SETTINGS[key]);
  }

  out.timedOnly = toBool_(source.timedOnly, DEFAULT_SETTINGS.timedOnly);
  out.timing = toTiming_(source.timing);

  return out;
}

/**
 * 真偽値へ寄せる。
 *
 * 文字列 'false' を Boolean() に渡すと true になる。
 * 同じ誤りが本番認証系で30日セッションの誤発行を起こしている（gas-auth/Main.gs）。
 * ここでも文字列を明示的に見る。
 */
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
  var keys = RESPONSE_STATUSES.concat(['timedOnly', 'timing']);

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
 * Push 購読を upsert する。endpoint が同一なら鍵だけ更新する。
 * 同じブラウザからの再購読で行が増え続けると、1件の通知が何度も届く。
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
  var stamp = nowMs;

  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].endpoint) === endpoint) {
      tableUpdate_(SHEET.SUBSCRIPTIONS, rows[i].__row, {
        endpoint: endpoint,
        p256dh: p256dh,
        auth: auth,
        createdAt: rows[i].createdAt || stamp,
        lastSuccessAt: rows[i].lastSuccessAt || '',
        lastErrorAt: '',
        lastError: ''
      });

      return { created: false, endpoint: endpoint };
    }
  }

  tableAppend_(SHEET.SUBSCRIPTIONS, {
    endpoint: endpoint,
    p256dh: p256dh,
    auth: auth,
    createdAt: stamp,
    lastSuccessAt: '',
    lastErrorAt: '',
    lastError: ''
  });

  return { created: true, endpoint: endpoint };
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
 * キューの行キー。**eventId と timing の組**で1件とする。
 * timing を変えたら別の通知になる（設定変更後に「5分前」と「10分前」が
 * 二重に出ないよう、設定変更時は古い timing の行を消す）。
 */
function queueKey_(eventId, timing) {
  return String(eventId) + '|' + String(timing);
}

/* ---------- sent_log ---------- */

/** 送信済みキーの集合。キューの絞り込みで毎回引くため、まとめて作る。 */
function sentKeySet_() {
  var rows = tableRead_(SHEET.SENT_LOG);
  var set = {};

  for (var i = 0; i < rows.length; i++) {
    set[String(rows[i].key)] = true;
  }

  return set;
}

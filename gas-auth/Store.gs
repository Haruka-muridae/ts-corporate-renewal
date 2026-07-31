/**
 * スプレッドシート操作層。
 *
 * 上位（Users.gs / Sessions.gs など）はここだけを通してシートへ触る。
 * 「どのファイルのどのシートか」を上位が知らずに済むようにする。
 *
 * ------------------------------------------------------------------
 * ファイルの特定
 * ------------------------------------------------------------------
 * Script Properties に保存した ID で開く。
 * 毎回フォルダ名で検索すると遅く、同名フォルダがあると誤って別物を開く。
 *
 * ID が未設定の場合は例外を投げ、setupAuthSystem() の実行を促す。
 * ------------------------------------------------------------------
 */

/** ID で開く。未設定・開けない場合は分かりやすい例外にする。 */
function openSpreadsheetByProperty_(propertyKey, label) {
  var id = getProperty_(propertyKey);

  if (id === '') {
    throw new Error(label + ' が未設定です。setupAuthSystem() を実行してください。（' + propertyKey + '）');
  }

  try {
    return SpreadsheetApp.openById(id);
  } catch (err) {
    throw new Error(label + ' を開けませんでした。Script Property ' + propertyKey + ' の値を確認してください。');
  }
}

function getUserSpreadsheet_() {
  return openSpreadsheetByProperty_(PROP.USER_SPREADSHEET_ID, DRIVE.USER_FILE_NAME);
}

function getLogSpreadsheet_() {
  return openSpreadsheetByProperty_(PROP.LOG_SPREADSHEET_ID, DRIVE.LOG_FILE_NAME);
}

function getConfigSpreadsheet_() {
  return openSpreadsheetByProperty_(PROP.CONFIG_SPREADSHEET_ID, DRIVE.CONFIG_FILE_NAME);
}

function getLegalSpreadsheet_() {
  return openSpreadsheetByProperty_(PROP.LEGAL_SPREADSHEET_ID, DRIVE.LEGAL_FILE_NAME);
}

/** シート名から、それが属するスプレッドシートを決める。 */
function spreadsheetForSheet_(sheetName) {
  if (sheetName === SHEETS.LEGAL_META
    || sheetName === SHEETS.LEGAL_TERMS
    || sheetName === SHEETS.LEGAL_PRIVACY
    || sheetName === SHEETS.LEGAL_TOKUSHO) {
    return getLegalSpreadsheet_();
  }

  if (sheetName === SHEETS.SETTINGS
    || sheetName === SHEETS.PLANS
    || sheetName === SHEETS.CONSENT_ITEMS
    || sheetName === SHEETS.CONFIRM_SECTIONS) {
    return getConfigSpreadsheet_();
  }

  if (sheetName === SHEETS.LOGIN_LOGS
    || sheetName === SHEETS.ADMIN_ACTION_LOGS
    || sheetName === SHEETS.SYSTEM_ERROR_LOGS) {
    return getLogSpreadsheet_();
  }

  return getUserSpreadsheet_();
}

/** シートを取得する。無ければ例外。 */
function getSheet_(sheetName) {
  var sheet = spreadsheetForSheet_(sheetName).getSheetByName(sheetName);

  if (!sheet) {
    throw new Error('シートが見つかりません: ' + sheetName + '（setupAuthSystem() を実行してください）');
  }

  return sheet;
}

/**
 * データ行をすべて読む（ヘッダーを除く）。
 * 戻り値は二次元配列。データが無ければ空配列。
 *
 * 想定利用者は数十人規模のため、全件読みで十分に速い。
 * 桁が変わったら索引シートの導入を検討する（README に記載）。
 */
function readRows_(sheetName) {
  var sheet = getSheet_(sheetName);
  var lastRow = sheet.getLastRow();
  var columns = HEADERS[sheetName].length;

  if (lastRow < 2) {
    return [];
  }

  return sheet.getRange(2, 1, lastRow - 1, columns).getValues();
}

/** 1行追記する。値は HEADERS の順に並べること。 */
function appendRow_(sheetName, values) {
  var sheet = getSheet_(sheetName);
  var columns = HEADERS[sheetName].length;
  var row = [];

  for (var i = 0; i < columns; i++) {
    row.push(values[i] === undefined || values[i] === null ? '' : values[i]);
  }

  sheet.appendRow(row);
  return row;
}

/** 指定行の1セルを更新する（rowNumber は実際の行番号＝ヘッダー込み）。 */
function updateCell_(sheetName, rowNumber, column, value) {
  getSheet_(sheetName).getRange(rowNumber, column, 1, 1).setValue(value);
}

/**
 * 指定行の複数セルをまとめて更新する。
 * updates は { 列番号: 値 } の形。書き込み回数を減らすために使う。
 */
function updateCells_(sheetName, rowNumber, updates) {
  var sheet = getSheet_(sheetName);
  var columns = Object.keys(updates);

  for (var i = 0; i < columns.length; i++) {
    var column = Number(columns[i]);
    sheet.getRange(rowNumber, column, 1, 1).setValue(updates[columns[i]]);
  }
}

/**
 * 条件に合う最初の行を探す。
 * 戻り値: { rowNumber, values } または null。
 *
 * @param {string} sheetName
 * @param {function(Array):boolean} predicate
 */
function findRow_(sheetName, predicate) {
  var rows = readRows_(sheetName);

  for (var i = 0; i < rows.length; i++) {
    if (predicate(rows[i])) {
      return { rowNumber: i + 2, values: rows[i] };
    }
  }

  return null;
}

/** 条件に合う行をすべて返す。 */
function findRows_(sheetName, predicate) {
  var rows = readRows_(sheetName);
  var out = [];

  for (var i = 0; i < rows.length; i++) {
    if (predicate(rows[i])) {
      out.push({ rowNumber: i + 2, values: rows[i] });
    }
  }

  return out;
}

/**
 * いま自分がロックを持っている深さ。
 *
 * LockService のロックはスクリプト単位のため、同じ実行の中で
 * 二重に tryLock すると **自分自身を待って** タイムアウトする。
 * 入れ子（例: Webhook 処理の中でユーザー作成）を安全にするため、
 * 深さを数えて最外周だけが実際のロックを取る。
 */
var lockDepth_ = 0;
var heldLock_ = null;

/**
 * 排他制御つきで処理を実行する。
 *
 * ユーザー作成・失敗回数の更新・トークンの使用・Webhook 処理など、
 * 「読んでから書く」処理は必ずこれで囲む。
 * 囲まないと、同時実行で片方の更新が消える。
 *
 * 入れ子で呼んでもよい（外側のロックをそのまま使う）。
 * ロックを取れなかった場合は例外を投げる（黙って処理を続けない）。
 */
function withLock_(fn, timeoutMs) {
  if (lockDepth_ > 0) {
    lockDepth_++;

    try {
      return fn();
    } finally {
      lockDepth_--;
    }
  }

  var wait = Number(timeoutMs);

  if (!isFinite(wait) || wait <= 0) {
    wait = 20000;
  }

  var lock = LockService.getScriptLock();

  if (!lock.tryLock(wait)) {
    throw new Error('LOCK_TIMEOUT');
  }

  heldLock_ = lock;
  lockDepth_ = 1;

  try {
    return fn();
  } finally {
    lockDepth_ = 0;
    heldLock_ = null;

    /* flush してからロックを離す。書き込みが反映される前に次が走らないように。 */
    try {
      SpreadsheetApp.flush();
    } catch (err) {
      /* flush できなくてもロックは必ず離す。 */
    }

    lock.releaseLock();
  }
}

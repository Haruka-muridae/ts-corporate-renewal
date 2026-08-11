/**
 * シート I/O の共通口。
 *
 * 上位（Posts.gs / Scheduler.gs / Threads.gs / WebApp.gs）は、
 * シートへの書き込みを必ずここ経由で行う。理由は2つ。
 *
 * 1. 「=」始まりの文字列が数式解釈されて #ERROR! になる事故
 *    （一想の note 取り込みで実際に発生）への対策を1か所に集める。
 * 2. シートは手動で用意せず、実行時に ensureSheet_() で解決する
 *    （要件 threads-mvp-requirements-v1.md §3.2）。
 */

var SHEET = {
  DRAFTS: '下書き',
  RESERVATIONS: '予約',
  HISTORY: '履歴'
};

/**
 * 各シートの列。**順序がそのまま列順**で、途中へ挿入しない（末尾へ足す）。
 * 時刻はすべてエポックミリ秒の数値で持つ（文字列だとタイムゾーンの解釈が
 * 環境に依存するため。gas-notifier と同じ方針）。
 */
var HEADERS = {
  '下書き': ['id', '本文', '作成日時'],
  '予約': ['id', '本文', '予定日時', '状態', '登録日時', '実行日時', 'エラー'],
  '履歴': ['id', '日時', '種別', '本文', '成否', 'エラー']
};

/**
 * 数式・メンションとして解釈される先頭文字。
 * 「=」だけでなく「+」「@」も Sheets では数式・スマートチップの起点になるため
 * まとめて対策する（「-」は負数の入力と区別できず誤爆が多いので対象外。
 * 本文が「-」で始まっても数値に見えない限り文字列のまま保存される）。
 */
function escapeCellValue_(value) {
  if (typeof value !== 'string') {
    return value;
  }

  if (value.charAt(0) === '=' || value.charAt(0) === '+' || value.charAt(0) === '@') {
    /* 先頭のアポストロフィは Sheets が「文字列である」印として扱い、
       読み出し時の値には含まれない。原本データは汚れない。 */
    return "'" + value;
  }

  return value;
}

/** シート不整合。呼び出し側はこれを握りつぶさず、記録して止まる。 */
function sheetMismatchError_(name, expected, actual) {
  var error = new Error(
    'シート「' + name + '」のヘッダーが定義と一致しません。' +
    '期待: [' + expected.join(', ') + '] / 実際: [' + actual.join(', ') + ']。' +
    '既存データを壊さないため、自動では修復しません。'
  );
  error.name = 'SheetMismatchError';
  return error;
}

/**
 * シートを実行時に解決する（要件 §3.2 の3分岐）。
 *   1. 無ければ生成してヘッダーを書く。
 *   2. あってヘッダーが一致すればそのまま返す。
 *   3. あるがヘッダーが不一致なら、書き込まずにエラーで止める。
 */
function ensureSheet_(name) {
  var headers = HEADERS[name];

  if (!headers) {
    throw new Error('未定義のシート名: ' + name);
  }

  var book = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = book.getSheetByName(name);

  if (!sheet) {
    sheet = book.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    return sheet;
  }

  var actual = sheet.getLastRow() === 0
    ? []
    : sheet.getRange(1, 1, 1, headers.length).getValues()[0];

  for (var i = 0; i < headers.length; i += 1) {
    if (String(actual[i] || '') !== headers[i]) {
      throw sheetMismatchError_(name, headers, actual);
    }
  }

  return sheet;
}

/** 行を追加する（全書き込みの共通口）。値は必ずエスケープを通す。 */
function appendRowTo_(name, values) {
  var sheet = ensureSheet_(name);
  sheet.appendRow(values.map(escapeCellValue_));
  return sheet;
}

/**
 * 1行の一部の列を書き換える（状態遷移用）。
 * rowNumber は 1 始まり（ヘッダーが 1 行目）、patch は { 列名: 値 }。
 */
function updateRowIn_(name, rowNumber, patch) {
  var sheet = ensureSheet_(name);
  var headers = HEADERS[name];

  Object.keys(patch).forEach(function (key) {
    var column = headers.indexOf(key) + 1;

    if (column === 0) {
      throw new Error('シート「' + name + '」に列「' + key + '」はありません');
    }

    sheet.getRange(rowNumber, column).setValue(escapeCellValue_(patch[key]));
  });
}

/** 全行を { 列名: 値 } の配列で読む。rowNumber（1始まり）を添える。 */
function readRowsFrom_(name) {
  var sheet = ensureSheet_(name);
  var headers = HEADERS[name];
  var lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return [];
  }

  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();

  return values.map(function (row, index) {
    var out = { rowNumber: index + 2 };

    headers.forEach(function (key, column) {
      out[key] = row[column];
    });

    return out;
  });
}

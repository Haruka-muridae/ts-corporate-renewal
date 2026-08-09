/*
 * Settings.gs — 段階ごとの生成オプション
 *
 * 既定値は Config.gs（ISSO_DEFAULT_SETTINGS）に持ち、**シートは上書き用**。
 * シートが空でも動く。空の値は「未設定」として既定へ戻す
 * （プロンプト側で目安が空になると、出力形式の指示行ごと落ちるため）。
 */

/** 1件読む。未設定なら既定値、それも無ければ空文字。 */
function IssoSettings_get(store, key) {
  var row = store.findById(ISSO_SHEET.SETTINGS, key);

  if (row !== null && String(row.value).replace(/^\s+|\s+$/g, '') !== '') {
    return row.value;
  }

  var fallback = ISSO_DEFAULT_SETTINGS[key];

  return fallback === undefined ? '' : fallback;
}

/** 既定値に保存済みを重ねて返す。画面はこれ1つを読めばよい。 */
function IssoSettings_all(store) {
  var out = {};
  var key;

  for (key in ISSO_DEFAULT_SETTINGS) {
    if (Object.prototype.hasOwnProperty.call(ISSO_DEFAULT_SETTINGS, key)) {
      out[key] = ISSO_DEFAULT_SETTINGS[key];
    }
  }

  var rows = store.getAll(ISSO_SHEET.SETTINGS);

  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].value).replace(/^\s+|\s+$/g, '') !== '') {
      out[rows[i].key] = rows[i].value;
    }
  }

  return out;
}

/** 1件書く。既にあれば上書き、無ければ足す。 */
function IssoSettings_set(store, key, value) {
  var row = store.findById(ISSO_SHEET.SETTINGS, key);

  if (row === null) {
    return store.insert(ISSO_SHEET.SETTINGS, { key: key, value: String(value) });
  }

  return store.update(ISSO_SHEET.SETTINGS, key, { value: String(value) });
}

/**
 * 段階の目安（文字数・尺）。
 *
 * どの settings キーを見るかは **Prompts.gs（生成物）の
 * ISSO_STAGE_SETTING_KEY** が宣言している。ここで対応表を持たない。
 */
function IssoSettings_lengthFor(store, stage) {
  var key = ISSO_STAGE_SETTING_KEY[stage];

  return key ? IssoSettings_get(store, key) : '';
}

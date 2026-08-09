/*
 * Config.gs — 定数・列定義・Script Properties
 *
 * ==================================================================
 * 方針
 * ==================================================================
 *   - **シートID・認証情報をコードに書かない。** Script Properties へ置く
 *     （gas-auth と同じ流儀。リポジトリは公開されている）
 *   - **列定義をここに集約する。** Sheets.gs も Tests.gs も、
 *     画面もここを見る。列を足すときはここだけを直す
 *   - 値が無いときは「使う時点で」名前付きの例外にする。起動時に
 *     全体を巻き添えにしない（lib/event/config.mjs と同じ考え方）
 * ==================================================================
 */

/** シート名。文字列を直接書かず、必ずここを参照する。 */
var ISSO_SHEET = {
  THEMES: 'themes',
  VERSIONS: 'versions',
  SCENES: 'scenes',
  QUEUE: 'generation_queue',
  POSTS: 'posts',
  SETTINGS: 'settings'
};

/*
 * 列定義。
 *
 * `type` は Sheets から読んだ値をどう解釈するかを決める。
 * **Sheets は同じ列でも boolean を返したり文字列を返したりする**
 * （TRUE と書いたか 'TRUE' と書いたかで変わる）。ここで型を宣言し、
 * Sheets.gs が正規化する。宣言が無いと、TRUE/FALSE の判定が
 * 「シートをどう編集したか」に依存して壊れる。
 *
 * **本文（body / source_text / prompt / result）は最後に置く。**
 * 長いので、前の列を読むのに横スクロールさせない（v1.0-personal §4）。
 */
var ISSO_COLUMNS = {
  themes: [
    { key: 'theme_id', type: 'string' },
    { key: 'title', type: 'string' },
    { key: 'audience', type: 'string' },
    { key: 'memo', type: 'string' },
    { key: 'status', type: 'string' },
    { key: 'created_at', type: 'string' },
    { key: 'updated_at', type: 'string' },
    { key: 'source_text', type: 'string' }
  ],
  versions: [
    { key: 'version_id', type: 'string' },
    { key: 'theme_id', type: 'string' },
    { key: 'stage', type: 'string' },
    { key: 'version_no', type: 'number' },
    { key: 'parent_version_id', type: 'string' },
    { key: 'adopted', type: 'boolean' },
    { key: 'edited_by_user', type: 'boolean' },
    { key: 'created_at', type: 'string' },
    { key: 'body', type: 'string' }
  ],
  scenes: [
    { key: 'scene_id', type: 'string' },
    { key: 'version_id', type: 'string' },
    { key: 'order', type: 'number' },
    { key: 'narration', type: 'string' },
    { key: 'visual_prompt', type: 'string' },
    { key: 'subtitle', type: 'string' }
  ],
  generation_queue: [
    { key: 'request_id', type: 'string' },
    { key: 'theme_id', type: 'string' },
    { key: 'stage', type: 'string' },
    { key: 'status', type: 'string' },
    { key: 'requested_at', type: 'string' },
    { key: 'completed_at', type: 'string' },
    { key: 'error', type: 'string' },
    { key: 'prompt', type: 'string' },
    { key: 'result', type: 'string' }
  ],
  posts: [
    { key: 'post_id', type: 'string' },
    { key: 'theme_id', type: 'string' },
    { key: 'version_id', type: 'string' },
    { key: 'platform', type: 'string' },
    { key: 'status', type: 'string' },
    { key: 'posted_at', type: 'string' },
    { key: 'url', type: 'string' },
    { key: 'error', type: 'string' }
  ],
  settings: [
    { key: 'key', type: 'string' },
    { key: 'value', type: 'string' }
  ]
};

/** 各シートの主キー列。1列目を主キーにそろえてある。 */
var ISSO_PRIMARY_KEY = {
  themes: 'theme_id',
  versions: 'version_id',
  scenes: 'scene_id',
  generation_queue: 'request_id',
  posts: 'post_id',
  settings: 'key'
};

/** ID の接頭辞。値を見ただけでどのシートのものか分かるようにする。 */
var ISSO_ID_PREFIX = {
  themes: 'thm',
  versions: 'ver',
  scenes: 'scn',
  generation_queue: 'req',
  posts: 'pst'
};

/**
 * 投稿先。**段階IDと同じ語**にしてある（`versions.stage` からそのまま引ける）。
 * note は Helper 経由なので、一想が直接投稿する先はこの2つだけ。
 */
var ISSO_PLATFORM = {
  THREADS: 'threads',
  X: 'x'
};

/** 状態値。**画面・GAS・Flow がこの語を共有する。** */
var ISSO_STATUS = {
  /*
   * generation_queue.status — Flow はこの語を書き戻す
   *
   * **「完了」と「取込済」を分けてある。**
   * 「完了」は Flow が結果を書いた状態、「取込済」は GAS が versions へ
   * 取り込んだ状態。分けないと、画面で更新を2回押したときに
   * **同じ結果から版が二重に作られる。**
   */
  QUEUE_WAITING: '待機',
  QUEUE_RUNNING: '処理中',
  QUEUE_DONE: '完了',
  QUEUE_INGESTED: '取込済',
  QUEUE_FAILED: '失敗',
  /* themes.status */
  THEME_DRAFT: 'draft',
  THEME_ARCHIVED: 'archived',
  /* posts.status */
  POST_OK: '成功',
  POST_FAILED: '失敗',
  POST_HANDED_TO_HELPER: 'Helper へ引き渡し済み'
};

/**
 * settings の既定値。**シートは上書き用**で、空でも動くようにする。
 * 段階ごとの目安は Prompts.gs（生成物）の既定と同じ値を持つ。
 */
var ISSO_DEFAULT_SETTINGS = {
  'threads.lengthHint': '50〜150字',
  'x.lengthHint': '150〜300字',
  'note.lengthHint': '1,500〜3,000字',
  'script.durationHint': '5〜10分',
  'tone': '',
  /*
   * X への1か月あたりの投稿上限。**課金の歯止め**（手順書 §E-4）。
   *
   * X 側にも支出上限を設定するが、**こちらは件数で止める。**
   * 単価が変わっても件数の見込みは変わらないため、
   * 「気づいたら請求が増えていた」という壊れ方をしにくい。
   *
   * 0 にすると X への投稿を止められる。
   */
  'x.monthlyPostLimit': '60'
};

/**
 * Script Properties を1件読む。
 *
 * BOM と前後の空白を落とす。**貼り付け経路によっては先頭に BOM が混ざる**
 * ことがあり、そのままだとIDが一致せず「シートが見つからない」になる
 * （lib/event/config.mjs で同じ手当てをしている）。
 */
function IssoConfig_prop(name) {
  var raw = PropertiesService.getScriptProperties().getProperty(name);

  if (raw === null || raw === undefined) {
    return null;
  }

  var value = String(raw).replace(/^﻿/, '').replace(/^\s+|\s+$/g, '');

  return value === '' ? null : value;
}

/** 必須の Script Property。無ければ**名前付きで**落とす。 */
function IssoConfig_requireProp(name) {
  var value = IssoConfig_prop(name);

  if (value === null) {
    throw new Error(
      'Script Properties に ' + name + ' が設定されていません。'
      + '「プロジェクトの設定 → スクリプト プロパティ」で設定してください。'
    );
  }

  return value;
}

/** 一想スプレッドシートのID。 */
function IssoConfig_spreadsheetId() {
  return IssoConfig_requireProp('ISSO_SPREADSHEET_ID');
}

/**
 * Helper（Note Draft Helper）の記事キュー。
 *
 * **Helper には手を入れず、ここへ1行 insert するだけ**（v1.0-personal §7-2）。
 * 列定義は実物から特定するまで未確定のため、ここでは所在だけを持つ。
 */
function IssoConfig_helperTarget() {
  return {
    spreadsheetId: IssoConfig_requireProp('HELPER_SPREADSHEET_ID'),
    sheetName: IssoConfig_requireProp('HELPER_SHEET_NAME')
  };
}

/**
 * Script Properties を1件書く。
 *
 * **トークンの自動更新（Threads）でだけ使う。** ほかは手で設定する。
 */
function IssoConfig_setProp(name, value) {
  PropertiesService.getScriptProperties().setProperty(name, String(value));
}

/**
 * Threads の資格情報（手順書 §D-3）。
 *
 * `THREADS_APP_ID` / `THREADS_APP_SECRET` を持つのは**トークンの更新のため。**
 * 投稿だけなら要らないが、**長期トークンは60日で切れる**ので、
 * 無いと2か月ごとに手で取り直すことになる。
 */
function IssoThreads_credentials() {
  return {
    userId: IssoConfig_requireProp('THREADS_USER_ID'),
    accessToken: IssoConfig_requireProp('THREADS_ACCESS_TOKEN'),
    /* 更新用。**無くても投稿はできる**ので required にしない。 */
    appId: IssoConfig_prop('THREADS_APP_ID'),
    appSecret: IssoConfig_prop('THREADS_APP_SECRET')
  };
}

/**
 * X の資格情報（手順書 §E-3）。
 *
 * **OAuth 1.0a を採る。** 認可のリダイレクトを受けるページが要らず、
 * トークンに期限が無い（Threads と違い60日ごとの更新が不要）。
 * 署名は `Utilities.computeHmacSignature` で足りるため、
 * **外部ライブラリを足さずに済む**（[AGENTS.md](../AGENTS.md)）。
 */
function IssoX_credentials() {
  return {
    apiKey: IssoConfig_requireProp('X_API_KEY'),
    apiSecret: IssoConfig_requireProp('X_API_SECRET'),
    accessToken: IssoConfig_requireProp('X_ACCESS_TOKEN'),
    accessTokenSecret: IssoConfig_requireProp('X_ACCESS_TOKEN_SECRET')
  };
}

/**
 * ID を作る。
 *
 * `Utilities.getUuid()` は Apps Script の標準。テストでは差し替えられるよう、
 * 生成関数を引数で受けられるようにしてある。
 */
function IssoConfig_newId(sheetName, uuidFn) {
  var prefix = ISSO_ID_PREFIX[sheetName];

  if (!prefix) {
    throw new Error('ID の接頭辞が未定義のシートです: ' + sheetName);
  }

  var uuid = uuidFn ? uuidFn() : Utilities.getUuid();

  return prefix + '_' + uuid;
}

/** いまの時刻（ISO 8601）。テストで固定できるよう関数にしてある。 */
function IssoConfig_now(nowFn) {
  return nowFn ? nowFn() : new Date().toISOString();
}

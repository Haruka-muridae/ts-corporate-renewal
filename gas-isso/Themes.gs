/*
 * Themes.gs — テーマ（着想）の読み書き
 *
 * ポートに対して書く。SpreadsheetApp は知らない（Sheets.gs の責務）。
 * `lib/pipeline/db/projects.mjs` と同じ考え方（第2段への移植性・roadmap §1 要件2）。
 */

/**
 * テーマを作る。
 *
 * @param {object} store IssoSheets_create() の戻り
 * @param {{ source_text: string, title?: string, audience?: string, memo?: string }} input
 * @param {{ now?: function, uuid?: function }} [deps] テストで固定するための口
 */
function IssoThemes_create(store, input, deps) {
  deps = deps || {};

  var source = String((input && input.source_text) || '').replace(/^\s+|\s+$/g, '');

  if (source === '') {
    /* 着想が無いとパイプラインが始まらない（FR-001）。空で作らせない。 */
    throw new Error('着想を入力してください。');
  }

  var at = IssoConfig_now(deps.now);

  var theme = {
    theme_id: IssoConfig_newId(ISSO_SHEET.THEMES, deps.uuid),
    title: String((input && input.title) || '').replace(/^\s+|\s+$/g, ''),
    audience: String((input && input.audience) || '').replace(/^\s+|\s+$/g, ''),
    memo: String((input && input.memo) || '').replace(/^\s+|\s+$/g, ''),
    status: ISSO_STATUS.THEME_DRAFT,
    created_at: at,
    updated_at: at,
    source_text: source
  };

  store.insert(ISSO_SHEET.THEMES, theme);

  return theme;
}

/** IDで引く。無ければ null。 */
function IssoThemes_get(store, themeId) {
  return store.findById(ISSO_SHEET.THEMES, themeId);
}

/**
 * 更新する。`updated_at` は必ずこちらで打つ。
 *
 * 呼び出し側に任せると、更新順に並べたときの一覧が壊れる。
 * `theme_id` と `created_at` は書き換えさせない（来歴が追えなくなる）。
 */
function IssoThemes_update(store, themeId, patch, deps) {
  deps = deps || {};

  var current = store.findById(ISSO_SHEET.THEMES, themeId);

  if (current === null) {
    throw new Error('テーマが見つかりません: ' + themeId);
  }

  /*
   * 許可制にしてある。列を足したときはここにも足す必要があるが、
   * 足し忘れても「保存されない」で済み、壊れた値が入るより安全。
   */
  var allowed = ['title', 'audience', 'memo', 'status', 'source_text'];
  var next = {};

  for (var i = 0; i < allowed.length; i++) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, allowed[i])) {
      next[allowed[i]] = patch[allowed[i]];
    }
  }

  next.updated_at = IssoConfig_now(deps.now);

  return store.update(ISSO_SHEET.THEMES, themeId, next);
}

/**
 * 一覧。**更新の新しい順**（画面の並び）。
 *
 * 既定では archived を出さない。
 */
function IssoThemes_list(store, options) {
  options = options || {};

  var all = store.getAll(ISSO_SHEET.THEMES);
  var out = [];

  for (var i = 0; i < all.length; i++) {
    if (options.includeArchived !== true && all[i].status === ISSO_STATUS.THEME_ARCHIVED) {
      continue;
    }

    out.push(all[i]);
  }

  out.sort(function (a, b) {
    if (a.updated_at === b.updated_at) {
      return 0;
    }

    return a.updated_at < b.updated_at ? 1 : -1;
  });

  return out;
}

/**
 * テーマを消す。**ぶら下がる版とシーンも一緒に消す。**
 *
 * **Sheets に外部キー制約は無い。** ここで消し漏らすと、どこからも
 * 参照されない版がシートに残り続け、手で開いたときに混乱のもとになる。
 */
function IssoThemes_remove(store, themeId) {
  var versions = store.findBy(ISSO_SHEET.VERSIONS, 'theme_id', themeId);

  for (var i = 0; i < versions.length; i++) {
    IssoScenes_remove(store, versions[i].version_id);
    store.remove(ISSO_SHEET.VERSIONS, versions[i].version_id);
  }

  store.remove(ISSO_SHEET.THEMES, themeId);
}

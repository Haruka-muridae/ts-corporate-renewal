/*
 * Versions.gs — 版の読み書きと**採用・派生**
 *
 * ==================================================================
 * ここが担っている要件
 * ==================================================================
 *   - 要件10章「重要」: parent_version_id による派生追跡。
 *     どの Threads 案からどの X・note が派生したかを辿れること
 *   - 要件15章: 「前段の**採用版**を次段の主要入力として扱う」
 *   - 要件15章: 「ユーザーが修正した表現を…AI原案より優先する」
 *     → edited_by_user を持ち、プロンプトの上流に印を付ける
 *   - FR-013: 複数案。**別シートにせず versions の複数行**として持ち、
 *     うち1件が adopted（案も版も「同じ段階の候補」で構造が同じ）
 *
 * 前段の並びは **Prompts.gs（生成物）の ISSO_STAGE_UPSTREAM** を見る。
 * ここで段階の順序を再定義しない。**単一ソースは definitions.mjs 側**であり、
 * ここに写しを持つと、プロンプトが渡す上流と画面の判定がずれる。
 * ==================================================================
 */

/**
 * 版を作る。`version_no` は同一 [theme_id, stage] 内の連番。
 *
 * @param {object} store
 * @param {{ theme_id: string, stage: string, body?: string,
 *           parent_version_id?: string, edited_by_user?: boolean }} input
 * @param {{ now?: function, uuid?: function }} [deps]
 */
function IssoVersions_create(store, input, deps) {
  deps = deps || {};

  if (!input || !input.theme_id || !input.stage) {
    throw new Error('theme_id と stage が必要です。');
  }

  if (ISSO_PROMPT_TEMPLATES[input.stage] === undefined) {
    /* 定義に無い段階の版を作らせない。あとで上流を辿れなくなる。 */
    throw new Error('未定義の段階です: ' + input.stage);
  }

  var siblings = IssoVersions_list(store, input.theme_id, input.stage);
  var maxNo = 0;

  for (var i = 0; i < siblings.length; i++) {
    if (siblings[i].version_no > maxNo) {
      maxNo = siblings[i].version_no;
    }
  }

  var version = {
    version_id: IssoConfig_newId(ISSO_SHEET.VERSIONS, deps.uuid),
    theme_id: input.theme_id,
    stage: input.stage,
    version_no: maxNo + 1,
    parent_version_id: input.parent_version_id || '',
    adopted: false,
    edited_by_user: input.edited_by_user === true,
    created_at: IssoConfig_now(deps.now),
    body: String(input.body === undefined || input.body === null ? '' : input.body)
  };

  store.insert(ISSO_SHEET.VERSIONS, version);

  return version;
}

/** 段階の版をすべて（新しい順）。 */
function IssoVersions_list(store, themeId, stage) {
  var all = store.findBy(ISSO_SHEET.VERSIONS, 'theme_id', themeId);
  var out = [];

  for (var i = 0; i < all.length; i++) {
    if (all[i].stage === stage) {
      out.push(all[i]);
    }
  }

  out.sort(function (a, b) { return b.version_no - a.version_no; });

  return out;
}

/**
 * 採用版を取る。
 *
 * **adopted が複数立っていた場合は version_no が最大のものを採る。**
 * 採用の切り替えは「旧を落として新を立てる」の2手なので、途中で
 * 中断されると2件立ちうる（実行が途中で止まる、シートを手で直す、など）。
 * そのとき画面が固まるより、**決定的に1件へ寄せて次の採用操作で直る**ほうがよい。
 */
function IssoVersions_getAdopted(store, themeId, stage) {
  var rows = IssoVersions_list(store, themeId, stage);
  var best = null;

  for (var i = 0; i < rows.length; i++) {
    if (rows[i].adopted !== true) {
      continue;
    }

    if (best === null || rows[i].version_no > best.version_no) {
      best = rows[i];
    }
  }

  return best;
}

/**
 * 採用する。**同一 [theme_id, stage] で adopted は高々1件。**
 *
 * 旧採用を落としてから新しいものを立てる。**落とすほうを先に**やるのは、
 * 途中で止まったときに「採用が2件」ではなく「採用が0件」で終わるため。
 * 0件なら画面が「未採用」を示し、押し直せば直る。
 */
function IssoVersions_adopt(store, versionId) {
  var target = store.findById(ISSO_SHEET.VERSIONS, versionId);

  if (target === null) {
    throw new Error('版が見つかりません: ' + versionId);
  }

  var siblings = IssoVersions_list(store, target.theme_id, target.stage);

  for (var i = 0; i < siblings.length; i++) {
    if (siblings[i].version_id !== versionId && siblings[i].adopted === true) {
      store.update(ISSO_SHEET.VERSIONS, siblings[i].version_id, { adopted: false });
    }
  }

  return store.update(ISSO_SHEET.VERSIONS, versionId, { adopted: true });
}

/**
 * 本文を編集する。**編集した事実を残す**（要件15章）。
 *
 * 版を作り直さず同じ版を書き換えるのは、「案の採用」と「文言の手直し」を
 * 別の操作として見せるため。手直しのたびに版が増えると、
 * どれが採用版か分からなくなる。
 */
function IssoVersions_editBody(store, versionId, body) {
  var current = store.findById(ISSO_SHEET.VERSIONS, versionId);

  if (current === null) {
    throw new Error('版が見つかりません: ' + versionId);
  }

  return store.update(ISSO_SHEET.VERSIONS, versionId, {
    body: String(body === undefined || body === null ? '' : body),
    edited_by_user: true
  });
}

/**
 * 次段の生成に渡す上流（**採用済みのものだけ**）。
 *
 * 要件15章「前段の採用版を主要入力とする」の実装。
 * **未採用の案は渡さない。** 渡すと、採用しなかった案の表現が次段に混ざる。
 *
 * 渡す段階は Prompts.gs の ISSO_STAGE_UPSTREAM が宣言している。
 * 返す形は `issoBuildPrompt` の `upstream` にそのまま渡せる形にする。
 */
function IssoVersions_collectUpstream(store, themeId, stage) {
  var wanted = ISSO_STAGE_UPSTREAM[stage];

  if (!wanted) {
    throw new Error('未定義の段階です: ' + stage);
  }

  var out = [];

  for (var i = 0; i < wanted.length; i++) {
    var adopted = IssoVersions_getAdopted(store, themeId, wanted[i]);

    if (adopted === null) {
      continue;
    }

    out.push({
      stage: wanted[i],
      label: ISSO_STAGE_LABELS[wanted[i]],
      body: adopted.body,
      editedByUser: adopted.edited_by_user === true
    });
  }

  return out;
}

/**
 * その段階を生成してよいか。
 *
 * **宣言された上流がすべて採用済みであること**を条件にする。
 *
 * ---------------------------------------------------------------
 * 【第2段との差】`lib/pipeline/db/versions.mjs` の canGenerate は
 * 「直前の段階だけ」を見ている。こちらは上流すべてを見る。
 *
 * 実運用ではパイプラインが順に進むため結果はほぼ同じだが、
 * **note の上流は [threads, x] の2つ**であり、x を採用したあとに
 * threads の採用を外すと、片方だけの上流でプロンプトが組まれる。
 * ここで止めるほうが、プロンプトの前提（宣言した上流が揃っている）と合う。
 *
 * 第2段を再開するときは、db 側もこの規則へ揃えること。
 * （db/versions.mjs の canGenerate にも同じ注記を置いてある）
 * ---------------------------------------------------------------
 */
function IssoVersions_canGenerate(store, themeId, stage) {
  var wanted = ISSO_STAGE_UPSTREAM[stage];

  if (!wanted) {
    throw new Error('未定義の段階です: ' + stage);
  }

  for (var i = 0; i < wanted.length; i++) {
    if (IssoVersions_getAdopted(store, themeId, wanted[i]) === null) {
      return false;
    }
  }

  return true;
}

/**
 * 新しい版の派生元にすべき版。
 *
 * **直前の段階の採用版**を指す。無ければ空文字。
 * 要件10章の派生追跡は、これを一貫して入れることで成り立つ。
 */
function IssoVersions_defaultParent(store, themeId, stage) {
  var wanted = ISSO_STAGE_UPSTREAM[stage];

  if (!wanted || wanted.length === 0) {
    return '';
  }

  var previous = wanted[wanted.length - 1];
  var adopted = IssoVersions_getAdopted(store, themeId, previous);

  return adopted === null ? '' : adopted.version_id;
}

/**
 * 派生の系譜を遡る。
 *
 * 要件10章が「体験の中核」としている追跡の実装。
 * **循環していても止まる**ようにしてある（手でシートを直したときに
 * 親子が輪になることがあり、そこで無限に回ると画面ごと固まる）。
 */
function IssoVersions_lineage(store, versionId) {
  var chain = [];
  var seen = {};
  var cursor = versionId;

  while (cursor) {
    if (seen[cursor] === true) {
      /* 輪になっている。ここで打ち切る。 */
      break;
    }

    seen[cursor] = true;

    var version = store.findById(ISSO_SHEET.VERSIONS, cursor);

    if (version === null) {
      break;
    }

    chain.push(version);
    cursor = version.parent_version_id;
  }

  return chain;
}

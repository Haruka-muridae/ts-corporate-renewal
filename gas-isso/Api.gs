/*
 * Api.gs — 画面が呼ぶ処理の本体
 *
 * ==================================================================
 * Main.gs との分担
 * ==================================================================
 *   Main.gs … doGet と、google.script.run から呼ばれる薄い入口。
 *             IssoSheets_open() で実シートのポートを作って渡すだけ
 *   Api.gs  … 実際の処理。**store を引数で受ける**ので、
 *             メモリ実装を差して Node でテストできる
 *
 * 画面へ返す値は **google.script.run が渡せる形**（素のオブジェクト・
 * 配列・文字列・数値・真偽値）に限る。日付オブジェクトや関数を混ぜない。
 * ==================================================================
 */

/**
 * 起動時に要るもの一式。
 *
 * `ensureSheets()` をここで呼ぶ。**何度実行しても既存を壊さない**ので、
 * 初回に手で初期化させる手順を1つ減らせる。
 */
function IssoApi_bootstrap(store) {
  store.ensureSheets();

  return {
    themes: IssoThemes_list(store),
    settings: IssoSettings_all(store),
    stages: IssoApi_stageMeta()
  };
}

/** 段階の見た目に要る情報。**並びと表示名は Prompts.gs（生成物）が正。** */
function IssoApi_stageMeta() {
  var out = [];

  for (var i = 0; i < ISSO_STAGE_IDS.length; i++) {
    var id = ISSO_STAGE_IDS[i];

    out.push({
      id: id,
      label: ISSO_STAGE_LABELS[id],
      candidates: ISSO_STAGE_CANDIDATES[id]
    });
  }

  return out;
}

/** テーマを作る。 */
function IssoApi_createTheme(store, input, deps) {
  return IssoThemes_create(store, input, deps);
}

/** テーマ一覧。 */
function IssoApi_listThemes(store, includeArchived) {
  return IssoThemes_list(store, { includeArchived: includeArchived === true });
}

/**
 * ワークスペースの状態。
 *
 * **画面が段階ごとに必要とするものを一度に返す。**
 * 段階ごとに呼び分けると、GAS の往復が段階数だけ増えて体感が悪くなる。
 */
function IssoApi_workspace(store, themeId, deps) {
  var theme = IssoThemes_get(store, themeId);

  if (theme === null) {
    throw new Error('テーマが見つかりません: ' + themeId);
  }

  var stages = [];

  for (var i = 0; i < ISSO_STAGE_IDS.length; i++) {
    var id = ISSO_STAGE_IDS[i];
    var versions = IssoVersions_list(store, themeId, id);
    var adopted = IssoVersions_getAdopted(store, themeId, id);
    var pending = IssoGeneration_pendingFor(store, themeId, id);

    /*
     * 台本だけシーン一覧を添える（AC-09 を画面で確かめられるように）。
     * **他の段階には付けない。** シーンを持つのは台本だけで、
     * 全段階に空配列を配ると画面側で「有る／無い」の判定が鈍る。
     */
    if (id === 'script') {
      for (var j = 0; j < versions.length; j++) {
        versions[j].scenes = IssoScenes_list(store, versions[j].version_id);
      }
    }

    /*
     * 投稿できる段階には、投稿済みかどうかを添える。
     * **画面がボタンを出すかどうかの根拠**になる（二度押しの手前で止める）。
     */
    if (id === ISSO_PLATFORM.THREADS || id === ISSO_PLATFORM.X) {
      for (var k = 0; k < versions.length; k++) {
        versions[k].posted = IssoApi_postedSummary(store, versions[k].version_id, id);
      }
    }

    stages.push({
      id: id,
      label: ISSO_STAGE_LABELS[id],
      candidates: ISSO_STAGE_CANDIDATES[id],
      canGenerate: IssoVersions_canGenerate(store, themeId, id),
      versions: versions,
      adoptedId: adopted === null ? '' : adopted.version_id,
      /*
       * 依頼が「完了」なら、画面は取り込みボタンを出す。
       * **prompt は返さない。** 画面で使わないうえ、長いので往復が重くなる。
       */
      request: pending === null ? null : {
        request_id: pending.request_id,
        status: pending.status,
        requested_at: pending.requested_at,
        error: pending.error
      }
    });
  }

  return {
    theme: theme,
    stages: stages,
    settings: IssoSettings_all(store),
    /* **今月の X の使用量を常に出す。** 課金は見えないところで増える。 */
    xUsage: IssoX_usage(store, deps),
    posts: IssoPosts_list(store, themeId)
  };
}

/**
 * その版の投稿の様子。**成功があればそれを、無ければ直近の失敗を返す。**
 *
 * 成功を優先するのは、**失敗して再試行して成功した**ときに
 * 「失敗」と見えては困るため。
 */
function IssoApi_postedSummary(store, versionId, platform) {
  var rows = store.findBy(ISSO_SHEET.POSTS, 'version_id', versionId);
  var latestFailure = null;

  for (var i = 0; i < rows.length; i++) {
    if (rows[i].platform !== platform) {
      continue;
    }

    if (rows[i].status === ISSO_STATUS.POST_OK) {
      return {
        ok: true,
        posted_at: rows[i].posted_at,
        url: rows[i].url,
        error: ''
      };
    }

    if (latestFailure === null || rows[i].posted_at > latestFailure.posted_at) {
      latestFailure = rows[i];
    }
  }

  if (latestFailure === null) {
    return null;
  }

  return {
    ok: false,
    posted_at: latestFailure.posted_at,
    url: '',
    error: latestFailure.error
  };
}

/**
 * 投稿する。
 *
 * **失敗も例外にせず記録して返す**（相手が返した理由を画面に出すため）。
 * 例外になるのは**送る前に止めたとき**（未採用・投稿済み・上限・長すぎ）だけで、
 * これは「送っていない」ことがはっきり分かるほうがよい。
 */
function IssoApi_post(store, versionId, platform, deps) {
  if (platform === ISSO_PLATFORM.THREADS) {
    return IssoThreads_post(store, versionId, deps);
  }

  if (platform === ISSO_PLATFORM.X) {
    return IssoX_post(store, versionId, deps);
  }

  throw new Error('この段階は投稿できません: ' + platform);
}

/** 生成を依頼する。 */
function IssoApi_requestGeneration(store, themeId, stage, deps) {
  var request = IssoGeneration_request(store, themeId, stage, deps);

  return {
    request_id: request.request_id,
    stage: request.stage,
    status: request.status,
    /* 手で Studio へ貼る運用のために、プロンプトはここでだけ返す。 */
    prompt: request.prompt
  };
}

/**
 * 依頼の様子を見て、完了していれば取り込む。
 *
 * 画面の「更新」ボタンがこれを呼ぶ。**完了していなければ何もしない。**
 */
function IssoApi_refresh(store, requestId, deps) {
  var request = store.findById(ISSO_SHEET.QUEUE, requestId);

  if (request === null) {
    throw new Error('依頼が見つかりません: ' + requestId);
  }

  if (request.status !== ISSO_STATUS.QUEUE_DONE) {
    return { ingested: false, status: request.status, error: request.error };
  }

  var result = IssoGeneration_ingest(store, requestId, deps);

  return {
    ingested: true,
    status: ISSO_STATUS.QUEUE_INGESTED,
    error: '',
    created: result.versions.length,
    scenes: result.scenes.length
  };
}

/**
 * 結果を手で貼る（Flow が無いとき・Flow が失敗したとき）。
 *
 * v1.0-personal §10 の「4 を Flow 抜きで先に通す」を画面から行えるようにする。
 * **貼ったあとそのまま取り込みまで進める。**
 */
function IssoApi_submitResult(store, requestId, text, deps) {
  IssoGeneration_complete(store, requestId, text, deps);

  return IssoApi_refresh(store, requestId, deps);
}

/** 採用する。 */
function IssoApi_adopt(store, versionId) {
  return IssoVersions_adopt(store, versionId);
}

/**
 * 本文を手直しする。
 *
 * **台本を手直ししたら、シーンも読み直す。**
 * `versions.body` が原本で `scenes` はそこから読み取った構造なので、
 * 本文だけ変えるとシーン一覧が古いまま画面に残り、どちらが本当か
 * 分からなくなる。
 *
 * 読み直せない手直し（区切りを壊した、シーンが1件になった）は
 * **例外にして、本文も保存しない。** 保存してから読み直しに失敗すると、
 * AC-09 を満たさない台本がシートに残ってしまう。
 */
function IssoApi_editBody(store, versionId, body, deps) {
  var current = store.findById(ISSO_SHEET.VERSIONS, versionId);

  if (current === null) {
    throw new Error('版が見つかりません: ' + versionId);
  }

  if (current.stage !== 'script') {
    return IssoVersions_editBody(store, versionId, body);
  }

  /* 読めることを先に確かめる。ここで落ちれば本文もシーンも元のまま。 */
  var parsed = IssoScenes_fromBody(body);

  if (parsed.ok !== true) {
    throw new Error(parsed.reason);
  }

  var updated = IssoVersions_editBody(store, versionId, body);

  IssoScenes_replace(store, versionId, parsed.scenes, deps);

  return updated;
}

/** 設定を保存する。渡された分だけ書く。 */
function IssoApi_saveSettings(store, values) {
  var key;

  for (key in values) {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      IssoSettings_set(store, key, values[key]);
    }
  }

  return IssoSettings_all(store);
}

/** テーマを消す（版とシーンも一緒に）。 */
function IssoApi_removeTheme(store, themeId) {
  IssoThemes_remove(store, themeId);

  return IssoThemes_list(store);
}

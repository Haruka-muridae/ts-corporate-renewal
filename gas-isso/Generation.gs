/*
 * Generation.gs — 生成の依頼と取り込み
 *
 * ==================================================================
 * 一想は Gemini を直接呼ばない
 * ==================================================================
 *   1. GAS がプロンプトを組み立て、generation_queue に1行（待機）
 *   2. Flow が拾って Gemini へ渡し、result に書いて「完了」にする
 *   3. GAS が result を解釈して versions へ取り込み、「取込済」にする
 *
 * **2 は Flow が無くても成立する。** result 列に手で貼れば 3 が動く。
 * Studio Flows の能力（v1.0-personal §9 確認事項②）が未確定でも
 * 実装と検証を進められるのは、この形にしてあるため。
 *
 * ==================================================================
 * 出力の解釈について
 * ==================================================================
 * 第1段は Flow 経由のため **Gemini の responseSchema が使えない。**
 * モデルが前置きやコードフェンスを付けることがあるので、
 * **行頭の区切り記号**で読む（definitions.mjs で選んだ理由）。
 *
 * 区切り記号は Prompts.gs（生成物）の ISSO_PROMPT_DELIMITER を見る。
 * **プロンプトと解析が同じ定義を見る**ようにしてある。片方だけ変えると、
 * 生成は成功しているのに取り込みで失敗する——という分かりにくい壊れ方をする。
 * ==================================================================
 */

/* ------------------------------------------------------------------
 * 解析（純粋関数）
 * ------------------------------------------------------------------ */

/**
 * コードフェンスを外す。
 *
 * responseSchema が使えないため、モデルが ``` で包むことがある。
 * 包まれたまま保存すると、note へ貼ったときにそのまま出る。
 */
function IssoGeneration_stripFences(text) {
  var value = String(text === undefined || text === null ? '' : text);

  value = value.replace(/^\s*```[a-zA-Z0-9_-]*\s*\n/, '');
  value = value.replace(/\n\s*```\s*$/, '');

  return value.replace(/^\s+|\s+$/g, '');
}

/**
 * 行頭が marker で始まる行で区切る。
 *
 * marker の行そのものは捨て、間の本文だけを返す。
 * **marker が1つも無ければ、全体を1ブロックとして返す**
 * （モデルが形式を無視したときに、何も取れないより1件取れたほうがよい）。
 */
function IssoGeneration_splitBlocks(text, marker) {
  var lines = IssoGeneration_stripFences(text).split(/\r?\n/);
  var blocks = [];
  var current = null;
  var i;

  for (i = 0; i < lines.length; i++) {
    if (lines[i].replace(/^\s+/, '').indexOf(marker) === 0) {
      if (current !== null) {
        blocks.push(current.join('\n'));
      }

      current = [];
      continue;
    }

    if (current !== null) {
      current.push(lines[i]);
    }
  }

  if (current !== null) {
    blocks.push(current.join('\n'));
  }

  if (blocks.length === 0) {
    var whole = IssoGeneration_stripFences(text);

    return whole === '' ? [] : [whole];
  }

  var out = [];

  for (i = 0; i < blocks.length; i++) {
    var trimmed = blocks[i].replace(/^\s+|\s+$/g, '');

    if (trimmed !== '') {
      out.push(trimmed);
    }
  }

  return out;
}

/** 複数案（threads）。 */
function IssoGeneration_parseCandidates(text) {
  return IssoGeneration_splitBlocks(text, ISSO_PROMPT_DELIMITER.CANDIDATE);
}

/**
 * note のタイトル候補と本文。
 *
 * **タイトル候補を捨てない。** Helper の記事キューは `title` を持つため、
 * バトン渡し（実装順序8）で必要になる。
 * 区切りが無ければ、全体を本文として扱う。
 */
function IssoGeneration_parseNote(text) {
  var value = IssoGeneration_stripFences(text);
  var lines = value.split(/\r?\n/);
  var titles = [];
  var body = [];
  var mode = 'body';
  var seenMarker = false;
  var i;

  for (i = 0; i < lines.length; i++) {
    var line = lines[i];
    var head = line.replace(/^\s+|\s+$/g, '');

    if (head.indexOf(ISSO_PROMPT_DELIMITER.TITLES) === 0) {
      mode = 'titles';
      seenMarker = true;
      continue;
    }

    if (head.indexOf(ISSO_PROMPT_DELIMITER.BODY) === 0) {
      mode = 'body';
      seenMarker = true;
      continue;
    }

    if (mode === 'titles') {
      if (head !== '') {
        /* 「1. 」のような番号が付いていたら落とす。 */
        titles.push(head.replace(/^[0-9]+[.)]\s*/, ''));
      }

      continue;
    }

    body.push(line);
  }

  return {
    titles: titles,
    body: body.join('\n').replace(/^\s+|\s+$/g, ''),
    /* 区切りが1つも無ければ、モデルが形式を無視したということ。 */
    structured: seenMarker
  };
}

/**
 * 台本のシーン。
 *
 * 各ブロックから「ナレーション:」「映像:」の行を拾う。
 * ラベルが無い行は直前のラベルの続きとして扱う（複数行に折り返されることがある）。
 */
function IssoGeneration_parseScenes(text) {
  var blocks = IssoGeneration_splitBlocks(text, ISSO_PROMPT_DELIMITER.SCENE);
  var scenes = [];
  var i;
  var j;

  for (i = 0; i < blocks.length; i++) {
    var lines = blocks[i].split(/\r?\n/);
    var narration = [];
    var visual = [];
    var target = null;

    for (j = 0; j < lines.length; j++) {
      var head = lines[j].replace(/^\s+|\s+$/g, '');

      if (head.indexOf(ISSO_PROMPT_DELIMITER.NARRATION) === 0) {
        target = narration;
        target.push(head.slice(ISSO_PROMPT_DELIMITER.NARRATION.length).replace(/^\s+/, ''));
        continue;
      }

      if (head.indexOf(ISSO_PROMPT_DELIMITER.VISUAL) === 0) {
        target = visual;
        target.push(head.slice(ISSO_PROMPT_DELIMITER.VISUAL.length).replace(/^\s+/, ''));
        continue;
      }

      if (target !== null && head !== '') {
        target.push(head);
      }
    }

    scenes.push({
      order: scenes.length,
      narration: narration.join('\n').replace(/^\s+|\s+$/g, ''),
      visual_prompt: visual.join('\n').replace(/^\s+|\s+$/g, ''),
      subtitle: ''
    });
  }

  return scenes;
}

/*
 * AC-09 の検証は **Scenes.gs の `IssoScenes_validate`** にある。
 * 当初ここに置いていたが、手直し（Api.gs）でも同じ規則が要るため移した。
 * 2か所に置くと、片方だけ直したときに静かにずれる。
 */

/* ------------------------------------------------------------------
 * 依頼
 * ------------------------------------------------------------------ */

/**
 * 生成を依頼する。プロンプトを組み立てて generation_queue へ1行足す。
 *
 * @param {object} store
 * @param {string} themeId
 * @param {string} stage
 * @param {{ now?: function, uuid?: function }} [deps]
 */
function IssoGeneration_request(store, themeId, stage, deps) {
  deps = deps || {};

  var theme = IssoThemes_get(store, themeId);

  if (theme === null) {
    throw new Error('テーマが見つかりません: ' + themeId);
  }

  if (ISSO_PROMPT_TEMPLATES[stage] === undefined) {
    throw new Error('未定義の段階です: ' + stage);
  }

  if (IssoVersions_canGenerate(store, themeId, stage) !== true) {
    /* 上流が採用されていない。画面はタブを押せなくしているが、念のため。 */
    throw new Error('前段が採用されていません。先に前の段階を採用してください。');
  }

  /*
   * 同じテーマ・段階で処理中の依頼があるなら足さない。
   * **二重に押されたときに、同じ内容の依頼が並ぶのを防ぐ。**
   */
  var pending = IssoGeneration_pendingFor(store, themeId, stage);

  if (pending !== null) {
    throw new Error('この段階はすでに依頼中です（' + pending.status + '）。');
  }

  var prompt = issoBuildPrompt(stage, {
    source: theme.source_text,
    upstream: IssoVersions_collectUpstream(store, themeId, stage),
    length: IssoSettings_lengthFor(store, stage),
    tone: IssoSettings_get(store, 'tone')
  });

  var request = {
    request_id: IssoConfig_newId(ISSO_SHEET.QUEUE, deps.uuid),
    theme_id: themeId,
    stage: stage,
    status: ISSO_STATUS.QUEUE_WAITING,
    requested_at: IssoConfig_now(deps.now),
    completed_at: '',
    error: '',
    prompt: prompt,
    result: ''
  };

  store.insert(ISSO_SHEET.QUEUE, request);

  return request;
}

/** 処理中（待機・処理中・完了）の依頼。**取込済と失敗は含めない。** */
function IssoGeneration_pendingFor(store, themeId, stage) {
  var rows = store.findBy(ISSO_SHEET.QUEUE, 'theme_id', themeId);

  for (var i = 0; i < rows.length; i++) {
    if (rows[i].stage !== stage) {
      continue;
    }

    if (rows[i].status === ISSO_STATUS.QUEUE_WAITING
      || rows[i].status === ISSO_STATUS.QUEUE_RUNNING
      || rows[i].status === ISSO_STATUS.QUEUE_DONE) {
      return rows[i];
    }
  }

  return null;
}

/** 待機中の依頼を古い順に返す。Flow が無いときの手動処理にも使う。 */
function IssoGeneration_listWaiting(store) {
  var rows = store.getAll(ISSO_SHEET.QUEUE);
  var out = [];

  for (var i = 0; i < rows.length; i++) {
    if (rows[i].status === ISSO_STATUS.QUEUE_WAITING) {
      out.push(rows[i]);
    }
  }

  out.sort(function (a, b) {
    if (a.requested_at === b.requested_at) {
      return 0;
    }

    return a.requested_at < b.requested_at ? -1 : 1;
  });

  return out;
}

/**
 * 結果を書き込む。**Flow がここへ書く代わりを、手でも行える。**
 *
 * Flow の設定が済むまではこれを使って通しで確認する
 * （v1.0-personal §10「4 を Flow 抜きで先に通す」）。
 */
function IssoGeneration_complete(store, requestId, resultText, deps) {
  deps = deps || {};

  var request = store.findById(ISSO_SHEET.QUEUE, requestId);

  if (request === null) {
    throw new Error('依頼が見つかりません: ' + requestId);
  }

  return store.update(ISSO_SHEET.QUEUE, requestId, {
    status: ISSO_STATUS.QUEUE_DONE,
    completed_at: IssoConfig_now(deps.now),
    error: '',
    result: String(resultText === undefined || resultText === null ? '' : resultText)
  });
}

/** 失敗させる。**結果は消さない**（あとで原因を追えるようにする）。 */
function IssoGeneration_fail(store, requestId, reason, deps) {
  deps = deps || {};

  return store.update(ISSO_SHEET.QUEUE, requestId, {
    status: ISSO_STATUS.QUEUE_FAILED,
    completed_at: IssoConfig_now(deps.now),
    error: String(reason === undefined || reason === null ? '' : reason)
  });
}

/* ------------------------------------------------------------------
 * 取り込み
 * ------------------------------------------------------------------ */

/**
 * 結果を versions へ取り込む。
 *
 * @returns {{ versions: Array, scenes: Array }} 作った版と、台本ならシーン
 */
function IssoGeneration_ingest(store, requestId, deps) {
  deps = deps || {};

  var request = store.findById(ISSO_SHEET.QUEUE, requestId);

  if (request === null) {
    throw new Error('依頼が見つかりません: ' + requestId);
  }

  /*
   * **取込済を弾く。** 画面で更新を2回押したときに、
   * 同じ結果から版が二重に作られるのを防ぐ。
   */
  if (request.status === ISSO_STATUS.QUEUE_INGESTED) {
    throw new Error('この依頼はすでに取り込み済みです。');
  }

  if (request.status !== ISSO_STATUS.QUEUE_DONE) {
    throw new Error('まだ完了していません（現在: ' + request.status + '）。');
  }

  var text = IssoGeneration_stripFences(request.result);

  if (text === '') {
    IssoGeneration_fail(store, requestId, '結果が空です。', deps);
    throw new Error('結果が空です。');
  }

  var stage = request.stage;
  var themeId = request.theme_id;
  var parent = IssoVersions_defaultParent(store, themeId, stage);
  var created = [];
  var scenes = [];
  var i;

  if (stage === 'threads') {
    var candidates = IssoGeneration_parseCandidates(text);

    if (candidates.length === 0) {
      IssoGeneration_fail(store, requestId, '案を読み取れませんでした。', deps);
      throw new Error('案を読み取れませんでした。');
    }

    for (i = 0; i < candidates.length; i++) {
      created.push(IssoVersions_create(store, {
        theme_id: themeId,
        stage: stage,
        body: candidates[i],
        parent_version_id: parent
      }, deps));
    }
  } else {
    if (stage === 'script') {
      scenes = IssoGeneration_parseScenes(text);

      var verdict = IssoScenes_validate(scenes);

      if (verdict.ok !== true) {
        /*
         * **AC-09 を満たさないものは取り込まない。**
         * 壊れた台本を versions に入れると、あとから直しようがなくなる。
         * 依頼を失敗にして、画面から再依頼できるようにする。
         *
         * **版を作る前に判定する。** 作ってから消すと、
         * 途中で落ちたときに親無しの版が残る。
         */
        IssoGeneration_fail(store, requestId, verdict.reason, deps);
        throw new Error(verdict.reason);
      }
    }

    var version = IssoVersions_create(store, {
      theme_id: themeId,
      stage: stage,
      body: text,
      parent_version_id: parent
    }, deps);

    created.push(version);

    if (stage === 'script') {
      /* 検証済みなので、ここで例外にはならない。 */
      scenes = IssoScenes_replace(store, version.version_id, scenes, deps);
    }
  }

  store.update(ISSO_SHEET.QUEUE, requestId, {
    status: ISSO_STATUS.QUEUE_INGESTED,
    error: ''
  });

  return { versions: created, scenes: scenes };
}

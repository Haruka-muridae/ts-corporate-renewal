/*
 * Scenes.gs — 台本のシーン（FR-043 / AC-09）
 *
 * ==================================================================
 * AC-09 の規則はここに置く
 * ==================================================================
 * 「note記事からYouTube台本を生成でき、台本が複数のシーンに分割され、
 *   **各シーンがナレーションと映像指示を持つ**」
 *
 * 検証は当初 Generation.gs に置いていたが、**シーンの規則はシーンの
 * 側にあるべき**なので移した。取り込み（Generation.gs）も手直し
 * （Api.gs）も、ここの `IssoScenes_validate` を呼ぶ。
 * 規則が2か所にあると、片方だけ直したときに静かにずれる。
 *
 * ==================================================================
 * body と scenes の関係
 * ==================================================================
 * `versions.body` が原本（生成された台本そのもの）。
 * `scenes` は**そこから読み取った構造**であって、別の原本ではない。
 *
 * したがって body を手直ししたら scenes も読み直す
 * （`IssoScenes_syncFromBody`）。読み直せない手直しは**受け付けない。**
 * 受け付けてしまうと、画面に出ているシーン一覧が本文と食い違い、
 * どちらが本当か分からなくなる。
 * ==================================================================
 */

/** AC-09 が「複数」と言う以上、1件では満たさない。 */
var ISSO_MIN_SCENES = 2;

/**
 * シーンの構造を検証する。**純粋関数。**
 *
 * プロンプトで指示していても、モデルが守るとは限らない。
 * **満たさないものを保存しない**ことで受入条件を担保する。
 */
function IssoScenes_validate(scenes) {
  if (!scenes || !scenes.length) {
    return { ok: false, reason: 'シーンを読み取れませんでした。' };
  }

  if (scenes.length < ISSO_MIN_SCENES) {
    return {
      ok: false,
      reason: 'シーンが' + scenes.length + '件しかありません（'
        + ISSO_MIN_SCENES + '件以上必要です）。'
    };
  }

  for (var i = 0; i < scenes.length; i++) {
    /* 全角空白だけの行も「無い」とみなす。 */
    var narration = String(scenes[i].narration || '').replace(/[\s　]/g, '');
    var visual = String(scenes[i].visual_prompt || '').replace(/[\s　]/g, '');

    if (narration === '') {
      return { ok: false, reason: (i + 1) + '番目のシーンにナレーションがありません。' };
    }

    if (visual === '') {
      return { ok: false, reason: (i + 1) + '番目のシーンに映像指示がありません。' };
    }
  }

  return { ok: true, reason: '' };
}

/**
 * 台本の版のシーンを入れ替える。**検証を通ったものだけ。**
 *
 * 再生成や手直しのたびに古いシーンが残らないよう、まるごと差し替える。
 */
function IssoScenes_replace(store, versionId, scenes, deps) {
  deps = deps || {};

  var verdict = IssoScenes_validate(scenes);

  if (verdict.ok !== true) {
    throw new Error(verdict.reason);
  }

  var rows = [];

  for (var i = 0; i < scenes.length; i++) {
    rows.push({
      scene_id: IssoConfig_newId(ISSO_SHEET.SCENES, deps.uuid),
      version_id: versionId,
      /* 並びはここで振り直す。モデルの申告する番号を信用しない。 */
      order: i,
      narration: String(scenes[i].narration),
      visual_prompt: String(scenes[i].visual_prompt),
      subtitle: scenes[i].subtitle === undefined || scenes[i].subtitle === null
        ? ''
        : String(scenes[i].subtitle)
    });
  }

  store.replaceBy(ISSO_SHEET.SCENES, 'version_id', versionId, rows);

  return rows;
}

/** 台本の版のシーンを order 順で返す。 */
function IssoScenes_list(store, versionId) {
  var rows = store.findBy(ISSO_SHEET.SCENES, 'version_id', versionId);

  rows.sort(function (a, b) { return a.order - b.order; });

  return rows;
}

/** 台本の版のシーンを消す。 */
function IssoScenes_remove(store, versionId) {
  store.replaceBy(ISSO_SHEET.SCENES, 'version_id', versionId, []);
}

/**
 * 手直しされた本文からシーンを読み直す。**保存はしない。**
 *
 * 保存を分けてあるのは、呼び出し側が
 * 「**読めることを確かめてから**本文を保存し、そのあとシーンを差し替える」
 * 順で書けるようにするため。先にシーンを差し替えると、本文の保存に失敗した
 * ときにシーンだけ新しくなる。
 *
 * 失敗の理由は**直し方まで含めて**返す。個人の道具なので、
 * 何が悪いかより「どう書けば通るか」のほうが要る。
 */
function IssoScenes_fromBody(body) {
  var scenes = IssoGeneration_parseScenes(body);
  var verdict = IssoScenes_validate(scenes);

  if (verdict.ok !== true) {
    return {
      ok: false,
      scenes: scenes,
      reason: 'この手直しではシーンを読み取れません（' + verdict.reason + '）。'
        + '「' + ISSO_PROMPT_DELIMITER.SCENE + '1」「'
        + ISSO_PROMPT_DELIMITER.NARRATION + '」「'
        + ISSO_PROMPT_DELIMITER.VISUAL + '」の形を保ってください。'
    };
  }

  return { ok: true, scenes: scenes, reason: '' };
}

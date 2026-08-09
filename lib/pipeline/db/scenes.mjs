/*
 * scenes の読み書きと検証（Scene 相当・FR-043 / AC-09）。
 *
 * ==================================================================
 * AC-09 の実装がここにある
 * ==================================================================
 * 「note記事からYouTube台本を生成でき、台本が複数のシーンに分割され、
 *   各シーンがナレーションと映像指示を持つ」
 *
 * 構造化出力（responseSchema）は形を保証するが、**空配列や空文字までは
 * 防げない。** 「scenes は ARRAY」と宣言しても、モデルが 0 件や
 * 空文字を返すことは起こりうる。そこで保存の前にここで検証する。
 *
 * v0.6 で LLM が Gemini（利用者BYOキー）になっても、**この検証は変わらない。**
 * 検証はプロバイダの話ではなく受入条件の話であるため。
 * ==================================================================
 */

import { STORE, makeId } from './schema.mjs';

/** AC-09 が「複数」と言う以上、1件では満たさない。 */
export const MIN_SCENES = 2;

/**
 * 生成結果のシーン配列を検証する。**純粋関数。**
 *
 * @param {unknown} scenes
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateScenes(scenes) {
  if (!Array.isArray(scenes)) {
    return { ok: false, reason: 'シーンの配列が返りませんでした。' };
  }

  if (scenes.length < MIN_SCENES) {
    return {
      ok: false,
      reason: `シーンが${scenes.length}件しかありません（${MIN_SCENES}件以上必要です）。`,
    };
  }

  for (const [index, scene] of scenes.entries()) {
    if (scene === null || typeof scene !== 'object') {
      return { ok: false, reason: `${index + 1}番目のシーンの形式が不正です。` };
    }

    /*
     * 空白だけの文字列も「無い」とみなす。
     * 全角空白を含めて落とすため、trim だけでなく置換もかける。
     */
    const narration = String(scene.narration ?? '').replace(/[\s　]/g, '');
    const visual = String(scene.visualPrompt ?? '').replace(/[\s　]/g, '');

    if (narration === '') {
      return { ok: false, reason: `${index + 1}番目のシーンにナレーションがありません。` };
    }

    if (visual === '') {
      return { ok: false, reason: `${index + 1}番目のシーンに映像指示がありません。` };
    }
  }

  return { ok: true };
}

/**
 * 台本の版にシーンを保存する。**検証を通ったものだけ**。
 *
 * 既存のシーンは入れ替える（再生成のたびに古いものが残らないように）。
 *
 * @param {import('./port.d.mts').Store} store
 */
export async function replaceScenes(store, versionId, scenes, deps = {}) {
  const check = validateScenes(scenes);

  if (!check.ok) {
    /*
     * ここで例外にするのは、**壊れた台本を保存させないため。**
     * 呼び出し側は再生成へ回す（設計 §3-4）。
     */
    throw new Error(check.reason);
  }

  const existing = await store.getAllBy(STORE.SCENES, 'byVersion', versionId);
  await store.removeAll(STORE.SCENES, existing.map((scene) => scene.id));

  const rows = scenes.map((scene, order) => ({
    id: makeId(STORE.SCENES, deps.cryptoImpl),
    versionId,
    order,
    narration: String(scene.narration),
    visualPrompt: String(scene.visualPrompt),
    subtitle: scene.subtitle === undefined || scene.subtitle === null
      ? null
      : String(scene.subtitle),
  }));

  return store.putAll(STORE.SCENES, rows);
}

/** 台本の版のシーンを order 順で取る。 */
export async function listScenes(store, versionId) {
  const rows = await store.getAllBy(STORE.SCENES, 'byVersion', versionId);

  return rows.sort((a, b) => a.order - b.order);
}

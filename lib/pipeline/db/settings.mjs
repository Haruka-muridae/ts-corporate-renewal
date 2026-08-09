/*
 * settings / meta の読み書き。
 *
 * settings … 段階ごとの生成オプション（FR-012 / FR-032 / FR-042）
 * meta     … スキーマ版・初回説明画面の既読（設計 §2-5）
 *
 * どちらも key/value の単純なストア。分けてあるのは、
 * エクスポート（export.mjs）で settings は持ち出し、
 * meta は持ち出さないため（他端末へ「既読」を持ち込みたくない）。
 */

import { STORE } from './schema.mjs';

/**
 * 段階ごとの既定値。**要件の数値をそのまま持つ。**
 *
 * ここを画面のプレースホルダにもする。値が2か所にあると必ずずれる。
 */
export const DEFAULT_SETTINGS = Object.freeze({
  'threads.lengthHint': '50〜150字',
  'threads.candidates': 3,
  'x.lengthHint': '150〜300字',
  'note.lengthHint': '1,500〜3,000字',
  'script.durationHint': '5〜10分',
  'tone': '',
});

/** @param {import('./port.d.mts').Store} store */
export async function getSetting(store, key) {
  const row = await store.get(STORE.SETTINGS, key);

  return row === null ? (DEFAULT_SETTINGS[key] ?? null) : row.value;
}

export async function setSetting(store, key, value) {
  return store.put(STORE.SETTINGS, { key, value });
}

/** 既定値に保存済みを重ねて返す。画面はこれ1つを読めばよい。 */
export async function getAllSettings(store) {
  const rows = await store.getAll(STORE.SETTINGS);
  const saved = Object.fromEntries(rows.map((row) => [row.key, row.value]));

  return { ...DEFAULT_SETTINGS, ...saved };
}

/* ------------------------------------------------------------------
 * meta
 * ------------------------------------------------------------------ */

export async function getMeta(store, key) {
  const row = await store.get(STORE.META, key);
  return row === null ? null : row.value;
}

export async function setMeta(store, key, value) {
  return store.put(STORE.META, { key, value });
}

/**
 * 初回説明画面（`/pipeline/welcome/`）を見たか。
 *
 * **見ていない利用者を必ず通す**（実装指示書 §2-2 が Must としている）。
 * データがブラウザにしか無いことを知らないまま使わせない。
 */
export async function hasSeenWelcome(store) {
  return (await getMeta(store, 'welcomeSeen')) === true;
}

export async function markWelcomeSeen(store) {
  return setMeta(store, 'welcomeSeen', true);
}

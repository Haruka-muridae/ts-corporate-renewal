/*
 * 貼り付けた台本を、AI 生成と同じ形（{ title, scenes: [{ seconds, text }] }）へ直す。
 *
 * ==================================================================
 * 方針
 * ==================================================================
 * Gemini を介さない。DOM も触らない純関数だけを置く（テストしやすくするため。
 * prompt.js / gemini.js と同じく、DOM 依存は app.js 側に閉じる）。
 *
 * 区切りは利用者の選択により「区切らない＝全文を1シーン」とする。
 * シーン内の長文は、後段（字幕）で自動的に折り返す前提。
 * ==================================================================
 */

/* 既定のタイトル。本文はあるがタイトル未入力のときに使う。 */
export const DEFAULT_PASTED_TITLE = 'ペーストした台本';

/*
 * 本文の長さから尺の目安（秒）をざっくり出す。
 * 日本語のナレーションはおよそ 6〜7 文字/秒。空白を除いた文字数 × 0.15 とする。
 * これは目安であり、最終尺は後段で実音声に同期させる。下限は2秒。
 */
export function estimateSeconds(text) {
  const len = String(text ?? '').replace(/\s+/g, '').length;
  return Math.max(2, Math.round(len * 0.15));
}

/*
 * 貼り付けた本文を台本オブジェクトへ。**全文を1シーンとして扱う。**
 * 空（空白のみを含む）なら null を返し、呼び出し側が案内を出す。
 *
 * 戻り値: { title, scenes: [{ seconds, text }], source: 'pasted' } | null
 */
export function buildPastedScript(rawTitle, rawBody) {
  /* 改行コードを揃え、前後の空白を落とす。中身は原文のまま保つ。 */
  const text = String(rawBody ?? '').replace(/\r\n?/g, '\n').trim();

  if (text === '') {
    return null;
  }

  const title = String(rawTitle ?? '').trim() || DEFAULT_PASTED_TITLE;

  return {
    title,
    scenes: [{ seconds: estimateSeconds(text), text }],
    source: 'pasted',
  };
}

/*
 * タイムライン計算の純関数。
 * 実測音声長(シーンごとのWAV再生時間)から、各シーンの開始秒と
 * Ken Burns(ズームのみ。docs/specs/short-script-mobile-video-plan-v1.md §5)の
 * パラメータを求める。
 *
 * 秒数を先に決め打ちしない方針は v1.5 §7.7 と同じ(§2.1のコメント参照)。
 */

/**
 * シーンごとの実測音声長(秒)から、各シーンの開始秒を積み上げる。
 * @param {Array<{durationSec:number}>} scenes
 * @returns {Array<{startSec:number, durationSec:number}>}
 */
export function computeSceneTimeline(scenes) {
  let cursor = 0;
  return scenes.map((scene) => {
    const entry = { startSec: cursor, durationSec: scene.durationSec };
    cursor += scene.durationSec;
    return entry;
  });
}

/** 全シーンの合計秒数。 */
export function totalDurationSec(scenes) {
  return scenes.reduce((sum, s) => sum + s.durationSec, 0);
}

/**
 * 進行度(0〜1)から Ken Burns のズーム倍率を求める(線形補間、ズームのみ)。
 * @param {number} progress - 0(シーン開始)〜1(シーン終了)
 * @param {{startScale?:number, endScale?:number}} [opts]
 */
export function kenBurnsScaleAt(progress, { startScale = 1.0, endScale = 1.12 } = {}) {
  const p = Math.min(1, Math.max(0, progress));
  return startScale + (endScale - startScale) * p;
}

/** 秒数とfpsからフレーム数を求める(四捨五入)。 */
export function frameCountForDuration(durationSec, fps = 30) {
  return Math.round(durationSec * fps);
}

/**
 * シーン内のフレームインデックスから、Ken Burnsのズーム倍率を求める。
 * @param {number} frameIndex - シーン内での0始まりフレーム番号
 * @param {number} totalFrames - シーンの総フレーム数
 * @param {{startScale?:number, endScale?:number}} [opts]
 */
export function kenBurnsScaleForFrame(frameIndex, totalFrames, opts) {
  if (totalFrames <= 1) return kenBurnsScaleAt(1, opts);
  return kenBurnsScaleAt(frameIndex / (totalFrames - 1), opts);
}

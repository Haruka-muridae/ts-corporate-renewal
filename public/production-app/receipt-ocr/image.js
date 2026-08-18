/*
 * アップロード前の画像縮小（仕様書 §14 の最終項）。
 *
 * ==================================================================
 * 複製元
 * ==================================================================
 * public/production-app/card-ocr/capture.js の縮小部分
 * （loadImage / fitSize / shrinkToJpeg / isHeic）を複製（複製日 2026-08-18）。
 * **import はしない**（docs/repository-structure.md §4-1）。
 *
 * 複製元から変えたところ:
 *   - 長辺の上限を config.js の IMAGE_MAX_EDGE_PX から取る
 *     （§14 が「長辺2,000px程度」と定めており、値の置き場は config.js）
 *   - 撮影・回転・ファイル名の組み立ては持ち込まない（この画面に無い機能）
 *   - **収まらなかったときに例外で止めない。** 呼び出し側が原本へ
 *     戻せるよう、理由付きで失敗を返す
 * ==================================================================
 *
 * ==================================================================
 * 原本を勝手に置き換えないこと
 * ==================================================================
 * §14 は縮小を「オプションを設ける」と書いており、常時実行とはしていない。
 * 領収書の原本画像は利用者が後から見返す証跡であり、既定で画質を
 * 落とすべきものではない。**既定は無効**とし、利用者が選んだときだけ縮める。
 *
 * 重複判定の SHA-256 は**選ばれた元のファイル**から取る。縮小後の
 * バイト列はブラウザ・実装で変わりうるため、同じ写真を2回上げたときに
 * 同じ値にならず、重複判定が働かなくなる（§10）。
 * ==================================================================
 *
 * ==================================================================
 * 解像度を下げすぎないこと
 * ==================================================================
 * OCR の精度は解像度に強く効く。レシートは名刺より文字が小さく、
 * 小計や税率の桁を落とすと検算まで狂う。長辺1,600px・品質0.75 を
 * 下限とし、**そこまで縮めても収まらなければ縮小自体を諦める**
 * （原本をそのまま上げるほうが、読めない画像を作るよりよい）。
 * ==================================================================
 */

import { IMAGE_MAX_EDGE_PX } from './config.js';

/* 目標のバイト数。これを下回れば十分とする。 */
export const TARGET_MAX_BYTES = 1.5 * 1024 * 1024;

export const MAX_EDGE = IMAGE_MAX_EDGE_PX;
export const MIN_EDGE = 1600;
export const MAX_QUALITY = 0.85;
export const MIN_QUALITY = 0.75;

/*
 * 段階的な圧縮の手順。
 * **品質を先に落とし、寸法は後で落とす。** 文字の輪郭は寸法のほうに
 * 強く効くので、削れる順に削る。
 */
export const COMPRESSION_STEPS = Object.freeze([
  Object.freeze({ maxEdge: MAX_EDGE, quality: MAX_QUALITY }),
  Object.freeze({ maxEdge: MAX_EDGE, quality: 0.80 }),
  Object.freeze({ maxEdge: MIN_EDGE, quality: MAX_QUALITY }),
  Object.freeze({ maxEdge: MIN_EDGE, quality: 0.80 }),
  Object.freeze({ maxEdge: MIN_EDGE, quality: MIN_QUALITY }),
]);

export const ShrinkFailure = Object.freeze({
  UNAVAILABLE: 'unavailable',
  DECODE_FAILED: 'decode-failed',
  ENCODE_FAILED: 'encode-failed',
  NOT_SMALLER: 'not-smaller',
});

/*
 * HEIC / HEIF かどうか。
 *
 * **拡張子でも見る。** iOS Safari は HEIC の type を空文字で渡すことが
 * あり、type だけでは見分けられない。
 *
 * ブラウザでは復号できないため、案内を「JPEG または PNG を選んでください」で
 * 終わらせない。iPhone の既定形式であり、利用者に特別なことをした自覚が無い。
 */
export function isHeic(file) {
  const type = String(file?.type ?? '').toLowerCase();
  const name = String(file?.name ?? '').toLowerCase();

  return /heic|heif/.test(type) || /\.(heic|heif)$/.test(name);
}

/* 長辺を maxEdge に収める寸法。**元より大きくは引き伸ばさない。** */
export function fitSize(width, height, maxEdge) {
  const longEdge = Math.max(width, height);

  if (longEdge <= maxEdge || longEdge === 0) {
    return { width, height };
  }

  const scale = maxEdge / longEdge;

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/* 縮める意味があるか（純粋）。小さい画像を再エンコードしても得が無い。 */
export function shouldShrink(file, { maxEdgeBytes = TARGET_MAX_BYTES } = {}) {
  return Number(file?.size ?? 0) > maxEdgeBytes;
}

/* ---------- ここから DOM を使う ---------- */

function canUseCanvas() {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}

async function loadImage(file) {
  if (typeof globalThis.createImageBitmap === 'function') {
    try {
      /* EXIF の向きを反映させる。横倒しのまま縮めないため。 */
      return await globalThis.createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* オプション非対応などで失敗した場合は <img> へ落とす。 */
    }
  }

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();

    image.addEventListener('load', () => {
      URL.revokeObjectURL(url);
      resolve(image);
    });

    image.addEventListener('error', () => {
      URL.revokeObjectURL(url);
      reject(new Error(ShrinkFailure.DECODE_FAILED));
    });

    image.src = url;
  });
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob !== 'function') {
      reject(new Error(ShrinkFailure.ENCODE_FAILED));
      return;
    }

    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error(ShrinkFailure.ENCODE_FAILED))),
      'image/jpeg',
      quality,
    );
  });
}

async function renderOnce(source, sourceWidth, sourceHeight, { maxEdge, quality }) {
  const fitted = fitSize(sourceWidth, sourceHeight, maxEdge);

  const canvas = document.createElement('canvas');
  canvas.width = fitted.width;
  canvas.height = fitted.height;

  const context = canvas.getContext('2d');

  if (!context) {
    throw new Error(ShrinkFailure.ENCODE_FAILED);
  }

  /* 縮小時のなめらかさを上げる。文字の輪郭が保たれやすい。 */
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, fitted.width, fitted.height);

  const blob = await canvasToBlob(canvas, quality);

  return { blob, width: fitted.width, height: fitted.height };
}

function closeSource(source) {
  if (source && typeof source.close === 'function') {
    source.close();
  }
}

/*
 * JPEG へ縮める。
 *
 * 戻り値（例外は投げない）:
 *   { ok: true, blob, width, height, bytes, step }
 *   { ok: false, reason }   … 縮められなかった。呼び出し側は原本を使う
 *
 * **失敗を例外にしない。** 縮小は §14 の「オプション」であって、
 * 保存の必須工程ではない。ここで例外を投げると、縮められない画像で
 * 保存そのものができなくなる。
 */
export async function shrinkToJpeg(file, { maxBytes = TARGET_MAX_BYTES } = {}) {
  if (!canUseCanvas()) {
    return { ok: false, reason: ShrinkFailure.UNAVAILABLE };
  }

  let source = null;

  try {
    source = await loadImage(file);
  } catch {
    return { ok: false, reason: ShrinkFailure.DECODE_FAILED };
  }

  const sourceWidth = source?.width ?? source?.naturalWidth ?? 0;
  const sourceHeight = source?.height ?? source?.naturalHeight ?? 0;

  if (!sourceWidth || !sourceHeight) {
    closeSource(source);
    return { ok: false, reason: ShrinkFailure.DECODE_FAILED };
  }

  try {
    let best = null;

    for (let index = 0; index < COMPRESSION_STEPS.length; index += 1) {
      const step = COMPRESSION_STEPS[index];

      let rendered;

      try {
        rendered = await renderOnce(source, sourceWidth, sourceHeight, step);
      } catch {
        return { ok: false, reason: ShrinkFailure.ENCODE_FAILED };
      }

      best = { ...rendered, step: index };

      if (rendered.blob.size <= maxBytes) {
        break;
      }
    }

    /*
     * 元より大きくなったら使わない。JPEG へ再エンコードすると、
     * 元が高圧縮の場合に膨らむことがある。
     */
    if (!best || best.blob.size >= Number(file?.size ?? 0)) {
      return { ok: false, reason: ShrinkFailure.NOT_SMALLER };
    }

    return {
      ok: true,
      blob: best.blob,
      width: best.width,
      height: best.height,
      bytes: best.blob.size,
      step: best.step,
    };
  } finally {
    /* ImageBitmap は GC を待たずに解放する。 */
    closeSource(source);
  }
}

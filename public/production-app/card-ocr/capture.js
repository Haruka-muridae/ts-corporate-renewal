/*
 * 名刺画像の取得と前処理（要件定義書 §FR-03・FR-04・FR-05、§8.2）。
 *
 * ==================================================================
 * 複製元
 * ==================================================================
 * public/apps/card-scanner/capture.js（2026-08-04）。
 * **import はしない**（docs/repository-structure.md §2-1・§4-1）。
 *
 * 複製元から変えたところ:
 *   - 長辺の既定を 1600 → **2000** にした（§20 の確定値）
 *   - **1.5MB に収まるまでの段階的な圧縮**を足した（§8.2）
 *   - HEIC を見分けて案内を分けた（§FR-03）
 *   - 手動回転を足した（§FR-04）
 *   - エラーを §15 の IMG-001 / IMG-002 / IMG-003 へ対応させた
 * ==================================================================
 *
 * ==================================================================
 * 解像度を下げすぎないこと
 * ==================================================================
 * OCR の精度は解像度に強く効く。小さくすると細かい文字（部署名や
 * メールアドレス）が落ちて読み取れなくなる。
 *
 * §8.2 は「推奨長辺1,600〜2,000ピクセル、JPEG品質0.80〜0.85
 * （0.75未満へは下げない）」と定めている。**この下限を割ってまで
 * 容量に収めない。** 割るくらいなら撮り直してもらう（IMG-002）。
 * ==================================================================
 *
 * DOM に触るのは shrinkToJpeg だけ。寸法の計算・圧縮の段取り・
 * 種別の判定・ファイル名の組み立ては純粋関数にしてあり、
 * ブラウザ無しで確かめられる。
 */

import { sanitizeFileNamePart } from './sanitize.js';

/* ---------- 仕様の数値（§8.2・§20） ---------- */

/* 圧縮後の上限。これを超えたら登録させない。 */
export const MAX_BYTES = 1.5 * 1024 * 1024;

/* 長辺。**1600 を下回らない。** */
export const MAX_EDGE = 2000;
export const MIN_EDGE = 1600;

/* JPEG 品質。**0.75 を下回らない。** */
export const MAX_QUALITY = 0.85;
export const MIN_QUALITY = 0.75;

/*
 * 段階的な圧縮の手順（§FR-05「超過時の段階的圧縮と撮り直し案内」）。
 *
 * **品質を先に落とし、寸法は後で落とす。** 文字の輪郭は寸法のほうに
 * 強く効くので、削れる順に削る。
 *
 * この配列を使い切っても 1.5MB に収まらなければ IMG-002 とする。
 * 「もっと縮めれば入る」は §8.2 の下限を割るので選ばない。
 */
export const COMPRESSION_STEPS = Object.freeze([
  Object.freeze({ maxEdge: MAX_EDGE, quality: 0.85 }),
  Object.freeze({ maxEdge: MAX_EDGE, quality: 0.80 }),
  Object.freeze({ maxEdge: MIN_EDGE, quality: 0.85 }),
  Object.freeze({ maxEdge: MIN_EDGE, quality: 0.80 }),
  Object.freeze({ maxEdge: MIN_EDGE, quality: MIN_QUALITY }),
]);

/* 受け入れる形式（§FR-03 の accept と揃える）。 */
export const ACCEPTED_TYPES = Object.freeze(['image/jpeg', 'image/png']);
export const ACCEPT_ATTRIBUTE = ACCEPTED_TYPES.join(',');

/* ---------- エラー ---------- */

export const CaptureErrorCode = {
  NO_FILE: 'NO_FILE',
  /* HEIC。iPhone の既定形式なので、ほかの「非対応」と分けて案内する。 */
  HEIC: 'HEIC',
  NOT_SUPPORTED: 'NOT_SUPPORTED',
  DECODE_FAILED: 'DECODE_FAILED',
  ENCODE_FAILED: 'ENCODE_FAILED',
  /* 下限まで圧縮しても 1.5MB に収まらなかった。 */
  TOO_LARGE: 'TOO_LARGE',
};

export class CaptureError extends Error {
  constructor(code, detail = '') {
    super(`capture:${code}`);
    this.name = 'CaptureError';
    this.code = code;
    this.detail = detail;
  }
}

/* 画面に出す言葉。エラーコードは §15 に対応する。 */
export function describeCaptureError(error) {
  const isKnown = error instanceof CaptureError;
  const code = isKnown ? error.code : CaptureErrorCode.ENCODE_FAILED;
  const detail = isKnown
    ? String(error.detail ?? '')
    : `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`;

  const described = (text, errorCode) => ({ text, errorCode, detail });

  switch (code) {
    case CaptureErrorCode.NO_FILE:
      return described('画像が選ばれていません。', 'IMG-001');
    case CaptureErrorCode.HEIC:
      /*
       * **HEIC は「非対応です」で終わらせない。** iPhone の既定形式で、
       * 利用者は自分が特殊なことをした自覚がない。
       * その場で解決できる道（カメラで撮る／設定を変える）まで書く。
       */
      return described(
        'HEIC形式の写真は読み取れません。この画面のカメラで撮り直すか、iPhoneの「設定 › カメラ › フォーマット」を「互換性優先」にしてから撮影してください。',
        'IMG-001',
      );
    case CaptureErrorCode.NOT_SUPPORTED:
      return described('JPEG または PNG の画像を選んでください。', 'IMG-001');
    case CaptureErrorCode.TOO_LARGE:
      return described(
        '画像を小さくできませんでした。名刺全体が入るように、少し離れて撮り直してください。',
        'IMG-002',
      );
    case CaptureErrorCode.DECODE_FAILED:
      return described('画像を読み込めませんでした。別の画像でお試しください。', 'IMG-003');
    default:
      return described('画像を変換できませんでした。', 'IMG-003');
  }
}

/* ---------- 種別の判定（純粋） ---------- */

/*
 * HEIC / HEIF かどうか。
 *
 * **拡張子でも見る。** iOS Safari は HEIC の type を空文字で渡すことが
 * あり、type だけでは見分けられない。
 */
export function isHeic(file) {
  const type = String(file?.type ?? '').toLowerCase();
  const name = String(file?.name ?? '').toLowerCase();

  return /heic|heif/.test(type) || /\.(heic|heif)$/.test(name);
}

/*
 * 受け入れてよい画像か。
 *
 * 戻り値は CaptureErrorCode または null（問題なし）。
 * 例外にしないのは、呼び出し側が「案内を出して選び直させる」だけで
 * 済ませたい場面が多いため。
 */
export function checkFile(file) {
  if (!file) {
    return CaptureErrorCode.NO_FILE;
  }

  if (isHeic(file)) {
    return CaptureErrorCode.HEIC;
  }

  const type = String(file.type ?? '').toLowerCase();

  /*
   * type が空のときは通す。iOS Safari が空で渡すことがあり、
   * ここで弾くと撮影した画像そのものが使えなくなる。
   * 実際に読めるかどうかは、このあとのデコードで分かる。
   */
  if (type === '') {
    return null;
  }

  return ACCEPTED_TYPES.includes(type) ? null : CaptureErrorCode.NOT_SUPPORTED;
}

/* ---------- 寸法（純粋） ---------- */

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

/* 回転は 90 度単位。90 / 270 で縦横が入れ替わる。 */
export function normalizeRotation(degrees) {
  const value = Number(degrees);

  if (!Number.isFinite(value)) {
    return 0;
  }

  return ((Math.round(value / 90) * 90) % 360 + 360) % 360;
}

export function rotatedSize(width, height, rotation) {
  return normalizeRotation(rotation) % 180 === 90
    ? { width: height, height: width }
    : { width, height };
}

/* ---------- ファイル名（純粋。§FR-07） ---------- */

function pad(value, length = 2) {
  return String(value).padStart(length, '0');
}

/*
 * `YYYYMMDD_HHMMSS_会社名_氏名_front.jpg`
 * 会社名・氏名が取れないときは `..._UNCLASSIFIED_<一時ID>_front.jpg`。
 *
 * **面の接尾辞は表面にも必ず付ける**（§FR-07、v3.1）。裏面が無い件でも
 * 付けることで、ファイル名の形が1つに定まり、あとから裏面を足す余地も残る。
 */
export function buildImageFileName({
  at = null,
  companyName = '',
  fullName = '',
  fallbackId = '',
  side = 'front',
} = {}) {
  const date = at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date();

  const stamp = [
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
  ].join('_');

  const company = sanitizeFileNamePart(companyName);
  const name = sanitizeFileNamePart(fullName);
  const suffix = side === 'back' ? 'back' : 'front';

  if (company === '' && name === '') {
    return `${stamp}_UNCLASSIFIED_${sanitizeFileNamePart(fallbackId) || 'unknown'}_${suffix}.jpg`;
  }

  return `${stamp}_${company}_${name}_${suffix}.jpg`.replace(/__+/g, '_');
}

/* 保存先の年月フォルダ（§FR-07 の images/YYYY/MM）。 */
export function yearMonthPath(at = new Date()) {
  const date = at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date();

  return { year: String(date.getFullYear()), month: pad(date.getMonth() + 1) };
}

/* ---------- 画像の読み込みと縮小（DOM を使う） ---------- */

/*
 * 画像を読み込む。
 *
 * createImageBitmap に imageOrientation: 'from-image' を付けると、
 * スマートフォンで撮った画像の EXIF 回転が反映され、横倒しのまま
 * 縮小されるのを防げる（§FR-05「方向補正、EXIF二重補正の実機確認」）。
 *
 * ImageBitmap を受け取った場合、呼び出し側が close() すること。
 */
export async function loadImage(file) {
  const problem = checkFile(file);

  if (problem) {
    throw new CaptureError(problem, String(file?.type ?? ''));
  }

  if (typeof globalThis.createImageBitmap === 'function') {
    try {
      return await globalThis.createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* オプション非対応などで失敗した場合は <img> へ落とす。 */
    }
  }

  return loadViaImageElement(file);
}

function loadViaImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };

    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new CaptureError(CaptureErrorCode.DECODE_FAILED, 'image_onerror'));
    };

    image.src = url;
  });
}

function closeSource(source) {
  if (source && typeof source.close === 'function') {
    source.close();
  }
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob !== 'function') {
      reject(new CaptureError(CaptureErrorCode.ENCODE_FAILED, 'toBlob_unavailable'));
      return;
    }

    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new CaptureError(CaptureErrorCode.ENCODE_FAILED, 'blob_null'));
        }
      },
      'image/jpeg',
      quality,
    );
  });
}

/* 1回ぶんの描画とエンコード。 */
async function renderOnce(source, sourceWidth, sourceHeight, { maxEdge, quality, rotation }) {
  const fitted = fitSize(sourceWidth, sourceHeight, maxEdge);
  const output = rotatedSize(fitted.width, fitted.height, rotation);

  const canvas = document.createElement('canvas');
  canvas.width = output.width;
  canvas.height = output.height;

  const context = canvas.getContext('2d');

  if (!context) {
    throw new CaptureError(CaptureErrorCode.ENCODE_FAILED, 'context_unavailable');
  }

  /* 縮小時のなめらかさを上げる。文字の輪郭が保たれやすい。 */
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';

  const angle = normalizeRotation(rotation);

  if (angle !== 0) {
    context.translate(output.width / 2, output.height / 2);
    context.rotate((angle * Math.PI) / 180);
    context.translate(-fitted.width / 2, -fitted.height / 2);
  }

  context.drawImage(source, 0, 0, fitted.width, fitted.height);

  const blob = await canvasToBlob(canvas, quality);

  return { blob, canvas, width: output.width, height: output.height };
}

/*
 * 画像を 1.5MB 以内の JPEG にする。
 *
 * 戻り値: { blob, dataUrl, width, height, bytes, step }
 *   step … COMPRESSION_STEPS の何段目で収まったか（0 起点）
 *
 * **収まらなければ IMG-002 として投げる。** §8.2 の下限（長辺1600・
 * 品質0.75）を割ってまで通さない。読めない画像を保存しても意味がない。
 */
export async function shrinkToJpeg(file, { rotation = 0, maxBytes = MAX_BYTES } = {}) {
  const source = await loadImage(file);

  const sourceWidth = source.width ?? source.naturalWidth ?? 0;
  const sourceHeight = source.height ?? source.naturalHeight ?? 0;

  if (!sourceWidth || !sourceHeight) {
    closeSource(source);
    throw new CaptureError(CaptureErrorCode.DECODE_FAILED, 'zero_size');
  }

  try {
    let last = null;

    for (let index = 0; index < COMPRESSION_STEPS.length; index += 1) {
      const step = COMPRESSION_STEPS[index];

      const rendered = await renderOnce(source, sourceWidth, sourceHeight, {
        maxEdge: step.maxEdge,
        quality: step.quality,
        rotation,
      });

      last = rendered;

      if (rendered.blob.size <= maxBytes) {
        return {
          blob: rendered.blob,
          dataUrl: rendered.canvas.toDataURL('image/jpeg', step.quality),
          width: rendered.width,
          height: rendered.height,
          bytes: rendered.blob.size,
          step: index,
        };
      }
    }

    throw new CaptureError(CaptureErrorCode.TOO_LARGE, String(last?.blob?.size ?? 0));
  } finally {
    /* ImageBitmap は GC を待たずに解放する。 */
    closeSource(source);
  }
}

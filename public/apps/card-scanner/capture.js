/*
 * 撮影した画像の読み込みと縮小。
 *
 * 担当するのは画像の変換だけ。
 * DOM要素の生成・状態遷移・API呼び出しはここに置かない。
 * 入力は File / Blob、出力は縮小したJPEGとプレビュー用のデータURL。
 *
 * ------------------------------------------------------------------
 * 解像度についての判断
 * ------------------------------------------------------------------
 * OCRの精度は解像度に強く効く。小さくしすぎると細かい文字（部署名や
 * メールアドレス）が落ちて読み取れなくなる。
 * そのため長辺の既定値は 1600px とし、これを下回らないこと。
 * 音声より品質要求が高い、という前提で数値を決めている。
 * ------------------------------------------------------------------
 *
 * EXIFの回転は createImageBitmap の imageOrientation: 'from-image' に任せる。
 * これが使えない環境では <img> へ読み込む方式へ落とすが、その場合は
 * ブラウザ側の既定の向き解釈に従う。
 */

/* 長辺の既定値。これより小さくしないこと（OCRの精度が落ちる）。 */
export const DEFAULT_MAX_EDGE = 1600;

/* JPEGの品質。文字のにじみを抑えつつ、通信量を現実的な範囲に収める。 */
export const JPEG_QUALITY = 0.85;

export const CaptureErrorCode = {
  NO_FILE: 'NO_FILE',
  NOT_IMAGE: 'NOT_IMAGE',
  DECODE_FAILED: 'DECODE_FAILED',
  ENCODE_FAILED: 'ENCODE_FAILED',
};

export class CaptureError extends Error {
  constructor(code, detail = null) {
    super(code);
    this.name = 'CaptureError';
    this.code = code;
    this.detail = detail;
  }
}

/*
 * 画像を読み込む。
 *
 * createImageBitmap が使えればそれを優先する。
 * imageOrientation: 'from-image' を付けると、スマートフォンで撮影した
 * 画像のEXIF回転が反映され、横倒しのまま縮小されるのを防げる。
 *
 * 戻り値: ImageBitmap または HTMLImageElement
 * ImageBitmap を受け取った場合、呼び出し側が close() すること。
 */
export async function loadImage(file) {
  if (!file) {
    throw new CaptureError(CaptureErrorCode.NO_FILE);
  }

  if (typeof file.type === 'string' && file.type !== '' && !file.type.startsWith('image/')) {
    throw new CaptureError(CaptureErrorCode.NOT_IMAGE, file.type);
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
      /* onload 後は URL を保持する必要がない。 */
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

/* 長辺を maxEdge に収める寸法を求める。元より大きくは引き伸ばさない。 */
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

function canvasToBlob(canvas) {
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
      JPEG_QUALITY,
    );
  });
}

/*
 * 画像を縮小してJPEGにする。
 *
 * 戻り値: { blob, dataUrl, width, height }
 *   blob    … Driveへ送るJPEG
 *   dataUrl … 画面のプレビューに使う
 *
 * ImageBitmap は使い終わったらこの関数の中で close() する。
 */
export async function shrinkToJpeg(file, maxEdge = DEFAULT_MAX_EDGE) {
  const source = await loadImage(file);

  const sourceWidth = source.width ?? source.naturalWidth ?? 0;
  const sourceHeight = source.height ?? source.naturalHeight ?? 0;

  if (!sourceWidth || !sourceHeight) {
    closeSource(source);
    throw new CaptureError(CaptureErrorCode.DECODE_FAILED, 'zero_size');
  }

  const { width, height } = fitSize(sourceWidth, sourceHeight, maxEdge);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');

  if (!context) {
    closeSource(source);
    throw new CaptureError(CaptureErrorCode.ENCODE_FAILED, 'context_unavailable');
  }

  /* 縮小時のなめらかさを上げる。文字の輪郭が保たれやすい。 */
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';

  try {
    context.drawImage(source, 0, 0, width, height);
  } finally {
    /* ImageBitmap はGCを待たずに解放する。 */
    closeSource(source);
  }

  const blob = await canvasToBlob(canvas);
  const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);

  return { blob, dataUrl, width, height };
}

function closeSource(source) {
  if (source && typeof source.close === 'function') {
    source.close();
  }
}

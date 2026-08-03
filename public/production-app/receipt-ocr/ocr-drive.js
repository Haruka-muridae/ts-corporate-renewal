/*
 * 案A：Drive OCR（仕様書 §0.2 / §5-⑤ / §9.5）。
 *
 * ------------------------------------------------------------------
 * なぜ Drive で文字が読めるのか
 * ------------------------------------------------------------------
 * 画像を mimeType='application/vnd.google-apps.document' として上げると、
 * Drive 側が Google ドキュメントへ変換する。その過程で OCR が走り、
 * 本文に文字が入る。それを text/plain で書き出せば文字列が得られる。
 *
 * 追加コストがかからず、必要な権限は既存の drive.file だけで足りる。
 * 代償として、返るのはレイアウトを失った一続きのテキストである
 * （座標が無いことは §0.2 の表に明記されている）。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * 一時ドキュメントは必ず消す（§9.5）
 * ------------------------------------------------------------------
 * 変換のために作ったドキュメントは中間生成物であり、利用者のドライブに
 * 残す理由がない。取得が失敗しても削除は実行する（finally）。
 * 共有設定は行わない。
 * ------------------------------------------------------------------
 */

import { GOOGLE_API } from './config.js';
import { AppError, PROGRESS } from './errors.js';
import { callGoogle, callGoogleText } from './google-api.js';
import { deleteFile, GOOGLE_DOC_MIME } from './drive.js';

export const ENGINE_ID = 'drive';

/* このエンジンは Gemini APIキーを必要としない（§4 キー未設定時の挙動）。 */
export const requiresApiKey = false;

/*
 * 画像を一時ドキュメントへ変換して上げる。
 * 変換の指示は uploadType=multipart ＋ mimeType の指定で行う。
 */
async function uploadForOcr({ accessToken, blob, displayName, signal }) {
  const metadata = {
    name: `ocr-tmp-${displayName}`,
    mimeType: GOOGLE_DOC_MIME,
  };

  const boundary = `ocr-${blob.size}-${blob.type.length}`;
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${blob.type || 'image/jpeg'}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;

  const body = new Blob([head, blob, tail], { type: `multipart/related; boundary=${boundary}` });

  const url = new URL(GOOGLE_API.driveUpload);
  url.searchParams.set('uploadType', 'multipart');
  /* 日本語のレシートを読むため、認識言語を明示する。 */
  url.searchParams.set('ocrLanguage', 'ja');
  url.searchParams.set('fields', 'id');

  const created = await callGoogle(url.href, {
    accessToken,
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
    signal,
    progress: PROGRESS.ORIGINAL_SAVED,
  });

  if (!created?.id) {
    throw new AppError('OCR-001', { progress: PROGRESS.ORIGINAL_SAVED, detail: 'no_doc_id' });
  }

  return created.id;
}

/*
 * 読み取る。
 *
 * 戻り値は { engine, text }。失敗は OCR-001。
 * 原本の保存は先に済んでいる前提なので、progress は ORIGINAL_SAVED。
 */
export async function recognize({ blob, accessToken, displayName = 'receipt', signal } = {}) {
  if (!blob) {
    throw new AppError('OCR-001', { progress: PROGRESS.ORIGINAL_SAVED, detail: 'no_blob' });
  }

  const documentId = await uploadForOcr({ accessToken, blob, displayName, signal });

  try {
    const url = new URL(`${GOOGLE_API.driveFiles}/${encodeURIComponent(documentId)}/export`);
    url.searchParams.set('mimeType', 'text/plain');

    const text = await callGoogleText(url.href, {
      accessToken,
      signal,
      progress: PROGRESS.ORIGINAL_SAVED,
    });

    return { engine: ENGINE_ID, text: String(text ?? '') };
  } finally {
    /* 取得が失敗しても消す。 */
    await deleteFile(documentId, { accessToken, signal });
  }
}

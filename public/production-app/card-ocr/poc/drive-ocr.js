/*
 * ブラウザからの Drive OCR（要件定義書 §FR-08）。
 *
 *   1. files.create（multipart）で画像を Google ドキュメントへ変換
 *      → この変換の過程で OCR が走る
 *   2. files.export（text/plain）で本文テキストを取得
 *   3. 一時ドキュメントを完全削除
 *
 * ==================================================================
 * 複製元
 * ==================================================================
 * public/apps/card-scanner/drive-ocr.js の ocrImage 周辺を複製したもの。
 * **import はしない。**（docs/repository-structure.md §2-1、要件定義書 §3）
 *
 * 複製元との違い:
 *   - ロガーを持たない
 *   - **空テキストのときの再試行（最大3回）を足した**（要件定義書 §FR-08 の3）。
 *     card-scanner は1回で諦めて OCR_EMPTY を投げる
 *   - 孤児回収を独立した関数として切り出した
 * ==================================================================
 *
 * ==================================================================
 * 一時ドキュメントは必ず消す
 * ==================================================================
 * 中間生成物であり、利用者のドライブに残してよいものではない。
 * **エクスポートが失敗しても削除する**（try / finally）。
 * 削除に失敗した場合は全体を失敗にせず、次回起動時の孤児回収に任せる
 * （要件定義書 §FR-21、AC-07）。
 * ==================================================================
 */

import {
  DRIVE_FILES_ENDPOINT,
  DRIVE_UPLOAD_ENDPOINT,
  DriveError,
  DriveErrorCode,
  GOOGLE_DOC_MIME,
  buildMultipartBody,
  createBoundary,
  deleteFile,
  driveFetchJson,
  driveFetchText,
} from './drive-api.js';

/* 要件定義書 §FR-08 の5。英語名刺を含む実データでの検証はフェーズ0で行う。 */
export const OCR_LANGUAGE = 'ja';

/* 空テキストのときの再試行回数（§FR-08 の3）。 */
export const MAX_OCR_ATTEMPTS = 3;

/*
 * 一時ドキュメントの名前の接頭辞。
 *
 * **消し忘れたものを後から識別できる名前にする。** 孤児回収はこの接頭辞で探す。
 */
export const TEMP_DOC_PREFIX = 'card-ocr-poc-temp-';

export const OcrErrorCode = {
  EMPTY: 'OCR_EMPTY',
};

export class OcrError extends Error {
  constructor(code, detail = '') {
    super(`ocr:${code}`);
    this.name = 'OcrError';
    this.code = code;
    this.detail = detail;
  }
}

/* 画面に出す言葉。エラーコードは要件定義書 §15 に対応する。 */
export function describeOcrError(error) {
  if (error instanceof OcrError && error.code === OcrErrorCode.EMPTY) {
    return { text: '文字を読み取れませんでした。撮り直してください。', errorCode: 'OCR-002' };
  }

  return { text: 'OCRに失敗しました。', errorCode: 'OCR-001' };
}

export function buildTempDocName(now = Date.now()) {
  return `${TEMP_DOC_PREFIX}${now}`;
}

/*
 * 画像を Google ドキュメントへ変換してアップロードする。戻り値はドキュメントID。
 *
 * このドキュメントは中間生成物なので、呼び出し側が必ず削除する。
 * フォルダには入れない（すぐ消すため）。
 */
async function uploadForOcr({ token, blob, fetchImpl }) {
  const boundary = createBoundary();
  const metadata = {
    name: buildTempDocName(),
    mimeType: GOOGLE_DOC_MIME,
  };

  const body = buildMultipartBody(metadata, blob, boundary);

  const params = new URLSearchParams({
    uploadType: 'multipart',
    ocrLanguage: OCR_LANGUAGE,
    fields: 'id',
  });

  const result = await driveFetchJson(`${DRIVE_UPLOAD_ENDPOINT}?${params}`, {
    token,
    fetchImpl,
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });

  if (!result?.id) {
    throw new DriveError(DriveErrorCode.UNKNOWN, 0, 'ocr_file_id_missing');
  }

  return result.id;
}

/*
 * ドキュメントの本文をプレーンテキストで取り出す。
 *
 * **このエンドポイントは JSON ではなくテキストを返す。**
 * response.json() ではなく text() で受けること。
 */
async function exportPlainText({ token, fileId, fetchImpl }) {
  const params = new URLSearchParams({ mimeType: 'text/plain' });
  const url = `${DRIVE_FILES_ENDPOINT}/${encodeURIComponent(fileId)}/export?${params}`;

  return driveFetchText(url, { token, fetchImpl });
}

/* 削除できなくても全体は失敗にしない。結果だけ返す。 */
async function deleteQuietly(fileId, { token, fetchImpl }) {
  try {
    await deleteFile(fileId, { token, fetchImpl });
    return true;
  } catch {
    return false;
  }
}

/*
 * 画像から文字を読み取る。
 *
 * 空テキストのときは、一時ドキュメントを消したうえで変換からやり直す
 * （最大 MAX_OCR_ATTEMPTS 回）。
 *
 * 戻り値: { text, attempts, deleted }
 *   deleted … 一時ドキュメントを全て消せたか。false なら孤児が残っている
 */
export async function ocrImage({ token, blob, fetchImpl, maxAttempts = MAX_OCR_ATTEMPTS }) {
  let lastDeleted = true;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const fileId = await uploadForOcr({ token, blob, fetchImpl });

    let text = '';

    try {
      text = await exportPlainText({ token, fileId, fetchImpl });
    } finally {
      /* 取得が失敗しても中間生成物は必ず消す。 */
      lastDeleted = await deleteQuietly(fileId, { token, fetchImpl }) && lastDeleted;
    }

    if (text.trim() !== '') {
      return { text, attempts: attempt, deleted: lastDeleted };
    }
  }

  throw new OcrError(OcrErrorCode.EMPTY, `attempts=${maxAttempts}`);
}

/*
 * 前回までに消し損ねた一時ドキュメントを回収する（要件定義書 8.1 ステージ0 の5）。
 *
 * 名前の前方一致では検索できないため、接頭辞を含むものを探して名前で絞る。
 * drive.file スコープなので、このクライアントIDが作ったものだけが対象になる。
 *
 * 戻り値: { found, deleted }
 */
export async function collectOrphanTempDocs({ token, fetchImpl, pageSize = 50 }) {
  const params = new URLSearchParams({
    q: [
      `name contains '${TEMP_DOC_PREFIX}'`,
      `mimeType='${GOOGLE_DOC_MIME}'`,
      'trashed=false',
    ].join(' and '),
    fields: 'files(id,name)',
    pageSize: String(pageSize),
    spaces: 'drive',
  });

  const result = await driveFetchJson(`${DRIVE_FILES_ENDPOINT}?${params}`, { token, fetchImpl });
  const files = Array.isArray(result?.files) ? result.files : [];

  /* 検索は contains なので、接頭辞で始まるものだけに絞り直す。 */
  const targets = files.filter((file) => String(file?.name ?? '').startsWith(TEMP_DOC_PREFIX));

  let deleted = 0;

  for (const file of targets) {
    if (await deleteQuietly(file.id, { token, fetchImpl })) {
      deleted += 1;
    }
  }

  return { found: targets.length, deleted };
}

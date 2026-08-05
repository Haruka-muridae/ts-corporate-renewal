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
 * public/production-app/card-ocr/poc/drive-ocr.js（2026-08-04）。
 * その元は public/apps/card-scanner/drive-ocr.js。
 * **どちらも import はしない**（docs/repository-structure.md §2-1・§4-1）。
 *
 * PoC から変えたところ:
 *   - **面ごとに並列で走らせる口を足した**（§FR-08 の6、v3.1）
 *   - **裏面の失敗を全体の失敗にしない**（同7）
 *   - 一時ドキュメントを保存先フォルダの中に作るようにした（§FR-08 の1）
 *   - AbortSignal を通せるようにした
 * ==================================================================
 *
 * ==================================================================
 * 一時ドキュメントは必ず消す
 * ==================================================================
 * 中間生成物であり、利用者のドライブに残してよいものではない。
 * **名刺の本文がそのまま入っている**ので、残せば第三者の個人情報が
 * 意図しない形でドライブに溜まることになる。
 *
 * エクスポートが失敗しても削除する（try / finally）。
 * 削除に失敗した場合は全体を失敗にせず、次回起動時の孤児回収に任せる
 * （要件定義書 §FR-21、AC-07）。
 *
 * **領収書OCRには孤児回収が無い**
 * （docs/receipt-ocr-findings-20260804.md #6）。同じ状態にしない。
 * ==================================================================
 */

import {
  DRIVE_FILES_ENDPOINT,
  DRIVE_UPLOAD_ENDPOINT,
  GOOGLE_DOC_MIME,
} from './config.js';

import {
  DriveError,
  DriveErrorCode,
  buildMultipartBody,
  createBoundary,
  deleteFile,
  driveFetchJson,
  driveFetchText,
} from './drive-api.js';

/* 要件定義書 §FR-08 の5。 */
export const OCR_LANGUAGE = 'ja';

/* 空テキストのときの再試行回数（§FR-08 の3）。 */
export const MAX_OCR_ATTEMPTS = 3;

/*
 * 一時ドキュメントの名前の接頭辞。
 *
 * **消し忘れたものを後から識別できる名前にする。** 孤児回収はこの接頭辞で探す。
 * 検証ページ（poc/）は `card-ocr-poc-temp-` を使う。**同じにしないこと。**
 * 同じだと、片方の回収がもう片方の処理中の一時ドキュメントを消しうる。
 */
export const TEMP_DOC_PREFIX = 'card-ocr-temp-';

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
  const isEmpty = error instanceof OcrError && error.code === OcrErrorCode.EMPTY;
  const detail = error instanceof OcrError
    ? String(error.detail ?? '')
    : `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`;

  if (isEmpty) {
    return {
      text: '文字を読み取れませんでした。撮り直してください。',
      errorCode: 'OCR-002',
      detail,
    };
  }

  return { text: 'OCRに失敗しました。', errorCode: 'OCR-001', detail };
}

/*
 * 一時ドキュメントの名前。
 *
 * **面と通し番号を入れる。** 表裏を同時に走らせるので、同じミリ秒に
 * 2つ作られうる。名前が衝突しても Drive は別ファイルとして扱うが、
 * 孤児回収の記録を読むときに区別できないと困る。
 */
export function buildTempDocName(side = 'front', now = Date.now(), seq = 0) {
  return `${TEMP_DOC_PREFIX}${side}-${now}-${seq}`;
}

/*
 * 画像を Google ドキュメントへ変換してアップロードする。戻り値はドキュメントID。
 *
 * 作成先は「TSAM AI/名刺データ」配下（§FR-08 の1）。マイドライブ直下に
 * 作ると、消し損ねたときに利用者の目に付く場所へ残ることになる。
 * parentId が無ければ従来どおり直下へ作る（保存先が未解決でも動くように）。
 */
async function uploadForOcr({ token, blob, fetchImpl, signal, side, seq, parentId }) {
  const boundary = createBoundary();
  const metadata = {
    name: buildTempDocName(side, Date.now(), seq),
    mimeType: GOOGLE_DOC_MIME,
  };

  if (parentId) {
    metadata.parents = [parentId];
  }

  const body = buildMultipartBody(metadata, blob, boundary);

  const params = new URLSearchParams({
    uploadType: 'multipart',
    ocrLanguage: OCR_LANGUAGE,
    fields: 'id',
  });

  const result = await driveFetchJson(`${DRIVE_UPLOAD_ENDPOINT}?${params}`, {
    token,
    fetchImpl,
    signal,
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
async function exportPlainText({ token, fileId, fetchImpl, signal }) {
  const params = new URLSearchParams({ mimeType: 'text/plain' });
  const url = `${DRIVE_FILES_ENDPOINT}/${encodeURIComponent(fileId)}/export?${params}`;

  return driveFetchText(url, { token, fetchImpl, signal });
}

/*
 * 削除できなくても全体は失敗にしない。結果だけ返す。
 *
 * **signal は渡さない。** 中断されたときこそ消す必要があるのに、
 * 中断済みの signal を渡すと削除そのものが始まらない。
 */
async function deleteQuietly(fileId, { token, fetchImpl }) {
  try {
    await deleteFile(fileId, { token, fetchImpl });
    return true;
  } catch {
    return false;
  }
}

/*
 * 画像1枚から文字を読み取る。
 *
 * 空テキストのときは、一時ドキュメントを消したうえで変換からやり直す
 * （最大 MAX_OCR_ATTEMPTS 回）。
 *
 * 戻り値: { text, attempts, deleted, side }
 *   deleted … 一時ドキュメントを全て消せたか。false なら孤児が残っている
 */
export async function ocrImage({
  token,
  blob,
  fetchImpl,
  signal,
  side = 'front',
  parentId = null,
  maxAttempts = MAX_OCR_ATTEMPTS,
}) {
  let lastDeleted = true;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const fileId = await uploadForOcr({
      token, blob, fetchImpl, signal, side, seq: attempt, parentId,
    });

    let text = '';

    try {
      text = await exportPlainText({ token, fileId, fetchImpl, signal });
    } finally {
      /* 取得が失敗しても中間生成物は必ず消す。 */
      lastDeleted = await deleteQuietly(fileId, { token, fetchImpl }) && lastDeleted;
    }

    if (text.trim() !== '') {
      return { text, attempts: attempt, deleted: lastDeleted, side };
    }
  }

  throw new OcrError(OcrErrorCode.EMPTY, `side=${side} attempts=${maxAttempts}`);
}

/*
 * 表面・裏面をまとめて読み取る（§FR-08 の6・7、v3.1）。
 *
 * ==================================================================
 * 並列に投げる。裏面の失敗で全体を落とさない
 * ==================================================================
 * 面ごとの OCR は互いに依存しないので、直列にすると単純に倍待つ。
 * §13.1 の所要時間目標（両面60秒）は並列を前提に置いている。
 *
 * **裏面は補助である。** 裏面が空でも、通信で失敗しても、表面の結果だけで
 * 先へ進む。画面には「裏面は読み取れませんでした」と出す（§FR-08 の7）。
 *
 * 逆に**表面の失敗は全体の失敗**とする。表面が読めない名刺は、
 * 登録しても中身が入らない。
 * ==================================================================
 *
 * 戻り値:
 *   { front: {text, attempts, deleted}, back: {…}|null,
 *     backError: Error|null, deleted: boolean }
 */
export async function ocrBothSides({
  token,
  front,
  back = null,
  fetchImpl,
  signal,
  parentId = null,
  maxAttempts = MAX_OCR_ATTEMPTS,
}) {
  const options = { token, fetchImpl, signal, parentId, maxAttempts };

  const [frontResult, backSettled] = await Promise.all([
    ocrImage({ ...options, blob: front, side: 'front' }),
    back
      ? ocrImage({ ...options, blob: back, side: 'back' })
        .then((value) => ({ ok: true, value }))
        /* ここで握る。**表面の Promise.all を巻き込ませない。** */
        .catch((error) => ({ ok: false, error }))
      : Promise.resolve(null),
  ]);

  const backResult = backSettled?.ok ? backSettled.value : null;
  const backError = backSettled && !backSettled.ok ? backSettled.error : null;

  return {
    front: frontResult,
    back: backResult,
    backError,
    deleted: frontResult.deleted && (backResult ? backResult.deleted : true),
  };
}

/*
 * 表裏のテキストを結合する（§FR-11、v3.1）。
 *
 * **面の区切りを明示する。** Gemini には1回で両面を渡すので、
 * どこからが裏面かが分からないと「表面優先」を指示しても効かない。
 * 裏面が無ければ表面だけを返す（余計な見出しを付けない）。
 */
export function joinSides(frontText, backText = '') {
  const front = String(frontText ?? '').trim();
  const back = String(backText ?? '').trim();

  if (back === '') {
    return front;
  }

  return `【表面】\n${front}\n\n【裏面】\n${back}`;
}

/*
 * 前回までに消し損ねた一時ドキュメントを回収する（§8.1 ステージ0 の5）。
 *
 * 名前の前方一致では検索できないため、接頭辞を含むものを探して名前で絞る。
 * drive.file スコープなので、**このクライアントIDが作ったものだけ**が対象になる。
 * 利用者の他のファイルには届かない。
 *
 * 戻り値: { found, deleted }
 */
export async function collectOrphanTempDocs({ token, fetchImpl, signal, pageSize = 50 }) {
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

  const result = await driveFetchJson(`${DRIVE_FILES_ENDPOINT}?${params}`, {
    token, fetchImpl, signal,
  });

  const files = Array.isArray(result?.files) ? result.files : [];

  /*
   * 検索は contains なので、接頭辞で**始まる**ものだけに絞り直す。
   * 絞らないと `card-ocr-poc-temp-…` まで拾い、検証ページの
   * 処理中の一時ドキュメントを消しうる。
   */
  const targets = files.filter((file) => String(file?.name ?? '').startsWith(TEMP_DOC_PREFIX));

  let deleted = 0;

  for (const file of targets) {
    if (await deleteQuietly(file.id, { token, fetchImpl })) {
      deleted += 1;
    }
  }

  return { found: targets.length, deleted };
}

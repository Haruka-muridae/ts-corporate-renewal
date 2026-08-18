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
 *
 * **消し損ねたものを回収する経路を持つ**（2026-08-18 追加）。
 * 通信断・タブを閉じた・トークン失効といった場面で削除は失敗しうる。
 * 回収する経路が無いと、OCR結果のテキストを含むドキュメントが
 * 利用者のドライブに溜まり続ける。「一時ファイルは即時に完全削除する」と
 * いう §9.5 の方針が、失敗経路で崩れていた
 * （docs/receipt-ocr-findings-20260804.md #6）。
 *
 * 複製元: public/production-app/card-ocr/drive-ocr.js の
 * collectOrphanTempDocs()（複製日 2026-08-18）。**import はしない**
 * （docs/repository-structure.md §4-1）。複製元から変えたところ:
 *   - 旧命名（`ocr-tmp-<利用者のファイル名>`）で残っている分も回収対象にした
 *   - **作成直後のものは消さない**（別タブで処理中のものを消さないため）
 * ------------------------------------------------------------------
 */

import { GOOGLE_API } from './config.js';
import { AppError, PROGRESS } from './errors.js';
import { callGoogle, callGoogleText } from './google-api.js';
import {
  createBoundary, deleteFile, findByNameContains, GOOGLE_DOC_MIME,
} from './drive.js';

export const ENGINE_ID = 'drive';

/* このエンジンは Gemini APIキーを必要としない（§4 キー未設定時の挙動）。 */
export const requiresApiKey = false;

/*
 * 一時ドキュメントの名前の接頭辞。
 *
 * **利用者のファイル名を入れない**（2026-08-18 変更）。
 * 旧実装は `ocr-tmp-${利用者のファイル名}` だったため、
 *   - 検索条件を組めず、消し損ねたものを後から見つけられない
 *   - 領収書のファイル名がドライブ上の別ファイル名として残る
 * という2つの問題があった。固定の接頭辞＋時刻＋通し番号にする。
 */
export const TEMP_DOC_PREFIX = 'receipt-ocr-tmp-';

/* 旧命名。回収の対象には含めるが、新しく作ることはない。 */
export const LEGACY_TEMP_DOC_PREFIX = 'ocr-tmp-';

/*
 * 回収の対象にするまでの猶予（10分）。
 *
 * **作成直後のものを消さない。** 複数のタブで同時に使っていると、
 * 片方の起動時回収が、もう片方が処理中の一時ドキュメントを
 * 消しうる。処理は数十秒で終わる想定（§14）なので、10分あれば
 * 「処理中」と「消し損ね」を取り違えない。
 */
export const ORPHAN_MIN_AGE_MS = 10 * 60 * 1000;

export function buildTempDocName(now = Date.now(), seq = 0) {
  return `${TEMP_DOC_PREFIX}${now}-${seq}`;
}

/* 一時ドキュメントの名前か（回収対象の絞り込み）。 */
export function isTempDocName(name) {
  const value = String(name ?? '');

  return value.startsWith(TEMP_DOC_PREFIX) || value.startsWith(LEGACY_TEMP_DOC_PREFIX);
}

/*
 * 画像を一時ドキュメントへ変換して上げる。
 * 変換の指示は uploadType=multipart ＋ mimeType の指定で行う。
 */
async function uploadForOcr({ accessToken, blob, signal, seq = 0 }) {
  const metadata = {
    name: buildTempDocName(Date.now(), seq),
    mimeType: GOOGLE_DOC_MIME,
  };

  /* 内容から決めない（findings #7）。drive.js と同じ作り方を使う。 */
  const boundary = createBoundary();
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
 * 戻り値は { engine, text, deleted }。失敗は OCR-001。
 * deleted が false なら一時ドキュメントが残っている（次回起動時に回収する）。
 * 原本の保存は先に済んでいる前提なので、progress は ORIGINAL_SAVED。
 */
export async function recognize({ blob, accessToken, signal } = {}) {
  if (!blob) {
    throw new AppError('OCR-001', { progress: PROGRESS.ORIGINAL_SAVED, detail: 'no_blob' });
  }

  const documentId = await uploadForOcr({ accessToken, blob, signal });

  let text = '';
  let deleted = false;

  try {
    const url = new URL(`${GOOGLE_API.driveFiles}/${encodeURIComponent(documentId)}/export`);
    url.searchParams.set('mimeType', 'text/plain');

    text = await callGoogleText(url.href, {
      accessToken,
      signal,
      progress: PROGRESS.ORIGINAL_SAVED,
    });
  } finally {
    /*
     * 取得が失敗しても消す。
     * **signal は渡さない。** 中断されたときこそ消す必要があるのに、
     * 中断済みの signal を渡すと削除そのものが始まらない。
     *
     * 戻り値を捨てないこと（findings #6）。return 文の中で組み立てると
     * finally の代入が間に合わないため、返すのは try の外で行う。
     */
    deleted = await deleteFile(documentId, { accessToken });
  }

  return { engine: ENGINE_ID, text: String(text ?? ''), deleted };
}

/*
 * 消し損ねた一時ドキュメントを回収する（§9.5・findings #6）。
 *
 * 起動時に1回だけ呼ぶ想定。失敗しても呼び出し側を止めない設計にするため、
 * 個々の削除失敗は数に反映するだけで例外にしない。
 * 検索自体が失敗した場合は例外を投げる（呼び出し側が握る）。
 *
 * 戻り値: { found, deleted, skipped }
 *   skipped … 作成から日が浅く、処理中の可能性があるため触らなかった数
 */
export async function collectOrphanTempDocs({
  accessToken,
  signal,
  now = Date.now(),
  minAgeMs = ORPHAN_MIN_AGE_MS,
} = {}) {
  const files = await findByNameContains([TEMP_DOC_PREFIX, LEGACY_TEMP_DOC_PREFIX], {
    accessToken,
    mimeType: GOOGLE_DOC_MIME,
    signal,
  });

  /*
   * 検索は contains なので、接頭辞で**始まる**ものだけに絞り直す。
   * 絞らないと、利用者が自分で作った「◯◯ocr-tmp-◯◯」という名前の
   * ドキュメントまで消しかねない。
   */
  const candidates = files.filter((file) => isTempDocName(file?.name));

  let deleted = 0;
  let skipped = 0;

  for (const file of candidates) {
    const createdAt = Date.parse(String(file?.createdTime ?? ''));

    /* 作成時刻が読めないものは古いものとして扱う（回収する）。 */
    if (Number.isFinite(createdAt) && now - createdAt < minAgeMs) {
      skipped += 1;
      continue;
    }

    if (await deleteFile(file.id, { accessToken })) {
      deleted += 1;
    }
  }

  return { found: candidates.length - skipped, deleted, skipped };
}

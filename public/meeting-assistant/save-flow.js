/*
 * ブラウザ録音の「保存 → 議事録」の流れ。画面・Drive・OPFS・Gemini を直接は知らない。
 *
 * ------------------------------------------------------------------
 * 端末の録音（OPFS）を消すのは、すべてが終わったあと
 * ------------------------------------------------------------------
 *   録音確定（OPFS に保持）
 *     → Google 認証を確定（有効で残り時間が十分ならそのまま。足りなければ利用者の押下で更新）
 *     → 保存先フォルダを保証（検索 → 無い階層だけ作成。drive-folders.js）
 *     → Drive（Potenitas voice）へ音声を保存
 *     → 台帳を UPLOADED（driveFileId 付き）にする
 *     → 台帳を PROCESSING にして Gemini → Markdown → Potenitas record
 *     → 全工程の成功を確認
 *     → 台帳から削除
 *     → OPFS の録音を削除
 *
 * 以前は Drive 保存の直後に OPFS を消し、その消えたファイルを指す File を
 * Gemini へ送っていたため、送信が「Failed to fetch」で必ず失敗した
 * （2026-08-25 本番）。Gemini 送信は fetch の body として File を読む。
 * OPFS の実体が消えていれば読めない。だから議事録の処理が終わるまで消さない。
 *
 * 録音を別の Blob へ複製してメモリに載せることもしない（90 分・約 86MB）。
 * OPFS の File をそのまま順に読ませる。
 *
 * ------------------------------------------------------------------
 * 失敗したときに録音を失わない
 * ------------------------------------------------------------------
 *   認証を更新できない … 台帳は変えず、端末の録音は残る。「Driveへ保存」の押下で再開
 *   保存先を作れない   … UPLOAD_FAILED。端末の録音は残る。「Driveへ再送」
 *   Drive 保存に失敗   … UPLOAD_FAILED。端末の録音は残る。「Driveへ再送」
 *   議事録の処理に失敗 … PROCESS_FAILED。端末の録音も Drive の音声も残る。
 *                        「議事録を作成」で処理だけをやり直す（Drive へは再送しない）
 *   処理の途中で落ちた … PROCESSING のまま残る。次回起動時に同じく「議事録を作成」
 *
 * 依存（deps）:
 *   ensureAuth    … () => Promise<void>  認証チェックポイント。足りなければ更新（失敗は例外）
 *   resolveFolder … (auth?) => Promise<string>  保存先（Potenitas voice）の ID を保証する
 *   ledger        … { get, put, remove }（pending-store.js）
 *   loadFile      … (localPath) => Promise<Blob>   OPFS から File を取る
 *   deleteLocal   … (localPath) => Promise<void>   OPFS の録音を消す
 *   uploadToDrive … (blob, entry, folderId) => Promise<{ id, name, webViewLink, url }>
 *   process       … (driveFile, entry) => Promise<{ completed: boolean }>
 *                    driveFile = { id, name, webViewLink, url, blob }
 *                    completed=false は「失敗ではないが終わっていない」
 *                    （APIキー未設定など）。台帳は UPLOADED のまま残す
 *   onStage       … (stage, info) => void  進捗の通知（任意）
 *   onFailure     … (stage, error, info) => void  失敗の記録（任意）
 * ------------------------------------------------------------------
 */

import { AppError, ErrorCode } from './errors.js';
import {
  applyProcessFailure,
  applyProcessing,
  applyUploadFailure,
  applyUploaded,
  isDriveSaved,
} from './recording-checkpoint.js';

export const SaveStage = Object.freeze({
  AUTH: 'auth',
  LOAD_LOCAL: 'load-local',
  FOLDER: 'folder',
  DRIVE_UPLOAD: 'drive-upload',
  PROCESS: 'process',
  CLEANUP: 'cleanup',
});

export const SaveOutcome = Object.freeze({
  COMPLETED: 'completed',
  DRIVE_FAILED: 'drive-failed',
  PROCESS_FAILED: 'process-failed',
  NOT_COMPLETED: 'not-completed',
});

function errorCodeOf(error) {
  return String(error?.code ?? error?.name ?? 'UNKNOWN');
}

/*
 * 台帳の 1 行を Drive へ保存し、議事録の処理まで進める。
 *
 * 戻り値: { outcome, entry, driveFile?, error? }
 *   Drive 保存の失敗だけは例外を投げる（呼び出し側が「再送」を案内する）。
 *   議事録の処理の失敗は例外を投げず outcome で返す（Drive には保存済みで、
 *   画面には「Drive には保存済み・やり直せる」と伝える必要があるため）。
 */
export async function saveAndProcessRecording({ entry, file = null }, deps) {
  const {
    ensureAuth = async () => {},
    resolveFolder = async () => null,
    ledger,
    loadFile,
    deleteLocal,
    uploadToDrive,
    process,
    onStage = () => {},
    onFailure = () => {},
  } = deps;

  let current = entry;
  let blob = file;

  /*
   * 0. Google 認証チェックポイント。
   * Drive へ上げる前にも、Drive 保存済みの再処理（最後に Markdown を Drive へ保存する）でも要る。
   * 更新できなければ台帳は変えずに返す（失敗ではなく「押してもらう」段階）。
   */
  onStage(SaveStage.AUTH, { recordingId: current.recordingId });

  try {
    await ensureAuth();
  } catch (error) {
    onFailure(SaveStage.AUTH, error, { recordingId: current.recordingId });
    throw error;
  }

  /* 1. 端末の録音を取る（File は参照。ここでは読まない） */
  onStage(SaveStage.LOAD_LOCAL, { recordingId: current.recordingId });

  if (!blob) {
    try {
      blob = await loadFile(current.localPath);
    } catch (error) {
      onFailure(SaveStage.LOAD_LOCAL, error, { recordingId: current.recordingId });

      if (error?.name === 'NotFoundError') {
        /* OPFS から消えている。台帳だけ残っても意味がないので落とす。 */
        ledger.remove(current.recordingId);

        if (isDriveSaved(current)) {
          /* 音声は Drive にある。Drive の一覧から作り直せることを伝える。 */
          throw new AppError(ErrorCode.LOCAL_FILE_MISSING_DRIVE_SAVED, 'local_file_unavailable', error);
        }
      }

      throw new AppError(ErrorCode.UPLOAD_FAILED, 'local_file_unavailable', error);
    }
  }

  if (!blob || blob.size === 0) {
    ledger.remove(current.recordingId);
    await deleteLocal(current.localPath);
    throw new AppError(ErrorCode.ENCODE_FAILED, 'empty_recording');
  }

  /* 2. Drive へ保存（保存済みなら送らない） */
  let driveFile;

  if (isDriveSaved(current)) {
    onStage(SaveStage.DRIVE_UPLOAD, { recordingId: current.recordingId, skipped: true });
    driveFile = {
      id: current.driveFileId,
      name: current.fileName,
      webViewLink: current.driveUrl || null,
      url: current.driveUrl || null,
    };
  } else {
    /* 2a. 保存先フォルダを保証する（検索 → 無い階層だけ作成）。失敗しても録音は残す。 */
    onStage(SaveStage.FOLDER, { recordingId: current.recordingId });
    let folderId;

    try {
      folderId = await resolveFolder();
    } catch (error) {
      onFailure(SaveStage.FOLDER, error, { recordingId: current.recordingId });
      current = applyUploadFailure({ ...current, sizeBytes: blob.size }, errorCodeOf(error));
      ledger.put(current);
      throw error;
    }

    /* 2b. Drive へ音声を保存 */
    onStage(SaveStage.DRIVE_UPLOAD, { recordingId: current.recordingId, sizeBytes: blob.size });

    try {
      driveFile = await uploadToDrive(blob, current, folderId);
    } catch (error) {
      onFailure(SaveStage.DRIVE_UPLOAD, error, { recordingId: current.recordingId });
      current = applyUploadFailure({ ...current, sizeBytes: blob.size }, errorCodeOf(error));
      ledger.put(current);
      throw error;
    }

    current = applyUploaded(
      { ...current, sizeBytes: blob.size },
      { driveFileId: String(driveFile?.id ?? ''), driveUrl: String(driveFile?.url ?? driveFile?.webViewLink ?? '') },
    );
    ledger.put(current);
  }

  /* 3. 議事録の処理（Gemini → Markdown → record）。端末の録音はまだ残す。 */
  current = applyProcessing(current);
  ledger.put(current);
  onStage(SaveStage.PROCESS, { recordingId: current.recordingId, driveFileId: current.driveFileId !== '' });

  let result;

  try {
    result = await process({ ...driveFile, blob }, current);
  } catch (error) {
    onFailure(SaveStage.PROCESS, error, { recordingId: current.recordingId });
    current = applyProcessFailure(current, errorCodeOf(error));
    ledger.put(current);
    return { outcome: SaveOutcome.PROCESS_FAILED, entry: current, driveFile, error };
  }

  if (result?.completed !== true) {
    /* 失敗ではないが終わっていない（APIキー未設定など）。UPLOADED に戻して残す。 */
    current = applyUploaded(current, { driveFileId: current.driveFileId, driveUrl: current.driveUrl });
    ledger.put(current);
    return { outcome: SaveOutcome.NOT_COMPLETED, entry: current, driveFile };
  }

  /* 4. 全工程が成功した。ここで初めて台帳と端末の録音を消す。 */
  onStage(SaveStage.CLEANUP, { recordingId: current.recordingId });
  ledger.remove(current.recordingId);
  await deleteLocal(current.localPath);

  return { outcome: SaveOutcome.COMPLETED, entry: current, driveFile };
}

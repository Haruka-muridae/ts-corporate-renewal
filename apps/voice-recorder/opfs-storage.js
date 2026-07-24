/*
 * OPFS（Origin Private File System）操作のうち、メインスレッド側の担当分。
 * SyncAccessHandle を使う書き込みは Worker 内（long-encoder-worker.js）で行う。
 * ここでは非同期APIのみ（ディレクトリ確認・起動時削除・File取得・削除）。
 *
 * OPFS は「録音中の一時保存領域」であり最終保存先ではない。
 * 保存または破棄後に一時ファイルは削除する。
 *
 * MVPでは復旧機能を実装しない。異常終了で残った .part ファイルは、
 * 次回起動時にこの opfs-storage.js が無条件で自動削除する（下記 cleanupStaleFiles）。
 */

export const RECORDINGS_DIR = 'recordings';
export const PART_SUFFIX = '.mp3.part';

/* OPFS ルート直下の recordings ディレクトリを得る（なければ作成）。 */
export async function getRecordingsDir(create = true) {
  if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') {
    throw new Error('OPFS_UNSUPPORTED');
  }
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(RECORDINGS_DIR, { create });
}

/*
 * 起動時のクリーンアップ。
 * recordings 配下の一時ファイル（.part）をすべて削除する。
 * MVPでは復旧しないため、残存は「異常終了の名残」とみなし無条件で消す。
 * 24時間の経過待ちはしない（起動時に即削除してよい、という決定に従う）。
 * 削除失敗は console.warn に記録し、通常利用は継続する。
 */
export async function cleanupStaleFiles() {
  let dir;
  try {
    dir = await getRecordingsDir(false);
  } catch {
    /* ディレクトリ自体が無い（未使用）か OPFS 非対応。何もしない。 */
    return { removed: 0, failed: 0 };
  }

  let removed = 0;
  let failed = 0;

  try {
    /* values() は AsyncIterator。対応環境のみ列挙できる。 */
    for await (const entry of dir.values()) {
      if (entry.kind === 'file' && entry.name.endsWith(PART_SUFFIX)) {
        try {
          await dir.removeEntry(entry.name);
          removed += 1;
        } catch (error) {
          failed += 1;
          console.warn('[voice-recorder] 一時ファイル削除に失敗', entry.name, error);
        }
      }
    }
  } catch (error) {
    console.warn('[voice-recorder] 一時ファイルの列挙に失敗', error);
  }

  return { removed, failed };
}

/* 確定した一時ファイルを File として取得する（プレビュー・保存用）。 */
export async function getRecordingFile(fileName) {
  const dir = await getRecordingsDir(false);
  const handle = await dir.getFileHandle(fileName, { create: false });
  return handle.getFile();
}

/* 一時ファイルを削除する。存在しない場合も成功扱い。 */
export async function deleteRecording(fileName) {
  try {
    const dir = await getRecordingsDir(false);
    await dir.removeEntry(fileName);
    return true;
  } catch (error) {
    /* 既に無い場合など。致命ではないため warn に留める。 */
    console.warn('[voice-recorder] 一時ファイル削除に失敗', fileName, error);
    return false;
  }
}

/*
 * 一時ファイル名を作る。
 * rec-YYYYMMDD-HHmmss-<random>.mp3.part
 * random は多重起動時の衝突回避。日時は利用者のローカル時刻。
 */
export function buildPartName(date, randomToken) {
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p2(date.getMonth() + 1)}${p2(date.getDate())}`
    + `-${p2(date.getHours())}${p2(date.getMinutes())}${p2(date.getSeconds())}`;
  return `rec-${stamp}-${randomToken}${PART_SUFFIX}`;
}

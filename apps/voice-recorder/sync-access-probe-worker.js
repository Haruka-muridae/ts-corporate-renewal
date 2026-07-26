/*
 * SyncAccessHandle 実対応の検証用 Worker（classic worker）。
 * createSyncAccessHandle は Dedicated Worker 内でしか正しく判定できないため、
 * 実際に一時ファイルを作って開き、閉じて削除できるかで対応可否を確認する。
 *
 * メッセージ受信: { type: 'probe', dirName }
 * メッセージ送信: { type: 'result', supported: boolean, error?: string }
 * error にはエラー名（NotSupportedError / InvalidStateError / SecurityError /
 * QuotaExceededError / UnknownError など）を入れる。
 */

self.onmessage = async (event) => {
  const message = event.data;
  if (!message || message.type !== 'probe') {
    return;
  }

  const dirName = message.dirName || 'recordings';
  const probeName = `probe-${(Date.now() % 1000000).toString(36)}.tmp`;

  let dir = null;
  let handle = null;

  try {
    if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') {
      self.postMessage({ type: 'result', supported: false, error: 'NotSupportedError' });
      return;
    }

    const root = await navigator.storage.getDirectory();
    dir = await root.getDirectoryHandle(dirName, { create: true });
    const fileHandle = await dir.getFileHandle(probeName, { create: true });

    /* ここが本命。対応していなければ例外になる。 */
    handle = await fileHandle.createSyncAccessHandle();
    /* 1バイト書いて閉じるところまで確認する。 */
    handle.write(new Uint8Array([0]), { at: 0 });
    handle.flush();
    handle.close();
    handle = null;

    /* 後片付け：プローブ用一時ファイルを必ず削除する。 */
    await dir.removeEntry(probeName);

    self.postMessage({ type: 'result', supported: true });
  } catch (error) {
    /* 失敗時も、作りかけの一時ファイルを可能な限り削除する。 */
    try { handle?.close(); } catch { /* noop */ }
    try { if (dir) await dir.removeEntry(probeName); } catch { /* noop */ }

    const name = (error && error.name) ? error.name : 'UnknownError';
    self.postMessage({ type: 'result', supported: false, error: name });
  }
};

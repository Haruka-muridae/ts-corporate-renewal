/*
 * 長時間録音モードの対応環境判定。
 * 個別の理由を返し、UI がどれが欠けているかを表示できるようにする。
 * ここでは通信も録音も行わず、機能検出のみを担う。
 */

/* 96kbps モノラル MP3 のおおよそのバイト/秒（見積り用の定数）。 */
export const MP3_BYTES_PER_SECOND = 96000 / 8; // 12000 bytes/s ≒ 0.70 MB/min

/* 長時間録音の上限と、開始前に要求する最低空き容量。 */
export const LONG_MAX_SECONDS = 60 * 60;
export const LONG_WARNING_SECONDS = 55 * 60;
export const MIN_FREE_BYTES = 150 * 1024 * 1024; // 150 MB

/* 長時間モードが対応するサンプルレート（規格内のみ、リサンプルしない）。 */
export const SUPPORTED_SAMPLE_RATES = [44100, 48000];

/* 個別チェック。true = 利用可能。 */
export function checkSecureContext() {
  return typeof window !== 'undefined' && window.isSecureContext === true;
}

export function checkMicrophone() {
  return typeof navigator !== 'undefined'
    && !!navigator.mediaDevices
    && typeof navigator.mediaDevices.getUserMedia === 'function';
}

export function checkAudioContext() {
  return typeof AudioContext === 'function' || typeof webkitAudioContext === 'function';
}

export function checkAudioWorklet() {
  return typeof AudioWorkletNode === 'function';
}

export function checkWorker() {
  return typeof Worker === 'function';
}

export function checkStorage() {
  return typeof navigator !== 'undefined' && !!navigator.storage;
}

export function checkGetDirectory() {
  return checkStorage() && typeof navigator.storage.getDirectory === 'function';
}

export function checkStorageManager() {
  return checkStorage() && typeof navigator.storage.estimate === 'function';
}

/*
 * 環境判定をまとめて返す。
 * reasons の各キーは「その条件を満たすか（true=OK）」。
 *
 * ここではメインスレッドで確認できる条件のみを判定する。
 * SyncAccessHandle（createSyncAccessHandle）は Dedicated Worker 専用APIで、
 * メインスレッドのプロトタイプ静的判定は対応ブラウザでも false になり得るため、
 * ここでは判定しない。実対応は録音開始時に Worker 内で実検証する
 * （opfs-storage.js の probeSyncAccessSupport / sync-access-probe-worker.js）。
 *
 * 空き容量（capacity）は非同期のため別途 checkFreeSpace で確認する。
 */
export function detectLongModeSupport() {
  const reasons = {
    secureContext: checkSecureContext(),
    microphone: checkMicrophone(),
    audioContext: checkAudioContext(),
    audioWorklet: checkAudioWorklet(),
    worker: checkWorker(),
    storage: checkStorage(),
    getDirectory: checkGetDirectory(),
    estimate: checkStorageManager(),
  };

  const supported = Object.values(reasons).every(Boolean);

  return { supported, reasons };
}

/* 非対応理由を利用者向け文言の配列にする。 */
export const REASON_LABELS = {
  secureContext: '安全な接続（HTTPS または localhost）ではありません。',
  microphone: 'このブラウザはマイク録音に対応していません。',
  audioContext: 'このブラウザは Web Audio に対応していません。',
  audioWorklet: 'このブラウザは AudioWorklet に対応していません。',
  worker: 'このブラウザは Web Worker に対応していません。',
  storage: 'このブラウザは端末内ストレージに対応していません。',
  getDirectory: 'このブラウザは端末内ストレージ（OPFS）に対応していません。',
  estimate: 'このブラウザは空き容量の確認に対応していません。',
};

export function unmetReasonMessages(reasons) {
  return Object.keys(reasons)
    .filter((key) => !reasons[key])
    .map((key) => REASON_LABELS[key] ?? key);
}

/*
 * 空き容量を確認する。
 * navigator.storage.estimate() の値は推定であり、実際に書き込める量と
 * 一致しない可能性がある。安全マージンを含めて判定すること。
 */
export async function checkFreeSpace(minBytes = MIN_FREE_BYTES) {
  if (!checkStorageManager()) {
    return { ok: false, reason: 'unsupported', freeBytes: null, quota: null, usage: null };
  }

  let estimate;
  try {
    estimate = await navigator.storage.estimate();
  } catch {
    return { ok: false, reason: 'estimate-failed', freeBytes: null, quota: null, usage: null };
  }

  const quota = typeof estimate.quota === 'number' ? estimate.quota : 0;
  const usage = typeof estimate.usage === 'number' ? estimate.usage : 0;
  const freeBytes = Math.max(0, quota - usage);

  return {
    ok: freeBytes >= minBytes,
    reason: freeBytes >= minBytes ? 'ok' : 'insufficient',
    freeBytes,
    quota,
    usage,
  };
}

/*
 * AudioContext の実サンプルレートが長時間モードで扱えるか。
 * 44100 / 48000 のみ対応し、それ以外は通常録音へ誘導する。
 * （MVPでは Worker 内リサンプリングを実装しない。）
 */
export function isSupportedSampleRate(sampleRate) {
  return SUPPORTED_SAMPLE_RATES.includes(sampleRate);
}

/* 経過秒からおおよその MP3 サイズ（バイト）を見積もる。 */
export function estimateMp3Bytes(seconds) {
  return Math.round(seconds * MP3_BYTES_PER_SECOND);
}

/* バイトを読みやすい単位にする（表示用）。 */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) {
    return '不明';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

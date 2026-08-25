/*
 * 対応環境の判定（要件書 §8.3）。
 * 個別の理由を返し、UI がどれが欠けているかを表示できるようにする。
 * ここでは通信も録音も行わず、機能検出のみを担う。
 *
 * ------------------------------------------------------------------
 * public/apps/voice-recorder/capabilities.js からの複製
 * ------------------------------------------------------------------
 * 本番アプリからテスト環境を import しない（docs/repository-structure.md §1）。
 * 複製元を直してもここへは反映されない。逆も同じ。
 *
 * 複製元との違い:
 *   - 上限・ビットレート・空き容量の定数を ../config.js へ移した
 *     （本アプリは長時間録音しか持たないため、モード別の定数を分ける必要がない）
 *   - 非対応時に通常録音へ誘導しない。このアプリには代替モードが無く、
 *     非対応はそのまま「利用できない」（§8.3: Chrome 最新版のみ動作保証）
 * ------------------------------------------------------------------
 */

import {
  MIN_FREE_BYTES,
  MP3_BYTES_PER_SECOND,
  SUPPORTED_SAMPLE_RATES,
} from '../config.js';

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
  return typeof AudioContext === 'function';
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
 * メインスレッドの静的判定は対応ブラウザでも false になり得るため、ここでは見ない。
 * 実対応は録音開始時に Worker 内で実検証する（opfs-storage.js の probeSyncAccessSupport）。
 *
 * 空き容量は非同期のため別途 checkFreeSpace で確認する。
 */
export function detectSupport() {
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

  return { supported: Object.values(reasons).every(Boolean), reasons };
}

/* 非対応理由を利用者向け文言にする。 */
export const REASON_LABELS = Object.freeze({
  secureContext: '安全な接続（HTTPS または localhost）ではありません。',
  microphone: 'このブラウザはマイク録音に対応していません。',
  audioContext: 'このブラウザは Web Audio に対応していません。',
  audioWorklet: 'このブラウザは AudioWorklet に対応していません。',
  worker: 'このブラウザは Web Worker に対応していません。',
  storage: 'このブラウザは端末内ストレージに対応していません。',
  getDirectory: 'このブラウザは端末内ストレージ（OPFS）に対応していません。',
  estimate: 'このブラウザは空き容量の確認に対応していません。',
});

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
 * AudioContext の実サンプルレートを扱えるか。
 * 44100 / 48000 のみ対応する（MVPでは Worker 内リサンプリングを実装しない）。
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

/* 秒を hh:mm:ss にする（§FR-04 の経過時間表示）。 */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hh = String(Math.floor(total / 3600)).padStart(2, '0');
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/*
 * MP3エンコード用 Web Worker（classic worker）。
 * メインスレッドから Int16 PCM を受け取り、lamejs で MP3 にする。
 *
 * lamejs はこのファイルからの相対パスで読み込む。
 * worker.js と vendor/ は同じ apps/voice-recorder/ 配下にある。
 */

/* メッセージのtype: 'progress' | 'complete' | 'error' */
const ErrorCode = {
  WORKER_LOAD_FAILED: 'WORKER_LOAD_FAILED',
  ENCODER_INIT_FAILED: 'ENCODER_INIT_FAILED',
  ENCODE_FAILED: 'ENCODE_FAILED',
};

let lamejsReady = false;

try {
  importScripts('./vendor/lamejs.iife.js');
  lamejsReady = typeof lamejs !== 'undefined' && typeof lamejs.Mp3Encoder === 'function';
} catch (error) {
  lamejsReady = false;
  /* 読み込み失敗はメッセージで通知する。onerror でも拾えるよう再送はしない。 */
  self.postMessage({ type: 'error', code: ErrorCode.WORKER_LOAD_FAILED, detail: String(error) });
}

const SAMPLES_PER_FRAME = 1152;
/* 進捗は約2%刻みに間引き、postMessage の頻度を抑える。 */
const PROGRESS_STEP = 0.02;

self.onmessage = (event) => {
  const message = event.data;

  if (!message || message.type !== 'encode') {
    return;
  }

  if (!lamejsReady) {
    self.postMessage({ type: 'error', code: ErrorCode.WORKER_LOAD_FAILED });
    return;
  }

  const { pcm, sampleRate, bitrate } = message;

  let encoder;
  try {
    encoder = new lamejs.Mp3Encoder(1, sampleRate, bitrate);
  } catch (error) {
    self.postMessage({ type: 'error', code: ErrorCode.ENCODER_INIT_FAILED, detail: String(error) });
    return;
  }

  try {
    const total = pcm.length;
    const parts = [];
    let lastReported = 0;

    for (let offset = 0; offset < total; offset += SAMPLES_PER_FRAME) {
      const frame = pcm.subarray(offset, offset + SAMPLES_PER_FRAME);
      const encoded = encoder.encodeBuffer(frame);

      if (encoded.length > 0) {
        parts.push(encoded);
      }

      const ratio = (offset + SAMPLES_PER_FRAME) / total;
      if (ratio - lastReported >= PROGRESS_STEP) {
        lastReported = ratio;
        self.postMessage({ type: 'progress', ratio: Math.min(ratio, 1) });
      }
    }

    const tail = encoder.flush();
    if (tail.length > 0) {
      parts.push(tail);
    }

    self.postMessage({ type: 'progress', ratio: 1 });

    /* 連結して1本の ArrayBuffer にまとめ、transfer で返す。 */
    let totalBytes = 0;
    for (const part of parts) {
      totalBytes += part.length;
    }

    const output = new Uint8Array(totalBytes);
    let position = 0;
    for (const part of parts) {
      output.set(part, position);
      position += part.length;
    }

    /* 大きな中間配列の参照を早期に手放す。 */
    parts.length = 0;

    self.postMessage({ type: 'complete', buffer: output.buffer }, [output.buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', code: ErrorCode.ENCODE_FAILED, detail: String(error) });
  }
};

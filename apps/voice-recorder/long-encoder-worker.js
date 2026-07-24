/*
 * 長時間録音用エンコード Worker（classic worker）。
 * PCM を受け取って lamejs で逐次 MP3 化し、OPFS の一時ファイルへ追記する。
 * 録音全体の PCM も MP3 もメモリに保持しない（端数と直近チャンクのみ）。
 *
 * SyncAccessHandle は専用 Worker 内でのみ利用できるため、書き込みはここで行う。
 * OPFS は一時保存領域。停止時に確定し、保存/破棄後にメイン側が削除する。
 * MVPでは復旧しない。異常終了で残った .part はメイン側が次回起動時に自動削除する。
 */

const MessageType = {
  READY: 'ready',
  PROGRESS: 'progress',
  WARNING: 'warning',
  FINALIZED: 'finalized',
  ABORTED: 'aborted',
  ERROR: 'error',
};

const ErrorCode = {
  WORKER_LOAD_FAILED: 'WORKER_LOAD_FAILED',
  ENCODER_INIT_FAILED: 'ENCODER_INIT_FAILED',
  OPFS_OPEN_FAILED: 'OPFS_OPEN_FAILED',
  OPFS_WRITE_FAILED: 'OPFS_WRITE_FAILED',
  ENCODE_FAILED: 'ENCODE_FAILED',
  FINALIZE_FAILED: 'FINALIZE_FAILED',
};

const SAMPLES_PER_FRAME = 1152;
const BITRATE_KBPS = 96;
/* 何秒ぶんエンコードするごとに OPFS を flush（ディスク確定）するか。 */
const FLUSH_INTERVAL_SECONDS = 10;

let lamejsReady = false;
try {
  importScripts('./vendor/lamejs.iife.js');
  lamejsReady = typeof lamejs !== 'undefined' && typeof lamejs.Mp3Encoder === 'function';
} catch (error) {
  lamejsReady = false;
  self.postMessage({ type: MessageType.ERROR, code: ErrorCode.WORKER_LOAD_FAILED, detail: String(error) });
}

/* 実行中の状態。1つの Worker は1回の録音を扱う。 */
let encoder = null;
let syncHandle = null;
let dirHandle = null;
let fileName = null;
let sampleRate = 44100;

let writePos = 0;
let remainder = new Int16Array(0); // 1152 に満たない端数
let encodedSamples = 0;
let bytesWritten = 0;
let secondsSinceFlush = 0;
let finished = false;

function post(type, extra) {
  self.postMessage({ type, ...extra });
}

/* Float32(-1..1) を Int16 へ。モノラル化は Worklet 側で済んでいる。 */
function floatToInt16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i += 1) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/* OPFS へ1チャンク書く。同期API。失敗は例外。 */
function writeChunk(bytes) {
  if (!bytes || bytes.length === 0) {
    return;
  }
  const written = syncHandle.write(bytes, { at: writePos });
  writePos += written;
  bytesWritten = writePos;
}

async function handleInit(message) {
  if (!lamejsReady) {
    post(MessageType.ERROR, { code: ErrorCode.WORKER_LOAD_FAILED });
    return;
  }

  sampleRate = message.sampleRate;
  fileName = message.fileName;

  try {
    encoder = new lamejs.Mp3Encoder(1, sampleRate, BITRATE_KBPS);
  } catch (error) {
    post(MessageType.ERROR, { code: ErrorCode.ENCODER_INIT_FAILED, detail: String(error) });
    return;
  }

  try {
    const root = await navigator.storage.getDirectory();
    dirHandle = await root.getDirectoryHandle(message.dirName, { create: true });
    const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
    syncHandle = await fileHandle.createSyncAccessHandle();
    /* 念のため空から始める。 */
    syncHandle.truncate(0);
    writePos = 0;
  } catch (error) {
    post(MessageType.ERROR, { code: ErrorCode.OPFS_OPEN_FAILED, detail: String(error) });
    return;
  }

  post(MessageType.READY, {});
}

function handlePcm(message) {
  if (finished || !encoder || !syncHandle) {
    return;
  }

  let int16;
  try {
    int16 = floatToInt16(message.pcm);
  } catch (error) {
    post(MessageType.ERROR, { code: ErrorCode.ENCODE_FAILED, detail: String(error) });
    return;
  }

  /* 端数と結合する。 */
  let samples;
  if (remainder.length > 0) {
    samples = new Int16Array(remainder.length + int16.length);
    samples.set(remainder, 0);
    samples.set(int16, remainder.length);
  } else {
    samples = int16;
  }

  const frameCount = Math.floor(samples.length / SAMPLES_PER_FRAME);
  const usable = frameCount * SAMPLES_PER_FRAME;

  try {
    for (let offset = 0; offset < usable; offset += SAMPLES_PER_FRAME) {
      const frame = samples.subarray(offset, offset + SAMPLES_PER_FRAME);
      const encoded = encoder.encodeBuffer(frame);
      if (encoded.length > 0) {
        writeChunk(encoded);
      }
    }
  } catch (error) {
    /* エンコード自体か OPFS 書き込みの失敗。呼び出し側の write は例外を投げる。 */
    const code = String(error).includes('write') ? ErrorCode.OPFS_WRITE_FAILED : ErrorCode.ENCODE_FAILED;
    post(MessageType.ERROR, { code, detail: String(error) });
    return;
  }

  /* 端数を保持（次回へ繰り越し）。独立配列にコピーして参照を切る。 */
  remainder = samples.slice(usable);

  encodedSamples += usable;
  const encodedSeconds = encodedSamples / sampleRate;

  /* 定期 flush（ディスク確定）。 */
  secondsSinceFlush += usable / sampleRate;
  if (secondsSinceFlush >= FLUSH_INTERVAL_SECONDS) {
    try {
      syncHandle.flush();
    } catch (error) {
      console.warn('[voice-recorder] OPFS flush に失敗', error);
    }
    secondsSinceFlush = 0;
  }

  post(MessageType.PROGRESS, { encodedSeconds, bytesWritten });
}

function handleStop() {
  if (finished || !encoder || !syncHandle) {
    return;
  }
  finished = true;

  try {
    /* 端数を最後のフレームとして投入（lamejs が内部で 1152 に満たない分を処理）。 */
    if (remainder.length > 0) {
      const encoded = encoder.encodeBuffer(remainder);
      if (encoded.length > 0) {
        writeChunk(encoded);
      }
      remainder = new Int16Array(0);
    }

    const tail = encoder.flush();
    if (tail.length > 0) {
      writeChunk(tail);
    }

    syncHandle.flush();
    const size = syncHandle.getSize();
    syncHandle.close();
    syncHandle = null;

    const durationSeconds = Math.round(encodedSamples / sampleRate);

    post(MessageType.FINALIZED, {
      fileName,
      bytesWritten: size,
      durationSeconds,
    });
  } catch (error) {
    post(MessageType.ERROR, { code: ErrorCode.FINALIZE_FAILED, detail: String(error) });
  } finally {
    /* 大きな参照を手放す。 */
    encoder = null;
    remainder = new Int16Array(0);
  }
}

async function handleAbort() {
  finished = true;
  try {
    if (syncHandle) {
      syncHandle.close();
      syncHandle = null;
    }
    if (dirHandle && fileName) {
      await dirHandle.removeEntry(fileName);
    }
  } catch (error) {
    console.warn('[voice-recorder] 中断時の一時ファイル削除に失敗', error);
  } finally {
    encoder = null;
    remainder = new Int16Array(0);
    post(MessageType.ABORTED, {});
  }
}

self.onmessage = (event) => {
  const message = event.data;
  if (!message || typeof message.type !== 'string') {
    return;
  }

  switch (message.type) {
    case 'init':
      handleInit(message);
      break;
    case 'pcm':
      handlePcm(message);
      break;
    case 'stop':
      handleStop();
      break;
    case 'abort':
      handleAbort();
      break;
    default:
      break;
  }
};

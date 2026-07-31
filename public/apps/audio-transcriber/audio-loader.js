/*
 * 音声ファイルの読み込み・検証・PCM化。
 *
 * DOM操作と画面文言はここに置かない（返すのはコードと数値だけ）。
 * 取得元（端末 / Drive）に関わらず、最終的にすべてこのファイルを通す。
 *
 * ------------------------------------------------------------------
 * 「対応形式」をどう判定するか
 * ------------------------------------------------------------------
 * 拡張子とMIMEは自己申告にすぎず、当てにならない。
 * かといって選択のたびに全体をPCMへ展開すると、長時間音声でメモリが尽きる。
 *
 * そこで2段階に分ける。
 *
 *   1. 選択時   … <audio> にBlob URLを読ませ、メタデータが取れるかで判定する。
 *                 これはブラウザが実際にコンテナとコーデックを解釈した結果なので、
 *                 拡張子の詐称では通らない。長さもここで得られる。
 *   2. 文字起こし時 … decodeAudioData で全体をPCMへ展開する。
 *                 ここで初めて完全なデコードが走る。
 *
 * 1で弾ければ、重い2に入る前に分かりやすいエラーを出せる。
 * ------------------------------------------------------------------
 */

import { AUDIO_EXTENSIONS, WHISPER } from './config.js';

export const AudioErrorCode = {
  NO_FILE: 'NO_FILE',
  UNSUPPORTED_TYPE: 'UNSUPPORTED_TYPE',
  DECODE_FAILED: 'DECODE_FAILED',
  EMPTY_AUDIO: 'EMPTY_AUDIO',
  TOO_LARGE: 'TOO_LARGE',
  TOO_LONG: 'TOO_LONG',
  OUT_OF_MEMORY: 'OUT_OF_MEMORY',
  CANCELLED: 'CANCELLED',
  UNKNOWN: 'UNKNOWN',
};

export class AudioError extends Error {
  constructor(code, detail = null) {
    super(code);
    this.name = 'AudioError';
    this.code = code;
    /* detail は原因の種別だけ。ファイルの中身は入れない。 */
    this.detail = detail;
  }
}

/* メタデータの読み込みを待つ上限。壊れたファイルで永久に待たないようにする。 */
const METADATA_TIMEOUT_MS = 20000;

/* ---------- 事前判定（拡張子・MIME） ---------- */

export function getExtension(fileName) {
  const match = /\.[^.]+$/.exec(String(fileName ?? ''));
  return match ? match[0].toLowerCase() : '';
}

/*
 * 明らかに音声ではないものを、読み込む前に落とす。
 * ここで true になっても「対応している」とは限らない。最終判定は probeAudio。
 */
export function looksLikeAudio(file) {
  if (!file) {
    return false;
  }

  const type = String(file.type ?? '').toLowerCase();

  if (type.startsWith('audio/')) {
    return true;
  }

  /*
   * 音声を含む動画コンテナ（.webm / .m4a を video/ として渡す環境がある）や、
   * MIMEが空のまま渡される環境があるため、拡張子でも救う。
   */
  if (AUDIO_EXTENSIONS.includes(getExtension(file.name))) {
    return true;
  }

  /* MIMEが空で拡張子も未知なら、判定材料が無いので通す（probeAudio が判断する）。 */
  return type === '';
}

/* ---------- メタデータの取得（選択時の検証を兼ねる） ---------- */

/*
 * Blob を <audio> に読ませ、長さを得る。
 *
 * 戻り値: { durationSec, objectUrl }
 * objectUrl は呼び出し側がプレーヤーへそのまま使い、
 * 不要になった時点で URL.revokeObjectURL する責任を負う。
 *
 * 読み込めなければ AudioError(UNSUPPORTED_TYPE) を投げ、URLは解放する。
 */
export function probeAudio(blob) {
  return new Promise((resolve, reject) => {
    if (!blob || blob.size === 0) {
      reject(new AudioError(AudioErrorCode.NO_FILE, 'empty_blob'));
      return;
    }

    const objectUrl = URL.createObjectURL(blob);
    const audio = new Audio();
    let settled = false;

    const cleanupListeners = () => {
      audio.removeEventListener('loadedmetadata', onLoaded);
      audio.removeEventListener('error', onError);
      window.clearTimeout(timer);
    };

    const fail = (code, detail) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanupListeners();
      /* 失敗したURLは誰も使わないので、ここで解放する。 */
      URL.revokeObjectURL(objectUrl);
      audio.src = '';
      reject(new AudioError(code, detail));
    };

    function onLoaded() {
      if (settled) {
        return;
      }

      const duration = Number(audio.duration);

      /*
       * ストリーミング用のWebMなどは duration が Infinity になることがある。
       * 長さが分からないだけで再生も文字起こしもできるため、null にして続行する。
       */
      const durationSec = Number.isFinite(duration) && duration > 0 ? duration : null;

      settled = true;
      cleanupListeners();
      resolve({ durationSec, objectUrl });
    }

    function onError() {
      fail(AudioErrorCode.UNSUPPORTED_TYPE, 'media_error');
    }

    const timer = window.setTimeout(() => {
      fail(AudioErrorCode.UNSUPPORTED_TYPE, 'metadata_timeout');
    }, METADATA_TIMEOUT_MS);

    audio.addEventListener('loadedmetadata', onLoaded);
    audio.addEventListener('error', onError);
    audio.preload = 'metadata';
    audio.src = objectUrl;
  });
}

/* ---------- PCM化（文字起こし直前） ---------- */

function createOfflineContext(sampleRate) {
  const Ctor = globalThis.OfflineAudioContext ?? globalThis.webkitOfflineAudioContext;

  if (typeof Ctor !== 'function') {
    throw new AudioError(AudioErrorCode.DECODE_FAILED, 'offline_context_unavailable');
  }

  /*
   * length は decodeAudioData には影響しない（デコード結果の長さが優先される）。
   * 1 を渡してコンテキスト自体のメモリ確保を最小にする。
   */
  return new Ctor(1, 1, sampleRate);
}

/*
 * 複数チャンネルを1本へ平均する。
 * Whisper はモノラルしか受け取らないため、ここで必ず1本にする。
 */
function mixToMono(audioBuffer) {
  const channelCount = audioBuffer.numberOfChannels;

  if (channelCount === 1) {
    /* コピーせず参照を返す。呼び出し側は書き換えない。 */
    return audioBuffer.getChannelData(0);
  }

  const length = audioBuffer.length;
  const mono = new Float32Array(length);

  for (let channel = 0; channel < channelCount; channel += 1) {
    const data = audioBuffer.getChannelData(channel);

    for (let i = 0; i < length; i += 1) {
      mono[i] += data[i];
    }
  }

  for (let i = 0; i < length; i += 1) {
    mono[i] /= channelCount;
  }

  return mono;
}

/*
 * Blob を 16kHz モノラルの Float32Array へ変換する。
 *
 * decodeAudioData は「コンテキストのサンプリングレートへ」リサンプルして返す。
 * したがって 16kHz の OfflineAudioContext で復号すれば、
 * 自前でリサンプル処理を書く必要はない（品質もブラウザ実装に任せられる）。
 *
 * 戻り値: { pcm: Float32Array, sampleRate: 16000, durationSec }
 */
export async function decodeToPcm(blob, { signal } = {}) {
  if (!blob || blob.size === 0) {
    throw new AudioError(AudioErrorCode.NO_FILE, 'empty_blob');
  }

  if (signal?.aborted) {
    throw new AudioError(AudioErrorCode.CANCELLED, 'aborted');
  }

  let arrayBuffer;

  try {
    arrayBuffer = await blob.arrayBuffer();
  } catch (error) {
    /* 巨大ファイルを ArrayBuffer に載せられなかった場合はここに来る。 */
    throw new AudioError(AudioErrorCode.OUT_OF_MEMORY, error?.name ?? 'array_buffer_failed');
  }

  if (signal?.aborted) {
    throw new AudioError(AudioErrorCode.CANCELLED, 'aborted');
  }

  const context = createOfflineContext(WHISPER.sampleRate);
  let audioBuffer;

  try {
    audioBuffer = await context.decodeAudioData(arrayBuffer);
  } catch (error) {
    /*
     * ここで失敗するのは、<audio> は再生できたが Web Audio が解釈できない形式
     * （一部の環境の m4a など）。利用者には「デコードできない」と伝える。
     */
    throw new AudioError(AudioErrorCode.DECODE_FAILED, error?.name ?? 'decode_failed');
  }

  if (!audioBuffer || audioBuffer.length === 0) {
    throw new AudioError(AudioErrorCode.EMPTY_AUDIO, 'zero_length');
  }

  const pcm = mixToMono(audioBuffer);

  return {
    pcm,
    sampleRate: WHISPER.sampleRate,
    durationSec: audioBuffer.duration,
  };
}

/* ---------- 分割 ---------- */

/*
 * 長い PCM を一定時間ごとに区切る。
 *
 * subarray はコピーを作らない（元の Float32Array のビュー）。
 * ただし Worker へ postMessage するときに構造化複製でコピーされるため、
 * 「同時にメモリへ載る量」は1区間ぶんに抑えられる。
 *
 * 戻り値: [{ pcm, startSec, endSec }]
 */
export function splitPcm(pcm, sampleRate, segmentSeconds) {
  const total = pcm.length;
  const segmentLength = Math.max(1, Math.floor(segmentSeconds * sampleRate));

  if (total <= segmentLength) {
    return [{ pcm, startSec: 0, endSec: total / sampleRate }];
  }

  const segments = [];

  for (let offset = 0; offset < total; offset += segmentLength) {
    const end = Math.min(offset + segmentLength, total);

    segments.push({
      pcm: pcm.subarray(offset, end),
      startSec: offset / sampleRate,
      endSec: end / sampleRate,
    });
  }

  return segments;
}

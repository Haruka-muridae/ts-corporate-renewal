/*
 * Capacitor NativeRecorder への薄い接続。
 *
 * @capacitor/core を import しない。PC ブラウザでは Capacitor が無く、
 * isNativeRecorderAvailable() は必ず false。既存 Recorder 経路を使う。
 * 録音処理そのものは持たない。
 */

import { buildRecordingFileName } from './filename.js';
import {
  LOCAL_KEPT_DRIVE_FAILED,
  NATIVE_AUDIO_EXTENSION,
  NATIVE_AUDIO_MIME,
  createRecordingId,
} from './recording-checkpoint.js';

export { LOCAL_KEPT_DRIVE_FAILED, NATIVE_AUDIO_EXTENSION, NATIVE_AUDIO_MIME };

export function getNativeRecorderPlugin(target = globalThis) {
  const cap = target?.Capacitor;
  if (!cap) {
    return null;
  }

  const existing = cap.Plugins?.NativeRecorder;
  if (existing && typeof existing.start === 'function') {
    return existing;
  }

  if (typeof cap.registerPlugin !== 'function') {
    return null;
  }

  const registered = cap.registerPlugin('NativeRecorder');
  if (!registered || typeof registered.start !== 'function') {
    return null;
  }

  return registered;
}

export function isNativeRecorderAvailable(target = globalThis) {
  return target?.Capacitor?.isNativePlatform?.() === true
    && getNativeRecorderPlugin(target) !== null;
}

export function isNativePlatform(target = globalThis) {
  return target?.Capacitor?.isNativePlatform?.() === true;
}

export async function startNativeRecording(meta = {}, target = globalThis) {
  const plugin = getNativeRecorderPlugin(target);
  if (!plugin) {
    const error = new Error('native_recorder_unavailable');
    error.code = 'NATIVE_RECORDER_UNAVAILABLE';
    throw error;
  }

  const recordingId = meta.recordingId || createRecordingId();
  const fileName = meta.fileName || buildRecordingFileName({
    method: 'offline',
    organization: meta.organization,
    personName: meta.personName,
    kind: meta.kind,
    date: meta.date ?? new Date(),
    extension: NATIVE_AUDIO_EXTENSION,
  });

  return plugin.start({
    recordingId,
    fileName,
    organization: meta.organization ?? '',
    personName: meta.personName ?? '',
    kind: meta.kind ?? '',
  });
}

export async function stopNativeRecording(target = globalThis) {
  const plugin = getNativeRecorderPlugin(target);
  if (!plugin?.stop) {
    const error = new Error('native_recorder_unavailable');
    error.code = 'NATIVE_RECORDER_UNAVAILABLE';
    throw error;
  }

  return plugin.stop();
}

export async function getNativeStatus(target = globalThis) {
  const plugin = getNativeRecorderPlugin(target);
  if (!plugin?.getStatus) {
    return { state: 'IDLE', elapsedSeconds: 0, recording: false };
  }

  return plugin.getStatus();
}

export async function listPendingNativeRecordings(target = globalThis) {
  const plugin = getNativeRecorderPlugin(target);
  if (!plugin?.listPending) {
    return [];
  }

  const result = await plugin.listPending();
  return Array.isArray(result?.items) ? result.items : Array.isArray(result) ? result : [];
}

export async function readNativeChunk(path, offset, size, target = globalThis) {
  const plugin = getNativeRecorderPlugin(target);
  if (!plugin?.readChunk) {
    const error = new Error('native_recorder_unavailable');
    error.code = 'NATIVE_RECORDER_UNAVAILABLE';
    throw error;
  }

  const result = await plugin.readChunk({ path, offset, size });
  return decodeBase64ToBuffer(result?.data ?? '');
}

export async function markNativeUploaded(recordingId, { driveFileId, driveUrl } = {}, target = globalThis) {
  const plugin = getNativeRecorderPlugin(target);
  if (!plugin?.markUploaded) {
    return;
  }

  return plugin.markUploaded({ recordingId, driveFileId: driveFileId ?? '', driveUrl: driveUrl ?? '' });
}

export async function markNativeUploadFailed(recordingId, error = '', target = globalThis) {
  const plugin = getNativeRecorderPlugin(target);
  if (!plugin?.markUploadFailed) {
    return;
  }

  return plugin.markUploadFailed({ recordingId, error: String(error || '') });
}

export function decodeBase64ToBuffer(base64) {
  const source = String(base64 || '');
  if (source === '') {
    return new ArrayBuffer(0);
  }

  const binary = globalThis.atob(source);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes.buffer;
}

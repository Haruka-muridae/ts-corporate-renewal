/*
 * ネイティブ録音の Checkpoint。DOM / Capacitor / Drive を知らない。
 * 録音ファイルとは別に状態を永続化する（要件 §12 / §15）。
 */

export const RecordingState = Object.freeze({
  IDLE: 'IDLE',
  RECORDING: 'RECORDING',
  INTERRUPTED: 'INTERRUPTED',
  STOPPING: 'STOPPING',
  SAVED_LOCAL: 'SAVED_LOCAL',
  UPLOADING: 'UPLOADING',
  UPLOADED: 'UPLOADED',
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  /*
   * Drive 保存後の議事録処理（Gemini → Markdown → Potenitas record）。
   * ブラウザ録音だけが使う。処理が終わるまで端末の録音（OPFS）は消さない。
   * 完了は行の削除で表す（COMPLETED 状態は持たない）。
   */
  PROCESSING: 'PROCESSING',
  PROCESS_FAILED: 'PROCESS_FAILED',
});

export const DriveUploadState = Object.freeze({
  NONE: 'none',
  PENDING: 'pending',
  UPLOADING: 'uploading',
  UPLOADED: 'uploaded',
  FAILED: 'failed',
});

export const NATIVE_AUDIO_EXTENSION = '.m4a';
export const NATIVE_AUDIO_MIME = 'audio/mp4';

export function createRecordingId(now = Date.now(), random = Math.random) {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return `rec-${now}-${random().toString(16).slice(2, 10)}`;
}

export function createCheckpoint({
  recordingId,
  startedAt,
  state = RecordingState.RECORDING,
  localPath = '',
  fileName = '',
  organization = '',
  personName = '',
  kind = '',
  lastCheckpointAt,
  driveUploadState = DriveUploadState.NONE,
  sizeBytes = 0,
  durationSeconds = 0,
  driveFileId = '',
  driveUrl = '',
  error = '',
} = {}) {
  const started = startedAt || new Date().toISOString();

  return {
    recordingId: String(recordingId || ''),
    startedAt: started,
    state,
    localPath: String(localPath || ''),
    fileName: String(fileName || ''),
    organization: String(organization || ''),
    personName: String(personName || ''),
    kind: String(kind || ''),
    lastCheckpointAt: lastCheckpointAt || started,
    driveUploadState,
    sizeBytes: Number(sizeBytes) || 0,
    durationSeconds: Number(durationSeconds) || 0,
    driveFileId: String(driveFileId || ''),
    driveUrl: String(driveUrl || ''),
    error: String(error || ''),
  };
}

export function elapsedSecondsFrom(startedAt, now = Date.now()) {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) {
    return 0;
  }

  return Math.max(0, Math.floor((now - started) / 1000));
}

export function isIncompleteRecording(checkpoint) {
  const state = checkpoint?.state;
  return state === RecordingState.RECORDING
    || state === RecordingState.INTERRUPTED
    || state === RecordingState.STOPPING;
}

export function isPendingUpload(checkpoint) {
  const state = checkpoint?.state;
  return state === RecordingState.SAVED_LOCAL
    || state === RecordingState.UPLOADING
    || state === RecordingState.UPLOAD_FAILED;
}

/*
 * Drive には保存済みだが、議事録の処理が終わっていない行。
 * Drive へは二度と送らず、議事録の処理だけをやり直す。
 */
export function isPendingProcessing(checkpoint) {
  const state = checkpoint?.state;
  return state === RecordingState.UPLOADED
    || state === RecordingState.PROCESSING
    || state === RecordingState.PROCESS_FAILED;
}

export function isDriveSaved(checkpoint) {
  return isPendingProcessing(checkpoint) && String(checkpoint?.driveFileId || '') !== '';
}

export function shouldOfferRetry(checkpoint) {
  return isPendingUpload(checkpoint) || isIncompleteRecording(checkpoint);
}

export function applyLocalSaved(checkpoint, { localPath, sizeBytes, durationSeconds, lastCheckpointAt } = {}) {
  return {
    ...checkpoint,
    state: RecordingState.SAVED_LOCAL,
    driveUploadState: DriveUploadState.PENDING,
    localPath: localPath ?? checkpoint.localPath,
    sizeBytes: sizeBytes ?? checkpoint.sizeBytes,
    durationSeconds: durationSeconds ?? checkpoint.durationSeconds,
    lastCheckpointAt: lastCheckpointAt || new Date().toISOString(),
    error: '',
  };
}

export function applyUploadFailure(checkpoint, error = '') {
  return {
    ...checkpoint,
    state: RecordingState.UPLOAD_FAILED,
    driveUploadState: DriveUploadState.FAILED,
    lastCheckpointAt: new Date().toISOString(),
    error: String(error || ''),
  };
}

export function applyUploaded(checkpoint, { driveFileId, driveUrl, lastCheckpointAt } = {}) {
  return {
    ...checkpoint,
    state: RecordingState.UPLOADED,
    driveUploadState: DriveUploadState.UPLOADED,
    driveFileId: driveFileId ?? checkpoint.driveFileId,
    driveUrl: driveUrl ?? checkpoint.driveUrl,
    lastCheckpointAt: lastCheckpointAt || new Date().toISOString(),
    error: '',
  };
}

export function applyProcessing(checkpoint, { lastCheckpointAt } = {}) {
  return {
    ...checkpoint,
    state: RecordingState.PROCESSING,
    lastCheckpointAt: lastCheckpointAt || new Date().toISOString(),
    error: '',
  };
}

export function applyProcessFailure(checkpoint, error = '') {
  return {
    ...checkpoint,
    state: RecordingState.PROCESS_FAILED,
    lastCheckpointAt: new Date().toISOString(),
    error: String(error || ''),
  };
}

export const LOCAL_KEPT_DRIVE_FAILED =
  '録音は端末に保存されています。Driveへのアップロードに失敗しました。';

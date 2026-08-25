/*
 * 未完了録音（未アップロード / 議事録未作成）の表示用。Drive やネイティブ I/O は持たない。
 */

import {
  DriveUploadState,
  RecordingState,
  isIncompleteRecording,
  isPendingProcessing,
  shouldOfferRetry,
} from './recording-checkpoint.js';

/* Drive 保存後の議事録処理はブラウザ録音だけが持つ。ネイティブ行には出さない。 */
function isBrowserProcessing(checkpoint) {
  return checkpoint?.source === 'browser' && isPendingProcessing(checkpoint);
}

export function pendingHeading() {
  return '処理が終わっていない録音があります';
}

export function retryButtonLabel() {
  return 'Driveへ再送';
}

export function processButtonLabel() {
  return '議事録を作成';
}

/*
 * まだ一度も送っていない録音は「保存」、失敗後は「再送」、
 * Drive 保存済みで議事録が未完了なら「議事録を作成」と呼び分ける。
 */
export function saveButtonLabel(checkpoint) {
  if (isBrowserProcessing(checkpoint)) {
    return processButtonLabel();
  }

  return checkpoint?.driveUploadState === DriveUploadState.FAILED
    ? retryButtonLabel()
    : 'Driveへ保存';
}

/* 行の補足。未確定（録音中にページが落ちた）行はその旨を出す。 */
export function pendingStateNote(checkpoint) {
  if (isIncompleteRecording(checkpoint)) {
    return '録音が途中で終わっています（停止まで保存された分だけ残っています）';
  }

  if (checkpoint?.driveUploadState === DriveUploadState.FAILED) {
    return '前回の保存に失敗';
  }

  if (isBrowserProcessing(checkpoint)) {
    if (checkpoint.state === RecordingState.PROCESS_FAILED) {
      return '音声は Drive に保存済み。前回の議事録作成に失敗';
    }

    if (checkpoint.state === RecordingState.PROCESSING) {
      return '音声は Drive に保存済み。議事録の作成が途中で終わっています';
    }

    return '音声は Drive に保存済み。議事録は未作成';
  }

  return '';
}

export function discardButtonLabel() {
  return '破棄';
}

export function discardConfirmText(checkpoint) {
  if (isBrowserProcessing(checkpoint)) {
    return `「${formatPendingTitle(checkpoint)}」を端末から削除しますか？ 音声は Drive に保存済みです（議事録は作成されません）。`;
  }

  return `「${formatPendingTitle(checkpoint)}」を端末から削除しますか？ Drive には保存されていません。`;
}

export function formatPendingTitle(checkpoint) {
  const name = String(checkpoint?.fileName || '').trim();
  if (name !== '') {
    return name;
  }

  return '録音ファイル';
}

export function visiblePendingRecordings(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => shouldOfferRetry(item) || isBrowserProcessing(item));
}

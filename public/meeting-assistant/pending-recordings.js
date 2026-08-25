/*
 * 未アップロード / 未完了録音の表示用。Drive やネイティブ I/O は持たない。
 */

import { DriveUploadState, isIncompleteRecording, shouldOfferRetry } from './recording-checkpoint.js';

export function pendingHeading() {
  return '未アップロードの録音があります';
}

export function retryButtonLabel() {
  return 'Driveへ再送';
}

/* まだ一度も送っていない録音は「保存」、失敗後は「再送」と呼び分ける。 */
export function saveButtonLabel(checkpoint) {
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

  return '';
}

export function discardButtonLabel() {
  return '破棄';
}

export function discardConfirmText(checkpoint) {
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
  return (Array.isArray(items) ? items : []).filter(shouldOfferRetry);
}

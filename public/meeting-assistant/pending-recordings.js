/*
 * 未アップロード / 未完了録音の表示用。Drive やネイティブ I/O は持たない。
 */

import { DriveUploadState, shouldOfferRetry } from './recording-checkpoint.js';

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

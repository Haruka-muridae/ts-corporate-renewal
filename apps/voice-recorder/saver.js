/*
 * 保存層。
 * ファイル名の生成と、保存先への書き出しのみを担当する。
 * DOM操作、録音、MP3変換は行わない。
 *
 * 保存先は SAVE_TARGETS に追加していく設計にしている。
 * Google Drive 保存を追加する場合は、このファイルに関数を1つ足し、
 * SAVE_TARGETS へ登録するだけでよい（UI層はこの一覧を読んでボタンを並べる）。
 */

function pad2(value) {
  return String(value).padStart(2, '0');
}

/*
 * recording-YYYYMMDD-HHmmss.<拡張子>
 * 日本時間へ固定せず、利用者のブラウザのローカル時刻を使う。
 */
export function buildFileName(extension, date = new Date()) {
  const stamp = [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join('') + '-' + [
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    pad2(date.getSeconds()),
  ].join('');

  return `recording-${stamp}.${extension}`;
}

/*
 * MIMEタイプから拡張子を決める。
 * 録音形式は実行環境によって変わるため、固定値を前提にしない。
 */
export function extensionForMimeType(mimeType) {
  if (!mimeType) {
    return 'bin';
  }

  const base = mimeType.split(';')[0].trim().toLowerCase();

  switch (base) {
    case 'audio/webm':
      return 'webm';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/mp4':
      return 'm4a';
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/wav':
      return 'wav';
    default:
      return 'bin';
  }
}

/* 端末へ保存する。オブジェクトURLは必ず解放する。 */
export function saveToDevice(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();

  /*
   * 即座に解放するとダウンロードが始まらない環境があるため、
   * 次のタスクまで待ってから解放する。
   */
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/*
 * 保存先の一覧。
 * id       … 内部識別子
 * label    … ボタン文言
 * note     … 補足説明（プライバシー説明の切り替えにも使う）
 * external … 音声が端末外へ送信されるか。true の保存先を追加する場合は
 *            同意UIとプライバシー説明の見直しが必須。
 * save     … 実処理。未実装の保存先は null。
 */
export const SAVE_TARGETS = [
  {
    id: 'device',
    label: '端末に保存',
    note: '音声は端末内に保存されます。',
    external: false,
    save: saveToDevice,
  },
  /*
   * 将来の追加予定。実装時にコメントを外す。
   * Google Identity Services によるクライアントサイドOAuthを使い、
   * スコープは drive.file（アプリが作成したファイルのみ）に限定する。
   * external: true のため、プライバシー説明の文言を保存先に応じて
   * 切り替える必要がある。
   *
   * {
   *   id: 'google-drive',
   *   label: 'Google Drive に保存',
   *   note: '音声が Google Drive へ送信されます。',
   *   external: true,
   *   save: saveToGoogleDrive,
   * },
   */
];

export function getSaveTarget(id) {
  return SAVE_TARGETS.find((target) => target.id === id) ?? null;
}

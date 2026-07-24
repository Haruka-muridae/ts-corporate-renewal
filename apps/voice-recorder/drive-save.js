/*
 * 「Google Driveへ保存」のUI層。
 * 認可は drive-auth.js、API呼び出しは drive-client.js が担当する。
 * このファイルは状態遷移・文言・DOM更新だけを持つ。
 *
 * 表示は必ず textContent で行う。
 * ファイル名やエラー文はDrive由来の値を含むため、innerHTML へは渡さない。
 *
 * 起動時にはDrive権限を要求しない。ボタンを押した時だけ認可を開始する。
 */

import {
  DriveAuthError,
  DriveAuthErrorCode,
  clearAccessToken,
  ensureAccessToken,
  getSignedInProfile,
} from './drive-auth.js';

import {
  DriveError,
  DriveErrorCode,
  buildDriveFileName,
  saveMp3ToDrive,
} from './drive-client.js';

/* 保存UIの状態。分岐はこの7つに限定する。 */
export const DriveSaveStatus = Object.freeze({
  IDLE: 'idle',                 // 未保存
  SIGNED_OUT: 'signed-out',     // Googleにログインしていない
  CONNECTING: 'connecting',     // Google Driveに接続しています
  UPLOADING: 'uploading',       // 保存中
  SAVED: 'saved',               // 保存完了
  FAILED: 'failed',             // 保存失敗
  REAUTH: 'reauth',             // 再認証が必要です
});

const STATUS_LABELS = Object.freeze({
  [DriveSaveStatus.IDLE]: '未保存',
  [DriveSaveStatus.SIGNED_OUT]: 'Googleにログインしていません',
  [DriveSaveStatus.CONNECTING]: 'Google Driveに接続しています',
  [DriveSaveStatus.UPLOADING]: '保存中',
  [DriveSaveStatus.SAVED]: '保存完了',
  [DriveSaveStatus.FAILED]: '保存失敗',
  [DriveSaveStatus.REAUTH]: '再認証が必要です',
});

/* 認可段階のエラー文言。内部エラー名は出さない。 */
export const AUTH_ERROR_MESSAGES = Object.freeze({
  [DriveAuthErrorCode.CLIENT_ID_MISSING]:
    'Google Drive保存は現在準備中です。設定が完了するまでお待ちください。',
  [DriveAuthErrorCode.NOT_SIGNED_IN]:
    'Google Driveへ保存するには、Googleへのログインが必要です。',
  [DriveAuthErrorCode.GIS_LOAD_FAILED]:
    'Googleの認証機能を読み込めませんでした。通信環境をご確認のうえ、ページを再読み込みしてお試しください。',
  [DriveAuthErrorCode.POPUP_CLOSED]:
    '認証画面が閉じられたため、保存を中止しました。もう一度お試しください。',
  [DriveAuthErrorCode.POPUP_BLOCKED]:
    '認証画面を開けませんでした。ブラウザのポップアップブロックを解除してお試しください。',
  [DriveAuthErrorCode.ACCESS_DENIED]:
    'Google Driveへのアクセスが許可されませんでした。保存するには権限の許可が必要です。',
  [DriveAuthErrorCode.SCOPE_NOT_GRANTED]:
    'Google Driveへの保存権限が許可されませんでした。権限の確認画面で「許可」を選んでください。',
  [DriveAuthErrorCode.UNKNOWN]:
    'Googleの認証に失敗しました。しばらく時間をおいてお試しください。',
});

/* API段階のエラー文言。 */
export const API_ERROR_MESSAGES = Object.freeze({
  [DriveErrorCode.UNAUTHORIZED]:
    '認証の有効期限が切れました。もう一度「Google Driveへ保存」を押して認証してください。',
  [DriveErrorCode.FORBIDDEN]:
    'Google Driveへの保存が許可されませんでした。アカウントの権限設定をご確認ください。',
  [DriveErrorCode.API_DISABLED]:
    'Google Drive APIが有効になっていません。管理者にGoogle Cloud側の設定をご確認ください。',
  [DriveErrorCode.QUOTA_EXCEEDED]:
    'Google Driveの保存容量が不足しています。空き容量を確保してからお試しください。',
  [DriveErrorCode.RATE_LIMITED]:
    'アクセスが集中しています。しばらく時間をおいてからお試しください。',
  [DriveErrorCode.NOT_FOUND]:
    '保存先のフォルダが見つかりませんでした。もう一度お試しください。',
  [DriveErrorCode.NETWORK]:
    '通信に失敗しました。ネットワーク接続をご確認のうえ、もう一度お試しください。',
  [DriveErrorCode.SERVER_ERROR]:
    'Google側で問題が発生しています。しばらく時間をおいてからお試しください。',
  [DriveErrorCode.UNKNOWN]:
    '保存に失敗しました。もう一度お試しください。',
});

export const FALLBACK_ERROR_MESSAGE = '保存に失敗しました。もう一度お試しください。';

/*
 * エラーを利用者向け日本語へ変換する。
 * 未知の例外でも必ず文言を返し、画面が無反応にならないようにする。
 */
export function toUserMessage(error) {
  if (error instanceof DriveAuthError) {
    return AUTH_ERROR_MESSAGES[error.code] ?? AUTH_ERROR_MESSAGES[DriveAuthErrorCode.UNKNOWN];
  }

  if (error instanceof DriveError) {
    return API_ERROR_MESSAGES[error.code] ?? API_ERROR_MESSAGES[DriveErrorCode.UNKNOWN];
  }

  return FALLBACK_ERROR_MESSAGE;
}

/* エラーから遷移先の状態を決める。 */
export function toStatus(error) {
  if (error instanceof DriveAuthError) {
    if (error.code === DriveAuthErrorCode.NOT_SIGNED_IN) {
      return DriveSaveStatus.SIGNED_OUT;
    }

    return DriveSaveStatus.FAILED;
  }

  if (error instanceof DriveError && error.code === DriveErrorCode.UNAUTHORIZED) {
    return DriveSaveStatus.REAUTH;
  }

  return DriveSaveStatus.FAILED;
}

/* ---------- DOM ---------- */

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);

  if (className) {
    element.className = className;
  }

  if (text !== undefined) {
    element.textContent = text;
  }

  return element;
}

/*
 * 保存パネルを組み立てて container へ差し込む。
 *
 * options:
 *   getRecording() … { blob, startedAt } を返す。未生成なら null。
 *   onDeveloperError(scope, error) … 開発者向けログ（任意）
 *
 * 戻り値: { reset() } 録音をやり直したときに呼ぶ。
 */
export function mountDriveSave(container, { getRecording, onDeveloperError } = {}) {
  if (!container) {
    return { reset() {} };
  }

  const panel = createElement('div', 'vr-drive');
  panel.dataset.driveStatus = DriveSaveStatus.IDLE;

  const statusLine = createElement('p', 'vr-drive__status');
  statusLine.setAttribute('role', 'status');
  statusLine.setAttribute('aria-live', 'polite');
  statusLine.textContent = STATUS_LABELS[DriveSaveStatus.IDLE];

  const actions = createElement('div', 'vr-drive__actions');
  const button = createElement('button', 'btn btn--primary vr-drive__button', 'Google Driveへ保存');
  button.type = 'button';
  actions.append(button);

  /* 未ログイン時だけ出す /apps/ への導線。自動遷移はしない。 */
  const signInLink = createElement('a', 'vr-drive__signin', 'AIアプリ一覧でログインする');
  signInLink.href = '../index.html';
  signInLink.hidden = true;
  actions.append(signInLink);

  const message = createElement('p', 'vr-drive__message');
  message.hidden = true;

  const result = createElement('p', 'vr-drive__result');
  result.hidden = true;
  const resultName = createElement('span', 'vr-drive__file');
  const resultLink = createElement('a', 'vr-drive__link', 'Google Driveで開く');
  resultLink.target = '_blank';
  resultLink.rel = 'noopener noreferrer';
  resultLink.hidden = true;
  result.append(resultName, resultLink);

  const note = createElement(
    'p',
    'vr-drive__note',
    'マイドライブの「TSAM AI」＞「Voice Recorder」へ保存します。このアプリが保存したファイル以外は読み取りません。',
  );

  panel.append(statusLine, actions, message, result, note);
  container.append(panel);

  /* ---------- 状態 ---------- */

  let status = DriveSaveStatus.IDLE;
  let busy = false;
  let savedOnce = false;

  function render() {
    panel.dataset.driveStatus = status;
    statusLine.textContent = STATUS_LABELS[status] ?? STATUS_LABELS[DriveSaveStatus.IDLE];

    /* 保存中・接続中は押せないようにして二重送信を防ぐ。 */
    button.disabled = busy;
    signInLink.hidden = status !== DriveSaveStatus.SIGNED_OUT;

    if (status === DriveSaveStatus.REAUTH) {
      button.textContent = '再認証して保存';
    } else if (savedOnce && status === DriveSaveStatus.SAVED) {
      /* 同じ録音の再保存は、別ファイルが作られることが分かる文言にする。 */
      button.textContent = 'もう一度Google Driveへ保存';
    } else {
      button.textContent = 'Google Driveへ保存';
    }
  }

  function showMessage(text, isError) {
    if (!text) {
      message.hidden = true;
      message.removeAttribute('role');
      message.textContent = '';
      return;
    }

    message.textContent = text;

    if (isError) {
      message.setAttribute('role', 'alert');
    } else {
      message.removeAttribute('role');
    }

    message.hidden = false;
  }

  function showResult(file) {
    if (!file) {
      result.hidden = true;
      resultLink.hidden = true;
      resultName.textContent = '';
      return;
    }

    /* Drive由来の値。必ず textContent で入れる。 */
    resultName.textContent = `保存したファイル: ${file.name}`;

    if (file.webViewLink) {
      resultLink.href = file.webViewLink;
      resultLink.hidden = false;
    } else {
      resultLink.removeAttribute('href');
      resultLink.hidden = true;
    }

    result.hidden = false;
  }

  function setStatus(next) {
    status = next;
    render();
  }

  /* ---------- 保存処理 ---------- */

  async function runSave({ forceConsent }) {
    const recording = typeof getRecording === 'function' ? getRecording() : null;

    if (!recording?.blob) {
      showMessage('保存できるMP3がありません。先に録音とMP3変換を行ってください。', false);
      return;
    }

    busy = true;
    showMessage('', false);
    showResult(null);
    setStatus(DriveSaveStatus.CONNECTING);

    let token;

    try {
      token = await ensureAccessToken({ forceConsent });
    } catch (error) {
      onDeveloperError?.('drive-auth', error);
      busy = false;
      setStatus(toStatus(error));
      showMessage(toUserMessage(error), true);
      return;
    }

    setStatus(DriveSaveStatus.UPLOADING);

    /*
     * 録音開始日時があればそれを使う。無ければ保存時刻。
     * 同じ録音を2回保存した場合、ファイル名は同じでもDrive側では
     * 別ファイルとして作成される（Driveは同名ファイルを許容する）。
     */
    const fileName = buildDriveFileName(recording.startedAt ?? new Date());

    try {
      const file = await saveMp3ToDrive({ token, blob: recording.blob, fileName });

      busy = false;
      savedOnce = true;
      setStatus(DriveSaveStatus.SAVED);
      showResult(file);
      showMessage('', false);
      return;
    } catch (error) {
      onDeveloperError?.('drive-upload', error);

      /* 401 は保持中のトークンを捨て、次回の押下で再認可できるようにする。 */
      if (error instanceof DriveError && error.code === DriveErrorCode.UNAUTHORIZED) {
        clearAccessToken();
      }

      busy = false;
      setStatus(toStatus(error));
      showMessage(toUserMessage(error), true);
    }
  }

  button.addEventListener('click', () => {
    /* 進行中は何もしない（disabled と合わせた二重防御）。 */
    if (busy) {
      return;
    }

    /* 期限切れ後は必ず同意画面を出して再認可する。 */
    runSave({ forceConsent: status === DriveSaveStatus.REAUTH });
  });

  /* 起動時にログイン状態だけ確認する。権限要求は行わない。 */
  if (!getSignedInProfile()) {
    setStatus(DriveSaveStatus.SIGNED_OUT);
    showMessage(AUTH_ERROR_MESSAGES[DriveAuthErrorCode.NOT_SIGNED_IN], false);
  } else {
    render();
  }

  return {
    /* 新しい録音を始めたときに、前回の保存結果を消す。 */
    reset() {
      busy = false;
      savedOnce = false;
      showResult(null);
      showMessage('', false);
      setStatus(getSignedInProfile() ? DriveSaveStatus.IDLE : DriveSaveStatus.SIGNED_OUT);

      if (status === DriveSaveStatus.SIGNED_OUT) {
        showMessage(AUTH_ERROR_MESSAGES[DriveAuthErrorCode.NOT_SIGNED_IN], false);
      }
    },
  };
}

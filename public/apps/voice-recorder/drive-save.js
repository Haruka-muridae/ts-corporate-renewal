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
  hasValidAccessToken,
} from './drive-auth.js';

import {
  DriveError,
  DriveErrorCode,
  buildDriveFileName,
  saveMp3ToDrive,
} from './drive-client.js';

import { debugLog, describeBlob } from './debug-log.js';

/*
 * 保存UIの状態。分岐はこの6つに限定する。
 * Drive保存は /apps/ のログイン表示に依存しないため、
 * 「未ログインだから押せない」という状態は持たない。
 * 認証はボタン押下時に保存操作の一部として行い、成功すれば自動で保存へ進む。
 */
export const DriveSaveStatus = Object.freeze({
  IDLE: 'idle',                 // 未保存
  CONNECTING: 'connecting',     // Google Driveに接続しています（認証中）
  UPLOADING: 'uploading',       // 保存中
  SAVED: 'saved',               // 保存完了
  CANCELLED: 'cancelled',       // 接続がキャンセルされた（録音データは保持）
  FAILED: 'failed',             // 保存失敗（録音データは保持）
});

const STATUS_LABELS = Object.freeze({
  [DriveSaveStatus.IDLE]: '未保存',
  [DriveSaveStatus.CONNECTING]: 'Google Driveに接続しています',
  [DriveSaveStatus.UPLOADING]: '保存中',
  [DriveSaveStatus.SAVED]: '保存完了',
  [DriveSaveStatus.CANCELLED]: '接続がキャンセルされました',
  [DriveSaveStatus.FAILED]: '保存失敗',
});

/* 認証フェーズで status 行の下に出す案内。録音データは常に保持される。 */
export const CONNECT_MESSAGES = Object.freeze({
  /* トークンが無い初回。 */
  FIRST: 'Google Driveへの接続が必要です。認証画面で許可してください。',
  /* 期限切れ・401後の再接続。 */
  REAUTH: 'Google Driveへ再接続しています。',
  /* キャンセル。 */
  CANCELLED: 'Google Driveへの接続がキャンセルされました。録音データは保持されています。',
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
    '認証の有効期限が切れました。もう一度お試しください。',
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

/*
 * エラーから遷移先の状態を決める。
 * ポップアップを閉じた／開けなかった場合は「キャンセル」扱いとし、
 * 失敗（赤い警告）とは区別する。いずれの場合も録音データは保持する。
 */
export function toStatus(error) {
  if (error instanceof DriveAuthError
    && (error.code === DriveAuthErrorCode.POPUP_CLOSED
      || error.code === DriveAuthErrorCode.POPUP_BLOCKED)) {
    return DriveSaveStatus.CANCELLED;
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
  /* 一度でも認可に成功したか。再接続の案内文を出し分けるために使う。 */
  let hasAuthedBefore = false;

  function render() {
    panel.dataset.driveStatus = status;
    statusLine.textContent = STATUS_LABELS[status] ?? STATUS_LABELS[DriveSaveStatus.IDLE];

    /* 保存中・接続中は押せないようにして二重送信を防ぐ。 */
    button.disabled = busy;

    if (savedOnce) {
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

  /*
   * トークンを用意する。
   * 有効なトークンがあればそのまま返し、無ければ認証（ポップアップ）を行う。
   * forceConsent は 401 後の再認可で使う。
   * 認証が必要なときだけ「接続が必要です／再接続しています」を表示する。
   */
  async function ensureTokenForSave({ forceConsent = false } = {}) {
    if (!forceConsent && hasValidAccessToken()) {
      return ensureAccessToken();
    }

    setStatus(DriveSaveStatus.CONNECTING);
    const reconnect = hasAuthedBefore || forceConsent;
    /* 一度でも認可済みなら「再接続」、初回なら「接続が必要」。 */
    showMessage(reconnect ? CONNECT_MESSAGES.REAUTH : CONNECT_MESSAGES.FIRST, false);
    debugLog('auth:connect', { reconnect, forceConsent });

    const token = await ensureAccessToken({ forceConsent });
    hasAuthedBefore = true;
    return token;
  }

  async function uploadOnce(token, recording) {
    setStatus(DriveSaveStatus.UPLOADING);
    showMessage('', false);

    /*
     * 録音開始日時があればそれを使う。無ければ保存時刻。
     * 同じ録音を2回保存した場合、ファイル名は同じでもDrive側では
     * 別ファイルとして作成される（Driveは同名ファイルを許容する）。
     */
    const fileName = buildDriveFileName(recording.startedAt ?? new Date());
    /* Blobの中身は出さず、有無・サイズ・MIMEだけを出す。 */
    debugLog('upload:start', describeBlob(recording.blob));
    return saveMp3ToDrive({ token, blob: recording.blob, fileName });
  }

  /*
   * 保存を実行する。1回のボタン押下で「認証 → アップロード」まで通す。
   *
   * ・トークンが無い／期限切れ … この中で取得してから保存へ進む（自動継続）
   * ・アップロード中に 401  … トークンを捨てて再認可し、そのまま再送信する
   *                          （利用者にもう一度押させない）
   * 録音データ（recording.blob）はこの関数内で破棄しない。
   */
  async function runSave() {
    if (busy) {
      return;
    }

    const recording = typeof getRecording === 'function' ? getRecording() : null;

    if (!recording?.blob) {
      showMessage('保存できるMP3がありません。先に録音とMP3変換を行ってください。', false);
      return;
    }

    busy = true;
    showResult(null);
    showMessage('', false);
    render();
    debugLog('save:start', describeBlob(recording.blob));

    try {
      let token = await ensureTokenForSave();

      try {
        const file = await uploadOnce(token, recording);
        savedOnce = true;
        setStatus(DriveSaveStatus.SAVED);
        showResult(file);
        showMessage('', false);
        debugLog('upload:success', { hasFileId: Boolean(file?.id) });
      } catch (error) {
        /*
         * 401：保持中トークンを捨て、同意付きで取り直して1回だけ再送信する。
         * ここで再取得したトークンで保存できれば、利用者操作は1回で完了する。
         * 再試行は最大1回（この catch は1度しか通らない）。
         */
        if (error instanceof DriveError && error.code === DriveErrorCode.UNAUTHORIZED) {
          debugLog('upload:401-retry', { attempt: 2 });
          onDeveloperError?.('drive-reauth', error);
          clearAccessToken();
          token = await ensureTokenForSave({ forceConsent: true });
          const file = await uploadOnce(token, recording);
          savedOnce = true;
          setStatus(DriveSaveStatus.SAVED);
          showResult(file);
          showMessage('', false);
          debugLog('upload:success', { hasFileId: Boolean(file?.id), afterReauth: true });
        } else {
          throw error;
        }
      }
    } catch (error) {
      const code = (error instanceof DriveError || error instanceof DriveAuthError)
        ? error.code : 'UNEXPECTED';
      debugLog('save:failed', { code });
      onDeveloperError?.('drive-save', error);

      /* 認可段階の 401 相当（再認可でも失敗）や API エラー。 */
      if (error instanceof DriveError && error.code === DriveErrorCode.UNAUTHORIZED) {
        clearAccessToken();
      }

      const next = toStatus(error);
      setStatus(next);

      if (next === DriveSaveStatus.CANCELLED) {
        /* キャンセルは警告ではなく案内として出す。録音データは保持済み。 */
        debugLog('auth:cancelled', { code });
        showMessage(CONNECT_MESSAGES.CANCELLED, false);
      } else {
        showMessage(toUserMessage(error), true);
      }
    } finally {
      busy = false;
      render();
    }
  }

  button.addEventListener('click', () => { runSave(); });

  /*
   * 起動時は常に「未保存（idle）」から始める。
   * ログイン表示の有無で押せなくすることはしない（認証は押下時に行う）。
   */
  render();

  return {
    /*
     * 新しい録音を始めたときに、前回の保存結果を消す。
     * これは録音のやり直し・破棄のときだけ呼ぶこと。
     * visibilitychange / pageshow / pagehide では呼ばない
     * （Androidのタブ休止・復元で保存状態や録音データを失わないため）。
     * hasAuthedBefore は保持し、取得済みトークンがあれば次回は無音で保存できる。
     */
    reset() {
      busy = false;
      savedOnce = false;
      showResult(null);
      showMessage('', false);
      setStatus(DriveSaveStatus.IDLE);
    },
  };
}

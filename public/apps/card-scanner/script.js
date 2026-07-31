/*
 * 名刺スキャナのUI層。
 *
 * 担当するのは状態遷移・文言・DOM更新だけ。
 *   認可            … ../drive-auth.js
 *   OCRと画像保存   … ./drive-ocr.js
 *   保存先の解決    … ./drive-folders.js
 *   台帳への追記    … ./sheets-client.js
 *   画像の縮小      … ./capture.js
 *   項目の振り分け  … ./card-parser.js（純粋関数）
 *   機械的な属性    … ./metadata.js（純粋関数）
 *   列と項目の定義  … ./fields.js
 *
 * 表示は必ず textContent で行う。
 * OCR結果・API由来の文字列は innerHTML へ渡さない。
 *
 * 起動時にDrive権限は要求しない。利用者がボタンを押した時だけ認可を開始する。
 * ポップアップブロックを避けるため、押下 → 認可 → 縮小 → 送信 の順で行う。
 *
 * ------------------------------------------------------------------
 * ログに出さないもの
 * ------------------------------------------------------------------
 * アクセストークン / メールアドレス / 画像の内容 /
 * OCR の本文 / フォルダID・ファイルID。
 * 出してよいのは件数・真偽値・エラーコードなどの要約だけ。
 * ------------------------------------------------------------------
 */

import {
  DriveAuthError,
  DriveAuthErrorCode,
  clearAccessToken,
  ensureAccessToken,
  hasValidAccessToken,
  setDriveAuthLogger,
} from '../drive-auth.js';

import {
  DriveError,
  DriveErrorCode,
  buildCardImageFileName,
  ocrImage,
  saveCardImage,
  setDriveOcrLogger,
} from './drive-ocr.js';

import {
  FolderResolution,
  adoptCandidateRootFolder,
  ensureFolderTree,
  resolveRootFolder,
  setFoldersLogger,
} from './drive-folders.js';

import {
  SheetsError,
  SheetsErrorCode,
  allocateCardId,
  appendCardRow,
  buildDuplicateKey,
  ensureSpreadsheet,
  findDuplicates,
  setSheetsLogger,
  spreadsheetUrl,
  verifyCardIdUnique,
} from './sheets-client.js';

import { CaptureError, shrinkToJpeg } from './capture.js';
import { mergeParsed, parseCardText } from './card-parser.js';

import {
  OCR_ENGINE,
  buildCompanyId,
  calcOcrConfidence,
  detectLanguage,
  detectOrientation,
  sha256Hex,
} from './metadata.js';

import {
  CONFIDENCE_BY_KEY,
  FIELDS,
  FIELD_INPUT_TYPES,
  LOW_CONFIDENCE_NOTICE,
  createEmptyMatched,
  createEmptyValues,
  dedupeEmails,
  normalizeEmail,
  parseTags,
} from './fields.js';

/* ============================================================
   デバッグログ
   既定では何も出さない。?debug=1 で有効化する。
   ============================================================ */

let debugEnabled = false;

try {
  debugEnabled = new URLSearchParams(window.location.search).get('debug') === '1';
} catch {
  /* location が読めない環境。無効のままにする。 */
}

function debug(event, data) {
  if (!debugEnabled) {
    return;
  }

  try {
    if (data === undefined) {
      console.debug(`[cs] ${event}`);
    } else {
      console.debug(`[cs] ${event}`, data);
    }
  } catch {
    /* console が使えない環境。無視する。 */
  }
}

setDriveAuthLogger(debug);
setDriveOcrLogger(debug);
setSheetsLogger(debug);
setFoldersLogger(debug);

/* ============================================================
   面の定義
   ============================================================ */

const SIDES = Object.freeze([
  { key: 'front', label: '表面', required: true },
  { key: 'back', label: '裏面', required: false },
]);

/* 統合OCRで面の境目に入れる区切り。人が読んで分かる形にする。 */
const OCR_JOINER = '\n----- 裏面 -----\n';

/* ============================================================
   状態
   ============================================================ */

export const CardScanStatus = Object.freeze({
  IDLE: 'idle',               // 表面の画像が選ばれていない
  CAPTURED: 'captured',       // 画像はある。まだ読み取っていない
  CONNECTING: 'connecting',   // Googleドライブに接続しています（認証中）
  READING: 'reading',         // 読み取り中
  REVIEW: 'review',           // 読み取り完了。確認・修正の段階
  SAVING: 'saving',           // 保存中
  SAVED: 'saved',             // 保存完了
  CANCELLED: 'cancelled',     // 接続がキャンセルされた（画像と入力内容は保持）
  FAILED: 'failed',           // 失敗（画像と入力内容は保持）
});

const STATUS_LABELS = Object.freeze({
  [CardScanStatus.IDLE]: '表面の画像が選ばれていません',
  [CardScanStatus.CAPTURED]: '読み取りの準備ができました',
  [CardScanStatus.CONNECTING]: 'Googleドライブに接続しています',
  [CardScanStatus.READING]: '文字を読み取っています',
  [CardScanStatus.REVIEW]: '読み取りが完了しました。内容をご確認ください',
  [CardScanStatus.SAVING]: 'スプレッドシートへ保存しています',
  [CardScanStatus.SAVED]: '保存が完了しました',
  [CardScanStatus.CANCELLED]: '接続がキャンセルされました',
  [CardScanStatus.FAILED]: '処理に失敗しました',
});

const CONNECT_MESSAGES = Object.freeze({
  FIRST: 'Googleドライブへの接続が必要です。認証画面で許可してください。',
  REAUTH: 'Googleドライブへ再接続しています。',
  CANCELLED: 'Googleドライブへの接続がキャンセルされました。撮影した画像と入力内容は保持されています。',
});

const AUTH_ERROR_MESSAGES = Object.freeze({
  [DriveAuthErrorCode.CLIENT_ID_MISSING]:
    'このアプリは現在準備中です。設定が完了するまでお待ちください。',
  [DriveAuthErrorCode.NOT_SIGNED_IN]:
    'Googleドライブを使うには、Googleへのログインが必要です。',
  [DriveAuthErrorCode.GIS_LOAD_FAILED]:
    'Googleの認証機能を読み込めませんでした。通信環境をご確認のうえ、ページを再読み込みしてお試しください。',
  [DriveAuthErrorCode.POPUP_CLOSED]:
    '認証画面が閉じられたため、処理を中止しました。もう一度お試しください。',
  [DriveAuthErrorCode.POPUP_BLOCKED]:
    '認証画面を開けませんでした。ブラウザのポップアップブロックを解除してお試しください。',
  [DriveAuthErrorCode.ACCESS_DENIED]:
    'Googleドライブへのアクセスが許可されませんでした。読み取りには権限の許可が必要です。',
  [DriveAuthErrorCode.SCOPE_NOT_GRANTED]:
    'Googleドライブへの権限が許可されませんでした。権限の確認画面で「許可」を選んでください。',
  [DriveAuthErrorCode.UNKNOWN]:
    'Googleの認証に失敗しました。しばらく時間をおいてお試しください。',
});

const OCR_ERROR_MESSAGES = Object.freeze({
  [DriveErrorCode.UNAUTHORIZED]:
    '認証の有効期限が切れました。もう一度お試しください。',
  [DriveErrorCode.FORBIDDEN]:
    'Googleドライブへのアクセスが許可されませんでした。アカウントの権限設定をご確認ください。',
  [DriveErrorCode.API_DISABLED]:
    'Google Drive APIが有効になっていません。管理者にGoogle Cloud側の設定をご確認ください。',
  [DriveErrorCode.QUOTA_EXCEEDED]:
    'Googleドライブの保存容量が不足しています。空き容量を確保してからお試しください。',
  [DriveErrorCode.RATE_LIMITED]:
    'アクセスが集中しています。しばらく時間をおいてからお試しください。',
  [DriveErrorCode.NOT_FOUND]:
    '読み取り結果を取得できませんでした。もう一度お試しください。',
  [DriveErrorCode.OCR_EMPTY]:
    '文字を読み取れませんでした。明るい場所で、名刺が画面いっぱいに写るように撮り直してください。',
  [DriveErrorCode.NETWORK]:
    '通信に失敗しました。ネットワーク接続をご確認のうえ、もう一度お試しください。',
  [DriveErrorCode.SERVER_ERROR]:
    'Google側で問題が発生しています。しばらく時間をおいてからお試しください。',
  [DriveErrorCode.UNKNOWN]:
    '読み取りに失敗しました。もう一度お試しください。',
});

const SHEETS_ERROR_MESSAGES = Object.freeze({
  [SheetsErrorCode.UNAUTHORIZED]:
    '認証の有効期限が切れました。もう一度お試しください。',
  [SheetsErrorCode.FORBIDDEN]:
    'スプレッドシートへの保存が許可されませんでした。アカウントの権限設定をご確認ください。',
  [SheetsErrorCode.API_DISABLED]:
    'スプレッドシートへの保存機能が有効になっていません。管理者にお問い合わせください。',
  [SheetsErrorCode.RATE_LIMITED]:
    'アクセスが集中しています。しばらく時間をおいてからお試しください。',
  [SheetsErrorCode.NOT_FOUND]:
    '保存先のスプレッドシートが見つかりませんでした。もう一度お試しください。',
  [SheetsErrorCode.NETWORK]:
    '通信に失敗しました。ネットワーク接続をご確認のうえ、もう一度お試しください。',
  [SheetsErrorCode.SERVER_ERROR]:
    'Google側で問題が発生しています。しばらく時間をおいてからお試しください。',
  [SheetsErrorCode.CARD_ID_CONFLICT]:
    'カードIDの採番が確定しませんでした。ほかの端末が同時に保存している可能性があります。少し待ってからもう一度お試しください。',
  [SheetsErrorCode.UNKNOWN]:
    '保存に失敗しました。もう一度お試しください。',
});

const CAPTURE_ERROR_MESSAGE = '画像を読み込めませんでした。別の画像でお試しください。';
const FALLBACK_ERROR_MESSAGE = '処理に失敗しました。もう一度お試しください。';
const BACK_OCR_FAILED_MESSAGE = '裏面の読み取りに失敗しました。表面の結果だけで続けます。裏面の内容は手で追加してください。';
const NO_FRONT_MESSAGE = '表面の画像を選んでください。裏面だけでは読み取れません。';

/*
 * 保存先の確認に関する文言。
 *
 * 「TSAM AI」が見つからない場合は自動で作るため、この画面が出るのは
 * 同名フォルダが複数見つかったときだけ。
 */
const FOLDER_MESSAGES = Object.freeze({
  MULTIPLE: '「TSAM AI」という名前のフォルダが複数見つかりました。どれを保存先にするか選んでください。',
  MULTIPLE_NOTE: '更新日時が新しいものが正しいとは限らないため、自動では選びません。Driveで中身を確認してから選んでください。',
  NOT_TSAM: '選択されたフォルダは保存先にできません。マイドライブ直下にある「TSAM AI」という名前のフォルダを選んでください。',
  NO_ACCESS: '選択されたフォルダへアクセスできませんでした。別の候補を選んでください。',
});

/* 重複の理由ごとの説明。 */
const DUPLICATE_REASONS = Object.freeze({
  cardId: 'カードID一致',
  frontImage: '表面画像が同一',
  backImage: '裏面画像が同一',
  crossImage: '表裏を入れ替えた同一画像',
  email: 'メール一致',
  mobile: '携帯電話一致',
  companyName: '会社名と氏名が一致',
});

/* 要確認の印に添える説明。 */
const FLAG_LABEL = '要確認';
const FLAG_HINT = '自動では判別できませんでした。内容をご確認ください。';

/* メール欄の文言。 */
const EMAIL_LABEL = 'メールアドレス';
const EMAIL_EMPTY_TEXT = 'メールアドレスは読み取れませんでした。必要であれば追加してください。';
const EMAIL_PRIMARY_NAME = 'cs-email-primary';

const CARD_ID_PLACEHOLDER = '保存時に自動生成';
const META_EMPTY = '—';

/*
 * 保存先が決まっていないことを表す内部エラー。
 * 画面に赤いエラーを出さず、復旧の案内へ切り替えるために使う。
 */
class StorageChoiceNeeded extends Error {
  constructor() {
    super('STORAGE_CHOICE_NEEDED');
    this.name = 'StorageChoiceNeeded';
  }
}

function toUserMessage(error) {
  if (error instanceof DriveAuthError) {
    return AUTH_ERROR_MESSAGES[error.code] ?? AUTH_ERROR_MESSAGES[DriveAuthErrorCode.UNKNOWN];
  }

  if (error instanceof DriveError) {
    return OCR_ERROR_MESSAGES[error.code] ?? OCR_ERROR_MESSAGES[DriveErrorCode.UNKNOWN];
  }

  if (error instanceof SheetsError) {
    return SHEETS_ERROR_MESSAGES[error.code] ?? SHEETS_ERROR_MESSAGES[SheetsErrorCode.UNKNOWN];
  }

  if (error instanceof CaptureError) {
    return CAPTURE_ERROR_MESSAGE;
  }

  return FALLBACK_ERROR_MESSAGE;
}

function toStatus(error) {
  if (error instanceof DriveAuthError
    && (error.code === DriveAuthErrorCode.POPUP_CLOSED
      || error.code === DriveAuthErrorCode.POPUP_BLOCKED)) {
    return CardScanStatus.CANCELLED;
  }

  return CardScanStatus.FAILED;
}

function isUnauthorized(error) {
  return (error instanceof DriveError && error.code === DriveErrorCode.UNAUTHORIZED)
    || (error instanceof SheetsError && error.code === SheetsErrorCode.UNAUTHORIZED);
}

/* ============================================================
   画面の部品
   ============================================================ */

const el = {
  status: document.getElementById('cs-status'),
  message: document.getElementById('cs-message'),
  saveImageCheckbox: document.getElementById('cs-save-image'),
  readButton: document.getElementById('cs-read-button'),

  folder: document.getElementById('cs-folder'),
  folderMessage: document.getElementById('cs-folder-message'),
  folderNote: document.getElementById('cs-folder-note'),
  folderCandidates: document.getElementById('cs-folder-candidates'),

  review: document.getElementById('cs-review'),
  lowConfidence: document.getElementById('cs-low-confidence'),
  duplicate: document.getElementById('cs-duplicate'),
  conflict: document.getElementById('cs-conflict'),
  conflictList: document.getElementById('cs-conflict-list'),
  form: document.getElementById('cs-form'),

  metaCardId: document.getElementById('cs-meta-card-id'),
  metaEngine: document.getElementById('cs-meta-engine'),
  metaConfidence: document.getElementById('cs-meta-confidence'),
  metaOrientation: document.getElementById('cs-meta-orientation'),
  metaLanguage: document.getElementById('cs-meta-language'),

  rawFront: document.getElementById('cs-raw-front'),
  rawBack: document.getElementById('cs-raw-back'),
  rawBackGroup: document.getElementById('cs-raw-back-group'),
  saveButton: document.getElementById('cs-save-button'),
  nextButton: document.getElementById('cs-next-button'),
  result: document.getElementById('cs-result'),
};

/* 面ごとの要素。IDは cs-<面>-<部品> の規則で決まる。 */
const sideEl = new Map();

SIDES.forEach((side) => {
  sideEl.set(side.key, {
    frame: document.getElementById(`cs-${side.key}-frame`),
    preview: document.getElementById(`cs-${side.key}-preview`),
    hint: document.getElementById(`cs-${side.key}-hint`),
    cameraInput: document.getElementById(`cs-${side.key}-camera-input`),
    fileInput: document.getElementById(`cs-${side.key}-file-input`),
    cameraButton: document.getElementById(`cs-${side.key}-camera-button`),
    fileButton: document.getElementById(`cs-${side.key}-file-button`),
    clearButton: document.getElementById(`cs-${side.key}-clear-button`),
    info: document.getElementById(`cs-${side.key}-info`),
  });
});

/* 生成した入力欄。キー → { input, field, flag, hint, wrapper } */
const inputs = new Map();

/* メールの行。{ row, input, radio, removeButton } の配列。 */
let emailRows = [];

function createSideState() {
  return {
    file: null,
    previewUrl: '',
    /* 縮小結果。画像保存とハッシュで再利用する。 */
    shrunk: null,
    text: '',
    hash: '',
  };
}

const state = {
  status: CardScanStatus.IDLE,
  busy: false,
  sides: {
    front: createSideState(),
    back: createSideState(),
  },
  matched: createEmptyMatched(),
  conflicts: [],

  /* 保存先。すべて解決できるまで null。 */
  folders: null,
  spreadsheetId: '',

  /* OCRの記録。保存時にそのまま列へ入る。 */
  ocrAt: null,
  orientation: '',
  language: '',

  /* 利用者が手で直した項目のキー。OCR信頼度の計算に使う。 */
  editedKeys: new Set(),

  /* 保存先の選択待ちで中断した操作。決まったら再開する。 */
  pendingAction: null,
  hasAuthedBefore: false,
};

function sideState(key) {
  return state.sides[key];
}

/* ============================================================
   表示
   ============================================================ */

function setStatus(next) {
  state.status = next;
  el.status.textContent = STATUS_LABELS[next] ?? STATUS_LABELS[CardScanStatus.IDLE];
  render();
}

function showMessage(text, tone) {
  if (!text) {
    el.message.hidden = true;
    el.message.removeAttribute('role');
    el.message.removeAttribute('data-tone');
    el.message.textContent = '';
    return;
  }

  el.message.textContent = text;
  el.message.dataset.tone = tone ?? 'info';

  if (tone === 'error') {
    el.message.setAttribute('role', 'alert');
  } else {
    el.message.removeAttribute('role');
  }

  el.message.hidden = false;
}

function render() {
  const { busy, status } = state;

  SIDES.forEach((side) => {
    const parts = sideEl.get(side.key);
    const hasImage = sideState(side.key).file !== null;

    parts.cameraButton.disabled = busy;
    parts.fileButton.disabled = busy;
    parts.clearButton.disabled = busy;
    parts.clearButton.hidden = !hasImage;
  });

  /* 表面が無ければ読み取れない。裏面だけでは押せない。 */
  el.readButton.disabled = busy || sideState('front').file === null;
  el.saveButton.disabled = busy;
  el.nextButton.disabled = busy;

  el.readButton.textContent = status === CardScanStatus.REVIEW || status === CardScanStatus.SAVED
    ? 'もう一度読み取る'
    : '文字を読み取る';
}

/* ============================================================
   自動項目の表示
   ============================================================ */

/*
 * OCR信頼度を計算し直して表示する。
 * 利用者が入力欄を直すたびに呼ぶ（手で直した項目は満点として扱うため）。
 */
function refreshConfidence() {
  if (state.ocrAt === null) {
    el.metaConfidence.textContent = META_EMPTY;
    return 0;
  }

  const score = calcOcrConfidence({
    values: collectValues(),
    matched: state.matched,
    confidenceByKey: CONFIDENCE_BY_KEY,
    editedKeys: state.editedKeys,
  });

  el.metaConfidence.textContent = `${score} / 100`;

  return score;
}

function renderMeta() {
  el.metaCardId.textContent = CARD_ID_PLACEHOLDER;
  el.metaEngine.textContent = state.ocrAt ? OCR_ENGINE : META_EMPTY;
  el.metaOrientation.textContent = state.orientation || META_EMPTY;
  el.metaLanguage.textContent = state.language || META_EMPTY;
  refreshConfidence();
}

/* ============================================================
   確認フォームの生成
   fields.js の定義から作る。ここで項目を独自に増やさない。
   ============================================================ */

function markEdited(key) {
  state.editedKeys.add(key);
  refreshConfidence();
}

function createFieldRow(field) {
  const config = FIELD_INPUT_TYPES[field.key] ?? {};
  const inputId = `cs-input-${field.key}`;
  const hintId = `cs-hint-${field.key}`;

  const wrapper = document.createElement('div');
  wrapper.className = 'cs-field';
  wrapper.dataset.field = field.key;
  wrapper.dataset.flagged = 'false';

  if (config.multiline) {
    wrapper.dataset.span = 'full';
  }

  const head = document.createElement('div');
  head.className = 'cs-field__head';

  const label = document.createElement('label');
  label.className = 'cs-field__label';
  label.setAttribute('for', inputId);
  label.textContent = field.label;

  const flag = document.createElement('span');
  flag.className = 'cs-field__flag';
  flag.textContent = FLAG_LABEL;
  flag.hidden = true;

  head.append(label, flag);

  if (field.key === 'tags') {
    const note = document.createElement('span');
    note.className = 'cs-field__note';
    note.textContent = 'カンマまたは改行で区切って複数指定できます。';
    head.append(note);
  }

  const input = config.multiline
    ? document.createElement('textarea')
    : document.createElement('input');

  input.className = 'cs-field__input';
  input.id = inputId;

  if (config.multiline) {
    input.rows = field.key === 'note' ? 3 : 2;
  } else {
    input.type = config.type ?? 'text';
  }

  if (config.inputMode) {
    input.inputMode = config.inputMode;
  }

  if (config.autocomplete) {
    input.autocomplete = config.autocomplete;
  }

  if (config.placeholder) {
    input.placeholder = config.placeholder;
  }

  input.addEventListener('input', () => { markEdited(field.key); });

  const hint = document.createElement('p');
  hint.className = 'cs-field__hint';
  hint.id = hintId;
  hint.textContent = FLAG_HINT;
  hint.hidden = true;

  wrapper.append(head, input, hint);

  inputs.set(field.key, { field, wrapper, input, flag, hint, hintId });

  return wrapper;
}

/* ------------------------------------------------------------
   メール欄
   件数が変わるため、他の項目と違って専用の部品にする。
   メインの指定は「実値」で持つ（インデックスだと削除でずれる）。
   ------------------------------------------------------------ */

function updateEmailControls() {
  const only = emailRows.length === 1;

  emailRows.forEach((entry) => {
    entry.radio.disabled = only;

    if (only) {
      entry.radio.checked = true;
    }
  });

  el.emailEmpty.hidden = emailRows.length > 0;
}

function removeEmailRow(entry) {
  const wasPrimary = entry.radio.checked;

  entry.row.remove();
  emailRows = emailRows.filter((item) => item !== entry);

  /* メインを消した場合は、残った先頭を自動でメインにする。 */
  if (wasPrimary && emailRows.length > 0) {
    emailRows[0].radio.checked = true;
  }

  updateEmailControls();
  markEdited('primaryEmail');
}

function createEmailRow(value = '', primary = false) {
  const row = document.createElement('li');
  row.className = 'cs-email';

  const mainLabel = document.createElement('label');
  mainLabel.className = 'cs-email__main';

  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = EMAIL_PRIMARY_NAME;
  radio.checked = primary;
  radio.addEventListener('change', () => { markEdited('primaryEmail'); });

  const mainText = document.createElement('span');
  mainText.textContent = 'メイン';

  mainLabel.append(radio, mainText);

  const input = document.createElement('input');
  input.type = 'email';
  input.inputMode = 'email';
  input.className = 'cs-field__input cs-email__input';
  input.value = value;
  input.setAttribute('aria-label', EMAIL_LABEL);
  input.addEventListener('input', () => { markEdited('primaryEmail'); });

  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'cs-email__remove';
  removeButton.textContent = '削除';
  removeButton.setAttribute('aria-label', 'このメールアドレスを削除する');

  row.append(mainLabel, input, removeButton);

  const entry = { row, input, radio, removeButton };
  removeButton.addEventListener('click', () => { removeEmailRow(entry); });

  emailRows.push(entry);
  el.emailList.append(row);

  return entry;
}

function renderEmails(emails, primaryEmail) {
  emailRows = [];
  el.emailList.replaceChildren();

  const list = dedupeEmails(emails);
  const primary = normalizeEmail(primaryEmail);
  const primaryIndex = list.findIndex((item) => normalizeEmail(item) === primary);
  const chosen = primaryIndex >= 0 ? primaryIndex : 0;

  list.forEach((item, index) => { createEmailRow(item, index === chosen); });

  updateEmailControls();
}

/* 空欄と重複を落として集める。メインが消えていれば先頭をメインにする。 */
function collectEmails() {
  const emails = [];
  let primaryEmail = '';

  emailRows.forEach((entry) => {
    const value = entry.input.value.trim();

    if (value === '') {
      return;
    }

    emails.push(value);

    if (entry.radio.checked && primaryEmail === '') {
      primaryEmail = value;
    }
  });

  const deduped = dedupeEmails(emails);

  if (primaryEmail === ''
    || !deduped.some((item) => normalizeEmail(item) === normalizeEmail(primaryEmail))) {
    primaryEmail = deduped[0] ?? '';
  }

  return { emails: deduped, primaryEmail };
}

function buildEmailBlock() {
  const wrapper = document.createElement('div');
  wrapper.className = 'cs-field cs-field--emails';
  wrapper.dataset.field = 'emails';
  wrapper.dataset.span = 'full';
  wrapper.dataset.flagged = 'false';

  const head = document.createElement('div');
  head.className = 'cs-field__head';

  const label = document.createElement('span');
  label.className = 'cs-field__label';
  label.textContent = EMAIL_LABEL;

  const note = document.createElement('span');
  note.className = 'cs-field__note';
  note.textContent = '複数登録できます。1つをメインに選んでください。';

  head.append(label, note);

  const list = document.createElement('ul');
  list.className = 'cs-email-list';

  const empty = document.createElement('p');
  empty.className = 'cs-field__hint';
  empty.textContent = EMAIL_EMPTY_TEXT;

  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'btn cs-btn-quiet cs-email-add';
  addButton.textContent = 'メールアドレスを追加';

  wrapper.append(head, list, empty, addButton);

  el.emailList = list;
  el.emailEmpty = empty;
  el.emailAdd = addButton;

  addButton.addEventListener('click', () => {
    const entry = createEmailRow('', emailRows.length === 0);
    updateEmailControls();
    entry.input.focus();
  });

  return wrapper;
}

function buildForm() {
  const fragment = document.createDocumentFragment();

  FIELDS.forEach((field) => {
    fragment.append(createFieldRow(field));

    /* メール欄は列定義と同じ位置（氏名かなの直後）に差し込む。 */
    if (field.key === 'nameKana') {
      fragment.append(buildEmailBlock());
    }
  });

  el.form.replaceChildren(fragment);

  el.lowConfidence.textContent = LOW_CONFIDENCE_NOTICE;
}

/*
 * 読み取り結果をフォームへ反映する。
 * matched が false で値が入っている項目には「要確認」を付ける。
 */
function renderValues(values, matched) {
  inputs.forEach((entry, key) => {
    const value = String(values?.[key] ?? '');
    entry.input.value = value;

    const flagged = matched?.[key] !== true && value !== '';

    entry.wrapper.dataset.flagged = flagged ? 'true' : 'false';
    entry.flag.hidden = !flagged;
    entry.hint.hidden = !flagged;

    if (flagged) {
      entry.input.setAttribute('aria-describedby', entry.hintId);
    } else {
      entry.input.removeAttribute('aria-describedby');
    }
  });

  renderEmails(values?.emails, values?.primaryEmail);
}

/* 画面の入力内容を集める。利用者が直した内容がそのまま保存対象になる。 */
function collectValues() {
  const values = createEmptyValues();

  inputs.forEach((entry, key) => {
    values[key] = entry.input.value.trim();
  });

  /* タグは表記を揃えてから保存する。 */
  values.tags = parseTags(values.tags);

  const { emails, primaryEmail } = collectEmails();
  values.emails = emails;
  values.primaryEmail = primaryEmail;

  return values;
}

/* 入力欄に値が1つでも入っているか。メールとタグも数える。 */
function hasAnyValue(values) {
  const filled = FIELDS.some((field) => {
    const value = values[field.key];
    return Array.isArray(value) ? value.length > 0 : String(value ?? '') !== '';
  });

  return filled || values.emails.length > 0;
}

/* ------------------------------------------------------------
   表面と裏面の食い違い
   ------------------------------------------------------------ */

function adoptConflictValue(conflict, item) {
  const entry = inputs.get(conflict.key);

  if (!entry) {
    return;
  }

  entry.input.value = conflict.backValue;
  entry.wrapper.dataset.flagged = 'false';
  entry.flag.hidden = true;
  entry.hint.hidden = true;
  entry.input.removeAttribute('aria-describedby');

  item.remove();
  state.conflicts = state.conflicts.filter((current) => current !== conflict);

  if (el.conflictList.childElementCount === 0) {
    el.conflict.hidden = true;
  }

  /* 利用者が選んだ値なので、確認済みとして扱う。 */
  markEdited(conflict.key);
  debug('conflict:adopted', { key: conflict.key });
}

function showConflicts(conflicts) {
  el.conflictList.replaceChildren();

  if (!Array.isArray(conflicts) || conflicts.length === 0) {
    el.conflict.hidden = true;
    return;
  }

  conflicts.forEach((conflict) => {
    const item = document.createElement('li');
    item.className = 'cs-conflict__item';

    const label = document.createElement('p');
    label.className = 'cs-conflict__label';
    label.textContent = conflict.label;

    const front = document.createElement('p');
    front.className = 'cs-conflict__value';
    front.textContent = `表面: ${conflict.frontValue}`;

    const back = document.createElement('p');
    back.className = 'cs-conflict__value';
    back.textContent = conflict.resolvable
      ? `裏面: ${conflict.backValue}`
      : `裏面にのみあるもの: ${conflict.backValue}`;

    item.append(label, front, back);

    if (conflict.resolvable) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn cs-btn-quiet cs-conflict__adopt';
      button.textContent = '裏面の値を使う';
      button.addEventListener('click', () => { adoptConflictValue(conflict, item); });
      item.append(button);
    } else {
      const note = document.createElement('p');
      note.className = 'cs-field__hint';
      note.textContent = 'メールアドレスは一覧へまとめて追加済みです。不要なものは削除してください。';
      item.append(note);
    }

    el.conflictList.append(item);
  });

  el.conflict.hidden = false;
}

/* ------------------------------------------------------------
   重複
   ------------------------------------------------------------ */

function showDuplicates(matches) {
  if (!Array.isArray(matches) || matches.length === 0) {
    el.duplicate.hidden = true;
    el.duplicate.textContent = '';
    el.duplicate.removeAttribute('data-severity');
    return;
  }

  const details = matches
    .map((item) => {
      const parts = [`${item.row}行目`];

      if (item.cardId) {
        parts.push(item.cardId);
      }

      if (item.date) {
        parts.push(item.date);
      }

      parts.push(DUPLICATE_REASONS[item.reason] ?? '一致');

      return parts.join(' / ');
    })
    .join('、');

  const critical = matches.some((item) => item.severity === 'critical');

  /* 保存は止めない。判断は利用者に委ねる。 */
  el.duplicate.textContent = critical
    ? `同じカードIDの行が既にあります（${details}）。採番に問題がある可能性があるため、保存前にご確認ください。`
    : `既に登録されています（${details}）。このまま保存すると2件になります。`;

  el.duplicate.dataset.severity = critical ? 'critical' : 'warning';
  el.duplicate.hidden = false;
}

function showResult({ spreadsheetId, updatedRange, frontImageLink, backImageLink, cardId }) {
  el.result.replaceChildren();

  const text = document.createElement('span');
  const rowText = updatedRange ? `（${updatedRange}）` : '';
  text.textContent = `スプレッドシートへ保存しました${rowText}。カードID: ${cardId}`;
  el.result.append(text);

  const addLink = (href, label, separator) => {
    if (!href) {
      return;
    }

    const link = document.createElement('a');
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = label;
    el.result.append(document.createTextNode(separator), link);
  };

  if (spreadsheetId) {
    addLink(spreadsheetUrl(spreadsheetId), '名刺台帳を開く', ' ');
  }

  addLink(frontImageLink, '表面の画像を開く', ' / ');
  addLink(backImageLink, '裏面の画像を開く', ' / ');

  el.result.hidden = false;
}

/* ============================================================
   撮影・画像選択
   ============================================================ */

function releasePreviewUrl(key) {
  const side = sideState(key);

  if (side.previewUrl) {
    URL.revokeObjectURL(side.previewUrl);
    side.previewUrl = '';
  }
}

function handleFileSelected(key, file) {
  if (!file) {
    return;
  }

  const side = sideState(key);
  const parts = sideEl.get(key);

  releasePreviewUrl(key);

  side.file = file;
  side.shrunk = null;
  side.text = '';
  side.hash = '';
  side.previewUrl = URL.createObjectURL(file);

  parts.preview.src = side.previewUrl;
  parts.preview.hidden = false;
  parts.hint.hidden = true;
  parts.frame.dataset.hasImage = 'true';

  const sizeKb = Math.round((file.size ?? 0) / 1024);
  parts.info.textContent = `選択中の画像: ${sizeKb.toLocaleString('ja-JP')} KB`;
  parts.info.hidden = false;

  showMessage('', 'info');
  el.result.hidden = true;

  if (sideState('front').file !== null) {
    setStatus(CardScanStatus.CAPTURED);
  } else {
    setStatus(CardScanStatus.IDLE);
  }

  debug('capture:selected', { side: key, size: file.size ?? null, type: file.type ?? null });
}

/* 1面だけ取り消す。もう一方の面と入力内容はそのまま残す。 */
function clearSide(key) {
  const side = sideState(key);
  const parts = sideEl.get(key);

  releasePreviewUrl(key);

  side.file = null;
  side.shrunk = null;
  side.text = '';
  side.hash = '';

  parts.preview.hidden = true;
  parts.preview.removeAttribute('src');
  parts.hint.hidden = false;
  parts.frame.dataset.hasImage = 'false';
  parts.info.hidden = true;
  parts.info.textContent = '';

  parts.cameraInput.value = '';
  parts.fileInput.value = '';

  if (sideState('front').file === null) {
    setStatus(CardScanStatus.IDLE);
  } else {
    render();
  }

  debug('capture:cleared', { side: key });
}

/* ============================================================
   認可
   ============================================================ */

async function ensureTokenForOperation({ forceConsent = false } = {}) {
  if (!forceConsent && hasValidAccessToken()) {
    return ensureAccessToken();
  }

  setStatus(CardScanStatus.CONNECTING);
  const reconnect = state.hasAuthedBefore || forceConsent;
  showMessage(reconnect ? CONNECT_MESSAGES.REAUTH : CONNECT_MESSAGES.FIRST, 'info');
  debug('auth:connect', { reconnect, forceConsent });

  const token = await ensureAccessToken({ forceConsent });
  state.hasAuthedBefore = true;
  return token;
}

async function withReauth(operation) {
  const token = await ensureTokenForOperation();

  try {
    return await operation(token);
  } catch (error) {
    if (!isUnauthorized(error)) {
      throw error;
    }

    debug('auth:401-retry', { attempt: 2 });
    clearAccessToken();
    const retryToken = await ensureTokenForOperation({ forceConsent: true });
    return operation(retryToken);
  }
}

/* ============================================================
   保存先の解決
   ============================================================ */

/* 日時の表示。Drive が返す modifiedTime は ISO 文字列。 */
function formatModifiedTime(value) {
  const date = new Date(String(value ?? ''));

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const pad = (n) => String(n).padStart(2, '0');

  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/*
 * 同名フォルダの候補を並べる。
 *
 * どれが本物かはアプリには判断できないため、自動では選ばない。
 * Drive で中身を確認できるよう、フォルダを開くリンクも添える。
 */
function showFolderCandidates(candidates) {
  el.folderCandidates.replaceChildren();

  if (!Array.isArray(candidates) || candidates.length === 0) {
    el.folderCandidates.hidden = true;
    return;
  }

  candidates.forEach((candidate, index) => {
    const item = document.createElement('li');
    item.className = 'cs-candidate';

    const label = document.createElement('span');
    label.className = 'cs-candidate__label';
    const updated = formatModifiedTime(candidate.modifiedTime);
    label.textContent = updated
      ? `候補${index + 1}（最終更新 ${updated}）`
      : `候補${index + 1}`;

    const open = document.createElement('a');
    open.className = 'cs-candidate__open';
    open.href = `https://drive.google.com/drive/folders/${encodeURIComponent(candidate.id)}`;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    open.textContent = 'Driveで中身を見る';

    const choose = document.createElement('button');
    choose.type = 'button';
    choose.className = 'btn btn--secondary cs-candidate__choose';
    choose.textContent = 'これを使う';
    choose.addEventListener('click', () => { runAdoptCandidate(candidate.id); });

    item.append(label, open, choose);
    el.folderCandidates.append(item);
  });

  el.folderCandidates.hidden = false;
}

function showFolderChoice(message, note, candidates = []) {
  el.folderMessage.textContent = message;
  el.folderNote.textContent = note ?? '';

  showFolderCandidates(candidates);

  el.folder.classList.remove('cs-is-hidden');
  render();
  el.folder.scrollIntoView({ block: 'start', behavior: 'auto' });
}

function hideFolderChoice() {
  el.folder.classList.add('cs-is-hidden');
  showFolderCandidates([]);
}

/*
 * 保存先（フォルダ階層と台帳）を用意する。
 *
 * TSAM AI が無ければそのまま作るので、通常は素通りする。
 * 中断するのは「同名の TSAM AI が複数見つかり、どれを使うか決められない」
 * 場合だけで、そのときは候補を出して利用者に選んでもらう。
 */
async function ensureStorage(token) {
  if (state.folders && state.spreadsheetId) {
    return { folders: state.folders, spreadsheetId: state.spreadsheetId };
  }

  const root = await resolveRootFolder({ token });

  if (root.resolution === FolderResolution.NEEDS_CHOICE || !root.id) {
    /*
     * 更新日時が新しいものが正しいとは限らないので、自動では選ばない。
     * Driveで中身を確認してもらってから決めてもらう。
     */
    showFolderChoice(
      FOLDER_MESSAGES.MULTIPLE,
      FOLDER_MESSAGES.MULTIPLE_NOTE,
      root.candidates,
    );

    throw new StorageChoiceNeeded();
  }

  const folders = await ensureFolderTree({ rootId: root.id, token });
  const { spreadsheetId, created } = await ensureSpreadsheet({
    token,
    parentFolderId: folders.app,
  });

  state.folders = folders;
  state.spreadsheetId = spreadsheetId;

  hideFolderChoice();
  debug('storage:ready', { created });

  return { folders, spreadsheetId };
}

/* 候補一覧の「これを使う」を押したとき。 */
async function runAdoptCandidate(folderId) {
  if (state.busy) {
    return;
  }

  state.busy = true;
  render();

  try {
    const token = await ensureTokenForOperation();
    /* 検索で見つけた候補でも、採用前に名前・種別・場所・アクセス可否を確かめる。 */
    const adopted = await adoptCandidateRootFolder({ folderId, token });

    if (!adopted.ok) {
      showFolderChoice(
        adopted.reason === 'access' ? FOLDER_MESSAGES.NO_ACCESS : FOLDER_MESSAGES.NOT_TSAM,
      );
      return;
    }

    hideFolderChoice();
    showMessage('', 'info');
    await resumePendingAction();
  } catch (error) {
    handleFailure(error, 'folder');
  } finally {
    state.busy = false;
    render();
  }
}

/* 保存先が決まったあと、中断していた操作を再開する。 */
async function resumePendingAction() {
  const action = state.pendingAction;
  state.pendingAction = null;

  if (action === 'read') {
    await runRead();
  } else if (action === 'save') {
    await runSave();
  }
}

/* ============================================================
   読み取り
   ============================================================ */

/*
 * 重複チェックは補助的な確認なので、失敗しても読み取り全体を失敗にしない。
 * カードIDはまだ採番していないため、この段階では渡さない。
 */
async function checkDuplicatesSafely(token, values) {
  try {
    const matches = await findDuplicates({
      token,
      spreadsheetId: state.spreadsheetId,
      values,
      frontImageHash: sideState('front').hash,
      backImageHash: sideState('back').hash,
    });

    showDuplicates(matches);
  } catch (error) {
    debug('sheets:duplicate-check-skipped', {
      code: error instanceof SheetsError ? error.code : 'UNEXPECTED',
    });
    showDuplicates([]);
  }
}

/*
 * 1面を縮小してOCRにかける。
 * 縮小結果は画像保存とハッシュで再利用する。
 */
async function readSide(token, key) {
  const side = sideState(key);

  if (!side.shrunk) {
    side.shrunk = await shrinkToJpeg(side.file);
    debug('capture:shrunk', {
      side: key,
      width: side.shrunk.width,
      height: side.shrunk.height,
      size: side.shrunk.blob.size,
    });
  }

  if (side.hash === '') {
    /* 保存対象そのもの（縮小後のJPEG）を対象にハッシュを取る。 */
    const buffer = await side.shrunk.blob.arrayBuffer();
    side.hash = await sha256Hex(buffer);
    debug('image:hashed', { side: key, length: side.hash.length });
  }

  const result = await ocrImage({ token, blob: side.shrunk.blob });
  return result.text;
}

function buildMergedText(frontText, backText) {
  return backText ? `${frontText}${OCR_JOINER}${backText}` : frontText;
}

async function runRead() {
  if (state.busy) {
    return;
  }

  if (sideState('front').file === null) {
    showMessage(NO_FRONT_MESSAGE, 'error');
    return;
  }

  state.busy = true;
  showMessage('', 'info');
  el.result.hidden = true;
  render();

  let backFailed = false;

  try {
    await withReauth(async (token) => {
      /* 保存先は読み取り前に用意する。ここで足りなければ選択画面へ。 */
      await ensureStorage(token);

      setStatus(CardScanStatus.READING);
      showMessage('', 'info');

      sideState('front').text = await readSide(token, 'front');

      if (sideState('back').file === null) {
        sideState('back').text = '';
        sideState('back').hash = '';
        backFailed = false;
        return;
      }

      /*
       * 裏面は補助なので、失敗しても表面の結果で続ける。
       * ただし 401 だけは上位の再認可へ通す。
       */
      try {
        sideState('back').text = await readSide(token, 'back');
        backFailed = false;
      } catch (error) {
        if (isUnauthorized(error)) {
          throw error;
        }

        sideState('back').text = '';
        backFailed = true;
        debug('ocr:back-failed', {
          code: error instanceof DriveError ? error.code : 'UNEXPECTED',
        });
      }
    });

    /* OCRが通った時刻を記録する。再OCRしたらここだけ更新される。 */
    state.ocrAt = new Date();

    const frontText = sideState('front').text;
    const backText = sideState('back').text;
    const mergedText = buildMergedText(frontText, backText);

    const front = parseCardText(frontText);
    const back = backText ? parseCardText(backText) : null;
    const merged = mergeParsed(front, back);

    state.matched = merged.matched;
    state.conflicts = merged.conflicts;
    /* 読み取り直したので、手直しの記録は捨てる。 */
    state.editedKeys = new Set();

    /* 向きは表面から。表面が無い状態ではここへ来ない。 */
    const shrunk = sideState('front').shrunk;
    state.orientation = detectOrientation(shrunk?.width, shrunk?.height);
    state.language = detectLanguage(mergedText);

    renderValues(merged.values, merged.matched);
    showConflicts(merged.conflicts);
    renderMeta();

    el.rawFront.textContent = front.lines.join('\n');
    el.rawBack.textContent = back ? back.lines.join('\n') : '';
    el.rawBackGroup.hidden = !back;

    el.review.classList.remove('cs-is-hidden');
    setStatus(CardScanStatus.REVIEW);

    debug('ocr:parsed', {
      hasBack: Boolean(back),
      conflicts: merged.conflicts.length,
      emails: merged.values.emails.length,
      orientation: state.orientation,
      language: state.language,
      filled: FIELDS.filter((field) => merged.values[field.key] !== '').length,
    });

    /* 重複の確認（失敗しても続行） */
    const token = hasValidAccessToken() ? await ensureAccessToken() : null;

    if (token) {
      await checkDuplicatesSafely(token, merged.values);
    }

    if (backFailed) {
      showMessage(BACK_OCR_FAILED_MESSAGE, 'error');
    }

    el.review.scrollIntoView({ block: 'start', behavior: 'auto' });
  } catch (error) {
    if (error instanceof StorageChoiceNeeded) {
      /* 保存先の選択待ち。決まったら読み取りから再開する。 */
      state.pendingAction = 'read';
      setStatus(CardScanStatus.CAPTURED);
      showMessage('', 'info');
    } else {
      handleFailure(error, 'read');
    }
  } finally {
    state.busy = false;
    render();
  }
}

/* ============================================================
   保存
   ============================================================ */

/* 画像の保存は任意。失敗しても行の追記は続ける。 */
async function saveSideImage(token, key, values, cardId) {
  const side = sideState(key);

  if (!side.shrunk?.blob) {
    return '';
  }

  const label = SIDES.find((item) => item.key === key)?.label ?? '';
  const folderId = key === 'front' ? state.folders?.frontImage : state.folders?.backImage;

  /* カードIDをファイル名に含めると、台帳の行から画像を辿れる。 */
  const fileName = buildCardImageFileName({
    company: values.company,
    name: values.name,
    side: `${label}_${cardId}`,
  });

  try {
    const image = await saveCardImage({ token, blob: side.shrunk.blob, fileName, folderId });
    return image.webViewLink;
  } catch (error) {
    debug('image:save-failed', {
      side: key,
      code: error instanceof DriveError ? error.code : 'UNEXPECTED',
    });
    return '';
  }
}

async function runSave() {
  if (state.busy) {
    return;
  }

  const values = collectValues();

  if (!hasAnyValue(values)) {
    showMessage('保存する内容がありません。読み取り結果を確認してください。', 'error');
    return;
  }

  state.busy = true;
  showMessage('', 'info');
  el.result.hidden = true;
  render();

  const frontText = sideState('front').text;
  const backText = sideState('back').text;
  const frontImageHash = sideState('front').hash;
  const backImageHash = sideState('back').hash;

  try {
    const saved = await withReauth(async (token) => {
      setStatus(CardScanStatus.SAVING);

      const { spreadsheetId } = await ensureStorage(token);

      /* 保存の瞬間を基準にする。登録日時・更新日時・カードIDで共有する。 */
      const savedAt = new Date();

      const { cardId } = await allocateCardId({ token, spreadsheetId, date: savedAt });
      const companyId = await buildCompanyId(values.company);

      const ocrConfidence = calcOcrConfidence({
        values,
        matched: state.matched,
        confidenceByKey: CONFIDENCE_BY_KEY,
        editedKeys: state.editedKeys,
      });

      /* 画面には出さないが、確認できるようログにだけ出す。 */
      debug('save:derived', {
        cardId,
        companyId,
        ocrConfidence,
        duplicateKey: buildDuplicateKey(values),
        frontImageHash,
        backImageHash,
      });

      let frontImageLink = '';
      let backImageLink = '';

      if (el.saveImageCheckbox.checked) {
        frontImageLink = await saveSideImage(token, 'front', values, cardId);
        backImageLink = await saveSideImage(token, 'back', values, cardId);
      }

      const { updatedRange } = await appendCardRow({
        token,
        spreadsheetId,
        values,
        cardId,
        companyId,
        createdAt: savedAt,
        /* 新規保存では登録日時と同じ。将来の編集保存ではここだけ更新する。 */
        updatedAt: savedAt,
        ocrAt: state.ocrAt,
        frontImageLink,
        backImageLink,
        frontText,
        backText,
        mergedText: buildMergedText(frontText, backText),
        ocrEngine: OCR_ENGINE,
        ocrConfidence,
        frontImageHash,
        backImageHash,
        orientation: state.orientation,
        language: state.language,
      });

      /*
       * 採番は原子的ではないため、追記したあとに実際に1行だけかを確かめる。
       * 検出しても行は触らない（どちらを残すかは中身を見ないと決められない）。
       * 検査そのものが失敗しても、保存は成功しているので全体は失敗にしない。
       */
      let cardIdRows = [];

      try {
        const verified = await verifyCardIdUnique({ token, spreadsheetId, cardId });

        if (verified.count > 1) {
          cardIdRows = verified.rows;
        }
      } catch (error) {
        debug('cardid:verify-skipped', {
          code: error instanceof SheetsError ? error.code : 'UNEXPECTED',
        });
      }

      return { spreadsheetId, updatedRange, frontImageLink, backImageLink, cardId, cardIdRows };
    });

    el.metaCardId.textContent = saved.cardId;
    setStatus(CardScanStatus.SAVED);
    showResult(saved);

    if (saved.cardIdRows.length > 1) {
      /*
       * 同じカードIDの行が複数できた。ほぼ同時に別の端末が保存した場合に起きうる。
       * 行は自動で消さない。利用者に台帳を見て判断してもらう。
       */
      showDuplicates([{
        row: saved.cardIdRows[0],
        cardId: saved.cardId,
        company: '',
        name: '',
        date: '',
        reason: 'cardId',
        severity: 'critical',
      }]);

      showMessage(
        `保存しましたが、同じカードID（${saved.cardId}）の行が${saved.cardIdRows.length}件あります（${saved.cardIdRows.join('行目, ')}行目）。`
        + 'ほかの端末とほぼ同時に保存された可能性があります。台帳を開いて、どちらを残すかご確認ください。行は自動では削除していません。',
        'error',
      );

      debug('cardid:duplicated', { count: saved.cardIdRows.length });
    } else {
      showMessage('', 'success');
    }

    debug('sheets:save-success', { hasRange: Boolean(saved.updatedRange) });
  } catch (error) {
    if (error instanceof StorageChoiceNeeded) {
      state.pendingAction = 'save';
      setStatus(CardScanStatus.REVIEW);
      showMessage('', 'info');
    } else {
      handleFailure(error, 'save');
    }
  } finally {
    state.busy = false;
    render();
  }
}

/* ============================================================
   失敗・キャンセル
   撮影した画像と入力内容はここで消さない。
   ============================================================ */

function handleFailure(error, phase) {
  const code = (error instanceof DriveError
    || error instanceof DriveAuthError
    || error instanceof SheetsError
    || error instanceof CaptureError)
    ? error.code
    : 'UNEXPECTED';

  debug(`${phase}:failed`, { code });

  if (isUnauthorized(error)) {
    clearAccessToken();
  }

  const next = toStatus(error);
  setStatus(next);

  if (next === CardScanStatus.CANCELLED) {
    showMessage(CONNECT_MESSAGES.CANCELLED, 'info');
  } else {
    showMessage(toUserMessage(error), 'error');
  }
}

/* ============================================================
   次の名刺へ
   ============================================================ */

function resetAll() {
  SIDES.forEach((side) => { clearSide(side.key); });

  state.matched = createEmptyMatched();
  state.conflicts = [];
  state.editedKeys = new Set();
  state.ocrAt = null;
  state.orientation = '';
  state.language = '';
  state.pendingAction = null;

  renderValues(createEmptyValues(), createEmptyMatched());
  showConflicts([]);
  showDuplicates([]);
  renderMeta();

  el.rawFront.textContent = '';
  el.rawBack.textContent = '';
  el.rawBackGroup.hidden = true;
  el.result.hidden = true;
  el.review.classList.add('cs-is-hidden');

  showMessage('', 'info');
  setStatus(CardScanStatus.IDLE);
  debug('reset', {});
}

/* ============================================================
   起動
   ============================================================ */

function init() {
  buildForm();
  renderValues(createEmptyValues(), createEmptyMatched());
  renderMeta();

  SIDES.forEach((side) => {
    const parts = sideEl.get(side.key);

    parts.cameraButton.addEventListener('click', () => { parts.cameraInput.click(); });
    parts.fileButton.addEventListener('click', () => { parts.fileInput.click(); });
    parts.clearButton.addEventListener('click', () => { clearSide(side.key); });

    parts.cameraInput.addEventListener('change', (event) => {
      handleFileSelected(side.key, event.target.files?.[0] ?? null);
    });

    parts.fileInput.addEventListener('change', (event) => {
      handleFileSelected(side.key, event.target.files?.[0] ?? null);
    });
  });

  el.readButton.addEventListener('click', () => { runRead(); });
  el.saveButton.addEventListener('click', () => { runSave(); });
  el.nextButton.addEventListener('click', () => { resetAll(); });

  setStatus(CardScanStatus.IDLE);
  debug('init', { debugEnabled });
}

init();

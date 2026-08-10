/*
 * 名刺メール配信アプリの画面制御。
 *
 * ==================================================================
 * このページが守ること
 * ==================================================================
 *   - guardPage() を必ず通す。Portal の一覧に載せていなくても、
 *     URLを知っていれば開けるため。
 *   - innerHTML を使わない。画面の組み立ては textContent と要素生成のみ。
 *   - トークン・宛先アドレスを console へ出さない。
 *   - 外部通信は config.js のエンドポイント（Google 3系統）と
 *     TSAM AI 認証系のみ。
 *   - テスト環境（public/apps/）と他の本番アプリから import しない。
 * ==================================================================
 *
 * 判定・組み立てのロジックは recipients.js / mail.js / ledger.js にある。
 * **ここは画面への反映だけ。** DOM を持たない側にロジックを寄せておくと、
 * テストで画面を組み立てずに済む。
 */

import { setScreenDepth } from '../../auth/config.js';
import { guardPage } from '../../auth/session.js';

import { BCC_BATCH_SIZE, isClientIdConfigured } from './config.js';
import {
  DriveAuthError,
  DriveAuthErrorCode,
  clearAccessToken,
  describeDriveAuthError,
  ensureAccessToken,
  getCachedAccessToken,
} from './drive-auth.js';
import { DriveError, DriveErrorCode, describeDriveError } from './drive-api.js';
import {
  LedgerError,
  describeLedgerError,
  readEmailColumn,
  resolveLedger,
} from './ledger.js';
import { chunkRecipients, normalizeRecipients } from './recipients.js';
import { describeSendError, sendAllBatches } from './mail.js';

/* /production-app/card-mail/ はサイトのルートから2階層下。 */
setScreenDepth(2);

const el = {};

for (const id of [
  'cm-loading', 'cm-content',
  'cm-guidance', 'cm-guidance-text', 'cm-connect',
  'cm-recipients', 'cm-recipients-state',
  'cm-count-valid', 'cm-count-batches', 'cm-count-duplicates', 'cm-count-invalid',
  'cm-invalid-panel', 'cm-invalid-list', 'cm-reload',
  'cm-compose', 'cm-subject', 'cm-body', 'cm-legal-check',
  'cm-send', 'cm-progress', 'cm-message',
  'cm-disconnect',
]) {
  el[id] = document.getElementById(id);
}

/* ---------- 画面の状態 ---------- */

/* 送信できる宛先（検証・重複排除済み）。 */
let recipients = [];

/*
 * 送信済みの束の数。**途中失敗からの再開に使う。**
 * 送ったメールは取り消せないので、再開時はこの数だけ束を飛ばす。
 */
let batchesDone = 0;

let sending = false;

/*
 * 次の連携で同意画面を出し直すか。
 *
 * 同意画面でチェックを片方外されると SCOPE_NOT_GRANTED で弾くが、
 * そのまま連携し直しても GIS が前回の部分許可を返すことがある。
 * 一度スコープ不足を見たら、次は同意画面を強制して付け直させる。
 */
let needsConsent = false;

/* 送信途中（一部の束だけ送信済みで、まだ残りがある）か。 */
function isMidCampaign() {
  const total = chunkRecipients(recipients).length;

  return recipients.length > 0 && batchesDone > 0 && batchesDone < total;
}

/*
 * トークンを用意する。失敗したら案内を出して null。
 *
 * **利用者のボタン押下から呼ぶこと**（ポップアップブロック対策）。
 */
async function acquireToken() {
  try {
    const token = await ensureAccessToken({ forceConsent: needsConsent });
    needsConsent = false;
    return token;
  } catch (error) {
    if (error instanceof DriveAuthError && error.code === DriveAuthErrorCode.SCOPE_NOT_GRANTED) {
      needsConsent = true;
    }

    const described = describeDriveAuthError(error);
    showMessage(`${described.text}（${described.errorCode}）`, { isError: true });
    return null;
  }
}

/* ---------- 表示の道具（innerHTML を使わない） ---------- */

function showMessage(text, { isError = false } = {}) {
  el['cm-message'].textContent = text;
  el['cm-message'].hidden = text === '';
  el['cm-message'].classList.toggle('cm-message--error', isError);
}

function showProgress(text) {
  el['cm-progress'].textContent = text;
  el['cm-progress'].hidden = text === '';
}

function setGuidance(text, { showConnect = false } = {}) {
  el['cm-guidance-text'].textContent = text;
  el['cm-guidance'].hidden = text === '';
  el['cm-connect'].hidden = !showConnect;
}

function renderInvalidList(invalid) {
  const list = el['cm-invalid-list'];

  while (list.firstChild) {
    list.removeChild(list.firstChild);
  }

  for (const value of invalid) {
    const item = document.createElement('li');
    item.textContent = value;
    list.append(item);
  }

  el['cm-invalid-panel'].hidden = invalid.length === 0;
}

/* 送信ボタンを押せる条件がそろっているかを見直す。 */
function refreshSendButton() {
  /*
   * 全束を送り終えたら押せなくする。押せるままにすると、押しても
   * 何も起きない「無反応なボタン」になる。次の配信は「宛先を
   * 読み込み直す」から始める（完了メッセージでも案内する）。
   */
  const remainingChunks = chunkRecipients(recipients).length - batchesDone;

  const ready = !sending
    && remainingChunks > 0
    && el['cm-subject'].value.trim() !== ''
    && el['cm-body'].value.trim() !== ''
    && el['cm-legal-check'].checked;

  el['cm-send'].disabled = !ready;
}

function describeAnyError(error) {
  if (error instanceof LedgerError) {
    return describeLedgerError(error);
  }

  if (error instanceof DriveError) {
    return describeDriveError(error);
  }

  return describeDriveAuthError(error);
}

/* ---------- 連携ボタン ---------- */

/*
 * 「Googleと連携する」の入口。
 *
 * **送信途中の再認可と、宛先の読み込みを分ける。** 送信途中（401で
 * トークンが切れた等）にここから loadRecipients へ入れると、再開位置
 * （batchesDone）がリセットされ、案内どおりに操作しただけで送信済みの
 * 相手へ同じメールがもう一度届く。途中ならトークンだけ取り直す。
 */
async function connectPressed() {
  if (sending) {
    return;
  }

  if (isMidCampaign()) {
    const token = await acquireToken();

    if (!token) {
      return;
    }

    const remaining = chunkRecipients(recipients)
      .slice(batchesDone)
      .reduce((sum, chunk) => sum + chunk.length, 0);

    setGuidance('');
    showMessage(`連携し直しました。「送信する」を押すと、残りの ${remaining} 件から再開します。`);
    refreshSendButton();
    return;
  }

  await loadRecipients();
}

/* ---------- 宛先の読み込み ---------- */

async function loadRecipients() {
  if (sending) {
    return;
  }

  /*
   * 送信途中に読み込み直すと再開位置が失われる。黙って進めず、
   * 二重送信のおそれを伝えたうえで利用者に選ばせる。
   */
  if (isMidCampaign()) {
    const proceed = globalThis.confirm(
      '送信の途中です。宛先を読み込み直すと再開位置が失われ、'
      + '送信済みの相手へ重複して送るおそれがあります。読み込み直しますか？',
    );

    if (!proceed) {
      return;
    }
  }

  /*
   * ポップアップブロックを避けるため、トークンの用意は
   * ボタン押下の直後（このハンドラの先頭側）で行う。
   */
  const token = await acquireToken();

  if (!token) {
    return;
  }

  setGuidance('');
  showMessage('');
  el['cm-recipients'].hidden = false;
  el['cm-recipients-state'].textContent = '名刺管理シートから宛先を読み込んでいます…';

  try {
    const sheetId = await resolveLedger({ token });
    const rawValues = await readEmailColumn(sheetId, { token });
    const result = normalizeRecipients(rawValues);

    recipients = result.recipients;
    batchesDone = 0;

    el['cm-recipients-state'].textContent = '';
    el['cm-count-valid'].textContent = `${result.recipients.length} 件`;
    el['cm-count-batches'].textContent =
      `${chunkRecipients(result.recipients).length} 通（${BCC_BATCH_SIZE}件ずつ）`;
    el['cm-count-duplicates'].textContent = `${result.duplicateCount} 件`;
    el['cm-count-invalid'].textContent = `${result.invalid.length} 件`;
    renderInvalidList(result.invalid);

    if (result.invalid.length > 0) {
      showMessage(
        '形式が正しくない宛先には送信されません。名刺管理シート側の修正をおすすめします。',
        { isError: false },
      );
    }

    el['cm-compose'].hidden = recipients.length === 0;
    el['cm-disconnect'].hidden = false;

    if (recipients.length === 0) {
      el['cm-recipients-state'].textContent = '送信できる宛先がありません。名刺OCRアプリで名刺を登録してください。';
    }
  } catch (error) {
    /*
     * 401 のときだけトークンを捨てる。403 で捨てると、レート制限
     * （待てば直る）を再連携でも直らない状態に変えてしまう。
     */
    if (error instanceof DriveError && error.code === DriveErrorCode.UNAUTHORIZED) {
      clearAccessToken();
      setGuidance('Google連携の期限が切れました。連携し直してください。', { showConnect: true });
    }

    const described = describeAnyError(error);
    el['cm-recipients-state'].textContent = '';

    /* 読み込めていないのに集計の枠だけ出ていると、無反応に見える。 */
    if (recipients.length === 0) {
      el['cm-recipients'].hidden = true;
    }

    showMessage(`${described.text}（${described.errorCode}）`, { isError: true });
  }

  refreshSendButton();
}

/* ---------- 送信 ---------- */

async function send() {
  if (sending) {
    return;
  }

  const token = getCachedAccessToken();

  if (!token) {
    setGuidance('Google連携の期限が切れました。連携し直してください。', { showConnect: true });
    refreshSendButton();
    return;
  }

  const subject = el['cm-subject'].value.trim();
  const text = el['cm-body'].value;
  const allChunks = chunkRecipients(recipients);

  /* 再開時は送信済みの束を飛ばす。 */
  const chunks = allChunks.slice(batchesDone);

  if (chunks.length === 0) {
    /* refreshSendButton がボタンを無効にするため通常は来ない。防衛的に案内する。 */
    showMessage('すべての宛先へ送信済みです。別の内容を送るには「宛先を読み込み直す」を押してください。');
    return;
  }

  const remainingCount = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const confirmed = globalThis.confirm(
    `${remainingCount} 件の宛先へ ${chunks.length} 通に分けてBCC送信します。よろしいですか？\n（送信したメールは取り消せません）`,
  );

  if (!confirmed) {
    return;
  }

  sending = true;
  refreshSendButton();

  /*
   * 送信中は宛先の読み込み直しと連携解除も止める。
   * 進行中に recipients や batchesDone を書き換えられると、
   * 送信済み位置が実態とずれ、飛ばし漏れ・二重送信につながる。
   */
  el['cm-reload'].disabled = true;
  el['cm-disconnect'].disabled = true;

  showMessage('');

  try {
    await sendAllBatches({
      subject,
      text,
      chunks,
      token,
      onProgress: (done, total) => {
        showProgress(`送信中… ${batchesDone + done} / ${allChunks.length} 通`);
        void total;
      },
    });

    batchesDone = allChunks.length;
    showProgress('');
    showMessage(
      `送信が完了しました（${recipients.length} 件 / ${allChunks.length} 通）。`
      + '送信内容はGmailの「送信済み」で確認できます。'
      + '別の内容を送るには「宛先を読み込み直す」からやり直してください。',
    );
  } catch (error) {
    /*
     * **どこまで送れたかを必ず見せる。** 送ったメールは取り消せない。
     * batchesDone を進めておくことで、「再送信」ボタンは残りの束から
     * 再開し、同じ相手への二重送信を起こさない。
     */
    batchesDone += Number(error?.batchesDone ?? 0);

    const sentTotal = allChunks
      .slice(0, batchesDone)
      .reduce((sum, chunk) => sum + chunk.length, 0);

    const described = describeSendError(error?.cause ?? error);

    if (error?.cause instanceof DriveError && error.cause.code === DriveErrorCode.UNAUTHORIZED) {
      clearAccessToken();
      setGuidance('Google連携の期限が切れました。連携し直してから「送信する」を押すと、残りの宛先から再開します。', { showConnect: true });
    }

    showProgress('');
    showMessage(
      `送信が途中で失敗しました。${sentTotal} 件（${batchesDone} 通）までは送信済みです。`
      + `原因: ${described.text}（${described.errorCode}）`
      + ' もう一度「送信する」を押すと、残りの宛先だけに送信します。',
      { isError: true },
    );
  } finally {
    sending = false;
    el['cm-reload'].disabled = false;
    el['cm-disconnect'].disabled = false;
    refreshSendButton();
  }
}

/* ---------- 起動 ---------- */

async function boot() {
  const user = await guardPage({ next: 'portal' });

  if (!user) {
    return; /* すでにログイン画面へ遷移している。 */
  }

  el['cm-loading'].hidden = true;
  el['cm-content'].hidden = false;

  if (!isClientIdConfigured()) {
    setGuidance('Google連携の設定が未完了です（クライアントID未設定）。');
    return;
  }

  setGuidance('Googleと連携すると、名刺管理シートの宛先を読み込みます。', { showConnect: true });

  el['cm-connect'].addEventListener('click', connectPressed);
  el['cm-reload'].addEventListener('click', loadRecipients);
  el['cm-send'].addEventListener('click', send);

  for (const id of ['cm-subject', 'cm-body']) {
    el[id].addEventListener('input', refreshSendButton);
  }

  el['cm-legal-check'].addEventListener('change', refreshSendButton);

  el['cm-disconnect'].addEventListener('click', () => {
    if (sending) {
      return; /* ボタンは無効化してあるが、二重の守り。 */
    }

    clearAccessToken();
    recipients = [];
    batchesDone = 0;
    el['cm-recipients'].hidden = true;
    el['cm-compose'].hidden = true;
    el['cm-disconnect'].hidden = true;
    showMessage('');
    showProgress('');
    setGuidance('連携を解除しました。再度連携すると宛先を読み込みます。', { showConnect: true });
    refreshSendButton();
  });
}

boot();

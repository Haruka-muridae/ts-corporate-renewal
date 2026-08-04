/*
 * 名刺OCR フェーズ0 検証ページの画面制御。
 *
 * ==================================================================
 * このページが守ること
 * ==================================================================
 *   - guardPage() を必ず通す。Portal の一覧に載せていなくても、
 *     URLを知っていれば開けるため（auth/app-registry.js の注意書き）。
 *   - キーは KeyStore.get('gemini') だけで取る。
 *     localStorage を直接触らない（keystore-spec-v1.md §2-1）。
 *   - キーを console へ出さない・画面へ出さない・URLへ載せない。
 *   - 外部通信は要件定義書 §12 の3系統のみ。このページが実際に
 *     使うのは Gemini の1系統だけである。
 *   - テスト環境（public/apps/）から import しない。
 * ==================================================================
 */

import { setScreenDepth } from '../../../auth/config.js';
import { guardPage } from '../../../auth/session.js';
import { KeyStore, PROVIDERS, isKeyStoreAvailable } from '../../../auth/keystore.js';
import { createMessageArea, createSubmitButton } from '../../../auth/ui.js';

import {
  classifyCardText,
  describeGeminiError,
  GEMINI_HOST,
} from './gemini.js';

import {
  PRIMARY_FIELDS,
  SAMPLE_EXPECTED,
  SAMPLE_ORDERED,
  SAMPLE_SHUFFLED,
} from './prompt.js';

import { escapeCellText } from './sanitize.js';

import {
  clearAccessToken,
  describeDriveAuthError,
  ensureAccessToken,
  getCachedAccessToken,
  hasValidAccessToken,
} from './drive-auth.js';

import { DRIVE_SCOPE, isClientIdConfigured } from './google-config.js';

import { describeDriveError } from './drive-api.js';
import { clearStorageCache, ensureStorage, spreadsheetUrl } from './drive-storage.js';
import { collectOrphanTempDocs, describeOcrError, ocrImage } from './drive-ocr.js';

/* /production-app/card-ocr/poc/ はサイトのルートから3階層下。 */
setScreenDepth(3);

const loadingElement = document.getElementById('poc-loading');
const contentElement = document.getElementById('poc-content');
const keyResultElement = document.getElementById('poc-key-result');
const keyActionsElement = document.getElementById('poc-key-actions');
const runButton = document.getElementById('poc-run');
const messageElement = document.getElementById('poc-message');
const geminiResultElement = document.getElementById('poc-gemini-result');
const orderedBody = document.getElementById('poc-ordered-body');
const shuffledBody = document.getElementById('poc-shuffled-body');
const uncertainElement = document.getElementById('poc-uncertain');
const sanitizeBody = document.getElementById('poc-sanitize-body');
const hostsElement = document.getElementById('poc-hosts');

const googleConfigElement = document.getElementById('poc-google-config');
const googleStateElement = document.getElementById('poc-google-state');
const googleMessageElement = document.getElementById('poc-google-message');
const connectButton = document.getElementById('poc-connect');
const disconnectButton = document.getElementById('poc-disconnect');

const driveMessageElement = document.getElementById('poc-drive-message');
const storageButton = document.getElementById('poc-storage');
const storageAgainButton = document.getElementById('poc-storage-again');
const storageTable = document.getElementById('poc-storage-table');
const storageBody = document.getElementById('poc-storage-body');
const storageLinks = document.getElementById('poc-storage-links');
const imageInput = document.getElementById('poc-image');
const ocrStateElement = document.getElementById('poc-ocr-state');
const ocrTextElement = document.getElementById('poc-ocr-text');

const message = createMessageArea(messageElement);
const googleMessage = createMessageArea(googleMessageElement);
const driveMessage = createMessageArea(driveMessageElement);
const run = createSubmitButton(runButton, { busyLabel: '実行しています…' });
const connect = createSubmitButton(connectButton, { busyLabel: '連携しています…' });
const storage = createSubmitButton(storageButton, { busyLabel: '用意しています…' });

/* 何回目の実行か。2回目以降は「再発見」を期待する（計画 §5 の項目10）。 */
let storageRunCount = 0;

/*
 * 実際に呼んだホストを記録する。
 * 「3系統以外へ出ていない」を目視で確かめるための計測であって、
 * 通信を止める仕掛けではない。止めるのは実装側の責任。
 */
const calledHosts = new Set();

function recordHost(url) {
  try {
    calledHosts.add(new URL(url).host);
  } catch {
    calledHosts.add('(解析できないURL)');
  }

  renderHosts();
}

function renderHosts() {
  hostsElement.replaceChildren();

  if (calledHosts.size === 0) {
    const item = document.createElement('li');
    item.textContent = 'まだ通信していません。';
    hostsElement.append(item);
    return;
  }

  for (const host of [...calledHosts].sort()) {
    const item = document.createElement('li');
    const allowed = host === GEMINI_HOST;

    item.textContent = `${host}${allowed ? '（§12 で許可された系統）' : '（★ 許可されていない）'}`;
    item.className = allowed ? 'poc-list__ok' : 'poc-list__ng';
    hostsElement.append(item);
  }
}

/*
 * fetch を包んで呼び出し先を記録する。
 * キーはヘッダーに入るため、記録するのは URL のホストだけにする。
 */
function countingFetch(url, options) {
  recordHost(url);
  return globalThis.fetch(url, options);
}

/* テキストをそのままセルへ入れる。innerHTML を使わない（§14.3）。 */
function addRow(tbody, cells, ok) {
  const row = document.createElement('tr');

  for (const value of cells) {
    const cell = document.createElement('td');
    cell.textContent = value;
    row.append(cell);
  }

  const verdict = document.createElement('td');
  verdict.textContent = ok ? '合格' : '不一致';
  verdict.className = ok ? 'poc-ok' : 'poc-ng';
  row.append(verdict);

  tbody.append(row);
}

function renderClassification(tbody, result) {
  tbody.replaceChildren();

  for (const field of PRIMARY_FIELDS) {
    const expected = SAMPLE_EXPECTED[field] ?? '';
    const actual = String(result?.[field] ?? '');
    /* 役職は「営業推進部 部長」から「部長」を取れれば合格とする。 */
    const ok = actual === expected || (expected !== '' && actual.includes(expected));

    addRow(tbody, [field, expected, actual || '(空)'], ok);
  }
}

function renderSanitize() {
  const cases = [
    ['=1+1', "'=1+1"],
    ['+81-3-1234-5678', "'+81-3-1234-5678"],
    ['-5', "'-5"],
    ['@example', "'@example"],
    ['株式会社サンプル商事', '株式会社サンプル商事'],
    ['', ''],
  ];

  sanitizeBody.replaceChildren();

  for (const [input, expected] of cases) {
    const actual = escapeCellText(input);
    addRow(sanitizeBody, [input === '' ? '(空文字)' : input, actual === '' ? '(空文字)' : actual], actual === expected);
  }
}

function renderKeyState() {
  if (!isKeyStoreAvailable()) {
    keyResultElement.textContent = 'このブラウザでは保存領域を使えません（プライベートモード等）。';
    return false;
  }

  /* 値そのものは取り出すが、画面には出さない。有無と長さだけ示す。 */
  const key = KeyStore.get(PROVIDERS.gemini);

  if (key === null) {
    keyResultElement.textContent = 'キーが未設定です（KEY-001）。Portal で保存してください。';
    keyActionsElement.hidden = false;
    return false;
  }

  keyResultElement.textContent = `キーを取得できました（${key.length}文字）。値は画面に出しません。`;
  keyActionsElement.hidden = true;
  return true;
}

/*
 * Google 連携の表示。
 *
 * **トークンそのものは出さない。** 有効かどうかと、
 * 要求したスコープだけを示す。
 */
function renderGoogleState() {
  const configured = isClientIdConfigured();

  googleConfigElement.textContent = configured
    ? `クライアントID: 設定済み ／ 要求スコープ: ${DRIVE_SCOPE}`
    : 'クライアントID: 未設定。google-config.js の GOOGLE_CLIENT_ID を差し替えてください（OAUTH-001）。';

  connectButton.disabled = !configured;

  const connected = hasValidAccessToken();

  googleStateElement.textContent = connected
    ? '連携済み。トークンはメモリにのみ保持しています（タブを閉じると消えます）。'
    : '連携していません。';

  disconnectButton.hidden = !connected;
}

connectButton.addEventListener('click', async () => {
  if (connect.isBusy()) {
    return;
  }

  googleMessage.clear();
  connect.start();

  try {
    /*
     * ボタン押下から直接呼ぶ。あいだに await を挟むと、
     * ブラウザが「利用者操作に由来しない」と見なしてポップアップを塞ぐ。
     */
    await ensureAccessToken();

    googleMessage.show('連携しました。ドライブへのアクセスが許可されています。', 'success');
  } catch (error) {
    const described = describeDriveAuthError(error);
    googleMessage.show(`${described.text}（${described.errorCode}）`, 'error');
    googleMessage.focus();
  } finally {
    connect.stop();
    renderGoogleState();
  }
});

disconnectButton.addEventListener('click', () => {
  /*
   * 手元のトークンを捨てるだけ。Google 側の許可は取り消されない。
   * 完全に切るには利用者が Google アカウントの設定から外す必要がある
   * （要件定義書 FR-24 の「連携解除方法のマニュアル記載」）。
   */
  clearAccessToken();

  /*
   * 保存先IDのキャッシュも一緒に捨てる。**Drive 上の実体は消さない。**
   * 次に「保存構造を用意する」を押したとき、段階2の検索から復旧できることを
   * 確かめられるようにするため（計画 §5 の項目10）。
   */
  clearStorageCache();
  storageRunCount = 0;

  googleMessage.show('この画面の連携を解除しました。Google 側の許可は残っています。', 'info');
  renderGoogleState();
});

/*
 * 保存構造の用意（計画 §5 の項目9・10）。
 *
 * 1回目は作成、2回目以降は再発見になるのが正しい。
 * 2回目に created が出たら重複作成であり、不合格。
 */
async function runStorage() {
  const token = getCachedAccessToken();

  if (token === null) {
    driveMessage.show('先に「Googleと連携する」を押してください。（OAUTH-001）', 'error');
    driveMessage.focus();
    return;
  }

  driveMessage.clear();
  storage.start();

  try {
    /* 前回消し損ねた一時ドキュメントを先に片付ける（要件定義書 8.1 ステージ0 の5）。 */
    const orphans = await collectOrphanTempDocs({ token, fetchImpl: countingFetch });

    const result = await ensureStorage({ token, fetchImpl: countingFetch });

    storageRunCount += 1;
    renderStorage(result, orphans);

    storageAgainButton.hidden = false;

    const expected = storageRunCount === 1 ? '初回のため作成されていれば合格です。' : '2回目以降は cache か search になれば合格です。';

    driveMessage.show(`保存構造を用意しました。${expected}`, 'success');
  } catch (error) {
    const described = describeDriveError(error);
    driveMessage.show(`${described.text}（${described.errorCode}）`, 'error');
    driveMessage.focus();
  } finally {
    storage.stop();
  }
}

function renderStorage(result, orphans) {
  storageBody.replaceChildren();

  const labels = {
    root: 'TSAM AI（フォルダ）',
    app: '名刺データ（フォルダ）',
    images: 'images（フォルダ）',
    spreadsheet: '名刺管理（スプレッドシート）',
  };

  for (const [key, from] of Object.entries(result.steps)) {
    /*
     * 1回目は created でも search でもよい（既にある場合がある）。
     * 2回目以降に created が出たら重複作成であり不合格。
     */
    const ok = storageRunCount === 1 ? true : from !== 'created';

    addRow(storageBody, [labels[key] ?? key, from], ok);
  }

  storageTable.hidden = false;

  const sheetLink = document.createElement('a');
  sheetLink.href = spreadsheetUrl(result.spreadsheetId);
  sheetLink.target = '_blank';
  sheetLink.rel = 'noopener noreferrer';
  sheetLink.textContent = '作られたスプレッドシートを開く（新しいタブ）';

  storageLinks.replaceChildren(sheetLink);

  if (orphans.found > 0) {
    const note = document.createElement('span');
    note.textContent = ` ／ 孤児の一時ドキュメント: ${orphans.found}件見つけ、${orphans.deleted}件削除`;
    storageLinks.append(note);
  }
}

storageButton.addEventListener('click', runStorage);
storageAgainButton.addEventListener('click', runStorage);

/*
 * OCR の疎通（計画 §5 の項目11）。
 *
 * 画像は Drive へ保存しない。読み取って、一時ドキュメントを消すところまで。
 */
imageInput.addEventListener('change', async () => {
  const file = imageInput.files?.[0];

  if (!file) {
    return;
  }

  const token = getCachedAccessToken();

  if (token === null) {
    ocrStateElement.textContent = '先に「Googleと連携する」を押してください。（OAUTH-001）';
    return;
  }

  ocrStateElement.textContent = '読み取っています…（あなたのGoogleドライブを利用します）';
  ocrTextElement.hidden = true;

  const startedAt = Date.now();

  try {
    const result = await ocrImage({ token, blob: file, fetchImpl: countingFetch });
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

    ocrStateElement.textContent = [
      `読み取れました（${seconds}秒、試行${result.attempts}回、${result.text.length}文字）。`,
      result.deleted ? '一時ドキュメントは削除済みです。' : '★ 一時ドキュメントの削除に失敗しました。次回起動時に回収します。',
    ].join(' ');

    /* テキストは textContent で入れる。innerHTML を使わない（§14.3）。 */
    ocrTextElement.textContent = result.text;
    ocrTextElement.hidden = false;
  } catch (error) {
    const described = error?.name === 'OcrError'
      ? describeOcrError(error)
      : describeDriveError(error);

    ocrStateElement.textContent = `${described.text}（${described.errorCode}）`;
  } finally {
    /* 同じファイルを選び直せるようにする。 */
    imageInput.value = '';
  }
});

runButton.addEventListener('click', async () => {
  if (run.isBusy()) {
    return;
  }

  message.clear();

  const key = KeyStore.get(PROVIDERS.gemini);

  if (key === null) {
    message.show('Gemini APIキーが設定されていません。Portal で保存してください。（KEY-001）', 'error');
    message.focus();
    return;
  }

  run.start();

  try {
    /*
     * 2件を順に投げる。並列にしない。
     * 無料枠キーはレート上限が低く、同時に投げると 429 を招きやすい。
     */
    const ordered = await classifyCardText(SAMPLE_ORDERED, {
      apiKey: key,
      fetchImpl: countingFetch,
    });

    const shuffled = await classifyCardText(SAMPLE_SHUFFLED, {
      apiKey: key,
      fetchImpl: countingFetch,
    });

    renderClassification(orderedBody, ordered);
    renderClassification(shuffledBody, shuffled);

    const orderedUncertain = Array.isArray(ordered.uncertainFields) ? ordered.uncertainFields : [];
    const shuffledUncertain = Array.isArray(shuffled.uncertainFields) ? shuffled.uncertainFields : [];

    uncertainElement.textContent = `uncertainFields — 原稿順: ${orderedUncertain.join(', ') || 'なし'} / 入替: ${shuffledUncertain.join(', ') || 'なし'}`;

    geminiResultElement.hidden = false;
    message.show('実行しました。上の表で判定を確認してください。', 'success');
  } catch (error) {
    const described = describeGeminiError(error);
    message.show(`${described.text}（${described.errorCode}）`, 'error');
    message.focus();
  } finally {
    run.stop();
  }
});

async function start() {
  const user = await guardPage();

  if (!user) {
    /* guardPage が /login/ へ送る。ここで描画を止める。 */
    return;
  }

  loadingElement.hidden = true;
  contentElement.hidden = false;

  renderKeyState();
  renderGoogleState();
  renderSanitize();
  renderHosts();
}

start();

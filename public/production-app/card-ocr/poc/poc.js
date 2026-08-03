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

const message = createMessageArea(messageElement);
const run = createSubmitButton(runButton, { busyLabel: '実行しています…' });

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
  renderSanitize();
  renderHosts();
}

start();

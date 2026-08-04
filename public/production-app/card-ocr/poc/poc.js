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
  listModels,
  DEFAULT_MODEL,
  FALLBACK_MODEL,
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

import {
  MeasureStatus,
  buildRow,
  clearSession,
  downloadCsv,
  loadSession,
  recordRateLimit,
  saveSession,
  summarize,
} from './measurement.js';

import { GeminiErrorCode } from './gemini.js';

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

const detailElement = document.getElementById('poc-detail');
const modelsButton = document.getElementById('poc-models');
const modelsResultElement = document.getElementById('poc-models-result');
const modelsListElement = document.getElementById('poc-models-list');

const message = createMessageArea(messageElement);
const googleMessage = createMessageArea(googleMessageElement);

/*
 * 原因の要約を出す。
 *
 * **「SYS-999 不明なエラー」だけで終わらせない。** サーバーが返した理由や、
 * こちらのコードが投げた例外の名前を、そのまま見えるようにする。
 */
function showDetail(detail) {
  const text = String(detail ?? '').trim();

  if (text === '') {
    detailElement.hidden = true;
    detailElement.textContent = '';
    return;
  }

  detailElement.textContent = text;
  detailElement.hidden = false;
}
const driveMessage = createMessageArea(driveMessageElement);
const run = createSubmitButton(runButton, { busyLabel: '実行しています…' });
const connect = createSubmitButton(connectButton, { busyLabel: '連携しています…' });
const storage = createSubmitButton(storageButton, { busyLabel: '用意しています…' });

/* 何回目の実行か。2回目以降は「再発見」を期待する（計画 §5 の項目10）。 */
let storageRunCount = 0;

/* ---------- 測定モード（計画 §7） ---------- */

const measureStartInput = document.getElementById('poc-measure-start');
const measureIntervalInput = document.getElementById('poc-measure-interval');
const measureFilesInput = document.getElementById('poc-measure-files');
const measureRunButton = document.getElementById('poc-measure-run');
const measureStopButton = document.getElementById('poc-measure-stop');
const measureMessageElement = document.getElementById('poc-measure-message');
const measureProgressElement = document.getElementById('poc-measure-progress');
const measureSummaryElement = document.getElementById('poc-measure-summary');
const measureDownloadButton = document.getElementById('poc-measure-download');
const measureResetButton = document.getElementById('poc-measure-reset');
const measureTable = document.getElementById('poc-measure-table');
const measureBody = document.getElementById('poc-measure-body');
const measureRateLimitsElement = document.getElementById('poc-measure-ratelimits');

const measureMessage = createMessageArea(measureMessageElement);

/*
 * 測定した行は**メモリにだけ**持つ（要件定義書 §FR-21）。
 * ページを閉じれば消えるため、閉じる前のダウンロードを促す。
 */
let measureRows = [];
let measureSession = loadSession();
let measureRunning = false;
let measureStopRequested = false;

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

function renderMeasureState() {
  measureStartInput.value = String(measureSession.nextNo);
  measureDownloadButton.disabled = measureRows.length === 0;

  const summary = summarize(measureRows);

  measureProgressElement.textContent = measureRows.length === 0
    ? `まだ測定していません。次は ${measureSession.nextNo} 枚目からです。`
    : `このセッションで ${measureRows.length} 件。次は ${measureSession.nextNo} 枚目です。`;

  if (measureRows.length > 0) {
    const rate = summary.completionRate === null ? '—' : `${Math.round(summary.completionRate * 100)}%`;
    const median = summary.medianMs === null ? '—' : `${(summary.medianMs / 1000).toFixed(1)}秒`;
    const p95 = summary.p95Ms === null ? '—' : `${(summary.p95Ms / 1000).toFixed(1)}秒`;

    measureSummaryElement.textContent = [
      `成功 ${summary.ok} / 429 ${summary.rateLimited} / 失敗 ${summary.failed}`,
      `処理完了率 ${rate}（基準95%以上）`,
      `所要時間 中央値 ${median}（基準45秒以内） / 95パーセンタイル ${p95}（基準90秒以内）`,
    ].join(' ／ ');
  } else {
    measureSummaryElement.textContent = '';
  }

  const events = measureSession.rateLimitEvents;

  measureRateLimitsElement.textContent = events.length === 0
    ? ''
    : `429の記録（項目14）: ${events.map((e) => `${e.no}枚目 ${e.at}`).join(' / ')}`;
}

function appendMeasureRow(row) {
  measureRows.push(row);

  const seconds = row.total_ms === '' ? '—' : (Number(row.total_ms) / 1000).toFixed(1);
  const ok = row.status === MeasureStatus.OK;

  addRow(
    measureBody,
    [String(row.no), row.file_name, row.status, seconds, row.companyName || '—'],
    ok,
  );

  /* 直近20件だけ画面に残す。CSVには全件入る。 */
  while (measureBody.children.length > 20) {
    measureBody.firstElementChild?.remove();
  }

  measureTable.hidden = false;
  renderMeasureState();
}

function wait(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/*
 * 1枚を通しで測る。画像 → OCR → Gemini。
 *
 * 要件定義書 §13.1 の「読み取り開始〜確認画面表示」に相当する区間を
 * total_ms として測る。
 */
async function measureOne(file, no, { token, apiKey }) {
  const startedAt = Date.now();
  const recordedAt = new Date().toISOString();

  let ocrMs = null;
  let ocrChars = null;
  let ocrAttempts = null;

  try {
    const ocrResult = await ocrImage({ token, blob: file, fetchImpl: countingFetch });

    ocrMs = Date.now() - startedAt;
    ocrChars = ocrResult.text.length;
    ocrAttempts = ocrResult.attempts;

    const geminiStartedAt = Date.now();
    const fields = await classifyCardText(ocrResult.text, {
      apiKey,
      fetchImpl: countingFetch,
    });

    const geminiMs = Date.now() - geminiStartedAt;

    return buildRow({
      no,
      fileName: file.name,
      status: MeasureStatus.OK,
      recordedAt,
      totalMs: Date.now() - startedAt,
      ocrMs,
      geminiMs,
      ocrChars,
      ocrAttempts,
      fields,
    });
  } catch (error) {
    /*
     * 429 は測定を止める理由にならない。**項目14 の観測データ**として
     * 記録し、次の1枚へ進む（計画 §7-3）。
     */
    const rateLimited = error?.code === GeminiErrorCode.RATE_LIMITED;

    if (rateLimited) {
      const at = new Date().toTimeString().slice(0, 5);
      measureSession = recordRateLimit(measureSession, { no, at });
      saveSession(measureSession);
    }

    const described = error?.name === 'GeminiError'
      ? describeGeminiError(error)
      : (error?.name === 'OcrError' ? describeOcrError(error) : describeDriveError(error));

    let status = MeasureStatus.ERROR;

    if (rateLimited) {
      status = MeasureStatus.RATE_LIMITED;
    } else if (error?.name === 'OcrError') {
      status = MeasureStatus.OCR_EMPTY;
    }

    return buildRow({
      no,
      fileName: file.name,
      status,
      errorCode: described.errorCode,
      /* 原因の要約をCSVへ残す。あとから切り分けられるようにするため。 */
      errorDetail: described.detail ?? '',
      recordedAt,
      totalMs: Date.now() - startedAt,
      ocrMs,
      ocrChars,
      ocrAttempts,
    });
  }
}

measureRunButton.addEventListener('click', async () => {
  if (measureRunning) {
    return;
  }

  measureMessage.clear();

  const token = getCachedAccessToken();

  if (token === null) {
    measureMessage.show('先に「Googleと連携する」を押してください。（OAUTH-001）', 'error');
    measureMessage.focus();
    return;
  }

  const apiKey = KeyStore.get(PROVIDERS.gemini);

  if (apiKey === null) {
    measureMessage.show('Gemini APIキーが設定されていません。（KEY-001）', 'error');
    measureMessage.focus();
    return;
  }

  const files = [...(measureFilesInput.files ?? [])];

  if (files.length === 0) {
    measureMessage.show('名刺画像を選んでください。', 'error');
    measureMessage.focus();
    return;
  }

  /* ファイル名で並べる。01.jpg〜50.jpg なら通し番号と一致する。 */
  files.sort((a, b) => a.name.localeCompare(b.name, 'ja'));

  const startNo = Math.max(1, Math.floor(Number(measureStartInput.value) || 1));
  const intervalMs = Math.max(0, Math.floor(Number(measureIntervalInput.value) || 0)) * 1000;

  if (measureSession.startedAt === null) {
    measureSession = { ...measureSession, startedAt: new Date().toISOString() };
  }

  measureRunning = true;
  measureStopRequested = false;
  measureRunButton.disabled = true;
  measureStopButton.hidden = false;

  try {
    for (const [index, file] of files.entries()) {
      if (measureStopRequested) {
        measureMessage.show('中断しました。CSVをダウンロードしてください。', 'info');
        break;
      }

      const no = startNo + index;

      measureProgressElement.textContent = `${no} 枚目を測定中…（${index + 1}/${files.length}）`;

      const row = await measureOne(file, no, { token, apiKey });

      appendMeasureRow(row);

      measureSession = { ...measureSession, nextNo: no + 1 };
      saveSession(measureSession);

      /* 最後の1枚のあとは待たない。 */
      if (intervalMs > 0 && index < files.length - 1 && !measureStopRequested) {
        await wait(intervalMs);
      }
    }

    if (!measureStopRequested) {
      measureMessage.show('測定が終わりました。**CSVをダウンロードしてください。**', 'success');
    }
  } finally {
    measureRunning = false;
    measureStopRequested = false;
    measureRunButton.disabled = false;
    measureStopButton.hidden = true;
    measureFilesInput.value = '';
    renderMeasureState();
  }
});

measureStopButton.addEventListener('click', () => {
  measureStopRequested = true;
  measureProgressElement.textContent = '現在の1枚が終わったら止まります…';
});

measureDownloadButton.addEventListener('click', () => {
  if (measureRows.length === 0) {
    return;
  }

  downloadCsv(measureRows);
  measureMessage.show(`${measureRows.length} 件をCSVへ書き出しました。`, 'success');
});

measureResetButton.addEventListener('click', () => {
  if (measureRows.length > 0
    && !globalThis.confirm('未保存の測定結果があります。破棄してよろしいですか。')) {
    return;
  }

  clearSession();
  measureSession = loadSession();
  measureRows = [];
  measureBody.replaceChildren();
  measureTable.hidden = true;
  measureMessage.show('進行状況をリセットしました。', 'info');
  renderMeasureState();
});

/*
 * 未保存のまま閉じさせない。
 * 結果はメモリにしか無いため、閉じるとその回の測定が消える。
 */
globalThis.addEventListener('beforeunload', (event) => {
  if (measureRows.length === 0) {
    return;
  }

  event.preventDefault();
  /* 文言はブラウザ側で決まる。値を返すことが「引き止める」の合図。 */
  event.returnValue = '';
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
    showDetail('');
    message.show('実行しました。上の表で判定を確認してください。', 'success');
  } catch (error) {
    const described = describeGeminiError(error);

    message.show(`${described.text}（${described.errorCode}）`, 'error');

    /*
     * 原因の要約を必ず出す。エラーコードだけでは切り分けができない。
     * モデル名が疑わしいときは、次の操作も案内する。
     */
    const hint = described.errorCode === 'AI-005'
      ? '\n\n→「利用できるモデルを調べる」を押して、設定中のモデル名が一覧にあるか確認してください。'
      : '';

    showDetail(`${described.detail}${hint}`);
    message.focus();
  } finally {
    run.stop();
  }
});

/*
 * このキーで使えるモデルを調べる。
 *
 * 生成が失敗したときに「そもそもどのモデルが使えるのか」を、
 * 推測ではなく事実で確かめるための操作。
 * Portal の疎通テストと同じ GET なので、生成が壊れていても動く。
 */
modelsButton.addEventListener('click', async () => {
  message.clear();
  showDetail('');

  const key = KeyStore.get(PROVIDERS.gemini);

  if (key === null) {
    message.show('Gemini APIキーが設定されていません。（KEY-001）', 'error');
    message.focus();
    return;
  }

  try {
    const models = await listModels({ apiKey: key, fetchImpl: countingFetch });
    const usable = models.filter((model) => model.supportsGenerate);

    modelsListElement.replaceChildren();

    const configured = [DEFAULT_MODEL, FALLBACK_MODEL];

    for (const name of configured) {
      const found = usable.some((model) => model.name === name);
      const item = document.createElement('li');

      item.textContent = `設定中: ${name} — ${found ? '一覧にあります' : '★ 一覧にありません（404の原因）'}`;
      item.className = found ? 'poc-list__ok' : 'poc-list__ng';
      modelsListElement.append(item);
    }

    for (const model of usable) {
      const item = document.createElement('li');
      item.textContent = model.displayName ? `${model.name}（${model.displayName}）` : model.name;
      modelsListElement.append(item);
    }

    modelsResultElement.hidden = false;
    message.show(`generateContent を使えるモデルが ${usable.length} 件見つかりました。`, 'success');
  } catch (error) {
    const described = describeGeminiError(error);
    message.show(`${described.text}（${described.errorCode}）`, 'error');
    showDetail(described.detail);
    message.focus();
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
  renderMeasureState();
}

start();

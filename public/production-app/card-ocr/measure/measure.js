/*
 * 測定画面の制御（計画 §7）。
 *
 * ==================================================================
 * 本番のモジュールをそのまま使う
 * ==================================================================
 * capture / drive-ocr / gemini / extract / merge は **1つ上の階層**、
 * つまり利用者が使うのと同じ実装を import する。
 *
 * 検証用PoC は自前の複製を持っていたため、**測っていたのは PoC の実装で
 * あって本番の実装ではなかった。** ここを直すのがこの画面の目的である。
 * ==================================================================
 *
 * ==================================================================
 * 台帳へ書かない
 * ==================================================================
 * 測定は「読み取りと振り分けがどれだけ当たるか」を見るもので、
 * 登録ではない。台帳へ書くと、測定のたびに利用者のシートが汚れる。
 * 保存先の用意（ensureStorage）も呼ばない。
 *
 * 一時ドキュメントの置き場所は指定しない（マイドライブ直下に作られ、
 * すぐ消える）。孤児が残った場合は本体アプリの起動時に回収される。
 * ==================================================================
 */

import { setScreenDepth } from '../../../auth/config.js';
import { guardPage } from '../../../auth/session.js';
import { KeyStore, PROVIDERS } from '../../../auth/keystore.js';

import { describeCaptureError, shrinkToJpeg } from '../capture.js';
import { describeOcrError, joinSides, ocrBothSides } from '../drive-ocr.js';
import { classifyCardText, describeGeminiError, GeminiErrorCode } from '../gemini.js';
import { extractByPattern, prepareForGemini } from '../extract.js';
import { mergeExtraction } from '../merge.js';
import {
  clearAccessToken,
  describeDriveAuthError,
  ensureAccessToken,
  getCachedAccessToken,
  hasValidAccessToken,
} from '../drive-auth.js';

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

/* /production-app/card-ocr/measure/ はルートから3階層下。 */
setScreenDepth(3);

const el = {};

for (const id of [
  'mo-loading', 'mo-content', 'mo-setup', 'mo-run',
  'mo-side-mode', 'mo-category', 'mo-next-no', 'mo-count', 'mo-rate',
  'mo-connect', 'mo-download', 'mo-reset',
  'mo-front', 'mo-back-field', 'mo-back', 'mo-start', 'mo-result', 'mo-message',
]) {
  el[id] = document.getElementById(id);
}

/* 測った行。**メモリにだけ持つ**（§FR-21）。 */
let rows = [];
let session = loadSession();
let running = false;

function showMessage(text, kind = 'info') {
  el['mo-message'].textContent = text;
  el['mo-message'].dataset.kind = kind;
  el['mo-message'].hidden = text === '';
}

function renderStatus() {
  el['mo-next-no'].textContent = String(session.nextNo);
  el['mo-count'].textContent = String(rows.length);
  el['mo-rate'].textContent = `${session.rateLimitEvents.length}回`;

  el['mo-download'].disabled = rows.length === 0;
  el['mo-back-field'].hidden = el['mo-side-mode'].value !== 'both';

  const hasFront = Boolean(el['mo-front'].files?.[0]);
  el['mo-start'].disabled = running || !hasFront || !hasValidAccessToken();
  el['mo-run'].hidden = !hasValidAccessToken();
}

function renderResult(pairs) {
  const target = el['mo-result'];
  target.replaceChildren();

  for (const [label, value] of pairs) {
    const term = document.createElement('dt');
    term.className = 'co-status-label';
    term.textContent = label;

    const cell = document.createElement('dd');
    cell.className = 'co-status-value';
    cell.dataset.ok = 'yes';
    cell.textContent = value;

    target.append(term, cell);
  }
}

/* 1枚を測る。**時間はこの関数の中でだけ測る。** */
async function measureOne() {
  if (running) {
    return;
  }

  const frontFile = el['mo-front'].files?.[0] ?? null;

  if (!frontFile) {
    return;
  }

  running = true;
  renderStatus();
  showMessage('測定しています…');

  const no = session.nextNo;
  const sideMode = el['mo-side-mode'].value;
  const backFile = sideMode === 'both' ? (el['mo-back'].files?.[0] ?? null) : null;
  const startedAt = Date.now();

  let ocrMs = null;
  let geminiMs = null;
  let ocrResult = null;

  try {
    const front = await shrinkToJpeg(frontFile);
    const back = backFile ? await shrinkToJpeg(backFile) : null;

    const ocrStarted = Date.now();

    ocrResult = await ocrBothSides({
      token: getCachedAccessToken(),
      front: front.blob,
      back: back?.blob ?? null,
    });

    ocrMs = Date.now() - ocrStarted;

    const text = prepareForGemini(joinSides(ocrResult.front.text, ocrResult.back?.text ?? ''));
    const geminiStarted = Date.now();

    const ai = await classifyCardText(text, { apiKey: KeyStore.get(PROVIDERS.gemini) });

    geminiMs = Date.now() - geminiStarted;

    const merged = mergeExtraction(ai, extractByPattern(text));

    rows.push(buildRow({
      no,
      fileName: frontFile.name,
      category: el['mo-category'].value,
      sideMode,
      status: MeasureStatus.OK,
      recordedAt: new Date(startedAt).toISOString(),
      totalMs: Date.now() - startedAt,
      ocrMs,
      geminiMs,
      ocrChars: ocrResult.front.text.trim().length,
      ocrAttempts: ocrResult.front.attempts,
      hasBack: Boolean(ocrResult.back),
      backOcrChars: ocrResult.back ? ocrResult.back.text.trim().length : null,
      backErrorCode: ocrResult.backError ? describeOcrError(ocrResult.backError).errorCode : '',
      fields: merged.values,
      merged,
    }));

    renderResult([
      ['所要時間', `${Date.now() - startedAt}ms（OCR ${ocrMs} / Gemini ${geminiMs}）`],
      ['会社名', merged.values.companyName || '（なし）'],
      ['氏名', merged.values.fullName || '（なし）'],
      /*
       * **役職は全文を出す。** 実機で「執行役員 AI人材育成責任者」の
       * 後半が落ちる例が出たため、その場で気づけるようにしておく
       * （計画 §7-6 の観察項目）。
       */
      ['役職', merged.values.jobTitle || '（なし）'],
      ['要確認', merged.uncertainFields.join('、') || 'なし'],
      ['裏面から', merged.fromBackFields.join('、') || 'なし'],
    ]);

    showMessage(`${no}枚目を記録しました。**CSVを保存するまで残りません。**`);
  } catch (error) {
    const described = describeMeasureError(error);

    if (described.status === MeasureStatus.RATE_LIMITED) {
      session = recordRateLimit(session, { no, at: new Date().toISOString() });
    }

    rows.push(buildRow({
      no,
      fileName: frontFile.name,
      category: el['mo-category'].value,
      sideMode,
      status: described.status,
      errorCode: described.errorCode,
      errorDetail: described.detail,
      recordedAt: new Date(startedAt).toISOString(),
      totalMs: Date.now() - startedAt,
      ocrMs,
      geminiMs,
      hasBack: Boolean(ocrResult?.back),
    }));

    showMessage(`${no}枚目は失敗として記録しました（${described.errorCode}）: ${described.detail}`, 'error');
  } finally {
    session = saveSession({ ...session, nextNo: no + 1 });
    el['mo-front'].value = '';
    el['mo-back'].value = '';
    running = false;
    renderStatus();
  }
}

/* 失敗の種類を、CSVの status とエラーコードへ落とす。 */
function describeMeasureError(error) {
  if (error?.name === 'GeminiError') {
    const described = describeGeminiError(error);

    return {
      status: error.code === GeminiErrorCode.RATE_LIMITED
        ? MeasureStatus.RATE_LIMITED
        : MeasureStatus.ERROR,
      errorCode: described.errorCode,
      detail: described.detail || described.text,
    };
  }

  if (error?.name === 'OcrError') {
    const described = describeOcrError(error);
    return { status: MeasureStatus.OCR_EMPTY, errorCode: described.errorCode, detail: described.detail };
  }

  if (error?.name === 'CaptureError') {
    const described = describeCaptureError(error);
    return { status: MeasureStatus.ERROR, errorCode: described.errorCode, detail: described.detail };
  }

  const described = describeGeminiError(error);
  return { status: MeasureStatus.ERROR, errorCode: described.errorCode, detail: described.detail };
}

async function connect() {
  try {
    await ensureAccessToken();
    showMessage('');
  } catch (error) {
    const described = describeDriveAuthError(error);
    showMessage(`${described.text}（${described.errorCode}）`, 'error');
  }

  renderStatus();
}

el['mo-connect'].addEventListener('click', () => { void connect(); });
el['mo-start'].addEventListener('click', () => { void measureOne(); });
el['mo-front'].addEventListener('change', renderStatus);
el['mo-side-mode'].addEventListener('change', renderStatus);

el['mo-download'].addEventListener('click', () => {
  downloadCsv(rows);
  showMessage('CSVを保存しました。ドライブやリポジトリへは置かないでください。');
});

el['mo-reset'].addEventListener('click', () => {
  session = clearSession();
  rows = [];
  renderStatus();
  showMessage('進行状況を消しました。');
});

globalThis.addEventListener?.('pagehide', () => {
  clearAccessToken();
});

/* CSV を保存せずに閉じようとしたら止める。 */
globalThis.addEventListener?.('beforeunload', (event) => {
  if (rows.length > 0) {
    event.preventDefault();
    event.returnValue = '';
  }
});

(async function start() {
  const user = await guardPage({ next: 'portal' });

  if (!user) {
    return;
  }

  el['mo-loading'].hidden = true;
  el['mo-content'].hidden = false;

  const stats = summarize(rows);
  void stats;

  renderStatus();
}());

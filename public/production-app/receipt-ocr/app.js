/*
 * 領収書スキャナの画面制御（仕様書 §4 / §5 / §9 / §12）。
 *
 * ------------------------------------------------------------------
 * innerHTML を使わない（§13）
 * ------------------------------------------------------------------
 * XSS対策を最重要要件としている。領収書の文字列も Google の応答も
 * 外から来た値であり、テキストとして扱う。
 * 文字を入れるのは textContent、要素を作るのは createElement だけにする。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * ここに秘密を残さない
 * ------------------------------------------------------------------
 * OAuth トークンは oauth.js のクロージャにあり、この画面は
 * currentToken() を呼び出しの直前に取り出して渡すだけにする。
 * Gemini APIキーは KeyStore から読むが、有無しか画面へ出さない（§13）。
 * ------------------------------------------------------------------
 */

import { guardPage } from '../../auth/session.js';
import { setScreenDepth, screenPath } from '../../auth/config.js';
import { KeyStore, PROVIDERS } from '../../auth/keystore.js';

import { ACCEPTED_IMAGE_TYPES, SCREEN_DEPTH, isOauthConfigured } from './config.js';
import { AppError, GUIDE, PROGRESS, describeError } from './errors.js';
import { yearMonthPath, timestamp } from './datetime.js';
import { sha256OfBlob } from './hash.js';
import { createGateway } from './gateway.js';
import { NOTICE, PROVISION_STATUS, assertWritable, provision } from './provisioning.js';
import { ensureMonthFolder, uploadImage } from './drive.js';
import { currentToken, forgetToken, hasValidToken, requestAccess } from './oauth.js';

import { collectOrphans, recognize } from './ocr.js';
import { isHeic, shrinkToJpeg } from './image.js';
import { FALLBACK_SETTINGS, resolveSettings } from './settings.js';
import { extractAll, toValues } from './extract.js';
import { validateAll } from './validate.js';
import { levelOf, scoreOf } from './confidence.js';
import { decideCompletion, SKIP_REASON } from './completion-policy.js';
import { complete, reconcile } from './ai-complete.js';
import {
  applyEdits, buildRecord, buildReviewModel, conflictedAiValues, REVIEW_FIELDS,
} from './review.js';
import { DUPLICATE_COLUMN_KEYS, describeDuplicate, evaluateDuplicate, toRows } from './duplicate.js';
import { readDuplicateColumns } from './sheets.js';
import { newRecordId, saveRecord } from './record.js';
import { toDuplicateStatus } from './status.js';
import { TABS } from './schema.js';

setScreenDepth(SCREEN_DEPTH);

/* ---------- 要素 ---------- */

const el = {};

for (const id of [
  'ro-main', 'ro-first-run', 'ro-first-run-ack',
  'ro-state-auth', 'ro-state-oauth', 'ro-state-key', 'ro-state-storage',
  'ro-connect', 'ro-key-link', 'ro-capture-panel',
  'ro-file', 'ro-shrink', 'ro-preview', 'ro-preview-image',
  'ro-meta-name', 'ro-meta-folder',
  'ro-start', 'ro-message', 'ro-progress',
  'ro-review-panel', 'ro-review-lead', 'ro-review-image', 'ro-review-confidence',
  'ro-review-warnings', 'ro-review-fields', 'ro-duplicate',
  'ro-adopt-all-row', 'ro-adopt-all', 'ro-adopt-all-note',
  'ro-keep-review', 'ro-save', 'ro-cancel',
]) {
  el[id] = document.getElementById(id);
}

/* ---------- 画面へ出す ---------- */

function setState(node, text, kind = '') {
  node.textContent = text;
  node.dataset.kind = kind;
}

function clearMessage() {
  el['ro-message'].textContent = '';
  el['ro-message'].hidden = true;
  el['ro-progress'].textContent = '';
  el['ro-progress'].hidden = true;
}

function showInfo(text) {
  clearMessage();
  el['ro-message'].textContent = text;
  el['ro-message'].dataset.kind = 'info';
  el['ro-message'].hidden = false;
}

/*
 * すでに出ている案内へ書き足す。
 *
 * 起動時の掃除や設定の読み込みは、プロビジョニングの案内より後に終わる。
 * showInfo で上書きすると、**先に出した案内（保存先が複数あった等）が
 * 消える。** エラーが出ているときは何も足さない（エラーを潰さない）。
 */
function appendInfo(text) {
  const node = el['ro-message'];

  if (node.dataset.kind === 'error' && !node.hidden) {
    return;
  }

  if (!node.hidden && node.dataset.kind === 'info' && node.textContent !== '') {
    node.textContent = `${node.textContent} ${text}`;
    return;
  }

  showInfo(text);
}

/*
 * エラーを出す（§12）。
 * 「どこまで完了しているか」を必ず添える。
 */
function showError(error) {
  const code = error instanceof AppError ? error.code : 'SHEET-001';
  const progress = error instanceof AppError ? error.progress : PROGRESS.NONE;
  const described = describeError(code, { progress });

  clearMessage();

  el['ro-message'].textContent = `［${described.code}］${described.message}`;
  el['ro-message'].dataset.kind = 'error';
  el['ro-message'].hidden = false;

  el['ro-progress'].textContent = described.progressText;
  el['ro-progress'].hidden = false;

  if (described.guide === GUIDE.PORTAL_KEY) {
    el['ro-key-link'].hidden = false;
  }

  if (described.guide === GUIDE.REAUTH) {
    forgetToken();
    setState(el['ro-state-oauth'], '未連携', 'warn');
    el['ro-connect'].hidden = false;
  }
}

/* §9 の案内。notices の並びどおりに、追記していく。 */
const NOTICE_TEXT = Object.freeze({
  [NOTICE.NOT_RESTORED]: '保存先が見つかりませんでした。空の状態から開始します。過去のデータは復元されません。',
  [NOTICE.DUPLICATE_STRUCTURE]: '保存先が複数見つかりました。先に作られたほうを使います。新しいほうは使用しません（削除はしていません）。',
  [NOTICE.TABS_REPAIRED]: '不足していたタブを作り直しました。',
  [NOTICE.SCHEMA_UPGRADED]: 'シートに新しい列を追加しました。',
  [NOTICE.SCHEMA_ALTERED]: 'シートの列が変更されています。データを壊さないため書き込みを停止しました。新しいシートを作り直すか、列の並びを元に戻してください。',
});

function showNotices(notices) {
  const texts = notices
    .filter((notice) => notice !== NOTICE.FIRST_RUN)
    .map((notice) => NOTICE_TEXT[notice])
    .filter(Boolean);

  if (texts.length > 0) {
    showInfo(texts.join(' '));
  }
}

/* ---------- 状態 ---------- */

let provisionResult = null;
let selected = null;
let saving = false;
/* 保存前確認で人の判断を待っている1件（§8）。 */
let pending = null;
/*
 * 「設定」タブから読んだしきい値（v1.3 §16.6 / §9.1）。
 * 読めるまで、読めなかったときは既定値で動く（安全側）。
 */
let settings = FALLBACK_SETTINGS;

/* ---------- 第3層：Gemini キー（§4-3） ---------- */

/*
 * KeyStore は読むだけ。値は画面へ出さず、有無だけを見る（§13）。
 *
 * OCR方式が案A（既定）のときキーは必須ではない。
 * 未設定なら補完をスキップし、要確認として扱う（§4 末尾）。
 */
function checkGeminiKey() {
  const has = KeyStore.has(PROVIDERS.gemini);

  if (has) {
    setState(el['ro-state-key'], '設定済み', 'ok');
    el['ro-key-link'].hidden = true;
    return true;
  }

  /*
   * KEY-001 相当。案A（既定）ではキーが無くても動くので、止めずに案内だけ出す。
   *
   * 誘導先は Portal のキー設定画面。**戻り先は付けない。**
   * Portal 側にこのアプリへ戻す仕組みは無く、next を付けると
   * 「戻ってくるはず」と読める導線になってしまう。
   * 利用者はキーを保存したあと、Portal のアプリ一覧から入り直す。
   */
  setState(el['ro-state-key'], '未設定（AI補完なしで動作します）', 'warn');
  el['ro-key-link'].hidden = false;
  el['ro-key-link'].href = screenPath('portal');

  return false;
}

/* ---------- 第2層：OAuth（§4-2） ---------- */

async function connectDrive() {
  if (!isOauthConfigured()) {
    setState(el['ro-state-oauth'], '設定が未完了です', 'error');
    showError(new AppError('OAUTH-001', { detail: 'client_id_missing' }));
    return false;
  }

  try {
    await requestAccess();
    setState(el['ro-state-oauth'], '連携済み', 'ok');
    el['ro-connect'].hidden = true;
    return true;
  } catch (error) {
    showError(error);
    return false;
  }
}

/* ---------- 保存先の用意（§9） ---------- */

async function runProvisioning() {
  setState(el['ro-state-storage'], '確認しています…');

  try {
    const gateway = createGateway({ accessToken: currentToken() });
    provisionResult = await provision(gateway);

    if (!provisionResult.writable) {
      setState(el['ro-state-storage'], '書き込みを停止しています', 'error');
      showNotices(provisionResult.notices);
      el['ro-capture-panel'].hidden = true;
      return false;
    }

    const label = provisionResult.status === PROVISION_STATUS.CREATED
      ? '作成しました'
      : (provisionResult.status === PROVISION_STATUS.RECREATED ? '作り直しました' : '確認しました');

    setState(el['ro-state-storage'], label, 'ok');

    if (provisionResult.notices.includes(NOTICE.FIRST_RUN)) {
      el['ro-first-run'].hidden = false;
    }

    showNotices(provisionResult.notices);
    el['ro-capture-panel'].hidden = false;

    /*
     * 設定タブの反映と、前回の消し残しの掃除。
     * **どちらも失敗しても保存の邪魔をしない。** 既定値で動き、
     * 掃除は次回に持ち越せばよい（このあとの await は結果表示のため）。
     */
    await applySheetSettings(gateway, provisionResult.locations.spreadsheetId);
    await collectTempDocs();

    return true;
  } catch (error) {
    setState(el['ro-state-storage'], '確認できませんでした', 'error');
    showError(error);
    return false;
  }
}

/* ---------- 設定タブの反映（v1.3 §16.6 / v2.0 §9.1） ---------- */

/*
 * シートの「設定」タブを読み、しきい値を差し替える。
 *
 * ------------------------------------------------------------------
 * 読めなければ既定で動く。止めない
 * ------------------------------------------------------------------
 * 設定は補助であって、保存の前提ではない。ここで例外を上へ流すと、
 * 設定タブを消しただけの利用者が保存できなくなる。
 *
 * 一方、**読めたのに使わなかった値は黙って捨てない。** 利用者は
 * 「変えたつもり」で使い続けることになるため、名前だけを案内へ足す。
 * ------------------------------------------------------------------
 */
async function applySheetSettings(gateway, spreadsheetId) {
  try {
    const raw = await gateway.readSettings(spreadsheetId);
    settings = resolveSettings(raw);
  } catch {
    settings = FALLBACK_SETTINGS;
    appendInfo('シートの「設定」タブを読めませんでした。既定のしきい値で動作します。');
    return;
  }

  if (settings.ignored.length > 0) {
    appendInfo(`「設定」タブの次の値は読み取れないため既定値を使います：${settings.ignored.join('、')}。`);
  }
}

/*
 * 前回消し損ねた OCR 一時ドキュメントを片づける（§9.5・findings #6）。
 *
 * 一時ドキュメントには OCR で読み取った領収書の文字がそのまま入る。
 * 削除は通信断やタブを閉じた場面で失敗しうるので、
 * **回収する経路を持たないと、中身がドライブに残り続ける。**
 */
async function collectTempDocs() {
  try {
    const result = await collectOrphans({ accessToken: currentToken() });

    if (result.found > 0) {
      appendInfo(`前回の処理で残っていた一時ファイルを ${result.deleted}/${result.found} 件片づけました。`);
    }
  } catch {
    /* 掃除できなくても保存はできる。次回の起動に持ち越す。 */
  }
}

/* ---------- 画像の取得と SHA-256（§5-②） ---------- */

function revokePreview() {
  if (selected?.previewUrl) {
    URL.revokeObjectURL(selected.previewUrl);
  }
}

async function onFileSelected() {
  const file = el['ro-file'].files?.[0] ?? null;

  clearMessage();
  revokePreview();
  selected = null;
  el['ro-start'].disabled = true;
  el['ro-preview'].hidden = true;
  el['ro-review-panel'].hidden = true;

  if (!file) {
    return;
  }

  /*
   * HEIC は「非対応です」で終わらせない（card-ocr の案内を複製、2026-08-18）。
   * iPhone の既定形式であり、利用者は特別なことをした自覚がない。
   * その場で直せる道まで書く。
   */
  if (isHeic(file)) {
    showInfo('HEIC形式の写真は読み取れません。iPhone の「設定 › カメラ › フォーマット」を「互換性優先」にして撮り直すか、JPEG に変換してから選んでください。');
    return;
  }

  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
    showInfo('JPEG または PNG の画像を選んでください。');
    return;
  }

  const hash = await sha256OfBlob(file);

  if (hash === null) {
    /* 安全なコンテキストでないと Web Crypto が無い。重複判定だけを諦める。 */
    showInfo('この環境では重複の確認ができません。保存は行えます。');
  }

  const { year, month } = yearMonthPath();
  const previewUrl = URL.createObjectURL(file);

  selected = { file, hash, previewUrl, year, month };

  el['ro-preview-image'].src = previewUrl;
  el['ro-meta-name'].textContent = file.name;
  /*
   * ハッシュは画面に出さない（2026-08-19）。重複判定（§10）と保存する
   * 行の値には引き続き使うが、64桁の16進数は利用者が読む値でも直せる値でも
   * ない。計算できなかったことは上の showInfo が伝えている。
   */
  el['ro-meta-folder'].textContent = `原本 / ${year} / ${month}`;
  el['ro-preview'].hidden = false;
  el['ro-start'].disabled = false;
}

/* ---------- 縮小（§14 の最終項。既定は無効） ---------- */

/*
 * 実際に上げる画像を決める。
 *
 * ------------------------------------------------------------------
 * 既定では原本をそのまま上げる
 * ------------------------------------------------------------------
 * §14 は縮小を「オプションを設ける」と書いており、常時実行ではない。
 * 領収書の原本は後から見返す証跡であり、こちらの都合で既定の画質を
 * 落とすものではない（§0.3 のとおり電帳法の要件は満たさないが、
 * だからといって黙って劣化させてよいことにはならない）。
 *
 * 縮小できなかった場合も**保存は続ける。** 原本のままで困るのは
 * 通信の速さだけで、保存できないほうが利用者の損失は大きい。
 * ------------------------------------------------------------------
 *
 * 拡張子を .jpg へ付け替えるのは、縮小後が必ず JPEG になるため。
 * PNG の中身に .png の名前が付いていると、あとで開くときに混乱する。
 */
async function prepareUploadBlob() {
  const original = { blob: selected.file, name: selected.file.name, shrunk: false };

  if (!el['ro-shrink']?.checked) {
    return original;
  }

  showInfo('画像を縮小しています…');

  const result = await shrinkToJpeg(selected.file);

  if (!result.ok) {
    /*
     * この案内はすぐ次の状態表示で流れる。**それでよい。**
     * 縮小の可否は保存の成否に関わらず、あとから困ることでもない。
     */
    showInfo('画像を縮小できなかったため、元の画像のまま保存します…');
    return original;
  }

  return {
    blob: result.blob,
    name: selected.file.name.replace(/\.[A-Za-z0-9]+$/, '') + '.jpg',
    shrunk: true,
  };
}

/* ---------- ②〜⑦ 原本保存・OCR・抽出・検証・補完 ---------- */

/*
 * 「原本を保存して読み取る」の一連。
 *
 * 順序は §5 の①〜⑦に合わせてある。原本の保存を先に済ませるのは、
 * あとの工程で失敗しても画像だけは利用者の手元に残すためで、
 * §12 の「どこまで完了しているか」もこの順序を前提にしている。
 */
async function runPipeline() {
  if (saving || !selected || !provisionResult?.writable) {
    return;
  }

  saving = true;
  el['ro-start'].disabled = true;
  showInfo('原本を保存しています…');

  try {
    assertWritable(provisionResult);

    const accessToken = currentToken();

    /*
     * ③' 縮小（§14 の最終項）。**利用者が選んだときだけ。**
     *
     * 原本は証跡なので、既定では触らない。縮められなければ黙って原本を使う
     * （縮小に失敗したことを理由に保存できなくしない）。
     * 重複判定のハッシュは選ばれた元のファイルから取ってある（§10）。
     */
    const upload = await prepareUploadBlob();

    /* ④ 原本の保存。 */
    const monthFolder = await ensureMonthFolder({
      accessToken,
      originalsFolderId: provisionResult.locations.originalsFolderId,
      year: selected.year,
      month: selected.month,
    });

    /*
     * ファイル名にはハッシュの先頭を添える。
     * 同じ月に同名のレシートが並んでも見分けがつき、
     * ハッシュ列との突き合わせも目視でできる。
     */
    const suffix = selected.hash ? `-${selected.hash.slice(0, 12)}` : '';
    const name = `${timestamp().replace(/[: ]/g, '')}${suffix}-${upload.name}`;

    const uploaded = await uploadImage({
      accessToken,
      blob: upload.blob,
      name,
      parentId: monthFolder.id,
    });

    /* ③ 重複照合（ハッシュ列ほか、判定に要る列だけを取る）。 */
    showInfo('登録済みか確認しています…');

    const columns = await readDuplicateColumns(
      provisionResult.locations.spreadsheetId,
      DUPLICATE_COLUMN_KEYS,
      { accessToken, tabTitle: TABS.data },
    );

    /* ⑤ OCR。 */
    showInfo('文字を読み取っています…');

    const apiKey = KeyStore.get(PROVIDERS.gemini);
    const ocrResult = await recognize({
      blob: upload.blob,
      accessToken,
      apiKey,
      displayName: upload.name,
    });

    /* ⑥ ルール抽出・検証・信頼度。 */
    const extracted = extractAll(ocrResult.text);
    let values = {
      ...toValues(extracted),
      originalUrl: uploaded?.webViewLink ?? '',
    };

    /*
     * しきい値は「設定」タブの値を使う（v1.3 §16.6）。
     * 読めなかった項目は resolveSettings が既定へ落としてある。
     */
    let validation = validateAll(values, {
      lines: extracted.lines,
      tax: extracted.tax,
      limits: settings.limits,
    });

    /* ⑦ 必要なときだけ補完する（v1.3 §11）。 */
    const decision = decideCompletion({
      extracted,
      validation,
      ocrText: ocrResult.text,
      hasApiKey: Boolean(apiKey),
      /* 「Gemini使用」「OCR文字数の最低基準」も設定タブが持つ。 */
      geminiEnabled: settings.geminiEnabled,
      minOcrLength: settings.minOcrLength,
    });

    let reconciliation = null;
    let usedGemini = false;

    if (decision.run) {
      showInfo('読み取れなかった項目をAIで補っています…');

      const aiValues = await complete({ apiKey, ocrText: ocrResult.text });

      if (aiValues) {
        reconciliation = reconcile({ ruleValues: values, aiValues, ocrText: ocrResult.text });
        usedGemini = true;

        /* 突合の結果、採用された値を反映する。 */
        for (const [key, field] of Object.entries(reconciliation.fields)) {
          if (field.value !== '' && field.value !== values[key]) {
            values[key] = field.value;
          }
        }

        validation = validateAll(values, {
          lines: extracted.lines,
          tax: extracted.tax,
          limits: settings.limits,
        });
      }
    }

    const score = scoreOf({
      usedOn: extracted.usedOn,
      totalAmount: extracted.totalAmount,
      payee: extracted.payee,
      taxConsistent: validation.amount.taxConsistent,
      discountSkipped: validation.warnings.includes('値引きあり・検算省略'),
      agreements: agreementsOf(reconciliation),
    });

    /* 高・中の境目も設定タブが持つ（v1.3 §14）。 */
    const level = levelOf(score.score, settings.thresholds);
    const duplicate = evaluateDuplicate({ ...values, imageHash: selected.hash }, toRows(columns));

    pending = {
      values,
      extracted,
      validation,
      reconciliation,
      usedGemini,
      confidence: { score: score.score, level },
      duplicate,
      ocrText: ocrResult.text,
      original: { name, id: uploaded?.id ?? '', url: uploaded?.webViewLink ?? '' },
      skipReason: decision.reason,
    };

    renderReview();
  } catch (error) {
    showError(error);
  } finally {
    saving = false;
    el['ro-start'].disabled = false;
  }
}

/* 突合で「一致した」項目だけを、信頼度の加点材料へ渡す。 */
function agreementsOf(reconciliation) {
  const out = {};

  for (const [key, field] of Object.entries(reconciliation?.fields ?? {})) {
    out[key] = field.status === 'agreed';
  }

  return out;
}

/* ---------- ⑧ 保存前確認（§8） ---------- */

const editors = new Map();

function renderReview() {
  const model = buildReviewModel({
    values: pending.values,
    reconciliation: pending.reconciliation,
    confidenceLevel: pending.confidence.level,
    validation: pending.validation,
  });

  el['ro-review-image'].src = selected.previewUrl;

  el['ro-review-confidence'].textContent =
    `信頼度 ${pending.confidence.level}（${pending.confidence.score}点）／`
    + `${pending.usedGemini ? 'AI補完あり' : 'AI補完なし'}`
    + (pending.skipReason === SKIP_REASON.NO_API_KEY ? '（APIキー未設定のためスキップ）' : '')
    + (pending.skipReason === SKIP_REASON.OCR_TOO_SHORT ? '（文字が少ないため補完せず）' : '');

  el['ro-review-lead'].textContent = model.highlightCount > 0
    ? `${model.highlightCount}件の項目は確認が必要です。内容を見て、必要なら直してください。`
    : '読み取った内容です。保存する前にご確認ください。';

  /*
   * 検証の警告（§13）。項目に結び付かないものをここへ出す。
   * 項目ごとの警告は、その行の下に添える。
   */
  el['ro-review-warnings'].replaceChildren();
  el['ro-review-warnings'].hidden = model.generalWarnings.length === 0;

  for (const warning of model.generalWarnings) {
    const item = document.createElement('li');
    item.textContent = warning;
    el['ro-review-warnings'].append(item);
  }

  /* 行を作り直す。innerHTML は使わない（§13）。 */
  el['ro-review-fields'].replaceChildren();
  editors.clear();

  for (const row of model.rows) {
    const wrapper = document.createElement('div');
    wrapper.className = 'ro-field-row';

    if (row.highlight) {
      wrapper.dataset.highlight = 'true';
    }

    const label = document.createElement('label');
    label.className = 'ro-field-row__label';
    label.textContent = row.label + (row.required ? '（必須）' : '');
    label.htmlFor = `ro-edit-${row.key}`;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ro-field-row__input';
    input.id = `ro-edit-${row.key}`;
    input.value = row.value;

    wrapper.append(label, input);

    if (row.aiValue !== '') {
      const hint = document.createElement('p');
      hint.className = 'ro-field-row__hint';

      const label = document.createElement('span');
      label.textContent = `AIの読み取り: ${row.aiValue}（食い違っています）`;

      /*
       * 押しても入力欄へ入れるだけ。確定はしない。
       * 保存は下の保存ボタンを押したときだけ行う（§8）。
       */
      const adopt = document.createElement('button');
      adopt.type = 'button';
      adopt.className = 'ro-adopt';
      adopt.textContent = 'この値を使う';
      adopt.addEventListener('click', () => {
        input.value = row.aiValue;
        input.focus();
      });

      hint.append(label, adopt);
      wrapper.append(hint);
    }

    /* 検証の警告（未来日・金額の桁など）。値は消さず、理由だけ添える。 */
    for (const warning of row.warnings) {
      const hint = document.createElement('p');
      hint.className = 'ro-field-row__hint';
      hint.textContent = warning;
      wrapper.append(hint);
    }

    editors.set(row.key, input);
    el['ro-review-fields'].append(wrapper);
  }

  /* 食い違った項目をまとめて入れ替える導線（入力欄へ入れるだけ）。 */
  const aiValues = conflictedAiValues(pending.reconciliation);
  const conflictCount = Object.keys(aiValues).length;

  el['ro-adopt-all-row'].hidden = conflictCount === 0;
  el['ro-adopt-all-note'].textContent = conflictCount > 0
    ? `${conflictCount}件が食い違っています。押しても入力欄へ入るだけで、保存はされません。`
    : '';

  const described = describeDuplicate(pending.duplicate);

  el['ro-duplicate'].textContent = described.text;
  el['ro-duplicate'].hidden = described.text === '';
  el['ro-duplicate'].dataset.kind = described.canSave ? 'info' : 'error';

  /* 完全一致は保存させない（§10 / DUP-001）。 */
  el['ro-save'].disabled = !described.canSave;
  el['ro-keep-review'].checked = model.highlightCount > 0;

  clearMessage();
  el['ro-review-panel'].hidden = false;
  el['ro-capture-panel'].hidden = true;
}

/* ---------- ⑨ シートへ保存 ---------- */

async function saveToSheet() {
  if (saving || !pending) {
    return;
  }

  /* 多重押下による二重登録を防ぐ（§10 末尾）。 */
  saving = true;
  el['ro-save'].disabled = true;
  showInfo('シートに保存しています…');

  try {
    assertWritable(provisionResult);

    const edits = {};

    for (const [key, input] of editors) {
      edits[key] = input.value;
    }

    const applied = applyEdits(pending.values, edits, {
      fields: REVIEW_FIELDS,
      reconciliation: pending.reconciliation,
    });
    const now = timestamp();

    const record = buildRecord({
      values: applied.values,
      /* MANUAL になるのは打ち直しのときだけ。AI の値の採用は HYBRID。 */
      edited: applied.edited,
      usedRule: true,
      usedGemini: pending.usedGemini || applied.adoptedFromAi,
      validation: pending.validation,
      reconciliation: pending.reconciliation,
      confidence: pending.confidence,
      duplicateStatus: toDuplicateStatus(pending.duplicate.kind),
      keepReview: el['ro-keep-review'].checked,
      recordId: newRecordId(),
      imageHash: selected.hash ?? '',
      original: pending.original,
      now,
    });

    await saveRecord({
      accessToken: currentToken(),
      spreadsheetId: provisionResult.locations.spreadsheetId,
      record,
      ocrText: pending.ocrText,
    });

    el['ro-review-panel'].hidden = true;
    el['ro-capture-panel'].hidden = false;
    el['ro-file'].value = '';
    el['ro-preview'].hidden = true;
    pending = null;

    showInfo(`保存しました（管理ID: ${record.recordId}）。`);
  } catch (error) {
    showError(error);
  } finally {
    saving = false;
    el['ro-save'].disabled = false;
  }
}

function cancelReview() {
  pending = null;
  el['ro-review-panel'].hidden = true;
  el['ro-capture-panel'].hidden = false;
  clearMessage();
  showInfo('保存をやめました。原本画像はドライブに残っています。');
}

/* ---------- 起動 ---------- */

async function start() {
  /*
   * 第1層：TSAM AI 認証（§4-1）。
   * 共通実装の guardPage() を使う。独自実装は禁止。
   * 戻り値が利用者になるまで、保護対象の内容を描画しない。
   */
  const user = await guardPage({ next: 'portal' });

  if (!user) {
    /* すでに /login/ へ遷移している（AUTH-001 相当）。 */
    return;
  }

  el['ro-main'].hidden = false;
  setState(el['ro-state-auth'], 'ログイン済み', 'ok');

  checkGeminiKey();

  el['ro-first-run-ack'].addEventListener('click', () => {
    el['ro-first-run'].hidden = true;
  });

  el['ro-connect'].addEventListener('click', async () => {
    if (await connectDrive()) {
      await runProvisioning();
    }
  });

  el['ro-file'].addEventListener('change', () => {
    onFileSelected().catch(showError);
  });

  el['ro-start'].addEventListener('click', () => {
    runPipeline().catch(showError);
  });

  el['ro-save'].addEventListener('click', () => {
    saveToSheet().catch(showError);
  });

  el['ro-cancel'].addEventListener('click', cancelReview);

  /*
   * 食い違った項目をまとめて AI の読み取りに入れ替える。
   * 入力欄へ入れるだけで、保存はしない。入れたあと手で直してもよい。
   */
  el['ro-adopt-all'].addEventListener('click', () => {
    if (!pending) {
      return;
    }

    const aiValues = conflictedAiValues(pending.reconciliation);
    let filled = 0;

    for (const [key, value] of Object.entries(aiValues)) {
      const input = editors.get(key);

      if (input) {
        input.value = value;
        filled += 1;
      }
    }

    showInfo(`${filled}件をAIの読み取りに置き換えました。内容を確かめてから保存してください。`);
  });

  globalThis.addEventListener('pagehide', () => {
    /* 画面を離れるときにトークンとプレビューを捨てる。 */
    forgetToken();
    revokePreview();
  });

  if (hasValidToken()) {
    await runProvisioning();
  }
}

start().catch(showError);

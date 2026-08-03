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
import { NOTICE, PROVISION_STATUS, provision } from './provisioning.js';
import { ensureMonthFolder, uploadImage } from './drive.js';
import { currentToken, forgetToken, hasValidToken, requestAccess } from './oauth.js';

setScreenDepth(SCREEN_DEPTH);

/* ---------- 要素 ---------- */

const el = {};

for (const id of [
  'ro-main', 'ro-first-run', 'ro-first-run-ack',
  'ro-state-auth', 'ro-state-oauth', 'ro-state-key', 'ro-state-storage',
  'ro-connect', 'ro-key-link', 'ro-capture-panel',
  'ro-file', 'ro-preview', 'ro-preview-image',
  'ro-meta-name', 'ro-meta-hash', 'ro-meta-folder',
  'ro-save-original', 'ro-message', 'ro-progress',
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

    return true;
  } catch (error) {
    setState(el['ro-state-storage'], '確認できませんでした', 'error');
    showError(error);
    return false;
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
  el['ro-save-original'].disabled = true;
  el['ro-preview'].hidden = true;

  if (!file) {
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
  el['ro-meta-hash'].textContent = hash ?? '（計算できません）';
  el['ro-meta-folder'].textContent = `原本 / ${year} / ${month}`;
  el['ro-preview'].hidden = false;
  el['ro-save-original'].disabled = false;
}

/* ---------- 原本の保存（§5-④） ---------- */

async function saveOriginal() {
  /* 多重押下による二重登録を防ぐ（§10 末尾）。 */
  if (saving || !selected || !provisionResult?.writable) {
    return;
  }

  saving = true;
  el['ro-save-original'].disabled = true;
  showInfo('保存しています…');

  try {
    const accessToken = currentToken();

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
    const name = `${timestamp().replace(/[: ]/g, '')}${suffix}-${selected.file.name}`;

    const uploaded = await uploadImage({
      accessToken,
      blob: selected.file,
      name,
      parentId: monthFolder.id,
    });

    clearMessage();
    showInfo('原本を保存しました。読み取りはフェーズ2で追加します。');

    el['ro-meta-folder'].textContent = `原本 / ${selected.year} / ${selected.month}（保存済み・${uploaded?.id ? 'ID取得済み' : 'ID不明'}）`;
  } catch (error) {
    showError(error);
  } finally {
    saving = false;
    el['ro-save-original'].disabled = false;
  }
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

  el['ro-save-original'].addEventListener('click', () => {
    saveOriginal().catch(showError);
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

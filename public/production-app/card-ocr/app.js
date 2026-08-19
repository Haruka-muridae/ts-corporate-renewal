/*
 * 名刺OCRアプリの画面制御（SC-00 まで）。
 *
 * ==================================================================
 * このページが守ること
 * ==================================================================
 *   - guardPage() を必ず通す。Portal の一覧に載せていなくても、
 *     URLを知っていれば開けるため。
 *   - キーは KeyStore の有無だけを見る。**値を読まない・画面へ出さない。**
 *     localStorage を直接触らない（keystore-spec-v1.md §2-1）。
 *   - innerHTML を使わない（要件定義書 §10.2）。
 *   - 外部通信は §12 の3系統のみ。この段階では Google の認可だけを使う。
 *   - テスト環境（public/apps/）と検証用PoC（poc/）から import しない。
 * ==================================================================
 *
 * 判別そのものは prerequisites.js にある。**ここは画面への反映だけ。**
 * DOM を持たない側にロジックを寄せておくと、テストで画面を組み立てずに
 * 済む。
 */

import { setScreenDepth, screenPath } from '../../auth/config.js';
import { guardPage } from '../../auth/session.js';
import { KeyStore, PROVIDERS, isKeyStoreAvailable } from '../../auth/keystore.js';

import { isClientIdConfigured } from './config.js';
import {
  clearAccessToken,
  describeDriveAuthError,
  ensureAccessToken,
  getCachedAccessToken,
  hasValidAccessToken,
} from './drive-auth.js';

import {
  Guidance,
  Prerequisite,
  buildStatusList,
  describePrerequisite,
  evaluatePrerequisites,
} from './prerequisites.js';

import { describeDriveError } from './drive-api.js';
import { StorageNotice, ensureStorage } from './drive-storage.js';
import { spreadsheetUrl } from './sheets.js';

import {
  collectOrphanTempDocs,
  describeOcrError,
  joinSides,
  ocrBothSides,
} from './drive-ocr.js';

import { classifyCardText, describeGeminiError } from './gemini.js';
import { registerCard } from './register.js';
import {
  MAX_GEMINI_INPUT_LENGTH,
  extractByPattern,
  normalizeText,
  prepareForGemini,
} from './extract.js';
import {
  MULTILINE_FIELDS,
  VALUE_FIELDS,
  fieldsNeedingReview,
  mergeExtraction,
} from './merge.js';

import { describeCaptureError, shrinkToJpeg } from './capture.js';
import {
  CaptureStep,
  clearAll,
  clearBack,
  createCaptureState,
  currentStep,
  describeStep,
  setBack,
  setFront,
  skipBack,
  wantBack,
} from './capture-flow.js';

/* /production-app/card-ocr/ はサイトのルートから2階層下。 */
setScreenDepth(2);

const el = {};

for (const id of [
  'co-loading', 'co-content', 'co-status',
  'co-prep', 'co-prep-summary',
  'co-guidance', 'co-guidance-title', 'co-guidance-text',
  'co-login-link', 'co-portal-link', 'co-connect',
  'co-ready', 'co-disconnect', 'co-message',
  'co-storage', 'co-storage-state', 'co-storage-notices',
  'co-sheet-link',
  'co-capture', 'co-capture-title', 'co-capture-text',
  'co-front-field', 'co-front-input', 'co-back-field', 'co-back-input',
  'co-ask-back', 'co-skip-back', 'co-want-back',
  'co-previews', 'co-start-actions', 'co-start', 'co-reset',
  'co-ocr', 'co-ocr-state', 'co-ocr-sides',
  'co-fields', 'co-fields-state', 'co-fields-list', 'co-fields-notes',
  'co-register', 'co-saved', 'co-saved-title', 'co-saved-list', 'co-saved-sheet', 'co-next',
  'co-duplicate', 'co-duplicate-title', 'co-duplicate-text',
  'co-duplicate-diff-title', 'co-duplicate-diff', 'co-duplicate-note',
  'co-update', 'co-register-anyway', 'co-duplicate-cancel',
]) {
  el[id] = document.getElementById(id);
}

/* guardPage() が返した利用者。未ログインならここへ来ない。 */
let signedIn = false;
/* 連携の処理中。ポップアップを二重に開かせない。 */
let connecting = false;
/* 保存構造の用意の結果。null は「まだ確認していない」。 */
let storage = null;
/* 用意の処理中。連続で押されても1回にする。 */
let provisioning = false;
/*
 * 撮影の状態（capture-flow.js）。
 * **画像はここにしか持たない。** localStorage へ書かない（§FR-21）。
 */
let capture = createCaptureState();
/* 前処理の実行中。処理が終わる前に次を選ばせない。 */
let processing = false;
/* OCR の実行中。二重送信を防ぐ。 */
let reading = false;
/*
 * 読み取ったテキスト。**メモリにしか持たない**（§FR-21）。
 * 画面にも本文は出さない（下の renderOcr を参照）。
 */
let ocrText = '';
/* 突き合わせた結果（merge.js）。null は「まだ分類していない」。 */
let merged = null;
/* 登録の実行中。二重送信を防ぐ。 */
let registering = false;
/*
 * 重複していた既存行（FR-17）。null は「重複していない」。
 * **record_id しか持たない。** 行番号は書く直前に引き直す
 * （register.js の locateRowByRecordId）。画面を見ている間に
 * 利用者が行を消せば、番号のほうは当てにならない。
 */
let duplicateTarget = null;

/* 画面に出す項目名。台帳の見出しとは別に、ここで日本語にする。 */
const FIELD_LABELS = Object.freeze({
  companyName: '会社名',
  departmentName: '部署名',
  jobTitle: '役職',
  fullName: '氏名',
  fullNameKana: '氏名カナ',
  postalCode: '郵便番号',
  address: '住所',
  phone: '電話番号',
  mobile: '携帯番号',
  fax: 'FAX',
  email: 'メールアドレス',
  url: 'URL',
  otherInformation: 'その他（どの項目にも入らなかった内容）',
});

/* ---------- 「準備」の折りたたみ ---------- */

/*
 * ==================================================================
 * 折りたたみは1枚だけにする（2026-08-19 に平坦化）
 * ==================================================================
 * 以前は「準備」の <details> の中に「ご利用の前に」「準備の状況」
 * 「保存先」の3枚を入れ子にしていた。**開く操作が2回必要**で、
 * どの中身がどこにあるのかを覚えていないと辿り着けなかった。
 *
 * いまは「準備」1枚に中身を並べ、開閉の判断もここ1か所に集約する。
 * 「ご利用の前に」は準備作業ではないので、この外に兄弟として置いた
 * （§5.3 の「既定は閉」を守るためでもある。index.html のコメント）。
 * ==================================================================
 *
 * ==================================================================
 * 畳むのは「すべて正常」と分かったときだけ
 * ==================================================================
 * 準備の状況・保存先は、**問題があるときにこそ見えていないと困る**。
 * そこで既定を「開く」にし、正常だと確かめられた場合だけ畳む。
 *
 * この向きにしておくと、判定を書き忘れた経路や、JavaScript が途中で
 * 落ちた場合でも、**畳まれたまま残ることがない。**
 * 「畳まれていて気づかない」を作らないための取り決めである。
 *
 * 誘導（co-guidance）は「準備」の外に置いてあるので、ここでは触らない。
 * ==================================================================
 */
function setPanelOpen(id, open) {
  el[id].open = open;
}

/* 見出しに状態を添える。閉じていても何が起きているか分かるように。 */
function setSummary(id, base, detail) {
  el[id].textContent = detail ? `${base} — ${detail}` : base;
}

/*
 * 開閉の判断材料。
 *
 * **DOM の open を読んで決めない。** 入れ子をやめた結果、中の状態を
 * 保持する要素が無くなった。ここに写しを持ち、applyPrepPanel() が
 * これだけを見て決める（判断が1か所に閉じる）。
 *
 * storage が null なのは「まだ確認していない」。判断材料にしない。
 */
const prepFacts = { allReady: false, storage: null };

/*
 * 3つの前提の状態を控える。
 *
 * すべて完了なら畳み、1つでも欠けていれば開く（SC-00 の動作は変えない。
 * 誘導そのものは render() が「準備」の外へ出す）。
 */
function applyStatusPanel(allReady) {
  prepFacts.allReady = allReady;
}

/*
 * 保存先の状態を控える。
 *
 * **異常のときは必ず開く。** 作成直後も開く（初めて作られたことは
 * 知らせる価値がある。§5.3 の最後の項）。
 * 見えている文言そのものは、呼び出し側が co-storage-state へ入れている。
 */
function applyStoragePanel({ ok, hasNotices }) {
  prepFacts.storage = { ok, hasNotices };
}

/*
 * 「準備」をどうするか。
 *
 * **中に1つでも気にすべきことがあれば開く。** 中で警告を出しているのに
 * 畳まれていては意味がない。
 */
function applyPrepPanel() {
  const storageNeedsCare = prepFacts.storage !== null
    && (!prepFacts.storage.ok || prepFacts.storage.hasNotices);
  const needsCare = !prepFacts.allReady || storageNeedsCare;

  setSummary('co-prep-summary', '準備', needsCare ? '確認が必要です' : 'すべて完了');
  setPanelOpen('co-prep', needsCare);
}

/* ---------- 表示の道具（innerHTML を使わない） ---------- */

function showMessage(text, kind = 'info') {
  el['co-message'].textContent = text;
  el['co-message'].dataset.kind = kind;
  el['co-message'].hidden = text === '';
}

function clearMessage() {
  showMessage('');
}

/*
 * ドライブの失敗を、切り分けられる形の文にする。
 *
 * ==================================================================
 * DRV-001 だけを出さない
 * ==================================================================
 * §15 のコードは7つの内部コード（FORBIDDEN / BAD_REQUEST /
 * RATE_LIMITED / SERVER_ERROR / STORAGE_FULL / NETWORK / UNKNOWN）を
 * DRV-001 に集約している。**「DRV-001」とだけ出す画面では、
 * 待てばよいのか、設定を直すのか、こちらの不具合なのかが分からない。**
 *
 * そこで **内部コードと、サーバーが返した理由（HTTPステータス込み）を
 * 必ず添える。** 表示コードは §15 のまま増やさない。
 * ==================================================================
 */
function formatDriveError(error) {
  const described = describeDriveError(error);
  const parts = [`${described.text}（${described.errorCode} / ${described.code}）`];

  if (described.detail) {
    parts.push(described.detail);
  }

  return parts.join(' / ');
}

function renderStatus(list) {
  const target = el['co-status'];
  target.replaceChildren();

  for (const item of list) {
    const term = document.createElement('dt');
    term.className = 'co-status-label';
    term.textContent = item.label;

    const value = document.createElement('dd');
    value.className = 'co-status-value';
    value.dataset.ok = item.ok ? 'yes' : 'no';
    value.textContent = item.text;

    target.append(term, value);
  }
}

/* ---------- 前提の判別と反映 ---------- */

function collectFacts() {
  const keyStoreAvailable = isKeyStoreAvailable();

  return {
    signedIn,
    keyStoreAvailable,
    /*
     * **has() だけを呼ぶ。** 値そのものは、実際に Gemini を呼ぶ
     * 場面まで取り出さない。画面の描画に鍵の中身は要らない。
     */
    hasGeminiKey: keyStoreAvailable && KeyStore.has(PROVIDERS.gemini),
    clientIdConfigured: isClientIdConfigured(),
    googleLinked: hasValidAccessToken(),
  };
}

function render() {
  const facts = collectFacts();
  const state = evaluatePrerequisites(facts);
  const described = describePrerequisite(state);

  renderStatus(buildStatusList(facts));

  /* 誘導は毎回すべて隠してから、該当する1つだけを出す。 */
  el['co-login-link'].hidden = true;
  el['co-portal-link'].hidden = true;
  el['co-connect'].hidden = true;

  applyStatusPanel(state === Prerequisite.READY);

  if (state === Prerequisite.READY) {
    el['co-guidance'].hidden = true;
    el['co-ready'].hidden = false;
    applyPrepPanel();
    return state;
  }

  /* 連携が切れたら保存構造の表示も畳む。古い結果を残さない。 */
  storage = null;
  el['co-storage'].hidden = true;
  el['co-ready'].hidden = true;
  /* 隠した以上、開閉の判断材料からも外す（消えた表示で開いたままにしない）。 */
  prepFacts.storage = null;

  /*
   * **前提が欠けたら「準備」を開く。** トークンが切れた場面がここに当たる。
   * 誘導は外に出るが、状況の一覧も一緒に見せる。
   */
  applyPrepPanel();
  el['co-guidance'].hidden = false;
  el['co-guidance-title'].textContent = described.title;
  el['co-guidance-text'].textContent = described.text;

  switch (described.guidance) {
    case Guidance.LOGIN:
      el['co-login-link'].href = screenPath('login');
      el['co-login-link'].hidden = false;
      break;
    case Guidance.PORTAL:
      /*
       * 戻り先（next）を付けない。Portal 側に本アプリへ戻す仕組みが
       * 無く、付けると「戻ってくるはず」と読める導線になる。
       * 戻り方は文言で示している（FR-25 の3、prerequisites.js）。
       */
      el['co-portal-link'].href = screenPath('portal');
      el['co-portal-link'].hidden = false;
      break;
    case Guidance.CONNECT:
      el['co-connect'].hidden = false;
      break;
    default:
      break;
  }

  return state;
}

/* ---------- 保存構造の用意（§8.1 ステージ0） ---------- */

/*
 * 案内の文言。**「作った」と「作り直した」を区別する。**
 * 作り直しは過去データが戻らないので、黙って進めてはいけない
 * （要件定義書 §5.3 の最後の項）。
 */
const NOTICE_TEXT = Object.freeze({
  [StorageNotice.CREATED]: '保存先を作成しました（マイドライブ／TSAM AI／名刺データ）。',
  [StorageNotice.RECREATED]: '保存先が見つからなかったため、新しく作り直しました。過去のデータは引き継がれません。',
  [StorageNotice.TABS_REPAIRED]: '不足していたシートのタブを作り直しました。',
  [StorageNotice.SCHEMA_UPGRADED]: 'シートに新しい列を追加しました。',
  [StorageNotice.SCHEMA_ALTERED]: 'シートの見出しが変更されているため、書き込みを停止しました。見出しを元に戻すか、シートの名前を変えて作り直してください。',
});

function renderNotices(notices) {
  const target = el['co-storage-notices'];
  target.replaceChildren();

  for (const notice of notices) {
    const text = NOTICE_TEXT[notice];

    if (!text) {
      continue;
    }

    const item = document.createElement('li');
    item.textContent = text;
    item.dataset.notice = notice;
    target.append(item);
  }

  target.hidden = target.childElementCount === 0;
}

async function prepareStorage() {
  if (provisioning) {
    return;
  }

  provisioning = true;
  el['co-storage'].hidden = false;
  el['co-storage-state'].textContent = '確認しています…';
  el['co-storage-state'].dataset.ok = 'pending';
  el['co-sheet-link'].hidden = true;
  renderNotices([]);

  /* 確認中は開いておく。終わってから畳むか決める。 */
  applyStoragePanel({ ok: false, hasNotices: false });
  applyPrepPanel();

  try {
    storage = await ensureStorage({ token: getCachedAccessToken() });

    renderNotices(storage.notices);

    if (!storage.writable) {
      el['co-storage-state'].textContent = '書き込みを停止しています';
      el['co-storage-state'].dataset.ok = 'no';
      el['co-capture'].hidden = true;

      /* **異常。開いたままにする。** */
      applyStoragePanel({ ok: false, hasNotices: true });
      applyPrepPanel();
      return;
    }

    const label = storage.steps.spreadsheet === 'created' ? '作成しました' : '確認しました';

    el['co-storage-state'].textContent = label;
    el['co-storage-state'].dataset.ok = 'yes';

    /*
     * 作成・作り直し・タブの補修などが起きた回は開く（§5.3 の最後の項）。
     * **何も起きていない回だけ畳む。**
     */
    applyStoragePanel({ ok: true, hasNotices: storage.notices.length > 0 });

    el['co-sheet-link'].href = spreadsheetUrl(storage.spreadsheetId);
    el['co-sheet-link'].hidden = false;

    /* 保存先が用意できてから撮影へ進ませる（§8.1 ステージ0 → 1）。 */
    el['co-capture'].hidden = false;
    renderCapture();

    /* 掃除は撮影を出したあとに回す。待たせる理由がない。 */
    void collectOrphans();
  } catch (error) {
    storage = null;
    el['co-storage-state'].textContent = '確認できませんでした';
    el['co-storage-state'].dataset.ok = 'no';

    /* **失敗。開いたままにする。** */
    applyStoragePanel({ ok: false, hasNotices: true });

    showMessage(formatDriveError(error), 'error');
  } finally {
    provisioning = false;

    /*
     * **最後に必ず親を決め直す。** どの経路を通っても、中の状態と
     * 親の開閉が食い違わないようにする。
     */
    applyPrepPanel();
  }
}

/* ---------- 撮影・前処理（SC-01 / SC-02） ---------- */

function renderPreviews() {
  const target = el['co-previews'];
  target.replaceChildren();

  for (const side of ['front', 'back']) {
    const image = capture[side];

    if (!image) {
      continue;
    }

    const figure = document.createElement('figure');
    figure.className = 'co-preview';
    figure.dataset.side = side;

    const picture = document.createElement('img');
    picture.className = 'co-preview-image';
    picture.src = image.dataUrl;
    /*
     * 名刺の中身を代替テキストに出さない。読み上げても意味が無く、
     * 第三者の個人情報が別の経路へ出る口を増やすだけである。
     */
    picture.alt = side === 'front' ? '表面のプレビュー' : '裏面のプレビュー';

    const caption = document.createElement('figcaption');
    caption.className = 'co-preview-caption';
    caption.textContent = `${side === 'front' ? '表面' : '裏面'}／`
      + `${image.width}×${image.height}px／`
      + `${Math.round(image.bytes / 1024)}KB`;

    const actions = document.createElement('div');
    actions.className = 'co-preview-actions';

    const rotate = document.createElement('button');
    rotate.type = 'button';
    rotate.className = 'auth-button auth-button--ghost';
    rotate.textContent = '回転';
    rotate.addEventListener('click', () => { void rotateSide(side); });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'auth-button auth-button--ghost';
    remove.textContent = side === 'front' ? '選び直す' : '裏面を取り消す';
    remove.addEventListener('click', () => { removeSide(side); });

    actions.append(rotate, remove);
    figure.append(picture, caption, actions);
    target.append(figure);
  }
}

function renderCapture() {
  const step = currentStep(capture);
  const described = describeStep(step);

  el['co-capture-title'].textContent = described.title;
  el['co-capture-text'].textContent = described.text;

  /* いま撮る面だけを出す（§FR-03「1画面に2つの入力欄を並べない」）。 */
  el['co-front-field'].hidden = step !== CaptureStep.FRONT;
  el['co-back-field'].hidden = step !== CaptureStep.BACK;
  el['co-ask-back'].hidden = step !== CaptureStep.ASK_BACK;
  el['co-start-actions'].hidden = step !== CaptureStep.READY;

  el['co-start'].disabled = step !== CaptureStep.READY || reading;

  renderPreviews();
}

/* ---------- 読み取り（Drive OCR。§8.1 ステージ2） ---------- */

/*
 * 面ごとの結果を出す。
 *
 * **読み取った本文を画面に出さない。** 名刺は第三者の個人情報で、
 * 画面に出す必要が無い。出すのは「何文字読めたか」だけにする。
 * 項目に振り分けたものは確認画面（SC-04）で見せる。
 *
 * ==================================================================
 * 内部の事情は画面に書かない（2026-08-19）
 * ==================================================================
 * 以前はここに「表面の再試行 2回目で成功」「Geminiへ渡すテキスト
 * N文字」「一時ファイル 消し切れませんでした」の3行も出していた。
 * **いずれも利用者が何かを判断するための情報ではない。**
 * 再試行と一時ファイル（次回起動時に collectOrphans が回収する）は
 * こちらの後始末の話であり、Gemini へ渡す文字数は §FR-11 の入力上限
 * （2,000文字）の目視確認という開発中の都合だった
 * （要件定義書 v3.6 で画面から外すと決めた）。
 *
 * **console へも落とさない。** このアプリは「読み取った本文や鍵が
 * ログへ出る道を1本も作らない」ことをテストで固定してあり
 * （tests/unit/card-ocr.mjs の「console へ出していない」）、
 * 診断のためにその約束を緩めない。
 *
 * 残すのは**上限を超えたときの1行だけ**。切り捨てで項目が欠けうる、
 * つまり利用者が結果を確かめる理由がある場合である。
 * ==================================================================
 */
function renderOcr(result) {
  const target = el['co-ocr-sides'];
  target.replaceChildren();

  const rows = [
    { label: '表面', value: `${result.front.text.trim().length}文字`, ok: true },
  ];

  if (result.back) {
    rows.push({ label: '裏面', value: `${result.back.text.trim().length}文字`, ok: true });
  } else if (result.backError) {
    const described = describeOcrError(result.backError);
    rows.push({ label: '裏面', value: `読み取れませんでした（${described.errorCode}）`, ok: false });
  }

  /*
   * §FR-11 の入力上限。**超えた回だけ**知らせる。
   * 切り捨てが起きると、拾えない項目が出うるためである。
   */
  /*
   * 判定は**正規化したあとの長さ**で行う。normalizeText() が重複行と
   * 空白を落とすため、生の長さで比べると「超えていないのに警告が出る」。
   * 切り捨てるのは truncateForGemini で、その入力もこの正規化後の文字列。
   */
  const normalizedLength = normalizeText(ocrText).length;

  if (normalizedLength > MAX_GEMINI_INPUT_LENGTH) {
    rows.push({
      label: '読み取った文字数',
      value: `${normalizedLength}文字（${MAX_GEMINI_INPUT_LENGTH}文字を超えた分は項目の振り分けに使われません）`,
      ok: false,
    });
  }

  for (const row of rows) {
    const term = document.createElement('dt');
    term.className = 'co-status-label';
    term.textContent = row.label;

    const value = document.createElement('dd');
    value.className = 'co-status-value';
    value.dataset.ok = row.ok ? 'yes' : 'no';
    value.textContent = row.value;

    target.append(term, value);
  }
}

async function readCard() {
  if (reading || currentStep(capture) !== CaptureStep.READY) {
    return;
  }

  reading = true;
  el['co-start'].disabled = true;
  el['co-ocr'].hidden = false;
  el['co-ocr-state'].textContent = '文字を読み取っています…';
  el['co-ocr-state'].dataset.ok = 'pending';
  el['co-ocr-sides'].replaceChildren();
  clearMessage();

  try {
    const result = await ocrBothSides({
      token: getCachedAccessToken(),
      front: capture.front.blob,
      back: capture.back?.blob ?? null,
      /* 一時ドキュメントは保存先の中に作る（§FR-08 の1）。 */
      parentId: storage?.appFolderId ?? null,
    });

    ocrText = joinSides(result.front.text, result.back?.text ?? '');

    el['co-ocr-state'].textContent = '読み取りました';
    el['co-ocr-state'].dataset.ok = 'yes';
    renderOcr(result);

    if (result.backError) {
      /* 裏面は補助。全体を失敗にしないが、黙っても進めない（§FR-08 の7）。 */
      showMessage('裏面は読み取れませんでした。表面の内容だけで進みます。', 'info');
    }

    /* 続けて項目へ振り分ける（ステージ2 → 3）。 */
    await classifyCard();
  } catch (error) {
    ocrText = '';
    el['co-ocr-state'].textContent = '読み取れませんでした';
    el['co-ocr-state'].dataset.ok = 'no';

    const described = describeOcrError(error);
    showMessage(`${described.text}（${described.errorCode}）`, 'error');
  } finally {
    reading = false;
    renderCapture();
  }
}

/* ---------- 項目への振り分け（§8.1 ステージ3・4） ---------- */

/*
 * 振り分けた結果を出す。
 *
 * **値をそのまま出す。** ここは利用者自身の画面で、利用者自身が
 * 撮った名刺である。確かめられなければ登録の可否を判断できない。
 * 修正と候補選択はフェーズ3（SC-04）で足す。
 */
function renderFields() {
  const target = el['co-fields-list'];
  target.replaceChildren();

  const review = new Set(fieldsNeedingReview(merged));

  for (const field of VALUE_FIELDS) {
    const row = document.createElement('div');
    row.className = 'co-field-row';

    const label = document.createElement('label');
    label.className = 'co-field-label';
    label.setAttribute('for', `co-input-${field}`);
    label.textContent = FIELD_LABELS[field] ?? field;

    if (review.has(field)) {
      const mark = document.createElement('span');
      mark.className = 'co-review-mark';
      mark.textContent = ' 要確認';
      label.append(mark);
    }

    /*
     * **入力欄にする。** 読み取りは必ず外すので、直せない画面は使えない
     * （§FR-15）。保存されるのはここに見えている値である。
     *
     * 複数行になりうる項目（その他）は textarea にする。1行の input だと
     * **入っている内容の一部しか見えず、消してしまいやすい。**
     */
    const multiline = MULTILINE_FIELDS.includes(field);
    const input = document.createElement(multiline ? 'textarea' : 'input');

    input.id = `co-input-${field}`;
    input.className = 'co-field-input';

    if (multiline) {
      input.rows = 4;
    } else {
      input.type = 'text';
    }

    input.value = merged.values[field] ?? '';
    input.dataset.field = field;
    input.dataset.review = review.has(field) ? 'yes' : 'no';

    row.append(label, input);
    target.append(row);
  }

  /* 由来の記録。どこから来た値かを追えるようにする（§FR-15 の5）。 */
  const notes = [];

  if (merged.fromBackFields.length > 0) {
    notes.push(`裏面から補った項目: ${merged.fromBackFields.join('、')}`);
  }

  if (merged.patternFilled.length > 0) {
    notes.push(`書式から補った項目: ${merged.patternFilled.join('、')}`);
  }

  if (merged.reclassified.length > 0) {
    notes.push(`電話番号の種別を整えました（${merged.reclassified.join('、')}）`);
  }

  if (merged.conflicts.length > 0) {
    notes.push(`表と裏で値が違った項目: ${merged.conflicts.join('、')}`);
  }

  const list = el['co-fields-notes'];
  list.replaceChildren();

  for (const note of notes) {
    const item = document.createElement('li');
    item.textContent = note;
    list.append(item);
  }

  list.hidden = notes.length === 0;
}

/*
 * 読み取ったテキストを項目へ振り分ける。
 *
 * **Gemini の呼び出しは1名刺につき1回**（§FR-11、§20）。
 * 両面ぶんを結合したテキストをそのまま渡す。
 */
async function classifyCard() {
  el['co-fields'].hidden = false;
  el['co-fields-state'].textContent = '項目へ振り分けています…';
  el['co-fields-state'].dataset.ok = 'pending';

  /*
   * キーはここで初めて取り出す。画面の描画には要らないので、
   * 使う直前まで持たない（keystore-spec-v1.md §2）。
   */
  const apiKey = KeyStore.get(PROVIDERS.gemini);
  const text = prepareForGemini(ocrText);

  try {
    const result = await classifyCardText(text, { apiKey });

    merged = mergeExtraction(result, extractByPattern(text));

    el['co-fields-state'].textContent = '振り分けました';
    el['co-fields-state'].dataset.ok = 'yes';
    renderFields();
  } catch (error) {
    merged = null;
    el['co-fields-state'].textContent = '振り分けできませんでした';
    el['co-fields-state'].dataset.ok = 'no';

    const described = describeGeminiError(error);

    /*
     * **detail まで出す。** 「不明なエラー」だけの画面は、利用者にも
     * こちらにも役に立たない（フェーズ0で SYS-999 の切り分けに
     * 何時間もかかった。計画 §7-5-2）。
     */
    showMessage(
      `${described.text}（${described.errorCode}）${described.detail ? ` / ${described.detail}` : ''}`,
      'error',
    );
  }
}

/* ---------- 確定保存（§8.1 ステージ5） ---------- */

/*
 * 画面の入力欄から値を読む。
 *
 * **merged.values ではなく、入力欄を読む。** 利用者が直した値が
 * 保存されなければ、直せる画面にした意味がない。
 */
function readEditedValues() {
  const values = {};

  for (const field of VALUE_FIELDS) {
    values[field] = el['co-fields-list'].querySelector(`[data-field="${field}"]`)?.value ?? '';
  }

  return values;
}

function renderSaved(result) {
  const target = el['co-saved-list'];
  target.replaceChildren();

  el['co-saved-title'].textContent = result.updated ? '更新しました' : '登録しました';

  const rows = [
    ['管理ID', result.recordId],
    ['表面の画像', result.front ? '保存しました' : '保存していません'],
    ['裏面の画像', result.back ? '保存しました' : '（裏面なし）'],
  ];

  if (result.updated) {
    /*
     * **変更履歴を残せたかどうかを必ず出す。** 台帳は書き換わって
     * いるので、記録に失敗したことを黙っていると、変更前の値が
     * どこにも無いまま「更新できた」ように見える（§11.3）。
     */
    /*
     * **件数は「変更履歴に残した行の数」である。** 画像のファイルIDや
     * ハッシュも含むため、画面で見た差分より多くなる。名前をそろえて
     * おかないと「1項目直したのに8件？」と読めてしまう。
     */
    rows.push([
      '変更履歴に記録した項目',
      result.changes.length > 0 ? `${result.changes.length}件` : 'なし',
    ]);
    rows.push([
      '変更履歴',
      result.historyRecorded ? '記録しました' : '記録できませんでした',
    ]);
  }

  for (const [label, value] of rows) {
    const term = document.createElement('dt');
    term.className = 'co-status-label';
    term.textContent = label;

    const cell = document.createElement('dd');
    cell.className = 'co-status-value';
    cell.dataset.ok = 'yes';
    cell.textContent = value;

    target.append(term, cell);
  }

  el['co-saved-sheet'].href = result.sheetUrl;
}

/* 重複の理由を、利用者が次に何をすればよいか分かる言葉にする。 */
function describeDuplicate(duplicate) {
  if (duplicate.kind === 'attribute') {
    return '会社名と氏名が、すでに登録されている行と同じです。'
      + '転職・異動などで内容が変わった場合は「既存の行を更新する」、'
      + '同姓同名の別の方の場合は「新規として登録する」を選んでください。';
  }

  return duplicate.side === 'back'
    ? '裏面の画像が、すでに登録されている画像と同じです。表と裏を取り違えていないかご確認ください。'
    : '表面の画像が、すでに登録されている画像と同じです。同じ写真をもう一度登録しようとしています。';
}

/*
 * 差分を出す（FR-17 の「差分確認必須・無確認自動上書き禁止」）。
 *
 * **中身の項目だけを出す**（register.js が CONTENT_COLUMNS で絞る）。
 * 管理IDやハッシュを並べても、更新してよいかの判断材料にならない。
 * 変更履歴のほうには全列を残す。
 */
function renderDuplicateDiff(result) {
  const target = el['co-duplicate-diff'];
  target.replaceChildren();

  const changes = Array.isArray(result.changes) ? result.changes : [];

  for (const change of changes) {
    const term = document.createElement('dt');
    term.className = 'co-status-label';
    term.textContent = change.header;

    const cell = document.createElement('dd');
    cell.className = 'co-status-value';
    cell.dataset.ok = 'pending';
    /* 空欄は「（空欄）」と書く。見えない差は差として伝わらない。 */
    const before = change.oldValue === '' ? '（空欄）' : change.oldValue;
    const after = change.newValue === '' ? '（空欄）' : change.newValue;
    cell.textContent = `${before} → ${after}`;

    target.append(term, cell);
  }

  const updatable = result.duplicate.updatable === true;

  el['co-duplicate-diff-title'].hidden = !updatable || changes.length === 0;
  el['co-update'].hidden = !updatable;

  const note = el['co-duplicate-note'];

  if (!updatable) {
    note.textContent = 'すでに登録されている行に管理ID（record_id）が無いため、'
      + 'その行を更新できません。新規として登録するか、シートを直接編集してください。';
    note.hidden = false;
  } else if (changes.length === 0) {
    note.textContent = '文字の項目に違いはありません。'
      + '更新すると、画像と読み取りの記録だけが新しいものへ差し替わります。';
    note.hidden = false;
  } else {
    note.textContent = '';
    note.hidden = true;
  }
}

async function register({ skipDuplicateCheck = false, updateRecordId = null } = {}) {
  if (registering || !merged || !storage?.writable) {
    return;
  }

  registering = true;
  el['co-register'].disabled = true;
  el['co-register-anyway'].disabled = true;
  el['co-update'].disabled = true;
  el['co-duplicate'].hidden = true;
  showMessage(updateRecordId ? '更新しています…' : '登録しています…');

  try {
    const result = await registerCard({
      values: readEditedValues(),
      merged,
      frontBlob: capture.front.blob,
      backBlob: capture.back?.blob ?? null,
      storage,
      token: getCachedAccessToken(),
      skipDuplicateCheck,
      updateRecordId,
    });

    if (result.missingRow) {
      /*
       * 差分を見ている間に、対象の行が消えた（か管理IDが変わった）。
       * **別の行を上書きしない**（register.js）。選び直してもらう。
       */
      duplicateTarget = null;
      showMessage(
        '更新しようとした行が見つかりませんでした。'
        + 'シートが編集された可能性があります。新規として登録するか、やり直してください。',
        'error',
      );
      el['co-duplicate'].hidden = false;
      el['co-update'].hidden = true;
      return;
    }

    if (!result.registered) {
      /*
       * 止めるのではなく、選ばせる（§FR-17・FR-19。DUP-001 / DUP-002）。
       *
       * **理由を分けて出す。** 「同じ画像」と「同じ会社の同じ人」では、
       * 利用者が次に取る行動が違う。前者は撮り直しの取り違え、
       * 後者は名刺の作り直しや部署異動でありうる。
       */
      duplicateTarget = result.duplicate.updatable ? result.duplicate.recordId : null;

      el['co-duplicate-title'].textContent = result.duplicate.kind === 'attribute'
        ? '同じ会社の同じ方が、すでに登録されています'
        : '同じ画像が、すでに登録されています';

      el['co-duplicate-text'].textContent = describeDuplicate(result.duplicate);
      renderDuplicateDiff(result);
      el['co-duplicate'].hidden = false;
      showMessage('');
      return;
    }

    duplicateTarget = null;
    renderSaved(result);
    el['co-fields'].hidden = true;
    el['co-capture'].hidden = true;
    el['co-ocr'].hidden = true;
    el['co-saved'].hidden = false;

    showMessage(
      result.updated && !result.historyRecorded
        ? '更新しましたが、変更履歴を記録できませんでした。変更前の値は残っていません。'
        : '',
      result.updated && !result.historyRecorded ? 'error' : 'info',
    );
  } catch (error) {
    showMessage(
      `${updateRecordId ? '更新' : '登録'}できませんでした: ${formatDriveError(error)}`,
      'error',
    );
  } finally {
    registering = false;
    el['co-register'].disabled = false;
    el['co-register-anyway'].disabled = false;
    el['co-update'].disabled = false;
  }
}

/* 次の名刺へ。**画像も読み取り結果も捨てる。** */
function startNext() {
  capture = clearAll();
  discardOcr();
  /* 前の名刺の更新先を持ち越さない。別の行を上書きしかねない。 */
  duplicateTarget = null;
  el['co-saved'].hidden = true;
  el['co-duplicate'].hidden = true;
  el['co-capture'].hidden = false;
  clearMessage();
  renderCapture();
}

/*
 * 消し損ねた一時ドキュメントを回収する（§8.1 ステージ0 の5）。
 *
 * **失敗しても起動を止めない。** 掃除であって、本筋の処理ではない。
 */
async function collectOrphans() {
  try {
    const result = await collectOrphanTempDocs({ token: getCachedAccessToken() });

    if (result.found > 0) {
      showMessage(
        `前回消し切れなかった一時ファイルを${result.deleted}件（${result.found}件中）回収しました。`,
      );
    }
  } catch {
    /* 掃除の失敗は利用者に見せない。次回また試す。 */
  }
}

/*
 * 選ばれたファイルを前処理して状態へ入れる。
 *
 * **入力欄の値は毎回空へ戻す。** 同じファイルをもう一度選んだときに
 * change が発火しなくなるため。
 */
async function acceptFile(side, file, rotation = 0) {
  if (processing) {
    return;
  }

  processing = true;
  clearMessage();

  try {
    const image = await shrinkToJpeg(file, { rotation });

    capture = side === 'front'
      ? setFront(capture, { ...image, source: file, rotation })
      : setBack(capture, { ...image, source: file, rotation });

    /* 画像が変わったら、前の読み取り結果は別の名刺のものになる。 */
    discardOcr();
  } catch (error) {
    const described = describeCaptureError(error);
    showMessage(`${described.text}（${described.errorCode}）`, 'error');
  } finally {
    processing = false;
    el['co-front-input'].value = '';
    el['co-back-input'].value = '';
    renderCapture();
  }
}

/*
 * 回転は**元の画像から作り直す。**
 * 縮小済みの画像を回し続けると、回すたびに劣化が積み上がる。
 */
async function rotateSide(side) {
  const image = capture[side];

  if (!image?.source) {
    return;
  }

  await acceptFile(side, image.source, (image.rotation ?? 0) + 90);
}

/*
 * 読み取り結果を捨てる。
 *
 * **画像を差し替えたら必ず呼ぶ。** 古いテキストを残すと、いま画面に
 * 出ている画像とは別の名刺の内容を保存することになる。
 */
function discardOcr() {
  ocrText = '';
  merged = null;
  /* 読み取り結果を捨てたら、更新先も捨てる（別の名刺の行になる）。 */
  duplicateTarget = null;
  el['co-ocr'].hidden = true;
  el['co-ocr-sides'].replaceChildren();
  el['co-fields'].hidden = true;
  el['co-fields-list'].replaceChildren();
  el['co-fields-notes'].replaceChildren();
  el['co-fields-notes'].hidden = true;
  el['co-duplicate'].hidden = true;
}

function removeSide(side) {
  capture = side === 'front' ? clearAll() : clearBack(capture);
  discardOcr();
  clearMessage();
  renderCapture();
}

/* ---------- Google 連携 ---------- */

async function connect() {
  if (connecting) {
    return;
  }

  connecting = true;
  el['co-connect'].disabled = true;
  showMessage('Googleの画面を開いています…');

  try {
    /*
     * **利用者の押下から直接呼ぶ。** 非同期処理を挟んでから呼ぶと
     * ポップアップブロックに当たる（drive-auth.js）。
     */
    await ensureAccessToken();
    clearMessage();
  } catch (error) {
    const described = describeDriveAuthError(error);
    showMessage(`${described.text}（${described.errorCode}）`, 'error');
  } finally {
    connecting = false;
    el['co-connect'].disabled = false;
  }

  /*
   * 連携できたら、続けて保存構造を用意する（§8.1 ステージ0）。
   * **render() のあとに呼ぶ。** 準備の状況を先に更新してから、
   * 時間のかかる通信へ入る。
   */
  if (render() === Prerequisite.READY) {
    await prepareStorage();
  }
}

function disconnect() {
  clearAccessToken();
  showMessage('連携を解除しました。');
  render();
}

/* ---------- 起動 ---------- */

async function start() {
  /*
   * 未ログインならここで /login/ へ飛ぶ。
   * 戻り先は自分自身ではなく Portal にしてある。SCREENS に本アプリの
   * 名前が無く、勝手に足すと apps-grid-spec の配置データと二重管理に
   * なるため（FR-25 の2）。ログイン後は Portal から入り直す。
   */
  const user = await guardPage({ next: 'portal' });

  if (!user) {
    return;
  }

  signedIn = true;

  el['co-loading'].hidden = true;
  el['co-content'].hidden = false;

  /*
   * 起動時点で連携が生きていることは無い（トークンはメモリのみで、
   * 読み込み直後は空）。それでも READY を見てから呼ぶのは、
   * **連携済みかどうかの判断を1か所に寄せるため**である。
   */
  if (render() === Prerequisite.READY) {
    await prepareStorage();
  }
}

el['co-connect'].addEventListener('click', () => { void connect(); });
el['co-disconnect'].addEventListener('click', disconnect);

el['co-front-input'].addEventListener('change', (event) => {
  void acceptFile('front', event.target.files?.[0] ?? null);
});

el['co-back-input'].addEventListener('change', (event) => {
  void acceptFile('back', event.target.files?.[0] ?? null);
});

el['co-skip-back'].addEventListener('click', () => {
  capture = skipBack(capture);
  renderCapture();
});

el['co-want-back'].addEventListener('click', () => {
  capture = wantBack(capture);
  renderCapture();
});

el['co-reset'].addEventListener('click', () => {
  capture = clearAll();
  discardOcr();
  clearMessage();
  renderCapture();
});

el['co-start'].addEventListener('click', () => { void readCard(); });
el['co-register'].addEventListener('click', () => { void register(); });
el['co-register-anyway'].addEventListener('click', () => { void register({ skipDuplicateCheck: true }); });

/*
 * 既存の行を更新する（FR-17）。**差分を見せたうえでの明示の操作**でしか
 * ここへ来ない。押されるまで上書きはしない。
 */
el['co-update'].addEventListener('click', () => {
  if (duplicateTarget) {
    void register({ updateRecordId: duplicateTarget });
  }
});

el['co-next'].addEventListener('click', startNext);

el['co-duplicate-cancel'].addEventListener('click', () => {
  duplicateTarget = null;
  el['co-duplicate'].hidden = true;
});

/*
 * 画面を離れるときにトークンを捨てる。
 * メモリにしか持っていないので必須ではないが、bfcache で戻ったときに
 * 期限切れのトークンを掴んだままにしないため（領収書OCRから取り込み）。
 */
globalThis.addEventListener?.('pagehide', () => {
  clearAccessToken();
});

void start();

/*
 * 画面の組み立て（X 投稿）。
 *
 * 起動の約束（他の本番アプリと同じ）:
 *   1. setScreenDepth(2) … /production-app/x-post/ はルートから2階層。
 *   2. guardPage() が利用者を返すまで中身（#xp-content）を出さない。
 *   3. APIキーは KeyStore から都度読む。このモジュールに保持しない。
 *
 * ロジック（検証・intent・保存・Gemini）は post.js / gemini.js に置き、
 * ここは DOM の付け外しだけを受け持つ。
 */

import { guardPage } from '../../auth/session.js';
import { setScreenDepth } from '../../auth/config.js';
import { KeyStore, PROVIDERS, isKeyStoreAvailable } from '../../auth/keystore.js';
import { WEIGHT_LIMIT } from './config.js';
import {
  countWeight,
  validatePostText,
  buildIntentUrl,
  isStorageAvailable,
  saveDraft,
  listDrafts,
  deleteDraft,
  recordHistory,
  listHistory,
  saveStylePrompt,
  loadStylePrompt,
} from './post.js';
import { generatePost, describeGeminiError } from './gemini.js';

setScreenDepth(2);

const dom = {
  loading: document.getElementById('xp-loading'),
  content: document.getElementById('xp-content'),
  storageNote: document.getElementById('xp-storage-note'),
  keyNote: document.getElementById('xp-key-note'),
  generateForm: document.getElementById('xp-generate-form'),
  generateButton: document.getElementById('xp-generate'),
  theme: document.getElementById('xp-theme'),
  style: document.getElementById('xp-style'),
  text: document.getElementById('xp-text'),
  count: document.getElementById('xp-count'),
  save: document.getElementById('xp-save'),
  post: document.getElementById('xp-post'),
  message: document.getElementById('xp-message'),
  drafts: document.getElementById('xp-drafts'),
  draftsSection: document.getElementById('xp-drafts-section'),
  history: document.getElementById('xp-history'),
  historySection: document.getElementById('xp-history-section'),
};

const storageOk = isStorageAvailable();

function say(text, isError = false) {
  dom.message.textContent = text;
  dom.message.className = `xp-message${isError ? ' xp-message--error' : ''}`;
}

function formatTime(ms) {
  const d = new Date(Number(ms));
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/*
 * 残りの目安を出す。
 *
 * 数えているのは従来どおり X の「ウェイト」（全角=2。post.js の countWeight）で、
 * 上限判定も WEIGHT_LIMIT のまま。画面に出す数字だけを、利用者が使える単位
 * ＝日本語の文字数へ直している（ウェイト ÷ 2）。
 * 半角中心の文なら実際にはもっと書けるため、必ず「約」を付ける。
 * 超過分は切り上げる（1ウェイト超えを「約0字オーバー」と出さないため）。
 */
function updateCount() {
  const weight = countWeight(dom.text.value);
  const over = weight > WEIGHT_LIMIT;
  const remainingWeight = WEIGHT_LIMIT - weight;

  dom.count.textContent = over
    ? `約${Math.ceil(-remainingWeight / 2)}字オーバー`
    : `残り約${Math.floor(remainingWeight / 2)}字`;
  dom.count.className = over ? 'xp-count-over' : '';
}

function refreshKeyState() {
  const hasKey = isKeyStoreAvailable() && KeyStore.has(PROVIDERS.gemini);
  dom.keyNote.hidden = hasKey;
}

/* ---------- 一覧の描画 ---------- */

function renderDrafts() {
  const drafts = storageOk ? listDrafts() : [];

  dom.drafts.textContent = '';

  /*
   * 0件のあいだはセクションごと出さない。空の一覧と「まだありません」は
   * 場所を取るだけで、利用者の次の操作を助けない（下書きは「下書き保存」で
   * 増え、そのときこの関数が呼び直されて現れる）。
   */
  dom.draftsSection.hidden = drafts.length === 0;

  for (const draft of drafts) {
    const li = document.createElement('li');

    const body = document.createElement('div');
    body.className = 'xp-item-body';

    const meta = document.createElement('p');
    meta.className = 'xp-item-meta';
    meta.textContent = formatTime(draft.createdAt);

    const text = document.createElement('p');
    text.className = 'xp-item-text';
    text.textContent = draft.text;

    body.append(meta, text);

    const actions = document.createElement('div');
    actions.className = 'xp-item-actions';

    const load = document.createElement('button');
    load.type = 'button';
    load.textContent = '呼び出す';
    load.addEventListener('click', () => {
      dom.text.value = draft.text;
      updateCount();
      dom.text.focus();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '削除';
    remove.addEventListener('click', () => {
      if (!confirm('この下書きを削除します。よろしいですか？')) {
        return;
      }

      deleteDraft(draft.id);
      renderDrafts();
    });

    actions.append(load, remove);
    li.append(body, actions);
    dom.drafts.append(li);
  }
}

function renderHistory() {
  const items = storageOk ? listHistory() : [];

  dom.history.textContent = '';

  /* 記録の範囲の注記もセクションの中にある。1件も無いうちは出す意味がない。 */
  dom.historySection.hidden = items.length === 0;

  for (const item of items) {
    const li = document.createElement('li');

    const body = document.createElement('div');
    body.className = 'xp-item-body';

    const meta = document.createElement('p');
    meta.className = 'xp-item-meta';
    meta.textContent = `${formatTime(item.at)}　${item.kind}`;

    const text = document.createElement('p');
    text.className = 'xp-item-text';
    text.textContent = item.text;

    body.append(meta, text);
    li.append(body);
    dom.history.append(li);
  }
}

/* ---------- 操作 ---------- */

function handleSave() {
  if (!storageOk) {
    say('この環境では保存できません', true);
    return;
  }

  try {
    saveDraft(dom.text.value);
    say('下書きを保存しました');
    renderDrafts();
  } catch (error) {
    say(String(error?.message ?? error), true);
  }
}

function handlePost() {
  const problem = validatePostText(dom.text.value);

  if (problem) {
    say(problem, true);
    return;
  }

  /*
   * ポップアップ扱いを避けるため、クリックと同じイベント内で開く。
   * intent リンクは X 側の画面なので、rel は window.open の
   * 既定（opener なし）に任せず明示する。
   */
  const win = window.open(buildIntentUrl(dom.text.value), '_blank', 'noopener,noreferrer');

  if (!win) {
    say('投稿画面を開けませんでした。ポップアップの許可をご確認ください。', true);
    return;
  }

  if (storageOk) {
    recordHistory('投稿画面を開いた', dom.text.value);
    renderHistory();
  }

  say('投稿画面を開きました。内容を確かめて「投稿」を押してください。');
}

async function handleGenerate(event) {
  event.preventDefault();

  const theme = dom.theme.value.trim();

  if (theme === '') {
    say('テーマ・指示を入力してください', true);
    dom.theme.focus();
    return;
  }

  if (dom.text.value.trim() !== ''
    && !confirm('入力中の本文を生成結果で置き換えます。よろしいですか？')) {
    return;
  }

  /* キーは都度読み、変数に残さない（KeyStore の方針）。 */
  const apiKey = isKeyStoreAvailable() ? KeyStore.get(PROVIDERS.gemini) : null;

  dom.generateButton.disabled = true;
  say('生成しています…');

  try {
    const text = await generatePost({ apiKey: apiKey ?? '', theme, stylePrompt: dom.style.value });
    dom.text.value = text;
    updateCount();
    say('生成しました。内容を確認・編集してから保存/投稿してください。');
  } catch (error) {
    const described = describeGeminiError(error);
    say(`${described.text}（${described.errorCode}）`, true);
  } finally {
    dom.generateButton.disabled = false;
  }
}

/* ---------- 起動 ---------- */

async function init() {
  const user = await guardPage();

  if (!user) {
    /* すでにログイン画面へ遷移している。ここで描画を止める。 */
    return;
  }

  dom.loading.hidden = true;
  dom.content.hidden = false;

  dom.storageNote.hidden = storageOk;

  dom.text.addEventListener('input', updateCount);
  dom.save.addEventListener('click', handleSave);
  dom.post.addEventListener('click', handlePost);
  dom.generateForm.addEventListener('submit', handleGenerate);

  /* ポータルでキーを設定して戻ってきたら、案内を消す。 */
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshKeyState();
    }
  });
  globalThis.addEventListener('focus', refreshKeyState);

  /* 調整プロンプトの復元と自動保存。保存できない環境では欄だけ生かす。 */
  if (storageOk) {
    dom.style.value = loadStylePrompt();
  }
  dom.style.addEventListener('input', () => {
    if (storageOk) {
      saveStylePrompt(dom.style.value);
    }
  });

  refreshKeyState();
  updateCount();
  renderDrafts();
  renderHistory();
}

init();

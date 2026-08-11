/*
 * 画面の組み立て（Threads 投稿）。
 *
 * 起動の約束（他の本番アプリと同じ）:
 *   1. setScreenDepth(2) … /production-app/threads-post/ はルートから2階層。
 *   2. guardPage() が利用者を返すまで中身（#tp-content）を出さない。
 *   3. APIキーは KeyStore から都度読む。このモジュールに保持しない。
 *
 * ロジック（検証・intent・保存・Gemini）は post.js / gemini.js に置き、
 * ここは DOM の付け外しだけを受け持つ。
 */

import { guardPage } from '../../auth/session.js';
import { setScreenDepth } from '../../auth/config.js';
import { KeyStore, PROVIDERS, isKeyStoreAvailable } from '../../auth/keystore.js';
import { TEXT_LIMIT } from './config.js';
import {
  countText,
  validatePostText,
  buildIntentUrl,
  isStorageAvailable,
  saveDraft,
  listDrafts,
  deleteDraft,
  recordHistory,
  listHistory,
} from './post.js';
import { generatePost, describeGeminiError } from './gemini.js';

setScreenDepth(2);

const dom = {
  loading: document.getElementById('tp-loading'),
  content: document.getElementById('tp-content'),
  storageNote: document.getElementById('tp-storage-note'),
  keyNote: document.getElementById('tp-key-note'),
  generateForm: document.getElementById('tp-generate-form'),
  generateButton: document.getElementById('tp-generate'),
  theme: document.getElementById('tp-theme'),
  text: document.getElementById('tp-text'),
  count: document.getElementById('tp-count'),
  limit: document.getElementById('tp-limit'),
  save: document.getElementById('tp-save'),
  post: document.getElementById('tp-post'),
  message: document.getElementById('tp-message'),
  drafts: document.getElementById('tp-drafts'),
  draftsEmpty: document.getElementById('tp-drafts-empty'),
  history: document.getElementById('tp-history'),
  historyEmpty: document.getElementById('tp-history-empty'),
};

const storageOk = isStorageAvailable();

function say(text, isError = false) {
  dom.message.textContent = text;
  dom.message.className = `tp-message${isError ? ' tp-message--error' : ''}`;
}

function formatTime(ms) {
  const d = new Date(Number(ms));
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function updateCount() {
  const length = countText(dom.text.value);
  dom.count.textContent = String(length);
  dom.count.className = length > TEXT_LIMIT ? 'tp-count-over' : '';
}

function refreshKeyState() {
  const hasKey = isKeyStoreAvailable() && KeyStore.has(PROVIDERS.gemini);
  dom.keyNote.hidden = hasKey;
}

/* ---------- 一覧の描画 ---------- */

function renderDrafts() {
  const drafts = storageOk ? listDrafts() : [];

  dom.drafts.textContent = '';
  dom.draftsEmpty.hidden = drafts.length > 0;

  for (const draft of drafts) {
    const li = document.createElement('li');

    const body = document.createElement('div');
    body.className = 'tp-item-body';

    const meta = document.createElement('p');
    meta.className = 'tp-item-meta';
    meta.textContent = formatTime(draft.createdAt);

    const text = document.createElement('p');
    text.className = 'tp-item-text';
    text.textContent = draft.text;

    body.append(meta, text);

    const actions = document.createElement('div');
    actions.className = 'tp-item-actions';

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
  dom.historyEmpty.hidden = items.length > 0;

  for (const item of items) {
    const li = document.createElement('li');

    const body = document.createElement('div');
    body.className = 'tp-item-body';

    const meta = document.createElement('p');
    meta.className = 'tp-item-meta';
    meta.textContent = `${formatTime(item.at)}　${item.kind}`;

    const text = document.createElement('p');
    text.className = 'tp-item-text';
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
   * intent リンクは Threads 側の画面なので、rel は window.open の
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
    const text = await generatePost({ apiKey: apiKey ?? '', theme });
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

  dom.limit.textContent = String(TEXT_LIMIT);
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

  refreshKeyState();
  updateCount();
  renderDrafts();
  renderHistory();
}

init();

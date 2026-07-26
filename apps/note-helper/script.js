/*
 * script.js — Note Draft Helper の処理本体
 *
 * Chrome拡張「note記事自動入力」をブラウザだけで動く形に移植したものです。
 * 通信部分は拡張の background.js、画面表示は popup.js を元にしています。
 *
 * 【拡張機能との対応】
 *   chrome.storage.local → localStorage
 *   chrome.runtime       → 使用しない（この1ファイルで完結）
 *   chrome.tabs.create   → window.open()
 *
 * 【使うGAS API（noteArticleApi.js）】
 *   GET  ?action=ping         … 接続確認（シートを変更しない）
 *   GET  ?action=next         … 次の記事を1件取得（H列が「取得済」になる）
 *   POST action=updateStatus  … 記事状況を更新する
 *
 * ============================================================
 * 【運用上の注意】
 * ============================================================
 *
 * 1. 「次の記事を取得」には副作用があります
 *    ?action=next は、記事を返す前にシートのH列（記事状況）を
 *    「取得済」へ変更します。押した時点で1件を消費するため、
 *    動作確認の目的で気軽に押さないでください。
 *    「取得済」のまま30分が経過した記事は、中断したものとみなして
 *    再取得の対象へ戻ります（noteArticleApi.js の STALE_FETCHED_MINUTES）。
 *    接続の確認だけなら、副作用のない「接続確認」（?action=ping）を使ってください。
 *
 * 2. 公開URLを知っている人は、誰でもAPIを操作できます
 *    ブラウザから直接通信するため、GASの公開設定は
 *    「アクセスできるユーザー＝全員」である必要があります。
 *    この設定では認証がないため、URLを知っていれば
 *    記事本文の取得と記事状況の更新が誰でも行えます。
 *
 * 3. GAS WebアプリURLを不用意に共有しないでください
 *    URLがそのまま認証情報に相当します。
 *    チャット・課題管理ツール・スクリーンショットなどに
 *    貼らないよう注意してください。
 *    このツールはURLをコード内に持たず、利用者の端末の
 *    localStorage にのみ保存します（キー名 gasWebAppUrl）。
 *
 * 4. 初回の本番確認は、実際にnoteへ投稿するときに行ってください
 *    「投稿完了」はシートに「Note記事作成済」を書き込みます。
 *    実際には投稿していない記事に対して押すと、
 *    シートの記録と実態が食い違い、あとから追跡できなくなります。
 *    テスト目的で押さず、本当に投稿できたときだけ押してください。
 */

'use strict';

// ============================================================
// 設定値
// ============================================================

/**
 * GAS WebアプリURLを保存するときのキー名。
 * URL自体はコードに書かず、必ずここから読み出す。
 */
const STORAGE_KEY_GAS_URL = 'gasWebAppUrl';

/** noteの新規記事作成画面 */
const NOTE_NEW_POST_URL = 'https://editor.note.com/new';

/**
 * GASへ送るステータス。
 * GAS側の UPDATABLE_STATUSES と文字列が完全に一致していないと拒否される。
 */
const ARTICLE_STATUS = {
  DRAFTED: 'Note記事作成済',
  ERROR: '下書き作成エラー'
};

/** 応答がおかしいときにConsoleへ出す文字数 */
const SNIPPET_LENGTH = 200;

// ============================================================
// 画面の部品をまとめて取得しておく
// ============================================================

const el = {
  // GAS設定
  gasUrlInput: document.getElementById('gasUrlInput'),
  saveUrlButton: document.getElementById('saveUrlButton'),
  pingButton: document.getElementById('pingButton'),

  // 記事取得
  fetchButton: document.getElementById('fetchButton'),

  // 記事表示
  articleView: document.getElementById('articleView'),
  articleNewsId: document.getElementById('articleNewsId'),
  articleStatus: document.getElementById('articleStatus'),
  articleTitleText: document.getElementById('articleTitleText'),
  articleBodyText: document.getElementById('articleBodyText'),
  bodyLength: document.getElementById('bodyLength'),

  // 操作
  copyTitleButton: document.getElementById('copyTitleButton'),
  copyBodyButton: document.getElementById('copyBodyButton'),
  copyBothButton: document.getElementById('copyBothButton'),
  openNoteButton: document.getElementById('openNoteButton'),
  completeButton: document.getElementById('completeButton'),
  errorMessageInput: document.getElementById('errorMessageInput'),
  errorButton: document.getElementById('errorButton'),
  closeButton: document.getElementById('closeButton'),

  // 投稿完了後の案内
  nextPromptView: document.getElementById('nextPromptView'),
  fetchNextButton: document.getElementById('fetchNextButton'),
  dismissPromptButton: document.getElementById('dismissPromptButton'),

  // 共通
  message: document.getElementById('message')
};

/**
 * いま画面に表示している記事のニュースID。
 * 表示していないときは空文字。
 *
 * タイトルと本文は編集できるため状態として持たず、
 * 送信時に textarea の value を読む。
 */
let currentNewsId = '';

/**
 * 処理中かどうか。
 * 二重送信を防ぐため、通信中は次の操作を受け付けない。
 */
let isBusy = false;

// ============================================================
// 画面表示のための道具
// ============================================================

/**
 * メッセージを表示する。
 *
 * APIの応答をそのまま innerHTML へ入れると危険なため、
 * 必ず textContent を使う。
 *
 * @param {string} text - 表示する文章
 * @param {string} type - 'error' | 'success' | 'info'
 */
function showMessage(text, type) {
  el.message.textContent = text;
  el.message.className = 'message message--' + type;
}

/** メッセージを消す */
function clearMessage() {
  el.message.textContent = '';
  el.message.className = 'message';
}

/**
 * 処理中はボタンを押せないようにする。
 *
 * 連打で通信が二重に走ると、記事を余分に消費したり
 * ステータスを二重更新したりするため、必ず両方を切り替える。
 *
 * @param {boolean} busy - true なら押せなくする
 */
function setBusy(busy) {
  isBusy = busy;

  const buttons = [
    el.saveUrlButton,
    el.pingButton,
    el.fetchButton,
    el.copyTitleButton,
    el.copyBodyButton,
    el.copyBothButton,
    el.openNoteButton,
    el.completeButton,
    el.errorButton,
    el.closeButton,
    el.fetchNextButton,
    el.dismissPromptButton
  ];

  buttons.forEach(function (button) {
    if (button) {
      button.disabled = busy;
    }
  });
}

/** 本文の文字数表示を更新する */
function updateBodyLength() {
  el.bodyLength.textContent = String(el.articleBodyText.value.length);
}

/**
 * 取得した記事を画面に表示する。
 *
 * @param {object} data - { newsId, title, body, status }
 */
function renderArticle(data) {
  currentNewsId = data.newsId;

  // textContent と value だけを使う（innerHTML は使わない）
  el.articleNewsId.textContent = data.newsId || '(なし)';
  el.articleStatus.textContent = data.status || '(不明)';

  // textarea の value に入れると改行がそのまま保たれる
  el.articleTitleText.value = data.title || '';
  el.articleBodyText.value = data.body || '';

  el.errorMessageInput.value = '';

  updateBodyLength();

  el.articleView.classList.remove('is-hidden');
}

/** 記事の表示を消す（サーバーへは何も送らない） */
function clearArticleView() {
  currentNewsId = '';

  el.articleNewsId.textContent = '-';
  el.articleStatus.textContent = '-';
  el.articleTitleText.value = '';
  el.articleBodyText.value = '';
  el.errorMessageInput.value = '';
  el.bodyLength.textContent = '0';

  el.articleView.classList.add('is-hidden');
}

/**
 * 「次の記事を取得しますか？」の案内を出し入れする。
 *
 * @param {boolean} show - true なら表示する
 */
function showNextPrompt(show) {
  el.nextPromptView.classList.toggle('is-hidden', !show);
}

// ============================================================
// GAS WebアプリURLの保存と読み込み
// ============================================================

/**
 * 保存済みのURLを読み出す。
 *
 * localStorage はこの端末のブラウザにだけ保存される仕組み。
 *
 * @returns {string} 保存されていなければ空文字
 */
function loadGasUrl() {
  try {
    return localStorage.getItem(STORAGE_KEY_GAS_URL) || '';
  } catch (error) {
    // プライベートモードなどで localStorage が使えない場合
    console.error('[note-helper] URLの読み出しに失敗しました:', error);
    return '';
  }
}

/**
 * URLを保存する。
 *
 * @param {string} url - 保存するURL
 * @returns {boolean} 保存できたら true
 */
function saveGasUrl(url) {
  try {
    localStorage.setItem(STORAGE_KEY_GAS_URL, url);
    return true;
  } catch (error) {
    console.error('[note-helper] URLの保存に失敗しました:', error);
    return false;
  }
}

/**
 * URLの形が正しいかを確認する。
 *
 * new URL() は形が不正だと例外を投げるので、それを判定に使う。
 *
 * @param {string} url - 確認するURL
 * @returns {boolean} https で始まる正しい形なら true
 */
function isValidHttpsUrl(url) {
  try {
    return new URL(url).protocol === 'https:';
  } catch (error) {
    return false;
  }
}

/**
 * これから通信に使うURLを決める。
 *
 * 入力欄に文字があればそれを使い、無ければ保存済みの値を使う。
 * こうすると、保存前でも「接続確認」で試せる。
 *
 * @returns {string} 使用するURL。決められなければ空文字
 */
function resolveGasUrl() {
  const typed = el.gasUrlInput.value.trim();

  if (typed !== '') {
    return typed;
  }

  return loadGasUrl();
}

// ============================================================
// GASとの通信
// ============================================================

/**
 * 応答がHTMLかどうかを判定する。
 *
 * GASの公開設定が「全員」でない場合、JSONではなく
 * ログイン画面のHTMLが返ってくる。その状況を見分けるために使う。
 *
 * @param {string} text - 応答の本文
 * @returns {boolean} HTMLらしければ true
 */
function looksLikeHtml(text) {
  const head = text.trim().slice(0, 100).toLowerCase();

  return head.indexOf('<!doctype') === 0 || head.indexOf('<html') === 0;
}

/**
 * GASへ通信し、結果を種類ごとに分けて返す。
 *
 * 【戻り値の形】
 * 例外を投げる代わりにオブジェクトを返すので、
 * 呼び出し側が失敗の種類ごとに表示を変えられる。
 *
 *   成功時: { ok: true, json: {...} }
 *   失敗時: { ok: false, kind: 'NETWORK'|'HTTP'|'PARSE'|'GAS', code, message }
 *
 * @param {string} requestUrl - 送信先URL
 * @param {object} [init] - fetch に渡す設定
 * @returns {Promise<object>} 上記の形の結果
 */
async function callGas(requestUrl, init) {
  let response;

  // --- 通信そのものの失敗 ---
  try {
    response = await fetch(requestUrl, init);
  } catch (error) {
    console.error('[note-helper] 通信に失敗しました:', error);
    console.error('[note-helper] 送信先URL:', requestUrl);

    return {
      ok: false,
      kind: 'NETWORK',
      message:
        '通信に失敗しました。URLが正しいか、ネットにつながっているか、' +
        'GASの公開設定が「全員」になっているか確認してください。'
    };
  }

  // --- HTTPエラー ---
  if (!response.ok) {
    console.error('[note-helper] HTTPエラー:', response.status, response.statusText, response.url);

    return {
      ok: false,
      kind: 'HTTP',
      message:
        'HTTPエラーが発生しました（' + response.status + ' ' + response.statusText + '）。' +
        'GASの公開設定を確認してください。'
    };
  }

  // --- 本文の読み取り ---
  // いきなり json() を呼ばず、まず文字列で受け取る。
  // JSON以外（ログイン画面のHTMLなど）が返ったときに中身を確認できる。
  let rawText;

  try {
    rawText = await response.text();
  } catch (error) {
    console.error('[note-helper] 応答の読み取りに失敗しました:', error);

    return { ok: false, kind: 'NETWORK', message: '応答の読み取りに失敗しました。' };
  }

  console.log('[note-helper] GASからの応答（先頭200文字）:', rawText.slice(0, SNIPPET_LENGTH));

  // --- JSON解析の失敗 ---
  if (looksLikeHtml(rawText)) {
    console.error(
      '[note-helper] JSONではなくHTMLが返りました。' +
        'GASの公開設定（アクセスできるユーザー＝全員）を確認してください。'
    );
    console.error('[note-helper] 最終URL（転送先）:', response.url);

    return {
      ok: false,
      kind: 'PARSE',
      message:
        'JSONではなくHTML（ログイン画面など）が返りました。' +
        'GASの公開設定を「全員」にしてください。'
    };
  }

  let json;

  try {
    json = JSON.parse(rawText);
  } catch (error) {
    console.error('[note-helper] JSONの解析に失敗しました:', error);
    console.error('[note-helper] 応答の先頭200文字:', rawText.slice(0, SNIPPET_LENGTH));
    console.error('[note-helper] 最終URL（転送先）:', response.url);

    return {
      ok: false,
      kind: 'PARSE',
      message: '応答をJSONとして読み取れませんでした。Consoleに応答の先頭200文字を出しています。'
    };
  }

  // --- GAS側が失敗と言っている場合 ---
  if (!json.success) {
    console.log('[note-helper] GASがsuccess:falseを返しました:', json);

    return {
      ok: false,
      kind: 'GAS',
      code: String(json.code || ''),
      message: String(json.message || 'GAS側でエラーが発生しました。')
    };
  }

  return { ok: true, json: json };
}

/**
 * GAS側のエラーを、種類に応じた説明文にする。
 *
 * @param {string} code - GASが返した code
 * @param {string} message - GASが返した message
 * @returns {string} 画面に出す文章
 */
function describeGasError(code, message) {
  if (code === 'INVALID_PARAM') {
    return '送信内容に不足がありました（INVALID_PARAM）：' + message;
  }

  if (code === 'NOT_FOUND') {
    return '対象の記事が見つかりませんでした（NOT_FOUND）：' + message;
  }

  if (code) {
    return 'GASエラー（' + code + '）：' + message;
  }

  return 'GASエラー：' + message;
}

/**
 * 失敗した結果を画面に表示する（NO_TARGET以外）。
 *
 * @param {object} result - callGas が返した失敗結果
 */
function showFailure(result) {
  if (result.kind === 'GAS') {
    showMessage(describeGasError(result.code, result.message), 'error');
    return;
  }

  // NETWORK / HTTP / PARSE はそのまま表示する
  showMessage(result.message, 'error');
}

/**
 * サーバー時刻（ISO 8601形式の文字列）を読みやすい形に直す。
 *
 * 解析できない値が来ても表示が壊れないよう、
 * その場合は受け取った文字列をそのまま返す。
 *
 * @param {string} isoText - 例：2026-07-26T06:12:34.567Z
 * @returns {string} 例：2026/7/26 15:12:34
 */
function formatServerTime(isoText) {
  const raw = String(isoText || '');

  if (raw === '') {
    return '不明';
  }

  const date = new Date(raw);

  // 不正な日付は getTime() が NaN になる
  if (Number.isNaN(date.getTime())) {
    return raw;
  }

  return date.toLocaleString('ja-JP');
}

/**
 * 接続確認を行う（GET ?action=ping）。
 *
 * シートを読み書きしないため、何度押しても記事は消費されない。
 *
 * @param {string} gasUrl - GAS WebアプリのURL
 * @returns {Promise<object>} callGas と同じ形の結果
 */
async function pingGas(gasUrl) {
  const requestUrl = new URL(gasUrl);
  requestUrl.searchParams.set('action', 'ping');

  return callGas(requestUrl.toString(), {
    method: 'GET',
    // GASは応答時に別ドメインへ転送するため、追いかける設定にする
    redirect: 'follow'
  });
}

/**
 * 次の記事を取得する（GET ?action=next）。
 *
 * @param {string} gasUrl - GAS WebアプリのURL
 * @returns {Promise<object>} callGas と同じ形の結果
 */
async function fetchNextArticle(gasUrl) {
  const requestUrl = new URL(gasUrl);
  // searchParams.set() で「?action=next」を安全に付け足す
  requestUrl.searchParams.set('action', 'next');

  return callGas(requestUrl.toString(), {
    method: 'GET',
    redirect: 'follow'
  });
}

/**
 * 記事状況を更新する（POST action=updateStatus）。
 *
 * 【フォーム形式で送る理由】
 * URLSearchParams を使うと Content-Type が
 * application/x-www-form-urlencoded になり、GAS側の e.parameter で読める。
 * JSON形式で送るとブラウザが事前確認（プリフライト）を行い、
 * GASはそれに応答できないため通信が失敗する。
 *
 * @param {string} gasUrl - GAS WebアプリのURL
 * @param {string} newsId - 対象のニュースID
 * @param {string} status - 設定するステータス
 * @param {string} message - エラー内容（GAS側でJ列へ記録される）
 * @returns {Promise<object>} callGas と同じ形の結果
 */
async function updateArticleStatus(gasUrl, newsId, status, message) {
  const body = new URLSearchParams();
  body.set('action', 'updateStatus');
  body.set('newsId', newsId);
  body.set('status', status);
  body.set('message', message);

  return callGas(gasUrl, {
    method: 'POST',
    body: body,
    redirect: 'follow'
  });
}

// ============================================================
// コピー処理
// ============================================================

/**
 * 文字列をクリップボードへコピーする。
 *
 * navigator.clipboard は https（または localhost）でしか使えない。
 * 使えない場合と失敗した場合の両方でエラーを表示する。
 *
 * @param {string} text - コピーする文字
 * @param {string} label - 画面に出す対象の名前
 */
async function copyToClipboard(text, label) {
  if (text === '') {
    showMessage(label + 'が空のためコピーできません。', 'error');
    return;
  }

  if (!navigator.clipboard || !window.isSecureContext) {
    console.error('[note-helper] クリップボードAPIを使えません。isSecureContext =', window.isSecureContext);

    showMessage(
      'この環境ではコピー機能を使えません。https または http://localhost で開いてください。' +
        '（手動で選択してコピーしてください）',
      'error'
    );
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    showMessage(label + 'をコピーしました。', 'success');
  } catch (error) {
    console.error('[note-helper] コピーに失敗しました:', error);

    showMessage(
      label + 'のコピーに失敗しました。手動で選択してコピーしてください。',
      'error'
    );
  }
}

// ============================================================
// 各ボタンの動作
// ============================================================

/**
 * 通信の前に、使えるURLがあるかを確認する。
 *
 * @returns {string} 使えるURL。無ければ空文字（メッセージは表示済み）
 */
function requireGasUrl() {
  const gasUrl = resolveGasUrl();

  if (gasUrl === '') {
    showMessage('GAS WebアプリURLが設定されていません。URLを入力して「保存」を押してください。', 'error');
    el.gasUrlInput.focus();
    return '';
  }

  if (!isValidHttpsUrl(gasUrl)) {
    showMessage('GAS WebアプリURLの形式が正しくありません。https:// から始まるURLを入力してください。', 'error');
    el.gasUrlInput.focus();
    return '';
  }

  return gasUrl;
}

/** 「保存」 */
function handleSaveUrl() {
  const url = el.gasUrlInput.value.trim();

  if (url === '') {
    showMessage('GAS WebアプリURLを入力してください。', 'error');
    el.gasUrlInput.focus();
    return;
  }

  if (!isValidHttpsUrl(url)) {
    showMessage('https:// から始まるURLを入力してください。', 'error');
    el.gasUrlInput.focus();
    return;
  }

  if (!saveGasUrl(url)) {
    showMessage('URLを保存できませんでした。ブラウザの設定を確認してください。', 'error');
    return;
  }

  showMessage('GAS WebアプリURLを保存しました。', 'success');
}

/** 「接続確認」 */
async function handlePing() {
  if (isBusy) {
    return;
  }

  const gasUrl = requireGasUrl();

  if (gasUrl === '') {
    return;
  }

  clearMessage();
  setBusy(true);
  showMessage('接続を確認しています…', 'info');

  const result = await pingGas(gasUrl);

  setBusy(false);

  if (!result.ok) {
    showFailure(result);
    return;
  }

  const version = String(result.json.version || '不明');
  const serverTime = formatServerTime(result.json.serverTime);

  showMessage(
    '接続できました。（APIバージョン ' + version + ' ／ サーバー時刻 ' + serverTime + '）',
    'success'
  );
}

/** 「次の記事を取得」／「取得する」 */
async function handleFetch() {
  if (isBusy) {
    return;
  }

  const gasUrl = requireGasUrl();

  if (gasUrl === '') {
    return;
  }

  clearMessage();
  showNextPrompt(false);
  clearArticleView();
  setBusy(true);
  showMessage('次の記事を取得しています…', 'info');

  const result = await fetchNextArticle(gasUrl);

  setBusy(false);

  if (!result.ok) {
    // 対象が無いのは異常ではないため、エラー色にせず案内として表示する
    if (result.kind === 'GAS' && result.code === 'NO_TARGET') {
      showMessage('下書き作成対象の記事はありません。', 'info');
      return;
    }

    showFailure(result);
    return;
  }

  // --- 中身が揃っているか確認する ---
  const data = result.json.data;

  if (!data) {
    console.error('[note-helper] dataが含まれていません:', result.json);
    showMessage('GASの応答に data が含まれていません。', 'error');
    return;
  }

  const newsId = String(data.newsId || '').trim();
  const title = String(data.title || '').trim();
  const body = String(data.body || '').trim();

  if (title === '' && body === '') {
    showMessage('取得した記事のタイトルと本文が両方空でした。シートの内容を確認してください。', 'error');
    return;
  }

  if (title === '') {
    showMessage('取得した記事のタイトルが空でした。', 'error');
    return;
  }

  if (body === '') {
    showMessage('取得した記事の本文が空でした。', 'error');
    return;
  }

  if (newsId === '') {
    showMessage('取得した記事のニュースIDが空でした。状況の更新ができないため中止します。', 'error');
    return;
  }

  renderArticle({
    newsId: newsId,
    title: title,
    body: body,
    status: String(data.status || '').trim()
  });

  showMessage('記事を取得しました。コピーしてnoteへ貼り付けてください。', 'success');
}

/** 「noteを開く」 */
function handleOpenNote() {
  // noopener を付けると、開いた先からこのページを操作されるのを防げる
  window.open(NOTE_NEW_POST_URL, '_blank', 'noopener');

  showMessage('noteの新規投稿画面を開きました。', 'info');
}

/**
 * 記事状況を更新して、表示を消す共通処理。
 *
 * @param {string} status - 設定するステータス
 * @param {string} message - GASのJ列へ記録する内容
 * @param {string} loadingText - 通信中に出す文章
 * @param {string} successText - 成功時に出す文章
 * @param {boolean} askNext - 成功後に「次の記事を取得しますか？」を出すか
 */
async function submitStatus(status, message, loadingText, successText, askNext) {
  if (isBusy) {
    return;
  }

  if (currentNewsId === '') {
    showMessage('記事が表示されていません。先に記事を取得してください。', 'error');
    return;
  }

  const gasUrl = requireGasUrl();

  if (gasUrl === '') {
    return;
  }

  clearMessage();
  setBusy(true);
  showMessage(loadingText, 'info');

  const result = await updateArticleStatus(gasUrl, currentNewsId, status, message);

  setBusy(false);

  if (!result.ok) {
    showFailure(result);
    return;
  }

  clearArticleView();
  showMessage(successText, 'success');

  if (askNext) {
    showNextPrompt(true);
  }
}

/** 「投稿完了」 */
function handleComplete() {
  submitStatus(
    ARTICLE_STATUS.DRAFTED,
    // 投稿完了ではエラー内容を残さないため空文字を送る
    '',
    '記事状況を更新しています…',
    '「' + ARTICLE_STATUS.DRAFTED + '」に更新しました。',
    // 続けて作業できるよう案内を出す
    true
  );
}

/** 「エラーとして記録」 */
function handleRecordError() {
  const errorText = el.errorMessageInput.value.trim();

  if (errorText === '') {
    showMessage('エラー内容を入力してください。', 'error');
    el.errorMessageInput.focus();
    return;
  }

  submitStatus(
    ARTICLE_STATUS.ERROR,
    errorText,
    '記事状況を更新しています…',
    '「' + ARTICLE_STATUS.ERROR + '」として記録しました。',
    false
  );
}

/** 「記事を閉じる」 */
function handleClose() {
  if (currentNewsId === '') {
    return;
  }

  clearArticleView();
  showNextPrompt(false);

  showMessage(
    '画面の表示を消しました。シートの記事状況は「取得済」のままです。',
    'info'
  );
}

// ============================================================
// 起動処理
// ============================================================

function init() {
  // --- GAS設定 ---
  el.saveUrlButton.addEventListener('click', handleSaveUrl);
  el.pingButton.addEventListener('click', handlePing);

  // --- 記事取得 ---
  el.fetchButton.addEventListener('click', handleFetch);
  el.fetchNextButton.addEventListener('click', handleFetch);

  el.dismissPromptButton.addEventListener('click', function () {
    showNextPrompt(false);
    clearMessage();
  });

  // --- コピー ---
  el.copyTitleButton.addEventListener('click', function () {
    copyToClipboard(el.articleTitleText.value, 'タイトル');
  });

  el.copyBodyButton.addEventListener('click', function () {
    copyToClipboard(el.articleBodyText.value, '本文');
  });

  el.copyBothButton.addEventListener('click', function () {
    const title = el.articleTitleText.value;
    const body = el.articleBodyText.value;

    // タイトルと本文の間を空行で区切る（改行はそのまま保たれる）
    copyToClipboard(title + '\n\n' + body, 'タイトルと本文');
  });

  // --- そのほかの操作 ---
  el.openNoteButton.addEventListener('click', handleOpenNote);
  el.completeButton.addEventListener('click', handleComplete);
  el.errorButton.addEventListener('click', handleRecordError);
  el.closeButton.addEventListener('click', handleClose);

  // --- 本文の文字数表示 ---
  el.articleBodyText.addEventListener('input', updateBodyLength);

  // --- 保存済みURLの復元 ---
  const savedUrl = loadGasUrl();

  if (savedUrl) {
    el.gasUrlInput.value = savedUrl;
    console.log('[note-helper] 保存済みGAS URLを復元しました。');
  } else {
    showMessage('最初にGAS WebアプリURLを入力して「保存」を押してください。', 'info');
  }
}

init();

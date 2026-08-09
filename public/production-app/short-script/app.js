/*
 * ショート動画 台本メーカーのエントリ。
 *
 * ==================================================================
 * 画面の出し方（名刺OCR ../card-ocr/app.js と同じ約束）
 * ==================================================================
 *   1. setScreenDepth(2) … /production-app/short-script/ はルートから2階層。
 *   2. guardPage() が利用者を返すまで中身（#ss-content）を出さない。
 *   3. APIキーは KeyStore の有無だけを見る。**値を読むのは生成の瞬間だけ**で、
 *      画面へは出さない・ログにも出さない。
 * ==================================================================
 */

import { guardPage } from '../../auth/session.js';
import { setScreenDepth } from '../../auth/config.js';
import { KeyStore, PROVIDERS, isKeyStoreAvailable } from '../../auth/keystore.js';
import { generateScript, describeGeminiError } from './gemini.js';
import { buildPastedScript, estimateSeconds } from './paste.js';
import {
  fetchSpeakers,
  startEngine,
  waitForEngineOnline,
  renderVideo,
  videoUrl,
} from './companion.js';
import { DURATIONS, DEFAULT_DURATION, THEME_MAX_LENGTH, APP_VERSION } from './config.js';
import { PROMPT_VERSION } from './prompt.js';

setScreenDepth(2);

/* ---------- DOM ---------- */

const el = (id) => document.getElementById(id);

const dom = {
  loading: el('ss-loading'),
  content: el('ss-content'),
  guidance: el('ss-guidance'),
  guidanceTitle: el('ss-guidance-title'),
  guidanceText: el('ss-guidance-text'),
  portalLink: el('ss-portal-link'),
  form: el('ss-form'),
  theme: el('ss-theme'),
  generate: el('ss-generate'),
  cancel: el('ss-cancel'),
  pasteForm: el('ss-paste'),
  pasteTitle: el('ss-paste-title'),
  pasteBody: el('ss-paste-body'),
  usePaste: el('ss-use-paste'),
  segForm: el('ss-segments'),
  segTitle: el('ss-seg-title'),
  segList: el('ss-seg-list'),
  segAdd: el('ss-seg-add'),
  useSeg: el('ss-use-seg'),
  bgField: el('ss-bg-field'),
  message: el('ss-message'),
  result: el('ss-result'),
  resultTitle: el('ss-result-title'),
  resultMeta: el('ss-result-meta'),
  scenes: el('ss-scenes'),
  copy: el('ss-copy'),
  download: el('ss-download'),
  regenerate: el('ss-regenerate'),
  video: el('ss-video'),
  companionGuidance: el('ss-companion-guidance'),
  companionText: el('ss-companion-text'),
  companionRetry: el('ss-companion-retry'),
  engineStart: el('ss-engine-start'),
  speaker: el('ss-speaker'),
  speed: el('ss-speed'),
  speedVal: el('ss-speed-val'),
  bg: el('ss-bg'),
  render: el('ss-render'),
  renderCancel: el('ss-render-cancel'),
  renderDetail: el('ss-render-detail'),
  videoOut: el('ss-video-out'),
  videoEl: el('ss-video-el'),
  videoDownload: el('ss-video-download'),
};

/* いま表示している台本。コピー・保存・動画化で使う。 */
let currentScript = null;
/* 台本生成中の中止に使う。 */
let activeController = null;
/* 動画生成中の中止に使う。 */
let renderController = null;

/*
 * 補助サービスの状態。'checking' | 'offline' | 'engine-offline' | 'online'。
 *   offline        … ai-video-app 自体に到達できない
 *   engine-offline … ai-video-app は応答するが VOICEVOX が使えない（mock 含む）
 * 「アプリの失敗」と「エンジンの失敗」を1本の真偽値に潰さないための3状態。
 */
let companionState = 'checking';
/* 補助サービスが使えるか。companionState === 'online' の導出値（既存参照箇所を壊さない）。 */
let companionReady = false;
/* 「エンジンを起動」の多重実行防止。 */
let engineStarting = false;

function setCompanionState(state) {
  companionState = state;
  companionReady = state === 'online';
}

/* ---------- 小さなヘルパー ---------- */

function show(node) {
  if (node) {
    node.hidden = false;
  }
}

function hide(node) {
  if (node) {
    node.hidden = true;
  }
}

/* 進捗・エラーの一言。tone は 'info' | 'error'。 */
function setMessage(text, tone = 'info') {
  if (!dom.message) {
    return;
  }

  if (!text) {
    hide(dom.message);
    dom.message.textContent = '';
    return;
  }

  dom.message.textContent = text;
  dom.message.dataset.tone = tone;
  show(dom.message);
}

function selectedDuration() {
  const checked = dom.form?.querySelector('input[name="ss-duration"]:checked');
  const value = Number(checked?.value);

  return DURATIONS.includes(value) ? value : DEFAULT_DURATION;
}

/* ---------- 入力方法（AI生成 / 貼り付け）の切り替え ---------- */

/* いまの入力方法。'ai' / 'paste' / 'segments'。既定は 'ai'。 */
function currentMode() {
  const checked = document.querySelector('input[name="ss-mode"]:checked');
  const value = checked?.value;
  return value === 'paste' || value === 'segments' ? value : 'ai';
}

/*
 * 入力方法に合わせてパネルを出し分ける。
 * 貼り付け・セグメントは Gemini を呼ばないため、APIキーの案内・制約を受けない。
 */
function applyMode() {
  const mode = currentMode();

  hide(dom.form);
  hide(dom.pasteForm);
  hide(dom.segForm);
  if (mode === 'paste') {
    show(dom.pasteForm);
  } else if (mode === 'segments') {
    show(dom.segForm);
  } else {
    show(dom.form);
  }

  /* 前の結果・メッセージは、方法を切り替えたら引きずらない。 */
  hide(dom.result);
  hide(dom.video);
  setMessage('', 'info');
  refreshKeyState();

  if (mode === 'paste') {
    dom.pasteBody.focus();
  } else if (mode === 'segments') {
    dom.segTitle.focus();
  } else {
    dom.theme.focus();
  }
}

/* ---------- APIキーの状態にあわせて入口を開閉する ---------- */

/*
 * KeyStore の有無だけを見て、案内と生成ボタンを切り替える。
 * **値は読まない**（読むのは実際に生成するときだけ）。
 *
 * 利用者がポータルの別タブでキーを設定して戻ってくることがあるため、
 * 画面が再表示された（visibilitychange / focus）ときに読み直す。
 */
function refreshKeyState() {
  /* 貼り付け・セグメントは Gemini を呼ばない。キーの有無で案内・制約をかけない。 */
  if (currentMode() !== 'ai') {
    hide(dom.guidance);
    return true;
  }

  const storageOk = isKeyStoreAvailable();
  const hasKey = storageOk && KeyStore.has(PROVIDERS.gemini);

  if (!storageOk) {
    dom.guidanceTitle.textContent = 'この端末ではキーを保存できません';
    dom.guidanceText.textContent =
      'プライベートモードなどで localStorage が使えないため、APIキーを保存・参照できません。通常のウィンドウでお試しください。';
    hide(dom.portalLink);
    show(dom.guidance);
    dom.generate.disabled = true;
    return hasKey;
  }

  if (!hasKey) {
    dom.guidanceTitle.textContent = 'Gemini APIキーの設定が必要です';
    dom.guidanceText.textContent =
      '台本の生成には、あなた自身の Gemini APIキーを使います。ポータルの「API設定」で一度だけ設定してください。キーはこの端末にのみ保存され、当社サーバーには送信されません。';
    show(dom.portalLink);
    show(dom.guidance);
    dom.generate.disabled = true;
    return hasKey;
  }

  hide(dom.guidance);
  dom.generate.disabled = false;
  return hasKey;
}

/* ---------- 生成 ---------- */

function setBusy(busy) {
  dom.generate.disabled = busy;
  dom.theme.disabled = busy;

  for (const input of dom.form.querySelectorAll('input[name="ss-duration"]')) {
    input.disabled = busy;
  }

  if (busy) {
    show(dom.cancel);
  } else {
    hide(dom.cancel);
  }
}

async function handleGenerate(event) {
  event.preventDefault();

  if (!refreshKeyState()) {
    return;
  }

  const theme = dom.theme.value.trim();

  if (theme === '') {
    setMessage('テーマを入力してください。', 'error');
    dom.theme.focus();
    return;
  }

  if (theme.length > THEME_MAX_LENGTH) {
    setMessage(`テーマは${THEME_MAX_LENGTH}文字以内で入力してください。`, 'error');
    return;
  }

  const durationSec = selectedDuration();

  /* 生成のたびに前の結果を隠す。古い台本が残って混乱させないため。 */
  hide(dom.result);
  hide(dom.video);
  currentScript = null;

  const controller = new AbortController();
  activeController = controller;
  setBusy(true);
  setMessage('台本を生成しています…', 'info');

  /*
   * キーの値を読むのはこの1行だけ。変数へ受けたら、この関数の外へ渡さない。
   * gemini.js もモジュール内に保持しない設計になっている。
   */
  const apiKey = KeyStore.get(PROVIDERS.gemini);

  try {
    const script = await generateScript(theme, durationSec, {
      apiKey,
      signal: controller.signal,
    });

    if (controller.signal.aborted) {
      return;
    }

    currentScript = { ...script, theme, durationSec, source: 'ai' };
    renderScript(currentScript);
    setMessage('', 'info');
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') {
      setMessage('生成を中止しました。', 'info');
      return;
    }

    const described = describeGeminiError(error);
    setMessage(`${described.text}（${described.errorCode}: ${described.detail}）`, 'error');
  } finally {
    if (activeController === controller) {
      activeController = null;
    }
    setBusy(false);
  }
}

function handleCancel() {
  if (activeController) {
    activeController.abort();
  }
}

/* ---------- 台本の貼り付け（Gemini を介さない） ---------- */

function handleUsePasted(event) {
  event.preventDefault();

  const script = buildPastedScript(dom.pasteTitle.value, dom.pasteBody.value);

  if (!script) {
    setMessage('台本の本文を入力してください。', 'error');
    dom.pasteBody.focus();
    return;
  }

  currentScript = script;
  renderScript(currentScript);
  setMessage('', 'info');
}

/* ---------- セグメント編集（Gemini を介さない） ---------- */

const MAX_SEGMENTS = 20;
let segCounter = 0;

/* セグメント番号を振り直す（追加・削除のたびに）。 */
function renumberSegments() {
  const rows = dom.segList.querySelectorAll('.ss-seg');
  rows.forEach((li, i) => {
    const head = li.querySelector('.ss-seg-num');
    if (head) {
      head.textContent = `セグメント${i + 1}`;
    }
  });
}

/* セグメント行を1つ作って一覧へ足す（innerHTML を使わない）。 */
function addSegmentRow() {
  if (dom.segList.querySelectorAll('.ss-seg').length >= MAX_SEGMENTS) {
    setMessage(`セグメントは最大${MAX_SEGMENTS}個までです。`, 'error');
    return;
  }

  segCounter += 1;
  const base = `ss-seg-${segCounter}`;

  const li = document.createElement('li');
  li.className = 'ss-seg';

  const head = document.createElement('p');
  head.className = 'ss-seg-num';

  const textLabel = document.createElement('label');
  textLabel.className = 'ss-field-label';
  textLabel.setAttribute('for', `${base}-text`);
  textLabel.textContent = 'ナレーション文';

  const textArea = document.createElement('textarea');
  textArea.className = 'ss-field-input ss-textarea';
  textArea.id = `${base}-text`;
  textArea.rows = 3;

  const imgLabel = document.createElement('label');
  imgLabel.className = 'ss-field-label';
  imgLabel.setAttribute('for', `${base}-img`);
  imgLabel.textContent = '背景画像（任意）';

  const imgInput = document.createElement('input');
  imgInput.type = 'file';
  imgInput.className = 'ss-field-input';
  imgInput.id = `${base}-img`;
  imgInput.accept = 'image/png,image/jpeg,image/webp';

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'auth-button auth-button--ghost';
  remove.textContent = 'このセグメントを削除';
  remove.addEventListener('click', () => {
    li.remove();
    renumberSegments();
  });

  const textField = document.createElement('div');
  textField.className = 'ss-field';
  textField.append(textLabel, textArea);

  const imgField = document.createElement('div');
  imgField.className = 'ss-field';
  imgField.append(imgLabel, imgInput);

  const actions = document.createElement('div');
  actions.className = 'ss-actions';
  actions.append(remove);

  li.append(head, textField, imgField, actions);
  dom.segList.append(li);
  renumberSegments();
  textArea.focus();
}

async function handleUseSegments(event) {
  event.preventDefault();

  const rows = Array.from(dom.segList.querySelectorAll('.ss-seg'));
  const picked = [];

  for (const li of rows) {
    const text = li.querySelector('textarea').value.replace(/\r\n?/g, '\n').trim();
    if (text === '') continue; // 空セグメントは飛ばす
    const file = li.querySelector('input[type="file"]').files?.[0] ?? null;
    picked.push({ text, file });
  }

  if (picked.length === 0) {
    setMessage('少なくとも1つのセグメントにナレーション文を入力してください。', 'error');
    return;
  }

  /* 画像を data URL 化。未選択は空文字＝そのセグメントは既定背景。 */
  let images;
  try {
    images = await Promise.all(
      picked.map((s) => (s.file ? fileToDataUrl(s.file) : Promise.resolve(''))),
    );
  } catch {
    setMessage('画像の読み込みに失敗しました。', 'error');
    return;
  }

  currentScript = {
    title: dom.segTitle.value.trim() || 'セグメント台本',
    scenes: picked.map((s) => ({ seconds: estimateSeconds(s.text), text: s.text })),
    segmentImages: images,
    source: 'segments',
  };
  renderScript(currentScript);
  setMessage('', 'info');
}

/* ---------- 結果の描画（innerHTML を使わない） ---------- */

function appendMetaRow(dl, label, value) {
  const dt = document.createElement('dt');
  dt.className = 'ss-meta-label';
  dt.textContent = label;

  const dd = document.createElement('dd');
  dd.className = 'ss-meta-value';
  dd.textContent = value;

  dl.append(dt, dd);
}

function renderScript(script) {
  dom.resultTitle.textContent = script.title;

  const totalSeconds = script.scenes.reduce((sum, scene) => sum + scene.seconds, 0);

  dom.resultMeta.replaceChildren();
  if (script.source === 'ai') {
    appendMetaRow(dom.resultMeta, 'テーマ', script.theme);
    appendMetaRow(dom.resultMeta, '尺（目安）', `${script.durationSec}秒`);
  } else {
    /* 貼り付け・セグメントにはテーマ・尺の指定がない。由来だけ示す。 */
    appendMetaRow(dom.resultMeta, '入力', script.source === 'segments' ? 'セグメント編集' : '貼り付け');
  }
  appendMetaRow(dom.resultMeta, 'シーン数', `${script.scenes.length}個`);
  appendMetaRow(dom.resultMeta, '合計（目安）', `${totalSeconds}秒`);

  /* 「作り直す」は AI 生成のときだけ意味がある。それ以外は隠す。 */
  if (script.source === 'ai') {
    show(dom.regenerate);
  } else {
    hide(dom.regenerate);
  }

  dom.scenes.replaceChildren();

  script.scenes.forEach((scene, index) => {
    const li = document.createElement('li');
    li.className = 'ss-scene';

    const head = document.createElement('p');
    head.className = 'ss-scene-head';

    const num = document.createElement('span');
    num.className = 'ss-scene-num';
    num.textContent = `シーン${index + 1}`;

    const sec = document.createElement('span');
    sec.className = 'ss-scene-sec';
    sec.textContent = `${scene.seconds}秒`;

    head.append(num, sec);

    const body = document.createElement('p');
    body.className = 'ss-scene-text';
    body.textContent = scene.text;

    li.append(head, body);
    dom.scenes.append(li);
  });

  show(dom.result);

  /* 台本ができたので、音声・動画の生成パネルも出す。 */
  showVideoPanel();

  dom.resultTitle.focus?.();
}

/* ---------- コピー / 保存 ---------- */

/* 台本を人が読めるプレーンテキストへ。コピー用。 */
function scriptToPlainText(script) {
  const lines = [script.title, ''];

  script.scenes.forEach((scene, index) => {
    lines.push(`シーン${index + 1}（${scene.seconds}秒）`);
    lines.push(scene.text);
    lines.push('');
  });

  return lines.join('\n').trim() + '\n';
}

async function handleCopy() {
  if (!currentScript) {
    return;
  }

  const text = scriptToPlainText(currentScript);

  try {
    await navigator.clipboard.writeText(text);
    setMessage('台本をコピーしました。', 'info');
  } catch {
    /* クリップボードが使えない環境（権限・古いブラウザ）でも黙らない。 */
    setMessage('コピーできませんでした。手動で選択してコピーしてください。', 'error');
  }
}

/*
 * 後段（音声・字幕・動画）がそのまま食える JSON で保存する。
 * scenes は { seconds, text } の配列。版も添えて、どの指示で作ったか残す。
 */
function handleDownload() {
  if (!currentScript) {
    return;
  }

  /*
   * 後段（音声・字幕・動画）が食うのは title と scenes。
   * 由来ごとに付随情報を変える。貼り付けにはテーマ・尺・プロンプト版がない。
   */
  const data = {
    title: currentScript.title,
    scenes: currentScript.scenes,
    appVersion: APP_VERSION,
  };

  if (currentScript.source === 'ai') {
    data.source = 'ai';
    data.theme = currentScript.theme;
    data.durationSec = currentScript.durationSec;
    data.promptVersion = PROMPT_VERSION;
  } else {
    /* 貼り付け・セグメント。scenes に文が入っている（画像は別送のため含めない）。 */
    data.source = currentScript.source || 'pasted';
  }

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const safeTitle = currentScript.title.replace(/[\\/:*?"<>|]/g, '').slice(0, 40) || 'script';

  const link = document.createElement('a');
  link.href = url;
  link.download = `${safeTitle}.json`;
  document.body.append(link);
  link.click();
  link.remove();

  /*
   * Blob URL は使い終わったら解放する。放置するとメモリに残る。
   * ただし click() の直後に同期で解放すると、一部ブラウザ（Firefox 等）では
   * ダウンロードが始まる前に無効化され、保存が失敗する。次tickへ遅らせる。
   */
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/* ---------- 音声・動画（ローカル補助サービス） ---------- */

/*
 * 補助サービスの状態を確かめ、話者を埋める／使えないなら案内を出す。
 * どの状態でも画面は壊さない（起動して「再確認」で復帰できる）。
 * 状態遷移はこの関数だけが行う（起動ハンドラも最後はここへ戻す）。
 */
async function refreshCompanion() {
  setCompanionState('checking');
  dom.render.disabled = true;
  dom.renderDetail.textContent = '生成サービスを確認しています…';
  show(dom.renderDetail);

  const { ok, speakers, engineStatus } = await fetchSpeakers();
  hide(dom.renderDetail);

  if (!ok) {
    /* ai-video-app 自体に到達できない。起動ボタンは出さない（押しても届かない）。 */
    setCompanionState('offline');
    dom.companionText.textContent =
      'お使いのPCの動画生成サービス（ai-video-app）に接続できません。ai-video-app を起動してから「再確認する」を押してください。';
    hide(dom.engineStart);
    show(dom.companionGuidance);
    dom.render.disabled = true;
    return;
  }

  if (engineStatus === 'offline' || engineStatus === 'mock') {
    /*
     * アプリは応答するがエンジンが使えない。話者一覧はフォールバックが
     * 返ってくるが、それで生成させると無音・失敗の動画になる。
     * mock も online にしない：ダミー音声（無音）の動画を黙って生成させない。
     * 気づくのは書き出し後で、利用者の時間を最も無駄にする失敗だからである。
     */
    setCompanionState('engine-offline');
    dom.companionText.textContent =
      '動画生成サービス（ai-video-app）は起動していますが、音声エンジン（VOICEVOX）が停止しています。「エンジンを起動」を押すと、この画面から起動できます（30秒ほどかかることがあります）。';
    show(dom.engineStart);
    show(dom.companionGuidance);
    dom.render.disabled = true;
    return;
  }

  /*
   * engineStatus === 'online' のほか null も online として扱う。
   * null はヘッダ欠落＝X-Engine-Status を持たない旧版の ai-video-app で、
   * 旧版は従来どおり「speakers が返れば使える」前提で動いていた。
   * ここで弾くと旧版の利用者が一律に生成不能になるため、後方互換で通す。
   */
  setCompanionState('online');
  hide(dom.engineStart);
  hide(dom.companionGuidance);

  /* 話者を埋め直す。応答が空でも既定の1件は出す。 */
  dom.speaker.replaceChildren();
  const list = speakers.length > 0 ? speakers : [{ id: 3, label: 'ずんだもん（ノーマル）' }];
  for (const sp of list) {
    const opt = document.createElement('option');
    opt.value = String(sp.id);
    opt.textContent = sp.label;
    dom.speaker.append(opt);
  }

  dom.render.disabled = false;
}

/*
 * VOICEVOX 未インストール（409 not_installed）の案内。
 * downloadUrl が http(s) の URL なら「公式サイト」をリンクにする。既存の流儀どおり
 * innerHTML は使わず、textContent ベースの DOM 操作で組む（replaceChildren の
 * 文字列引数はテキストノードになる）。downloadUrl は補助サービス由来の値だが、
 * javascript: 等を href に入れないよう形式だけは確かめる。
 */
function showEngineNotInstalled(downloadUrl) {
  if (typeof downloadUrl === 'string' && /^https?:\/\//.test(downloadUrl)) {
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = '公式サイト';
    dom.companionText.replaceChildren(
      'VOICEVOX がインストールされていません。',
      link,
      'からインストールしてから「再確認する」を押してください。',
    );
    return;
  }

  dom.companionText.textContent =
    'VOICEVOX がインストールされていません。公式サイトからインストールしてから「再確認する」を押してください。';
}

/*
 * 「エンジンを起動」。起動を依頼し、online になるまで待って画面を戻す。
 * 成功時の状態遷移は refreshCompanion() の呼び直しに集約する
 * （ここで直接 online へ書き換える経路を作ると、遷移が2系統になり追えなくなる）。
 */
async function handleEngineStart() {
  /*
   * 多重実行の防止と状態の確認。ボタンは engine-offline のときだけ表示して
   * いるが、再確認と競合して隠れる直前のクリックが届くことがあるため、
   * 表示制御だけに頼らず状態でも防ぐ。
   */
  if (engineStarting || companionState !== 'engine-offline') {
    return;
  }

  engineStarting = true;
  dom.engineStart.disabled = true;
  dom.companionRetry.disabled = true;
  /* #ss-companion-guidance は aria-live="polite"。進行状況も読み上げられる。 */
  dom.companionText.textContent =
    '音声エンジン（VOICEVOX）を起動しています…（30秒ほどかかることがあります）';

  try {
    const { status, downloadUrl } = await startEngine();

    if (status === 0) {
      /* 通信断＝ai-video-app 自体が落ちた。判定は refreshCompanion に任せて offline へ。 */
      await refreshCompanion();
      return;
    }

    if (status === 404) {
      /* /api/engine/start を持たない旧版。押し直しても直らないので手動起動を案内する。 */
      dom.companionText.textContent =
        'お使いの ai-video-app が古いため、この画面からは起動できません。VOICEVOX を手動で起動してから「再確認する」を押してください。';
      return;
    }

    if (status === 409) {
      /*
       * VOICEVOX 未インストール（reason: not_installed）。ポーリングしても起動しない
       * ため、30秒待たせず即座に案内する（待った末の汎用文言になっていた）。
       */
      showEngineNotInstalled(downloadUrl);
      return;
    }

    /*
     * 起動依頼は届いた（エラー応答でも、起動が遅れているだけの場合があるため
     * ここでは打ち切らず）、online になるまでポーリングで待つ。
     */
    const { online, unreachable } = await waitForEngineOnline();

    if (unreachable) {
      /*
       * ポーリング中に ai-video-app 自体が落ちた。エンジンではなくアプリ側の
       * 問題なので、refreshCompanion に流して offline 表示へ収束させる。
       * そのまま offline なら、汎用の接続案内より状況が分かる専用文言に差し替える
       * （瞬断から復帰していた場合は refreshCompanion の判定を尊重して触らない）。
       */
      await refreshCompanion();
      if (companionState === 'offline') {
        dom.companionText.textContent =
          'ai-video-app への接続が失われました。ai-video-app を起動し直してから「再確認する」を押してください。';
      }
      return;
    }

    if (online) {
      await refreshCompanion();
      return;
    }

    dom.companionText.textContent =
      '起動を確認できませんでした。VOICEVOX が正しくインストールされているかを確認のうえ、手動で起動してから「再確認する」を押してください。';
  } finally {
    engineStarting = false;
    dom.engineStart.disabled = false;
    dom.companionRetry.disabled = false;
  }
}

/* 台本ができたら動画パネルを出し、補助サービスを確認する。 */
function showVideoPanel() {
  hide(dom.videoOut);
  hide(dom.renderDetail);
  /* セグメント編集は画像を各セグメントで指定済み。全体アップロード欄は隠す。 */
  if (currentScript?.source === 'segments') {
    hide(dom.bgField);
  } else {
    show(dom.bgField);
  }
  show(dom.video);
  refreshCompanion();
}

function setRendering(busy) {
  dom.render.disabled = busy || !companionReady;
  dom.speaker.disabled = busy;
  dom.speed.disabled = busy;
  dom.bg.disabled = busy;

  if (busy) {
    show(dom.renderCancel);
  } else {
    hide(dom.renderCancel);
  }
}

/* 選ばれた背景画像を data URL の配列にする。上限まで。 */
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function readBackgrounds() {
  const files = Array.from(dom.bg?.files ?? []).slice(0, 12);
  if (files.length === 0) {
    return [];
  }
  return Promise.all(files.map(fileToDataUrl));
}

async function handleRender() {
  if (!currentScript || !companionReady) {
    return;
  }

  hide(dom.videoOut);
  show(dom.renderDetail);
  dom.renderDetail.textContent = '準備しています…';

  const controller = new AbortController();
  renderController = controller;
  setRendering(true);

  let backgrounds = [];
  if (currentScript.source === 'segments') {
    /* セグメント編集では画像はセグメントごとに指定済み（scenes と1:1）。 */
    backgrounds = Array.isArray(currentScript.segmentImages) ? currentScript.segmentImages : [];
  } else {
    try {
      backgrounds = await readBackgrounds();
    } catch {
      /* 画像の読み込みに失敗しても、背景なし（既定）で続ける。 */
      backgrounds = [];
    }
  }

  const options = {
    speakerId: Number(dom.speaker.value) || 3,
    speedScale: Number(dom.speed.value) || 1,
    backgrounds,
  };

  try {
    const done = await renderVideo(currentScript, options, {
      signal: controller.signal,
      onEvent: (ev) => {
        if (ev.type === 'stage' && ev.detail) {
          dom.renderDetail.textContent = ev.detail;
        }
      },
    });

    if (controller.signal.aborted) {
      return;
    }

    /* 完成。動画は補助サービス（別オリジン）から配信される。 */
    const url = videoUrl(done.videoId);
    dom.videoEl.src = url;
    dom.videoDownload.href = url;
    dom.videoDownload.setAttribute('download', `${currentScript.title || 'video'}.mp4`);
    hide(dom.renderDetail);
    show(dom.videoOut);
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') {
      dom.renderDetail.textContent = '動画の生成を中止しました。';
      return;
    }
    dom.renderDetail.textContent = error?.message || '動画の生成に失敗しました。';
  } finally {
    if (renderController === controller) {
      renderController = null;
    }
    setRendering(false);
  }
}

function handleRenderCancel() {
  if (renderController) {
    renderController.abort();
  }
}

/* ---------- 起動 ---------- */

async function init() {
  const user = await guardPage();

  if (!user) {
    /* すでにログイン画面へ遷移している。ここで描画を止める。 */
    return;
  }

  hide(dom.loading);
  show(dom.content);

  dom.form.addEventListener('submit', handleGenerate);
  dom.cancel.addEventListener('click', handleCancel);
  dom.pasteForm.addEventListener('submit', handleUsePasted);
  dom.segForm.addEventListener('submit', handleUseSegments);
  dom.segAdd.addEventListener('click', addSegmentRow);
  dom.copy.addEventListener('click', handleCopy);
  dom.download.addEventListener('click', handleDownload);
  dom.regenerate.addEventListener('click', () => {
    /* 同じテーマ・尺で作り直す。フォーム送信を再利用する。 */
    dom.form.requestSubmit();
  });

  for (const radio of document.querySelectorAll('input[name="ss-mode"]')) {
    radio.addEventListener('change', applyMode);
  }

  dom.render.addEventListener('click', handleRender);
  dom.renderCancel.addEventListener('click', handleRenderCancel);
  dom.companionRetry.addEventListener('click', refreshCompanion);
  dom.engineStart.addEventListener('click', handleEngineStart);
  dom.speed.addEventListener('input', () => {
    dom.speedVal.textContent = Number(dom.speed.value).toFixed(2);
  });

  /* ポータルでキーを設定して戻ってきたら、案内を消す。 */
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshKeyState();
    }
  });
  globalThis.addEventListener('focus', refreshKeyState);

  /* セグメント編集は最初の1行を用意しておく。 */
  addSegmentRow();

  /* 初期表示。既定は AI モード。applyMode がパネル・キー状態・フォーカスを整える。 */
  applyMode();
}

init();

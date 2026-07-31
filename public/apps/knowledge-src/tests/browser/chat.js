/*
 * AIナレッジチャットの統合＋UIテスト。
 *
 * 本番コードをそのまま動かし、差し替えるのは
 *   - globalThis.fetch（Drive API のモック。ナレッジを用意するため）
 *   - LLMエンジン（setEngineFactory で偽物へ）
 * だけ。実モデル（1.4GB）はダウンロードしない。
 */

import { loadFixtures, installFakeGis, installFakeFetch, createTree } from './fake-drive.js';
import { createFakeEngineFactory } from './fake-engine.js';

import { openDb, db } from '../../src/db/db.js';
import { clearAllCache, setSyncOptions, countChunks } from '../../src/db/repo.js';
import { runSync, terminateParseWorker } from '../../src/sync/sync-engine.js';
import { clearIndex, search, terminateSearchWorker } from '../../src/search/search-service.js';
import { resetAuth } from '../../src/auth/google-auth.js';
import { el } from '../../src/core/dom.js';

import { setEngineFactory, prepareEngine, disposeEngine, isEngineReady, normalizeProgress, normalizeEngineError } from '../../src/chat/engine/llm-engine.js';
import { ChatErrorCode } from '../../src/chat/engine/errors.js';
import { createChatStore, ModelState, ChatState } from '../../src/chat/state/chat-state.js';
import { createActions } from '../../src/chat/actions.js';
import { mountChat } from '../../src/chat/ui/chat-app.js';
import { loadKnowledgeSummary, loadNeighborChunks } from '../../src/chat/knowledge-source.js';
import { clearConversations, listConversations } from '../../src/chat/state/history-repo.js';

const out = document.getElementById('out');
const lines = [];
let total = 0;
let failed = 0;
const failures = [];

const log = (text) => { lines.push(text); out.textContent = lines.join('\n'); };
const section = (title) => log(`\n=== ${title} ===`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, condition, extra) {
  total += 1;
  if (condition) {
    log(`  ok   ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    log(`  NG   ${name} ${extra === undefined ? '' : JSON.stringify(extra).slice(0, 300)}`);
  }
}

/* 想定外のエラーを数える。 */
const unhandled = [];
const consoleErrors = [];
window.addEventListener('unhandledrejection', (e) => unhandled.push(String(e.reason?.code ?? e.reason).slice(0, 120)));
const originalConsoleError = console.error;
console.error = (...args) => {
  const text = args.map(String).slice(0, 2).join(' ');
  if (!text.startsWith('[knowledge]')) consoleErrors.push(text);
  originalConsoleError.apply(console, args);
};

/* 外部LLM APIへの通信を検出する（1件でもあれば異常）。 */
const externalCalls = [];
const FOLDER = { id: 'f-kn', name: '01_ナレッジ', path: 'マイドライブ / TSAM AI / ローカルLLM / 01_ナレッジ' };

function buildShell() {
  document.body.append(
    el('header', {}, [el('div', { id: 'status-bar', class: 'app-status', role: 'status', 'aria-live': 'polite' })]),
    el('main', { id: 'main', tabindex: '-1' }),
  );
}

async function main() {
  let net = null;

  try {
    const fixtures = await loadFixtures(['sample.txt', 'sample.md', 'sample.pdf', 'sample.docx', 'sample-sjis.txt']);
    installFakeGis();
    const scenario = {};
    net = installFakeFetch({ tree: createTree(fixtures), scenario });

    /* fetch をさらに包み、外部LLM APIらしき宛先を記録する。 */
    const wrapped = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = String(typeof input === 'string' ? input : (input instanceof URL ? input.href : input?.url ?? ''));
      if (/openai|anthropic|generativelanguage|googleapis\.com\/v1beta|cohere|mistral|api\.groq/i.test(url)) {
        externalCalls.push(url.slice(0, 120));
      }
      return wrapped(input, init);
    };

    await openDb();
    await clearAllCache({ keepSettings: false });
    await clearIndex();
    await clearConversations();
    await setSyncOptions({ maxFileBytes: 40 * 1024 * 1024, pageSize: 100, concurrency: 2, recursive: true, maxDepth: 5 });

    buildShell();

    /* ============================================================ */
    section('1. ナレッジ0件の状態');

    let summary = await loadKnowledgeSummary();
    check('チャンク0件', summary.chunkCount === 0);
    check('ナレッジ無しと判定', summary.hasKnowledge === false);
    check('エラーではない', summary.error === null);

    const store = createChatStore();
    const ui = mountChat({ store, actions: null });
    const actions = createActions({ store, ui });
    ui.setActions(actions);

    store.patch({
      booted: true,
      dbReady: true,
      knowledge: summary,
      environment: { usable: true, gpu: 'ok', online: true, browser: 'Chrome', mobile: false, requirements: [], optional: [], adapterInfo: null, message: '', hint: '' },
    });
    await actions.restoreSettings();
    await wait(120);

    const text = () => document.getElementById('main').textContent;
    const role = (name) => document.querySelector(`[data-role="${name}"]`);

    check('ナレッジ0件の案内を出す', text().includes('同期済みのナレッジがありません'));
    check('ナレッジ管理へのリンクを出す', Boolean([...document.querySelectorAll('a')].find((a) => a.textContent === 'ナレッジ管理を開く')));
    check('モデル未読込では入力を無効化', document.getElementById('chat-input')?.disabled === true);
    check('初回説明を出す', text().includes('あなたのブラウザ内で動作します'));
    check('外部AI APIへ送信しないと明示', text().includes('外部のAI APIへ送信しません'));
    check('初回ダウンロードがあることを隠さない', text().includes('初回だけAIモデルのファイルをダウンロードする通信が発生します'));
    check('キャッシュ削除で再取得と明示', text().includes('再ダウンロードが必要'));
    check('WebGPU非対応の可能性を明示', text().includes('WebGPU非対応の端末では利用できません'));
    check('モデル準備ボタンがある', Boolean(role('prepare-model')));
    check('自動ダウンロードしない', store.get().modelState === ModelState.IDLE);

    /* ============================================================ */
    section('2. ナレッジを用意する（既存の同期をそのまま使う）');

    const sync = await runSync({ folder: FOLDER });
    check('同期できる', sync.failed === 0 && sync.added > 0, sync);
    check('チャンクができる', (await countChunks()) > 0);

    await actions.refreshKnowledge();
    summary = store.get().knowledge;
    check('件数を読み出せる', summary.chunkCount > 0 && summary.indexedFileCount > 0, summary);
    check('最終同期日時を読み出せる', typeof summary.lastSyncAt === 'string' && summary.lastSyncAt.length > 0);
    await wait(120);
    check('件数を状態バーに出す', document.getElementById('status-bar').textContent.includes('チャンク'));
    check('ナレッジ0件の案内が消える', !text().includes('同期済みのナレッジがありません'));

    const neighbors = await loadNeighborChunks((await db.chunks.toArray())[0].fileId, 0, { before: 1, after: 1 });
    check('前後チャンクを引ける', neighbors.length >= 1);

    /* ============================================================ */
    section('3. モデルの準備（偽エンジン）');

    const fake = createFakeEngineFactory();
    setEngineFactory(fake.factory);

    const progressSeen = [];
    store.subscribe((s) => {
      if (s.modelProgress) progressSeen.push(s.modelProgress.phase);
    });

    await actions.prepareModel();
    await wait(60);

    check('モデルが利用可能になる', store.get().modelState === ModelState.READY, store.get().lastError);
    check('エンジンが読み込まれる', isEngineReady() === true);
    check('ダウンロード進捗が流れる', progressSeen.includes('downloading'));
    check('初期化段階が流れる', progressSeen.includes('initializing'));
    check('進捗表示が消える', store.get().modelProgress === null);
    check('モデル情報を保持する', store.get().modelInfo?.modelId === store.get().modelId);
    check('準備は1回だけ', fake.state.created === 1, fake.state.created);
    await wait(120);
    check('入力が有効になる', document.getElementById('chat-input')?.disabled === false);
    check('初回説明が消える', !text().includes('あなたのブラウザ内で動作します'));

    /* ============================================================ */
    section('4. 質問と回答（RAG）');

    net.reset();
    externalCalls.length = 0;

    actions.setDraft('テスト用キーワードあいうえお について教えて');
    await actions.submit();
    await wait(120);

    const messages = store.get().messages;
    const answer = messages[messages.length - 1];

    check('質問と回答が並ぶ', messages.length === 2 && messages[0].role === 'user' && answer.role === 'assistant');
    check('回答が生成される', answer.text.length > 0);
    check('生成が終わっている', answer.streaming === false);
    check('待機状態へ戻る', store.get().chatState === ChatState.IDLE);
    check('引用元を持つ', Array.isArray(answer.sources) && answer.sources.length > 0, answer.searchInfo);
    check('引用元にファイル名がある', answer.sources[0].fileName.length > 0);
    check('引用元に関連度がある', typeof answer.sources[0].score === 'number');
    check('引用元にDriveリンクがある', answer.sources[0].driveUrl.startsWith('https://drive.google.com/'));

    /* プロンプトの中身を確認する。 */
    const prompt = fake.state.lastMessages;
    check('systemプロンプトを渡す', prompt[0].role === 'system');
    check('資料をタグで囲んで渡す', prompt[prompt.length - 1].content.includes('<knowledge_sources>'));
    check('質問を渡す', prompt[prompt.length - 1].content.includes('テスト用キーワードあいうえお'));
    check('資料本文を渡す', prompt[prompt.length - 1].content.includes('<source id="1"'));
    check('生成パラメータを渡す', fake.state.lastOptions.maxTokens > 0 && typeof fake.state.lastOptions.temperature === 'number');

    check('外部LLM APIへの通信0件', externalCalls.length === 0, externalCalls);
    check('Driveへの非GET0件', net.nonGet().length === 0, net.nonGet());
    check('質問中にDrive通信をしない', net.requests.length === 0, net.requests.length);

    await wait(150);
    check('回答を画面に出す', text().includes('これはテスト回答です'));
    check('引用元を画面に出す', text().includes('参照した資料（'));
    check('チャンク番号を出す', text().includes('チャンク '));
    check('Driveで開くリンクを出す', Boolean([...document.querySelectorAll('a')].find((a) => a.textContent === 'Driveで開く')));
    check('ナレッジ管理で検索するリンクを出す', Boolean([...document.querySelectorAll('a')].find((a) => a.textContent === 'ナレッジ管理で検索')));

    /* ============================================================ */
    section('5. ストリーミングと停止');

    fake.state.tokenDelayMs = 8;
    fake.state.answer = 'あ'.repeat(200);

    actions.newConversation();
    /* 資料に当たる語を含めて、根拠不足で断られないようにする。 */
    actions.setDraft('テスト用キーワードあいうえお の詳しい説明');
    const pending = actions.submit();

    await wait(120);
    const mid = store.get().messages.find((m) => m.role === 'assistant');
    check('生成中の状態になる', store.get().chatState === ChatState.GENERATING || store.get().chatState === ChatState.RETRIEVING);
    check('途中経過が入る', mid.text.length > 0 && mid.text.length < 200, mid.text.length);
    check('生成中と表示する', mid.streaming === true);

    actions.stop();
    await pending;
    await wait(60);

    const stopped = store.get().messages.find((m) => m.role === 'assistant');
    check('停止できる', stopped.streaming === false);
    check('停止として記録する', stopped.stopped === true);
    check('途中までの回答を残す', stopped.text.length > 0 && stopped.text.length < 200);
    check('停止後は待機へ戻る', store.get().chatState === ChatState.IDLE);
    check('エンジンへ中断を伝える', fake.state.interrupted > 0);

    fake.state.tokenDelayMs = 0;
    fake.state.answer = 'これはテスト回答です。[1]';

    /* ============================================================ */
    section('6. 二重送信の防止');

    actions.newConversation();
    fake.state.tokenDelayMs = 5;
    actions.setDraft('テスト用キーワードあいうえお 二重送信');

    const first = actions.submit();
    await wait(20);
    actions.setDraft('テスト用キーワードあいうえお 二重送信2');
    const second = await actions.submit();
    await first;
    await wait(60);

    check('2件目は拒否される', second === null);
    check('会話は1往復だけ', store.get().messages.length === 2, store.get().messages.length);
    fake.state.tokenDelayMs = 0;

    /* ============================================================ */
    section('7. 検索結果が無い場合は、AIを動かさずに断る');

    actions.newConversation();
    fake.state.chats = 0;
    actions.setDraft('xyzzy plugh frobnicate');
    await actions.submit();
    await wait(80);

    const noHit = store.get().messages.find((m) => m.role === 'assistant');
    check('決まった文言で断る', noHit.text === '同期済みナレッジから回答できませんでした。', noHit.text);
    check('断ったことを記録する', noHit.refused === true);
    check('引用元は空', noHit.sources.length === 0);
    check('根拠レベルは0', noHit.grounding?.level === 0, noHit.grounding);
    check('モデルを動かさない', fake.state.chats === 0, fake.state.chats);
    check('待機状態へ戻る', store.get().chatState === ChatState.IDLE);
    await wait(80);
    check('画面にも断り文言を出す', text().includes('同期済みナレッジから回答できませんでした'));
    check('次の手を案内する', text().includes('資料で使われている表現に近づけて'));
    check('推測しないと明示する', text().includes('推測で答えることはしません'));
    check('もう一度試せる', Boolean(role('regenerate')));

    /* 制限を外せば、従来どおり「資料なし」の回答を作る。 */
    await actions.updateSettings({ minGroundingLevel: 0 });
    actions.newConversation();
    actions.setDraft('xyzzy plugh frobnicate');
    await actions.submit();
    await wait(80);

    const forced = store.get().messages.find((m) => m.role === 'assistant');
    check('制限を外せば回答する', forced.refused !== true && forced.text.length > 0);
    check('資料が無いことをプロンプトへ書く',
      fake.state.lastMessages[fake.state.lastMessages.length - 1].content.includes('該当する資料は見つかりませんでした'));
    await actions.updateSettings({ minGroundingLevel: 2 });

    /* ============================================================ */
    section('8. 一般モード');

    actions.setMode('general');
    actions.newConversation();
    net.reset();
    actions.setDraft('こんにちは');
    await actions.submit();
    await wait(80);

    check('資料を検索しない', store.get().messages[1].sources.length === 0);
    check('一般用のsystemを使う', fake.state.lastMessages[0].content.includes('社内資料を参照していない'));
    check('Drive通信をしない', net.requests.length === 0);
    actions.setMode('knowledge');

    /* ============================================================ */
    section('9. エラーの分類');

    check('中断はキャンセル扱い',
      normalizeEngineError(Object.assign(new Error('x'), { name: 'AbortError' })).code === ChatErrorCode.CANCELLED_BY_USER);
    check('GPUロストを分類', normalizeEngineError(new Error('GPUDevice was lost')).code === ChatErrorCode.GPU_DEVICE_LOST);
    check('メモリ不足を分類', normalizeEngineError(new Error('out of memory')).code === ChatErrorCode.OUT_OF_MEMORY);
    check('容量不足を分類', normalizeEngineError(new Error('quota exceeded')).code === ChatErrorCode.CACHE_QUOTA_EXCEEDED);
    check('通信失敗を分類', normalizeEngineError(new TypeError('Failed to fetch')).code === ChatErrorCode.MODEL_DOWNLOAD_FAILED);
    check('WebGPU不可を分類', normalizeEngineError(new Error('WebGPU not available')).code === ChatErrorCode.WEBGPU_UNAVAILABLE);
    check('日本語メッセージがある',
      normalizeEngineError(new Error('out of memory')).userMessage.includes('メモリ'));

    check('進捗を正規化できる',
      normalizeProgress({ text: 'Fetching param cache[3/50]: 120MB fetched. 24% completed', progress: 0.24 }).loadedMB === 120);
    check('ファイル番号を取り出せる',
      normalizeProgress({ text: 'Fetching param cache[3/50]', progress: 0.2 }).fileIndex === 3);
    check('初期化段階を判定できる',
      normalizeProgress({ text: 'Loading model to GPU', progress: 0.9 }).phase === 'initializing');

    /* ダウンロード失敗 → 再試行 */
    await disposeEngine();
    const failing = createFakeEngineFactory({ mode: 'download-fail' });
    setEngineFactory(failing.factory);
    store.setModelState(ModelState.IDLE);
    await actions.prepareModel();
    await wait(40);

    check('ダウンロード失敗をエラーにする', store.get().modelState === ModelState.ERROR);
    check('利用者向けメッセージを出す', store.get().lastError?.message.includes('ダウンロードに失敗'));
    await wait(80);
    check('再試行ボタンを出す', role('prepare-model')?.textContent.includes('再試行'));

    setEngineFactory(fake.factory);
    await actions.prepareModel();
    await wait(40);
    check('再試行で復帰できる', store.get().modelState === ModelState.READY);

    /* ============================================================ */
    section('10. 会話履歴');

    actions.newConversation();
    actions.setDraft('テスト用キーワードあいうえお 履歴のテスト');
    await actions.submit();
    await wait(120);

    const saved = await listConversations();
    check('会話を保存する', saved.length >= 1, saved.length);
    check('題名を付ける', saved[0].title.includes('履歴のテスト'));

    const rows = await db.conversations.toArray();
    const dump = JSON.stringify(rows);
    /* 保存するのは決められた項目だけ。資料の本文を持ち込まない。 */
    const allowedKeys = 'at,errorCode,role,sourceRefs,stopped,text';
    check('保存する項目を限定する',
      rows.every((r) => r.messages.every((m) => Object.keys(m).sort().join(',') === allowedKeys)),
      rows[0]?.messages?.[0] && Object.keys(rows[0].messages[0]).sort().join(','));
    check('参照はチャンクIDの文字列だけ',
      rows.every((r) => r.messages.every((m) => m.sourceRefs.every((x) => typeof x === 'string'))));
    check('資料オブジェクトを保存しない', !dump.includes('"driveUrl"') && !dump.includes('"chunkIndex"'));
    check('トークンを保存しない', !/ya29|Bearer|access_token/i.test(dump));

    await actions.updateSettings({ saveHistory: false });
    actions.newConversation();
    actions.setDraft('テスト用キーワードあいうえお 保存しないテスト');
    await actions.submit();
    await wait(120);
    check('保存しない設定を守る', (await listConversations()).length === saved.length);
    await actions.updateSettings({ saveHistory: true });

    await actions.clearAllConversations();
    check('履歴を全削除できる', (await listConversations()).length === 0);

    /* ============================================================ */
    section('11. モデルキャッシュとナレッジの分離');

    const chunksBefore = await countChunks();
    await actions.clearModelCache();
    check('モデルを解放する', isEngineReady() === false);
    check('ナレッジは消えない', (await countChunks()) === chunksBefore, { before: chunksBefore, after: await countChunks() });
    check('モデル状態が未読込へ戻る', store.get().modelState === ModelState.IDLE);
    check('ナレッジを消していないと案内', store.get().notice.includes('ナレッジのデータは削除していません'));

    setEngineFactory(fake.factory);
    await actions.prepareModel();
    await wait(40);
    check('再準備できる', store.get().modelState === ModelState.READY);

    /* ============================================================ */
    section('12. 根拠レベルと引用の表示');

    actions.newConversation();
    fake.state.answer = 'テスト用キーワードあいうえお について説明します。[1]\n\n参照した資料\n[1] sample.txt';
    actions.setDraft('テスト用キーワードあいうえお とは');
    await actions.submit();
    await wait(150);

    const graded = store.get().messages.find((m) => m.role === 'assistant');
    check('根拠レベルを持つ', typeof graded.grounding?.level === 'number', graded.grounding);
    check('根拠は十分と判定', graded.grounding.level >= 3, graded.grounding);
    check('★の文字列を持つ', graded.grounding.stars.includes('★'));
    check('被覆率を持つ', graded.grounding.coverage > 0.5, graded.grounding.coverage);
    check('引用元に一致率が付く', typeof graded.sources[0].matchRatio === 'number');
    check('引用の検証結果を持つ', Array.isArray(graded.citations?.cited));
    check('引用した番号を認識する', graded.citations.cited.includes(1), graded.citations);
    check('存在しない番号は無い', graded.citations.unknown.length === 0);

    check('画面に根拠★を出す', text().includes('根拠 ★'));
    check('画面に一致率を出す', text().includes('一致率'));
    check('引用済みの資料に印を付ける', text().includes('回答で引用'));

    const citationLink = document.querySelector('.citation');
    check('回答中の[1]をリンクにする', Boolean(citationLink) && citationLink.tagName === 'A');
    check('リンク先が引用元の項目', (() => {
      const href = citationLink?.getAttribute('href') ?? '';
      const id = href.includes('#') ? href.slice(href.indexOf('#') + 1) : '';
      return id !== '' && Boolean(document.getElementById(id));
    })(), citationLink?.getAttribute('href'));
    check('引用リンクに読み上げ用の説明がある',
      (citationLink?.getAttribute('aria-label') ?? '').includes('引用 1'));

    /* 存在しない番号を書いたときは、画面で警告する。 */
    actions.newConversation();
    fake.state.answer = 'テスト用キーワードあいうえお です。[9]';
    actions.setDraft('テスト用キーワードあいうえお とは');
    await actions.submit();
    await wait(150);

    const badCite = store.get().messages.find((m) => m.role === 'assistant');
    check('存在しない引用番号を検出する', badCite.citations.unknown.includes(9), badCite.citations);
    check('画面で警告する', text().includes('存在しない資料番号'));
    check('警告を読み上げ対象にする',
      [...document.querySelectorAll('[role="alert"]')].some((n) => n.textContent.includes('存在しない資料番号')));
    check('不正な引用は取り消し線で示す', Boolean(document.querySelector('.citation--unknown')));

    fake.state.answer = 'これはテスト回答です。[1]';

    /* ============================================================ */
    section('13. 診断（12分類）');

    const diag = await actions.runDiagnostics();
    check('12項目を返す', diag.rows.length === 12, diag.rows.length);
    check('集計を返す', diag.summary.total === 12);
    check('検索を実際に実行する', diag.rows.find((r) => r.id === 'search').status === 'ok', diag.rows.find((r) => r.id === 'search'));
    check('RAGを実際に実行する', diag.rows.find((r) => r.id === 'rag').status === 'ok');
    check('プロンプト防御を確認する', diag.rows.find((r) => r.id === 'prompt').status === 'ok');
    check('IndexedDBを確認する', diag.rows.find((r) => r.id === 'indexeddb').status === 'ok');
    check('保存トークン0件を確認する', diag.rows.find((r) => r.id === 'permission').status === 'ok');
    check('Drive非呼び出しを確認する', diag.rows.find((r) => r.id === 'drive').status === 'ok');
    check('診断で索引を汚さない', (await countChunks()) === chunksBefore);
    check('診断の実行時刻を残す', typeof store.get().diagnosticsAt === 'string');

    await wait(120);
    check('診断表を画面に出す', Boolean(document.querySelector('[data-role="diagnostics-table"]')));
    check('診断の行数が画面と一致',
      document.querySelectorAll('[data-role="diagnostics-table"] tbody tr').length === 12);
    check('診断中に外部通信をしない', externalCalls.length === 0);
    check('診断中にDrive通信をしない', net.requests.length === 0, net.requests.length);

    /* ============================================================ */
    section('14. 画面の使い勝手');

    actions.newConversation();
    await wait(120);
    check('質問の例を出す', document.querySelectorAll('[data-role="example-question"]').length === 3);
    check('例を押すと入力へ入る', (() => {
      document.querySelector('[data-role="example-question"]').click();
      return store.get().draft.length > 0;
    })());
    actions.setDraft('');

    check('会話ログに aria-live がある', document.getElementById('chat-log')?.getAttribute('aria-live') === 'polite');
    check('会話ログに aria-busy がある', document.getElementById('chat-log')?.hasAttribute('aria-busy'));
    check('入力欄に説明が結び付く', document.getElementById('chat-input')?.getAttribute('aria-describedby') === 'chat-input-help');
    check('入力欄に上限がある', document.getElementById('chat-input')?.getAttribute('maxlength') === '2000');
    check('文字数を出す', text().includes('/ 2000 文字'));

    actions.setDraft('操作案内の確認');
    await wait(80);
    check('キーボード操作を案内する', text().includes('Escで生成を停止'));
    actions.setDraft('');
    await wait(60);
    check('送信できない理由を出す', text().includes('質問を入力してください'));
    check('読み上げ用の通知がある', Boolean(document.querySelector('.visually-hidden[role="status"]')));
    check('モデル情報にライセンスを出す', text().includes('ライセンス'));
    check('最低根拠レベルを選べる', Boolean(document.querySelector('[data-role="min-grounding"]')));

    /* Esc で停止できる */
    fake.state.tokenDelayMs = 8;
    fake.state.answer = 'あ'.repeat(200);
    actions.setDraft('テスト用キーワードあいうえお の長い説明');
    const escPending = actions.submit();
    await wait(120);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await escPending;
    await wait(60);
    check('Escで生成を止められる',
      store.get().messages.find((m) => m.role === 'assistant')?.stopped === true);
    fake.state.tokenDelayMs = 0;
    fake.state.answer = 'これはテスト回答です。[1]';

    /* ============================================================ */
    section('15. 通信の総括');

    check('外部LLM APIへの通信0件（全期間）', externalCalls.length === 0, externalCalls);
    check('Drive非GET0件（全期間）', net.nonGet().length === 0, net.nonGet());
    check('質問本文が外部へ出ない', !JSON.stringify(net.requests).includes('テスト用キーワードあいうえお'));

    const storages = JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie });
    check('localStorageに本文を置かない', !storages.includes('これはテスト回答です'));
    check('localStorageにトークンが無い', !storages.includes('fake-token'));
    check('URLに質問が入らない', !location.search.includes('%') && !location.hash.includes('テスト'));
  } catch (error) {
    failed += 1;
    failures.push('FATAL');
    log(`FATAL ${error?.code ?? ''} ${error?.message ?? error}`);
    log(String(error?.stack ?? '').slice(0, 900));
  } finally {
    net?.restore();
    setEngineFactory(null);
    await disposeEngine().catch(() => {});
    resetAuth();
    terminateParseWorker();
    terminateSearchWorker();
  }

  section('16. 想定外のエラー');
  check('unhandledrejection 0件', unhandled.length === 0, unhandled);
  check('想定外の console.error 0件', consoleErrors.length === 0, consoleErrors);

  log(`\nチャットテスト: ${total} 件中 ${total - failed} 件成功 / ${failed} 件失敗`);
  if (failed > 0) {
    log(`失敗: ${failures.join(' / ')}`);
  }
  log(failed === 0 ? 'RESULT: ALL PASS' : `RESULT: ${failed} FAILURES`);
  document.title = failed === 0 ? 'PASS' : 'FAIL';
}

main();

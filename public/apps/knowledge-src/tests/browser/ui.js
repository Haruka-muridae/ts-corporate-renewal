/*
 * 画面（UI・アクセシビリティ）のテスト。
 *
 * 本番と同じ画面シェルを iframe ではなくこのページ内へ組み立てて検証する。
 * 実際のアプリのエントリ（main.js）は副作用が多いため、
 * 画面部品（ui/app.js と views）を直接組み立てる。
 */

/* 本番と同じスタイルを読み込む（レスポンシブ指定などを実際に検証するため）。 */
import '../../src/styles.css';

import { installFakeGis, installFakeFetch, createTree, loadFixtures } from './fake-drive.js';
import { createStore, AppState, FileSyncState } from '../../src/core/state.js';
import { mountApp } from '../../src/ui/app.js';
import { openDb } from '../../src/db/db.js';
import { clearAllCache, putFile, setSelectedFolder } from '../../src/db/repo.js';
import { openFolderBrowser } from '../../src/ui/folder-browser.js';
import { openCreateFoldersDialog } from '../../src/ui/create-folders-dialog.js';
import { openKnowledgeUploadDialog } from '../../src/ui/knowledge-upload-dialog.js';
import { buildFolderPlan, classifyPlan, summarizePlan, formatNodePath } from '../../src/drive/folder-plan.js';
import { makeSetupRecord, createProgress, summarizeDiagnosis } from '../../src/setup/wizard-state.js';
import { FOLDER_STRUCTURE } from '../../src/config.js';
import { formatBytes, formatDateTime, formatNumber, el, clear } from '../../src/core/dom.js';

const out = document.getElementById('out');
const lines = [];
let total = 0;
let failed = 0;
const failures = [];

const log = (text) => { lines.push(text); out.textContent = lines.join('\n'); };
const section = (title) => log(`\n=== ${title} ===`);

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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---- 画面シェルを組み立てるための最小のDOM ---- */

function buildShell() {
  const container = el('div');

  container.append(
    el('header', { class: 'app-header' }, [
      el('div', { class: 'app-header__account', id: 'account-area', 'aria-live': 'polite' }),
      el('nav', { class: 'app-nav', 'aria-label': '画面切り替え' }, [el('ul', { id: 'nav-list', class: 'app-nav__list' })]),
      el('div', { class: 'app-status', id: 'status-bar', role: 'status', 'aria-live': 'polite' }),
    ]),
    el('main', { id: 'main', class: 'app-main', tabindex: '-1' }),
  );

  document.body.append(container);
  return container;
}

async function main() {
  let net = null;

  try {
    const fixtures = await loadFixtures(['sample.txt']);
    installFakeGis();
    const scenario = {};
    net = installFakeFetch({ tree: createTree(fixtures), scenario });

    await openDb();
    await clearAllCache({ keepSettings: false });

    const store = createStore();
    const calls = [];
    const actions = new Proxy({}, {
      get: (target, prop) => (...args) => {
        calls.push({ name: String(prop), args });
        return Promise.resolve(null);
      },
    });

    buildShell();
    const app = mountApp({ store, actions });

    section('1. 画面の構成');

    const nav = document.querySelectorAll('.app-nav__button');
    check('タブが6つある', nav.length === 6, nav.length);
    check('タブの名称', Array.from(nav).map((b) => b.textContent).join('/') === '初期設定/ファイル管理/ナレッジ検索/ストレージ/エラーログ/設定', Array.from(nav).map((b) => b.textContent));
    check('選択中のタブに aria-current', nav[0].getAttribute('aria-current') === 'page');
    check('他のタブには aria-current が無い', !nav[1].hasAttribute('aria-current'));
    check('ナビに aria-label', document.querySelector('.app-nav').getAttribute('aria-label') === '画面切り替え');
    check('状態バーは role=status', document.getElementById('status-bar').getAttribute('role') === 'status');
    check('状態バーは aria-live', document.getElementById('status-bar').getAttribute('aria-live') === 'polite');
    check('スコープを常時表示', document.querySelector('.state-badge--scope')?.textContent.includes('読み取り専用'));
    check('状態バッジに文字がある（色だけに依存しない）', document.querySelector('.state-badge')?.textContent === '未認証');

    section('2. 画面切り替え');

    nav[3].click();
    await wait(120);
    check('ストレージ画面へ切り替わる', document.querySelector('.card__title')?.textContent === 'ストレージ使用量');
    check('切り替え後の aria-current', nav[3].getAttribute('aria-current') === 'page' && !nav[0].hasAttribute('aria-current'));
    check('ハッシュが更新される', window.location.hash === '#storage', window.location.hash);

    window.location.hash = '#search';
    await wait(150);
    check('ハッシュ変更で切り替わる', document.querySelector('.card__title')?.textContent === 'ナレッジ検索');

    app.navigate('files');
    await wait(120);
    check('プログラムからも切り替えられる', document.querySelector('.card__title')?.textContent === '同期状況');

    /* 存在しないハッシュでも壊れない */
    window.location.hash = '#___nope___';
    await wait(150);
    check('未知のハッシュでも画面が出る', document.querySelectorAll('.card').length > 0);

    section('3. キーボード操作');

    app.navigate('search');
    await wait(120);

    const searchInput = document.querySelector('input[type="search"]');
    check('検索入力がある', Boolean(searchInput));
    check('検索入力に aria-label', searchInput.getAttribute('aria-label') === '検索キーワード');

    const focusables = document.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href]');
    check('フォーカスできる要素がある', focusables.length > 0, focusables.length);
    check('負のtabindexで飛ばされる要素が無い', Array.from(focusables).every((e) => e.getAttribute('tabindex') !== '-1'));

    searchInput.focus();
    check('入力へフォーカスできる', document.activeElement === searchInput);

    /* Enter でフォームが送信される（ボタンを押さなくても検索できる） */
    let submitted = false;
    const form = document.querySelector('.search-form');
    form.addEventListener('submit', () => { submitted = true; }, { once: true });
    searchInput.value = 'テスト';
    form.requestSubmit();
    await wait(120);
    check('Enter（submit）で検索が走る', submitted);

    section('4. 状態の反映');

    store.setAppState(AppState.SYNCING);
    store.patch({ progress: { phase: 'parsing', done: 3, total: 10, currentName: 'a.pdf' } });
    await wait(80);
    check('同期中バッジ', document.querySelector('.state-badge')?.textContent === '同期中');
    const bar = document.querySelector('.progress');
    check('進捗バーが出る', Boolean(bar));
    check('進捗は role=progressbar', bar.getAttribute('role') === 'progressbar');
    check('進捗値が入る', bar.getAttribute('aria-valuenow') === '30', bar.getAttribute('aria-valuenow'));
    check('進捗に aria-label', Boolean(bar.getAttribute('aria-label')));
    check('件数を文字で出す', document.getElementById('status-bar').textContent.includes('3/10'));

    store.patch({ progress: null });
    store.setAppState(AppState.ERROR);
    store.patch({ lastError: { code: 'X', message: 'テスト用のエラー文です。' } });
    await wait(80);
    check('エラーバッジ', document.querySelector('.state-badge')?.textContent === 'エラー');
    check('エラー文が出る', document.getElementById('status-bar').textContent.includes('テスト用のエラー文です。'));

    store.setAppState(AppState.SYNC_IDLE);
    store.patch({ lastError: null, folder: { id: 'f-kn', name: '01_ナレッジ', path: 'マイドライブ / TSAM AI / ローカルLLM / 01_ナレッジ' } });
    await wait(80);
    check('対象フォルダを表示', document.getElementById('status-bar').textContent.includes('01_ナレッジ'));

    section('5. 長い文字列の扱い');

    const longName = 'あ'.repeat(300);
    await putFile({
      fileId: 'long-1', name: `${longName}.txt`, mimeType: 'text/plain', formatLabel: 'テキスト',
      size: 1234, modifiedTime: '2026-01-01T00:00:00.000Z', version: '1', md5Checksum: '',
      driveUrl: 'https://drive.google.com/file/d/long-1/view', folderId: 'f-kn', folderName: 'フォルダ',
      isKnowledge: 1, contentHash: '', lastSyncedAt: null, errorCode: 'X',
      errorMessage: 'エラー文'.repeat(80), syncState: FileSyncState.ERROR, charCount: 0, chunkCount: 0, pageCount: null,
    });

    app.navigate('files');
    store.patch({ files: [{
      fileId: 'long-1', name: `${longName}.txt`, formatLabel: 'テキスト', size: 1234,
      modifiedTime: '2026-01-01T00:00:00.000Z', driveUrl: 'https://drive.google.com/file/d/long-1/view',
      folderName: 'フォルダ', isKnowledge: 1, syncState: FileSyncState.ERROR,
      errorMessage: 'エラー文'.repeat(80), chunkCount: 0, lastSyncedAt: null,
    }] });
    await wait(150);

    const row = document.querySelector('table.data tbody tr');
    check('長いファイル名の行が出る', Boolean(row));
    check('ファイル名がテキストとして入る', row.textContent.includes('あああ'));
    check('横スクロール用の枠がある', Boolean(document.querySelector('.table-wrap')));
    check('本文がはみ出さない設定', getComputedStyle(document.querySelector('.file-name')).wordBreak === 'break-word');
    check('エラー列に上限幅がある', getComputedStyle(document.querySelector('.error-cell')).maxWidth !== 'none');
    const addKnowledgeButton = Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent.includes('ナレッジを追加'));
    check('ナレッジを追加ボタンがある', Boolean(addKnowledgeButton));
    calls.length = 0;
    addKnowledgeButton.click();
    await wait(80);
    check('追加ボタンで専用操作を呼ぶ', calls.some((call) => call.name === 'openKnowledgeUpload'));

    section('6. 画面幅・モーション');

    /* 本番の index.html を読み、実際の指定を確認する。 */
    const productionHtml = await (await fetch('/index.html')).text();
    check('viewport が設定されている', /<meta name="viewport" content="[^"]*width=device-width/.test(productionHtml));
    check('lang が ja', /<html lang="ja">/.test(productionHtml));
    /*
     * CSP は meta の content 属性だけを取り出して調べる。
     * HTML内の説明コメントにも同じ語が出てくるため、文書全体の検索では判定を誤る。
     */
    const cspMatch = /<meta http-equiv="Content-Security-Policy" content="([\s\S]*?)">/.exec(productionHtml);
    check('CSPが設定されている', Boolean(cspMatch));

    const csp = (cspMatch?.[1] ?? '').replace(/\s+/g, ' ');
    const directive = (name) => (new RegExp(`(?:^|;)\\s*${name}\\s+([^;]*)`).exec(csp)?.[1] ?? '').trim();

    check('script-src に unsafe-inline が無い', !directive('script-src').includes('unsafe-inline'), directive('script-src'));
    check('script-src に unsafe-eval が無い', !directive('script-src').includes('unsafe-eval'), directive('script-src'));
    check('script-src は self と Google のみ', directive('script-src') === "'self' https://accounts.google.com https://apis.google.com", directive('script-src'));
    check('connect-src に Drive API がある', directive('connect-src').includes('https://www.googleapis.com'), directive('connect-src'));
    check('default-src は none', directive('default-src') === "'none'", directive('default-src'));
    check('object-src none', directive('object-src') === "'none'");
    check('base-uri self', directive('base-uri') === "'self'");
    check('form-action none', directive('form-action') === "'none'");
    check('worker-src は self と blob', directive('worker-src') === "'self' blob:", directive('worker-src'));
    check('referrer policy が設定されている', /<meta name="referrer"/.test(productionHtml));
    check('アイコンを参照している', /rel="icon"/.test(productionHtml));
    /*
     * 相対パスかどうかは開発サーバーでは判定できない。
     * Vite が開発時に ./favicon.ico を /favicon.ico へ書き換え、
     * /@vite/client も差し込むため。ビルド後の検査（npm run test:dist）で確認する。
     */
    check('スキップリンクがある', productionHtml.includes('skip-link'));
    check('noscript の案内がある', productionHtml.includes('noscript'));
    const styles = Array.from(document.styleSheets).flatMap((sheet) => {
      try { return Array.from(sheet.cssRules); } catch { return []; }
    });
    const mediaRules = styles.filter((rule) => rule.constructor.name === 'CSSMediaRule').map((rule) => rule.conditionText);
    check('スマートフォン向けの指定がある', mediaRules.some((c) => c.includes('max-width')), mediaRules);
    check('prefers-reduced-motion に対応', mediaRules.some((c) => c.includes('prefers-reduced-motion')), mediaRules);

    section('7. フォルダ選択ダイアログ');

    const dialogPromise = openFolderBrowser();
    await wait(400);

    const dialog = document.querySelector('dialog.dialog');
    check('ダイアログが開く', Boolean(dialog) && dialog.open);
    check('ダイアログに aria-label', dialog.getAttribute('aria-label') === 'フォルダを選択');
    check('モーダルとして開く（背面を操作できない）', dialog.matches(':modal'));
    check('フォルダ一覧が出る', document.querySelectorAll('.folder-list__open').length > 0);
    check('パンくずがある', Boolean(document.querySelector('.breadcrumb')));

    /* Esc で閉じるとキャンセル扱いになる */
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    const dialogResult = await dialogPromise;
    check('Escでキャンセルになる', dialogResult === null, dialogResult);
    check('閉じたら要素が残らない', !document.querySelector('dialog.dialog'));

    section('8. 表示フォーマット');

    check('バイト表示', formatBytes(0) === '0 B' && formatBytes(1536).startsWith('1.5'), formatBytes(1536));
    check('大きなバイト表示', formatBytes(5 * 1024 * 1024 * 1024).includes('GB'));
    check('不正値は—', formatBytes(NaN) === '—' && formatBytes(-1) === '—');
    check('日時表示', formatDateTime('2026-01-02T03:04:00.000Z').includes('2026/01/02'));
    check('不正な日時は—', formatDateTime('nope') === '—' && formatDateTime(null) === '—');
    check('数値の桁区切り', formatNumber(1234567) === '1,234,567');
    check('不正な数値は—', formatNumber('x') === '—');

    section('9. 多重クリック');

    app.navigate('storage');
    store.patch({ stats: { fileCount: 1, documentCount: 1, chunkCount: 3, totalChars: 10, usage: 100, quota: 1000, free: 900 } });
    await wait(150);

    const rebuild = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '検索インデックス再構築');
    check('再構築ボタンがある', Boolean(rebuild));
    calls.length = 0;
    rebuild.click();
    rebuild.click();
    rebuild.click();
    await wait(200);
    check('連打しても1回しか実行しない', calls.filter((c) => c.name === 'rebuildIndex').length === 1, calls.map((c) => c.name));

    check('不要データ整理ボタンがある', Array.from(document.querySelectorAll('button')).some((b) => b.textContent === '不要データの整理'));

    section('10. 未認証・期限切れの表示');

    store.patch({ profile: null });
    store.setAppState(AppState.UNAUTHENTICATED);
    await wait(80);
    check('未認証ならログインボタンを出す', document.getElementById('account-area').textContent.includes('Googleでログイン'));

    store.patch({ profile: { displayName: 'テスト太郎', email: 'test@example.com', photoLink: '' } });
    await wait(80);
    check('認証済みなら名前を出す', document.getElementById('account-area').textContent.includes('テスト太郎'));
    check('ログアウトボタンを出す', document.getElementById('account-area').textContent.includes('ログアウト'));
    check('画像が無ければイニシャル', document.querySelector('.account-avatar')?.textContent === 'テ');

    /* ============================================================ */
    section('11. 不足フォルダの作成');

    const nodes = buildFolderPlan(FOLDER_STRUCTURE);
    const asFound = (keys) => new Map(keys.map((key, i) => [key, {
      status: 'found', folder: { id: `id${i}`, name: key.split('/').pop() },
    }]));
    const makeStructure = (keys) => {
      const s = summarizePlan(classifyPlan(nodes, asFound(keys)));
      return {
        ...s,
        entries: s.entries.map((e) => ({ ...e, path: formatNodePath(e.node) })),
        missing: s.missing.map((e) => ({ ...e, path: formatNodePath(e.node) })),
        existing: s.existing.map((e) => ({ ...e, path: formatNodePath(e.node) })),
      };
    };

    const ALL_KEYS = nodes.map((n) => n.key);
    const PARTIAL_KEYS = ALL_KEYS.slice(0, 3);

    store.setAppState(AppState.NO_FOLDER);
    app.navigate('setup');
    store.patch({ structure: null, folderCreating: false, folderCreateResult: null });
    await wait(150);

    const createButton = () => document.querySelector('[data-role="create-folders"]');
    const textOf = () => document.querySelector('.app-main')?.textContent ?? document.body.textContent;

    /* --- ボタンの表示条件 --- */
    check('未確認では作成ボタンを出さない', createButton() === null);
    check('目標の構成を常に表示する', textOf().includes('99_システム'));
    check('必要な権限を表示する', textOf().includes('drive（フォルダ作成のあいだだけ）'));

    store.patch({ structure: makeStructure(ALL_KEYS) });
    await wait(120);
    check('全部揃っていれば作成ボタンを出さない', createButton() === null);
    check('全部揃っていればその旨を出す', textOf().includes('すべて揃っています'));

    store.patch({ structure: makeStructure(PARTIAL_KEYS) });
    await wait(120);
    check('不足があれば作成ボタンを出す', createButton() !== null);
    check('不足件数をボタンに出す', createButton().textContent.includes('3 件'), createButton()?.textContent);
    check('不足フォルダ名を一覧に出す', textOf().includes('02_未整理') && textOf().includes('03_アーカイブ'));
    check('既存は「既存（再利用）」と出す', textOf().includes('既存（再利用）'));
    check('不足は「新規作成」と出す', textOf().includes('新規作成'));

    /* --- 同名複数のときは作成させない --- */
    const dupFound = asFound(['TSAM AI']);
    dupFound.set('TSAM AI', { status: 'ambiguous', candidates: [{ id: 'a', name: 'TSAM AI', parentName: 'マイドライブ' }, { id: 'b', name: 'TSAM AI', parentName: 'マイドライブ' }] });
    const dupStructure = summarizePlan(classifyPlan(nodes, dupFound));
    store.patch({
      structure: {
        ...dupStructure,
        entries: dupStructure.entries.map((e) => ({ ...e, path: formatNodePath(e.node) })),
        missing: [],
        existing: [],
        ambiguous: dupStructure.ambiguous.map((e) => ({ ...e, path: formatNodePath(e.node) })),
        needsCreation: true,
      },
    });
    await wait(120);
    check('同名複数では作成ボタンを無効化する', createButton()?.disabled === true);
    check('同名複数では理由を出す', textOf().includes('重複が解消されるまで'));
    check('同名複数では候補を出す', textOf().includes('このフォルダを使う'));

    /* --- 3連打でも1回 --- */
    store.patch({ structure: makeStructure(PARTIAL_KEYS), folderCreateResult: null });
    await wait(120);
    calls.length = 0;
    createButton().click();
    createButton().click();
    createButton().click();
    await wait(200);
    check('作成ボタンを3連打しても1回だけ実行する',
      calls.filter((c) => c.name === 'createMissingFolders').length === 1,
      calls.map((c) => c.name));

    /* --- 作成中の進捗と無効化 --- */
    store.patch({
      folderCreating: true,
      folderCreateProgress: { phase: 'creating', done: 1, total: 3, currentName: '02_未整理' },
    });
    await wait(120);
    const createBar = document.querySelector('progress[role="progressbar"]');
    check('作成中は進捗バーを出す', Boolean(bar));
    check('進捗に aria-valuenow', createBar?.getAttribute('aria-valuenow') === '1', createBar?.getAttribute('aria-valuenow'));
    check('進捗に aria-label', createBar?.getAttribute('aria-label') === 'フォルダ作成の進捗');
    check('進捗を文字でも出す', textOf().includes('1 / 3') && textOf().includes('02_未整理'));
    check('進捗は aria-live で伝える', document.querySelector('.progress-block')?.getAttribute('aria-live') === 'polite');
    check('作成中はボタンを無効化する', createButton()?.disabled === true);
    check('作成中は「作成中…」と出す', createButton()?.textContent === '作成中…');

    store.patch({
      folderCreating: true,
      folderCreateProgress: { phase: 'authorizing', done: 0, total: 3, currentName: '' },
    });
    await wait(120);
    check('認可待ちを文字で出す', textOf().includes('許可を求めています'));

    /* --- 成功表示 --- */
    store.patch({
      folderCreating: false,
      folderCreateProgress: null,
      folderCreateResult: {
        ok: true,
        created: [
          { key: 'a', name: '02_未整理', path: 'マイドライブ / TSAM AI / ローカルLLM / 02_未整理', id: 'n1', webViewLink: 'https://drive.google.com/drive/folders/n1' },
          { key: 'b', name: '03_アーカイブ', path: 'マイドライブ / TSAM AI / ローカルLLM / 03_アーカイブ', id: 'n2', webViewLink: 'https://drive.google.com/drive/folders/n2' },
        ],
        reused: [{ key: 'c', name: '01_ナレッジ', path: 'x' }],
        failed: [],
        skipped: [],
        error: null,
      },
    });
    await wait(120);
    check('成功を文字で伝える', textOf().includes('作成が完了しました'));
    check('成功メッセージは role=status', Boolean(document.querySelector('.notice--success[role="status"]')));
    const driveLinks = Array.from(document.querySelectorAll('a[href^="https://drive.google.com/"]'));
    check('作成済みフォルダのリンクを出す', driveLinks.length === 2, driveLinks.length);
    check('リンクは新しいタブで開く', driveLinks.every((a) => a.target === '_blank' && a.rel.includes('noopener')));
    check('再実行ボタンに切り替わる', createButton()?.textContent === '作成を再実行');

    /* --- 失敗表示 --- */
    store.patch({
      folderCreateResult: {
        ok: false,
        created: [{ key: 'a', name: '02_未整理', path: 'マイドライブ / TSAM AI / ローカルLLM / 02_未整理', id: 'n1', webViewLink: '' }],
        reused: [],
        failed: [{ key: 'b', name: '03_アーカイブ', path: 'マイドライブ / TSAM AI / ローカルLLM / 03_アーカイブ', message: 'Google側で問題が発生しています。', code: 'SERVER_ERROR' }],
        skipped: [{ key: 'c', name: '99_システム', path: 'マイドライブ / TSAM AI / ローカルLLM / 99_システム', message: '前の段階が完了しなかったため実行していません。', code: 'SERVER_ERROR' }],
        error: { code: 'FOLDER_CREATE_FAILED', message: 'フォルダの作成に失敗しました。成功した分は作成済みです。' },
      },
    });
    await wait(120);
    check('失敗を文字で伝える', textOf().includes('フォルダの作成に失敗しました'));
    check('失敗メッセージは role=status', Boolean(document.querySelector('.notice--error[role="status"]')));
    check('失敗したフォルダ名を出す', textOf().includes('03_アーカイブ'));
    check('未実行のフォルダも出す', textOf().includes('99_システム') && textOf().includes('実行していません'));
    check('成功した分は表示に残る', textOf().includes('作成したフォルダ'));
    check('再実行を案内する', textOf().includes('続きから作り直せます'));

    /* --- 権限拒否 --- */
    store.patch({
      folderCreateResult: {
        ok: false,
        created: [],
        reused: [],
        failed: [{ key: 'a', name: '02_未整理', path: 'マイドライブ / TSAM AI / ローカルLLM / 02_未整理', message: 'フォルダを作成する権限が許可されませんでした。 同意画面でDriveのチェックを外さずに「許可」を選んでください。作成しない場合はキャンセルで戻れます。', code: 'WRITE_SCOPE_NOT_GRANTED' }],
        skipped: [],
        error: { code: 'WRITE_SCOPE_NOT_GRANTED', message: 'フォルダを作成する権限が許可されませんでした。' },
      },
    });
    await wait(120);
    check('権限拒否を文字で伝える', textOf().includes('権限が許可されませんでした'));
    check('権限拒否でも再実行できる', createButton()?.disabled === false);

    /* --- 確認ダイアログ --- */
    const planForDialog = makeStructure(PARTIAL_KEYS);

    const cancelPromise = openCreateFoldersDialog(planForDialog);
    await wait(120);
    const createDialog = document.querySelector('dialog[aria-label="不足フォルダの作成を確認"]');
    check('確認ダイアログが開く', Boolean(createDialog));
    check('モーダルとして開く（背面を操作できない）', createDialog.matches(':modal'));
    check('ダイアログに aria-label', createDialog.getAttribute('aria-label') === '不足フォルダの作成を確認');
    check('作成予定の階層を出す', createDialog.textContent.includes('作成後の階層'));
    check('既存フォルダを出す', createDialog.textContent.includes('既存フォルダ（再利用：3 件）'));
    check('新規作成するフォルダを出す', createDialog.textContent.includes('新規作成するフォルダ（3 件）'));
    /* 要件で決められた4点が必ず読めること。 */
    check('「フォルダのみ作成」と明記する', createDialog.textContent.includes('フォルダのみ作成します'));
    check('「既存ファイルは編集・削除しない」と明記する', createDialog.textContent.includes('既存ファイルは編集・削除しません'));
    check('「同期は開始しない」と明記する', createDialog.textContent.includes('同期は開始しません'));
    check('「Drive編集権限を一時的に使用」と明記する', createDialog.textContent.includes('GoogleのDrive編集権限を一時的に使用します'));
    check('必要な権限を出す', createDialog.textContent.includes('必要な権限'));
    check('作成後に権限を破棄すると明記する', createDialog.textContent.includes('アプリ内部から破棄されます'));
    check('キャンセルボタンがある', Array.from(createDialog.querySelectorAll('button')).some((b) => b.textContent === 'キャンセル'));
    check('作成ボタンに件数を出す', Array.from(createDialog.querySelectorAll('button')).some((b) => b.textContent === '3 件を作成する'));
    check('既定のフォーカスはキャンセル', document.activeElement?.textContent === 'キャンセル');

    /* Esc で閉じるとキャンセル扱い */
    createDialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    check('Escでキャンセルになる', (await cancelPromise) === false);
    check('閉じたら要素が残らない', document.querySelector('dialog[aria-label="不足フォルダの作成を確認"]') === null);

    /* キャンセルボタン */
    const cancelByButton = openCreateFoldersDialog(planForDialog);
    await wait(80);
    Array.from(document.querySelectorAll('dialog button')).find((b) => b.textContent === 'キャンセル').click();
    check('キャンセルボタンで false を返す', (await cancelByButton) === false);

    /* 作成する */
    const confirmPromise = openCreateFoldersDialog(planForDialog);
    await wait(80);
    Array.from(document.querySelectorAll('dialog button')).find((b) => b.textContent === '3 件を作成する').click();
    check('「作成する」で true を返す', (await confirmPromise) === true);
    check('確認後もダイアログを残さない', document.querySelector('dialog[aria-label="不足フォルダの作成を確認"]') === null);

    /* ============================================================ */
    section('12. ナレッジ追加ダイアログ');

    const folder = {
      id: 'f-kn',
      name: '01_ナレッジ',
      path: 'マイドライブ / TSAM AI / ローカルLLM / 01_ナレッジ',
    };
    let uploadRunCount = 0;
    const uploadPromise = openKnowledgeUploadDialog({
      folder,
      runUpload: async (plan, { onProgress }) => {
        uploadRunCount += 1;
        const entry = plan.accepted[0];
        onProgress({
          phase: 'uploading', done: 0, total: 1, currentName: entry.relativePath,
          itemId: entry.id, itemStatus: 'uploading',
        });
        onProgress({
          phase: 'uploading', done: 1, total: 1, currentName: entry.relativePath,
          itemId: entry.id, itemStatus: 'saved', uploadName: entry.safeName, fileId: 'uploaded-1',
        });
        return {
          ok: true,
          syncCompleted: true,
          upload: {
            uploaded: [{
              entry,
              file: { id: 'uploaded-1', name: entry.safeName },
              uploadName: entry.safeName,
              renamed: false,
              parseable: true,
            }],
            failed: [],
            skipped: [],
          },
          syncedFiles: [{ fileId: 'uploaded-1', syncState: 'indexed', chunkCount: 2 }],
        };
      },
    });
    await wait(100);
    let uploadDialog = document.querySelector('dialog[aria-label="ナレッジファイルを追加"]');
    check('追加ダイアログがモーダルで開く', Boolean(uploadDialog) && uploadDialog.matches(':modal'));
    check('固定保存先を明記', uploadDialog.textContent.includes('TSAM AI / ローカルLLM / 01_ナレッジ'));
    check('ドラッグ＆ドロップ領域がある', Boolean(uploadDialog.querySelector('.upload-drop[role="button"]')));
    check('複数ファイル入力', uploadDialog.querySelector('input[type="file"]:not([webkitdirectory])')?.multiple === true);
    check('フォルダ入力', Boolean(uploadDialog.querySelector('input[webkitdirectory]')));
    check('対応形式を説明', uploadDialog.textContent.includes('PDF、DOCX、TXT、Markdown、CSV'));
    check('保存のみの形式を説明', uploadDialog.textContent.includes('HTML、PPTX、XLSX'));
    check('選択前は確認ボタンが無効', Array.from(uploadDialog.querySelectorAll('button'))
      .find((button) => button.textContent === '内容を確認')?.disabled === true);

    const transfer = new DataTransfer();
    transfer.items.add(new File(['追加テスト本文'], 'UI追加.txt', { type: 'text/plain' }));
    const input = uploadDialog.querySelector('input[type="file"]:not([webkitdirectory])');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(100);
    uploadDialog = document.querySelector('dialog[aria-label="ナレッジファイルを追加"]');
    check('選択ファイル名を安全なテキストで表示', uploadDialog.textContent.includes('UI追加.txt'));
    check('選択後は確認へ進める', Array.from(uploadDialog.querySelectorAll('button'))
      .find((button) => button.textContent === '内容を確認')?.disabled === false);

    Array.from(uploadDialog.querySelectorAll('button')).find((button) => button.textContent === '内容を確認').click();
    await wait(100);
    check('確認画面にファイル数', uploadDialog.textContent.includes('ファイル数：1件'));
    check('確認画面に一時書き込み権限', uploadDialog.textContent.includes('アップロード時のみ'));
    check('確認画面に既存ファイル非変更', uploadDialog.textContent.includes('削除・編集・移動・上書きは行いません'));
    check('確認画面に同期・解析', uploadDialog.textContent.includes('差分同期'));

    Array.from(uploadDialog.querySelectorAll('button'))
      .find((button) => button.textContent.includes('アップロードして同期')).click();
    await wait(180);
    uploadDialog = document.querySelector('dialog[aria-label="ナレッジファイルを追加"]');
    check('明示確認後だけアップロードを実行', uploadRunCount === 1);
    check('完了をaria-liveで通知', Boolean(uploadDialog.querySelector('[role="status"][aria-live="polite"]')));
    check('Drive保存状態', uploadDialog.textContent.includes('保存済み'));
    check('同期状態', uploadDialog.textContent.includes('同期済み'));
    check('解析状態', uploadDialog.textContent.includes('解析済み'));
    check('チャンク件数', uploadDialog.textContent.includes('2件'));
    check('検索反映状態', uploadDialog.textContent.includes('反映済み'));
    check('検索導線', Boolean(uploadDialog.querySelector('a[href*="#search"]')));
    check('チャット導線', Boolean(Array.from(uploadDialog.querySelectorAll('a')).find((a) => a.textContent.includes('AIナレッジチャット'))));
    check('追加アップロード導線', Boolean(Array.from(uploadDialog.querySelectorAll('button')).find((b) => b.textContent === '追加でアップロード')));
    Array.from(uploadDialog.querySelectorAll('button')).find((button) => button.textContent === '閉じる').click();
    await uploadPromise;
    check('閉じたら追加ダイアログが残らない', document.querySelector('dialog[aria-label="ナレッジファイルを追加"]') === null);

    /* 選択前にEscで閉じても書き込み処理は呼ばれない。 */
    const uploadCancel = openKnowledgeUploadDialog({ folder, runUpload: async () => { uploadRunCount += 1; } });
    await wait(80);
    uploadDialog = document.querySelector('dialog[aria-label="ナレッジファイルを追加"]');
    uploadDialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    await uploadCancel;
    check('Escキャンセルではアップロードしない', uploadRunCount === 1);

    section('13. セットアップウィザード');

    /* 初回アクセスの状況に合わせる（未認証から始める）。 */
    store.setAppState(AppState.UNAUTHENTICATED);

    const navEl = document.querySelector('.app-nav');
    const wizardText = () => document.querySelector('.wizard')?.textContent ?? '';
    const roleButton = (role) => document.querySelector(`[data-role="${role}"]`);
    const stepItems = () => Array.from(document.querySelectorAll('.wizard__list-item'));

    /* --- 表示条件 --- */
    check('setup が未読込なら通常画面のまま', document.querySelector('.wizard') === null);
    check('通常画面ではナビが見えている', navEl.hidden === false);

    store.patch({ setup: makeSetupRecord(createProgress(), { completed: true }) });
    await wait(120);
    check('完了済みならウィザードを出さない', document.querySelector('.wizard') === null);

    store.patch({ setup: makeSetupRecord(createProgress(), { completed: false }) });
    await wait(150);
    check('未完了ならウィザードを出す', document.querySelector('.wizard') !== null);
    check('ウィザード中はナビを隠す', navEl.hidden === true);
    check('タブは切り替わらない', (() => { app.navigate('storage'); return document.querySelector('.wizard') !== null; })());

    /* --- ステップの一覧 --- */
    check('手順は7つ', stepItems().length === 7, stepItems().length);
    check('手順の名称',
      stepItems().map((li) => li.querySelector('.wizard__label').textContent).join('/')
      === 'Googleにログイン/フォルダ構成を確認/不足フォルダを作成/初回同期/検索テスト/診断/完了',
      stepItems().map((li) => li.querySelector('.wizard__label').textContent));
    check('実施中の手順に aria-current', stepItems()[0].getAttribute('aria-current') === 'step');
    check('他の手順に aria-current は無い', !stepItems()[1].hasAttribute('aria-current'));
    check('状態を文字で出す（色だけに頼らない）',
      stepItems()[0].querySelector('.tag').textContent === '実施中');
    check('進み具合を progressbar で出す',
      document.querySelector('.wizard__head progress[role="progressbar"]')?.getAttribute('aria-valuemax') === '6');

    /* --- ステップ1: ログイン --- */
    check('ログインボタンが出る', Boolean(roleButton('wizard-signin')));
    check('要求スコープを明示する', wizardText().includes('https://www.googleapis.com/auth/drive.readonly'));
    check('この時点で書き込まないと明示する', wizardText().includes('この時点ではDriveへ何も書き込みません'));
    calls.length = 0;
    roleButton('wizard-signin').click();
    roleButton('wizard-signin').click();
    roleButton('wizard-signin').click();
    await wait(200);
    check('ログインボタンを3連打しても1回', calls.filter((c) => c.name === 'signIn').length === 1, calls.map((c) => c.name));

    /* --- ステップ2以降は前の手順待ち --- */
    check('先の手順は前の手順待ちと出す', wizardText().includes('前の手順が終わると実行できます'));
    check('先の手順のボタンは出さない', roleButton('wizard-folder') === null);

    /* --- 進捗を進める --- */
    let progress = { ...createProgress(), signIn: true };
    store.patch({ setup: makeSetupRecord(progress, { completed: false }) });
    await wait(120);
    check('ログイン後はフォルダ確認が実施中', stepItems()[1].getAttribute('aria-current') === 'step');
    check('フォルダ確認のボタンが出る', Boolean(roleButton('wizard-folder')));
    check('完了した手順は完了と出す', stepItems()[0].querySelector('.tag').textContent === '完了');

    progress = { ...progress, folder: true };
    store.patch({
      setup: makeSetupRecord(progress, { completed: false }),
      structure: makeStructure(PARTIAL_KEYS),
    });
    await wait(120);
    check('作成ボタンが出る', Boolean(roleButton('wizard-create')));
    check('作成対象を並べる', wizardText().includes('02_未整理'));
    check('必要な権限を出す', wizardText().includes('drive（フォルダ作成のあいだだけ）'));
    check('スキップできる', Boolean(roleButton('wizard-skip-create')));

    calls.length = 0;
    roleButton('wizard-skip-create').click();
    await wait(150);
    check('スキップで skipSetupStep を呼ぶ',
      calls.some((c) => c.name === 'skipSetupStep' && c.args[0] === 'create'), calls.map((c) => c.name));

    /* --- 作成中の進捗 --- */
    store.patch({
      folderCreating: true,
      folderCreateProgress: { phase: 'creating', done: 2, total: 3, currentName: '03_アーカイブ' },
    });
    await wait(120);
    check('作成中は進捗を出す', wizardText().includes('2 / 3') && wizardText().includes('03_アーカイブ'));
    check('作成中はボタンを無効化する', roleButton('wizard-create')?.disabled === true);
    store.patch({ folderCreating: false, folderCreateProgress: null });

    /* --- サンプルファイルの手順（01_ナレッジ を新規作成したときだけ） --- */
    progress = { ...progress, createSkipped: true };
    store.patch({ setup: makeSetupRecord(progress, { completed: false }) });
    await wait(120);
    check('通常はサンプル手順を出さない', !wizardText().includes('サンプルファイルを作成'), stepItems().length);

    progress = { ...progress, knowledgeFolderCreated: true };
    store.patch({ setup: makeSetupRecord(progress, { completed: false }) });
    await wait(120);
    check('01_ナレッジを新規作成した場合だけ出す', stepItems().length === 8, stepItems().length);
    check('サンプル手順のボタンが出る', Boolean(roleButton('wizard-samples')));
    check('作成するファイル名を出す', wizardText().includes('README.md') && wizardText().includes('サンプル.txt'));
    check('上書きしないと明記する', wizardText().includes('上書きはしません'));
    check('初回だけと明記する', wizardText().includes('初回の1度だけ'));

    store.patch({
      samplesResult: {
        ok: true,
        created: [{ name: 'README.md', webViewLink: 'https://drive.google.com/file/d/x/view' }],
        skipped: [{ name: 'サンプル.txt' }],
        failed: [],
        error: null,
      },
    });
    await wait(120);
    check('サンプル作成の結果を出す', wizardText().includes('サンプルファイルの作成が完了しました'));
    check('作成したファイルのリンクを出す',
      Array.from(document.querySelectorAll('.wizard a[href^="https://drive.google.com/"]')).length === 1);
    check('既存で作らなかったものも出す', wizardText().includes('既にあったため作成しなかったファイル'));

    /* --- 同期・検索テスト --- */
    progress = { ...progress, samplesSkipped: true };
    store.patch({
      setup: makeSetupRecord(progress, { completed: false }),
      folder: { id: 'f-kn', name: '01_ナレッジ', path: 'マイドライブ / TSAM AI / ローカルLLM / 01_ナレッジ' },
    });
    await wait(120);
    check('同期のボタンが出る', Boolean(roleButton('wizard-sync')));
    check('読み取りだけと明記する', wizardText().includes('読み取りのリクエストしか送りません'));

    progress = { ...progress, sync: true };
    store.patch({ setup: makeSetupRecord(progress, { completed: false }) });
    await wait(120);
    check('検索テストのボタンが出る', Boolean(roleButton('wizard-search')));
    check('検索する語を出す', wizardText().includes('テスト用キーワードあいうえお'));

    store.patch({ setupSearch: { term: 'テスト用キーワードあいうえお', hits: 2, names: ['サンプル.txt', 'test.txt'] } });
    await wait(120);
    check('検索テストの結果を出す', wizardText().includes('2 件ヒットしました'));
    check('ヒットしたファイル名を出す', wizardText().includes('サンプル.txt'));

    store.patch({ setupSearch: { term: 'x', hits: 0, names: [] } });
    await wait(120);
    check('ヒットしない場合も案内を出す', wizardText().includes('ヒットしませんでした'));

    /* --- 診断 --- */
    progress = { ...progress, search: true };
    store.patch({ setup: makeSetupRecord(progress, { completed: false }) });
    await wait(120);
    check('診断のボタンが出る', Boolean(roleButton('wizard-diagnose')));

    store.patch({
      setupDiagnosis: summarizeDiagnosis({
        gis: { id: 'gis', label: 'GIS', status: 'success', message: 'ok' },
        folder1: { id: 'folder1', label: '1段目', status: 'failure', message: '見つかりません' },
      }, { scope: 'https://www.googleapis.com/auth/drive.readonly', writeTokenHeld: false }),
    });
    await wait(120);
    const diagRows = Array.from(document.querySelectorAll('.diag-table tbody tr'));
    check('診断は7項目を表で出す', diagRows.length === 7, diagRows.length);
    check('診断の項目名',
      diagRows.map((tr) => tr.querySelector('th').textContent).join('/')
      === 'OAuth（Googleログイン）/Drive API への接続/フォルダ構成/同期/検索/ブラウザ内データベース/権限');
    check('成功・失敗を文字で出す', diagRows[0].querySelector('.tag').textContent === '成功');
    check('失敗も文字で出す', diagRows[2].querySelector('.tag').textContent === '失敗');
    check('未実行も文字で出す', diagRows[3].querySelector('.tag').textContent === '未実行');
    check('権限の判定を出す', diagRows[6].textContent.includes('書き込み用の権限は保持していません'));

    /* --- 完了 --- */
    check('未完了のあいだは開始ボタンを押せない', roleButton('wizard-finish')?.disabled !== false);

    progress = { ...progress, diagnose: true };
    store.patch({ setup: makeSetupRecord(progress, { completed: false }) });
    await wait(120);
    check('すべて片付くと開始ボタンが押せる', roleButton('wizard-finish')?.disabled === false);
    check('完了の案内を出す', wizardText().includes('すべての手順が終わりました'));
    check('再実行できることを案内する', wizardText().includes('セットアップを再実行'));

    calls.length = 0;
    roleButton('wizard-finish').click();
    await wait(150);
    check('開始ボタンで finishSetup を呼ぶ', calls.some((c) => c.name === 'finishSetup'), calls.map((c) => c.name));

    store.patch({ setup: makeSetupRecord(progress, { completed: true }) });
    await wait(150);
    check('完了すると通常画面へ戻る', document.querySelector('.wizard') === null);
    check('完了するとナビが戻る', navEl.hidden === false);
    check('通常画面のタブが6つに戻る', document.querySelectorAll('.app-nav__button').length === 6);

    /* --- 設定からの再実行 --- */
    app.navigate('settings');
    await wait(200);
    const restart = document.querySelector('[data-role="restart-setup"]');
    check('設定に再実行ボタンがある', Boolean(restart));
    check('完了時刻を案内する', document.querySelector('.app-main').textContent.includes('セットアップ済み'));
    calls.length = 0;
    restart.click();
    await wait(150);
    check('再実行で restartSetup を呼ぶ', calls.some((c) => c.name === 'restartSetup'), calls.map((c) => c.name));

    store.patch({ setup: makeSetupRecord(createProgress(), { completed: false }) });
    await wait(150);
    check('再実行するとウィザードへ戻る', document.querySelector('.wizard') !== null);

    /* 後片付け（以降のテストへ影響させない）。 */
    store.patch({ setup: null });
    await wait(120);
  } catch (error) {
    failed += 1;
    failures.push('FATAL');
    log(`FATAL ${error?.message ?? error}`);
    log(String(error?.stack ?? '').slice(0, 800));
  } finally {
    net?.restore();
  }

  log(`\nUIテスト: ${total} 件中 ${total - failed} 件成功 / ${failed} 件失敗`);
  if (failed > 0) {
    log(`失敗: ${failures.join(' / ')}`);
  }
  log(failed === 0 ? 'RESULT: ALL PASS' : `RESULT: ${failed} FAILURES`);
  document.title = failed === 0 ? 'PASS' : 'FAIL';
}

main();

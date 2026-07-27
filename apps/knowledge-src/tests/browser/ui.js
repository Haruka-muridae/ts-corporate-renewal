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

/*
 * ブラウザ統合テスト。
 *
 * Drive API と GIS をモックし、本番コードをそのまま動かす。
 * 実行はヘッドレスChrome（npm run test:browser）。
 *
 * 本番コードにはテスト用の分岐を一切入れていない。
 * 差し替えているのは globalThis.google と globalThis.fetch だけ。
 */

import { loadFixtures, installFakeGis, installFakeFetch, createTree, MIMES, driveError, htmlError } from './fake-drive.js';

import {
  ensureAccessToken, hasValidAccessToken, signOut, resetAuth, getProfile, subscribeAuth, clearAccessToken,
} from '../../src/auth/google-auth.js';
import {
  fetchAbout, findFoldersByName, listFilesInFolder, exportGoogleDoc, downloadFile, collectFolderTree,
} from '../../src/drive/drive-client.js';
import { resolveKnowledgeFolder, PathResolveStatus } from '../../src/drive/folder-path.js';
import { runSync, previewFolder, cancelSync, isSyncing, resyncFile, terminateParseWorker } from '../../src/sync/sync-engine.js';
import { rebuildIndex, search, clearIndex, probeIndex, persistIndex } from '../../src/search/search-service.js';
import { openDb, runWrite, db } from '../../src/db/db.js';
import {
  listFiles, getDocument, getChunksByFile, collectStats, clearAllCache,
  setSyncOptions, getSyncOptions, listLogs, trimLogs, deleteFileData, setChunkOptions,
  cleanupOrphans, listFileIdsWithChunks,
} from '../../src/db/repo.js';
import { ErrorCode } from '../../src/core/errors.js';
import { FileSyncState } from '../../src/core/state.js';
import { getPdfAssetUrls } from '../../src/config.js';
import { createWorkerClient } from '../../src/workers/worker-rpc.js';
import { safeUrl, safeDriveUrl, highlightFragment, el } from '../../src/core/dom.js';
import { logger } from '../../src/core/logger.js';

const out = document.getElementById('out');
const lines = [];
let total = 0;
let failed = 0;
const failures = [];

function log(text) {
  lines.push(text);
  out.textContent = lines.join('\n');
}

function check(name, condition, extra) {
  total += 1;
  if (condition) {
    log(`  ok   ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    log(`  NG   ${name} ${extra === undefined ? '' : JSON.stringify(extra).slice(0, 400)}`);
  }
}

function section(title) {
  log(`\n=== ${title} ===`);
}

/* ---- 想定外のエラーを数える（要件: console error 0 / unhandled rejection 0） ---- */

const unhandled = [];
const consoleErrors = [];

window.addEventListener('unhandledrejection', (event) => {
  unhandled.push(String(event.reason?.code ?? event.reason?.message ?? event.reason).slice(0, 120));
});

const originalConsoleError = console.error;
console.error = (...args) => {
  const text = args.map((a) => String(a)).slice(0, 2).join(' ');
  /* logger は開発モードでのみ console へ出す（本番は無効）。意図的なエラー注入の記録は除く。 */
  if (!text.startsWith('[knowledge]')) {
    consoleErrors.push(text);
  }
  originalConsoleError.apply(console, args);
};

const FOLDER = { id: 'f-kn', name: '01_ナレッジ', path: 'マイドライブ / TSAM AI / ローカルLLM / 01_ナレッジ' };
const FIXTURES = [
  'sample.txt', 'sample.md', 'sample.pdf', 'sample.docx', 'sample-sjis.txt',
  'sample-bom.txt', 'sample-crlf.txt', 'sample-nul.txt', 'empty.txt', 'zero.txt',
  'huge-line.txt', 'urls.md', 'japanese.pdf', 'multipage.pdf', 'broken.pdf', 'zero.pdf',
  'empty.docx', 'broken.docx',
];

const DEFAULT_SYNC = { maxFileBytes: 40 * 1024 * 1024, pageSize: 100, concurrency: 2, recursive: true, maxDepth: 5 };
const findFile = (files, id) => files.find((f) => f.fileId === id);

async function main() {
  let net = null;
  let gis = null;
  const scenario = {};

  try {
    const fixtures = await loadFixtures(FIXTURES);
    gis = installFakeGis();
    const tree = createTree(fixtures);
    net = installFakeFetch({ tree, scenario });

    await openDb();
    await clearAllCache({ keepSettings: false });
    await clearIndex();
    await setSyncOptions(DEFAULT_SYNC);

    /* ============================================================ */
    section('1. 認証');

    check('初期状態は未認証', !hasValidAccessToken());
    const token = await ensureAccessToken();
    check('トークンを取得できる', typeof token === 'string' && token.length > 0);
    check('取得後は認証済み', hasValidAccessToken());
    check('キャッシュを再利用する（要求は1回）', gis.requests === 1, gis.requests);

    const cached = await ensureAccessToken();
    check('2回目はポップアップを出さない', gis.requests === 1 && cached === token, gis.requests);

    /* 同時に複数呼んでも二重にポップアップを出さない */
    clearAccessToken();
    const before = gis.requests;
    const [t1, t2] = await Promise.allSettled([ensureAccessToken(), ensureAccessToken()]);
    check('同時要求で片方は拒否される（二重ポップアップ防止）', (t1.status === 'rejected') !== (t2.status === 'rejected'), { t1: t1.status, t2: t2.status });
    check('同時要求でも要求は1回だけ', gis.requests === before + 1, gis.requests);

    const about = await fetchAbout();
    check('about.get でプロフィール取得', about.profile?.displayName === 'テスト太郎', about.profile);
    check('プロフィールが保持される', getProfile()?.email === 'test@example.com');

    let authEvents = 0;
    const unsub = subscribeAuth(() => { authEvents += 1; });
    check('認証状態を購読できる', authEvents === 1);
    unsub();

    section('2. 認証の失敗パターン');

    const withGisMode = async (mode, fn) => {
      resetAuth();
      const previous = gis.mode;
      gis.mode = mode;
      try {
        return await fn();
      } finally {
        gis.mode = previous;
      }
    };

    const expectAuthError = async (mode, expected, label) => {
      await withGisMode(mode, async () => {
        try {
          await ensureAccessToken();
          check(label, false, 'エラーにならなかった');
        } catch (error) {
          check(label, error.code === expected, error.code);
        }
      });
    };

    await expectAuthError('popup_closed', ErrorCode.AUTH_POPUP_CLOSED, 'ポップアップを閉じた');
    await expectAuthError('popup_blocked', ErrorCode.AUTH_POPUP_BLOCKED, 'ポップアップブロック');
    await expectAuthError('access_denied', ErrorCode.AUTH_ACCESS_DENIED, '同意しなかった');
    await expectAuthError('wrong_scope', ErrorCode.AUTH_SCOPE_NOT_GRANTED, 'Drive権限が付与されなかった');

    /* 失敗しても、その後やり直せる */
    resetAuth();
    check('失敗後に再認証できる', typeof (await ensureAccessToken()) === 'string');

    section('3. 固定パス探索');

    const resolved = await resolveKnowledgeFolder();
    check('解決できる', resolved.status === PathResolveStatus.RESOLVED, resolved.status);
    check('末端が 01_ナレッジ', resolved.folder?.id === 'f-kn', resolved.folder);
    check('3階層たどる', resolved.trail.length === 3);
    check('階層の順序', JSON.stringify(resolved.trail.map((t) => t.name)) === JSON.stringify(['TSAM AI', 'ローカルLLM', '01_ナレッジ']));
    check('別階層の同名フォルダを拾わない', !['f-decoy-root', 'f-decoy-tsam'].includes(resolved.folder?.id));
    check('ゴミ箱の同名フォルダを拾わない', resolved.folder?.id !== 'f-decoy-trashed');
    check('表示パス', resolved.folder?.path === 'マイドライブ / TSAM AI / ローカルLLM / 01_ナレッジ');

    const upper = await findFoldersByName({ parentId: 'root', name: 'tsam ai' });
    check('大文字小文字違いは完全一致にしない', upper.exact.length === 0 && upper.loose.length === 1, { e: upper.exact.length, l: upper.loose.length });

    const spaced = await findFoldersByName({ parentId: 'root', name: ' TSAM AI ' });
    check('前後空白つきは一致しない', spaced.exact.length === 0 && spaced.loose.length === 0);

    const fullwidth = await findFoldersByName({ parentId: 'f-llm', name: '０１_ナレッジ' });
    check('全角違いは一致しない', fullwidth.exact.length === 0);

    section('4. 固定パスの異常系');

    const withRename = async (id, name, fn) => {
      const original = tree.get(id).name;
      tree.get(id).name = name;
      try {
        return await fn();
      } finally {
        tree.get(id).name = original;
      }
    };

    for (const [id, label] of [['f-tsam', 'TSAM AI'], ['f-llm', 'ローカルLLM'], ['f-kn', '01_ナレッジ']]) {
      /* eslint-disable-next-line no-await-in-loop */
      const result = await withRename(id, `${label}_renamed`, () => resolveKnowledgeFolder());
      check(`${label} が無いと未検出`, result.status === PathResolveStatus.NOT_FOUND, result.status);
      check(`${label} の階層名を示す`, result.missingAt === label, result.missingAt);
      check(`${label}: 日本語メッセージ`, result.message.includes('見つかりませんでした'));
    }

    tree.set('f-llm2', { id: 'f-llm2', parent: 'f-tsam', name: 'ローカルLLM', mimeType: MIMES.FOLDER, modifiedTime: '2026-01-01T00:00:00.000Z', trashed: false, version: '1' });
    const ambiguous = await resolveKnowledgeFolder();
    check('同名複数を検出', ambiguous.status === PathResolveStatus.AMBIGUOUS, ambiguous.status);
    check('自動選択しない', ambiguous.folder === null);
    check('候補を返す', ambiguous.candidates.length === 2);
    check('候補に親名が入る', ambiguous.candidates.every((c) => c.parentName === 'TSAM AI'));
    tree.delete('f-llm2');

    tree.get('f-kn').trashed = true;
    check('ゴミ箱のフォルダは無視', (await resolveKnowledgeFolder()).status === PathResolveStatus.NOT_FOUND);
    tree.get('f-kn').trashed = false;

    const expectResolveFailure = async (kind, response, expectedStatus, label) => {
      scenario.inject = (k) => (k === kind ? response() : null);
      try {
        const result = await resolveKnowledgeFolder();
        check(label, result.status === expectedStatus, { status: result.status, message: result.message });
      } finally {
        scenario.inject = null;
      }
    };

    await expectResolveFailure('list', () => driveError(403, 'insufficientFilePermissions'), PathResolveStatus.ERROR, '途中階層が403ならエラー扱い');
    await expectResolveFailure('list', () => driveError(500), PathResolveStatus.ERROR, '5xxならエラー扱い');
    check('エラー後も再探索できる', (await resolveKnowledgeFolder()).status === PathResolveStatus.RESOLVED);

    section('5. ページネーション');

    scenario.pageSize = 2;
    const paged = await collectFolderTree({ folderId: 'f-kn', folderName: '01_ナレッジ', recursive: true, maxDepth: 5, pageSize: 2 });
    check('複数ページを結合して取得', paged.length === 7, paged.length);
    check('重複なく取得', new Set(paged.map((f) => f.id)).size === 7);
    check('pageToken を送っている', net.requests.some((r) => r.pageToken !== null));
    scenario.pageSize = undefined;

    section('6. 一覧のみ取得（解析しない）');

    net.reset();
    const preview = await previewFolder({ folder: FOLDER });
    check('走査件数', preview.scanned === 7, preview.scanned);
    check('本文の取得は発生しない', net.countMedia() === 0 && net.countExport() === 0);

    let files = await listFiles();
    check('一覧に保存される', files.length === 7, files.length);
    check('サブフォルダ配下も含む', Boolean(findFile(files, 'file-sub-txt')));
    check('スプレッドシートは対象外', findFile(files, 'file-sheet').syncState === FileSyncState.SKIPPED);
    check('対象外の理由が日本語', findFile(files, 'file-sheet').errorMessage.includes('スプレッドシート'));
    check('対象ファイルは未処理', findFile(files, 'file-txt').syncState === FileSyncState.PENDING);
    check('フォルダ名が入る', findFile(files, 'file-sub-txt').folderName === 'sub');
    check('DriveリンクがDriveドメイン', findFile(files, 'file-txt').driveUrl.startsWith('https://drive.google.com/'));

    section('7. 同期（取得・解析・保存）');

    net.reset();
    const sync1 = await runSync({ folder: FOLDER });
    check('新規件数', sync1.added === 6, sync1);
    check('対象外は skipped', sync1.skipped === 1);
    check('失敗ゼロ', sync1.failed === 0, sync1);
    check('Googleドキュメントを export', net.countExport() === 1);
    check('本体取得は5件', net.countMedia() === 5);

    files = await listFiles();
    check('索引済み6件', files.filter((f) => f.syncState === FileSyncState.INDEXED).length === 6);

    const expectText = async (fileId, needle, label) => {
      const doc = await getDocument(fileId);
      check(label, Boolean(doc?.text?.includes(needle)), doc?.text?.slice(0, 80));
    };

    await expectText('file-txt', 'テスト用キーワードあいうえお', 'TXTの抽出');
    await expectText('file-md', 'テスト用キーワードかきくけこ', 'Markdownの抽出');
    await expectText('file-pdf', 'PDFKEYWORD-SASISUSESO', 'PDFの抽出');
    await expectText('file-docx', 'テスト用キーワードたちつてと', 'DOCXの抽出');
    await expectText('file-gdoc', 'テスト用キーワードなにぬねの', 'Googleドキュメントの抽出');
    await expectText('file-sub-txt', 'テスト用キーワードはひふへほ', 'Shift_JIS TXTの抽出');

    const mdChunks = await getChunksByFile('file-md');
    check('見出しがチャンクに入る', mdChunks.some((c) => c.heading.includes('就業規則') || c.heading.includes('第2章')));
    check('チャンクにDriveリンク', mdChunks[0].driveUrl.startsWith('https://drive.google.com/'));
    check('チャンクにフォルダ名', mdChunks[0].folderName === '01_ナレッジ');
    check('コードブロックを保持', mdChunks.some((c) => c.text.includes('const x = 1')));

    section('8. Driveへの書き込みが無いこと');

    check('非GETリクエストは0件', net.nonGet().length === 0, net.nonGet());
    check('Authorizationヘッダー欠落は0件', net.missingAuth().length === 0);
    check('uploadエンドポイントを呼ばない', net.requests.every((r) => !r.url.includes('/upload/')));
    check('files/create を呼ばない', net.requests.every((r) => !/\/files$/.test(r.path) || r.method === 'GET'));

    section('9. 日本語検索');

    const hitFile = async (query) => (await search(query)).hits[0]?.fileId;
    check('TXTがヒット', await hitFile('テスト用キーワードあいうえお') === 'file-txt');
    check('Markdownがヒット', await hitFile('テスト用キーワードかきくけこ') === 'file-md');
    check('DOCXがヒット', await hitFile('テスト用キーワードたちつてと') === 'file-docx');
    check('Googleドキュメントがヒット', await hitFile('テスト用キーワードなにぬねの') === 'file-gdoc');
    check('サブフォルダ内TXTがヒット', await hitFile('テスト用キーワードはひふへほ') === 'file-sub-txt');
    check('PDFがヒット', await hitFile('PDFKEYWORD-SASISUSESO') === 'file-pdf');

    const q = await search('有給休暇');
    check('部分語でヒット', q.hits.length > 0);
    check('抜粋が返る', typeof q.hits[0]?.snippet === 'string' && q.hits[0].snippet.length > 0);
    check('関連度が数値', typeof q.hits[0]?.score === 'number');
    check('Driveリンクが安全', safeDriveUrl(q.hits[0]?.driveUrl) !== null);
    check('ファイル名でヒット', (await search('test-knowledge')).hits.length > 0);
    check('フォルダ名でヒット', (await search('01_ナレッジ')).hits.length > 0);
    check('無関係語はヒットしない', (await search('存在しない語句ZZZ')).hits.length === 0);
    check('空検索は0件', (await search('   ')).hits.length === 0);
    check('件数上限が効く', (await search('テスト', { limit: 2 })).hits.length <= 2);

    section('10. 差分同期');

    net.reset();
    const sync2 = await runSync({ folder: FOLDER });
    check('再取得なし', net.countMedia() === 0 && net.countExport() === 0);
    check('全件が変更なし', sync2.unchanged === 6 && sync2.skipped === 1, sync2);
    check('追加・更新なし', sync2.added === 0 && sync2.updated === 0);

    /* 更新日時だけ変更・内容同一 */
    tree.get('file-txt').modifiedTime = '2026-03-01T00:00:00.000Z';
    tree.get('file-txt').version = '2';
    const beforeChunks = (await getChunksByFile('file-txt')).map((c) => c.chunkId);
    net.reset();
    const sync3 = await runSync({ folder: FOLDER });
    check('再取得は1件だけ', net.countMedia() === 1, net.countMedia());
    check('内容同一なら更新扱いにしない', sync3.updated === 0, sync3);
    check('チャンクを作り直さない', JSON.stringify(beforeChunks) === JSON.stringify((await getChunksByFile('file-txt')).map((c) => c.chunkId)));

    /* version だけ変更・内容同一 */
    tree.get('file-md').version = '9';
    net.reset();
    const syncVer = await runSync({ folder: FOLDER });
    check('version変更でも再取得する', net.countMedia() === 1, net.countMedia());
    check('内容同一なら更新扱いにしない（version）', syncVer.updated === 0, syncVer);

    /* 更新日時同一・内容変更（Drive上ありえないが、取りこぼさないこと） */
    tree.get('file-docx').body = fixtures['sample.docx'];
    const sameTimeHash = (await getDocument('file-docx')).contentHash;
    check('内容ハッシュが保存されている', typeof sameTimeHash === 'string' && sameTimeHash.startsWith('sha256-'));

    /* 内容変更 */
    tree.get('file-txt').body = new TextEncoder().encode('更新後の本文です。テスト用キーワードまみむめも を含みます。\n').buffer;
    tree.get('file-txt').modifiedTime = '2026-03-02T00:00:00.000Z';
    tree.get('file-txt').version = '3';
    const sync4 = await runSync({ folder: FOLDER });
    check('更新件数1', sync4.updated === 1, sync4);
    check('新しい内容で検索できる', await hitFile('テスト用キーワードまみむめも') === 'file-txt');
    check('古い内容は検索に残らない', (await search('テスト用キーワードあいうえお')).hits.length === 0);

    /* ファイル名変更 */
    tree.get('file-txt').name = 'renamed-knowledge.txt';
    tree.get('file-txt').modifiedTime = '2026-03-03T00:00:00.000Z';
    tree.get('file-txt').version = '4';
    const renameSync = await runSync({ folder: FOLDER });
    files = await listFiles();
    check('ファイル名変更が反映される', findFile(files, 'file-txt').name === 'renamed-knowledge.txt');
    check('ファイル名変更では再分割しない', renameSync.updated === 0, renameSync);
    check('新しいファイル名で検索できる', (await search('renamed-knowledge')).hits.length > 0);
    check('チャンクのファイル名も更新される', (await getChunksByFile('file-txt')).every((c) => c.name !== 'test-knowledge.txt' && c.fileName === 'renamed-knowledge.txt'), (await getChunksByFile('file-txt')).map((c) => c.fileName));
    check('検索結果に新しいファイル名が出る', (await search('テスト用キーワードまみむめも')).hits[0]?.fileName === 'renamed-knowledge.txt');
    check('古いファイル名では検索できない', (await search('test-knowledge.txt')).hits.every((h) => h.fileId !== 'file-txt'));

    /* チャンクだけ失われた場合に作り直せること（保存が途中で失敗した状況） */
    await db.chunks.where('fileId').equals('file-sub-txt').delete();
    await runSync({ folder: FOLDER });
    check('チャンクが失われても作り直す', (await getChunksByFile('file-sub-txt')).length > 0, (await getChunksByFile('file-sub-txt')).length);
    check('作り直し後も検索できる', (await search('テスト用キーワードはひふへほ')).hits.length > 0);

    section('11. 削除・移動の追随');

    tree.delete('file-md');
    const sync5 = await runSync({ folder: FOLDER });
    check('削除件数1', sync5.deleted === 1, sync5);
    files = await listFiles();
    check('一覧から消える', !findFile(files, 'file-md'));
    check('文書も消える', (await getDocument('file-md')) === undefined);
    check('チャンクも消える', (await getChunksByFile('file-md')).length === 0);
    check('検索にも出ない', (await search('テスト用キーワードかきくけこ')).hits.length === 0);
    check('他のファイルは残る', Boolean(findFile(files, 'file-txt')) && Boolean(findFile(files, 'file-docx')));
    check('他のファイルの検索は生きている', (await search('テスト用キーワードたちつてと')).hits.length > 0);

    tree.get('file-docx').parent = 'f-tsam';
    const sync6 = await runSync({ folder: FOLDER });
    check('対象外への移動を削除として扱う', sync6.deleted === 1, sync6);
    check('移動後は検索から消える', (await search('テスト用キーワードたちつてと')).hits.length === 0);
    tree.get('file-docx').parent = 'f-kn';
    const sync7 = await runSync({ folder: FOLDER });
    check('戻すと再取り込み', sync7.added === 1, sync7);
    check('再び検索できる', (await search('テスト用キーワードたちつてと')).hits.length > 0);

    /* 対象フォルダ内での移動（サブフォルダへ）は削除にしない */
    tree.get('file-docx').parent = 'f-sub';
    const sync8 = await runSync({ folder: FOLDER });
    check('フォルダ内移動は削除にしない', sync8.deleted === 0, sync8);
    files = await listFiles();
    check('移動先フォルダ名が更新される', findFile(files, 'file-docx').folderName === 'sub');
    tree.get('file-docx').parent = 'f-kn';
    await runSync({ folder: FOLDER });

    tree.get('file-pdf').trashed = true;
    const sync9 = await runSync({ folder: FOLDER });
    check('ゴミ箱移動を削除として扱う', sync9.deleted === 1, sync9);
    tree.get('file-pdf').trashed = false;
    await runSync({ folder: FOLDER });
    check('ゴミ箱から戻すと再取り込み', (await search('PDFKEYWORD-SASISUSESO')).hits.length > 0);

    section('12. 日本語PDF（CIDフォント + CMap）');

    tree.set('file-jp-pdf', {
      id: 'file-jp-pdf', parent: 'f-kn', name: 'japanese.pdf', mimeType: 'application/pdf',
      modifiedTime: '2026-04-03T00:00:00.000Z', version: '1', trashed: false,
      webViewLink: 'https://drive.google.com/file/d/file-jp-pdf/view', body: fixtures['japanese.pdf'],
    });
    await runSync({ folder: FOLDER });
    files = await listFiles();
    check('日本語PDFを解析できる', findFile(files, 'file-jp-pdf').syncState === FileSyncState.INDEXED, findFile(files, 'file-jp-pdf'));
    await expectText('file-jp-pdf', '日本語テスト', 'CMap経由で日本語を抽出');
    check('日本語PDFが検索でヒット', (await search('日本語テスト')).hits.some((h) => h.fileId === 'file-jp-pdf'));

    tree.set('file-multipdf', {
      id: 'file-multipdf', parent: 'f-kn', name: 'multipage.pdf', mimeType: 'application/pdf',
      modifiedTime: '2026-04-04T00:00:00.000Z', version: '1', trashed: false,
      webViewLink: 'https://drive.google.com/file/d/file-multipdf/view', body: fixtures['multipage.pdf'],
    });
    await runSync({ folder: FOLDER });
    const multi = await getDocument('file-multipdf');
    check('複数ページを抽出', multi.text.includes('PAGE-ONE-ALPHA') && multi.text.includes('PAGE-THREE-CHARLIE'), multi.text);
    check('ページ順を保つ', multi.text.indexOf('PAGE-ONE-ALPHA') < multi.text.indexOf('PAGE-TWO-BRAVO'));
    files = await listFiles();
    check('ページ数を記録', findFile(files, 'file-multipdf').pageCount === 3, findFile(files, 'file-multipdf').pageCount);

    tree.delete('file-jp-pdf');
    tree.delete('file-multipdf');
    await runSync({ folder: FOLDER });

    section('13. 異常なファイル');

    const addFile = (id, name, mimeType, body, extra = {}) => tree.set(id, {
      id, parent: 'f-kn', name, mimeType, modifiedTime: '2026-05-01T00:00:00.000Z',
      version: '1', trashed: false, webViewLink: `https://drive.google.com/file/d/${id}/view`, body, ...extra,
    });

    addFile('bad-empty', 'empty.txt', 'text/plain', fixtures['empty.txt']);
    addFile('bad-zero', 'zero.txt', 'text/plain', fixtures['zero.txt']);
    addFile('bad-pdf', 'broken.pdf', 'application/pdf', fixtures['broken.pdf']);
    addFile('bad-zeropdf', 'zero.pdf', 'application/pdf', fixtures['zero.pdf']);
    addFile('bad-docx', 'broken.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fixtures['broken.docx']);
    addFile('bad-emptydocx', 'empty.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fixtures['empty.docx']);
    addFile('ok-bom', 'bom.txt', 'text/plain', fixtures['sample-bom.txt']);
    addFile('ok-crlf', 'crlf.txt', 'text/plain', fixtures['sample-crlf.txt']);
    addFile('ok-nul', 'nul.txt', 'text/plain', fixtures['sample-nul.txt']);
    addFile('ok-huge', 'huge-line.txt', 'text/plain', fixtures['huge-line.txt']);
    addFile('ok-urls', 'urls.md', 'text/markdown', fixtures['urls.md']);

    const syncBad = await runSync({ folder: FOLDER });
    files = await listFiles();

    check('空ファイルは EMPTY_TEXT', findFile(files, 'bad-empty').errorCode === ErrorCode.EMPTY_TEXT, findFile(files, 'bad-empty').errorCode);
    check('0バイトファイルも EMPTY_TEXT', findFile(files, 'bad-zero').errorCode === ErrorCode.EMPTY_TEXT, findFile(files, 'bad-zero').errorCode);
    check('破損PDFは PDF_PARSE_FAILED', findFile(files, 'bad-pdf').errorCode === ErrorCode.PDF_PARSE_FAILED, findFile(files, 'bad-pdf').errorCode);
    check('0バイトPDFもエラー', findFile(files, 'bad-zeropdf').syncState === FileSyncState.ERROR, findFile(files, 'bad-zeropdf').errorCode);
    check('破損DOCXは DOCX_PARSE_FAILED', findFile(files, 'bad-docx').errorCode === ErrorCode.DOCX_PARSE_FAILED, findFile(files, 'bad-docx').errorCode);
    check('空DOCXは EMPTY_TEXT', findFile(files, 'bad-emptydocx').errorCode === ErrorCode.EMPTY_TEXT, findFile(files, 'bad-emptydocx').errorCode);
    check('エラーは日本語で表示', findFile(files, 'bad-pdf').errorMessage.includes('PDF'));

    check('BOM付きUTF-8を解析', findFile(files, 'ok-bom').syncState === FileSyncState.INDEXED);
    check('BOMを本文に残さない', !(await getDocument('ok-bom')).text.startsWith('﻿'));
    check('BOM付きが検索できる', (await search('テスト用キーワードまみむめも')).hits.some((h) => h.fileId === 'ok-bom'));
    check('CRLFを解析', findFile(files, 'ok-crlf').syncState === FileSyncState.INDEXED);
    check('CRを残さない', !(await getDocument('ok-crlf')).text.includes('\r'));
    check('制御文字を含むTXTを解析', findFile(files, 'ok-nul').syncState === FileSyncState.INDEXED);
    check('制御文字を除去', !(await getDocument('ok-nul')).text.includes(' '));
    check('巨大1行を解析', findFile(files, 'ok-huge').syncState === FileSyncState.INDEXED);
    check('巨大1行を複数チャンクへ', (await getChunksByFile('ok-huge')).length > 50, (await getChunksByFile('ok-huge')).length);
    check('巨大1行が上限内', (await getChunksByFile('ok-huge')).every((c) => c.text.length <= 1200));
    check('URL・数字を壊さない', (await getDocument('ok-urls')).text.includes('https://example.com/path?a=1&b=2') && (await getDocument('ok-urls')).text.includes('1,234,567'));
    check('失敗があっても他は成功', syncBad.added >= 5, syncBad);
    check('失敗件数を集計（壊れ4 + 空2）', syncBad.failed === 6, syncBad.failed);

    ['bad-empty', 'bad-zero', 'bad-pdf', 'bad-zeropdf', 'bad-docx', 'bad-emptydocx',
      'ok-huge', 'ok-bom', 'ok-crlf', 'ok-nul', 'ok-urls'].forEach((id) => tree.delete(id));
    await runSync({ folder: FOLDER });
    check('追加したファイルを片付けた', (await listFiles()).length === 6, (await listFiles()).map((f) => f.name));

    section('14. サイズ上限');

    tree.get('file-txt').declaredSize = 999 * 1024 * 1024;
    net.reset();
    await runSync({ folder: FOLDER });
    files = await listFiles();
    check('上限超過はエラー扱い', findFile(files, 'file-txt').errorCode === ErrorCode.FILE_TOO_LARGE);
    check('上限超過は取得しない', net.requests.every((r) => !r.url.includes('file-txt') || !r.url.includes('alt=media')));
    delete tree.get('file-txt').declaredSize;
    await runSync({ folder: FOLDER });

    section('15. HTTPエラーの写像と再試行');

    const expectError = async (kind, response, fn, expected, label) => {
      scenario.inject = (k) => (k === kind ? response() : null);
      try {
        await fn();
        check(label, false, 'エラーにならなかった');
      } catch (error) {
        check(label, error.code === expected, { got: error.code, status: error.status });
      } finally {
        scenario.inject = null;
      }
    };

    /* 401 は一度だけ再認可して成功する */
    let used401 = false;
    scenario.inject = (k) => {
      if (k === 'list' && !used401) { used401 = true; return driveError(401, 'authError'); }
      return null;
    };
    check('401 は自動で再認可して成功', (await listFilesInFolder({ folderId: 'f-kn' })).files.length > 0);
    scenario.inject = null;

    await expectError('list', () => driveError(401, 'authError'), () => listFilesInFolder({ folderId: 'f-kn' }), ErrorCode.AUTH_EXPIRED, '401が続くとエラー');
    await expectError('list', () => driveError(403, 'accessNotConfigured'), () => listFilesInFolder({ folderId: 'f-kn' }), ErrorCode.DRIVE_API_DISABLED, '403 API未有効');
    await expectError('list', () => driveError(403, 'insufficientFilePermissions'), () => listFilesInFolder({ folderId: 'f-kn' }), ErrorCode.DRIVE_PERMISSION_DENIED, '403 権限不足');
    await expectError('media', () => driveError(404, 'notFound'), () => downloadFile('file-txt'), ErrorCode.DRIVE_NOT_FOUND, '404');
    await expectError('export', () => driveError(403, 'exportSizeLimitExceeded'), () => exportGoogleDoc('file-gdoc'), ErrorCode.DRIVE_EXPORT_TOO_LARGE, '403 export上限');
    await expectError('list', () => htmlError(502), () => listFilesInFolder({ folderId: 'f-kn' }), ErrorCode.SERVER_ERROR, 'JSONでないエラー応答');
    await expectError('list', () => new Response('', { status: 204 }), () => listFilesInFolder({ folderId: 'f-kn' }), ErrorCode.NETWORK_ERROR, '204（本文なし）でも落ちない');

    let attempts = 0;
    scenario.inject = (k) => {
      if (k !== 'list') return null;
      attempts += 1;
      return attempts <= 2 ? driveError(429, 'rateLimitExceeded', { 'Retry-After': '0' }) : null;
    };
    check('429 は再試行して成功', (await listFilesInFolder({ folderId: 'f-kn' })).files.length > 0 && attempts === 3, { attempts });
    scenario.inject = null;

    await expectError('list', () => driveError(429, 'rateLimitExceeded', { 'Retry-After': '0' }), () => listFilesInFolder({ folderId: 'f-kn' }), ErrorCode.DRIVE_RATE_LIMIT, '429が続くとエラー');
    await expectError('list', () => driveError(503, null, { 'Retry-After': '0' }), () => listFilesInFolder({ folderId: 'f-kn' }), ErrorCode.SERVER_ERROR, '5xxが続くとエラー');

    scenario.inject = (k) => (k === 'list' ? driveError(403, 'insufficientFilePermissions') : null);
    try {
      await runSync({ folder: FOLDER });
      check('同期中の一覧失敗はエラーになる', false);
    } catch (error) {
      check('同期中の一覧失敗はエラーになる', error.code === ErrorCode.DRIVE_PERMISSION_DENIED, error.code);
    }
    scenario.inject = null;
    check('失敗後も同期を再開できる', !isSyncing());

    /* 1ファイルだけ失敗しても他は成功する */
    scenario.inject = (k, info) => (k === 'media' && info.id === 'file-pdf' ? driveError(403, 'insufficientFilePermissions') : null);
    await runSync({ folder: FOLDER, force: true });
    scenario.inject = null;
    files = await listFiles();
    check('一部失敗しても他は索引済み', findFile(files, 'file-gdoc').syncState === FileSyncState.INDEXED);
    check('失敗ファイルにエラーが記録される', findFile(files, 'file-pdf').errorCode === ErrorCode.DRIVE_PERMISSION_DENIED, findFile(files, 'file-pdf').errorCode);
    await runSync({ folder: FOLDER, force: true });
    files = await listFiles();
    check('再同期で回復する', findFile(files, 'file-pdf').syncState === FileSyncState.INDEXED);

    section('16. 中断・再開・二重起動');

    await clearAllCache({ keepSettings: true });
    await clearIndex();
    await setSyncOptions({ ...DEFAULT_SYNC, concurrency: 1 });

    const cancelled = await runSync({
      folder: FOLDER,
      onProgress: (p) => { if (p.phase === 'parsing' && p.done >= 1) cancelSync(); },
    });
    check('キャンセルが記録される', cancelled.cancelled === true, cancelled);
    check('キャンセル後は実行中でない', !isSyncing());

    const resumed = await runSync({ folder: FOLDER });
    check('再開して残りを処理', resumed.failed === 0, resumed);
    files = await listFiles();
    const targetCount = files.filter((f) => f.isKnowledge).length;
    check('再開後は全対象が索引済み', files.filter((f) => f.syncState === FileSyncState.INDEXED).length === targetCount, files.map((f) => `${f.name}:${f.syncState}`));
    check('対象外は索引しない', files.filter((f) => !f.isKnowledge).every((f) => f.syncState === FileSyncState.SKIPPED));

    /* 二重起動の防止（同期ボタン連打） */
    const first = runSync({ folder: FOLDER, force: true });
    let doubleStart = null;
    try {
      await runSync({ folder: FOLDER });
      doubleStart = 'started';
    } catch (error) {
      doubleStart = error.detail;
    }
    await first;
    check('同期は二重起動しない', doubleStart === 'sync_in_progress', doubleStart);
    check('一覧取得も二重起動しない', await (async () => {
      const a = runSync({ folder: FOLDER });
      let blocked = false;
      try { await previewFolder({ folder: FOLDER }); } catch (error) { blocked = error.detail === 'sync_in_progress'; }
      await a;
      return blocked;
    })());

    /* 遅い応答の途中でキャンセルしても固まらない */
    scenario.delayMs = 300;
    const slow = runSync({ folder: FOLDER, force: true });
    setTimeout(() => cancelSync(), 120);
    const slowResult = await slow;
    check('遅延中のキャンセルでも戻る', slowResult.cancelled === true || slowResult.failed === 0, slowResult);
    scenario.delayMs = 0;
    await runSync({ folder: FOLDER });

    section('17. ファイル単位の操作');

    await resyncFile('file-gdoc');
    files = await listFiles();
    check('再同期で未処理へ戻す', findFile(files, 'file-gdoc').syncState === FileSyncState.PENDING);
    net.reset();
    await runSync({ folder: FOLDER });
    check('再同期で再取得する', net.countExport() === 1, net.countExport());

    const beforeDelete = (await collectStats()).chunkCount;
    const gdocChunks = (await getChunksByFile('file-gdoc')).length;
    await deleteFileData('file-gdoc');
    const afterDelete = await collectStats();
    check('ファイル単位削除でチャンクも減る', afterDelete.chunkCount === beforeDelete - gdocChunks, { beforeDelete, after: afterDelete.chunkCount, gdocChunks });
    check('他ファイルは消えない', afterDelete.fileCount > 0);
    await runSync({ folder: FOLDER });

    section('18. 検索インデックス');

    const stats1 = await collectStats();
    check('索引が保存されている', stats1.indexDocCount > 0);
    const rebuilt = await rebuildIndex();
    check('再構築できる', rebuilt.count === stats1.chunkCount, { rebuilt, chunks: stats1.chunkCount });
    check('再構築後も検索できる', (await search('テスト用キーワードなにぬねの')).hits.length > 0);

    const beforeReload = (await search('有給休暇')).hits.map((h) => h.chunkId);
    await clearIndex();
    const afterReload = (await search('有給休暇')).hits.map((h) => h.chunkId);
    check('索引削除後も自動復旧して同じ結果', JSON.stringify(beforeReload) === JSON.stringify(afterReload), { beforeReload, afterReload });

    const probe = await probeIndex();
    check('索引プローブ', probe.found === true);
    check('プローブの一時データは残らない', (await search('診断用キーワード')).hits.length === 0);
    check('索引を保存できる', typeof (await persistIndex()) === 'number');

    section('19. IndexedDB');

    try {
      await runWrite('test:quota', () => {
        const error = new Error('quota');
        error.name = 'QuotaExceededError';
        throw error;
      });
      check('容量不足を専用コードへ写像', false);
    } catch (error) {
      check('容量不足を専用コードへ写像', error.code === ErrorCode.DB_QUOTA_EXCEEDED);
      check('容量不足の日本語メッセージ', error.userMessage.includes('保存容量'));
    }

    try {
      await runWrite('test:generic', () => { throw new Error('boom'); });
      check('書き込み失敗を写像', false);
    } catch (error) {
      check('書き込み失敗を写像', error.code === ErrorCode.DB_WRITE_FAILED);
    }

    check('スキーマのバージョンが2以上', db.verno >= 2, db.verno);
    check('テーブルが揃っている', ['settings', 'files', 'documents', 'chunks', 'searchIndex', 'syncLogs'].every((t) => db.tables.some((x) => x.name === t)), db.tables.map((t) => t.name));

    /* orphan（親を失ったデータ）が残らないこと */
    const orphanFiles = new Set((await listFiles()).map((f) => f.fileId));
    const allChunks = await db.chunks.toArray();
    check('親のいないチャンクが無い', allChunks.every((c) => orphanFiles.has(c.fileId)), allChunks.filter((c) => !orphanFiles.has(c.fileId)).map((c) => c.fileId));
    const allDocs = await db.documents.toArray();
    check('親のいない文書が無い', allDocs.every((d) => orphanFiles.has(d.fileId)), allDocs.filter((d) => !orphanFiles.has(d.fileId)).map((d) => d.fileId));

    /* 取り残されたデータを検出して掃除できること */
    await db.chunks.put({
      chunkId: '__orphan__:0', fileId: '__orphan__', fileName: 'orphan.txt', folderName: 'x',
      heading: '', text: '孤児チャンクのテストです。', chunkIndex: 0, updatedTime: '', driveUrl: '',
    });
    await db.documents.put({ fileId: '__orphan__', text: '孤児文書', charCount: 4, contentHash: 'x', updatedAt: '' });
    const removedOrphans = await cleanupOrphans();
    check('孤児チャンクを検出して削除', removedOrphans.chunkIds.includes('__orphan__:0'), removedOrphans);
    check('孤児文書を検出して削除', removedOrphans.documentIds.includes('__orphan__'), removedOrphans);
    check('孤児が残っていない', !(await listFileIdsWithChunks()).includes('__orphan__'));
    check('掃除しても正常データは残る', (await collectStats()).chunkCount > 0);
    check('掃除は再実行しても安全', (await cleanupOrphans()).chunkIds.length === 0);

    /* 同期の最後にも自動で掃除されること */
    await db.chunks.put({
      chunkId: '__orphan2__:0', fileId: '__orphan2__', fileName: 'o2.txt', folderName: 'x',
      heading: '', text: '孤児2', chunkIndex: 0, updatedTime: '', driveUrl: '',
    });
    const orphanSync = await runSync({ folder: FOLDER });
    check('同期の最後に孤児を掃除する', orphanSync.orphansRemoved === 1, orphanSync.orphansRemoved);
    check('掃除後に孤児が残らない', !(await listFileIdsWithChunks()).includes('__orphan2__'));

    /* ログの上限 */
    for (let i = 0; i < 60; i += 1) {
      logger.info('test:log-flood', { i });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const beforeTrim = (await listLogs(5000)).length;
    const removed = await trimLogs(20);
    const afterTrim = (await listLogs(5000)).length;
    check('ログを間引ける', afterTrim <= 20 && removed > 0, { beforeTrim, afterTrim, removed });

    section('20. Worker の堅牢性');

    const rpc = createWorkerClient(
      () => new Worker(new URL('../../src/workers/parse.worker.js', import.meta.url), { type: 'module' }),
      { name: 'test-parse', defaultTimeoutMs: 30000 },
    );

    check('ping に応答する', (await rpc.call('ping', {}))?.ok === true);

    try {
      await rpc.call('___no_such_handler___', {});
      check('未知のtypeはエラー', false);
    } catch (error) {
      check('未知のtypeはエラー', error.code === ErrorCode.UNKNOWN, error.code);
    }

    try {
      await rpc.call('parse', { fileId: 'x', kind: 'xlsx', buffer: new ArrayBuffer(4), chunkOptions: {} });
      check('未対応形式はエラー', false);
    } catch (error) {
      check('未対応形式はエラー', error.code === ErrorCode.UNSUPPORTED_TYPE, error.code);
    }

    /* タイムアウトでWorkerを作り直し、その後も使えること */
    const quick = createWorkerClient(
      () => new Worker(new URL('../../src/workers/parse.worker.js', import.meta.url), { type: 'module' }),
      { name: 'test-timeout', defaultTimeoutMs: 1 },
    );
    try {
      await quick.call('parse', { fileId: 'x', kind: 'pdf', buffer: fixtures['sample.pdf'].slice(0), chunkOptions: {}, pdfAssets: getPdfAssetUrls() });
      check('タイムアウトする', false);
    } catch (error) {
      check('タイムアウトする', error.code === ErrorCode.WORKER_TIMEOUT, error.code);
    }
    check('タイムアウト後にWorkerを作り直す', (await createWorkerClient(
      () => new Worker(new URL('../../src/workers/parse.worker.js', import.meta.url), { type: 'module' }),
      { name: 'test-recover', defaultTimeoutMs: 30000 },
    ).call('ping', {}))?.ok === true);

    /* 中断シグナル */
    const controller = new AbortController();
    const aborted = rpc.call('parse', {
      fileId: 'x', kind: 'pdf', buffer: fixtures['multipage.pdf'].slice(0), chunkOptions: {}, pdfAssets: getPdfAssetUrls(),
    }, { signal: controller.signal });
    controller.abort();
    try {
      await aborted;
      check('AbortSignal で中断できる', false);
    } catch (error) {
      check('AbortSignal で中断できる', error.code === ErrorCode.CANCELLED, error.code);
    }

    /* 同時2件 */
    const [a, b] = await Promise.all([
      rpc.call('parse', { fileId: 'a', fileName: 'a.pdf', kind: 'pdf', buffer: fixtures['sample.pdf'].slice(0), chunkOptions: {}, pdfAssets: getPdfAssetUrls() }),
      rpc.call('parse', { fileId: 'b', fileName: 'b.pdf', kind: 'pdf', buffer: fixtures['japanese.pdf'].slice(0), chunkOptions: {}, pdfAssets: getPdfAssetUrls() }),
    ]);
    check('同時2件を処理できる', a.text.includes('PDFKEYWORD') && b.text.includes('日本語テスト'), { a: a.text.slice(0, 30), b: b.text.slice(0, 30) });
    check('要求IDが混ざらない', a.text !== b.text);

    rpc.terminate();
    check('terminate 後も呼び出しでWorkerを再生成', (await rpc.call('ping', {}))?.ok === true);
    rpc.terminate();
    quick.terminate();

    section('21. DOM の安全性');

    check('javascript: を拒否', safeUrl('javascript:alert(1)') === null);
    check('data: を拒否', safeUrl('data:text/html,<script>') === null);
    check('vbscript: を拒否', safeUrl('vbscript:msgbox') === null);
    check('制御文字での難読化を拒否', safeUrl('java\nscript:alert(1)') === null);
    check('プロトコル相対を拒否', safeUrl('//evil.example.com') === null);
    check('httpsは許可', safeUrl('https://example.com/a') === 'https://example.com/a');
    check('Drive以外のhttpsはDriveリンクにしない', safeDriveUrl('https://evil.example.com/x') === null);
    check('Driveドメインは許可', safeDriveUrl('https://drive.google.com/file/d/x/view') !== null);
    check('docs.google.com も許可', safeDriveUrl('https://docs.google.com/document/d/x/edit') !== null);

    const fragment = highlightFragment('<script>alert(1)</script> キーワード', ['キーワード']);
    const holder = el('div');
    holder.append(fragment);
    check('本文のタグをHTMLとして解釈しない', holder.querySelector('script') === null);
    check('本文のタグは文字として残る', holder.textContent.includes('<script>'));
    check('一致部分は mark 要素になる', holder.querySelector('mark')?.textContent === 'キーワード');

    const evil = el('a', { href: 'javascript:alert(1)', text: 'x' });
    check('el() は危険なhrefを設定しない', !evil.hasAttribute('href'));

    section('22. トークンが残らない');

    const logs = await listLogs(1000);
    const logDump = JSON.stringify(logs);
    check('ログにトークンが無い', !logDump.includes('fake-token'), logDump.slice(0, 200));
    check('ログにBearerが無い', !logDump.includes('Bearer'));
    check('ログにAuthorizationが無い', !/"authorization"/i.test(logDump));

    check('ログアウト前は認証済み', hasValidAccessToken());
    signOut();
    check('ログアウトでトークン破棄', !hasValidAccessToken());
    check('プロフィールも破棄', getProfile() === null);
    check('Googleへ取り消しを送る', gis.revoked > 0);

    const storages = JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie });
    check('localStorage等にトークンが無い', !storages.includes('fake-token'), storages.slice(0, 200));

    const dbDump = JSON.stringify({
      settings: await db.settings.toArray(),
      files: await db.files.toArray(),
      documents: (await db.documents.toArray()).map((d) => ({ ...d, text: d.text.slice(0, 40) })),
      searchIndex: (await db.searchIndex.toArray()).map((r) => ({ id: r.id, docCount: r.docCount })),
    });
    check('IndexedDBにトークンが無い', !dbDump.includes('fake-token'));

    const cacheKeys = 'caches' in globalThis ? await caches.keys() : [];
    check('Cache Storage を使っていない', cacheKeys.length === 0, cacheKeys);
    check('Service Worker を登録していない', !navigator.serviceWorker?.controller);
    check('URLにトークンが無い', !location.href.includes('token') && !location.hash.includes('access'));
    check('DOMにトークンが無い', !document.body.textContent.includes('fake-token'));

    check('再認証できる', typeof (await ensureAccessToken()) === 'string');

    section('23. 全キャッシュ削除');

    await clearAllCache({ keepSettings: true });
    await clearIndex();
    const cleared = await collectStats();
    check('ファイル0件', cleared.fileCount === 0);
    check('文書0件', cleared.documentCount === 0);
    check('チャンク0件', cleared.chunkCount === 0);
    check('検索は空を返す', (await search('テスト用キーワードなにぬねの')).hits.length === 0);
    check('設定は残る', (await getSyncOptions()).concurrency === 1);

    await setChunkOptions({ targetChars: 800, overlapChars: 100, maxChars: 1200, minChars: 80 });
    check('設定を書き戻せる', (await getSyncOptions()).recursive === true);
  } catch (error) {
    failed += 1;
    failures.push('FATAL');
    log(`FATAL ${error?.code ?? ''} ${error?.message ?? error}`);
    log(String(error?.stack ?? '').slice(0, 900));
  } finally {
    net?.restore();
    resetAuth();
    terminateParseWorker();
  }

  section('24. 想定外のエラー');
  check('unhandledrejection 0件', unhandled.length === 0, unhandled);
  check('想定外の console.error 0件', consoleErrors.length === 0, consoleErrors);

  log(`\nブラウザ統合テスト: ${total} 件中 ${total - failed} 件成功 / ${failed} 件失敗`);
  if (failed > 0) {
    log(`失敗: ${failures.join(' / ')}`);
  }
  log(failed === 0 ? 'RESULT: ALL PASS' : `RESULT: ${failed} FAILURES`);
  document.title = failed === 0 ? 'PASS' : 'FAIL';
}

main();

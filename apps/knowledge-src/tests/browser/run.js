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
  hasWriteToken,
} from '../../src/auth/google-auth.js';
import { scanFolderStructure, createMissingFolders, isCreatingFolders } from '../../src/drive/folder-create.js';
import { PlanStatus } from '../../src/drive/folder-plan.js';
import { createSampleFiles } from '../../src/drive/sample-files.js';
import { requestWriteToken, discardWriteToken } from '../../src/auth/google-auth.js';
import { makeSetupRecord, createProgress } from '../../src/setup/wizard-state.js';
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
  cleanupOrphans, listFileIdsWithChunks, getSetupState, setSetupState,
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
    /* 失敗したときに原因が分かるよう、ファイルごとのエラーコードを添える。 */
    const sync1Errors = (await listFiles())
      .filter((f) => f.errorCode)
      .map((f) => ({ id: f.fileId, code: f.errorCode, message: String(f.errorMessage ?? '').slice(0, 60) }));
    check('失敗ゼロ', sync1.failed === 0, { summary: sync1, errors: sync1Errors });
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

    /* ============================================================ */
    section('21-2. 不足フォルダの作成（POST files.create）');

    /* 木構造を何度も作り替えるので、初期状態を控えておく。 */
    const treeSnapshot = new Map([...tree.entries()].map(([id, node]) => [id, { ...node }]));
    const restoreTree = () => {
      tree.clear();
      treeSnapshot.forEach((node, id) => tree.set(id, { ...node }));
    };
    /* 対象階層のフォルダだけを消す（ファイルは触らない）。 */
    const dropFolders = (...ids) => ids.forEach((id) => tree.delete(id));
    const mark = () => net.requests.length;
    const from = (n) => net.requests.slice(n);
    const names = (list) => list.map((item) => item.node.name).join(',');

    /* --- 一部存在（既定の木：01_ナレッジ まである） --- */
    let at = mark();
    let plan = await scanFolderStructure();
    check('一部存在：既存3件', plan.existing.length === 3, names(plan.existing));
    check('一部存在：不足3件', plan.missing.length === 3, names(plan.missing));
    check('一部存在：不足は02/03/99', names(plan.missing) === '02_未整理,03_アーカイブ,99_システム');
    check('一部存在：作成できる', plan.canCreate === true);
    check('確認だけでは書き込まない', from(at).every((r) => r.method === 'GET'));
    check('確認だけでは書き込みトークンを取らない', gis.writeRequests === 0, gis.writeRequests);

    at = mark();
    let result = await createMissingFolders({ isBusy: () => false });
    let posts = from(at).filter((r) => r.method === 'POST');

    check('一部存在：3件作成できる', result.ok === true && result.created.length === 3, result.error?.code);
    check('一部存在：POSTは3件', posts.length === 3, posts.length);
    check('一部存在：作成順序が仕様どおり',
      posts.map((r) => r.body.name).join(',') === '02_未整理,03_アーカイブ,99_システム',
      posts.map((r) => r.body.name));
    check('すべて POST /files', posts.every((r) => r.path.endsWith('/files')));
    check('mimeType はフォルダ', posts.every((r) => r.body.mimeType === MIMES.FOLDER));
    check('parents はちょうど1件', posts.every((r) => Array.isArray(r.body.parents) && r.body.parents.length === 1));
    check('親は ローカルLLM', posts.every((r) => r.body.parents[0] === 'f-llm'));
    check('fields が要件どおり', posts.every((r) => r.fields === 'id,name,mimeType,parents,webViewLink'));
    check('本文に余計な項目が無い',
      posts.every((r) => Object.keys(r.body).sort().join(',') === 'mimeType,name,parents'));
    check('作成には書き込みトークンを使う', posts.every((r) => r.writeToken === true));
    check('一覧取得は読み取りトークンのまま',
      from(at).filter((r) => r.method === 'GET').every((r) => r.writeToken === false));
    check('書き込みトークンの要求は1回', gis.writeRequests === 1, gis.writeRequests);
    check('作成後に書き込みトークンを破棄する', hasWriteToken() === false);
    check('作成済みリンクを返す', result.created.every((item) => item.folder.webViewLink.startsWith('https://drive.google.com/')));

    /* --- 全部存在（作成不要） --- */
    at = mark();
    plan = await scanFolderStructure();
    check('全部存在：COMPLETE', plan.status === PlanStatus.COMPLETE, plan.status);
    check('全部存在：作成不要', plan.needsCreation === false);
    result = await createMissingFolders({ isBusy: () => false });
    check('全部存在：何も作らない', result.ok === true && result.created.length === 0);
    check('全部存在：POSTが発生しない', from(at).filter((r) => r.method === 'POST').length === 0);
    check('全部存在：書き込みトークンを取らない', gis.writeRequests === 1, gis.writeRequests);

    /* --- 作成後の再探索（固定パスが解決できる） --- */
    const afterCreate = await resolveKnowledgeFolder();
    check('作成後も固定パスを解決できる', afterCreate.status === PathResolveStatus.RESOLVED);
    check('作成後の対象は 01_ナレッジ', afterCreate.folder.id === 'f-kn');

    /* --- TSAM AI のみ存在 --- */
    restoreTree();
    dropFolders('f-llm', 'f-kn', 'f-sub');
    at = mark();
    plan = await scanFolderStructure();
    check('TSAM AIのみ：既存1件', plan.existing.length === 1 && plan.existing[0].node.name === 'TSAM AI');
    check('TSAM AIのみ：不足5件', plan.missing.length === 5, names(plan.missing));

    at = mark();
    result = await createMissingFolders({ isBusy: () => false });
    posts = from(at).filter((r) => r.method === 'POST');
    check('TSAM AIのみ：5件作成', result.ok === true && result.created.length === 5, result.error?.code);
    check('TSAM AIのみ：既存は作り直さない', !posts.some((r) => r.body.name === 'TSAM AI'));
    check('TSAM AIのみ：ローカルLLMの親は既存のTSAM AI',
      posts[0].body.name === 'ローカルLLM' && posts[0].body.parents[0] === 'f-tsam');
    check('TSAM AIのみ：子の親は新しいローカルLLM',
      new Set(posts.slice(1).map((r) => r.body.parents[0])).size === 1
      && posts.slice(1)[0].body.parents[0] === result.created[0].folder.id);

    /* --- 全フォルダ不存在 --- */
    restoreTree();
    dropFolders('f-tsam', 'f-llm', 'f-kn', 'f-sub');
    at = mark();
    plan = await scanFolderStructure();
    check('全て不存在：既存0件', plan.existing.length === 0);
    check('全て不存在：不足6件', plan.missing.length === 6, names(plan.missing));
    check('全て不存在でもゴミ箱のTSAM AIを拾わない', plan.missing[0].node.name === 'TSAM AI');

    at = mark();
    result = await createMissingFolders({ isBusy: () => false });
    posts = from(at).filter((r) => r.method === 'POST');
    check('全て不存在：6件作成', result.ok === true && result.created.length === 6, result.error?.code);
    check('全て不存在：作成順序',
      posts.map((r) => r.body.name).join(',') === 'TSAM AI,ローカルLLM,01_ナレッジ,02_未整理,03_アーカイブ,99_システム',
      posts.map((r) => r.body.name));
    check('全て不存在：最初の親はroot', posts[0].body.parents[0] === 'root');
    check('全て不存在：2段目の親は1段目のID', posts[1].body.parents[0] === result.created[0].folder.id);
    check('全て不存在：3段目以降の親は2段目のID',
      posts.slice(2).every((r) => r.body.parents[0] === result.created[1].folder.id));

    /* --- 同名複数 --- */
    restoreTree();
    tree.set('f-llm-dup', {
      id: 'f-llm-dup', parent: 'f-tsam', name: 'ローカルLLM', mimeType: MIMES.FOLDER,
      modifiedTime: '2026-01-01T00:00:00.000Z', version: '1', trashed: false,
      webViewLink: 'https://drive.google.com/drive/folders/f-llm-dup',
    });
    at = mark();
    plan = await scanFolderStructure();
    check('同名複数：AMBIGUOUS', plan.status === PlanStatus.AMBIGUOUS, plan.status);
    check('同名複数：作成させない', plan.canCreate === false);
    check('同名複数：候補を返す', plan.ambiguous[0].candidates.length === 2);
    check('同名複数：自動選択しない', plan.ambiguous[0].folder === null);
    check('同名複数：その先は判定しない', plan.blocked.length === 4, plan.blocked.length);

    at = mark();
    result = await createMissingFolders({ isBusy: () => false });
    check('同名複数：作成を拒否する', result.error?.code === ErrorCode.FOLDER_CREATE_AMBIGUOUS, result.error?.code);
    check('同名複数：POSTが発生しない', from(at).filter((r) => r.method === 'POST').length === 0);
    check('同名複数：書き込みトークンを取らない', gis.writeRequests === 3, gis.writeRequests);
    tree.delete('f-llm-dup');

    /* --- 409相当（走査後・作成前に他者が作った） --- */
    restoreTree();
    at = mark();
    result = await createMissingFolders({
      isBusy: () => false,
      onProgress: (progress) => {
        /* 認可の直後、まだ1件も作っていない時点で外から 02_未整理 を作る。 */
        if (progress.phase === 'authorizing' && !tree.has('f-race')) {
          tree.set('f-race', {
            id: 'f-race', parent: 'f-llm', name: '02_未整理', mimeType: MIMES.FOLDER,
            modifiedTime: '2026-03-01T00:00:00.000Z', version: '1', trashed: false,
            webViewLink: 'https://drive.google.com/drive/folders/f-race',
          });
        }
      },
    });
    posts = from(at).filter((r) => r.method === 'POST');
    check('409相当：二重に作らない', !posts.some((r) => r.body.name === '02_未整理'), posts.map((r) => r.body.name));
    check('409相当：既存として再利用する', result.reused.some((item) => item.node.name === '02_未整理'));
    check('409相当：残りは作成する', posts.length === 2, posts.length);
    check('409相当：全体としては成功', result.ok === true, result.error?.code);

    /* --- HTTP 409 が返った場合（再試行しない） --- */
    restoreTree();
    at = mark();
    scenario.inject = (kind) => (kind === 'create' ? driveError(409, 'duplicate') : null);
    result = await createMissingFolders({ isBusy: () => false });
    posts = from(at).filter((r) => r.method === 'POST');
    /* 409 は再試行しない。ただし致命的ではないので、残りのノードは試す。 */
    check('409：1ノードあたり1回しか送らない',
      posts.length === 3 && new Set(posts.map((r) => r.body.name)).size === 3, posts.map((r) => r.body.name));
    check('409：失敗として記録する', result.failed.length === 3 && result.ok === false, result.failed.length);
    check('409：作成扱いにしない', result.created.length === 0);
    scenario.inject = undefined;

    /* --- 401（再試行しない） --- */
    restoreTree();
    at = mark();
    scenario.inject = (kind) => (kind === 'create' ? driveError(401, 'authError') : null);
    result = await createMissingFolders({ isBusy: () => false });
    posts = from(at).filter((r) => r.method === 'POST');
    check('401：再試行しない', posts.length === 1, posts.length);
    check('401：認証エラーとして扱う', result.failed[0]?.error?.code === ErrorCode.AUTH_EXPIRED, result.failed[0]?.error?.code);
    check('401：残りは実行しない', result.skipped.length === 2, result.skipped.length);
    scenario.inject = undefined;

    /* --- 403（再試行しない） --- */
    restoreTree();
    at = mark();
    scenario.inject = (kind) => (kind === 'create' ? driveError(403, 'insufficientFilePermissions') : null);
    result = await createMissingFolders({ isBusy: () => false });
    posts = from(at).filter((r) => r.method === 'POST');
    check('403：再試行しない', posts.length === 1, posts.length);
    check('403：権限不足として扱う', result.failed[0]?.error?.code === ErrorCode.DRIVE_PERMISSION_DENIED);
    check('403：残りは実行しない', result.skipped.length === 2);
    scenario.inject = undefined;

    /* --- 429（Retry-After を尊重して再試行し、成功する） --- */
    restoreTree();
    at = mark();
    let rateLimited = 0;
    scenario.inject = (kind) => {
      if (kind !== 'create') return null;
      rateLimited += 1;
      return rateLimited <= 2 ? driveError(429, 'rateLimitExceeded', { 'retry-after': '0' }) : null;
    };
    result = await createMissingFolders({ isBusy: () => false });
    posts = from(at).filter((r) => r.method === 'POST');
    check('429：再試行して成功する', result.ok === true, result.error?.code);
    check('429：再試行分だけPOSTが増える', posts.length === 5, posts.length);
    check('429：作成結果は3件', result.created.length === 3);
    scenario.inject = undefined;

    /* --- 5xx（上限まで再試行して失敗する） --- */
    restoreTree();
    at = mark();
    scenario.inject = (kind) => (kind === 'create' ? driveError(503, 'backendError', { 'retry-after': '0' }) : null);
    result = await createMissingFolders({ isBusy: () => false });
    posts = from(at).filter((r) => r.method === 'POST');
    /* 1ノードにつき「初回 + 再試行3回」= 4回。不足3件なので合計12回。 */
    check('5xx：1ノードあたり4回試す', posts.length === 12, posts.length);
    check('5xx：ノードごとの試行回数が4回',
      ['02_未整理', '03_アーカイブ', '99_システム']
        .every((name) => posts.filter((r) => r.body.name === name).length === 4),
      posts.map((r) => r.body.name));
    check('5xx：サーバーエラーとして扱う', result.failed[0]?.error?.code === ErrorCode.SERVER_ERROR);
    check('5xx：後続は続行する', result.failed.length + result.created.length === 3, result);
    scenario.inject = undefined;

    /* --- ネットワーク中断 --- */
    restoreTree();
    at = mark();
    scenario.inject = (kind) => {
      if (kind === 'create') throw new TypeError('Failed to fetch');
      return null;
    };
    result = await createMissingFolders({ isBusy: () => false });
    check('ネットワーク中断：通信エラーとして扱う',
      result.failed[0]?.error?.code === ErrorCode.NETWORK_ERROR, result.failed[0]?.error?.code);
    check('ネットワーク中断：成功扱いにしない', result.ok === false);
    scenario.inject = undefined;

    /* --- 部分失敗からの再開 --- */
    restoreTree();
    at = mark();
    scenario.inject = (kind, info) => {
      /* 03_アーカイブ だけ失敗させる。 */
      if (kind === 'create' && info?.body?.name === '03_アーカイブ') {
        return driveError(503, 'backendError', { 'retry-after': '0' });
      }
      return null;
    };
    const firstRun = await createMissingFolders({ isBusy: () => false });
    check('再開：1回目は2件成功1件失敗',
      firstRun.created.length === 2 && firstRun.failed.length === 1, firstRun);
    check('再開：1回目は未完了', firstRun.ok === false);
    check('再開：失敗したのは03_アーカイブ', firstRun.failed[0].node.name === '03_アーカイブ');

    scenario.inject = undefined;
    at = mark();
    const secondRun = await createMissingFolders({ isBusy: () => false });
    posts = from(at).filter((r) => r.method === 'POST');
    check('再開：2回目は残り1件だけ作る', posts.length === 1, posts.map((r) => r.body.name));
    check('再開：作り直したのは03_アーカイブ', posts[0].body.name === '03_アーカイブ');
    check('再開：1回目の成功分は作り直さない',
      !posts.some((r) => ['02_未整理', '99_システム'].includes(r.body.name)));
    check('再開：2回目で完了する', secondRun.ok === true, secondRun.error?.code);

    /* --- 二重実行の防止 --- */
    restoreTree();
    at = mark();
    const [runA, runB] = await Promise.all([
      createMissingFolders({ isBusy: () => false }),
      createMissingFolders({ isBusy: () => false }),
    ]);
    const rejected = [runA, runB].filter((r) => r.error?.code === ErrorCode.FOLDER_CREATE_IN_PROGRESS);
    check('二重実行：片方だけ実行される', rejected.length === 1, [runA.error?.code, runB.error?.code]);
    check('二重実行：POSTは3件のまま', from(at).filter((r) => r.method === 'POST').length === 3);
    check('二重実行：実行中フラグが戻る', isCreatingFolders() === false);

    /* --- 別タブが実行中（Web Locks） --- */
    restoreTree();
    if (navigator.locks?.request) {
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      const lockHeld = navigator.locks.request('tsam-knowledge-folder-create', () => held);

      at = mark();
      const lockedOut = await createMissingFolders({ isBusy: () => false });
      check('別タブ実行中：作成を断る', lockedOut.error?.code === ErrorCode.FOLDER_CREATE_IN_PROGRESS, lockedOut.error?.code);
      check('別タブ実行中：POSTが発生しない', from(at).filter((r) => r.method === 'POST').length === 0);

      release();
      await lockHeld;
      check('別タブのロックが外れたら実行できる',
        (await createMissingFolders({ isBusy: () => false })).ok === true);
    } else {
      check('別タブ実行中：作成を断る（Web Locks非対応のため省略）', true);
      check('別タブ実行中：POSTが発生しない（同上）', true);
      check('別タブのロックが外れたら実行できる（同上）', true);
    }

    /* --- 同期中は作成しない --- */
    restoreTree();
    at = mark();
    const busyResult = await createMissingFolders({ isBusy: () => true });
    check('同期中：作成を断る', busyResult.error?.code === ErrorCode.FOLDER_CREATE_BLOCKED_BY_SYNC);
    check('同期中：POSTが発生しない', from(at).filter((r) => r.method === 'POST').length === 0);

    /* --- 途中で同期が始まったら止める --- */
    restoreTree();
    at = mark();
    let syncStarted = false;
    const interrupted = await createMissingFolders({
      isBusy: () => syncStarted,
      onProgress: (progress) => {
        if (progress.phase === 'creating' && progress.done === 1) {
          syncStarted = true;
        }
      },
    });
    check('作成中に同期が始まったら残りを止める', interrupted.skipped.length > 0, interrupted.skipped.length);
    check('止めた分は未実行として記録する',
      interrupted.skipped.every((item) => item.reason === ErrorCode.FOLDER_CREATE_BLOCKED_BY_SYNC));

    /* --- 中断（AbortSignal） --- */
    restoreTree();
    at = mark();
    const aborter = new AbortController();
    aborter.abort();
    const abortedRun = await createMissingFolders({ isBusy: () => false, signal: aborter.signal });
    check('中断：作成しない', from(at).filter((r) => r.method === 'POST').length === 0);
    check('中断：未実行として記録する', abortedRun.skipped.length === 3 || abortedRun.error !== null, abortedRun);

    /* --- 書き込みメソッドの集計 --- */
    restoreTree();
    check('PUT/PATCH/DELETE は1件も無い', net.forbiddenWrites().length === 0, net.forbiddenWrites());
    check('非GETはすべて POST /files',
      net.nonGet().every((r) => r.method === 'POST' && r.path.endsWith('/files')),
      net.nonGet().filter((r) => r.method !== 'POST').map((r) => r.method));
    check('非GETはすべてフォルダ作成',
      net.nonGet().every((r) => r.body?.mimeType === MIMES.FOLDER));
    check('uploadエンドポイントを呼ばない', !net.requests.some((r) => r.url.includes('/upload/')));
    check('作成にも必ず Authorization を付ける', net.creates().every((r) => r.hasAuthHeader));

    /* --- 書き込みトークンが残らない --- */
    check('作成後に書き込みトークンを保持しない', hasWriteToken() === false);
    const writeLogs = JSON.stringify(await listLogs(1000));
    check('ログに書き込みトークンが無い', !writeLogs.includes('fake-write-token'));
    const writeStorages = JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie });
    check('ストレージに書き込みトークンが無い', !writeStorages.includes('fake-write-token'));
    check('DOMに書き込みトークンが無い', !document.body.textContent.includes('fake-write-token'));
    const writeDbDump = JSON.stringify(await db.settings.toArray());
    check('IndexedDBに書き込みトークンが無い', !writeDbDump.includes('fake-write-token'));

    /* 木を元に戻してから次の節へ進む。 */
    restoreTree();

    /* ============================================================ */
    section('21-3. サンプルファイルの作成（初回のみ・上書きしない）');

    /* 01_ナレッジ を作り直した状態を作る（中身は空）。 */
    const emptyKnowledge = () => {
      restoreTree();
      [...tree.keys()].forEach((id) => {
        if (tree.get(id)?.parent === 'f-kn') {
          tree.delete(id);
        }
      });
    };

    emptyKnowledge();
    at = mark();
    await requestWriteToken();
    let samples = await createSampleFiles({ folderId: 'f-kn' });
    discardWriteToken();
    let uploads = from(at).filter((r) => r.isUpload);

    check('空のフォルダなら2件作る', samples.ok === true && samples.created.length === 2,
      samples.failed.map((f) => ({ name: f.name, code: f.error?.code, detail: f.error?.detail })));
    check('アップロードは2件', uploads.length === 2, uploads.length);
    check('作成順序は README.md → サンプル.txt',
      uploads.map((r) => r.body.name).join(',') === 'README.md,サンプル.txt', uploads.map((r) => r.body.name));
    check('multipart で送る', uploads.every((r) => r.uploadType === 'multipart'));
    check('Content-Type が multipart/related', uploads.every((r) => r.contentType.startsWith('multipart/related')));
    check('メタデータは3項目だけ',
      uploads.every((r) => Object.keys(r.body).sort().join(',') === 'mimeType,name,parents'));
    check('親は 01_ナレッジ', uploads.every((r) => r.body.parents[0] === 'f-kn'));
    check('fields は要件どおり', uploads.every((r) => r.fields === 'id,name,mimeType,parents,webViewLink'));
    check('本文が入っている', uploads.every((r) => typeof r.content === 'string' && r.content.length > 50));
    check('検索テスト用の語を含む',
      uploads.some((r) => r.content.includes('テスト用キーワードあいうえお')));
    check('READMEのMIMEはMarkdown',
      uploads.find((r) => r.body.name === 'README.md').body.mimeType === 'text/markdown');
    check('作成には書き込みトークンを使う', uploads.every((r) => r.writeToken === true));
    check('Driveリンクを返す',
      samples.created.every((item) => item.file.webViewLink.startsWith('https://drive.google.com/')));
    check('Drive上に実体ができる', tree.has(samples.created[0].file.id));

    /* --- 既存ファイルがある場合は上書きしない --- */
    at = mark();
    await requestWriteToken();
    samples = await createSampleFiles({ folderId: 'f-kn' });
    discardWriteToken();
    uploads = from(at).filter((r) => r.isUpload);

    check('2回目はアップロードしない', uploads.length === 0, uploads.length);
    check('2回目は既存として扱う', samples.skipped.length === 2, samples.skipped.length);
    check('2回目も成功として返す', samples.ok === true);
    check('二重に作られていない',
      [...tree.values()].filter((n) => n.parent === 'f-kn' && n.name === 'README.md').length === 1);

    /* --- 片方だけ既にある --- */
    emptyKnowledge();
    tree.set('f-existing-readme', {
      id: 'f-existing-readme', parent: 'f-kn', name: 'README.md', mimeType: 'text/markdown',
      modifiedTime: '2026-01-01T00:00:00.000Z', version: '1', trashed: false,
      body: new TextEncoder().encode('利用者が先に置いた README です。').buffer,
      webViewLink: 'https://drive.google.com/file/d/f-existing-readme/view',
    });

    at = mark();
    await requestWriteToken();
    samples = await createSampleFiles({ folderId: 'f-kn' });
    discardWriteToken();
    uploads = from(at).filter((r) => r.isUpload);

    check('既にある方は作らない', uploads.length === 1 && uploads[0].body.name === 'サンプル.txt', uploads.map((r) => r.body.name));
    check('既存ファイルの中身を変えない',
      new TextDecoder().decode(tree.get('f-existing-readme').body).includes('利用者が先に置いた'));
    check('既存ファイルへのPUT/PATCHは無い', net.forbiddenWrites().length === 0);

    /* --- 失敗と再実行 --- */
    emptyKnowledge();
    at = mark();
    scenario.inject = (kind, info) => (kind === 'upload' && info?.body?.name === 'サンプル.txt'
      ? driveError(403, 'insufficientFilePermissions')
      : null);
    await requestWriteToken();
    samples = await createSampleFiles({ folderId: 'f-kn' });
    discardWriteToken();

    check('失敗した分を記録する', samples.failed.length === 1 && samples.ok === false);
    check('成功した分は残す', samples.created.length === 1 && samples.created[0].name === 'README.md');

    scenario.inject = undefined;
    at = mark();
    await requestWriteToken();
    samples = await createSampleFiles({ folderId: 'f-kn' });
    discardWriteToken();
    uploads = from(at).filter((r) => r.isUpload);

    check('再実行は残り1件だけ', uploads.length === 1 && uploads[0].body.name === 'サンプル.txt');
    check('再実行で完了する', samples.ok === true);
    check('README を作り直さない', samples.skipped.some((item) => item.name === 'README.md'));

    /* --- フォルダ未指定 --- */
    const noFolder = await createSampleFiles({});
    check('フォルダが無ければ実行しない', noFolder.error?.code === ErrorCode.SETUP_STEP_BLOCKED);

    /* --- 作ったサンプルを検索できる --- */
    emptyKnowledge();
    await requestWriteToken();
    await createSampleFiles({ folderId: 'f-kn' });
    discardWriteToken();

    await runSync({ folder: FOLDER });
    const sampleHit = await search('テスト用キーワードあいうえお');
    check('作成したサンプルを検索できる',
      sampleHit.hits.some((hit) => hit.fileName === 'サンプル.txt'), sampleHit.hits.map((h) => h.fileName));

    restoreTree();
    await clearAllCache({ keepSettings: true });
    await clearIndex();

    /* ============================================================ */
    section('21-4. セットアップ状態の保存');

    const fresh = await getSetupState();
    check('初回は未完了', fresh.completed === false);
    check('初回は進捗が空', Object.values(fresh.progress).every((v) => v === false));

    await setSetupState(makeSetupRecord({ signIn: true, folder: true }, { completed: false }));
    const midway = await getSetupState();
    check('途中経過を保存できる', midway.progress.signIn === true && midway.progress.folder === true);
    check('保存しても未完了のまま', midway.completed === false);

    await setSetupState(makeSetupRecord(midway.progress, { completed: true }));
    const completed = await getSetupState();
    check('完了を保存できる', completed.completed === true);
    check('完了時刻が入る', typeof completed.completedAt === 'string' && completed.completedAt.length > 0);

    const setupDump = JSON.stringify(await db.settings.toArray());
    check('保存値にトークンが無い', !setupDump.includes('fake-token') && !setupDump.includes('fake-write-token'));
    check('保存値に本文が入らない', !setupDump.includes('テスト用キーワード'));

    /* 全キャッシュ削除では消えない（設定領域のため）。 */
    await clearAllCache({ keepSettings: true });
    check('キャッシュ削除後も完了状態が残る', (await getSetupState()).completed === true);

    /* 再実行のために初期化できる。 */
    await setSetupState(makeSetupRecord(createProgress(), { completed: false }));
    check('再実行のため初期化できる', (await getSetupState()).completed === false);

    /* --- 書き込み経路の総括 --- */
    check('非GETは POST だけ', net.nonGet().every((r) => r.method === 'POST'));
    check('非GETの宛先は2種類だけ',
      net.nonGet().every((r) => r.path === '/drive/v3/files' || r.path === '/upload/drive/v3/files'),
      [...new Set(net.nonGet().map((r) => r.path))]);
    check('フォルダ作成はフォルダのMIMEだけ',
      net.creates().every((r) => r.body?.mimeType === MIMES.FOLDER));
    check('アップロードはサンプル2種類だけ',
      net.uploads().every((r) => ['README.md', 'サンプル.txt'].includes(r.body?.name)),
      [...new Set(net.uploads().map((r) => r.body?.name))]);
    check('PUT/PATCH/DELETE は最後まで0件', net.forbiddenWrites().length === 0);

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

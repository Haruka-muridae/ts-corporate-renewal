/* apps/shared の検証。ネットワークもDOMも使わない。 */

import { check, section, finish, fatal } from '../helpers/assert.mjs';
import { sharedUrl } from '../helpers/env.mjs';

/* 絶対パスを書かない。リポジトリのどこへ置いても動くようにする。 */
const url = (name) => sharedUrl(name);


section("1. モジュールグラフの読み込み（循環import含む）");
const shared = await import(url('bootstrap.js'));
check('bootstrap.js が読める', typeof shared === 'object');
check('SHARED_VERSION', shared.SHARED_VERSION === '2.0.0-phase2', shared.SHARED_VERSION);

for (const ns of ['driveAuth', 'driveFiles', 'profileStore', 'aiConfig', 'aiClient']) {
  check(`名前空間 ${ns}`, typeof shared[ns] === 'object' && shared[ns] !== null);
}

for (const fn of ['ensureAccessToken', 'withAccessToken', 'loadProfileFromDrive',
  'saveProfileToDrive', 'runAiTask', 'setApiKey', 'getSharedContext', 'startShared']) {
  check(`関数 ${fn}`, typeof shared[fn] === 'function');
}

section("2. providers の循環import（TDZ）が起きないこと");
const local = await import(url('providers/local.js'));
const gemini = await import(url('providers/gemini.js'));
check('local.CAPABILITIES が評価済み', local.CAPABILITIES.summarize === false);
check('gemini.CAPABILITIES が評価済み', gemini.CAPABILITIES.answer === false);
check('local.PROVIDER_ID', local.PROVIDER_ID === 'local');
check('gemini エンドポイント定数', gemini.GEMINI_API_ORIGIN === 'https://generativelanguage.googleapis.com');

section("3. drive-auth のスコープ正規化");
const { normalizeScope, DRIVE_FILE_SCOPE } = shared.driveAuth;
check('既定は drive.file', normalizeScope() === DRIVE_FILE_SCOPE);
check('配列→文字列', normalizeScope(['b', 'a']) === 'a b');
check('重複除去＋整列', normalizeScope('b a b') === 'a b');
check('空白のみは空文字', normalizeScope('   ') === '');

section("4. drive-files の純関数");
const df = shared.driveFiles;
check(
  'フォルダクエリに4条件',
  df.buildFolderQuery('TSAM AI', null)
    === "name='TSAM AI' and mimeType='application/vnd.google-apps.folder' and trashed=false and 'root' in parents",
  df.buildFolderQuery('TSAM AI', null),
);
check("クエリの ' をエスケープ", df.escapeQueryValue("a'b") === "a\\'b");
check('401→UNAUTHORIZED', df.mapHttpErrorToCode(401, null) === 'UNAUTHORIZED');
check('429→RATE_LIMITED', df.mapHttpErrorToCode(429, null) === 'RATE_LIMITED');
check('403 quota→QUOTA_EXCEEDED',
  df.mapHttpErrorToCode(403, { error: { errors: [{ reason: 'storageQuotaExceeded' }] } }) === 'QUOTA_EXCEEDED');
check('503→SERVER_ERROR', df.mapHttpErrorToCode(503, null) === 'SERVER_ERROR');
check('isUnauthorized', df.isUnauthorized({ status: 401 }) === true && df.isUnauthorized({ status: 404 }) === false);
check('パス表示', df.formatPath(['TSAM AI', 'マイページ']) === 'マイドライブ / TSAM AI / マイページ');
check('DRIVE_PATHS.ROOT が既存アプリと一致', df.DRIVE_PATHS.ROOT === 'TSAM AI');

section("5. profile-store の検証");
const ps = shared.profileStore;
const bad = ps.sanitizeProfileValues({ displayName: '', note: 'x'.repeat(600), email: 'notanemail' });
check('必須未入力を検出', Boolean(bad.errors.displayName));
check('文字数超過を検出', Boolean(bad.errors.note));
check('メール形式を検出', Boolean(bad.errors.email));
check('hasValidationErrors', ps.hasValidationErrors(bad.errors) === true);

const good = ps.sanitizeProfileValues({
  displayName: '  山田 太郎  ',
  company: '株式会社テスト',
  unknownField: '捨てられるはず',
});
check('前後空白を除去', good.values.displayName === '山田 太郎');
check('未知のキーを捨てる', good.values.unknownField === undefined);
check('検証通過', ps.hasValidationErrors(good.errors) === false);

const ctrl = ps.sanitizeProfileValues({ displayName: 'a\u0000b\tc' });
check('制御文字を除去', ctrl.values.displayName === 'abc', ctrl.values.displayName);

const doc = ps.buildProfileDocument(good.values, { sub: 'sub-123' });
check('ドキュメントのバージョン', doc.v === 1);
check('sub を保持', doc.sub === 'sub-123');
const round = ps.parseProfileDocument(JSON.parse(JSON.stringify(doc)));
check('往復で一致', round.profile.displayName === '山田 太郎');
check('バージョン違いは null', ps.parseProfileDocument({ ...doc, v: 99 }) === null);
check('壊れた入力は null', ps.parseProfileDocument('文字列') === null);
check('概要は summary:true のみ',
  ps.getProfileSummary(doc).map((i) => i.key).join(',') === 'displayName,company',
  ps.getProfileSummary(doc).map((i) => i.key).join(','));
check('保存先の説明',
  ps.describeProfileLocation() === 'マイドライブ / TSAM AI / マイページ / profile.json',
  ps.describeProfileLocation());
check('APIキー項目が存在しない',
  ps.PROFILE_FIELDS.every((f) => !/key|token|secret|password/i.test(f.key)));

section("6. ai-config の検証");
const ac = shared.aiConfig;
check('既定モードは free', ac.getAiMode() === 'free');
check('不正モードを拒否', ac.setAiMode('bogus') === false);
check('キー形式OK', ac.validateApiKey(`AIza${'a'.repeat(35)}`).ok === true);
check('キー形式NG（接頭辞）', ac.validateApiKey(`XXXX${'a'.repeat(35)}`).ok === false);
check('キー形式NG（空）', ac.validateApiKey('').ok === false);
check('キー形式NG（長すぎ）', ac.validateApiKey(`AIza${'a'.repeat(300)}`).ok === false);
const masked = ac.maskApiKey(`AIza${'a'.repeat(31)}wxyz`);
check('マスクは末尾4文字のみ', masked.endsWith('wxyz') && !masked.includes('AIza'), masked);
check('設定要約にキー実値が無い', !Object.prototype.hasOwnProperty.call(ac.getAiConfig(), 'apiKey'));
check('storage 無しでも落ちない', ac.hasApiKey() === false);

section("7. ai-client が Phase 1 で NOT_IMPLEMENTED を返すこと");
const acl = shared.aiClient;
const readyFree = acl.checkReady({ task: acl.AI_TASK.SUMMARIZE, mode: 'free' });
check('free は未対応', readyFree.ok === false && readyFree.code === 'TASK_UNSUPPORTED', JSON.stringify(readyFree));
const readyBogus = acl.checkReady({ mode: 'bogus' });
check('未知モードは MODE_UNSUPPORTED', readyBogus.code === 'MODE_UNSUPPORTED');
check('listModes が2件', acl.listModes().length === 2);
check('listModes は全て利用不可', acl.listModes().every((m) => m.available === false));

let thrown = null;
try {
  await acl.runAiTask({ task: 'summarize', input: 'テスト' });
} catch (error) {
  thrown = error;
}
check('runAiTask が AiError を投げる', thrown?.name === 'AiError', String(thrown));
check('code は TASK_UNSUPPORTED', thrown?.code === 'TASK_UNSUPPORTED', thrown?.code);

let inputError = null;
try {
  await acl.runAiTask({ task: 'summarize', input: '   ' });
} catch (error) {
  inputError = error;
}
check('空入力は INVALID_INPUT', inputError?.code === 'INVALID_INPUT');

let providerError = null;
try {
  await local.run({ task: 'summarize', input: 'x' });
} catch (error) {
  providerError = error;
}
check('provider.run は NOT_IMPLEMENTED', providerError?.code === 'NOT_IMPLEMENTED');

section("8. Drive 通信の組み立て（fetch をモック）");

/* Drive を模した最小のサーバー。フォルダとファイルをメモリに持つ。 */
function createFakeDrive() {
  const items = new Map();
  let seq = 0;
  const calls = [];

  async function fetchImpl(url, init) {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    calls.push(`${method} ${u.pathname}`);

    if (init.headers.Authorization !== 'Bearer test-token') {
      return new Response('{}', { status: 401 });
    }

    /* 検索 */
    if (method === 'GET' && u.pathname.endsWith('/drive/v3/files') && u.searchParams.has('q')) {
      const q = u.searchParams.get('q');
      const name = /name='([^']*)'/.exec(q)?.[1];
      const parent = /'([^']*)' in parents/.exec(q)?.[1];
      const wantFolder = q.includes("mimeType='application/vnd.google-apps.folder'");
      const files = [...items.values()].filter((it) => it.name === name
        && it.parent === parent
        && (wantFolder ? it.isFolder : !it.isFolder));
      return Response.json({ files });
    }

    /* 本体取得 */
    if (method === 'GET' && u.searchParams.get('alt') === 'media') {
      const id = decodeURIComponent(u.pathname.split('/').pop());
      return new Response(items.get(id).content, { status: 200 });
    }

    /* multipart 新規作成（/upload/ の判定を先に行う。パス末尾は同じため） */
    if (method === 'POST' && u.pathname.startsWith('/upload/')) {
      const text = await new Response(init.body).text();
      const parts = text.split('\r\n\r\n');
      const meta = JSON.parse(parts[1].split('\r\n')[0]);
      const content = parts.slice(3).join('\r\n\r\n').split('\r\n--')[0];
      seq += 1;
      const id = `id-${seq}`;
      items.set(id, {
        id, name: meta.name, parent: meta.parents?.[0] ?? 'root', isFolder: false, content,
      });
      return Response.json({ id, name: meta.name, size: String(content.length) });
    }

    /* フォルダ作成 */
    if (method === 'POST' && u.pathname.endsWith('/drive/v3/files')) {
      const meta = JSON.parse(init.body);
      seq += 1;
      const id = `id-${seq}`;
      items.set(id, { id, name: meta.name, parent: meta.parents?.[0] ?? 'root', isFolder: true });
      return Response.json({ id, name: meta.name });
    }

    /* 中身の差し替え */
    if (method === 'PATCH') {
      const id = decodeURIComponent(u.pathname.split('/').pop());
      const content = await new Response(init.body).text();
      items.get(id).content = content;
      return Response.json({ id, name: items.get(id).name, size: String(content.length) });
    }

    return new Response('{}', { status: 404 });
  }

  return { fetchImpl, items, calls };
}

const drive = createFakeDrive();
const token = 'test-token';

const folderId = await df.ensureFolderPath(['TSAM AI', 'マイページ'], { token, fetchImpl: drive.fetchImpl });
check('2階層を作成', typeof folderId === 'string');
check('TSAM AI が root 直下', [...drive.items.values()].some((i) => i.name === 'TSAM AI' && i.parent === 'root'));
check('マイページが TSAM AI 配下',
  [...drive.items.values()].some((i) => i.name === 'マイページ' && i.parent !== 'root'));

const again = await df.ensureFolderPath(['TSAM AI', 'マイページ'], { token, fetchImpl: drive.fetchImpl });
check('2回目は再利用して二重作成しない', again === folderId
  && [...drive.items.values()].filter((i) => i.isFolder).length === 2);

const write1 = await df.writeJsonFile({
  token, name: 'profile.json', parentId: folderId, data: doc, fetchImpl: drive.fetchImpl,
});
check('新規作成（created:true）', write1.created === true);

const read1 = await df.readJsonFile({
  token, name: 'profile.json', parentId: folderId, fetchImpl: drive.fetchImpl,
});
check('書いた内容を読み戻せる', read1.data.profile.displayName === '山田 太郎', JSON.stringify(read1?.data));

const write2 = await df.writeJsonFile({
  token,
  name: 'profile.json',
  parentId: folderId,
  data: { ...doc, profile: { ...doc.profile, displayName: '更新後' } },
  fetchImpl: drive.fetchImpl,
});
check('2回目は更新（created:false）', write2.created === false);
check('PATCH を使っている', drive.calls.some((c) => c.startsWith('PATCH')));
check('ファイルが増えていない', [...drive.items.values()].filter((i) => !i.isFolder).length === 1);

const read2 = await df.readJsonFile({
  token, name: 'profile.json', parentId: folderId, fetchImpl: drive.fetchImpl,
});
check('更新が反映されている', read2.data.profile.displayName === '更新後');

const missing = await df.readJsonFile({
  token, name: 'notfound.json', parentId: folderId, fetchImpl: drive.fetchImpl,
});
check('未登録は null（例外にしない）', missing === null);

let authError = null;
try {
  await df.findFolder('TSAM AI', null, { token: 'wrong', fetchImpl: drive.fetchImpl });
} catch (error) {
  authError = error;
}
check('401 は DriveError(UNAUTHORIZED)',
  authError?.name === 'DriveError' && authError.code === 'UNAUTHORIZED');
check('isUnauthorized が拾える', df.isUnauthorized(authError) === true);

check('トークンがURLに載っていない', drive.calls.every((c) => !c.includes('test-token')));

section("9. withAccessToken の401リトライ");
const { withAccessToken } = shared.driveAuth;
let attempts = 0;
let retryResult = null;
let retryError = null;
try {
  retryResult = await withAccessToken(
    async () => {
      attempts += 1;
      const e = new Error('x');
      e.status = 401;
      throw e;
    },
    { shouldReauth: df.isUnauthorized },
  );
} catch (error) {
  retryError = error;
}
/* Node には document が無いため GIS を読み込めず、run へ到達しない。 */
check('トークン取得前に run を呼ばない', attempts === 0, `attempts=${attempts}`);
check('DriveAuthError(GIS_LOAD_FAILED) になる',
  retryError?.name === 'DriveAuthError' && retryError.code === 'GIS_LOAD_FAILED',
  `${retryError?.name}/${retryError?.code}`);
check('retryResult は未設定', retryResult === null);

/*
 * 外部リンクの正本。
 *
 * ここでは値と検査だけを確かめる。
 * **実際にURLを開かない。** 紹介プログラム側へ、
 * テストのたびに通信を発生させないため。
 */
section("外部リンク（shared/external-links.js）");
const links = await import(url('external-links.js'));

check('Googleアカウント作成URL',
  links.GOOGLE_ACCOUNT_CREATE_URL === 'https://accounts.google.com/signup',
  links.GOOGLE_ACCOUNT_CREATE_URL);
check('Workspace紹介URL',
  links.GOOGLE_WORKSPACE_REFERRAL_URL === 'https://referworkspace.app.goo.gl/2KTq',
  links.GOOGLE_WORKSPACE_REFERRAL_URL);

for (const [name, value] of [
  ['アカウント作成', links.GOOGLE_ACCOUNT_CREATE_URL],
  ['Workspace紹介', links.GOOGLE_WORKSPACE_REFERRAL_URL],
]) {
  check(`${name}: HTTPS`, new URL(value).protocol === 'https:');
  check(`${name}: 許可ドメイン`, links.isAllowedExternalUrl(value) === true);
}

/* 紹介URLはクエリを持たない短縮URL。落とすべきクエリが無いことを確認する。 */
check('紹介URLのクエリを削っていない',
  new URL(links.GOOGLE_WORKSPACE_REFERRAL_URL).search === '');

section("外部リンクの検査（isAllowedExternalUrl）");
check('http は拒否', links.isAllowedExternalUrl('http://accounts.google.com/signup') === false);
check('未知のホストは拒否', links.isAllowedExternalUrl('https://evil.example/signup') === false);
/* endsWith 判定だと通ってしまう形。完全一致でなければならない。 */
check('★接尾辞が一致するだけの偽ホストを拒否',
  links.isAllowedExternalUrl('https://evil-accounts.google.com.attacker.test/') === false);
check('サブドメイン偽装を拒否',
  links.isAllowedExternalUrl('https://accounts.google.com.attacker.test/') === false);
check('javascript: を拒否', links.isAllowedExternalUrl('javascript:alert(1)') === false);
check('data: を拒否', links.isAllowedExternalUrl('data:text/html,x') === false);
check('空文字を拒否', links.isAllowedExternalUrl('') === false);
check('前後空白を拒否', links.isAllowedExternalUrl(' https://accounts.google.com/signup ') === false);
check('文字列以外を拒否', links.isAllowedExternalUrl(null) === false);
check('workspace.google.com は許可（転送先）',
  links.isAllowedExternalUrl('https://workspace.google.com/pricing') === true);

section("外部リンクの文言");
const byId = Object.fromEntries(links.ACCOUNT_LINKS.map((item) => [item.id, item]));
check('2件ある', links.ACCOUNT_LINKS.length === 2, String(links.ACCOUNT_LINKS.length));

const personal = byId['google-account'];
const workspace = byId['workspace-referral'];

check('通常アカウント側に「無料」がある', personal.lead.includes('無料'));
check('★Workspace側に「無料」が無い',
  !`${workspace.lead}${workspace.note}${workspace.label}`.includes('無料'),
  workspace.note);
check('Workspace: 紹介プログラムと明記', workspace.note.includes('紹介プログラム'));
check('Workspace: 有料と明記', workspace.note.includes('有料'));
check('Workspace: Google LLC 提供と明記', workspace.note.includes('Google LLC'));
check('通常アカウント: 外部サイトと明記', personal.note.includes('外部サイト'));

/* 正本が凍結されていること（実行時に書き換えられない）。 */
check('ACCOUNT_LINKS が凍結', Object.isFrozen(links.ACCOUNT_LINKS));
check('各項目が凍結', links.ACCOUNT_LINKS.every((item) => Object.isFrozen(item)));
check('ALLOWED_HOSTS が凍結', Object.isFrozen(links.ALLOWED_HOSTS));

finish();

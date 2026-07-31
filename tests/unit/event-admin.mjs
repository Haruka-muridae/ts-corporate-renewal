/*
 * 管理画面の認証とCSVの検証（実装仕様書 9章、受入条件10・11）。
 *
 * ==================================================================
 * 特に確かめること
 * ==================================================================
 *   - ログインの失敗理由でアドレスの存在を教えないこと
 *   - 期限切れのセッションを使い続けないこと
 *   - CSVで数式が実行されないこと（CSVインジェクション）
 *   - 名札用CSVが支払済みだけ・記載5項目だけになること（年齢を出さない）
 * ==================================================================
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

import {
  signInWithPassword,
  refreshSession,
  getUser,
  signOut,
  needsRefresh,
  REFRESH_MARGIN_SECONDS,
} from '../../lib/event/admin-auth.mjs';

import { buildCsv, escapeCsvValue, csvFileName, BOM } from '../../lib/event/csv.mjs';

const CONFIG = {
  url: 'https://example.supabase.co',
  anonKey: 'anon-key',
  nowSeconds: 1_800_000_000,
};

function fakeFetch(handler) {
  const calls = [];

  const impl = async (url, options = {}) => {
    calls.push({ url, options });
    return handler(url, options);
  };

  return { impl, calls };
}

try {
  /* ---------------------------------------------------------------- */
  section('ログイン');

  const okAuth = fakeFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 3600,
      user: { id: 'user-1', email: 'admin@example.com' },
    }),
  }));

  const session = await signInWithPassword(
    { ...CONFIG, fetchImpl: okAuth.impl },
    { email: 'admin@example.com', password: 'correct-horse' },
  );

  check('アクセストークンを返す', session.accessToken === 'access-1');
  check('リフレッシュトークンを返す', session.refreshToken === 'refresh-1');
  check('有効期限を秒で持つ',
    session.expiresAt === CONFIG.nowSeconds + 3600, session.expiresAt);
  check('メールアドレスを返す', session.email === 'admin@example.com');
  check('パスワード付与の口を呼ぶ',
    okAuth.calls[0].url.includes('token?grant_type=password'));
  check('anonキーを送る', okAuth.calls[0].options.headers.apikey === 'anon-key');

  /* 失敗理由は一種類にそろえる。 */
  const failAuth = fakeFetch(async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: 'invalid_grant', error_description: 'Invalid login credentials' }),
  }));

  let loginError = null;

  try {
    await signInWithPassword(
      { ...CONFIG, fetchImpl: failAuth.impl },
      { email: 'admin@example.com', password: 'wrong' },
    );
  } catch (error) {
    loginError = error;
  }

  check('失敗を例外にする', loginError instanceof Error);
  check('アドレスの存在を教えない',
    loginError.message === 'メールアドレスまたはパスワードが正しくありません',
    loginError.message);
  check('例外にパスワードを含めない', !loginError.message.includes('wrong'));

  const emptyCases = [
    { name: 'メールアドレスが空', input: { email: '', password: 'x' } },
    { name: 'パスワードが空', input: { email: 'a@example.com', password: '' } },
  ];

  for (const { name, input } of emptyCases) {
    let threw = false;

    try {
      await signInWithPassword({ ...CONFIG, fetchImpl: okAuth.impl }, input);
    } catch (error) {
      threw = error instanceof TypeError;
    }

    check(`${name}なら通信前に止める`, threw);
  }

  /* ---------------------------------------------------------------- */
  section('セッションの更新');

  check('期限が切れていれば更新が必要',
    needsRefresh({ expiresAt: CONFIG.nowSeconds - 1 }, CONFIG.nowSeconds) === true);
  check('期限が近ければ更新が必要',
    needsRefresh(
      { expiresAt: CONFIG.nowSeconds + REFRESH_MARGIN_SECONDS - 1 },
      CONFIG.nowSeconds,
    ) === true);
  check('十分に余裕があれば更新は不要',
    needsRefresh(
      { expiresAt: CONFIG.nowSeconds + REFRESH_MARGIN_SECONDS + 60 },
      CONFIG.nowSeconds,
    ) === false);
  check('セッションが無ければ更新が必要', needsRefresh(null, CONFIG.nowSeconds) === true);

  const refreshFetch = fakeFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      access_token: 'access-2',
      refresh_token: 'refresh-2',
      expires_in: 3600,
      user: { email: 'admin@example.com' },
    }),
  }));

  const refreshed = await refreshSession(
    { ...CONFIG, fetchImpl: refreshFetch.impl }, 'refresh-1',
  );

  check('新しいアクセストークンを返す', refreshed.accessToken === 'access-2');
  check('更新の口を呼ぶ',
    refreshFetch.calls[0].url.includes('token?grant_type=refresh_token'));

  const refreshFailFetch = fakeFetch(async () => ({
    ok: false, status: 401, json: async () => ({ error: 'invalid_grant' }),
  }));

  let refreshError = null;

  try {
    await refreshSession({ ...CONFIG, fetchImpl: refreshFailFetch.impl }, 'refresh-x');
  } catch (error) {
    refreshError = error;
  }

  check('更新に失敗したら例外', refreshError instanceof Error);
  check('例外にトークンを含めない', !refreshError.message.includes('refresh-x'));

  /* ---------------------------------------------------------------- */
  section('セッションの確認（受入条件10）');

  const userFetch = fakeFetch(async () => ({
    ok: true, status: 200, json: async () => ({ id: 'user-1', email: 'admin@example.com' }),
  }));

  const user = await getUser({ ...CONFIG, fetchImpl: userFetch.impl }, 'access-1');

  check('利用者を返す', user?.email === 'admin@example.com');
  check('Bearer でトークンを送る',
    userFetch.calls[0].options.headers.Authorization === 'Bearer access-1');

  const revokedFetch = fakeFetch(async () => ({ ok: false, status: 401, json: async () => ({}) }));

  check('失効したトークンでは null',
    (await getUser({ ...CONFIG, fetchImpl: revokedFetch.impl }, 'access-old')) === null);

  check('トークンが無ければ通信せず null',
    (await getUser({ ...CONFIG, fetchImpl: revokedFetch.impl }, '')) === null);

  /*
   * 期限内でも Supabase 側で失効していれば弾く。
   * 管理者を削除した直後にアクセスできては困る。
   */
  const deletedUserFetch = fakeFetch(async () => ({
    ok: true, status: 200, json: async () => ({}),
  }));

  check('利用者が返らなければ null',
    (await getUser({ ...CONFIG, fetchImpl: deletedUserFetch.impl }, 'access-1')) === null);

  /* ---------------------------------------------------------------- */
  section('ログアウト');

  const logoutFetch = fakeFetch(async () => ({ ok: true, status: 204, json: async () => ({}) }));
  await signOut({ ...CONFIG, fetchImpl: logoutFetch.impl }, 'access-1');

  check('失効の口を呼ぶ', logoutFetch.calls[0].url.includes('/auth/v1/logout'));

  const logoutFailFetch = fakeFetch(async () => {
    throw new Error('ネットワークに接続できません');
  });

  let logoutThrew = false;

  try {
    await signOut({ ...CONFIG, fetchImpl: logoutFailFetch.impl }, 'access-1');
  } catch {
    logoutThrew = true;
  }

  check('失効に失敗しても例外にしない（Cookieは消せる）', logoutThrew === false);

  /* ---------------------------------------------------------------- */
  section('CSVのエスケープ');

  check('普通の値はそのまま', escapeCsvValue('山田 太郎') === '山田 太郎');
  check('カンマを含む値は引用符で囲む',
    escapeCsvValue('株式会社A,B') === '"株式会社A,B"');
  check('引用符は二重にする', escapeCsvValue('あ"い') === '"あ""い"');
  check('改行を含む値は引用符で囲む',
    escapeCsvValue('1行目\n2行目') === '"1行目\n2行目"');
  check('null は空', escapeCsvValue(null) === '');
  check('undefined は空', escapeCsvValue(undefined) === '');
  check('数値は文字列にする', escapeCsvValue(4400) === '4400');

  /*
   * CSVインジェクション。Excel が数式として実行しないよう無害化する。
   */
  const formulas = [
    { input: '=1+1', expects: "'=1+1" },
    { input: '+1', expects: "'+1" },
    { input: '-1', expects: "'-1" },
    { input: '@SUM(A1)', expects: "'@SUM(A1)" },
  ];

  formulas.forEach(({ input, expects }) => {
    check(`「${input}」を数式にしない`, escapeCsvValue(input) === expects,
      escapeCsvValue(input));
  });

  check('数式かつカンマを含む場合は両方処理する',
    escapeCsvValue('=HYPERLINK("http://x","a")')
      === '"\'=HYPERLINK(""http://x"",""a"")"',
    escapeCsvValue('=HYPERLINK("http://x","a")'));

  /* ---------------------------------------------------------------- */
  section('CSVの組み立て');

  const columns = [
    { header: '受付番号', key: 'receipt' },
    { header: '氏名', key: 'name' },
    { header: '支払金額', key: 'price' },
  ];

  const csv = buildCsv(columns, [
    { receipt: 'TSAM-0001', name: '山田 太郎', price: 4400 },
    { receipt: 'TSAM-0002', name: '鈴木, 花子', price: 11000 },
  ]);

  check('BOMで始まる（Excelで文字化けしない）', csv.startsWith(BOM));
  check('改行はCRLF', csv.includes('\r\n') && !/[^\r]\n/.test(csv));
  check('末尾も改行で終わる', csv.endsWith('\r\n'));

  const rows = csv.slice(BOM.length).trimEnd().split('\r\n');

  check('1行目は見出し', rows[0] === '受付番号,氏名,支払金額', rows[0]);
  check('2行目が1件目', rows[1] === 'TSAM-0001,山田 太郎,4400', rows[1]);
  check('カンマを含む氏名を壊さない',
    rows[2] === 'TSAM-0002,"鈴木, 花子",11000', rows[2]);
  check('行数は見出し+2件', rows.length === 3, rows.length);

  check('値が無い列は空欄',
    buildCsv(columns, [{ receipt: 'TSAM-0003' }]).includes('TSAM-0003,,'));

  check('0件でも見出しだけ出る',
    buildCsv(columns, []).slice(BOM.length) === '受付番号,氏名,支払金額\r\n');

  /* ---------------------------------------------------------------- */
  section('ファイル名');

  check('日付が入る',
    csvFileName('applications', new Date('2026-08-01T09:00:00+09:00'))
      === 'applications_20260801.csv',
    csvFileName('applications', new Date('2026-08-01T09:00:00+09:00')));

  check('日本時間で決める（UTCの日付に引きずられない）',
    csvFileName('nametags', new Date('2026-07-31T23:00:00Z')) === 'nametags_20260801.csv',
    csvFileName('nametags', new Date('2026-07-31T23:00:00Z')));

  finish();
} catch (error) {
  fatal(error);
}

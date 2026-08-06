/*
 * E2E の共通処理。
 *
 * ------------------------------------------------------------------
 * ポータル認証をどう通すか
 * ------------------------------------------------------------------
 * 画面は guardPage()（public/auth/session.js）を通る。これは
 *   1. localStorage の `tsam-auth-session` からトークンを読む
 *   2. Apps Script の /exec へ verifySession を POST する
 *   3. data.user が返ったときだけ画面を描画する
 * という順序で、**サーバーの応答が根拠**である（ローカルの値だけでは通らない）。
 *
 * したがってテストでは 1 と 2 の両方を用意する。
 * 片方だけでは guardPage がログイン画面へ飛ばしてしまう。
 *
 * 本物の Apps Script は叩かない。叩けば本番のセッション表に行が増えるし、
 * ネットワークの都合でテストが落ちるようになる。
 * ------------------------------------------------------------------
 */

export const APP_PATH = '/production-app/voice-recorder/';

/* public/auth/config.js の sessionStorageKey と同じ値。 */
const SESSION_KEY = 'tsam-auth-session';

/* Apps Script Web アプリの URL 形（public/auth/config.js の apiUrl）。 */
const AUTH_API_PATTERN = '**/macros/s/**/exec*';

export const TEST_USER = Object.freeze({
  email: 'e2e@example.com',
  displayName: 'E2E テスト',
  role: 'member',
});

/*
 * 認証系の応答を差し替える。
 * verifySession 以外の action が来た場合も成功で返す（この画面は使わない）。
 */
export async function mockPortalAuth(page, { user = TEST_USER } = {}) {
  await page.route(AUTH_API_PATTERN, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ success: true, data: { user } }),
    });
  });
}

/*
 * ログイン済みの状態を作る。ページ読み込み前に走らせる必要がある。
 *
 * addInitScript の関数はブラウザ側へ直列化されて渡るため、この
 * モジュールのスコープ（SESSION_KEY など）は見えない。
 * 使う値は引数で渡すこと。
 */
export async function seedSession(page, token = 'e2e-session-token') {
  await page.addInitScript(({ key, value }) => {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* プライベートモード等。テストでは起きない。 */
    }
  }, { key: SESSION_KEY, value: token });
}

/*
 * 録音画面を開く。
 *
 * query には config.js のテスト用上書き（testMaxSeconds / testWarningSeconds）を渡す。
 * これは localhost でのみ有効で、本番オリジンでは無視される。
 */
export async function gotoRecorder(page, { query = {}, authenticated = true } = {}) {
  await mockPortalAuth(page);

  if (authenticated) {
    await seedSession(page);
  }

  const search = new URLSearchParams(query).toString();
  await page.goto(`${APP_PATH}${search === '' ? '' : `?${search}`}`);

  if (authenticated) {
    /* guardPage() が利用者を返すまで main は hidden のまま。 */
    await page.locator('#vr-main').waitFor({ state: 'visible' });
  }
}

/*
 * OPFS の recordings 配下にあるファイル名の一覧。
 *
 * 一時ファイルの削除（§FR-05 / §FR-08）は estimate() の増減より
 * この一覧で見るほうが確実。estimate() は推定値で、粒度も粗い。
 */
export function listRecordings(page) {
  return page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('recordings', { create: false });
      const names = [];

      for await (const entry of dir.values()) {
        names.push(entry.name);
      }

      return names;
    } catch {
      /* ディレクトリ自体が無い＝一件も作られていない。 */
      return [];
    }
  });
}

/* OPFS の推定使用量（バイト）。逐次書き出しが効いているかの確認に使う。 */
export function storageUsage(page) {
  return page.evaluate(async () => {
    const estimate = await navigator.storage.estimate();
    return typeof estimate.usage === 'number' ? estimate.usage : 0;
  });
}

/* 経過時間表示（hh:mm:ss）を秒に直す。 */
export function parseDuration(text) {
  const parts = String(text).trim().split(':').map(Number);

  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    return Number.NaN;
  }

  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

/*
 * 「N MB」「N KB」「N B」形式の表示をバイトへ戻す。
 * capabilities.js の formatBytes と対になる。
 */
export function parseBytes(text) {
  const match = /^([\d.]+)\s*(B|KB|MB|GB)$/.exec(String(text).trim());

  if (match === null) {
    return Number.NaN;
  }

  const scale = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
  return Number(match[1]) * scale[match[2]];
}

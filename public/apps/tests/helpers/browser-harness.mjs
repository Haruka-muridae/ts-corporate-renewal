/*
 * ブラウザテストの土台。
 *
 * 各ブラウザスイートはこれを使い、サーバーと Chrome の
 * 起動・後片付けを任せる。
 *
 *   import { withBrowser } from '../helpers/browser-harness.mjs';
 *
 *   await withBrowser(async ({ page, origin, subpathOrigin }) => {
 *     await page.goto(`${origin}/apps/login/`);
 *     ...
 *   });
 *
 * 例外が起きても finally で必ず片付ける。
 * ポートはスイートごとに変え、並行実行しても衝突しないようにする。
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startStaticServer } from './static-server.mjs';
import { launchChrome } from './chrome.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/*
 * 配信ルート（public/apps/tests/helpers から3つ上 = public/）。
 * 静的サーバーはここを `/` として配信する。本番の
 * https://tsam-ai.com/ が public/ を配信するのと同じ対応になる。
 */
export const SITE_ROOT = resolve(here, '../../..');

/* リポジトリのルート（public/ のさらに1つ上）。package.json などを読むときに使う。 */
export const REPO_ROOT = resolve(here, '../../../..');

/*
 * 配信ルートの外にあるテスト資材を、URL上だけ足す。
 * フィクスチャは公開物ではないため public/ には置かない。
 */
export const TEST_MOUNTS = {
  '/tests/': resolve(REPO_ROOT, 'tests'),
};

/*
 * スイートごとの既定ポート。
 * 環境変数で上書きできる（CI やポート衝突時のため）。
 */
export function resolvePorts(suiteIndex) {
  const httpBase = Number(process.env.TEST_PORT ?? 5311);
  const cdpBase = Number(process.env.TEST_CDP_PORT ?? 9411);

  return {
    http: httpBase + suiteIndex,
    cdp: cdpBase + suiteIndex,
  };
}

/*
 * サーバーと Chrome を用意して fn を実行する。
 *
 * fn には次が渡る。
 *   page          … CDP セッション（evaluate / goto / setViewport など）
 *   origin        … http://127.0.0.1:PORT           （独自ドメイン相当）
 *   subpathOrigin … http://127.0.0.1:PORT/<repo>    （プロジェクトPages相当）
 *   server        … notFound の記録を見たいとき用
 */
export async function withBrowser(fn, { suiteIndex = 0 } = {}) {
  const ports = resolvePorts(suiteIndex);

  let server = null;
  let page = null;

  try {
    server = await startStaticServer({ rootDir: SITE_ROOT, port: ports.http, mounts: TEST_MOUNTS });
    page = await launchChrome({ port: ports.cdp });

    return await fn({
      page,
      origin: server.origin,
      subpathOrigin: server.subpathOrigin,
      server,
    });
  } finally {
    /* 失敗しても必ず片付ける。片付け自体の失敗で結果を変えない。 */
    if (page) {
      await page.close().catch(() => {});
    }

    if (server) {
      await server.close().catch(() => {});
    }
  }
}

/*
 * withBrowser を使わず、上から順に書くスイート向けの起動口。
 *
 * try / finally で全体を囲まなくても、Chrome は
 * helpers/chrome.mjs の終了フックが確実に kill する。
 * それでも通常経路では close() を呼ぶこと。
 *
 *   const { page, origin, subpathOrigin, close } = await startSuite(0);
 *   ...
 *   finish();
 *   await close();
 */
export async function startSuite(suiteIndex = 0) {
  const ports = resolvePorts(suiteIndex);

  const server = await startStaticServer({ rootDir: SITE_ROOT, port: ports.http, mounts: TEST_MOUNTS });

  let page;

  try {
    page = await launchChrome({ port: ports.cdp });
  } catch (error) {
    await server.close().catch(() => {});
    throw error;
  }

  return {
    page,
    origin: server.origin,
    subpathOrigin: server.subpathOrigin,
    server,
    close: async () => {
      await page.close().catch(() => {});
      await server.close().catch(() => {});
    },
  };
}

/*
 * ダミー認証でログインする（ブラウザ操作）。
 * Supabase 未設定の状態で使う共通手順。
 */
export async function dummyLogin(page, origin, {
  email = 'taro@example.com',
  password = 'password123',
  from = '/apps/login/',
} = {}) {
  await page.goto(`${origin}${from}`);
  await page.evaluate('localStorage.clear(); sessionStorage.clear();');
  await page.goto(`${origin}${from}`);

  await page.evaluate(`
    document.getElementById("login-id").value = ${JSON.stringify(email)};
    document.getElementById("login-password").value = ${JSON.stringify(password)};
    document.getElementById("login-form").requestSubmit();
  `);

  await page.sleep(1300);
}

/* 画面表示用の写しだけを偽造する（攻撃者の視点を再現する）。 */
export function forgeMirrorScript(overrides = {}) {
  const payload = {
    v: 2,
    userId: 'user-1',
    displayName: '偽装ユーザー',
    loginId: 'forged@example.com',
    provider: 'supabase',
    aal: 'aal1',
    emailConfirmed: true,
    ...overrides,
  };

  return `localStorage.setItem("tsam-ai-session", JSON.stringify({
    ...${JSON.stringify(payload)},
    issuedAt: Date.now(),
    expiresAt: Date.now() + 3600000
  }));`;
}

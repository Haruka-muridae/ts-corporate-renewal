/**
 * push-assistant — カレンダーの予定を Web Push で知らせ、タップで URL を開く。
 *
 * ==================================================================
 * サイト配信の Worker とは別サービスである
 * ==================================================================
 * リポジトリ直下の wrangler.jsonc は tsam-ai.com（OpenNext / Next.js）の
 * ものであり、こちらは workers/push-assistant/wrangler.jsonc を使う
 * **独立したサービス**（仕様書 §3-1）。デプロイも別に行う。
 *
 *   npm run deploy:push-assistant
 *
 * 同じホスト（tsam-ai.com）を共有できるのは、Cloudflare が
 * **パス Route を Custom Domain より先に評価する**ため。
 * `/push-assistant/*` だけがこの Worker に来て、他は従来どおり。
 * ==================================================================
 *
 * ==================================================================
 * run_worker_first の代償
 * ==================================================================
 * 静的ファイルも含めて**全リクエストがこの Worker を通る**。
 * 素直に assets へ流すだけの経路でも、ここを通らないと配信されない。
 * つまり **fetch が落ちると画面ごと出なくなる**。
 * だから下の fetch は、どの段階で失敗しても Response を返す形にしてある
 * （API の失敗は JSON、それ以外は素の 404/500）。
 *
 * run_worker_first を外すと assets が先に応答してしまい、
 * `/push-assistant/` の接頭辞を剥がせない（assets の中には
 * `/push-assistant/index.html` ではなく `/index.html` がある）。
 * ==================================================================
 */

import { MAX_USERS_PER_TICK } from './constants.mjs';
import { appUrl, basePath, required } from './config.mjs';
import { SECURITY_HEADERS, withSecurityHeaders } from './http.mjs';
import { handleApi, loadVapid } from './api.mjs';
import { importEncryptionKey } from './crypto-util.mjs';
import { createD1Store } from './store.mjs';
import { runTick } from './tick.mjs';

/**
 * ログの唯一の書き出し口。
 *
 * 形式を固定してあるのは `wrangler tail | grep` で追えるようにするため。
 * **detail に秘密を入れない**（tick.mjs の冒頭。呼び出し側の責任）。
 */
function log(level, code, detail = '') {
  const line = `push-assistant ${level} code=${code}${detail ? ` ${detail}` : ''}`;

  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

/**
 * 依存（store / fetch / 時計）を解決する。
 *
 * ------------------------------------------------------------------
 * テストからの差し替え口
 * ------------------------------------------------------------------
 * Workers の fetch ハンドラの引数は (request, env, ctx) で固定されており、
 * 依存を外から渡す隙間が env しか無い。そこで `__STORE` / `__FETCH` /
 * `__NOW_MS` を見る。
 *
 * **平文の環境変数（vars）で誤って有効化されることはない。**
 * vars は必ず文字列になるので、下の型検査（object / function / number）を
 * 通らない。加えて wrangler.jsonc にこれらの名前は無く、
 * `wrangler deploy` は設定に無い vars を Worker から削除する。
 * ------------------------------------------------------------------
 */
function resolveDeps(env) {
  const injectedStore = env?.__STORE;
  const injectedFetch = env?.__FETCH;
  const injectedNow = env?.__NOW_MS;

  return {
    store: (injectedStore && typeof injectedStore === 'object')
      ? injectedStore
      : (env?.DB ? createD1Store(env.DB) : null),
    fetchImpl: typeof injectedFetch === 'function' ? injectedFetch : fetch,
    nowMs: typeof injectedNow === 'number' ? injectedNow : Date.now(),
  };
}

const handler = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const base = safeBasePath(env);

    /*
     * 接頭辞を剥がす。
     *
     * 本番では Route（tsam-ai.com/push-assistant/*）に一致したものだけが
     * 来るので必ず接頭辞が付く。`wrangler dev` では
     * http://localhost:8787/api/health のように接頭辞無しでも叩けると
     * 便利なので、どちらも受ける。
     */
    let path = url.pathname;

    if (base !== '' && path === base) {
      /*
       * 末尾スラッシュ無し。本番では Route に一致せずメイン Worker が
       * 308 するので、ここへは来ない。dev と、Route の設定を変えたときの保険。
       */
      return new Response(null, {
        status: 308,
        headers: { Location: `${base}/`, ...SECURITY_HEADERS },
      });
    }

    if (base !== '' && path.startsWith(`${base}/`)) {
      path = path.slice(base.length);
    }

    if (path === '/api' || path.startsWith('/api/')) {
      const deps = resolveDeps(env);

      try {
        return await handleApi({
          request,
          url,
          path,
          env,
          store: deps.store,
          nowMs: deps.nowMs,
          fetchImpl: deps.fetchImpl,
          log,
        });
      } catch (error) {
        /* handleApi は自分で捕まえるが、その外（resolveDeps 等）の保険。 */
        log('error', 'FETCH_CRASHED', `name=${error?.name ?? 'Error'}`);

        return new Response(
          JSON.stringify({ ok: false, error: { code: 'SERVER_ERROR', message: 'サーバーでエラーが発生しました。' } }),
          {
            status: 500,
            headers: {
              'Content-Type': 'application/json;charset=UTF-8',
              'Cache-Control': 'no-store',
              ...SECURITY_HEADERS,
            },
          },
        );
      }
    }

    return serveAsset({ request, url, path, env });
  },

  /**
   * Cron（毎分）。
   *
   * `ctx.waitUntil` ではなく **await する。** waitUntil にすると
   * scheduled が即座に返り、Cloudflare 側のダッシュボードでは
   * 「成功」に見えるのに、実際の処理が途中で打ち切られうる。
   * 実行時間の上限（Cron は 15 分）に対して 1 tick は数秒なので、
   * 素直に待って、失敗を失敗として記録するほうがよい。
   */
  async scheduled(controller, env) {
    const deps = resolveDeps(env);

    if (!deps.store) {
      log('error', 'NOT_CONFIGURED', 'missing=DB');
      return;
    }

    try {
      await runTick({
        store: deps.store,
        vapid: await loadVapid(env),
        encryptionKey: await importEncryptionKey(required(env, 'TOKEN_ENCRYPTION_KEY')),
        clientId: required(env, 'GOOGLE_CLIENT_ID'),
        clientSecret: required(env, 'GOOGLE_CLIENT_SECRET'),
        appUrl: appUrl(env),
        nowMs: deps.nowMs,
        fetchImpl: deps.fetchImpl,
        log,
        maxUsers: MAX_USERS_PER_TICK,
      });
    } catch (error) {
      /*
       * ここへ来るのは設定漏れか store の障害。**通知は全員ぶん止まる**が、
       * 次の分にまた走る。何が足りないかを名前で残す（値は残さない）。
       */
      log('error', 'TICK_CRASHED', `name=${error?.name ?? 'Error'} missing=${error?.missing ?? '-'}`);
    }
  },
};

export default handler;

/**
 * 静的ファイルを返す。
 *
 * `ASSETS` の中は `/index.html`, `/app.js`, `/sw.js` のように
 * **接頭辞無し**で入っている。剥がした path をそのまま渡す。
 */
async function serveAsset({ request, url, path, env }) {
  if (!env?.ASSETS || typeof env.ASSETS.fetch !== 'function') {
    return new Response('Not Found', { status: 404, headers: SECURITY_HEADERS });
  }

  const target = new URL(path === '' ? '/' : path, url.origin);
  target.search = url.search;

  let response;

  try {
    response = await env.ASSETS.fetch(new Request(target, request));
  } catch {
    return new Response('Not Found', { status: 404, headers: SECURITY_HEADERS });
  }

  /*
   * assets が無ければ素の 404。**JSON にしない**（仕様書の指示）。
   * ここは人間がブラウザで見る経路であり、機械が読む API ではない。
   */
  if (response.status === 404) {
    return new Response('Not Found', { status: 404, headers: SECURITY_HEADERS });
  }

  return withSecurityHeaders(response, cacheHeadersFor(path));
}

/**
 * キャッシュの指示（仕様書 §10）。
 *
 * HTML と sw.js は `no-cache`。**Service Worker が古いまま残ると、
 * 通知の受け口が更新されない**（notificationclick の処理を直しても
 * 反映されない）。ブラウザは sw.js を最大 24 時間キャッシュしうるので、
 * ここで明示的に止める。
 *
 * それ以外（app.js / css）は assets 側の既定（ETag）に任せる。
 */
function cacheHeadersFor(path) {
  const isHtml = path === '' || path === '/' || path.endsWith('.html') || path.endsWith('/');
  const isServiceWorker = path.endsWith('/sw.js') || path === '/sw.js';

  return isHtml || isServiceWorker ? { 'Cache-Control': 'no-cache' } : {};
}

/**
 * base path を取る。**設定漏れでも例外を投げない。**
 *
 * ここで投げると画面が真っ白になる（run_worker_first のため
 * 静的ファイルもこの関数を通る）。既定値へ倒して、
 * 設定漏れは API 側で NOT_CONFIGURED として見せる。
 */
function safeBasePath(env) {
  try {
    return basePath(env);
  } catch {
    return '/push-assistant';
  }
}

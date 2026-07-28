/*
 * テスト用の静的配信サーバー。
 *
 * ------------------------------------------------------------------
 * GitHub Pages の2形態を1つのサーバーで再現する
 * ------------------------------------------------------------------
 *   http://127.0.0.1:PORT/apps/login/
 *     → 独自ドメイン配信（https://tsam-ai.com/apps/…）に相当
 *
 *   http://127.0.0.1:PORT/ts-corporate-renewal/apps/login/
 *     → プロジェクトPages配信（https://user.github.io/repo/apps/…）に相当
 *
 * 後者は先頭のリポジトリ名を取り除いてから同じファイルを返す。
 * シンボリックリンクやファイル複製を作らずにサブパスを検証できる。
 * ------------------------------------------------------------------
 *
 * 依存を増やさないため node:http のみを使う。
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, normalize } from 'node:path';

/* プロジェクトPages を模すときの先頭セグメント。 */
export const REPO_PREFIX = '/ts-corporate-renewal';

const MIME_BY_EXT = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2',
};

/*
 * サーバーを起動する。
 *
 * rootDir … 配信するディレクトリ（リポジトリのルート）
 * port    … 使用ポート
 *
 * 戻り値: { origin, close(), notFound }
 *   notFound … 404 になったパスの記録（リンク切れの検出に使う）
 */
export async function startStaticServer({ rootDir, port }) {
  const notFound = [];
  const base = normalize(resolve(rootDir));

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      let path = decodeURIComponent(url.pathname);

      /* プロジェクトPages を模した先頭セグメントを取り除く。 */
      if (path === REPO_PREFIX) {
        path = '/';
      } else if (path.startsWith(`${REPO_PREFIX}/`)) {
        path = path.slice(REPO_PREFIX.length);
      }

      if (path.endsWith('/')) {
        path += 'index.html';
      }

      const target = normalize(resolve(base, `.${path}`));

      /* 配信ディレクトリの外は返さない。 */
      if (!target.startsWith(base)) {
        res.writeHead(403).end('forbidden');
        return;
      }

      const info = await stat(target).catch(() => null);

      if (!info?.isFile()) {
        notFound.push(url.pathname);
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
        return;
      }

      const body = await readFile(target);

      res.writeHead(200, {
        'Content-Type': MIME_BY_EXT[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': body.length,
        /* テスト間で古い応答を引きずらない。 */
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });

  await new Promise((done, failed) => {
    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        failed(new Error(
          `ポート ${port} は使用中です。`
          + '前回のテストが残っている可能性があります。'
          + `\n  確認: netstat -ano | findstr :${port}`
          + '\n  別のポートを使う場合は環境変数 TEST_PORT を設定してください。',
        ));
        return;
      }
      failed(error);
    });

    server.listen(port, '127.0.0.1', () => done());
  });

  return {
    origin: `http://127.0.0.1:${port}`,
    /* プロジェクトPages 相当のベースURL。 */
    subpathOrigin: `http://127.0.0.1:${port}${REPO_PREFIX}`,
    notFound,
    close: () => new Promise((done) => {
      server.closeAllConnections?.();
      server.close(() => done());
    }),
  };
}

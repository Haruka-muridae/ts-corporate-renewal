/*
 * E2E 用の静的サーバー。
 *
 * 本番は Vercel が `public/` を静的ルートとして配る（CLAUDE.md「配信構成」）。
 * ここでも配信ルートを `public/` に合わせる。リポジトリのルートではない。
 *
 * 依存を足さないために自前で書いている（`serve` などを入れない）。
 * 必要なのは GET と正しい Content-Type だけで、それ以上の機能は要らない。
 *
 * OPFS と AudioWorklet は「安全なコンテキスト」を要求する。
 * http でも localhost は安全なコンテキストとして扱われるため、TLS は不要。
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../../../public', import.meta.url)));

const TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
}));

/*
 * URL のパスを `public/` 配下の実ファイルへ解決する。
 * `..` を含む経路で public の外へ出られないことを、正規化後の接頭辞で確認する。
 */
function resolvePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const candidate = resolve(join(ROOT, normalize(decoded)));

  if (candidate !== ROOT && !candidate.startsWith(ROOT + sep)) {
    return null;
  }

  return candidate;
}

async function findFile(path) {
  try {
    const info = await stat(path);

    if (info.isDirectory()) {
      const indexPath = join(path, 'index.html');
      const indexInfo = await stat(indexPath);
      return indexInfo.isFile() ? indexPath : null;
    }

    return info.isFile() ? path : null;
  } catch {
    return null;
  }
}

export function startStaticServer(port = 0) {
  const server = createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }

    const target = resolvePath(req.url ?? '/');
    const file = target === null ? null : await findFile(target);

    if (file === null) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': TYPES.get(extname(file).toLowerCase()) ?? 'application/octet-stream',
      /* 実装を直しながらテストを回すため、キャッシュさせない。 */
      'Cache-Control': 'no-store',
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    createReadStream(file).pipe(res);
  });

  return new Promise((resolvePromise) => {
    server.listen(port, '127.0.0.1', () => {
      resolvePromise({
        server,
        port: server.address().port,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/*
 * `node static-server.mjs [port]` で直接起動されたときだけ listen する。
 *
 * 判定に pathToFileURL を使うこと。Windows では import.meta.url が
 * `file:///C:/...`（スラッシュ3本）になるのに対し、argv[1] は `C:\...` なので、
 * 文字列を手で組み立てると必ず食い違う。実際にここで Playwright の
 * webServer が即終了した。
 */
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const port = Number(process.argv[2]) || 8000;
  startStaticServer(port).then(({ port: actual }) => {
    console.log(`static server: http://localhost:${actual}/ (root: ${ROOT})`);
  });
}

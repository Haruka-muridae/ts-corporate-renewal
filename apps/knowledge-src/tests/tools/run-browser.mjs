/*
 * ブラウザテストの実行役。
 *
 *   1. 対象ページを配信するサーバーを立てる
 *      - モード dev  : Vite 開発サーバー（tests/browser/ を実行）
 *      - モード dist : 本番ビルドを静的配信（apps/knowledge/ を検査）
 *   2. ヘッドレス Chrome を起動する
 *   3. CDP でページの結果を読み取る
 *
 * Playwright 等の大きな依存関係は増やさず、Chrome の DevTools Protocol を
 * WebSocket（Node 22+ の標準実装）で直接叩く。
 *
 * 使い方:
 *   node tests/tools/run-browser.mjs dev
 *   node tests/tools/run-browser.mjs dist
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const repoApps = resolve(root, '..');

const mode = process.argv[2] ?? 'dev';
const DEV_PORT = 5233;
const DIST_PORT = 5234;
const CDP_PORT = 9333;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA ?? ''}/Google/Chrome/Application/chrome.exe`,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));

if (!chromePath) {
  console.error('Chrome が見つかりません。CHROME_PATH を設定してください。');
  process.exit(1);
}

const MIME_BY_EXT = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.bcmap': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.pfb': 'application/octet-stream',
};

/* 本番配信物の検査用。GitHub Pages の深いサブパスを再現する。 */
function startStaticServer(port, baseDir, prefix, notFound = []) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      let path = decodeURIComponent(url.pathname);

      if (!path.startsWith(prefix)) {
        res.writeHead(404).end('not found');
        return;
      }

      path = path.slice(prefix.length) || '/';
      if (path.endsWith('/')) {
        path += 'index.html';
      }

      /* ディレクトリ外への参照を拒否する。 */
      const target = normalize(resolve(baseDir, `.${path}`));
      if (!target.startsWith(normalize(baseDir))) {
        res.writeHead(403).end('forbidden');
        return;
      }

      const info = await stat(target).catch(() => null);
      if (!info?.isFile()) {
        notFound.push(url.pathname);
        res.writeHead(404).end('not found');
        return;
      }

      const body = await readFile(target);
      res.writeHead(200, {
        'Content-Type': MIME_BY_EXT[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': body.length,
      });
      res.end(body);
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });

  return new Promise((done) => server.listen(port, '127.0.0.1', () => done(server)));
}

function waitFor(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((done, fail) => {
    const attempt = async () => {
      try {
        const response = await fetch(url);
        if (response.ok) {
          done();
          return;
        }
      } catch {
        /* まだ起動していない。 */
      }

      if (Date.now() > deadline) {
        fail(new Error(`起動しません: ${url}`));
        return;
      }

      setTimeout(attempt, 300);
    };

    attempt();
  });
}

/* ---- CDP ---- */

async function connect(urlFilter, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.includes(urlFilter));
      if (page) {
        return page;
      }
    } catch {
      /* Chrome の起動待ち。 */
    }

    if (Date.now() > deadline) {
      throw new Error('CDP へ接続できません');
    }

    await new Promise((r) => setTimeout(r, 300));
  }
}

async function runPage(pageUrl, urlFilter, { waitMs = 300000, expression } = {}) {
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-extensions',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${resolve(root, 'node_modules/.cache/chrome-test-profile')}`,
    pageUrl,
  ], { stdio: 'ignore' });

  const consoleLogs = [];

  try {
    const target = await connect(urlFilter);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const pending = new Map();
    let nextId = 0;

    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);

      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }

      if (message.method === 'Runtime.consoleAPICalled') {
        consoleLogs.push({
          level: message.params.type,
          text: message.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300),
        });
      }

      if (message.method === 'Runtime.exceptionThrown') {
        consoleLogs.push({
          level: 'exception',
          text: String(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text).slice(0, 300),
        });
      }

      if (message.method === 'Log.entryAdded') {
        consoleLogs.push({ level: message.params.entry.level, text: String(message.params.entry.text).slice(0, 300) });
      }
    });

    await new Promise((done, fail) => {
      ws.addEventListener('open', done);
      ws.addEventListener('error', fail);
    });

    const send = (method, params = {}) => {
      nextId += 1;
      const id = nextId;
      return new Promise((done) => {
        pending.set(id, done);
        ws.send(JSON.stringify({ id, method, params }));
      });
    };

    await send('Runtime.enable');
    await send('Log.enable');

    const evaluate = async (code, awaitPromise = false) => {
      const response = await send('Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise });

      /* プロトコル自体のエラー（式が長すぎる、対象が消えた等）。 */
      if (response.error) {
        return { error: `CDP: ${response.error.message ?? JSON.stringify(response.error)}` };
      }

      if (response.result?.exceptionDetails) {
        const details = response.result.exceptionDetails;
        return { error: details.exception?.description ?? details.text };
      }

      return { value: response.result?.result?.value };
    };

    /*
     * 接続直後は about:blank から対象URLへの遷移が終わっていないことがある。
     * その状態で評価すると「Execution context was destroyed」になるため、
     * 読み込み完了を待ってから式を流す。
     */
    const waitUntilLoaded = async (timeoutMs = 30000) => {
      const limit = Date.now() + timeoutMs;

      while (Date.now() < limit) {
        const state = await evaluate('document.readyState');
        if (state.value === 'complete') {
          return true;
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      return false;
    };

    if (expression) {
      await waitUntilLoaded();

      /*
       * ページ遷移と評価が重なると「Execution context was destroyed」になる。
       * 読み込み完了を待ってから、数回だけやり直す。
       */
      let custom = null;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        custom = await evaluate(expression, true);

        if (!String(custom.error ?? '').includes('context was destroyed')) {
          break;
        }

        await new Promise((r) => setTimeout(r, 800));
        await waitUntilLoaded();
      }

      ws.close();
      return { custom, consoleLogs };
    }

    await waitUntilLoaded();

    const deadline = Date.now() + waitMs;
    let title = '';

    while (Date.now() < deadline) {
      title = (await evaluate('document.title')).value ?? '';
      if (title === 'PASS' || title === 'FAIL') {
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    const output = (await evaluate("document.getElementById('out')?.textContent ?? ''")).value ?? '';
    ws.close();

    return { title, output, consoleLogs };
  } finally {
    chrome.kill();
  }
}

/* ---- 実行 ---- */

if (mode === 'dev' || mode === 'ui') {
  /* dev は統合テストとUIテストの両方、ui はUIテストだけを流す。 */
  const pages = mode === 'ui'
    ? [{ file: 'ui.html', label: 'UI' }]
    : [{ file: 'index.html', label: '統合' }, { file: 'ui.html', label: 'UI' }];

  const vite = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', '--port', String(DEV_PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });

  let bad = 0;

  try {
    for (const page of pages) {
      const url = `http://localhost:${DEV_PORT}/tests/browser/${page.file}`;
      await waitFor(url);
      const { title, output, consoleLogs } = await runPage(url, `tests/browser/${page.file}`);

      console.log(`\n########## ${page.label}テスト (${page.file}) ##########`);
      console.log(output);

      const unexpected = consoleLogs.filter((l) => (l.level === 'error' || l.level === 'exception')
        && !l.text.startsWith('[knowledge]'));

      if (unexpected.length > 0) {
        console.log('--- ブラウザの想定外ログ ---');
        unexpected.forEach((l) => console.log(`  [${l.level}] ${l.text}`));
      }

      console.log(`判定: ${title}`);

      if (title !== 'PASS' || unexpected.length > 0) {
        bad += 1;
      }
    }
  } finally {
    vite.kill();
  }

  process.exit(bad === 0 ? 0 : 1);
}

if (mode === 'dist') {
  const distDir = resolve(repoApps, 'knowledge');
  /* GitHub Pages のプロジェクトページを想定した深いサブパス。 */
  const prefix = '/myrepo/apps/knowledge';
  const notFound = [];
  const server = await startStaticServer(DIST_PORT, distDir, prefix, notFound);
  const pageUrl = `http://127.0.0.1:${DIST_PORT}${prefix}/index.html`;

  try {
    await waitFor(pageUrl);

    const expression = `
      (async () => {
        const out = { errors: [], rejections: [], requests: [] };
        window.addEventListener('unhandledrejection', (e) => out.rejections.push(String(e.reason)));

        const originalError = console.error;
        console.error = (...a) => { out.errors.push(a.map(String).join(' ')); originalError(...a); };

        const originalFetch = window.fetch;
        window.fetch = (input, init) => {
          const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
          out.requests.push({ url: String(url).slice(0, 160), method: (init && init.method) || 'GET' });
          return originalFetch(input, init);
        };

        /* 起動は非同期（DBを開いてから描画する）。画面が出るまで待つ。 */
        const deadline = Date.now() + 30000;
        while (document.querySelectorAll('.app-nav__button').length === 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200));
        }

        out.href = location.href;
        out.title = document.title;
        out.nav = Array.from(document.querySelectorAll('.app-nav__button')).map((b) => b.textContent);
        out.badges = Array.from(document.querySelectorAll('.state-badge')).map((b) => b.textContent);

        const nav = document.querySelectorAll('.app-nav__button');
        if (nav.length === 0) {
          return JSON.stringify({ ...out, bootFailed: true });
        }
        for (let i = 0; i < nav.length; i += 1) {
          nav[i].click();
          await new Promise((r) => setTimeout(r, 350));
        }
        out.settingsInputs = document.querySelectorAll('input[type=number]').length;
        out.diagButton = Array.from(document.querySelectorAll('button')).some((b) => b.textContent === '診断を実行');

        nav[0].click();
        await new Promise((r) => setTimeout(r, 300));

        out.absoluteRefs = Array.from(document.querySelectorAll('[src],[href]'))
          .map((e) => e.getAttribute('src') || e.getAttribute('href'))
          .filter((v) => v && v.startsWith('/'));

        const probe = async (path) => {
          try { return (await originalFetch(path)).status; } catch (e) { return String(e).slice(0, 60); }
        };
        out.assets = {
          cmap: await probe('./cmaps/90ms-RKSJ-H.bcmap'),
          ucs2: await probe('./cmaps/Adobe-Japan1-UCS2.bcmap'),
          font: await probe('./standard_fonts/LiberationSans-Regular.ttf'),
          favicon: await probe('./favicon.ico'),
          missing: await probe('./__does_not_exist__'),
        };

        // 本番CSP下で解析Workerを起動し、日本語PDFを抽出できるか
        out.workerProbe = await (async () => {
          const html = await (await originalFetch('./index.html')).text();
          const chunk = /assets\\/(index-[A-Za-z0-9_-]+\\.js)/.exec(html);
          if (!chunk) return 'chunk-not-found';
          const src = await (await originalFetch('./assets/' + chunk[1])).text();
          const parse = /(parse\\.worker-[A-Za-z0-9_-]+\\.js)/.exec(src);
          if (!parse) return 'parse-worker-not-found';
          const pdfBytes = Uint8Array.from(atob('JAPANESE_PDF_BASE64'), (c) => c.charCodeAt(0)).buffer;
          const base = new URL('./', location.href).href;
          return await new Promise((resolve) => {
            const w = new Worker('./assets/' + parse[1], { type: 'module' });
            const timer = setTimeout(() => { resolve('TIMEOUT'); w.terminate(); }, 60000);
            w.onmessage = (e) => {
              const d = e.data;
              if (!d || d.ns !== 'tsam-knowledge-rpc' || d.progress) return;
              clearTimeout(timer);
              resolve(d.ok ? { text: d.result.text, pages: d.result.stats.pageCount } : { error: d.error });
              w.terminate();
            };
            w.onerror = (e) => { clearTimeout(timer); resolve('WORKER_ERROR ' + (e.message || '')); };
            w.postMessage({ ns: 'tsam-knowledge-rpc', id: 1, type: 'parse', payload: {
              fileId: 'p', fileName: 'japanese.pdf', kind: 'pdf', buffer: pdfBytes, chunkOptions: {},
              pdfAssets: { cMapUrl: base + 'cmaps/', standardFontDataUrl: base + 'standard_fonts/' },
            } }, [pdfBytes]);
          });
        })();

        await new Promise((r) => setTimeout(r, 500));
        return JSON.stringify(out);
      })()
    `.replace('JAPANESE_PDF_BASE64', (await readFile(resolve(root, 'tests/fixtures/generated/japanese.pdf'))).toString('base64'));

    const { custom, consoleLogs } = await runPage(pageUrl, 'myrepo/apps/knowledge', { expression });

    if (custom.error || typeof custom.value !== 'string') {
      console.log('評価に失敗:', custom.error ?? `想定外の戻り値: ${JSON.stringify(custom.value)}`);
      console.log('--- ブラウザのログ ---');
      consoleLogs.slice(0, 20).forEach((l) => console.log(`  [${l.level}] ${l.text}`));
      server.close();
      await new Promise((r) => setTimeout(r, 300));
      process.exit(1);
    }

    const result = JSON.parse(custom.value);
    let failures = 0;
    const check = (name, condition, extra) => {
      if (condition) {
        console.log(`  ok   ${name}`);
      } else {
        failures += 1;
        console.log(`  NG   ${name} ${extra === undefined ? '' : JSON.stringify(extra).slice(0, 300)}`);
      }
    };

    console.log(`--- 本番配信物の検査（${prefix}/） ---`);
    check('起動できる', !result.bootFailed, result);
    check('深いサブパスで表示できる', result.nav.length === 6, result.nav);
    check('スコープを表示している', result.badges.some((b) => b.includes('drive.readonly')), result.badges);
    check('6画面すべて切り替えられる', result.settingsInputs === 7 && result.diagButton, { inputs: result.settingsInputs, diag: result.diagButton });
    check('絶対パス参照が無い', result.absoluteRefs.length === 0, result.absoluteRefs);
    check('CMapを取得できる', result.assets.cmap === 200, result.assets);
    check('CID用CMapを取得できる', result.assets.ucs2 === 200);
    check('標準フォントを取得できる', result.assets.font === 200);
    check('アイコンを取得できる', result.assets.favicon === 200);
    check('存在しないパスは404', result.assets.missing === 404, result.assets.missing);
    check('CSP下で日本語PDFを抽出できる', result.workerProbe?.text?.includes('日本語テスト'), result.workerProbe);
    check('起動時に外部通信をしない', result.requests.every((r) => !/googleapis|accounts\.google|apis\.google/.test(r.url)), result.requests);
    check('unhandled rejection 0件', result.rejections.length === 0, result.rejections);
    check('console.error 0件', result.errors.length === 0, result.errors);

    /* 意図的に叩いた存在しないパス以外で 404 が出ていないこと。 */
    const unexpected404 = notFound.filter((p) => !p.includes('__does_not_exist__'));
    check('想定外の404が無い', unexpected404.length === 0, unexpected404);

    const unexpected = consoleLogs.filter((l) => (l.level === 'error' || l.level === 'exception')
      && !l.text.startsWith('[knowledge]')
      && !l.text.includes('404'));
    check('ブラウザのエラーログ0件（404を除く）', unexpected.length === 0, unexpected.map((l) => l.text));

    console.log(`\n本番配信物テスト: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`);
    process.exit(failures === 0 ? 0 : 1);
  } finally {
    server.close();
  }
}

console.error(`不明なモード: ${mode}`);
process.exit(1);

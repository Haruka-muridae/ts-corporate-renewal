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

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { readFile, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const repoApps = resolve(root, '..');

const mode = process.argv[2] ?? 'dev';
/*
 * 配信ポートも固定しない。
 *
 * 固定にすると、同じ端末の別の作業ディレクトリで動いている
 * 「このプロジェクトの別コピー」の dev サーバーが同じポートを掴んでいるとき、
 * --strictPort で自分の Vite が起動できないまま、
 * 相手のサーバーへ接続してテストが進んでしまう。
 * 実際にそれで、存在しないはずのテストページが
 * SPA フォールバックでアプリ本体に化けていた。
 */
let DEV_PORT = 0;
let DIST_PORT = 0;
/*
 * CDP のポートは固定しない。
 *
 * 固定にすると、同じ端末の別の作業ディレクトリで動いている Chrome が
 * 同じポートを掴んでいるだけでテストが起動できなくなる。
 * 実際にそれで落ちた（別リポジトリの headless Chrome が 9333 を保持）。
 * 他人のプロセスを落とさずに済むよう、毎回空きポートを取る。
 */
async function findFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createSocketServer();

    probe.on('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

let CDP_PORT = await findFreePort();

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

/*
 * expectSubstring を渡すと、200 が返るだけでなく
 * 「中身が期待したページか」まで確かめる。
 * Vite は解決できないパスに index.html を返すため、
 * 200 だけでは別のページを掴んでいても気づけない。
 */
function waitFor(url, timeoutMs = 60000, expectSubstring = '') {
  const deadline = Date.now() + timeoutMs;

  return new Promise((done, fail) => {
    const attempt = async () => {
      try {
        const response = await fetch(url);
        if (response.ok) {
          if (expectSubstring === '' || (await response.text()).includes(expectSubstring)) {
            done();
            return;
          }

          fail(new Error(`${url} が期待したページではありません（${expectSubstring} が含まれていません）`));
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

/*
 * Chrome をプロセスツリーごと終了する。
 *
 * Windows では child.kill() が起動した1プロセスしか落とさず、
 * renderer / gpu-process / crashpad-handler が生き残る。
 * 生き残りが CDP ポートとプロファイルのロックを掴んだままになり、
 * 次のページで「CDP へ接続できません」になる。
 */
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    } catch {
      /* taskkill が無い環境では通常の kill にする。 */
    }
  }

  child.kill();
}

/*
 * profile を分けられるようにしてある。
 *
 * 同じ user-data-dir で Chrome を連続して起動し直すと、
 * 直前のプロセスがプロファイルのロックを解放しきる前に次が起動し、
 * 起動そのものに失敗することがある（3ページ目で落ちていた）。
 * dev モードはページごとに別プロファイルを使う。
 * dist モードは前の読み込みの IndexedDB を引き継ぐ必要があるため既定のまま。
 */
async function runPage(pageUrl, urlFilter, { waitMs = 300000, expression, profile = 'chrome-test-profile' } = {}) {
  /* ページごとに空きポートを取り直す（前ページの後始末に依存しない）。 */
  CDP_PORT = await findFreePort();

  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-extensions',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${resolve(root, `node_modules/.cache/${profile}`)}`,
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

    /*
     * 接続が切れたときに、待っている送信を全部落とす。
     * これをしないと Promise が永久に解決されず、
     * Node が「unsettled top-level await」で黙って終了してしまい、
     * どのページで何が起きたのか分からなくなる。
     */
    let socketDown = null;

    const dropPending = (reason) => {
      socketDown = socketDown ?? reason;

      pending.forEach((done) => done({ error: { message: reason } }));
      pending.clear();
    };

    ws.addEventListener('close', () => dropPending('CDP 接続が切断されました（Chrome が終了した可能性）'));
    ws.addEventListener('error', () => dropPending('CDP 接続でエラーが発生しました'));

    const send = (method, params = {}) => {
      nextId += 1;
      const id = nextId;

      if (socketDown) {
        return Promise.resolve({ error: { message: socketDown } });
      }

      return new Promise((done) => {
        pending.set(id, done);

        try {
          ws.send(JSON.stringify({ id, method, params }));
        } catch (error) {
          pending.delete(id);
          done({ error: { message: `送信できません: ${error.message}` } });
        }
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

    /*
     * 期待したテストページが読み込まれたことを確かめ、違えば開き直す。
     *
     * Vite の dev サーバーは、パスを解決できないとき index.html を返す
     * （SPA フォールバック）。依存の再最適化などでファイルを返せない一瞬に
     * 当たると、テストページのつもりでアプリ本体が読み込まれ、
     * 「1件も結果が出ないまま終わる」という分かりにくい失敗になる。
     */
    const ensureTestPage = async (attempts = 3) => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        await waitUntilLoaded();

        const found = await evaluate("!!document.getElementById('out')");

        if (found.value === true) {
          return true;
        }

        await send('Page.navigate', { url: pageUrl });
        await new Promise((r) => setTimeout(r, 1500));
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

    if (!await ensureTestPage()) {
      throw new Error(`${pageUrl}: テストページを読み込めませんでした（アプリ本体が返っている可能性）`);
    }

    const deadline = Date.now() + waitMs;
    let title = '';

    while (Date.now() < deadline) {
      title = (await evaluate('document.title')).value ?? '';
      if (title === 'PASS' || title === 'FAIL') {
        break;
      }

      if (socketDown) {
        throw new Error(`${pageUrl}: ${socketDown}`);
      }

      await new Promise((r) => setTimeout(r, 1000));
    }

    const output = (await evaluate("document.getElementById('out')?.textContent ?? ''")).value ?? '';
    ws.close();

    return { title, output, consoleLogs };
  } finally {
    killTree(chrome);
  }
}

/* ---- 実行 ---- */

if (mode === 'dev' || mode === 'ui') {
  /* dev は統合テストとUIテストの両方、ui はUIテストだけを流す。 */
  const pages = mode === 'ui'
    ? [{ file: 'ui.html', label: 'UI' }, { file: 'chat.html', label: 'チャットUI' }]
    : [
      { file: 'index.html', label: '統合' },
      { file: 'ui.html', label: 'UI' },
      { file: 'chat.html', label: 'チャットUI' },
    ];

  DEV_PORT = await findFreePort();

  const vite = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', '--port', String(DEV_PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });

  let bad = 0;

  try {
    for (const page of pages) {
      const url = `http://localhost:${DEV_PORT}/tests/browser/${page.file}`;
      /*
       * 自分が起動した dev サーバーの、期待したテストページであることを確かめる。
       * id="out" はテスト用ページだけが持つ（アプリ本体には無い）。
       */
      await waitFor(url, 60000, 'id="out"');
      const { title, output, consoleLogs } = await runPage(url, `tests/browser/${page.file}`, {
        profile: `chrome-test-${page.file.replace(/\W+/g, '-')}`,
      });

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
    /* npx 経由なので、木ごと落とさないと dev サーバーが残る。 */
    killTree(vite);
  }

  process.exit(bad === 0 ? 0 : 1);
}

if (mode === 'dist') {
  /*
   * 「初回アクセス」から始めるため、ブラウザのプロファイル（IndexedDBを含む）を消す。
   * 消さないと前回の実行でセットアップ済みになっていて、ウィザードを確認できない。
   */
  await rm(resolve(root, 'node_modules/.cache/chrome-test-profile'), { recursive: true, force: true })
    .catch(() => { /* 初回は存在しない。 */ });

  DIST_PORT = await findFreePort();

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
          /*
           * エントリのチャンク名はビルド構成で変わる
           * （マルチページ化で index-*.js → main-*.js になった）。
           * HTML の module スクリプトから実際の名前を読む。
           */
          const chunk = /<script[^>]+type="module"[^>]+src="\\.\\/assets\\/([^"]+\\.js)"/.exec(html);
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

    /*
     * 初回アクセスではセットアップウィザードが出る。
     * 1回目でウィザードを確認し、完了状態を書き込んでから、
     * 2回目で通常画面（タブ）を確認する。
     * プロファイルは dist モードの開始時に消しているので、必ず「初回」から始まる。
     */
    const wizardExpression = `
      (async () => {
        const out = { errors: [], rejections: [] };
        const deadline = Date.now() + 30000;
        while (!document.querySelector('.wizard') && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200));
        }

        const wizard = document.querySelector('.wizard');
        out.wizardShown = Boolean(wizard);
        out.navHidden = document.querySelector('.app-nav')?.hidden === true;
        out.steps = Array.from(document.querySelectorAll('.wizard__label')).map((e) => e.textContent);
        out.hasSignInButton = Boolean(document.querySelector('[data-role="wizard-signin"]'));
        out.text = (wizard?.textContent ?? '').slice(0, 4000);

        /*
         * 完了状態を直接書き込む（アプリと同じ設定テーブル）。
         * 次の読み込みで通常画面になることを確かめるため。
         */
        out.wrote = await new Promise((resolve) => {
          const open = indexedDB.open('tsam-knowledge');
          open.onerror = () => resolve('open-failed');
          open.onsuccess = () => {
            const dbi = open.result;
            try {
              const tx = dbi.transaction('settings', 'readwrite');
              tx.objectStore('settings').put({
                key: 'setupState',
                value: { version: 1, completed: true, completedAt: '2026-07-28T00:00:00.000Z', progress: {} },
                updatedAt: '2026-07-28T00:00:00.000Z',
              });
              tx.oncomplete = () => { dbi.close(); resolve('ok'); };
              tx.onerror = () => { dbi.close(); resolve('tx-failed'); };
            } catch (e) {
              dbi.close();
              resolve(String(e).slice(0, 80));
            }
          };
        });

        return JSON.stringify(out);
      })()
    `;

    /* チャットページ（/chat/）の検査。モデルは取得しない。 */
    const chatExpression = `
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

        const deadline = Date.now() + 30000;
        while (!document.querySelector('[data-role="prepare-model"]') && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200));
        }

        out.title = document.title;
        out.hasPrepareButton = Boolean(document.querySelector('[data-role="prepare-model"]'));
        out.hasInput = Boolean(document.getElementById('chat-input'));
        out.inputDisabled = document.getElementById('chat-input')?.disabled === true;
        out.text = (document.getElementById('main')?.textContent ?? '').slice(0, 6000);
        out.headerText = (document.querySelector('.app-header')?.textContent ?? '').slice(0, 1000);
        out.absoluteRefs = Array.from(document.querySelectorAll('[src],[href]'))
          .map((e) => e.getAttribute('src') || e.getAttribute('href'))
          .filter((v) => v && v.startsWith('/'));
        out.links = Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href'));
        out.csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '';

        /* 読み上げ・キーボード操作まわりが配信物にも残っているか。 */
        out.logAriaLive = document.getElementById('chat-log')?.getAttribute('aria-live') ?? '';
        out.logAriaBusy = document.getElementById('chat-log')?.hasAttribute('aria-busy') === true;
        out.inputDescribedBy = document.getElementById('chat-input')?.getAttribute('aria-describedby') ?? '';
        out.hasSkipLink = Boolean(document.querySelector('.skip-link'));
        out.hasAnnouncer = Boolean(document.querySelector('.visually-hidden[role="status"]'));
        out.hasDiagnosticsButton = Boolean(document.querySelector('[data-role="run-diagnostics"]'));
        out.hasMinGrounding = Boolean(document.querySelector('[data-role="min-grounding"]'));
        out.viewport = document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '';

        /* 横スクロールが出ていないか（狭い画面での確認）。 */
        out.docWidth = document.documentElement.scrollWidth;
        out.viewWidth = document.documentElement.clientWidth;

        /* 読み込んだスクリプトに sourceMappingURL が残っていないか。 */
        out.scripts = Array.from(document.querySelectorAll('script[src]')).map((s) => s.getAttribute('src'));

        const bodies = await Promise.all(out.scripts.map((src) =>
          originalFetch(src).then((r) => r.text()).catch(() => '')));

        out.hasSourceMap = bodies.some((b) => b.includes('sourceMappingURL'));
        out.hasLocalPath = bodies.some((b) => /[A-Za-z]:\\\\Users|\\/home\\/[a-z]+\\/|Desktop\\\\/.test(b));
        out.hasSecretLike = bodies.some((b) => /AIza[0-9A-Za-z_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|ya29\\./.test(b));
        out.mentionsExternalLlm = bodies.some((b) => /api\\.openai\\.com|api\\.anthropic\\.com|generativelanguage\\.googleapis\\.com/i.test(b));

        /* 起動時点で外部（モデル配信元）へ出ていないこと。 */
        out.externalRequests = out.requests.filter((r) =>
          /huggingface|hf\.co|raw\.githubusercontent|openai|anthropic|generativelanguage/i.test(r.url));

        return JSON.stringify(out);
      })()
    `;

    const chatPage = await runPage(`http://127.0.0.1:${DIST_PORT}${prefix}/chat/index.html`, 'chat/index.html', { expression: chatExpression });
    const chatResult = chatPage.custom.error || typeof chatPage.custom.value !== 'string'
      ? null
      : JSON.parse(chatPage.custom.value);

    const first = await runPage(pageUrl, 'myrepo/apps/knowledge', { expression: wizardExpression });
    const wizardResult = first.custom.error || typeof first.custom.value !== 'string'
      ? null
      : JSON.parse(first.custom.value);

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

    /* 1回目：初回アクセス（セットアップウィザード） */
    check('初回アクセスでウィザードが出る', wizardResult?.wizardShown === true, first.custom.error ?? wizardResult);
    check('ウィザード中はナビを隠す', wizardResult?.navHidden === true);
    check('手順が7つ並ぶ', wizardResult?.steps?.length === 7, wizardResult?.steps);
    check('最初はログインの案内', wizardResult?.hasSignInButton === true);
    check('読み取り専用であることを案内する', wizardResult?.text?.includes('drive.readonly') === true);
    check('完了状態を保存できる', wizardResult?.wrote === 'ok', wizardResult?.wrote);

    /* 2回目：完了後の通常画面 */
    check('起動できる', !result.bootFailed, result);
    check('完了後は通常画面が出る', result.nav.length === 6, result.nav);
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

    /* チャットページ（/chat/） */
    check('/chat/ が表示できる', chatResult?.hasPrepareButton === true, chatPage.custom.error ?? chatResult);
    check('/chat/ のタイトル', chatResult?.title?.includes('AIナレッジチャット') === true, chatResult?.title);
    check('/chat/ は起動時にモデルを取得しない', chatResult?.externalRequests?.length === 0, chatResult?.externalRequests);
    check('/chat/ の入力はモデル未読込で無効', chatResult?.inputDisabled === true);
    check('/chat/ に初回説明がある', chatResult?.text?.includes('あなたのブラウザ内で動作します') === true);
    check('/chat/ に外部AI不使用の明示がある', chatResult?.headerText?.includes('外部AI API不使用') === true);
    check('/chat/ にナレッジ管理への導線がある', chatResult?.links?.includes('../') === true, chatResult?.links);
    check('/chat/ にアプリ一覧への導線がある', chatResult?.links?.includes('../../') === true);
    check('/chat/ に絶対パス参照が無い', chatResult?.absoluteRefs?.length === 0, chatResult?.absoluteRefs);
    check('/chat/ のCSPに unsafe-inline が無い', !/script-src[^;]*unsafe-inline/.test(chatResult?.csp ?? 'x'));
    check("/chat/ のCSPに unsafe-eval が無い", !/script-src[^;]*'unsafe-eval'/.test(chatResult?.csp ?? 'x'));
    check("/chat/ のCSPは wasm-unsafe-eval のみ許可", /script-src[^;]*'wasm-unsafe-eval'/.test(chatResult?.csp ?? ''));
    check('/chat/ のCSPにモデル配信元がある',
      /connect-src[^;]*huggingface\.co/.test(chatResult?.csp ?? '')
      && /connect-src[^;]*raw\.githubusercontent\.com/.test(chatResult?.csp ?? ''));
    check('/chat/ のCSPにDrive APIは不要', !/connect-src[^;]*www\.googleapis\.com/.test(chatResult?.csp ?? ''));
    check('/chat/ console.error 0件', chatResult?.errors?.length === 0, chatResult?.errors);
    check('/chat/ unhandled rejection 0件', chatResult?.rejections?.length === 0, chatResult?.rejections);

    /* アクセシビリティと操作性が配信物にも残っていること。 */
    check('/chat/ 会話ログが読み上げ対象', chatResult?.logAriaLive === 'polite');
    check('/chat/ 会話ログに aria-busy がある', chatResult?.logAriaBusy === true);
    check('/chat/ 入力欄に説明が結び付く', chatResult?.inputDescribedBy === 'chat-input-help');
    check('/chat/ 本文へスキップできる', chatResult?.hasSkipLink === true);
    check('/chat/ 読み上げ用の通知がある', chatResult?.hasAnnouncer === true);
    check('/chat/ 診断を実行できる', chatResult?.hasDiagnosticsButton === true);
    check('/chat/ 根拠レベルを選べる', chatResult?.hasMinGrounding === true);
    check('/chat/ 端末幅に追従する', (chatResult?.viewport ?? '').includes('width=device-width'));
    check('/chat/ 横スクロールが出ない',
      Number(chatResult?.docWidth ?? 0) <= Number(chatResult?.viewWidth ?? 0) + 1,
      { doc: chatResult?.docWidth, view: chatResult?.viewWidth });

    /* 配信物そのものの監査。 */
    check('/chat/ ソースマップを配らない', chatResult?.hasSourceMap === false);
    check('/chat/ ローカルパスが混ざらない', chatResult?.hasLocalPath === false);
    check('/chat/ 秘密情報らしき文字列が無い', chatResult?.hasSecretLike === false);
    check('/chat/ 外部LLM APIの宛先を含まない', chatResult?.mentionsExternalLlm === false);

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

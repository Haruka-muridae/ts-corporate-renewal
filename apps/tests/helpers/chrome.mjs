/*
 * ヘッドレス Chrome の起動と、DevTools Protocol での操作。
 *
 * Playwright 等の大きな依存は増やさず、Node 22+ 標準の WebSocket で
 * CDP を直接叩く（apps/knowledge-src/tests/tools/run-browser.mjs と同じ方針）。
 *
 * 後片付けを最優先にしている。
 *   - Chrome は必ず kill する（失敗時・例外時も）
 *   - プロファイルは一時ディレクトリへ作り、終了時に削除する
 *   - 応答待ちには上限を設け、握りっぱなしで止まらないようにする
 */

import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * 起動した Chrome の後始末を保証するための保険。
 *
 * 子プロセスは親の終了では死なない（Windows では特に）。
 * テストが例外で落ちた場合でも Chrome を残さないよう、
 * プロセス終了時に同期的に kill する。
 */
const liveChildren = new Set();
let exitHookInstalled = false;

function installExitHook() {
  if (exitHookInstalled) {
    return;
  }

  exitHookInstalled = true;

  /* exit ハンドラでは同期処理しかできない。kill と rmSync だけを行う。 */
  process.once('exit', () => {
    liveChildren.forEach(({ child, profileDir }) => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* すでに終了している。 */
      }

      try {
        rmSync(profileDir, { recursive: true, force: true });
      } catch {
        /* 消せなくてもテスト結果には影響しない。 */
      }
    });
  });

  /* Ctrl+C や kill でも後片付けしてから終わる。 */
  ['SIGINT', 'SIGTERM'].forEach((signal) => {
    process.once(signal, () => {
      process.exit(130);
    });
  });
}

/*
 * Chrome の場所。環境変数 CHROME_PATH があれば最優先。
 * 見つからない場合は、探した場所を添えて失敗させる。
 */
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA ?? ''}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

export function findChrome() {
  const found = CHROME_CANDIDATES.find((p) => existsSync(p));

  if (!found) {
    throw new Error(
      'Chrome が見つかりません。環境変数 CHROME_PATH で実行ファイルを指定してください。\n'
      + `探した場所:\n${CHROME_CANDIDATES.map((p) => `  ${p}`).join('\n')}`,
    );
  }

  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * Chrome を起動して CDP セッションを返す。
 *
 * 戻り値のオブジェクトは必ず close() すること。
 * try / finally で囲むのが前提。
 */
export async function launchChrome({ port, startUrl = 'about:blank' }) {
  const chromePath = findChrome();
  const profileDir = await mkdtemp(join(tmpdir(), 'tsam-chrome-'));

  installExitHook();

  const child = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    /* 実在サービスへ通信しないことを確かめたいので、更新系も止める。 */
    '--disable-component-update',
    '--disable-sync',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    startUrl,
  ], { stdio: 'ignore' });

  const entry = { child, profileDir };
  liveChildren.add(entry);

  const cleanup = async () => {
    liveChildren.delete(entry);

    try {
      child.kill('SIGKILL');
    } catch {
      /* すでに終了している。 */
    }

    /* 子プロセスの終了を待つ（待たずに消すと必ずロックに当たる）。 */
    await Promise.race([
      new Promise((done) => child.once('exit', done)),
      sleep(3000),
    ]);

    /*
     * Windows では Chrome の終了後もしばらくファイルが掴まれたままになる。
     * 一度で消えないことが多いため、間隔を空けて何度か試す。
     * それでも消えなければ諦める（%TEMP% なのでOSが後で回収する）。
     */
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await rm(profileDir, { recursive: true, force: true });
        return;
      } catch {
        await sleep(200 * (attempt + 1));
      }
    }
  };

  try {
    const target = await waitForTarget(port);
    const session = await connect(target.webSocketDebuggerUrl);

    return {
      ...session,
      async close() {
        await session.disconnect();
        await cleanup();
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function waitForTarget(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');

      if (page?.webSocketDebuggerUrl) {
        return page;
      }
    } catch {
      /* まだ起動していない。 */
    }

    if (Date.now() > deadline) {
      throw new Error(
        `Chrome の CDP へ接続できません（ポート ${port}）。`
        + '\n  他のテストが動いていないか、ポートが塞がっていないか確認してください。',
      );
    }

    await sleep(250);
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const consoleErrors = [];
  let requests = [];
  let nextId = 0;

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);

    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
    }

    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }

    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      consoleErrors.push(`EXCEPTION: ${details?.exception?.description ?? details?.text}`);
    }

    if (message.method === 'Network.requestWillBeSent') {
      requests.push(message.params.request.url);
    }
  });

  await new Promise((done, failed) => {
    ws.addEventListener('open', done);
    ws.addEventListener('error', () => failed(new Error('CDP の WebSocket に接続できません')));
  });

  /*
   * 応答待ちに上限を設ける。
   * ページ遷移で実行コンテキストが壊れると応答が返らないことがあり、
   * 上限が無いとテスト全体が止まる。
   */
  const send = (method, params = {}, timeoutMs = 10000) => {
    nextId += 1;
    const id = nextId;

    return new Promise((done) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        done({ __timeout: true });
      }, timeoutMs);

      pending.set(id, (message) => {
        clearTimeout(timer);
        done(message);
      });

      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  const evaluate = async (expression, retry = 1) => {
    const response = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });

    if (response.__timeout) {
      if (retry > 0) {
        await sleep(400);
        return evaluate(expression, retry - 1);
      }
      return '__TIMEOUT__';
    }

    if (response.result?.exceptionDetails) {
      const details = response.result.exceptionDetails;
      throw new Error(details.exception?.description ?? details.text);
    }

    return response.result?.result?.value;
  };

  const goto = async (url, waitMs = 900) => {
    await send('Page.navigate', { url });
    await sleep(waitMs);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');

  return {
    send,
    evaluate,
    goto,
    sleep,
    consoleErrors,
    /* 直近の通信記録。resetRequests() で区切って使う。 */
    getRequests: () => requests.slice(),
    resetRequests: () => { requests = []; },
    setViewport: (width, height = 800) => send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: width < 768,
    }),
    clearViewport: () => send('Emulation.clearDeviceMetricsOverride'),
    disconnect: async () => {
      try {
        ws.close();
      } catch {
        /* すでに閉じている。 */
      }
    },
  };
}

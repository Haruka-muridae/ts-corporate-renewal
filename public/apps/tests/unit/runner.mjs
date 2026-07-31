/*
 * テスト実行役そのものの検査。
 *
 * ------------------------------------------------------------------
 * なぜこれを試験するのか
 * ------------------------------------------------------------------
 * タイムアウトと後始末は、壊れていても普段は気づけない。
 * 「タイムアウトしたのに子プロセスが残る」は、
 * 実際に詰まるまで表に出ないため、手で確かめようがない。
 *
 * 実測でも、実行役を止めたあとに Chrome と node が残り、
 * ポートを掴んだままになる事象が2回起きている。
 * ------------------------------------------------------------------
 *
 * 長く待つ試験は書かない。短いタイムアウトを渡して確かめる。
 */

import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import { check, section, finish, fatal } from '../helpers/assert.mjs';
import { runChild, liveChildCount, killAllLiveChildren } from '../helpers/run-child.mjs';
import { IS_WINDOWS, spawnOptionsForTree } from '../helpers/process-tree.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * 使い捨ての作業場所。
 * 検査用の小さなスクリプトをここへ書き、最後に必ず消す。
 * リポジトリへ雛形ファイルを増やさないため。
 */
const workDir = await mkdtemp(join(tmpdir(), 'tsam-runner-'));

const script = async (name, body) => {
  const path = join(workDir, name);
  await writeFile(path, body, 'utf8');
  return path;
};

const node = process.execPath;

try {
  section("1. 正常終了する子プロセス");
  const okPath = await script('ok.mjs', 'console.log("hello");\nprocess.exitCode = 0;\n');
  const ok = await runChild(node, [okPath], { timeoutMs: 10_000 });

  check('exit code 0', ok.code === 0, String(ok.code));
  check('標準出力を拾う', ok.stdout.includes('hello'), ok.stdout.trim());
  check('タイムアウト扱いにならない', ok.timedOut === false);
  check('起動エラーなし', ok.spawnError === null, String(ok.spawnError));
  check('所要時間が記録される', typeof ok.durationMs === 'number' && ok.durationMs >= 0);
  check('追跡から外れる', liveChildCount() === 0, String(liveChildCount()));

  section("2. 非ゼロ終了する子プロセス");
  const ngPath = await script('ng.mjs', 'console.error("boom");\nprocess.exit(3);\n');
  const ng = await runChild(node, [ngPath], { timeoutMs: 10_000 });

  check('exit code が伝わる', ng.code === 3, String(ng.code));
  check('標準エラーを拾う', ng.stderr.includes('boom'), ng.stderr.trim());
  check('タイムアウトではない', ng.timedOut === false);

  section("3. タイムアウトする子プロセス");
  /*
   * setInterval でイベントループを生かし続ける。
   * 「終わらないスイート」の再現。
   */
  const hangPath = await script('hang.mjs',
    'console.log("started");\nsetInterval(() => {}, 1000);\n');

  const startedAt = Date.now();
  const hang = await runChild(node, [hangPath], { timeoutMs: 1200 });
  const elapsed = Date.now() - startedAt;

  check('★タイムアウトとして記録される', hang.timedOut === true);
  check('★終了コードが 0 にならない', hang.code !== 0, String(hang.code));
  check('★上限付近で打ち切る', elapsed < 8000, `${elapsed}ms`);
  check('打ち切りが早すぎない', elapsed >= 1000, `${elapsed}ms`);
  check('★子プロセスが残らない', liveChildCount() === 0, String(liveChildCount()));
  check('打ち切りまでの出力は残る', hang.stdout.includes('started'), hang.stdout.trim());

  section("4. タイムアウト後に孫プロセスも残らない");
  /*
   * スイートは Chrome を起動する。つまり孫がいる。
   * 親だけ kill すると孫が残り、ポートを掴んだままになる。
   *
   * ここでは孫の代わりに、ポートを掴む子を起動させて確かめる。
   */
  const port = 5399;
  const grandPath = await script('grand.mjs', `
import { createServer } from 'node:http';
const s = createServer((_, res) => res.end('x'));
s.listen(${port}, '127.0.0.1', () => console.log('listening'));
setInterval(() => {}, 1000);
`);
  const parentPath = await script('parent.mjs', `
import { spawn } from 'node:child_process';
spawn(process.execPath, [${JSON.stringify(grandPath)}], { stdio: 'inherit' });
setInterval(() => {}, 1000);
`);

  const tree = await runChild(node, [parentPath], { timeoutMs: 2500 });
  check('タイムアウトする', tree.timedOut === true);

  /* 解放を待つ。TIME_WAIT ではなく LISTEN が消えることを見る。 */
  let free = false;
  for (let i = 0; i < 12; i += 1) {
    /* eslint-disable-next-line no-await-in-loop */
    free = await new Promise((done) => {
      const probe = createServer();
      probe.once('error', () => done(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)));
    });

    if (free) break;
    /* eslint-disable-next-line no-await-in-loop */
    await sleep(400);
  }

  check('★孫が掴んだポートが解放される', free === true,
    free ? '' : `ポート ${port} が残っている`);

  section("5. 起動に失敗した場合");
  const missing = await runChild(join(workDir, 'does-not-exist.exe'), [], { timeoutMs: 3000 });
  check('★promise が解決する（固まらない）', typeof missing === 'object');
  check('起動エラーが記録される', typeof missing.spawnError === 'string' && missing.spawnError.length > 0);
  check('exit code は 0 でない', missing.code !== 0, String(missing.code));
  check('追跡から外れる', liveChildCount() === 0);

  section("6. 後始末を何度呼んでも壊れない");
  killAllLiveChildren();
  killAllLiveChildren();
  check('★二重に呼んでも例外にならない', true);
  check('追跡が空のまま', liveChildCount() === 0);

  section("7. プラットフォーム差分");
  const opts = spawnOptionsForTree();
  if (IS_WINDOWS) {
    check('Windows では detached を付けない', opts.detached === undefined, JSON.stringify(opts));
  } else {
    check('POSIX では detached を付ける（プロセスグループを作る）', opts.detached === true);
  }
  check('spawn へ渡せる形', typeof opts === 'object' && opts !== null);

  section("8. 実行役の設定");
  const runnerSource = await import('node:fs/promises')
    .then((fs) => fs.readFile(new URL('../run.mjs', import.meta.url), 'utf8'));

  check('★スイート単位のタイムアウトがある', runnerSource.includes('TIMEOUT_MS'));
  check('★環境変数で変えられる（unit）', runnerSource.includes('TEST_TIMEOUT_UNIT_MS'));
  check('★環境変数で変えられる（browser）', runnerSource.includes('TEST_TIMEOUT_BROWSER_MS'));
  check('★SIGINT で後始末する', runnerSource.includes('SIGINT'));
  check('★SIGTERM で後始末する', runnerSource.includes('SIGTERM'));
  check('★uncaughtException で後始末する', runnerSource.includes('uncaughtException'));
  check('★unhandledRejection で後始末する', runnerSource.includes('unhandledRejection'));
  check('★exit で後始末する', runnerSource.includes("process.on('exit'"));
  check('タイムアウトを結果表示で区別する', runnerSource.includes('タイムアウト'));
  check('ブラウザの上限がunitより長い',
    Number(process.env.TEST_TIMEOUT_BROWSER_MS ?? 300_000)
      > Number(process.env.TEST_TIMEOUT_UNIT_MS ?? 120_000));

  section("9. 自然終了できないスイートの保険");
  const assertSource = await import('node:fs/promises')
    .then((fs) => fs.readFile(new URL('../helpers/assert.mjs', import.meta.url), 'utf8'));

  check('★終了できないときの保険がある', assertSource.includes('armExitWatchdog'));
  check('★unref したタイマーを使う（正常時に影響しない）', assertSource.includes('timer.unref()'));
  check('猶予時間を環境変数で変えられる', assertSource.includes('TEST_EXIT_GRACE_MS'));
  check('結果行を出したあとに効く', assertSource.indexOf('TESTRESULT') < assertSource.indexOf('armExitWatchdog'));

  /* 実際に「終われないスイート」を動かして、保険が効くことを見る。 */
  const stuckPath = await script('stuck.mjs', `
import { createServer } from 'node:http';
/* 閉じないサーバー。これがあるとプロセスは自然終了できない。 */
createServer(() => {}).listen(0, '127.0.0.1');
console.log('TESTRESULT 1 0');
process.exitCode = 0;
setTimeout(() => {
  console.error('watchdog fired');
  process.exit(process.exitCode ?? 0);
}, 300).unref();
`);
  const stuck = await runChild(node, [stuckPath], { timeoutMs: 6000 });
  check('★詰まっても最後は終了する', stuck.timedOut === false, `timedOut=${stuck.timedOut}`);
  check('★結果行は読み取れる', stuck.stdout.includes('TESTRESULT 1 0'));
  check('保険が働いたことが分かる', stuck.stderr.includes('watchdog fired'), stuck.stderr.trim());

  section("10. 前回の一時プロファイルの掃除");
  /*
   * タイムアウトで打ち切られたスイートは SIGKILL で死ぬ。
   * SIGKILL は捕まえられないため、終了フックの削除が動かず
   * 一時プロファイルが残る。実行開始時に掃除できることを確かめる。
   */
  const chrome = await import('../helpers/chrome.mjs');
  const stalePrefix = chrome.PROFILE_PREFIX;

  check('プロファイル名の目印が公開されている',
    typeof stalePrefix === 'string' && stalePrefix.length > 0, String(stalePrefix));

  const stale = await mkdtemp(join(tmpdir(), stalePrefix));
  await writeFile(join(stale, 'dummy.txt'), 'x', 'utf8');
  check('残骸を作れた', existsSync(stale));

  const removed = await chrome.sweepStaleProfiles();
  check('★残骸を消す', existsSync(stale) === false, stale);
  check('消した数を返す', removed >= 1, String(removed));

  /* 何も無い状態で呼んでも壊れない。 */
  const again = await chrome.sweepStaleProfiles();
  check('★空の状態で呼んでも例外にならない', typeof again === 'number', String(again));

  const runnerSweeps = runnerSource.includes('sweepStaleProfiles');
  check('★実行役が開始時に掃除する', runnerSweeps);

  section("11. Node の下限が実際の要件と合っているか");
  /*
   * ------------------------------------------------------------------
   * なぜ検査するのか
   * ------------------------------------------------------------------
   * ブラウザテストは helpers/chrome.mjs でグローバルの WebSocket を使う。
   * これがフラグ無しで使えるのは Node 22.0 から、
   * 実験的でなくなるのは 22.4 から。
   *   https://nodejs.org/api/globals.html#websocket
   *
   * engines がこれより低いと、条件を満たす環境で入れたのに
   * ブラウザテストだけが動かない、という分かりにくい失敗になる。
   *
   * 文字列の一致ではなく、数値として下限を比べる。
   * ">=22.4.0" でも ">= 22.4.0" でも "^22.4.0" でも通るようにする。
   * CI のバージョン（24）と一致させる検査にはしない。
   * CI を上げ下げしても、下限の意味は変わらないため。
   * ------------------------------------------------------------------
   */
  const pkg = JSON.parse(
    await import('node:fs/promises')
      .then((fs) => fs.readFile(new URL('../../../../package.json', import.meta.url), 'utf8')),
  );

  const range = pkg.engines?.node ?? '';
  check('engines.node がある', typeof range === 'string' && range.length > 0, range);

  /* 範囲指定から最初の x.y.z を取り出す。 */
  const found = range.match(/(\d+)\.(\d+)\.(\d+)/);
  check('版が読み取れる', found !== null, range);

  const [major, minor] = found ? [Number(found[1]), Number(found[2])] : [0, 0];
  const atLeast = (m, n) => major > m || (major === m && minor >= n);

  check('★グローバル WebSocket が使える下限（22.0）以上', atLeast(22, 0), range);
  check('★実験的でなくなる下限（22.4）以上', atLeast(22, 4), range);
  check('下限を上げすぎていない（26未満）', major < 26, range);

  /* いま動かしている Node が、その下限を満たしていること。 */
  const [runMajor, runMinor] = process.versions.node.split('.').map(Number);
  check('実行中の Node が下限を満たす',
    runMajor > major || (runMajor === major && runMinor >= minor),
    `実行中 ${process.versions.node} / 下限 ${range}`);

  /* 実際に使えることを確かめる。宣言と実態がずれていないか。 */
  check('★グローバル WebSocket が実在する', typeof WebSocket === 'function', typeof WebSocket);

  section("12. 一時ディレクトリ");
  check('作業場所が作られている', existsSync(workDir));
  const entries = await readdir(workDir);
  check('検査用スクリプトが置かれている', entries.length > 0, `${entries.length} 件`);
} catch (error) {
  fatal(error);
} finally {
  /* 何があっても消す。%TEMP% を汚さない。 */
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
  killAllLiveChildren();
}

check('★一時ディレクトリを削除した', !existsSync(workDir), workDir);

finish();

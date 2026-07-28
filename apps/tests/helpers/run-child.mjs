/*
 * 子プロセスを1つ動かし、結果を集める。
 *
 * ------------------------------------------------------------------
 * 実行役から切り出してある理由
 * ------------------------------------------------------------------
 * タイムアウトと後始末は、壊れていても普段は気づけない。
 * 「タイムアウトしたのに子が残る」は、実際に起きるまで表に出ない。
 *
 * 実行役（run.mjs）へ直接書くと、それ自体を試験できない。
 * ここへ出しておけば、短いタイムアウトを与えて
 * unit/runner.mjs から普通に検査できる。
 * ------------------------------------------------------------------
 */

import { spawn } from 'node:child_process';
import { killTree, killTreeSync, spawnOptionsForTree } from './process-tree.mjs';

/*
 * 動かしている子の一覧。
 * 実行役が異常終了しても、ここを見て後始末できるようにする。
 */
const live = new Set();

/* いま動いている子をすべて同期的に終わらせる（exit ハンドラ用）。 */
export function killAllLiveChildren() {
  live.forEach((child) => killTreeSync(child));
  live.clear();
}

export function liveChildCount() {
  return live.size;
}

/*
 * 子プロセスを動かす。
 *
 * 戻り値:
 *   {
 *     code,        終了コード（シグナルで死んだ場合は null）
 *     signal,      終了シグナル
 *     stdout, stderr,
 *     timedOut,    タイムアウトで打ち切ったか
 *     spawnError,  起動そのものに失敗した場合のメッセージ
 *     durationMs,
 *     killed,      ツリーの終了を確認できたか
 *   }
 *
 * **この関数は投げない。** 失敗も戻り値で表す。
 * 実行役が1スイートの失敗で止まらないようにするため。
 */
export function runChild(command, args, {
  cwd = process.cwd(),
  timeoutMs = 120_000,
  env = process.env,
} = {}) {
  return new Promise((done) => {
    const startedAt = Date.now();

    let child;

    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...spawnOptionsForTree(),
      });
    } catch (error) {
      done({
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        spawnError: error?.message ?? String(error),
        durationMs: Date.now() - startedAt,
        killed: true,
      });
      return;
    }

    live.add(child);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });

    const timer = setTimeout(() => {
      timedOut = true;
      /*
       * ツリーごと終わらせる。
       * ここで child.kill() だけにすると Chrome が残り、
       * ポートを掴んだまま次のスイートが失敗する。
       */
      killTree(child).then((ok) => {
        if (!ok) {
          stderr += '\n[run-child] タイムアウト後、子プロセスの終了を確認できませんでした。\n';
        }
      });
    }, timeoutMs);

    const settle = (code, signal) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      live.delete(child);

      done({
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        spawnError: null,
        durationMs: Date.now() - startedAt,
        killed: true,
      });
    };

    /* 起動に失敗した場合（実行ファイルが無い等）。close は来ない。 */
    child.on('error', (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      live.delete(child);

      done({
        code: null,
        signal: null,
        stdout,
        stderr,
        timedOut,
        spawnError: error?.message ?? String(error),
        durationMs: Date.now() - startedAt,
        killed: true,
      });
    });

    /*
     * exit ではなく close を待つ。
     * exit は標準出力が読み切られる前に来ることがあり、
     * 結果行（TESTRESULT）を取りこぼす。
     */
    child.on('close', (code, signal) => settle(code, signal));
  });
}

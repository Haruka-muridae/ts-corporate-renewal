/*
 * 子プロセスを、その子孫ごと確実に終わらせる。
 *
 * ------------------------------------------------------------------
 * なぜ child.kill() だけでは足りないか
 * ------------------------------------------------------------------
 * テストスイートは Chrome を起動する。
 * スイート本体（node）を kill しても、Chrome は別プロセスなので生き残る。
 * Chrome はポートと一時プロファイルを掴んだままになり、
 * 次回の実行が「ポートが使用中」で失敗する。
 *
 * そのため、プロセスツリーごと終わらせる必要がある。
 * OSごとにやり方が違う。
 *
 *   Windows … taskkill /T が子孫までたどってくれる
 *   POSIX  … 子をプロセスグループのリーダーにしておき、
 *            グループ全体へシグナルを送る（kill(-pid)）
 * ------------------------------------------------------------------
 *
 * 追加のnpmパッケージは使わない。Node 標準だけで完結させる。
 */

import { spawn } from 'node:child_process';

export const IS_WINDOWS = process.platform === 'win32';

/*
 * spawn へ渡す追加オプション。
 *
 * POSIX では detached: true にして、子を新しいプロセスグループの
 * リーダーにする。こうしないと kill(-pid) でグループを狙えない。
 *
 * Windows では detached を付けない。
 * 付けても taskkill /T に必要ではなく、
 * 親が死んだあとに子が独立して残りやすくなる副作用のほうが大きい。
 */
export function spawnOptionsForTree() {
  return IS_WINDOWS ? {} : { detached: true };
}

/*
 * ツリーを同期的に終わらせる。
 *
 * process.on('exit') の中からも呼べるように、同期APIだけを使う。
 * exit ハンドラでは await できないため、非同期版は用意しない。
 *
 * 失敗しても投げない。後片付けの失敗でテスト結果を変えないため。
 */
export function killTreeSync(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const pid = child.pid;

  if (!pid) {
    return;
  }

  if (IS_WINDOWS) {
    try {
      /*
       * /T … 子孫も対象にする
       * /F … 強制終了
       * 出力は捨てる（すでに終了していると「見つかりません」と出るため）。
       */
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } catch {
      /* taskkill が無い環境。次の kill で最低限のことをする。 */
    }
  } else {
    try {
      /* 負のPIDはプロセスグループ全体を指す。 */
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {
      /* グループが無い（detached が効かなかった）。単体で試す。 */
    }
  }

  try {
    child.kill('SIGKILL');
  } catch {
    /* すでに終了している。 */
  }
}

/*
 * ツリーを終わらせ、実際に終了するまで待つ。
 *
 * taskkill は非同期に効くため、待たずに次のスイートを始めると
 * ポートがまだ解放されていないことがある。
 *
 * 戻り値: 終了を確認できたか（true / false）
 */
export function killTree(child, { waitMs = 5000 } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  killTreeSync(child);

  return new Promise((done) => {
    let settled = false;

    const finish = (ok) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      done(ok);
    };

    const timer = setTimeout(() => finish(false), waitMs);
    child.once('exit', () => finish(true));
  });
}

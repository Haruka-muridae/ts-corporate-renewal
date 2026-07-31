/*
 * テストの判定と集計。
 *
 * 各スイートはこれを使い、最後に必ず finish() を呼ぶ。
 * finish() は実行役（run-all.mjs）が読み取れる1行を出力する。
 *
 *   TESTRESULT <pass> <fail>
 *
 * 出力形式は apps/knowledge-src/tests/ に合わせ、
 *   ok   … 合格
 *   NG   … 不合格
 * とする。
 */

let pass = 0;
let fail = 0;
const failures = [];

export function check(name, condition, extra) {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${name}`);
    return true;
  }

  fail += 1;
  failures.push(name);

  const detail = extra === undefined ? '' : ` -> ${String(extra).slice(0, 300)}`;
  console.log(`  NG   ${name}${detail}`);
  return false;
}

export function section(title) {
  console.log(`== ${title} ==`);
}

export function counts() {
  return { pass, fail, total: pass + fail };
}

/*
 * 結果を出力してプロセスを終える。
 * 失敗があれば終了コード 1。
 */
export function finish() {
  if (failures.length > 0) {
    console.log('\n不合格:');
    failures.forEach((name) => console.log(`  - ${name}`));
  }

  console.log(`\n結果: pass=${pass} fail=${fail}`);
  /* 実行役が解析する行。書式を変えないこと。 */
  console.log(`TESTRESULT ${pass} ${fail}`);

  /*
   * process.exit() は使わない。
   * ブラウザテストでは WebSocket や子プロセスの後始末が残っており、
   * 強制終了すると Windows の Node で内部ハンドルの警告が出る。
   * 終了コードだけ設定して、自然終了に任せる。
   */
  process.exitCode = failures.length > 0 ? 1 : 0;

  armExitWatchdog();
}

/*
 * 自然終了できなかったときの保険。
 *
 * ------------------------------------------------------------------
 * unref したタイマーを使う理由
 * ------------------------------------------------------------------
 * finish() のあと、ハンドル（Chrome の WebSocket・HTTPサーバー・
 * 開いたままのソケット）が1つでも残っていると、プロセスは終わらない。
 * 実行役から見ると「結果は出ているのに終わらない」状態になる。
 *
 * unref() したタイマーはイベントループを生かし続けない。
 *   ちゃんと終われる場合 … このタイマーは発火せず、静かに消える
 *   終われない場合      … 他のハンドルがループを生かしているので発火する
 *
 * つまり「本当に詰まっているときだけ」効く。
 * 正常時の挙動は一切変えない。
 * ------------------------------------------------------------------
 */
const EXIT_GRACE_MS = Number(process.env.TEST_EXIT_GRACE_MS ?? 10_000);

function armExitWatchdog() {
  if (EXIT_GRACE_MS <= 0) {
    return;
  }

  const timer = setTimeout(() => {
    console.error(
      `\n[assert] 結果出力から ${Math.round(EXIT_GRACE_MS / 1000)}秒たっても終了できませんでした。`
      + '\n  後片付けされていないハンドルが残っています（Chrome / HTTPサーバー / WebSocket）。'
      + '\n  結果は出力済みのため、この時点で強制終了します。',
    );

    /* 結果行はすでに出ているので、実行役の集計は壊れない。 */
    process.exit(process.exitCode ?? 0);
  }, EXIT_GRACE_MS);

  timer.unref();
}

/*
 * 想定外の例外でスイートが止まった場合も、
 * 実行役が「異常終了」と分かるようにする。
 */
export function fatal(error) {
  console.log(`\n致命的エラー: ${error?.stack ?? error}`);
  console.log(`TESTRESULT ${pass} ${fail + 1}`);
  process.exitCode = 1;
}

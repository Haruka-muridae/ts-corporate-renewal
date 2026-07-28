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

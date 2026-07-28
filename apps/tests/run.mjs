/*
 * テストの実行役。
 *
 * 使い方（リポジトリのルートから）:
 *   npm test                 … 全部
 *   npm run test:unit        … Node のみ（Chrome 不要）
 *   npm run test:browser     … 実ブラウザのみ
 *
 *   node apps/tests/run.mjs            … 全部
 *   node apps/tests/run.mjs unit       … Node のみ
 *   node apps/tests/run.mjs browser    … 実ブラウザのみ
 *   node apps/tests/run.mjs auth       … 認証まわりだけ
 *   node apps/tests/run.mjs audit      … 監査で追加した分だけ
 *
 * ------------------------------------------------------------------
 * 各スイートを別プロセスで動かす理由
 * ------------------------------------------------------------------
 * スイートは globalThis（localStorage / document / location）を
 * 差し替え、モジュールの内部状態にも触れる。
 * 1つのプロセスでまとめて読み込むと、前のスイートの状態が
 * 次へ漏れて、結果が実行順に依存する。
 *
 * 子プロセスへ分けることで、順番を入れ替えても同じ結果になる。
 * ------------------------------------------------------------------
 *
 * 各スイートは最後に `TESTRESULT <pass> <fail>` を出力する。
 * ここではその行を読み取って集計する。
 */

import { spawn } from 'node:child_process';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

/*
 * スイート一覧。
 * browser のものは Chrome を起動するため、時間がかかる。
 */
const SUITES = [
  { name: 'shared', file: 'unit/shared.mjs', kind: 'unit', groups: ['shared'] },
  { name: 'shared-dom', file: 'unit/shared-dom.mjs', kind: 'unit', groups: ['shared'] },
  { name: 'auth', file: 'unit/auth.mjs', kind: 'unit', groups: ['auth'] },
  { name: 'supabase', file: 'unit/supabase.mjs', kind: 'unit', groups: ['auth'] },
  { name: 'paths', file: 'unit/paths.mjs', kind: 'unit', groups: ['auth', 'audit'] },
  { name: 'audit', file: 'unit/audit.mjs', kind: 'unit', groups: ['auth', 'audit'] },
  { name: 'browser:login-flow', file: 'browser/login-flow.mjs', kind: 'browser', groups: ['auth'] },
  { name: 'browser:phase3-screens', file: 'browser/phase3-screens.mjs', kind: 'browser', groups: ['auth'] },
  { name: 'browser:audit', file: 'browser/audit.mjs', kind: 'browser', groups: ['auth', 'audit'] },
];

const mode = process.argv[2] ?? 'all';

function selectSuites() {
  if (mode === 'all') return SUITES;
  if (mode === 'unit' || mode === 'browser') return SUITES.filter((s) => s.kind === mode);
  return SUITES.filter((s) => s.groups.includes(mode));
}

const selected = selectSuites();

if (selected.length === 0) {
  console.error(`不明な指定: ${mode}`);
  console.error('使える値: all / unit / browser / shared / auth / audit');
  process.exit(1);
}

/* ---- 実行 ---- */

function runSuite(suite) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [resolve(here, suite.file)], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('close', (code) => {
      const match = stdout.match(/TESTRESULT (\d+) (\d+)/);

      done({
        suite,
        code,
        stdout,
        stderr,
        pass: match ? Number(match[1]) : 0,
        fail: match ? Number(match[2]) : 0,
        /* 結果行が出ていない＝途中で落ちた。 */
        crashed: !match,
      });
    });
  });
}

console.log(`テスト実行: ${mode}（${selected.length} スイート）\n`);

const results = [];

for (const suite of selected) {
  process.stdout.write(`  実行中 ${suite.name} ... `);

  /* 依存関係は無いが、Chrome とポートの競合を避けるため直列に実行する。 */
  /* eslint-disable-next-line no-await-in-loop */
  const result = await runSuite(suite);
  results.push(result);

  if (result.crashed) {
    console.log('異常終了');
  } else if (result.fail > 0) {
    console.log(`NG (${result.pass}/${result.pass + result.fail})`);
  } else {
    console.log(`ok (${result.pass})`);
  }
}

/* ---- 失敗の詳細 ---- */

const broken = results.filter((r) => r.crashed || r.fail > 0);

if (broken.length > 0) {
  console.log('\n================ 失敗の詳細 ================');

  for (const result of broken) {
    console.log(`\n--- ${result.suite.name} (${relative(repoRoot, resolve(here, result.suite.file))}) ---`);

    if (result.crashed) {
      console.log('結果行が出力されませんでした。スイートが途中で落ちています。');
      console.log(result.stdout.split('\n').slice(-25).join('\n'));
      console.log(result.stderr.split('\n').slice(-25).join('\n'));
      continue;
    }

    /* NG の行だけを抜き出す。 */
    result.stdout
      .split('\n')
      .filter((line) => line.includes('  NG   '))
      .forEach((line) => console.log(line));
  }
}

/* ---- 集計 ---- */

const width = Math.max(...results.map((r) => r.suite.name.length)) + 2;
let totalPass = 0;
let totalFail = 0;

console.log('\n================ 結果 ================');

for (const result of results) {
  const total = result.pass + result.fail;
  totalPass += result.pass;
  totalFail += result.fail;

  const label = result.crashed ? '異常終了' : `${result.pass}/${total}`;
  console.log(`${result.suite.name.padEnd(width)}${label.padStart(10)}`);
}

console.log('-'.repeat(width + 10));
console.log(`${'合計'.padEnd(width - 2)}${`${totalPass}/${totalPass + totalFail}`.padStart(10)}`);

/*
 * 異常終了したスイートは結果行を出さないため、
 * その中の件数は上の合計に入っていない。
 *
 * これを書かないと「合計 401/401」だけが目に入り、
 * 全部通ったように読めてしまう。
 * 終了コードは 1 なので機械は正しく判定するが、人が誤読する。
 */
const crashedCount = results.filter((r) => r.crashed).length;

if (crashedCount > 0) {
  console.log(
    `\n★ ${crashedCount} スイートが異常終了しました。`
    + '上の合計には、そのスイートの件数が含まれていません。',
  );
}

if (totalFail > 0 || broken.length > 0) {
  const parts = [];

  if (totalFail > 0) {
    parts.push(`不合格 ${totalFail} 件`);
  }

  if (crashedCount > 0) {
    parts.push(`異常終了 ${crashedCount} スイート`);
  }

  console.log(`\n${parts.join(' / ')}`);
  process.exit(1);
}

console.log('\nすべて成功しました。');
process.exit(0);

/*
 * 本番認証システム（gas-auth / auth / 各画面）のテスト実行役。
 *
 * 使い方（リポジトリのルートから）:
 *   npm run test:auth-system            … 全部
 *   npm run test:auth-system unit       … Node のみ（Chrome 不要）
 *   npm run test:auth-system browser    … 実ブラウザのみ
 *
 * 既存の apps/tests/run.mjs とは別物。
 * /apps/ 配下（テスト環境）のテストはそちらが担当し、
 * ここでは本番認証系だけを見る。
 *
 * ------------------------------------------------------------------
 * スイートを別プロセスで動かす理由
 * ------------------------------------------------------------------
 * 各スイートは Apps Script 環境の偽物を組み立て、
 * グローバル（localStorage / document / location）も差し替える。
 * 1プロセスにまとめると前のスイートの状態が次へ漏れ、
 * 結果が実行順に依存する。
 * ------------------------------------------------------------------
 *
 * 各スイートは最後に `TESTRESULT <pass> <fail>` を出力する。
 */

import { spawn } from 'node:child_process';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const SUITES = [
  { name: 'crypto', file: 'unit/crypto.mjs', kind: 'unit' },
  { name: 'password', file: 'unit/password.mjs', kind: 'unit' },
  { name: 'tokens-sessions', file: 'unit/tokens-sessions.mjs', kind: 'unit' },
  { name: 'login', file: 'unit/login.mjs', kind: 'unit' },
  { name: 'stripe', file: 'unit/stripe.mjs', kind: 'unit' },
  { name: 'consent', file: 'unit/consent.mjs', kind: 'unit' },
  { name: 'legal', file: 'unit/legal.mjs', kind: 'unit' },
  { name: 'setup', file: 'unit/setup.mjs', kind: 'unit' },
  { name: 'frontend', file: 'unit/frontend.mjs', kind: 'unit' },
  { name: 'event-pricing', file: 'unit/event-pricing.mjs', kind: 'unit' },
  { name: 'event-mail', file: 'unit/event-mail.mjs', kind: 'unit' },
  { name: 'event-application', file: 'unit/event-application.mjs', kind: 'unit' },
  { name: 'browser:auth-screens', file: 'browser/auth-screens.mjs', kind: 'browser' },
];

const mode = process.argv[2] ?? 'all';

function selectSuites() {
  if (mode === 'all') return SUITES;
  if (mode === 'unit' || mode === 'browser') return SUITES.filter((s) => s.kind === mode);
  return SUITES.filter((s) => s.name === mode);
}

const selected = selectSuites();

if (selected.length === 0) {
  console.error(`不明な指定: ${mode}`);
  console.error('使える値: all / unit / browser / スイート名');
  process.exit(1);
}

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
        crashed: !match,
      });
    });
  });
}

console.log(`本番認証システムのテスト: ${mode}（${selected.length} スイート）\n`);

const results = [];

for (const suite of selected) {
  process.stdout.write(`  実行中 ${suite.name} ... `);

  /* Chrome とポートの競合を避けるため直列に実行する。 */
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

    result.stdout
      .split('\n')
      .filter((line) => line.includes('  NG   '))
      .forEach((line) => console.log(line));
  }
}

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
 * 異常終了したスイートは結果行を出さないため、その件数は上の合計に入らない。
 * 「合計は全部通っている」と誤読されないよう、明示する。
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

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

import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChild, killAllLiveChildren, liveChildCount } from './helpers/run-child.mjs';
import { sweepStaleProfiles } from './helpers/chrome.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

/*
 * スイート1本の上限時間。
 *
 * ------------------------------------------------------------------
 * 上限を設ける理由
 * ------------------------------------------------------------------
 * スイートは finish() で process.exit() を呼ばず、自然終了に任せている
 * （Windows で内部ハンドルの警告が出るため）。
 *
 * この設計では、ハンドルが1つでも解放され残ると
 * プロセスが永久に終わらない。上限が無いと実行役ごと止まり、
 * CI では時間切れまで気づけない。
 *
 * 実測（10スイート合計 約2分15秒、ブラウザ1本あたり約30秒）に対して
 * 十分な余裕を取る。正常なテストを打ち切らないことを優先する。
 * ------------------------------------------------------------------
 */
const TIMEOUT_MS = Object.freeze({
  unit: Number(process.env.TEST_TIMEOUT_UNIT_MS ?? 120_000),
  browser: Number(process.env.TEST_TIMEOUT_BROWSER_MS ?? 300_000),
});

/*
 * スイート一覧。
 * browser のものは Chrome を起動するため、時間がかかる。
 */
const SUITES = [
  { name: 'runner', file: 'unit/runner.mjs', kind: 'unit', groups: ['runner'] },
  { name: 'shared', file: 'unit/shared.mjs', kind: 'unit', groups: ['shared'] },
  { name: 'shared-dom', file: 'unit/shared-dom.mjs', kind: 'unit', groups: ['shared'] },
  { name: 'auth', file: 'unit/auth.mjs', kind: 'unit', groups: ['auth'] },
  { name: 'supabase', file: 'unit/supabase.mjs', kind: 'unit', groups: ['auth'] },
  { name: 'paths', file: 'unit/paths.mjs', kind: 'unit', groups: ['auth', 'audit'] },
  { name: 'audit', file: 'unit/audit.mjs', kind: 'unit', groups: ['auth', 'audit'] },
  { name: 'card-manager', file: 'unit/card-manager.mjs', kind: 'unit', groups: ['card-manager'] },
  { name: 'browser:login-flow', file: 'browser/login-flow.mjs', kind: 'browser', groups: ['auth'] },
  { name: 'browser:phase3-screens', file: 'browser/phase3-screens.mjs', kind: 'browser', groups: ['auth'] },
  { name: 'browser:audit', file: 'browser/audit.mjs', kind: 'browser', groups: ['auth', 'audit'] },
  { name: 'browser:google-links', file: 'browser/google-links.mjs', kind: 'browser', groups: ['auth'] },
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
  console.error('使える値: all / unit / browser / runner / shared / auth / audit / card-manager');
  process.exit(1);
}

/* ---- 実行 ---- */

async function runSuite(suite) {
  const outcome = await runChild(process.execPath, [resolve(here, suite.file)], {
    cwd: repoRoot,
    timeoutMs: TIMEOUT_MS[suite.kind] ?? TIMEOUT_MS.unit,
  });

  const match = outcome.stdout.match(/TESTRESULT (\d+) (\d+)/);

  return {
    suite,
    ...outcome,
    pass: match ? Number(match[1]) : 0,
    fail: match ? Number(match[2]) : 0,
    /* 結果行が出ていない＝途中で落ちた。 */
    crashed: !match,
  };
}

/*
 * 実行役が途中で死んでも、子（とその先の Chrome）を残さない。
 *
 * exit ハンドラでは非同期処理ができないため、同期的に終わらせる。
 * これが無いと、Ctrl+C や上位のタイムアウトで実行役だけが消え、
 * Chrome・HTTPサーバー・ポートが掴まれたままになる。
 */
process.on('exit', () => {
  killAllLiveChildren();
});

['SIGINT', 'SIGTERM'].forEach((signal) => {
  process.on(signal, () => {
    console.log(`\n${signal} を受け取りました。実行中のスイートを終了します。`);
    killAllLiveChildren();
    /* 128 + シグナル番号。中断であることが終了コードから分かる。 */
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
});

process.on('uncaughtException', (error) => {
  console.error('\n実行役で想定しない例外が発生しました:', error?.message ?? error);
  killAllLiveChildren();
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('\n実行役で未処理のPromise拒否が発生しました:', reason?.message ?? reason);
  killAllLiveChildren();
  process.exit(1);
});

/*
 * 前回の残骸を先に片付ける。
 * タイムアウトで打ち切られたスイートは SIGKILL で死ぬため、
 * 自前の終了フックが動かず、一時プロファイルが残る。
 */
const swept = await sweepStaleProfiles();

if (swept > 0) {
  console.log(`前回の一時プロファイルを ${swept} 件片付けました。`);
}

console.log(`テスト実行: ${mode}（${selected.length} スイート）\n`);

const startedAt = Date.now();
const results = [];

for (const suite of selected) {
  process.stdout.write(`  実行中 ${suite.name} ... `);

  /* 依存関係は無いが、Chrome とポートの競合を避けるため直列に実行する。 */
  /* eslint-disable-next-line no-await-in-loop */
  const result = await runSuite(suite);
  results.push(result);

  if (result.timedOut) {
    console.log(`タイムアウト (${Math.round(result.durationMs / 1000)}秒)`);
  } else if (result.spawnError) {
    console.log('起動失敗');
  } else if (result.crashed) {
    console.log('異常終了');
  } else if (result.fail > 0) {
    console.log(`NG (${result.pass}/${result.pass + result.fail})`);
  } else {
    console.log(`ok (${result.pass})`);
  }
}

/* ---- 失敗の詳細 ---- */

function describeOutcome(result) {
  if (result.spawnError) return '起動失敗';
  if (result.timedOut) return 'タイムアウト';
  if (result.crashed) return '異常終了';
  return `不合格 ${result.fail} 件`;
}

const broken = results.filter((r) => r.crashed || r.fail > 0);

if (broken.length > 0) {
  console.log('\n================ 失敗の詳細 ================');

  for (const result of broken) {
    console.log(`\n--- ${result.suite.name} (${relative(repoRoot, resolve(here, result.suite.file))}) ---`);

    /* 何が起きたのかを、推測させずに書く。 */
    console.log(`種別: ${describeOutcome(result)}`);
    console.log(`所要: ${Math.round(result.durationMs / 1000)}秒`
      + `  exit code: ${result.code ?? '-'}  signal: ${result.signal ?? '-'}`);

    if (result.spawnError) {
      console.log(`起動できませんでした: ${result.spawnError}`);
      continue;
    }

    if (result.timedOut) {
      console.log(
        `上限 ${Math.round((TIMEOUT_MS[result.suite.kind] ?? TIMEOUT_MS.unit) / 1000)}秒 を超えたため打ち切りました。`
        + '\n  スイートが自然終了できていない可能性があります'
        + '（Chrome・HTTPサーバー・WebSocket のいずれかが閉じていない）。'
        + `\n  上限を変える場合は環境変数 ${result.suite.kind === 'browser' ? 'TEST_TIMEOUT_BROWSER_MS' : 'TEST_TIMEOUT_UNIT_MS'} を設定してください。`,
      );
    }

    if (result.crashed) {
      if (!result.timedOut) {
        console.log('結果行が出力されませんでした。スイートが途中で落ちています。');
      }
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

  let label = `${result.pass}/${total}`;

  if (result.timedOut) {
    label = 'タイムアウト';
  } else if (result.spawnError) {
    label = '起動失敗';
  } else if (result.crashed) {
    label = '異常終了';
  }

  console.log(`${result.suite.name.padEnd(width)}${label.padStart(12)}`);
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

const timedOutCount = results.filter((r) => r.timedOut).length;

/* 後始末の結果も書く。残っていれば次回の実行が失敗するため。 */
const leftover = liveChildCount();

if (leftover > 0) {
  console.log(`\n★ 追跡中の子プロセスが ${leftover} 件残っています。`);
}

if (totalFail > 0 || broken.length > 0) {
  const parts = [];

  if (totalFail > 0) {
    parts.push(`不合格 ${totalFail} 件`);
  }

  if (timedOutCount > 0) {
    parts.push(`タイムアウト ${timedOutCount} スイート`);
  }

  if (crashedCount - timedOutCount > 0) {
    parts.push(`異常終了 ${crashedCount - timedOutCount} スイート`);
  }

  console.log(`\n${parts.join(' / ')}`);
  process.exit(1);
}

console.log(`\nすべて成功しました。（${Math.round((Date.now() - startedAt) / 1000)}秒）`);
process.exit(0);

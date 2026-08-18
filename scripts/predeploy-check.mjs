/*
 * デプロイ前の安全確認（`npm run deploy` 系の先頭で実行される）。
 *
 * 2026-08-18 に、origin/main の内容を含まない古いクローンからの
 * `npm run deploy` が本番を上書きし、直前にデプロイ済みの機能
 * （meeting-minutes の Google ドライブ保存）が消える事故が起きた。
 * このリポジトリのデプロイは手動運用（CLAUDE.md「配信構成」）で、
 * どの作業コピーからでも実行できてしまうこと自体は変えられない。
 * そこで deploy スクリプトの先頭にこの確認を挟み、
 * 「origin/main より古い内容を本番へ送る」操作を既定で止める。
 *
 * 確認は2つ。
 *   1. HEAD が origin/main を含んでいる（= 取り込み漏れがない）
 *   2. コミットされていない実変更が無い（改行コードだけの差は無視する。
 *      Windows / WSL の併用で CR だけの差が大量に出ることがあるため）
 *
 * 意図的に例外を通すときは、環境変数で明示する。
 *   DEPLOY_ALLOW_BEHIND=1 … origin/main を含まない状態のデプロイを許す
 *                           （例: 障害時に既知の安定コミットへ意図的に戻す）
 *   DEPLOY_ALLOW_DIRTY=1  … 未コミットの変更を含むデプロイを許す
 *
 * git fetch が失敗した場合（オフライン等）は警告して続行する。
 * ネットワーク断でデプロイ自体を不能にしないための判断で、その場合の
 * 比較対象は「前回 fetch 時点の origin/main」になる。
 *
 * 依存を持たない素の Node スクリプト（AGENTS.md: 外部ライブラリを足さない）。
 * Windows / WSL のどちらの Node でも動く。
 */

import { execFileSync } from 'node:child_process';

function fail(lines) {
  console.error('\n[predeploy-check] デプロイを中止しました。\n');
  for (const line of lines) {
    console.error(`  ${line}`);
  }
  console.error('');
  process.exit(1);
}

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...options }).trim();
}

/* git が使えない環境では安全側に倒して止める（デプロイは git クローンから行う前提）。 */
try {
  git(['rev-parse', '--is-inside-work-tree']);
} catch {
  fail([
    'git を実行できませんでした。',
    'デプロイはこのリポジトリの git 作業コピーから、git を PATH に通して実行してください。',
  ]);
}

/* 1. origin/main の取り込み確認 */

try {
  git(['fetch', '--quiet', 'origin', 'main']);
} catch {
  console.warn('[predeploy-check] 警告: git fetch に失敗しました。前回取得時点の origin/main と比較します。');
}

let behind = false;

try {
  git(['merge-base', '--is-ancestor', 'origin/main', 'HEAD']);
} catch {
  behind = true;
}

if (behind && process.env.DEPLOY_ALLOW_BEHIND !== '1') {
  let missing = '';
  try {
    missing = git(['rev-list', '--count', 'HEAD..origin/main']);
  } catch {
    /* 件数が取れなくても中止の判断は変わらない。 */
  }

  fail([
    'この作業コピーは origin/main の内容を含んでいません'
      + (missing ? `（origin/main 側に未取り込みのコミットが ${missing} 件あります）。` : '。'),
    'このままデプロイすると、他所で main へ取り込み済みの変更が本番から消えます。',
    '',
    '対処: git pull（または git merge origin/main）で取り込んでから deploy を実行してください。',
    '意図的に古い内容へ戻す場合のみ: DEPLOY_ALLOW_BEHIND=1 を付けて再実行してください。',
  ]);
}

/* 2. 未コミット変更の確認（改行コードだけの差は無視） */

function dirtyFiles(extraArgs) {
  try {
    const out = git(['diff', '--ignore-cr-at-eol', '--name-only', ...extraArgs]);
    return out === '' ? [] : out.split('\n');
  } catch {
    return [];
  }
}

const dirty = [...new Set([...dirtyFiles([]), ...dirtyFiles(['--cached'])])];

if (dirty.length > 0 && process.env.DEPLOY_ALLOW_DIRTY !== '1') {
  fail([
    'コミットされていない変更があります:',
    ...dirty.slice(0, 10).map((f) => `  - ${f}`),
    ...(dirty.length > 10 ? [`  …ほか ${dirty.length - 10} 件`] : []),
    '',
    '対処: コミット（と main への取り込み）を済ませてから deploy を実行してください。',
    '未コミットのままデプロイする場合のみ: DEPLOY_ALLOW_DIRTY=1 を付けて再実行してください。',
  ]);
}

console.log('[predeploy-check] OK: origin/main を含み、未コミットの実変更はありません。');

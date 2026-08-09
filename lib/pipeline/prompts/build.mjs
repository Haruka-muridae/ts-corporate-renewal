/*
 * 生成物を書き出す。
 *
 *   node lib/pipeline/prompts/build.mjs         書き出す
 *   node lib/pipeline/prompts/build.mjs --check  差分があれば失敗する（CI 向け）
 *
 * ==================================================================
 * --check があるのはなぜか
 * ==================================================================
 * definitions.mjs を直したのに生成物を作り直し忘れると、
 * **リポジトリ上のテキストと実際に使うプロンプトが食い違う。**
 * 貼り直す運用（Flow）では特に気づきにくい。
 *
 * `tests/unit/pipeline-prompts.mjs` がこの --check 相当を行うため、
 * 作り直し忘れはテストで落ちる。
 * ==================================================================
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAllFlowTexts } from './flow-text.mjs';
import { buildGasSource } from './gas-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

/** 生成物の一覧。テスト側もここを読む。 */
export function outputs() {
  const files = [
    {
      path: resolve(repoRoot, 'gas-isso', 'Prompts.gs'),
      content: buildGasSource(),
    },
  ];

  for (const { fileName, content } of buildAllFlowTexts()) {
    files.push({
      path: resolve(repoRoot, 'docs', 'pipeline', 'flow-text', fileName),
      content,
    });
  }

  return files;
}

/** 差分のあるファイルを返す。無ければ空配列。 */
export function diff() {
  return outputs().filter(({ path, content }) => {
    if (!existsSync(path)) {
      return true;
    }

    /* 改行コードの差だけで落とさない（Windows で編集された場合に備える）。 */
    return readFileSync(path, 'utf8').replace(/\r\n/g, '\n') !== content;
  });
}

function write() {
  for (const { path, content } of outputs()) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
    console.log(`  書き出し: ${path.slice(repoRoot.length + 1)}`);
  }
}

/* 直接実行されたときだけ動く。import しても副作用が出ないようにする。 */
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  if (process.argv.includes('--check')) {
    const stale = diff();

    if (stale.length === 0) {
      console.log('生成物は最新です。');
      process.exitCode = 0;
    } else {
      console.error('生成物が古いか、ありません:');
      for (const { path } of stale) {
        console.error(`  ${path.slice(repoRoot.length + 1)}`);
      }
      console.error('\nnode lib/pipeline/prompts/build.mjs で作り直してください。');
      process.exitCode = 1;
    }
  } else {
    write();
    console.log('完了。**生成物は手で編集しないこと。**');
  }
}

/*
 * ソースの静的検査。
 *
 * 外部の静的解析ツールを増やさずに、この構成で問題になりやすい点だけを機械的に見る。
 *   - 解決できない相対 import / 存在しない named export
 *   - 他から参照されていない export（死にコードの候補）
 *   - 危険なDOM API・秘密情報らしき文字列
 *   - 空の catch、console 直呼び
 *   - addEventListener と removeEventListener の対応
 *
 * 実行: npm run test:static
 * 失敗（exit 1）になるのは「壊れている」ものだけ。
 * 参考情報は警告として出すだけで、失敗にはしない。
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const srcDir = resolve(root, 'src');

let errors = 0;
let warnings = 0;

const fail = (message) => { errors += 1; console.log(`  NG   ${message}`); };
const warn = (message) => { warnings += 1; console.log(`  警告 ${message}`); };
const ok = (message) => console.log(`  ok   ${message}`);

async function collect(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collect(full, out);
    } else if (full.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

const files = await collect(srcDir);
const rel = (p) => relative(root, p).replace(/\\/g, '/');

const sources = new Map();
for (const file of files) {
  sources.set(file, await readFile(file, 'utf8'));
}

/* ---------- 1. import / export の整合 ---------- */

console.log('--- import / export の整合 ---');

const EXPORT_DECL = /export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/g;
const EXPORT_LIST = /export\s*\{([^}]+)\}/g;
const IMPORT_STMT = /import\s+([^;]*?)\s+from\s+['"]([^'"]+)['"]/g;
const SIDE_EFFECT_IMPORT = /import\s+['"]([^'"]+)['"]/g;

const exportsByFile = new Map();
const importsByFile = new Map();
const bareSpecifiers = new Set();

for (const [file, src] of sources) {
  const names = new Set();

  for (const match of src.matchAll(EXPORT_DECL)) {
    names.add(match[1]);
  }
  for (const match of src.matchAll(EXPORT_LIST)) {
    match[1].split(',').forEach((part) => {
      const alias = part.trim().split(/\s+as\s+/).pop();
      if (alias) names.add(alias.trim());
    });
  }

  exportsByFile.set(file, names);

  const list = [];

  for (const match of src.matchAll(IMPORT_STMT)) {
    const spec = match[2];

    if (!spec.startsWith('.')) {
      bareSpecifiers.add(spec);
      continue;
    }

    const named = [];
    const braces = /\{([^}]*)\}/.exec(match[1]);

    if (braces) {
      braces[1].split(',').forEach((part) => {
        const original = part.trim().split(/\s+as\s+/)[0];
        if (original) named.push(original.trim());
      });
    }

    list.push({ spec, named, target: resolve(dirname(file), spec) });
  }

  for (const match of src.matchAll(SIDE_EFFECT_IMPORT)) {
    const spec = match[1];
    if (spec.startsWith('.')) {
      list.push({ spec, named: [], target: resolve(dirname(file), spec) });
    }
  }

  importsByFile.set(file, list);
}

console.log(`  外部パッケージ: ${[...bareSpecifiers].sort().join(', ')}`);

let importProblems = 0;

for (const [file, list] of importsByFile) {
  for (const entry of list) {
    if (!sources.has(entry.target)) {
      /* CSS などは対象外。 */
      if (/\.(css|json)$/.test(entry.spec)) {
        continue;
      }
      fail(`解決できない import: ${rel(file)} -> ${entry.spec}`);
      importProblems += 1;
      continue;
    }

    const available = exportsByFile.get(entry.target);

    for (const name of entry.named) {
      if (!available.has(name)) {
        fail(`存在しない export: ${rel(file)} -> ${entry.spec} :: ${name}`);
        importProblems += 1;
      }
    }
  }
}

if (importProblems === 0) {
  ok('すべての相対 import が解決できる');
}

/* ---------- 2. 参照されていない export ---------- */

console.log('--- 参照されていない export（死にコード候補） ---');

const used = new Set();

for (const list of importsByFile.values()) {
  for (const entry of list) {
    for (const name of entry.named) {
      used.add(`${entry.target}::${name}`);
    }
  }
}

/* 将来拡張用と、エントリから直接使うものは対象外にする。 */
const IGNORE_UNUSED = [/src[\\/]future[\\/]/, /src[\\/]main\.js$/];

let unused = 0;

for (const [file, names] of exportsByFile) {
  if (IGNORE_UNUSED.some((re) => re.test(file))) {
    continue;
  }
  for (const name of names) {
    if (!used.has(`${file}::${name}`)) {
      warn(`未参照: ${rel(file)} :: ${name}`);
      unused += 1;
    }
  }
}

if (unused === 0) {
  ok('未参照の export なし');
}

/* ---------- 3. 危険なAPI・秘密情報 ---------- */

console.log('--- 危険なAPI / 秘密情報 ---');

const DANGEROUS = [
  { re: /\.innerHTML\s*=/, label: 'innerHTML への代入' },
  { re: /\.outerHTML\s*=/, label: 'outerHTML への代入' },
  { re: /insertAdjacentHTML\s*\(/, label: 'insertAdjacentHTML' },
  { re: /document\.write\s*\(/, label: 'document.write' },
  { re: /\beval\s*\(/, label: 'eval' },
  { re: /new\s+Function\s*\(/, label: 'Function コンストラクタ' },
  { re: /setTimeout\s*\(\s*['"]/, label: 'setTimeout への文字列' },
  { re: /localStorage\./, label: 'localStorage 利用' },
  { re: /sessionStorage\./, label: 'sessionStorage 利用' },
  { re: /document\.cookie/, label: 'cookie 利用' },
  /*
   * PUT / PATCH / DELETE はどこにも書かせない。
   * POST は「フォルダ作成の唯一の経路」である drive-writer.js だけ許す
   * （下の allowIn を参照）。他のファイルに現れたら失敗させる。
   */
  { re: /method:\s*['"](PUT|PATCH|DELETE)['"]/, label: '禁止された書き込みHTTPメソッド' },
  { re: /method:\s*['"]POST['"]/, label: '想定外の POST', allowIn: /drive[\\/]drive-writer\.js$/ },
  /*
   * アップロード経路も drive-writer.js だけに閉じる。
   * 使うのはセットアップの「サンプルファイル作成」1か所からのみ。
   */
  {
    re: /uploadType|\/upload\//,
    label: '想定外の Drive アップロード経路',
    /* URL の定義は config.js、実際の呼び出しは drive-writer.js だけに閉じる。 */
    allowIn: /(drive[\\/]drive-writer\.js|src[\\/]config\.js)$/,
  },
  { re: /client_secret|clientSecret|GOCSPX|refresh_token|private_key/, label: '秘密情報らしき文字列' },
  { re: /\bya29\./, label: 'アクセストークンらしき文字列' },
];

let dangerous = 0;

for (const [file, src] of sources) {
  src.split('\n').forEach((line, index) => {
    /* コメント行は対象外（説明文に語が出てくるため）。 */
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
      return;
    }

    for (const rule of DANGEROUS) {
      if (!rule.re.test(line)) {
        continue;
      }
      /* 例外を認めたファイルだけは通す（経路を1か所に閉じ込めるため）。 */
      if (rule.allowIn && rule.allowIn.test(file)) {
        continue;
      }
      fail(`${rule.label}: ${rel(file)}:${index + 1}`);
      dangerous += 1;
    }
  });
}

/*
 * 書き込み経路が1ファイルに閉じていることを、逆方向からも確かめる。
 * drive-writer.js 以外に fetch(..., { method: ... }) が現れたら異常。
 */
const writerFiles = [...sources.keys()].filter((file) => /method:\s*['"]POST['"]/.test(sources.get(file)));

if (writerFiles.length === 1 && /drive-writer\.js$/.test(writerFiles[0])) {
  ok('非GETの経路は drive-writer.js の1ファイルだけ');
} else {
  fail(`非GETの経路が想定外のファイルにある: ${writerFiles.map(rel).join(', ')}`);
  dangerous += 1;
}

if (dangerous === 0) {
  ok('危険なAPI・秘密情報なし');
}

/* ---------- 4. console 直呼び ---------- */

console.log('--- console の直接利用 ---');

let consoleCalls = 0;

for (const [file, src] of sources) {
  src.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) {
      return;
    }
    if (/\bconsole\.(log|warn|error|info|debug)\s*\(/.test(line)) {
      /* logger.js は本番で出力を止める作りなので許可する。 */
      if (/core[\\/]logger\.js$/.test(file)) {
        return;
      }
      fail(`console 直呼び: ${rel(file)}:${index + 1}`);
      consoleCalls += 1;
    }
  });
}

if (consoleCalls === 0) {
  ok('logger 以外に console の直接利用なし');
}

/* ---------- 5. 空 catch ---------- */

console.log('--- 空の catch ---');

let emptyCatch = 0;

for (const [file, src] of sources) {
  /* コメントだけの catch は「意図的に無視」として許容する。 */
  for (const match of src.matchAll(/catch\s*(?:\([^)]*\))?\s*\{([\s\S]*?)\}/g)) {
    const body = match[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').trim();
    if (body === '') {
      const before = src.slice(0, match.index);
      const line = before.split('\n').length;
      const hadComment = /\/\*|\/\//.test(match[1]);
      if (!hadComment) {
        fail(`理由の書かれていない空 catch: ${rel(file)}:${line}`);
        emptyCatch += 1;
      }
    }
  }
}

if (emptyCatch === 0) {
  ok('空 catch はすべて理由が書かれている');
}

/* ---------- 6. TODO 等 ---------- */

console.log('--- 未完成マーカー ---');

let markers = 0;

for (const [file, src] of sources) {
  src.split('\n').forEach((line, index) => {
    if (/\b(TODO|FIXME|HACK|XXX|TEMP)\b/.test(line)) {
      warn(`未完成マーカー: ${rel(file)}:${index + 1} ${line.trim().slice(0, 80)}`);
      markers += 1;
    }
  });
}

if (markers === 0) {
  ok('TODO / FIXME / HACK なし');
}

/* ---------- 7. イベントリスナの解除 ---------- */

console.log('--- window / document へのリスナ ---');

let listeners = 0;

for (const [file, src] of sources) {
  for (const match of src.matchAll(/(window|document|globalThis)\.addEventListener\(\s*['"]([^'"]+)['"]/g)) {
    const before = src.slice(0, match.index);
    listeners += 1;
    /* 情報として出す。解除が必要かは呼び出し側の寿命による。 */
    warn(`${match[1]}.addEventListener('${match[2]}') : ${rel(file)}:${before.split('\n').length}`);
  }
}

if (listeners === 0) {
  ok('window / document への恒久リスナなし');
}

console.log(`\n静的検査: エラー ${errors} 件 / 警告 ${warnings} 件`);
process.exit(errors === 0 ? 0 : 1);

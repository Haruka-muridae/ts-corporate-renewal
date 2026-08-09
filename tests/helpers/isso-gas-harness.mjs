/*
 * gas-isso/*.gs を Node 上で読み込むための最小のハーネス。
 *
 * ==================================================================
 * なぜ gas-auth のハーネスを使わないのか
 * ==================================================================
 * `tests/helpers/gas-harness.mjs` は**本番認証系（gas-auth）専用**で、
 * 偽の Drive・Spreadsheet・MailApp を丸ごと組み立てている。
 * 読み込み先も gas-auth に固定されている。
 *
 * 一想のために手を入れると、**本番認証系のテスト基盤を別系統の都合で
 * 変えることになる**（CLAUDE.md「片方の都合でもう片方を変えない」／
 * repository-structure §4-1・§5-3 の「共通層を作らない・複製する」）。
 *
 * ==================================================================
 * そして、そもそも大きな偽物が要らない
 * ==================================================================
 * `Sheets.gs` は SpreadsheetApp を1か所に閉じ、その外は
 * **テーブルアクセサ**（read / create / append / writeAt / deleteAt）
 * に対して書いてある。テストは `IssoSheets_memoryTables()` を差すだけでよく、
 * **SpreadsheetApp の偽物は1行も要らない。**
 *
 * ここで用意するのは、`.gs` を評価する器と、
 * `PropertiesService` / `Utilities` の最小の代役だけ。
 * ==================================================================
 */

import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const GAS_DIR = resolve(here, '..', '..', 'gas-isso');

/**
 * gas-isso の `.gs` を読み込み、定義された関数・変数を返す。
 *
 * @param {{ properties?: Record<string, string>, uuids?: string[], now?: string }} [options]
 */
export function loadIssoGas(options = {}) {
  const properties = { ...(options.properties ?? {}) };

  /* テストで固定できるよう、順に払い出す。使い切ったら連番へ落とす。 */
  const uuids = [...(options.uuids ?? [])];
  let uuidCount = 0;

  const PropertiesService = {
    getScriptProperties() {
      return {
        getProperty(name) {
          return Object.prototype.hasOwnProperty.call(properties, name)
            ? properties[name]
            : null;
        },
        setProperty(name, value) {
          properties[name] = String(value);
        },
      };
    },
  };

  /*
   * 署名は**本物を使う。**
   *
   * `computeHmacSignature` を偽物にすると、OAuth 1.0a の検証が
   * 「自分で決めた答えと一致するか」になってしまい、何も確かめられない。
   * Node の crypto は Apps Script と同じ HMAC-SHA1 / base64 を計算するので、
   * **署名文字列の組み立て（ここが間違えやすい）を実際の値で確かめられる。**
   */
  const Utilities = {
    getUuid() {
      uuidCount += 1;
      return uuids.length > 0 ? uuids.shift() : `uuid-${uuidCount}`;
    },
    MacAlgorithm: { HMAC_SHA_1: 'HMAC_SHA_1' },
    computeHmacSignature(algorithm, value, key) {
      if (algorithm !== 'HMAC_SHA_1') {
        throw new Error(`未対応のアルゴリズムです: ${algorithm}`);
      }

      /* Apps Script はバイト配列を返す。base64Encode がそれを受ける。 */
      return createHmac('sha1', key).update(value, 'utf8').digest();
    },
    base64Encode(bytes) {
      return Buffer.from(bytes).toString('base64');
    },
  };

  /*
   * SpreadsheetApp と UrlFetchApp は**意図的に用意しない。**
   *
   * テストが実シート経路（IssoSheets_spreadsheetTables）や
   * 実通信経路（IssoHttp_fetch の中身）を触ったら、
   * ここで ReferenceError になって気づける。**気づかずに素通りするより、
   * その場で落ちたほうがよい。**
   *
   * 投稿系は `deps.fetch` を差し替えて検証する。**実キーも実通信も要らず、
   * 401・403・429・5xx のような「実物では起こしにくい失敗」まで確かめられる。**
   */

  /* 読み込み順を固定する。Config.gs の定数を他が参照するため。 */
  const files = readdirSync(GAS_DIR)
    .filter((name) => name.endsWith('.gs'))
    .sort((a, b) => (a === 'Config.gs' ? -1 : b === 'Config.gs' ? 1 : a.localeCompare(b)));

  const sources = files.map((name) => readFileSync(join(GAS_DIR, name), 'utf8'));
  const code = sources.join('\n;\n');

  /*
   * 公開する名前をソースから拾う。
   *
   * 固定のリストにすると、`.gs` を足すたびにここも直すことになり、
   * **直し忘れたときに「関数が undefined」という分かりにくい失敗**になる。
   * 行頭の宣言だけを見るので、関数の中の var は拾わない。
   */
  const names = new Set();

  for (const match of code.matchAll(/^function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
    names.add(match[1]);
  }

  for (const match of code.matchAll(/^var\s+([A-Za-z_$][\w$]*)\s*=/gm)) {
    names.add(match[1]);
  }

  if (names.size === 0) {
    throw new Error('gas-isso から公開できる宣言が見つかりませんでした。');
  }

  const exportList = [...names].map((name) => `${name}: ${name}`).join(', ');

  /*
   * すべてを1つのスコープで評価する。Apps Script はファイルを分けても
   * グローバルを共有するため、その振る舞いに合わせる。
   */
  const exported = new Function(
    'PropertiesService',
    'Utilities',
    `${code}\n;return { ${exportList} };`,
  )(PropertiesService, Utilities);

  return { ...exported, files, properties, exportedNames: [...names] };
}

/**
 * 定義どおりの見出しを持つ空のシート一式を作り、ポートを返す。
 *
 * ほとんどのテストはここから始められる。
 */
export function createIssoStore(gas, seed) {
  const tables = gas.IssoSheets_memoryTables(seed);
  const store = gas.IssoSheets_create(tables);

  if (seed === undefined) {
    store.ensureSheets();
  }

  return { store, tables };
}

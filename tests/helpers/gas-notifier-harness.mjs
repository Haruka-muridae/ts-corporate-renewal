/*
 * 配布用GAS（gas-notifier/*.gs）を Node 上で動かすための土台。
 *
 * ==================================================================
 * gas-harness.mjs と分けてある理由
 * ==================================================================
 * 本番認証系（gas-auth/）とは、必要な Apps Script サービスが違う。
 * こちらは Calendar（Advanced Service）・ScriptApp（トリガー）・Session が要り、
 * 逆に Drive・MailApp・CacheService は使わない。
 * また、スコープが spreadsheets.currentonly なので
 * 「ID で別ファイルを開く」という gas-auth の前提そのものが無い。
 * ==================================================================
 *
 * ==================================================================
 * jsrsasign の本体は読み込まない
 * ==================================================================
 * lib_jsrsasign.gs には貼り付け先とスタブしか入っていない（本体は利用者が貼る）。
 * ここでは KEYUTIL / KJUR の偽物を差し込み、鍵の形と JWT の組み立て方だけを見る。
 * 実物の ES256 署名が通ることは、利用者の環境で verifyJsrsasign() を
 * 実行して確かめる（docs/external-dependency-approvals.md §1-4）。
 * ==================================================================
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '../..');
const GAS_DIR = join(REPO_ROOT, 'gas-notifier');

/* ---------- 偽のスプレッドシート ---------- */

class FakeRange {
  constructor(sheet, row, column, numRows, numColumns) {
    this.sheet = sheet;
    this.row = row;
    this.column = column;
    this.numRows = numRows;
    this.numColumns = numColumns;
  }

  getValues() {
    const out = [];

    for (let r = 0; r < this.numRows; r += 1) {
      const source = this.sheet.rows[this.row - 1 + r] ?? [];
      const line = [];

      for (let c = 0; c < this.numColumns; c += 1) {
        const value = source[this.column - 1 + c];
        line.push(value === undefined || value === null ? '' : value);
      }

      out.push(line);
    }

    return out;
  }

  setValues(values) {
    for (let r = 0; r < values.length; r += 1) {
      const target = this.sheet.ensureRow(this.row - 1 + r);

      for (let c = 0; c < values[r].length; c += 1) {
        target[this.column - 1 + c] = values[r][c];
      }
    }

    return this;
  }

  setValue(value) {
    this.sheet.ensureRow(this.row - 1)[this.column - 1] = value;
    return this;
  }
}

class FakeSheet {
  constructor(name) {
    this.name = name;
    /* rows[0] がヘッダー。 */
    this.rows = [];
  }

  getName() {
    return this.name;
  }

  ensureRow(index) {
    while (this.rows.length <= index) {
      this.rows.push([]);
    }

    return this.rows[index];
  }

  getLastRow() {
    return this.rows.length;
  }

  getRange(row, column, numRows = 1, numColumns = 1) {
    return new FakeRange(this, row, column, numRows, numColumns);
  }

  appendRow(values) {
    this.rows.push(values.slice());
    return this;
  }

  deleteRow(rowNumber) {
    this.rows.splice(rowNumber - 1, 1);
    return this;
  }

  setFrozenRows() {
    return this;
  }
}

class FakeSpreadsheet {
  constructor(name) {
    this.name = name;
    this.sheets = [];
  }

  getName() {
    return this.name;
  }

  getSheetByName(name) {
    return this.sheets.find((sheet) => sheet.name === name) ?? null;
  }

  insertSheet(name) {
    const sheet = new FakeSheet(name);
    this.sheets.push(sheet);
    return sheet;
  }
}

/* ---------- 偽の jsrsasign ---------- */

/*
 * 公開鍵は非圧縮形式（0x04 + X + Y = 65バイト）でなければならない。
 * 実物と同じ長さの16進文字列を返し、hexToBase64Url_ の変換を実際に通す。
 */
const FAKE_PUB_KEY_HEX = `04${'ab'.repeat(64)}`;

function base64UrlOf(text) {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function makeFakeJsrsasign(record) {
  return {
    KEYUTIL: {
      generateKeypair(algorithm, curve) {
        record.generated.push({ algorithm, curve });

        return {
          prvKeyObj: { kind: 'private' },
          pubKeyObj: { kind: 'public', pubKeyHex: FAKE_PUB_KEY_HEX },
        };
      },

      getPEM(key, format) {
        if (format === 'PKCS8PRV') {
          return '-----BEGIN PRIVATE KEY-----\nFAKE-PRIVATE\n-----END PRIVATE KEY-----';
        }

        return '-----BEGIN PUBLIC KEY-----\nFAKE-PUBLIC\n-----END PUBLIC KEY-----';
      },
    },

    KJUR: {
      jws: {
        JWS: {
          sign(algorithm, header, payload, key) {
            record.signed.push({
              algorithm,
              header: JSON.parse(header),
              payload: JSON.parse(payload),
              key,
            });

            return `${base64UrlOf(header)}.${base64UrlOf(payload)}.fake-signature`;
          },

          verify() {
            return true;
          },
        },
      },
    },
  };
}

/* ---------- 環境の組み立て ---------- */

/**
 * Apps Script 環境を1つ作る。
 *
 * options:
 *   properties  … Script Properties の初期値
 *   now         … 現在時刻（ミリ秒）
 *   email       … Session.getEffectiveUser().getEmail() の戻り
 *   serviceUrl  … ScriptApp.getService().getUrl() の戻り（'' なら未デプロイ）
 */
export function createNotifierEnvironment({
  properties = {},
  now = Date.UTC(2026, 7, 10, 0, 0, 0),
  email = 'owner@example.com',
  serviceUrl = 'https://script.google.com/macros/s/AKfake/exec',
} = {}) {
  const scriptProperties = { ...properties };
  const book = new FakeSpreadsheet('TSAM AI 録音通知');
  const logs = [];
  const fetchCalls = [];
  const fetchHandlers = [];
  const jsrsasignRecord = { generated: [], signed: [] };

  let triggers = [];
  let currentTime = now;
  let lockHeld = false;
  let currentEmail = email;
  let currentServiceUrl = serviceUrl;
  let calendarItems = [];
  let calendarCalls = [];

  const sandbox = {
    console,

    Date: class extends Date {
      constructor(...args) {
        if (args.length === 0) {
          super(currentTime);
          return;
        }

        super(...args);
      }

      static now() {
        return currentTime;
      }
    },

    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => (
          Object.prototype.hasOwnProperty.call(scriptProperties, key)
            ? scriptProperties[key]
            : null
        ),
        setProperty: (key, value) => {
          scriptProperties[key] = String(value);
        },
        deleteProperty: (key) => {
          delete scriptProperties[key];
        },
      }),
    },

    SpreadsheetApp: {
      getActive: () => book,
      getActiveSpreadsheet: () => book,
      flush: () => {},
    },

    Utilities: {
      getUuid: () => randomUUID(),

      /* 符号付きバイト配列（-128..127）を受ける。Apps Script と同じ。 */
      base64EncodeWebSafe: (bytes) => {
        const buffer = Buffer.from(bytes.map((b) => ((b % 256) + 256) % 256));
        return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
      },
    },

    LockService: {
      getScriptLock: () => ({
        tryLock: () => {
          if (lockHeld) {
            return false;
          }

          lockHeld = true;
          return true;
        },
        releaseLock: () => {
          lockHeld = false;
        },
        hasLock: () => lockHeld,
      }),
    },

    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (trigger) => {
        triggers = triggers.filter((item) => item !== trigger);
      },
      newTrigger: (handler) => ({
        timeBased: () => ({
          everyMinutes: (minutes) => ({
            create: () => {
              const trigger = {
                minutes,
                getHandlerFunction: () => handler,
              };

              triggers.push(trigger);
              return trigger;
            },
          }),
        }),
      }),
      getService: () => ({ getUrl: () => currentServiceUrl }),
    },

    Session: {
      getEffectiveUser: () => ({ getEmail: () => currentEmail }),
    },

    /* Advanced Service（Calendar v3）。 */
    Calendar: {
      Events: {
        list: (calendarId, options) => {
          calendarCalls.push({ calendarId, options });
          return { items: calendarItems };
        },
      },
    },

    UrlFetchApp: {
      fetch: (url, options) => {
        fetchCalls.push({ url, options });

        for (const handler of fetchHandlers) {
          const result = handler(url, options);

          if (result) {
            return {
              getResponseCode: () => result.status ?? 200,
              getContentText: () => (
                typeof result.body === 'string' ? result.body : JSON.stringify(result.body ?? {})
              ),
            };
          }
        }

        return {
          getResponseCode: () => 201,
          getContentText: () => '',
        };
      },
    },

    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({
        content: text,
        setMimeType() { return this; },
        getContent() { return this.content; },
      }),
    },

    Logger: {
      log: (value) => {
        logs.push(String(value));
      },
    },
  };

  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  /* .gs をファイル名順に読み込む。宣言だけなので順序に依存しない。 */
  const files = readdirSync(GAS_DIR)
    .filter((name) => name.endsWith('.gs'))
    .sort();

  for (const name of files) {
    const code = readFileSync(join(GAS_DIR, name), 'utf8');
    vm.runInContext(code, sandbox, { filename: `gas-notifier/${name}` });
  }

  /*
   * 偽の jsrsasign は .gs の読み込み後に差し込む。
   * lib_jsrsasign.gs のスタブ（var window / var navigator）を上書きしないため。
   */
  const fake = makeFakeJsrsasign(jsrsasignRecord);
  sandbox.KEYUTIL = fake.KEYUTIL;
  sandbox.KJUR = fake.KJUR;

  return {
    api: sandbox,
    properties: scriptProperties,
    book,
    logs,
    fetchCalls,
    jsrsasign: jsrsasignRecord,

    getTriggers: () => triggers.slice(),

    setTime(ms) {
      currentTime = ms;
      return currentTime;
    },

    advance(ms) {
      currentTime += ms;
      return currentTime;
    },

    getTime() {
      return currentTime;
    },

    setEmail(value) {
      currentEmail = value;
    },

    setServiceUrl(value) {
      currentServiceUrl = value;
    },

    /* Calendar.Events.list が返す予定を差し替える。 */
    setCalendarItems(items) {
      calendarItems = items;
    },

    getCalendarCalls() {
      return calendarCalls.slice();
    },

    /* UrlFetchApp の応答を差し込む。先に登録したものから試す。 */
    onFetch(handler) {
      fetchHandlers.push(handler);
    },

    clearFetchHandlers() {
      fetchHandlers.length = 0;
    },

    clearFetchCalls() {
      fetchCalls.length = 0;
    },

    /* シートの中身を { header: value } の配列で読む（検査用）。 */
    readSheet(name) {
      const sheet = book.getSheetByName(name);

      if (!sheet || sheet.rows.length < 2) {
        return [];
      }

      const header = sheet.rows[0];

      return sheet.rows.slice(1).map((row) => {
        const out = {};

        header.forEach((key, index) => {
          out[key] = row[index] === undefined ? '' : row[index];
        });

        return out;
      });
    },

    /* doGet / doPost の戻り値を JSON にする。 */
    readOutput(output) {
      return JSON.parse(output.getContent());
    },
  };
}

/** セットアップ済みの環境。ほとんどのテストはこちらを使う。 */
export function createReadyNotifierEnvironment(options = {}) {
  const env = createNotifierEnvironment(options);

  env.api.setupNotifier();

  return env;
}

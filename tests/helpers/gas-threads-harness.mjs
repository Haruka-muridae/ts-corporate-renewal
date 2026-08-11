/*
 * Threads 投稿 MVP（gas-threads/*.gs）を Node 上で動かすための土台。
 *
 * gas-notifier-harness.mjs を出発点に、この MVP が使うサービスだけに
 * 絞ってある（MailApp / Session / HtmlService / everyMinutes トリガー、
 * そして生成機能用の UrlFetchApp。Threads への投稿は intent リンク方式の
 * ため外部通信しない——UrlFetchApp を使うのは Gemini だけ）。
 * 分けてあるのは他のハーネスと同じ理由で、必要なサービスの形が違うため。
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '../..');
const GAS_DIR = join(REPO_ROOT, 'gas-threads');

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

/* ---------- 環境の組み立て ---------- */

/**
 * Apps Script 環境を1つ作る。
 *
 * options:
 *   properties … Script Properties の初期値
 *   now        … 現在時刻（ミリ秒）
 *   email      … Session.getEffectiveUser().getEmail() の戻り
 *   mailError  … MailApp.sendEmail を失敗させたいときにメッセージを入れる
 */
export function createThreadsEnvironment({
  properties = {},
  now = Date.UTC(2026, 7, 11, 0, 0, 0),
  email = 'owner@example.com',
} = {}) {
  const scriptProperties = { ...properties };
  const book = new FakeSpreadsheet('Threads 投稿 MVP');
  const logs = [];
  const sentMails = [];
  const fetchCalls = [];
  const fetchHandlers = [];

  let triggers = [];
  let currentTime = now;
  let lockHeld = false;
  let currentEmail = email;
  let mailError = null;

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
              const trigger = { minutes, getHandlerFunction: () => handler };
              triggers.push(trigger);
              return trigger;
            },
          }),
        }),
      }),
    },

    Session: {
      getEffectiveUser: () => ({ getEmail: () => currentEmail }),
    },

    MailApp: {
      sendEmail: (options) => {
        if (mailError) {
          throw new Error(mailError);
        }

        sentMails.push({ ...options });
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
          getResponseCode: () => 404,
          getContentText: () => JSON.stringify({ error: { message: 'no handler' } }),
        };
      },
    },

    HtmlService: {
      createHtmlOutputFromFile: (name) => ({
        name,
        title: '',
        setTitle(value) {
          this.title = value;
          return this;
        },
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
    vm.runInContext(code, sandbox, { filename: `gas-threads/${name}` });
  }

  return {
    api: sandbox,
    properties: scriptProperties,
    book,
    logs,
    sentMails,
    fetchCalls,

    /* UrlFetchApp の応答を差し込む。先に登録したものから試す。 */
    onFetch(handler) {
      fetchHandlers.push(handler);
    },

    clearFetchHandlers() {
      fetchHandlers.length = 0;
    },

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

    /* MailApp.sendEmail を失敗させる（null で戻す）。 */
    setMailError(message) {
      mailError = message;
    },

    /* ロックを外から握る（トリガーの同時発火を再現する）。 */
    holdLock() {
      lockHeld = true;
    },

    releaseLock() {
      lockHeld = false;
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

    /* シートに**実際に格納された**生の値（エスケープの検査用）。 */
    rawRows(name) {
      const sheet = book.getSheetByName(name);
      return sheet ? sheet.rows.map((row) => row.slice()) : null;
    },
  };
}

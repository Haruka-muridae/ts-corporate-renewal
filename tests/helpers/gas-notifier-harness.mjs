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
 * V2 では署名も判定もこの中で起きない
 * ==================================================================
 * どちらも運営の Workers（notifier-gate）が行う。ここでは UrlFetchApp の
 * 応答を差し替えて「ゲートがこう答えたとき、テンプレートがどう振る舞うか」を見る。
 * 判定そのものの正しさは notifier-gate スイートが持つ。
 * ==================================================================
 */

import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '../..');
const GAS_DIR = join(REPO_ROOT, 'gas-notifier');

/**
 * Apps Script のバイト配列は符号付き（-128..127）。
 * Utilities.* が返す値を実物と同じ形にする。
 */
function toSignedBytes(buffer) {
  return Array.from(buffer, (value) => (value > 127 ? value - 256 : value));
}

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
  scriptId = 'SCRIPT-ID-FAKE',
} = {}) {
  const scriptProperties = { ...properties };
  const book = new FakeSpreadsheet('TSAM AI 録音通知');
  const logs = [];
  const fetchCalls = [];
  const fetchHandlers = [];

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

      /* Apps Script は符号付きバイト配列を返す。呼び出し側がそれ前提で書いている。 */
      computeHmacSha256Signature: (value, key) => toSignedBytes(
        createHmac('sha256', String(key)).update(String(value), 'utf8').digest(),
      ),

      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },

      computeDigest: (algorithm, value) => {
        if (algorithm !== 'SHA_256') {
          throw new Error(`未対応のダイジェスト: ${algorithm}`);
        }

        return toSignedBytes(createHash('sha256').update(String(value), 'utf8').digest());
      },

      newBlob: (text) => ({
        getBytes: () => toSignedBytes(Buffer.from(String(text), 'utf8')),
      }),
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

      getScriptId: () => scriptId,

      /*
       * 実物はアクセストークン。**この値がクライアントへ渡らないこと**を
       * テストが見張れるよう、それと分かる文字列にしてある。
       */
      getOAuthToken: () => 'FAKE-OAUTH-TOKEN',
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

  return {
    api: sandbox,
    properties: scriptProperties,
    book,
    logs,
    fetchCalls,

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

/**
 * ゲート（notifier-gate）の公開オリジン。
 * 正本は workers/notifier-gate/origin.mjs で、一致は notifier-gate スイートが見る。
 */
export const GATE_ORIGIN = 'https://notifier-gate.potenitas-lp.workers.dev';

/**
 * ゲートの偽物を差し込む。
 *
 * 判定そのものの正しさは notifier-gate スイートが持つ。ここで確かめたいのは
 * 「ゲートがこう答えたとき、テンプレートがどう振る舞うか」なので、
 * 応答は呼び出し側が決められるようにしてある。
 *
 * 戻り値の calls に、送られた本文が順に入る（何を送ったかの検査に使う）。
 */
export function installGateStub(env, {
  licenseState = 'active',
  evaluate = null,
  publicKey = 'FAKE-VAPID-PUBLIC-KEY',
  jwt = 'fake.jwt.value',
  vapidStatus = 200,
  /* vapidStatus が 200 以外のときに返す符号。上限（429）の検証に使う。 */
  vapidError = 'LICENSE_EXPIRED',
  /* 429 のときに添える「窓が明けるまでの秒数」。0 なら添えない（古いゲートの再現）。 */
  vapidRetryAfterSec = 0,
  evaluateStatus = 200,
  testNotifyStatus = 200,
} = {}) {
  const calls = [];

  env.onFetch((url, options) => {
    if (String(url).indexOf(GATE_ORIGIN) !== 0) {
      return null;
    }

    const path = String(url).slice(GATE_ORIGIN.length);
    const body = JSON.parse(options.payload);

    calls.push({ path, body });

    if (path === '/v1/evaluate') {
      if (evaluateStatus !== 200) {
        return { status: evaluateStatus, body: { ok: false, error: { code: 'RATE_LIMITED', message: '' } } };
      }

      const decided = evaluate
        ? evaluate(body)
        : { notify: body.events.map((event) => ({
          eid: event.eid,
          feature: 'calendar',
          timing: body.settings.timingMin,
          startAt: event.startAt,
          notifyAt: new Date(Date.parse(event.startAt) - body.settings.timingMin * 60000).toISOString(),
        })), remove: [] };

      return {
        status: 200,
        body: { ok: true, notify: decided.notify || [], remove: decided.remove || [], licenseState },
      };
    }

    if (path === '/v1/vapid') {
      if (vapidStatus !== 200) {
        const failure = { ok: false, error: { code: vapidError, message: '' } };

        if (vapidRetryAfterSec > 0) {
          /* 本物と同じく**最上位**へ置く（error の中ではない）。 */
          failure.retryAfterSec = vapidRetryAfterSec;
        }

        return { status: vapidStatus, body: failure };
      }

      const jwts = {};

      for (const audience of body.audiences) {
        jwts[audience] = `${jwt}:${audience}`;
      }

      return {
        status: 200,
        body: {
          ok: true,
          publicKey,
          jwts,
          expiresAt: new Date(env.getTime() + 12 * 60 * 60 * 1000).toISOString(),
          licenseState,
        },
      };
    }

    if (path === '/v1/test-notify') {
      if (testNotifyStatus !== 200) {
        return { status: testNotifyStatus, body: { ok: false, error: { code: 'RATE_LIMITED', message: '' } } };
      }

      return { status: 200, body: { ok: true, licenseState } };
    }

    return { status: 404, body: { ok: false, error: { code: 'INVALID_ACTION', message: '' } } };
  });

  return calls;
}

/**
 * セットアップ済みの環境。ほとんどのテストはこちらを使う。
 *
 * licenseKey を渡すと、録音アプリから受け取り済みの状態にする
 * （実運用では saveLicense 経由で入る）。
 */
export function createReadyNotifierEnvironment({
  licenseKey = 'LK'.padEnd(43, 'x'),
  webAppUrl = 'https://script.google.com/macros/s/AKdeployed/exec',
  ...options
} = {}) {
  const env = createNotifierEnvironment(options);

  env.api.setupNotifier();

  if (licenseKey) {
    env.properties.LICENSE_KEY = licenseKey;
  }

  /*
   * 公開済みの状態にする。
   *
   * **getService().getUrl() では代用できない。** 実機の不具合を受けて、
   * 公開したという事実は deployWebApp() が保存した WEBAPP_URL だけが
   * 持つようにした（gas-notifier/Setup.gs の webAppUrl_）。
   * 未公開の状態を試したいテストは webAppUrl: '' を渡す。
   */
  if (webAppUrl) {
    env.properties.WEBAPP_URL = webAppUrl;
  }

  return env;
}

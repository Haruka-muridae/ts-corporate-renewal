/*
 * Apps Script のコード（gas-auth/*.gs）を Node 上で動かすための土台。
 *
 * ==================================================================
 * なぜ必要か
 * ==================================================================
 * 認証の中身（ハッシュ、トークン、ロック、Webhook の冪等性）は、
 * 実際に動かさないと確かめられない。しかし Apps Script には
 * 自動テストの仕組みが無く、実行するたびに本番のスプレッドシートへ
 * 書き込んでしまう。
 *
 * そこで Apps Script のサービス（SpreadsheetApp / Utilities / LockService …）
 * をメモリ上の偽物に差し替え、.gs をそのまま vm で読み込む。
 * 本番コードは1行も変えずに、Node から関数を呼んで検証できる。
 * ==================================================================
 *
 * ------------------------------------------------------------------
 * 偽物の忠実さについて
 * ------------------------------------------------------------------
 * 特に気をつけた点:
 *   - バイト配列は **符号付き（-128..127）** で返す。
 *     Apps Script の Utilities がそうであり、ここを符号なしにすると
 *     16進変換や XOR の不具合を見逃す。
 *   - computeHmacSha256Signature は文字列版とバイト配列版の
 *     両方の呼び出し方に対応する（PBKDF2 が後者を使う）。
 *   - getLastRow() は「ヘッダーを含む行数」を返す。
 * ------------------------------------------------------------------
 */

import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '../..');
const GAS_DIR = join(REPO_ROOT, 'gas-auth');

/* ---------- バイト配列の変換 ---------- */

/* Buffer → Apps Script 相当の符号付き配列。 */
function toSignedBytes(buffer) {
  const out = [];

  for (let i = 0; i < buffer.length; i += 1) {
    out.push(buffer[i] > 127 ? buffer[i] - 256 : buffer[i]);
  }

  return out;
}

/* 符号付き配列・文字列・Buffer のいずれでも Buffer にする。 */
function toBuffer(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    return Buffer.from(value.map((b) => ((b % 256) + 256) % 256));
  }

  return Buffer.from(String(value), 'utf8');
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

  /* 入力規則は挙動に関係しないため、受け取って捨てる。 */
  setDataValidation() {
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

  /* ヘッダーを含む行数。データが無くヘッダーだけなら 1。 */
  getLastRow() {
    return this.rows.length;
  }

  getMaxRows() {
    return Math.max(this.rows.length, 1);
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
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.sheets = [];
  }

  getId() {
    return this.id;
  }

  getName() {
    return this.name;
  }

  getSheets() {
    return this.sheets.slice();
  }

  getSheetByName(name) {
    return this.sheets.find((sheet) => sheet.name === name) ?? null;
  }

  insertSheet(name) {
    const sheet = new FakeSheet(name);
    this.sheets.push(sheet);
    return sheet;
  }

  deleteSheet(sheet) {
    this.sheets = this.sheets.filter((item) => item !== sheet);
  }
}

/* ---------- 偽の Drive ---------- */

class FakeFolder {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.folders = [];
    this.files = [];
  }

  getId() {
    return this.id;
  }

  getName() {
    return this.name;
  }

  getFoldersByName(name) {
    return makeIterator(this.folders.filter((folder) => folder.name === name));
  }

  createFolder(name) {
    const folder = new FakeFolder(`folder-${randomUUID()}`, name);
    this.folders.push(folder);
    return folder;
  }

  getFilesByName(name) {
    return makeIterator(this.files.filter((file) => file.name === name));
  }

  /* プレビューHTMLの書き出しで使う。 */
  createFile(name, content, mimeType) {
    const file = new FakeFile(`file-${randomUUID()}`, name, mimeType);
    file.content = String(content);
    file.parent = this;
    this.files.push(file);
    return file;
  }
}

class FakeFile {
  constructor(id, name, mimeType) {
    this.id = id;
    this.name = name;
    this.mimeType = mimeType;
    this.parent = null;
    this.content = '';
  }

  setContent(value) {
    this.content = String(value);
    return this;
  }

  getBlob() {
    return { getDataAsString: () => this.content };
  }

  getUrl() {
    return `https://drive.example/file/${this.id}`;
  }

  getId() {
    return this.id;
  }

  getName() {
    return this.name;
  }

  getMimeType() {
    return this.mimeType;
  }

  moveTo(folder) {
    if (this.parent) {
      this.parent.files = this.parent.files.filter((file) => file !== this);
    }

    folder.files.push(this);
    this.parent = folder;
    return this;
  }
}

/* ID からフォルダを探す。数が少ないため木をたどるだけで足りる。 */
function findFolderById(folder, id) {
  if (folder.id === id) {
    return folder;
  }

  for (const child of folder.folders) {
    const found = findFolderById(child, id);

    if (found) {
      return found;
    }
  }

  return null;
}

function makeIterator(items) {
  let index = 0;

  return {
    hasNext: () => index < items.length,
    next: () => items[index++],
  };
}

/* ---------- 環境の組み立て ---------- */

/*
 * Apps Script 環境を1つ作る。
 * 戻り値の api から .gs 内の関数を呼べる。
 *
 * options:
 *   properties … Script Properties の初期値
 *   now        … 現在時刻（ミリ秒）。時間の経過を作れるよう可変にする
 */
export function createGasEnvironment({ properties = {}, now = Date.UTC(2026, 6, 29, 0, 0, 0) } = {}) {
  const scriptProperties = { ...properties };
  const spreadsheets = new Map();
  const driveFiles = new Map();
  const rootFolder = new FakeFolder('root', 'マイドライブ');
  const cache = new Map();
  const logs = [];
  const sentMails = [];

  /* UrlFetchApp の応答をテストごとに差し替えるための入れ物。 */
  const fetchHandlers = [];
  const fetchCalls = [];

  let currentTime = now;
  let lockHeld = false;

  function registerSpreadsheet(name) {
    const id = `sheet-${spreadsheets.size + 1}-${randomUUID().slice(0, 8)}`;
    const book = new FakeSpreadsheet(id, name);
    spreadsheets.set(id, book);

    const file = new FakeFile(id, name, 'application/vnd.google-apps.spreadsheet');
    driveFiles.set(id, file);

    return book;
  }

  const sandbox = {
    console,

    /* --- 時計 --- */
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

    /* --- Properties --- */
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

    /* --- Spreadsheet --- */
    SpreadsheetApp: {
      openById: (id) => {
        const book = spreadsheets.get(id);

        if (!book) {
          throw new Error(`No spreadsheet: ${id}`);
        }

        return book;
      },
      create: (name) => registerSpreadsheet(name),
      getActiveSpreadsheet: () => null,
      flush: () => {},
      newDataValidation: () => ({
        requireValueInRange: () => ({
          setAllowInvalid: () => ({ build: () => ({}) }),
        }),
      }),
    },

    /* --- Drive --- */
    DriveApp: {
      getRootFolder: () => rootFolder,
      getFileById: (id) => {
        const file = driveFiles.get(id);

        if (!file) {
          throw new Error(`No file: ${id}`);
        }

        return file;
      },
      getFolderById: (id) => {
        const found = findFolderById(rootFolder, id);

        if (!found) {
          throw new Error(`No folder: ${id}`);
        }

        return found;
      },
    },

    MimeType: {
      GOOGLE_SHEETS: 'application/vnd.google-apps.spreadsheet',
      HTML: 'text/html',
    },

    /* --- Utilities --- */
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },

      getUuid: () => randomUUID(),

      computeDigest: (algorithm, value) => toSignedBytes(
        createHash('sha256').update(toBuffer(value)).digest(),
      ),

      /*
       * 文字列同士でも、バイト配列同士でも呼ばれる。
       * Apps Script と同じく、どちらの組み合わせも受け付ける。
       */
      computeHmacSha256Signature: (value, key) => toSignedBytes(
        createHmac('sha256', toBuffer(key)).update(toBuffer(value)).digest(),
      ),

      base64Encode: (value) => toBuffer(value).toString('base64'),

      newBlob: (value) => ({
        getBytes: () => toSignedBytes(Buffer.from(String(value), 'utf8')),
      }),
    },

    /* --- Lock --- */
    LockService: {
      getScriptLock: () => ({
        tryLock: () => {
          if (lockHeld) {
            /* 同じ実行から二重に取ろうとしたら失敗する（本番と同じ）。 */
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

    /* --- Cache --- */
    CacheService: {
      getScriptCache: () => ({
        get: (key) => (cache.has(key) ? cache.get(key) : null),
        put: (key, value) => {
          cache.set(key, String(value));
        },
      }),
    },

    /* --- Mail --- */
    MailApp: {
      sendEmail: (options) => {
        sentMails.push({ ...options });
      },
    },

    /* --- 外部通信 --- */
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

    /* --- 出力 --- */
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
    vm.runInContext(code, sandbox, { filename: `gas-auth/${name}` });
  }

  return {
    /* .gs の関数・変数はここから呼ぶ。 */
    api: sandbox,

    /* --- 検査・操作用 --- */
    properties: scriptProperties,
    logs,
    sentMails,
    fetchCalls,
    spreadsheets,
    rootFolder,

    /* 時間を進める。 */
    advance(ms) {
      currentTime += ms;
      return currentTime;
    },

    setTime(ms) {
      currentTime = ms;
      return currentTime;
    },

    getTime() {
      return currentTime;
    },

    /* UrlFetchApp の応答を差し込む。先に登録したものから試す。 */
    onFetch(handler) {
      fetchHandlers.push(handler);
    },

    clearFetchHandlers() {
      fetchHandlers.length = 0;
    },

    /* doGet / doPost の戻り値（ContentService）を JSON にする。 */
    readOutput(output) {
      return JSON.parse(output.getContent());
    },
  };
}

/*
 * セットアップ済みの環境を作る。ほとんどのテストはこちらを使う。
 *
 * setupAuthSystem() を実際に呼ぶため、
 * Drive・スプレッドシート・シート・既定設定・管理者レコードが揃う。
 */
export function createReadyEnvironment({ appBaseUrl = 'https://tsam-ai.example/', ...options } = {}) {
  const env = createGasEnvironment(options);

  env.api.setupAuthSystem();

  /*
   * APP_BASE_URL は setupAuthSystem() では決められない（運用者が入れる）。
   * 未設定のままだとメール内のURLを組み立てられず、案内メールが送られない。
   * 実運用と同じ条件にするため、ここで入れておく。
   *
   * 「未設定だと送られない」こと自体は login スイートで別途確認する。
   */
  if (appBaseUrl) {
    setSetting(env, 'APP_BASE_URL', appBaseUrl);
  }

  /* テストのたびに実物へ通信しないよう、Stripe は既定で未設定にしておく。 */
  env.api.clearSettingsCache_();

  return env;
}

/* 設定シートの値を書き換える（運用中の変更を再現する）。 */
export function setSetting(env, key, value) {
  const book = env.api.getConfigSpreadsheet_();
  const sheet = book.getSheetByName('settings');
  const rows = sheet.rows;

  for (let i = 1; i < rows.length; i += 1) {
    if (String(rows[i][0]).trim() === key) {
      rows[i][1] = value;
      env.api.clearSettingsCache_();
      return;
    }
  }

  sheet.appendRow([key, value, '']);
  env.api.clearSettingsCache_();
}

/* users シートから1件取り出す（検査用）。 */
export function getUserRow(env, email) {
  return env.api.findUserByEmail_(email);
}

/* テスト用に、決済済み・パスワード設定済みの利用者を作る。 */
export function createActiveUser(env, {
  email = 'member@example.com',
  password = 'Member-Password-2026',
  subscriptionStatus = 'active',
  paymentExempt = false,
  role = 'member',
} = {}) {
  const user = env.api.withLock_(() => env.api.createUser_({
    email,
    role,
    subscriptionStatus,
    paymentExempt,
    accountStatus: 'pending',
  }));

  const issued = env.api.withLock_(
    () => env.api.issueToken_(user.userId, 'initial_setup'),
  );

  const result = env.api.performPasswordSet_({
    token: issued.token,
    password,
    passwordConfirm: password,
    expectedType: 'initial_setup',
  });

  if (!result.ok) {
    throw new Error(`テスト用利用者のパスワード設定に失敗: ${JSON.stringify(result.errorPair)}`);
  }

  return { user: env.api.findUserByEmail_(email), email, password };
}

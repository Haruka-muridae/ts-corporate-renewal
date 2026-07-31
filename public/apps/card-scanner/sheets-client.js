/*
 * Google スプレッドシート「名刺台帳（表裏対応 v3）」への追記。
 *
 * 担当するのは Sheets API v4 と、台帳を特定するための Drive 呼び出しだけ。
 * DOM操作・認可フロー・画面文言・項目の振り分けはここに置かない。
 *
 * ------------------------------------------------------------------
 * 新しいスコープは不要
 * ------------------------------------------------------------------
 * spreadsheets.create と spreadsheets.values.append は、
 * このアプリ自身が作成したスプレッドシートに対してであれば
 * 既存の drive.file スコープで動作する。
 * OAuth同意画面の設定は変更しないこと。
 *
 * ただし Google Cloud 側で **Sheets API の有効化** は必要。
 * 未有効の場合は 403 / accessNotConfigured が返るため、
 * API_DISABLED として区別できるようにしてある。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * 旧版との関係
 * ------------------------------------------------------------------
 * 14列（片面）→ 24列（表裏）→ 36列（拡張）と列が変わっている。
 * 列がずれたまま追記する事故を防ぐため、版ごとに台帳名とキャッシュキーを
 * 完全に分けてある。**旧台帳・旧キーは読み書きも削除もしない。**
 * 列を移行する処理や、見出しの不一致を検出して分岐する処理は持たない。
 * ------------------------------------------------------------------
 *
 * 台帳IDの解決も、フォルダと同じく localStorage を「キャッシュ」として扱う。
 * 正本は Drive 上の実体で、キャッシュは使う前に必ず files.get で検証する。
 */

import {
  COLUMN_DEFS,
  COLUMN_INDEX,
  EMAIL_HEADERS,
  SHEET_HEADERS,
  SHEET_RANGE,
  columnsToEmails,
  dedupeEmails,
  emailsToColumns,
  formatTags,
  normalizeEmail,
} from './fields.js';

import { DriveError, DriveErrorCode, getFileMeta } from './drive-ocr.js';
import { buildCardId, isCardId, nextCardSequence } from './metadata.js';

/* 36列の台帳。24列の v2、14列の旧台帳とは別物として扱う。 */
export const SPREADSHEET_NAME = '名刺台帳（表裏対応 v3）';
export const SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet';

/* スプレッドシートIDのキャッシュ先。IDは秘密情報ではない。 */
export const SPREADSHEET_ID_STORAGE_KEY = 'tsam-card-scanner-spreadsheet-id-v3';

const SHEETS_ENDPOINT = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_FILES_ENDPOINT = 'https://www.googleapis.com/drive/v3/files';

/* 読み書きする範囲。列数から fields.js が決める（36列なら A:AJ）。 */
const READ_RANGE = SHEET_RANGE;
/* 追記先。A:A を指定すると、表の最後の行の次に追加される。 */
const APPEND_RANGE = 'A:A';

/*
 * セルの長さの上限。
 * Sheets の1セルは50,000文字まで。OCR本文だけがこれに届きうる。
 * 短い列まで同じ上限で切ると、異常に長い値が入っても気付けないため分けてある。
 */
export const CELL_MAX_LENGTH = 50000;
export const SHORT_CELL_MAX_LENGTH = 1000;
const TRUNCATED_SUFFIX = '…（以降省略）';

/* カードIDの採番をやり直す上限。これを超えたら異常事態として扱う。 */
const CARD_ID_MAX_ATTEMPTS = 5;

export const SheetsErrorCode = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  API_DISABLED: 'API_DISABLED',
  RATE_LIMITED: 'RATE_LIMITED',
  NOT_FOUND: 'NOT_FOUND',
  NETWORK: 'NETWORK',
  SERVER_ERROR: 'SERVER_ERROR',
  /* カードIDの採番が規定回数で確定しなかった。 */
  CARD_ID_CONFLICT: 'CARD_ID_CONFLICT',
  UNKNOWN: 'UNKNOWN',
};

export class SheetsError extends Error {
  constructor(code, status = 0, detail = null) {
    super(code);
    this.name = 'SheetsError';
    this.code = code;
    this.status = status;
    /* detail には API のエラー理由だけを入れる。トークンは入れない。 */
    this.detail = detail;
  }
}

/* ---------- ログ出力の差し替え ---------- */

let logger = () => {};

export function setSheetsLogger(fn) {
  logger = typeof fn === 'function' ? fn : () => {};
}

/* ---------- 日時 ---------- */

function pad2(value) {
  return String(value).padStart(2, '0');
}

/*
 * YYYY/MM/DD HH:mm 形式。
 * valueInputOption=USER_ENTERED で送るため、Sheets 側が日時として解釈する。
 * ISO文字列だと文字列のまま入り、並べ替えや期間指定ができなくなる。
 *
 * 登録日時・更新日時・OCR実行日時のすべてでこの形式を使う。
 */
export function formatTimestamp(date = new Date()) {
  const day = [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join('/');

  return `${day} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/* ---------- セルの組み立て ---------- */

/*
 * 画像リンクのセル。
 * USER_ENTERED なので数式として解釈される。
 * URL内の " をエスケープして数式を壊さないようにする。
 *
 * **この関数の戻り値は escapeCellText へ通さないこと。**
 * 通すと先頭にアポストロフィが付き、数式ではなくただの文字列になる。
 */
export function buildImageFormula(imageLink, label) {
  if (!imageLink) {
    return '';
  }

  const safeUrl = String(imageLink).replace(/"/g, '""');
  const safeLabel = String(label).replace(/"/g, '""');

  return `=HYPERLINK("${safeUrl}","${safeLabel}")`;
}

/*
 * 数式として解釈されうるセルを、文字列として入れるための保護。
 *
 * 全体を valueInputOption=USER_ENTERED で送っているため、
 * = + - @ で始まる値は Sheets が数式と解釈し #NAME? になる。
 * 先頭にアポストロフィを付けると、表示は元のまま文字列として入る。
 *
 * maxLength は列の性質で使い分ける。
 *   OCR本文        … CELL_MAX_LENGTH（50,000）
 *   それ以外の文字列 … SHORT_CELL_MAX_LENGTH（1,000）
 */
export function escapeCellText(value, maxLength = SHORT_CELL_MAX_LENGTH) {
  let text = String(value ?? '');

  if (text === '') {
    return '';
  }

  if (text.length > maxLength) {
    text = text.slice(0, Math.max(0, maxLength - TRUNCATED_SUFFIX.length)) + TRUNCATED_SUFFIX;
  }

  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

/* OCR本文用。上限だけが違う。 */
export function escapeOcrText(value) {
  return escapeCellText(value, CELL_MAX_LENGTH);
}

/* ---------- 重複判定キー ---------- */

/*
 * 重複判定キーを作る。優先順位は次のとおりで、上から最初に作れたものを使う。
 *
 *   1. メインメールアドレス
 *   2. 携帯電話（数字だけを比較する）
 *   3. 会社名 + 氏名
 *
 * どれも作れない場合は空文字を返し、その行はキーによる判定の対象から外れる
 * （画像ハッシュやメール交差では引き続き判定される）。
 */
export function buildDuplicateKey(values) {
  const emails = dedupeEmails(values?.emails);
  const primary = normalizeEmail(values?.primaryEmail) || normalizeEmail(emails[0]);

  if (primary !== '') {
    return `email:${primary}`;
  }

  const mobile = String(values?.mobile ?? '').replace(/\D/g, '');

  if (mobile !== '') {
    return `mobile:${mobile}`;
  }

  const company = String(values?.company ?? '').replace(/\s+/g, '').toLowerCase();
  const name = String(values?.name ?? '').replace(/\s+/g, '').toLowerCase();

  if (company !== '' && name !== '') {
    return `company+name:${company}|${name}`;
  }

  return '';
}

/* ---------- 行の組み立て ---------- */

/*
 * auto 列の値を用意する。
 *
 * 列の定義（COLUMN_DEFS）と1対1で対応させ、ここに無いキーは空になる。
 * 列を増やしたら、fields.js と ここの2か所だけを直せばよい。
 *
 * 日時は3つとも別引数で受ける:
 *   createdAt … 登録日時。新規保存時に決まる
 *   updatedAt … 更新日時。新規保存では createdAt と同じ値を入れる。
 *                将来の編集保存で、createdAt を保ったままここだけ更新できる
 *   ocrAt     … OCR実行日時。再OCRしたときはここだけ更新する
 */
function buildAutoCells(input) {
  const {
    cardId = '',
    companyId = '',
    createdAt = new Date(),
    updatedAt = null,
    ocrAt = null,
    frontImageLink = '',
    backImageLink = '',
    frontText = '',
    backText = '',
    mergedText = '',
    ocrEngine = '',
    ocrConfidence = null,
    frontImageHash = '',
    backImageHash = '',
    orientation = '',
    language = '',
    values,
  } = input;

  return {
    cardId: escapeCellText(cardId),
    createdAt: formatTimestamp(createdAt),
    /* 新規保存では登録日時と同じ値になる。 */
    updatedAt: formatTimestamp(updatedAt ?? createdAt),
    /* OCRしていない場合は空のまま。 */
    ocrAt: ocrAt ? formatTimestamp(ocrAt) : '',
    companyId: escapeCellText(companyId),

    /* 数式として入れたいので escapeCellText を通さない。 */
    frontImageUrl: buildImageFormula(frontImageLink, '表面画像を見る'),
    backImageUrl: buildImageFormula(backImageLink, '裏面画像を見る'),

    frontOcr: escapeOcrText(frontText),
    backOcr: escapeOcrText(backText),
    mergedOcr: escapeOcrText(mergedText),

    ocrEngine: escapeCellText(ocrEngine),
    /* 0〜100の整数。数値として入れたいので文字列化しない。 */
    ocrConfidence: Number.isFinite(ocrConfidence) ? ocrConfidence : '',

    frontImageHash: escapeCellText(frontImageHash),
    backImageHash: escapeCellText(backImageHash),
    orientation: escapeCellText(orientation),
    language: escapeCellText(language),
    duplicateKey: escapeCellText(buildDuplicateKey(values)),
  };
}

/*
 * 1行分の配列を作る。列順は fields.js の COLUMN_DEFS が唯一の定義。
 * ここで順序を独自に決めないこと。全36列を必ず埋める（空でも列は出す）。
 */
export function buildRow(input) {
  const values = input?.values ?? {};
  const auto = buildAutoCells({ ...input, values });

  return COLUMN_DEFS.flatMap((column) => {
    if (column.kind === 'emails') {
      return emailsToColumns(values.emails, values.primaryEmail)
        .map((email) => escapeCellText(email));
    }

    if (column.kind === 'auto') {
      return [auto[column.key] ?? ''];
    }

    /* タグだけは配列・自由入力のどちらでも受けられるように整える。 */
    if (column.key === 'tags') {
      return [escapeCellText(formatTags(values.tags))];
    }

    return [escapeCellText(values[column.key] ?? '')];
  });
}

/* ---------- エラー分類 ---------- */

function extractReason(body) {
  const error = body?.error;

  if (!error) {
    return '';
  }

  if (Array.isArray(error.errors) && error.errors.length > 0) {
    return String(error.errors[0]?.reason ?? '');
  }

  return String(error.status ?? '');
}

export function mapHttpErrorToCode(status, body) {
  const reason = extractReason(body);
  const message = String(body?.error?.message ?? '');

  if (status === 401) {
    return SheetsErrorCode.UNAUTHORIZED;
  }

  if (status === 429) {
    return SheetsErrorCode.RATE_LIMITED;
  }

  if (status === 404) {
    return SheetsErrorCode.NOT_FOUND;
  }

  if (status === 403) {
    /* Sheets API が有効化されていない場合。管理者の設定が必要。 */
    if (reason === 'accessNotConfigured'
      || /has not been used in project|is disabled|API has not been used/i.test(message)) {
      return SheetsErrorCode.API_DISABLED;
    }

    if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded'
      || /rate limit/i.test(message)) {
      return SheetsErrorCode.RATE_LIMITED;
    }

    return SheetsErrorCode.FORBIDDEN;
  }

  if (status >= 500) {
    return SheetsErrorCode.SERVER_ERROR;
  }

  return SheetsErrorCode.UNKNOWN;
}

/* ---------- 低レベル呼び出し ---------- */

async function readJsonSafely(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/*
 * fetch を1か所に集約する。
 * fetchImpl を差し替えられるようにしてあるのはテスト用。
 * ここでも上位でも、トークンをログへ出さないこと。
 */
async function apiFetch(url, { token, method = 'GET', body = null, headers = {}, fetchImpl }) {
  const doFetch = fetchImpl ?? globalThis.fetch;

  if (typeof doFetch !== 'function') {
    throw new SheetsError(SheetsErrorCode.NETWORK, 0, 'fetch_unavailable');
  }

  let response;

  try {
    response = await doFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...headers,
      },
      body,
    });
  } catch (error) {
    throw new SheetsError(SheetsErrorCode.NETWORK, 0, error?.name ?? 'fetch_failed');
  }

  if (!response.ok) {
    const errorBody = await readJsonSafely(response);
    throw new SheetsError(
      mapHttpErrorToCode(response.status, errorBody),
      response.status,
      extractReason(errorBody) || null,
    );
  }

  return readJsonSafely(response);
}

/* ---------- IDのキャッシュ ---------- */

function readCachedId() {
  try {
    const value = globalThis.localStorage?.getItem(SPREADSHEET_ID_STORAGE_KEY);
    return typeof value === 'string' && value !== '' ? value : null;
  } catch {
    return null;
  }
}

function writeCachedId(spreadsheetId) {
  try {
    globalThis.localStorage?.setItem(SPREADSHEET_ID_STORAGE_KEY, spreadsheetId);
  } catch {
    /* 保存できなくても動作に支障はない（毎回検索するだけ）。 */
  }
}

function clearCachedId() {
  try {
    globalThis.localStorage?.removeItem(SPREADSHEET_ID_STORAGE_KEY);
  } catch {
    /* 何もしない。 */
  }
}

/* ---------- 台帳の特定 ---------- */

/* Drive の検索クエリでは \ と ' をエスケープする。 */
function escapeQueryValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/*
 * 以前このアプリが作った台帳を、指定フォルダの直下で探す。
 *
 * 親を条件に含めるのは、別の場所にある同名ファイルを掴まないため。
 * 同名が複数ある場合に備えて modifiedTime の新しい順で受け取る。
 */
async function searchSpreadsheets({ token, parentFolderId, fetchImpl }) {
  const params = new URLSearchParams({
    q: [
      `name='${escapeQueryValue(SPREADSHEET_NAME)}'`,
      `mimeType='${SPREADSHEET_MIME}'`,
      'trashed=false',
      `'${escapeQueryValue(parentFolderId)}' in parents`,
    ].join(' and '),
    fields: 'files(id,name,modifiedTime)',
    orderBy: 'modifiedTime desc',
    pageSize: '10',
    spaces: 'drive',
  });

  const result = await apiFetch(`${DRIVE_FILES_ENDPOINT}?${params}`, { token, fetchImpl });

  return Array.isArray(result?.files) ? result.files : [];
}

/*
 * キャッシュした台帳IDを検証する。
 *
 * 名前・親・種別・未削除まで確かめる。IDだけ生きていても、
 * 別のフォルダへ移動されていたら保存先として使わない。
 *
 * 404・403 はキャッシュを捨てて null。
 * 401・通信不良はキャッシュを残したまま投げる（フォルダ側と同じ方針）。
 */
async function verifyCachedSpreadsheet({ token, parentFolderId, fetchImpl }) {
  const cached = readCachedId();

  if (!cached) {
    return null;
  }

  let meta;

  try {
    meta = await getFileMeta(cached, { token, fetchImpl });
  } catch (error) {
    const dropped = error instanceof DriveError
      && (error.code === DriveErrorCode.NOT_FOUND || error.code === DriveErrorCode.FORBIDDEN);

    if (dropped) {
      clearCachedId();
      logger('sheets:cache-dropped', { reason: error.code });
      return null;
    }

    throw error;
  }

  const parents = Array.isArray(meta?.parents) ? meta.parents : [];

  const ok = meta
    && meta.trashed !== true
    && meta.mimeType === SPREADSHEET_MIME
    && String(meta.name ?? '') === SPREADSHEET_NAME
    && parents.includes(parentFolderId);

  if (!ok) {
    clearCachedId();
    logger('sheets:cache-dropped', { reason: 'mismatch' });
    return null;
  }

  return cached;
}

/* 見出し行を太字・背景色にし、1行目を固定する。作成直後に1回だけ実行する。 */
async function formatHeaderRow({ token, spreadsheetId, sheetId, fetchImpl }) {
  const requests = [
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: SHEET_HEADERS.length,
        },
        cell: {
          userEnteredFormat: {
            /* 既存サイトの配色に寄せた薄いグレー。読みやすさのためだけに使う。 */
            backgroundColor: { red: 0.95, green: 0.94, blue: 0.91 },
            textFormat: { bold: true },
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat)',
      },
    },
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    },
  ];

  await apiFetch(`${SHEETS_ENDPOINT}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
    token,
    fetchImpl,
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ requests }),
  });
}

/*
 * 台帳を新規作成し、指定フォルダへ移動する。
 *
 * spreadsheets.create は親を指定できないため、作成後に Drive API で
 * 親を付け替える。移動に失敗しても台帳自体は使えるので、全体は失敗にしない
 * （マイドライブ直下に残るだけ）。
 */
async function createSpreadsheet({ token, parentFolderId, fetchImpl }) {
  const created = await apiFetch(`${SHEETS_ENDPOINT}?fields=spreadsheetId,sheets.properties.sheetId`, {
    token,
    fetchImpl,
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({
      properties: { title: SPREADSHEET_NAME, locale: 'ja_JP', timeZone: 'Asia/Tokyo' },
    }),
  });

  const spreadsheetId = created?.spreadsheetId;

  if (!spreadsheetId) {
    throw new SheetsError(SheetsErrorCode.UNKNOWN, 0, 'spreadsheet_id_missing');
  }

  /* 見出し行を書き込む。 */
  const params = new URLSearchParams({ valueInputOption: 'USER_ENTERED' });
  const range = encodeURIComponent('A1');

  await apiFetch(`${SHEETS_ENDPOINT}/${encodeURIComponent(spreadsheetId)}/values/${range}?${params}`, {
    token,
    fetchImpl,
    method: 'PUT',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ values: [[...SHEET_HEADERS]] }),
  });

  if (parentFolderId) {
    try {
      const moveParams = new URLSearchParams({
        addParents: parentFolderId,
        fields: 'id,parents',
      });

      await apiFetch(
        `${DRIVE_FILES_ENDPOINT}/${encodeURIComponent(spreadsheetId)}?${moveParams}`,
        { token, fetchImpl, method: 'PATCH' },
      );
    } catch (error) {
      logger('sheets:move-failed', {
        code: error instanceof SheetsError ? error.code : 'UNEXPECTED',
      });
    }
  }

  /* 書式は失敗しても台帳自体は使えるため、全体を失敗にしない。 */
  const sheetId = created?.sheets?.[0]?.properties?.sheetId ?? 0;

  try {
    await formatHeaderRow({ token, spreadsheetId, sheetId, fetchImpl });
  } catch (error) {
    logger('sheets:header-format-failed', {
      code: error instanceof SheetsError ? error.code : 'UNEXPECTED',
    });
  }

  logger('sheets:created', { hasSpreadsheetId: true, columns: SHEET_HEADERS.length });

  return spreadsheetId;
}

/*
 * 台帳を用意する。フォルダと同じ3段階で解決する。
 *
 *   1. キャッシュを files.get で検証
 *   2. 指定フォルダ直下を検索（見つかればキャッシュへ書き戻す）
 *   3. どちらでも無ければ新規作成
 *
 * 台帳は「このアプリ専用の入れ物」なので、3 で利用者に確認は求めない。
 * 利用者の判断が要るのは TSAM AI フォルダをどれにするかだけ。
 *
 * 戻り値: { spreadsheetId, created, candidates }
 */
export async function ensureSpreadsheet({ token, parentFolderId, fetchImpl }) {
  if (!parentFolderId) {
    throw new SheetsError(SheetsErrorCode.UNKNOWN, 0, 'parent_folder_missing');
  }

  const cached = await verifyCachedSpreadsheet({ token, parentFolderId, fetchImpl });

  if (cached) {
    logger('sheets:resolved', { from: 'cache' });
    return { spreadsheetId: cached, created: false, candidates: [] };
  }

  const found = await searchSpreadsheets({ token, parentFolderId, fetchImpl });

  if (found.length > 0) {
    writeCachedId(found[0].id);
    logger('sheets:resolved', { from: 'search', count: found.length });

    return {
      spreadsheetId: found[0].id,
      created: false,
      candidates: found.length > 1 ? found : [],
    };
  }

  const spreadsheetId = await createSpreadsheet({ token, parentFolderId, fetchImpl });
  writeCachedId(spreadsheetId);

  return { spreadsheetId, created: true, candidates: [] };
}

/* ---------- 既存行の読み取り ---------- */

/* 保存時に付けたアポストロフィは API 経由では返らないが、念のため落とす。 */
function stripLeadingApostrophe(value) {
  return String(value ?? '').replace(/^'/, '');
}

/*
 * 見出し行から列位置を解決する。
 * 見出しが読めない・欠けている場合は SHEET_HEADERS 由来の既定値へ落とす。
 */
function resolveColumns(header) {
  const at = (label) => {
    const index = header.indexOf(label);
    return index >= 0 ? index : COLUMN_INDEX[label];
  };

  return {
    cardId: at('カードID'),
    timestamp: at('登録日時'),
    company: at('会社名'),
    name: at('氏名'),
    duplicateKey: at('重複判定キー'),
    frontHash: at('表面画像ハッシュ'),
    backHash: at('裏面画像ハッシュ'),
    emails: EMAIL_HEADERS.map((label) => at(label)),
  };
}

async function readAllRows({ token, spreadsheetId, fetchImpl }) {
  const range = encodeURIComponent(READ_RANGE);
  const result = await apiFetch(
    `${SHEETS_ENDPOINT}/${encodeURIComponent(spreadsheetId)}/values/${range}`,
    { token, fetchImpl },
  );

  return Array.isArray(result?.values) ? result.values : [];
}

/* ---------- カードID ---------- */

/*
 * 既存行から、その日の次のカードIDを決める。
 *
 * 完全な排他制御はブラウザからはできない。
 * そこで「読む → 候補を作る → もう一度読んで確認する」の順で行い、
 * 間に他の端末が保存していた場合は採番し直す。
 * それでも同時書き込みが重なれば衝突しうるため、
 * 規定回数で確定しなければ CARD_ID_CONFLICT として利用者へ知らせる。
 *
 * 戻り値: { cardId, existingIds }
 */
export async function allocateCardId({ token, spreadsheetId, date = new Date(), fetchImpl }) {
  let candidate = '';
  let existingIds = [];

  for (let attempt = 0; attempt < CARD_ID_MAX_ATTEMPTS; attempt += 1) {
    const rows = await readAllRows({ token, spreadsheetId, fetchImpl });

    if (rows.length === 0) {
      /* 見出し行すら無い台帳。1番から始める。 */
      candidate = buildCardId(1, date);
      existingIds = [];
      break;
    }

    const columns = resolveColumns(rows[0].map((cell) => String(cell ?? '').trim()));

    existingIds = rows
      .slice(1)
      .map((row) => stripLeadingApostrophe(row[columns.cardId]).trim())
      .filter((value) => isCardId(value));

    const next = buildCardId(nextCardSequence(existingIds, date), date);

    /* 1回目は候補を作るだけ。2回目以降で「まだ空いているか」を確かめる。 */
    if (candidate === next && !existingIds.includes(next)) {
      logger('cardid:allocated', { attempt: attempt + 1 });
      return { cardId: next, existingIds };
    }

    candidate = next;
  }

  if (candidate === '') {
    throw new SheetsError(SheetsErrorCode.CARD_ID_CONFLICT, 0, 'no_candidate');
  }

  /* 最後の候補がまだ空いていれば採用する。 */
  if (!existingIds.includes(candidate)) {
    logger('cardid:allocated', { attempt: CARD_ID_MAX_ATTEMPTS });
    return { cardId: candidate, existingIds };
  }

  throw new SheetsError(SheetsErrorCode.CARD_ID_CONFLICT, 0, 'retry_exhausted');
}

/*
 * 追記したあとに、そのカードIDが本当に1行だけかを確かめる。
 *
 * allocateCardId は「読み直して空きを確認する」方式であって、原子的な排他制御では
 * ない。2つの端末が同じ瞬間に同じ候補を確認すると、両方が追記できてしまう。
 * Sheets API にはこれを防ぐ手段（条件付き書き込み・トランザクション）が無いため、
 * **起きたことを検出して利用者へ知らせる**方針を採る。
 *
 * ここでは検出だけを行う。**既存行の自動削除も上書きもしない。**
 * どちらを残すかは中身を見ないと決められず、機械的に消すと取り返しがつかない。
 *
 * 戻り値: { count, rows }
 *   count … 同じカードIDを持つ行数（正常なら1）
 *   rows  … その行番号（1始まり、見出し行が1行目）
 */
export async function verifyCardIdUnique({ token, spreadsheetId, cardId, fetchImpl }) {
  const target = String(cardId ?? '').trim();

  if (target === '') {
    return { count: 0, rows: [] };
  }

  const rows = await readAllRows({ token, spreadsheetId, fetchImpl });

  if (rows.length <= 1) {
    return { count: 0, rows: [] };
  }

  const columns = resolveColumns(rows[0].map((cell) => String(cell ?? '').trim()));
  const found = [];

  for (let i = 1; i < rows.length; i += 1) {
    if (stripLeadingApostrophe(rows[i][columns.cardId]).trim() === target) {
      found.push(i + 1);
    }
  }

  logger('cardid:verified', { count: found.length });

  return { count: found.length, rows: found };
}

/* ---------- 重複チェック ---------- */

/*
 * 既存行と突き合わせる。
 *
 * 次のいずれかに当たれば重複とみなす。表示は優先度の高い順に並べる。
 *
 *   1. カードID一致       … 通常は起きない。起きたら採番の異常なので重大警告
 *   2. 画像ハッシュ一致   … 同じ画像を再登録した。面まで特定して知らせる
 *   3. メール一致         … 全メールアドレスの交差判定
 *   4. 携帯電話一致       … 重複判定キー経由
 *   5. 会社名+氏名一致    … 重複判定キー経由
 *
 * 見つかっても保存は止めない。名刺を再度もらうこと自体は正常な出来事なので、
 * 警告を出して利用者の判断に委ねる（この関数は判定結果を返すだけ）。
 *
 * 戻り値: [{ row, cardId, company, name, date, reason, severity }]
 *   reason   … 'cardId' | 'frontImage' | 'backImage' | 'crossImage' | 'email' | 'mobile' | 'companyName'
 *   severity … 'critical'（カードID一致）| 'warning'（それ以外）
 */
export async function findDuplicates({
  token,
  spreadsheetId,
  values,
  cardId = '',
  frontImageHash = '',
  backImageHash = '',
  fetchImpl,
}) {
  const rows = await readAllRows({ token, spreadsheetId, fetchImpl });

  if (rows.length <= 1) {
    return [];
  }

  const header = rows[0].map((cell) => String(cell ?? '').trim());
  const columns = resolveColumns(header);

  const targetKey = buildDuplicateKey(values);
  const targetEmails = new Set(
    dedupeEmails(values?.emails).map((item) => normalizeEmail(item)),
  );

  const targetFront = String(frontImageHash ?? '').trim().toLowerCase();
  const targetBack = String(backImageHash ?? '').trim().toLowerCase();
  const targetCardId = String(cardId ?? '').trim();

  const matches = [];

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];

    const rowCardId = stripLeadingApostrophe(row[columns.cardId]).trim();
    const rowKey = stripLeadingApostrophe(row[columns.duplicateKey]).trim();
    const rowFront = stripLeadingApostrophe(row[columns.frontHash]).trim().toLowerCase();
    const rowBack = stripLeadingApostrophe(row[columns.backHash]).trim().toLowerCase();

    const rowEmails = columnsToEmails(columns.emails.map((index) => row[index]));

    const sameCardId = targetCardId !== '' && rowCardId !== '' && rowCardId === targetCardId;

    const sameFront = targetFront !== '' && rowFront !== '' && rowFront === targetFront;
    const sameBack = targetBack !== '' && rowBack !== '' && rowBack === targetBack;
    /* 表裏を入れ替えて撮り直した場合も同じ名刺なので拾う。 */
    const crossImage = (targetFront !== '' && rowBack === targetFront)
      || (targetBack !== '' && rowFront === targetBack);

    const sharedEmail = targetEmails.size > 0
      && rowEmails.some((item) => targetEmails.has(normalizeEmail(item)));

    const sameKey = targetKey !== '' && rowKey !== '' && rowKey === targetKey;

    if (!sameCardId && !sameFront && !sameBack && !crossImage && !sharedEmail && !sameKey) {
      continue;
    }

    /* 具体的な一致ほど上の理由を採る。 */
    let reason = 'companyName';

    if (sameCardId) {
      reason = 'cardId';
    } else if (sameFront) {
      reason = 'frontImage';
    } else if (sameBack) {
      reason = 'backImage';
    } else if (crossImage) {
      reason = 'crossImage';
    } else if (sharedEmail) {
      reason = 'email';
    } else if (rowKey.startsWith('mobile:')) {
      reason = 'mobile';
    } else if (rowKey.startsWith('email:')) {
      reason = 'email';
    }

    matches.push({
      /* 1始まりの行番号（見出し行が1行目）。 */
      row: i + 1,
      cardId: rowCardId,
      company: String(row[columns.company] ?? ''),
      name: String(row[columns.name] ?? ''),
      date: String(row[columns.timestamp] ?? ''),
      reason,
      severity: sameCardId ? 'critical' : 'warning',
    });
  }

  /* 重大なものを先頭へ。同じ深刻度なら行番号順のまま。 */
  matches.sort((a, b) => {
    if (a.severity === b.severity) {
      return 0;
    }
    return a.severity === 'critical' ? -1 : 1;
  });

  logger('sheets:duplicate-check', { count: matches.length });

  return matches;
}

/* ---------- 追記 ---------- */

/*
 * 1行追記する。
 *
 * insertDataOption=INSERT_ROWS を付けると、既存セルを上書きせず行を挿入する。
 * valueInputOption=USER_ENTERED は、日時の解釈と =HYPERLINK() のために必要。
 *
 * 戻り値: { updatedRange }
 */
export async function appendCardRow({ token, spreadsheetId, fetchImpl, ...rowInput }) {
  const params = new URLSearchParams({
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    fields: 'updates.updatedRange',
  });

  const range = encodeURIComponent(APPEND_RANGE);
  const row = buildRow(rowInput);

  const result = await apiFetch(
    `${SHEETS_ENDPOINT}/${encodeURIComponent(spreadsheetId)}/values/${range}:append?${params}`,
    {
      token,
      fetchImpl,
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ values: [row] }),
    },
  );

  const updatedRange = result?.updates?.updatedRange ?? '';
  logger('sheets:appended', { hasRange: updatedRange !== '', columns: row.length });

  return { updatedRange };
}

/* スプレッドシートを開くURL。画面のリンクに使う。 */
export function spreadsheetUrl(spreadsheetId) {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit`;
}

/*
 * 確定保存（§FR-07・FR-19・§11.2、§8.1 ステージ5）。
 *
 *   1. 重複を見る（同一画像のハッシュ → 会社名＋氏名）
 *   2. 表面・裏面の画像を images/YYYY/MM へ上げる
 *   3. 台帳へ1行追記する
 *
 * ==================================================================
 * 手本にした実装
 * ==================================================================
 * ../receipt-ocr/ の record.js / app.js の保存手順を手本にした。
 * **import はしない**（docs/repository-structure.md §4-1）。
 *
 * 領収書OCRから採った形:
 *   - 列の定義から行を組み立てる（位置で書かない）
 *   - **本体を先に保存し、付随するものは後**（下記）
 *   - 二重送信を防ぐ
 * ==================================================================
 *
 * ==================================================================
 * 画像を先に上げ、台帳は最後に書く
 * ==================================================================
 * 途中で失敗したときに残る状態を考えて、この順にしている。
 *
 *   画像だけ残る … 台帳に無い画像がドライブに残る。**害は小さい**
 *   台帳だけ残る … 画像へのリンクが切れた行が残る。**こちらが悪い**
 *
 * 行があるのに画像が無いと、利用者は「保存できたはずだ」と思う。
 * 逆は「保存できていない」と分かる。**分かるほうの失敗を選ぶ。**
 *
 * 画像の後始末（消し戻し）はしない。消すほうが失敗しうるし、
 * 利用者のドライブから勝手にファイルを消す動きを増やしたくない。
 * ==================================================================
 */

import { APP_VERSION, JPEG_MIME, TABS } from './config.js';
import { uploadFile } from './drive-api.js';
import { resolveMonthFolder } from './drive-storage.js';
import {
  DATA_COLUMNS,
  buildDataRow,
  buildDuplicateKey,
  buildNameKey,
  headersOf,
} from './schema.js';
import { appendRow, readColumn, spreadsheetUrl } from './sheets.js';
import { buildImageFileName, yearMonthPath } from './capture.js';
import { hashBothSides } from './hash.js';
import { PROMPT_VERSION } from './prompt.js';

/* ---------- 重複（§FR-06・FR-17・FR-19） ---------- */

/*
 * 台帳の中に同じ画像のハッシュがあるか。
 *
 * **表裏を入れ替えて撮った場合も拾う**（§FR-06）。撮る順番を間違える
 * のはよくあることで、それを別件として登録させない。
 * そのために、新しい2つのハッシュを既存の2列すべてと突き合わせる。
 *
 * ここで見るのは**同一ファイルの再送だけ**である。同じ名刺を撮り直した
 * 場合は別のハッシュになるので拾えない。それは下の
 * findAttributeDuplicate（会社名＋氏名）が受け持つ。
 */
export function findHashDuplicate({ front, back }, existingHashes = []) {
  const known = new Set(existingHashes.filter((value) => typeof value === 'string' && value !== ''));

  if (front && known.has(front)) {
    return { found: true, side: 'front' };
  }

  if (back && known.has(back)) {
    return { found: true, side: 'back' };
  }

  return { found: false, side: null };
}

/*
 * 会社名と氏名が既に登録されているか（FR-17）。
 *
 * **同じ名刺を撮り直すとハッシュは変わる。** それでも同じ人の名刺なら
 * 二重に登録したくない、という要望に応える判定である。
 *
 * **会社名と氏名の両方が埋まっているときだけ見る**（buildNameKey）。
 * 片方だけで同一と判断すると、同姓の別会社や、社名しか読めなかった
 * 名刺どうしを同じものと見なしてしまう。
 *
 * 一致は「大文字小文字と空白を無視した完全一致」だけである。
 * 「株式会社」と「(株)」は別物として扱う。**表記の寄せ方を増やすほど、
 * 別人を同一人物と判定する危険が増える**ためで、迷ったら拾わない側に置く。
 */
export function findAttributeDuplicate(candidate, existingPairs = []) {
  const key = buildNameKey(candidate);

  if (key === '') {
    return { found: false, kind: null };
  }

  const known = new Set(
    existingPairs
      .map((pair) => buildNameKey(pair))
      .filter((value) => value !== ''),
  );

  return known.has(key)
    ? { found: true, kind: 'attribute', side: null }
    : { found: false, kind: null };
}

/* 台帳から、重複判定に使う列を読む。列の位置は定義から求める。 */
export async function readKnownKeys(spreadsheetId, options) {
  const headers = headersOf(DATA_COLUMNS);
  const at = (name) => readColumn(spreadsheetId, TABS.data, headers.indexOf(name), options);

  const [frontHashes, backHashes, companies, names] = await Promise.all([
    at('front_image_hash'),
    at('back_image_hash'),
    at('会社名'),
    at('氏名'),
  ]);

  /* 行の並びは同じなので、位置で組にできる。 */
  const rowCount = Math.max(companies.length, names.length);
  const pairs = [];

  for (let index = 0; index < rowCount; index += 1) {
    pairs.push({ companyName: companies[index] ?? '', fullName: names[index] ?? '' });
  }

  return { hashes: [...frontHashes, ...backHashes], pairs };
}

/* ---------- 1件ぶんの値 ---------- */

/* 台帳の record_id（§11.2。ブラウザで作る）。 */
export function buildRecordId() {
  const cryptoObj = globalThis.crypto;

  if (typeof cryptoObj?.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }

  if (typeof cryptoObj?.getRandomValues === 'function') {
    const bytes = cryptoObj.getRandomValues(new Uint8Array(16));
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  return `id-${Date.now()}`;
}

/* 登録日時。**日本時間で読める形にする**（利用者が開く表である）。 */
export function formatRegisteredAt(at = new Date()) {
  const date = at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date();
  const pad = (value) => String(value).padStart(2, '0');

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/*
 * 台帳へ入れる1件を組み立てる。
 *
 * **値はここで作らない。** 画面で確認・修正されたものをそのまま受け取る。
 * 作るのは記録のための値（ID・日時・版・重複キー）だけである。
 */
export function buildRecord({
  values,
  merged = null,
  hashes = {},
  front = null,
  back = null,
  at = new Date(),
}) {
  const duplicate = buildDuplicateKey(values);

  return {
    ...values,
    record_id: buildRecordId(),
    registeredAt: formatRegisteredAt(at),
    duplicateKey: duplicate.key,
    hasBack: Boolean(back),
    backFilledFields: Array.isArray(merged?.fromBackFields) ? merged.fromBackFields : [],
    frontImageHash: hashes.front ?? '',
    backImageHash: hashes.back ?? '',
    frontFileId: front?.id ?? '',
    backFileId: back?.id ?? '',
    frontFileUrl: front?.webViewLink ?? '',
    backFileUrl: back?.webViewLink ?? '',
    appVersion: APP_VERSION,
    promptVersion: PROMPT_VERSION,
  };
}

/* ---------- 保存 ---------- */

async function uploadSide(blob, { side, parentId, values, recordId, at, token, fetchImpl, signal }) {
  if (!blob) {
    return null;
  }

  const name = buildImageFileName({
    at,
    companyName: values.companyName,
    fullName: values.fullName,
    fallbackId: recordId,
    side,
  });

  return uploadFile(
    { name, mimeType: JPEG_MIME, parents: [parentId] },
    blob,
    { token, fetchImpl, signal },
  );
}

/*
 * 確定保存する。
 *
 * 戻り値: { recordId, duplicate, sheetUrl, front, back }
 *   duplicate … 同じ画像が既にあった場合の情報。**止めるかどうかは
 *               呼び出し側が決める**（利用者が「それでも登録する」を
 *               選べるようにするため）
 */
export async function registerCard({
  values,
  merged = null,
  frontBlob,
  backBlob = null,
  storage,
  token,
  fetchImpl,
  signal,
  at = new Date(),
  skipDuplicateCheck = false,
}) {
  const options = { token, fetchImpl, signal };
  const hashes = await hashBothSides({ front: frontBlob, back: backBlob });

  if (!skipDuplicateCheck) {
    const known = await readKnownKeys(storage.spreadsheetId, options);

    /*
     * **画像の一致を先に見る。** 同じファイルの再送は確実に重複であり、
     * 会社名・氏名の一致より根拠が強い。案内の文言も変えられる。
     */
    const byHash = findHashDuplicate(hashes, known.hashes);

    if (byHash.found) {
      return { registered: false, duplicate: { ...byHash, kind: 'image' }, recordId: null };
    }

    const byAttribute = findAttributeDuplicate(values, known.pairs);

    if (byAttribute.found) {
      return { registered: false, duplicate: byAttribute, recordId: null };
    }
  }

  const monthFolder = await resolveMonthFolder(
    storage.imageFolderId,
    yearMonthPath(at),
    options,
  );

  const recordId = buildRecordId();
  const uploadOptions = {
    parentId: monthFolder.id, values, recordId, at, ...options,
  };

  /* 表と裏は同時に上げてよい。互いに依存しない。 */
  const [front, back] = await Promise.all([
    uploadSide(frontBlob, { ...uploadOptions, side: 'front' }),
    uploadSide(backBlob, { ...uploadOptions, side: 'back' }),
  ]);

  const record = { ...buildRecord({ values, merged, hashes, front, back, at }), record_id: recordId };

  await appendRow(storage.spreadsheetId, TABS.data, buildDataRow(record), options);

  return {
    registered: true,
    duplicate: { found: false, side: null },
    recordId,
    sheetUrl: spreadsheetUrl(storage.spreadsheetId),
    front,
    back,
  };
}

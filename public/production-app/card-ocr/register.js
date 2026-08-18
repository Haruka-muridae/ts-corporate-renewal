/*
 * 確定保存（§FR-07・FR-17・FR-18・FR-19・§11.2・§11.3、§8.1 ステージ5）。
 *
 *   1. 重複を見る（同一画像のハッシュ → 会社名＋氏名）
 *   2. 表面・裏面の画像を images/YYYY/MM へ上げる
 *   3. 台帳へ1行追記する。**既存行の更新を選ばれた場合は、
 *      record_id で行を特定して上書きし、変更前値を変更履歴へ残す**
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
  CONTENT_COLUMNS,
  DATA_COLUMNS,
  buildDataRow,
  buildDuplicateKey,
  buildHistoryRow,
  buildNameKey,
  diffValues,
  headersOf,
  rowToValues,
} from './schema.js';
import {
  appendRow,
  appendRows,
  readColumn,
  readRow,
  spreadsheetUrl,
  updateRow,
} from './sheets.js';
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

/*
 * 台帳から、重複判定に使う列を読む。列の位置は定義から求める。
 *
 * **record_id と行番号も一緒に持って帰る**（v3.5 で追加）。
 * 重複が見つかったときに「どの行のことか」が分からないと、
 * FR-17 の「既存行の更新」へ進めないためである。
 */
export async function readKnownKeys(spreadsheetId, options) {
  const headers = headersOf(DATA_COLUMNS);
  const at = (name) => readColumn(spreadsheetId, TABS.data, headers.indexOf(name), options);

  const [recordIds, frontHashes, backHashes, companies, names] = await Promise.all([
    at('record_id'),
    at('front_image_hash'),
    at('back_image_hash'),
    at('会社名'),
    at('氏名'),
  ]);

  /*
   * 行の並びは同じなので、位置で組にできる。
   * **列ごとに長さが違いうる**（Sheets は右端・下端の空を返さない）ので、
   * 一番長いものに合わせて空で埋める。
   */
  const rowCount = Math.max(
    recordIds.length, frontHashes.length, backHashes.length,
    companies.length, names.length,
  );

  const rows = [];

  for (let index = 0; index < rowCount; index += 1) {
    rows.push({
      /* 見出しが1行目なので、データの1件目は2行目。 */
      rowNumber: index + 2,
      recordId: recordIds[index] ?? '',
      frontHash: frontHashes[index] ?? '',
      backHash: backHashes[index] ?? '',
      companyName: companies[index] ?? '',
      fullName: names[index] ?? '',
    });
  }

  return {
    rows,
    /* 既存の呼び出し形（一致の有無だけを見る）も残す。 */
    hashes: [...frontHashes, ...backHashes],
    pairs: rows.map(({ companyName, fullName }) => ({ companyName, fullName })),
  };
}

/*
 * 重複している**行**を特定する（FR-17）。
 *
 * 上の2つの判定を、行ごとに順に当てるだけである。優先順位は
 * 「画像の一致 → 会社名＋氏名」で、registerCard が持っていたものと同じ。
 *
 * **行を返すのが要点**である。更新（FR-18）は record_id で行を特定して
 * 書くので、「重複している」だけでは足りない。
 */
export function findDuplicateRow(hashes, values, rows = []) {
  for (const row of rows) {
    const hit = findHashDuplicate(hashes, [row.frontHash, row.backHash]);

    if (hit.found) {
      return { found: true, kind: 'image', side: hit.side, row };
    }
  }

  for (const row of rows) {
    if (findAttributeDuplicate(values, [row]).found) {
      return { found: true, kind: 'attribute', side: null, row };
    }
  }

  return { found: false, kind: null, side: null, row: null };
}

/*
 * record_id から行番号を求める（FR-18）。見つからなければ null。
 *
 * **書く直前にもう一度引く。** 重複を見つけた時点の行番号は、利用者が
 * 別のタブで行を消したり並べ替えたりすれば、その瞬間にずれる。
 * 位置ではなく record_id が正である以上、位置は毎回引き直す。
 *
 * 同じ record_id が2行ある場合（行のコピーで起こる）は**最初の行**を採る。
 * どちらも同じ1件を指しているので、片方を選んでも別人を書き換えることには
 * ならない。**曖昧だからと更新を止めるほうが、利用者の逃げ場が無くなる。**
 */
export async function locateRowByRecordId(spreadsheetId, recordId, options) {
  if (typeof recordId !== 'string' || recordId === '') {
    return null;
  }

  const headers = headersOf(DATA_COLUMNS);
  const ids = await readColumn(spreadsheetId, TABS.data, headers.indexOf('record_id'), options);
  const index = ids.indexOf(recordId);

  return index < 0 ? null : index + 2;
}

/* いま台帳に入っている1件を読む（差分確認と変更履歴に使う）。 */
async function readExistingRecord(spreadsheetId, rowNumber, options) {
  const row = await readRow(spreadsheetId, TABS.data, rowNumber, DATA_COLUMNS.length, options);

  return rowToValues(row);
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

/*
 * 変更履歴の行を作る（§11.3）。変わった項目の数だけ行ができる。
 *
 * **変更前値を残すのが目的**である（FR-17）。上書きしてしまえば、
 * 元の値はどこにも残らない。台帳は利用者の資産で、こちらには控えが無い。
 */
export function buildHistoryRows({ recordId, changes = [], at = new Date() }) {
  const changedAt = formatRegisteredAt(at);

  return changes.map((change) => buildHistoryRow({
    historyId: buildRecordId(),
    changedAt,
    recordId,
    fieldName: change.header,
    oldValue: change.oldValue,
    newValue: change.newValue,
  }));
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

/* 表と裏を上げる。互いに依存しないので同時でよい。 */
async function uploadBothSides({ frontBlob, backBlob, storage, values, recordId, at, options }) {
  const monthFolder = await resolveMonthFolder(
    storage.imageFolderId,
    yearMonthPath(at),
    options,
  );

  const uploadOptions = {
    parentId: monthFolder.id, values, recordId, at, ...options,
  };

  const [front, back] = await Promise.all([
    uploadSide(frontBlob, { ...uploadOptions, side: 'front' }),
    uploadSide(backBlob, { ...uploadOptions, side: 'back' }),
  ]);

  return { front, back };
}

/*
 * 既にある1件を、いま読み取った内容で上書きする（FR-17・FR-18・§11.3）。
 *
 * ==================================================================
 * 順序（台帳が先、変更履歴が後）
 * ==================================================================
 * 逆にすると、**書き換えに失敗したのに「こう変えた」という履歴だけが
 * 残る。** 履歴のほうが先に書けてしまう状態は、あとから見て嘘になる。
 *
 * 台帳を先に書けば、履歴に失敗しても
 * 「更新はできた／記録は残せなかった」と**利用者に伝えられる**
 * （historyRecorded を返す）。register.js 冒頭の「分かるほうの失敗を
 * 選ぶ」と同じ考え方である。
 * ==================================================================
 *
 * ==================================================================
 * record_id と登録日時は引き継ぐ
 * ==================================================================
 * record_id は行の同一性そのものなので、作り直さない。
 * 登録日時も**最初に登録した日時のまま**残す。更新した日時は
 * 変更履歴の changed_at が持っており、二重に持つ必要がない。
 * ==================================================================
 */
async function updateCard({
  recordId, values, merged, hashes, frontBlob, backBlob, storage, at, options,
}) {
  const rowNumber = await locateRowByRecordId(storage.spreadsheetId, recordId, options);

  if (rowNumber === null) {
    /*
     * 差分を見ている間に、その行が消された（か record_id が書き換えられた）。
     * **どこか別の行を上書きしない。** 呼び出し側で案内する。
     */
    return {
      registered: false,
      updated: false,
      missingRow: true,
      duplicate: { found: false, side: null },
      recordId: null,
    };
  }

  const existing = await readExistingRecord(storage.spreadsheetId, rowNumber, options);
  const { front, back } = await uploadBothSides({
    frontBlob, backBlob, storage, values, recordId, at, options,
  });

  /*
   * **登録日時は読んだ値をそのまま書き戻す。**
   *
   * Sheets は `2026-01-05 09:00:00` を日時として取り込むため、
   * FORMULA で読むと**シリアル値（数値）で返ることがある。**
   * その場合はシリアル値をそのまま書き戻すことになるが、
   * セルの表示形式は日時のまま残るので見え方は変わらない。
   * **こちらで文字列へ組み立て直さない。** 変換を挟むほうが、
   * 取り違えて別の日時を書く危険が大きい（値そのものは同じである）。
   */
  const record = {
    ...buildRecord({ values, merged, hashes, front, back, at }),
    record_id: recordId,
    registeredAt: existing.registeredAt !== '' ? existing.registeredAt : formatRegisteredAt(at),
  };

  const row = buildDataRow(record);

  /*
   * 履歴は**全列**を見る（record_id を除く）。画面に出す差分は
   * 名刺の中身だけだが（CONTENT_COLUMNS）、記録のほうを絞ると
   * 「画像が差し替わった」「裏面が外れた」が追えなくなる。
   */
  const changes = diffValues(
    existing,
    rowToValues(row),
    DATA_COLUMNS.filter((column) => column.key !== 'record_id'),
  );

  await updateRow(storage.spreadsheetId, TABS.data, rowNumber, row, options);

  let historyRecorded = true;

  if (changes.length > 0) {
    try {
      await appendRows(
        storage.spreadsheetId,
        TABS.history,
        buildHistoryRows({ recordId, changes, at }),
        options,
      );
    } catch {
      /* 台帳は書けている。**更新そのものを失敗にしない。** */
      historyRecorded = false;
    }
  }

  return {
    registered: true,
    updated: true,
    duplicate: { found: false, side: null },
    recordId,
    rowNumber,
    changes,
    historyRecorded,
    sheetUrl: spreadsheetUrl(storage.spreadsheetId),
    front,
    back,
  };
}

/*
 * 確定保存する。
 *
 * 戻り値: { registered, recordId, duplicate, sheetUrl, front, back }
 *   duplicate … 同じ名刺が既にあった場合の情報。**止めるかどうかは
 *               呼び出し側が決める**（利用者が「新規として登録する」
 *               「既存の行を更新する」を選べるようにするため。FR-17）
 *   existing / changes … 重複していた行の中身と、いまの内容との差分。
 *               **差分確認なしに上書きさせない**ために返す
 *
 * updateRecordId を渡すと、追記ではなく**その record_id の行の更新**になる。
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
  updateRecordId = null,
}) {
  const options = { token, fetchImpl, signal };
  const hashes = await hashBothSides({ front: frontBlob, back: backBlob });

  if (typeof updateRecordId === 'string' && updateRecordId !== '') {
    return updateCard({
      recordId: updateRecordId,
      values, merged, hashes, frontBlob, backBlob, storage, at, options,
    });
  }

  if (!skipDuplicateCheck) {
    const known = await readKnownKeys(storage.spreadsheetId, options);

    /*
     * **画像の一致を先に見る。** 同じファイルの再送は確実に重複であり、
     * 会社名・氏名の一致より根拠が強い。案内の文言も変えられる
     * （優先順位は findDuplicateRow の中にある）。
     */
    const hit = findDuplicateRow(hashes, values, known.rows);

    if (hit.found) {
      /*
       * **record_id が空の行は更新できない。** 利用者が消した場合で、
       * 位置で当てにいくと別人の行を上書きしうる。新規登録だけを許す。
       */
      const updatable = hit.row.recordId !== '';
      const existing = updatable
        ? await readExistingRecord(storage.spreadsheetId, hit.row.rowNumber, options)
        : null;

      return {
        registered: false,
        duplicate: {
          found: true,
          kind: hit.kind,
          side: hit.side,
          recordId: hit.row.recordId,
          rowNumber: hit.row.rowNumber,
          updatable,
        },
        existing,
        changes: existing ? diffValues(existing, values, CONTENT_COLUMNS) : [],
        recordId: null,
      };
    }
  }

  const recordId = buildRecordId();
  const { front, back } = await uploadBothSides({
    frontBlob, backBlob, storage, values, recordId, at, options,
  });

  const record = { ...buildRecord({ values, merged, hashes, front, back, at }), record_id: recordId };

  await appendRow(storage.spreadsheetId, TABS.data, buildDataRow(record), options);

  return {
    registered: true,
    updated: false,
    duplicate: { found: false, side: null },
    recordId,
    sheetUrl: spreadsheetUrl(storage.spreadsheetId),
    front,
    back,
  };
}

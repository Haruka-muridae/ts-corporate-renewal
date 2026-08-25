/*
 * 名刺台帳の検索・絞り込み。**純粋関数のみ**（DOM・fetch を参照しない）。
 *
 * 正規化の順序（この順で固定）:
 *   1. String.prototype.normalize('NFKC')
 *   2. 小文字化
 *   3. カタカナ → ひらがな（コードポイント 0x30A1-0x30F6 を -0x60）
 *
 * 全文検索の対象は FIELDS（fields.js）の全項目 + emails + 統合OCR（mergedOcr）。
 * スペース区切りは AND 検索（すべての語を含む場合だけ一致）。
 * タグ絞り込みは、タグ列（カンマ区切り。fields.js の parseTags と同じ区切り）を
 * 正規化したうえでの完全一致。
 */

import { FIELDS, parseTags } from '../card-scanner/fields.js';

/* カタカナ（U+30A1-U+30F6）→ ひらがな。 */
const KATAKANA_START = 0x30a1;
const KATAKANA_END = 0x30f6;
const KATAKANA_TO_HIRAGANA_OFFSET = 0x60;

/* NFKC → 小文字化 → カタカナ折りたたみ。この順を変えないこと。 */
export function normalizeSearchText(value) {
  const nfkc = String(value ?? '').normalize('NFKC').toLowerCase();
  let out = '';

  for (const ch of nfkc) {
    const code = ch.codePointAt(0);

    if (code >= KATAKANA_START && code <= KATAKANA_END) {
      out += String.fromCodePoint(code - KATAKANA_TO_HIRAGANA_OFFSET);
    } else {
      out += ch;
    }
  }

  return out;
}

/* 全文検索の対象キー。field 項目すべて（emails・mergedOcr は別途足す）。 */
const FULLTEXT_FIELD_KEYS = FIELDS.map((field) => field.key);

/* レコード1件の検索対象文字列（正規化済み）を作る。 */
export function buildSearchIndex(record) {
  const parts = [];

  FULLTEXT_FIELD_KEYS.forEach((key) => {
    const value = record?.values?.[key];

    if (Array.isArray(value)) {
      parts.push(value.join(' '));
    } else if (value) {
      parts.push(String(value));
    }
  });

  (record?.values?.emails ?? []).forEach((email) => parts.push(email));

  if (record?.auto?.mergedOcr) {
    parts.push(String(record.auto.mergedOcr));
  }

  return normalizeSearchText(parts.join(' '));
}

/* スペース区切りのAND検索。空クエリは常に一致。 */
export function matchesQuery(record, query) {
  const normalized = normalizeSearchText(query).trim();

  if (normalized === '') {
    return true;
  }

  const terms = normalized.split(/\s+/).filter((term) => term !== '');
  const index = buildSearchIndex(record);

  return terms.every((term) => index.includes(term));
}

/* タグの完全一致（正規化後）。空指定は常に一致。 */
export function matchesTag(record, tag) {
  const target = normalizeSearchText(tag).trim();

  if (target === '') {
    return true;
  }

  return parseTags(record?.values?.tags).some((item) => normalizeSearchText(item) === target);
}

/* 会社名の完全一致（正規化後）。空指定は常に一致。 */
export function matchesCompany(record, company) {
  const target = normalizeSearchText(company).trim();

  if (target === '') {
    return true;
  }

  return normalizeSearchText(record?.values?.company) === target;
}

/* 全文検索・タグ・会社を組み合わせて絞り込む。 */
export function filterRecords(records, { query = '', tag = '', company = '' } = {}) {
  return (Array.isArray(records) ? records : [])
    .filter((record) => matchesQuery(record, query)
      && matchesTag(record, tag)
      && matchesCompany(record, company));
}

/* 絞り込みの選択肢を集める。正規化した値で重複を除き、最初に出た表記を残す。 */
function collectUniqueOptions(records, getRawValues) {
  const seen = new Map();

  (Array.isArray(records) ? records : []).forEach((record) => {
    getRawValues(record).forEach((raw) => {
      const value = String(raw ?? '').trim();

      if (value === '') {
        return;
      }

      const key = normalizeSearchText(value);

      if (!seen.has(key)) {
        seen.set(key, value);
      }
    });
  });

  return [...seen.values()].sort((a, b) => a.localeCompare(b, 'ja'));
}

/* タグ絞り込み用の選択肢一覧。 */
export function collectTagOptions(records) {
  return collectUniqueOptions(records, (record) => parseTags(record?.values?.tags));
}

/* 会社絞り込み用の選択肢一覧。 */
export function collectCompanyOptions(records) {
  return collectUniqueOptions(records, (record) => [record?.values?.company]);
}

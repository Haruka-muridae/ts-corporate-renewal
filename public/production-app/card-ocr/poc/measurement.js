/*
 * 精度・所要時間の測定（フェーズ0計画 §7、要件定義書 §16.2 / §13.1）。
 *
 * ==================================================================
 * 抽出結果をブラウザに保存しない
 * ==================================================================
 * 要件定義書 §FR-21 は「未登録の画像・抽出結果」について
 * **「localStorage等へ保存しない」**と定めている。測定結果には名刺の
 * 中身（第三者の個人情報）が入るため、この制約がそのまま効く。
 *
 * したがって:
 *   - 測定した行は**メモリにだけ**持つ。ページを閉じれば消える
 *   - localStorage へ入れるのは**個人情報を含まない進行状況だけ**
 *     （次の通し番号、開始時刻、429 の発生記録）
 *
 * 「中断・再開」はこの制約のもとで次の形になる。
 *
 *   中断 … その時点までのCSVをダウンロードしてから閉じる
 *   再開 … 進行状況から次の番号が復元される。続きを測り、
 *          2枚目のCSVを出して表計算ソフトで結合する
 *
 * **CSVを保存せずに閉じると、その回の測定結果は失われる。**
 * 画面側で警告を出すこと。
 * ==================================================================
 */

import { escapeCellText } from './sanitize.js';

/* 進行状況の保存キー。**個人情報を入れないこと。** */
export const SESSION_STORAGE_KEY = 'tsam-card-ocr-measure-session';

/*
 * CSV の列。
 *
 * expected_* は空で出す。**測定後に表計算ソフトで正解を書き込む**ための欄で、
 * 画面から入力させない（計画 §7-1。打ち間違いがそのまま精度の数字になるため）。
 */
export const CSV_COLUMNS = Object.freeze([
  'no',
  'file_name',
  'status',
  'error_code',
  'recorded_at',
  'total_ms',
  'ocr_ms',
  'gemini_ms',
  'ocr_chars',
  'ocr_attempts',
  'companyName',
  'departmentName',
  'jobTitle',
  'fullName',
  'fullNameKana',
  'postalCode',
  'address',
  'phone',
  'mobile',
  'fax',
  'email',
  'url',
  'uncertainFields',
  'expected_companyName',
  'expected_fullName',
  'expected_jobTitle',
  'expected_email',
  'expected_phone',
]);

export const MeasureStatus = {
  OK: 'ok',
  RATE_LIMITED: 'rate_limited',
  OCR_EMPTY: 'ocr_empty',
  ERROR: 'error',
};

/* ---------- 進行状況（個人情報を含まない） ---------- */

function emptySession() {
  return { startedAt: null, nextNo: 1, rateLimitEvents: [] };
}

export function loadSession() {
  try {
    const raw = globalThis.localStorage?.getItem(SESSION_STORAGE_KEY);

    if (typeof raw !== 'string' || raw === '') {
      return emptySession();
    }

    const parsed = JSON.parse(raw);

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return emptySession();
    }

    const nextNo = Number(parsed.nextNo);

    return {
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : null,
      nextNo: Number.isFinite(nextNo) && nextNo >= 1 ? Math.floor(nextNo) : 1,
      rateLimitEvents: Array.isArray(parsed.rateLimitEvents) ? parsed.rateLimitEvents : [],
    };
  } catch {
    /* 壊れた値でも測定を止めない。 */
    return emptySession();
  }
}

/*
 * 保存できたかどうかを返す。
 *
 * 保存領域が無い環境（プライベートモード等）では **false** を返す。
 * 「呼べたから保存された」とは限らないため、成功を騙らない。
 * 保存できなくても測定自体は続けられる（再開位置が復元できないだけ）。
 */
export function saveSession(session) {
  const storage = globalThis.localStorage;

  if (!storage) {
    return false;
  }

  try {
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
      startedAt: session.startedAt,
      nextNo: session.nextNo,
      rateLimitEvents: session.rateLimitEvents,
    }));
    return true;
  } catch {
    /* 容量超過・書き込み禁止。 */
    return false;
  }
}

export function clearSession() {
  try {
    globalThis.localStorage?.removeItem(SESSION_STORAGE_KEY);
  } catch {
    /* 消せなくても測定は続けられる。 */
  }
}

/*
 * 429 の発生を記録する（項目14 の観測データ）。
 *
 * **何枚目で、いつ当たったか**を残す。無料枠のレート上限がどのくらいで
 * 効いてくるのかは、これでしか分からない。
 */
export function recordRateLimit(session, { no, at }) {
  return {
    ...session,
    rateLimitEvents: [...session.rateLimitEvents, { no, at }],
  };
}

/* ---------- 行の組み立て ---------- */

/*
 * 1件ぶんの測定結果を、CSVの列に合わせた素の値の集合にする。
 *
 * 値の整形（サニタイズ）はCSV化のときに行う。ここでは形だけを揃える。
 */
export function buildRow({
  no,
  fileName,
  status,
  errorCode = '',
  recordedAt,
  totalMs = null,
  ocrMs = null,
  geminiMs = null,
  ocrChars = null,
  ocrAttempts = null,
  fields = null,
}) {
  const field = (key) => String(fields?.[key] ?? '');

  return {
    no,
    file_name: fileName,
    status,
    error_code: errorCode,
    recorded_at: recordedAt,
    total_ms: totalMs ?? '',
    ocr_ms: ocrMs ?? '',
    gemini_ms: geminiMs ?? '',
    ocr_chars: ocrChars ?? '',
    ocr_attempts: ocrAttempts ?? '',
    companyName: field('companyName'),
    departmentName: field('departmentName'),
    jobTitle: field('jobTitle'),
    fullName: field('fullName'),
    fullNameKana: field('fullNameKana'),
    postalCode: field('postalCode'),
    address: field('address'),
    phone: field('phone'),
    mobile: field('mobile'),
    fax: field('fax'),
    email: field('email'),
    url: field('url'),
    uncertainFields: Array.isArray(fields?.uncertainFields)
      ? fields.uncertainFields.join(' ')
      : '',
    /* 正解列は空。測定後に表計算ソフトで書き込む。 */
    expected_companyName: '',
    expected_fullName: '',
    expected_jobTitle: '',
    expected_email: '',
    expected_phone: '',
  };
}

/* ---------- CSV ---------- */

/*
 * CSV の1セルを作る。
 *
 * 2段構えになっている。
 *   1. escapeCellText … 数式インジェクション対策（= + - @ の先頭）。
 *      **表計算ソフトで開いた瞬間に数式として評価されるのを防ぐ。**
 *      要件定義書 §FR-18 と同じ問題が、CSVでも起きる
 *   2. RFC 4180 の引用 … カンマ・引用符・改行を含む値を壊さない
 */
export function csvEscape(value) {
  const guarded = escapeCellText(value);

  if (guarded === '') {
    return '';
  }

  if (/[",\r\n]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }

  return guarded;
}

export function buildCsv(rows) {
  const lines = [CSV_COLUMNS.join(',')];

  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((column) => csvEscape(row[column])).join(','));
  }

  /* 改行は CRLF。表計算ソフトの既定に合わせる。 */
  return lines.join('\r\n');
}

/*
 * ダウンロード用の Blob を作る。
 *
 * **先頭に BOM を付ける。** 付けないと Excel が UTF-8 と判定できず、
 * 日本語が文字化けする。
 */
export function buildCsvBlob(rows) {
  return new Blob(['﻿', buildCsv(rows)], { type: 'text/csv;charset=utf-8;' });
}

export function buildCsvFileName(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
  ].join('');

  return `card-ocr-measure-${stamp}.csv`;
}

/*
 * ブラウザにダウンロードさせる。
 *
 * **保存先はブラウザのダウンロードだけ。** ドライブへ上げない。
 * 第三者の個人情報が入るため、当社の管理下へ置かない
 * （要件定義書 §14.4、計画 §7-5）。
 */
export function downloadCsv(rows, { now = new Date() } = {}) {
  const blob = buildCsvBlob(rows);
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = buildCsvFileName(now);
  document.body.append(link);
  link.click();
  link.remove();

  /* 参照を残さない。 */
  URL.revokeObjectURL(url);
}

/* ---------- 集計（画面表示用の目安） ---------- */

export function summarize(rows) {
  const done = rows.filter((row) => row.status === MeasureStatus.OK);
  const times = done
    .map((row) => Number(row.total_ms))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  const percentile = (p) => {
    if (times.length === 0) {
      return null;
    }

    const index = Math.min(times.length - 1, Math.floor((times.length - 1) * p));
    return times[index];
  };

  return {
    total: rows.length,
    ok: done.length,
    rateLimited: rows.filter((row) => row.status === MeasureStatus.RATE_LIMITED).length,
    failed: rows.filter((row) => row.status === MeasureStatus.ERROR
      || row.status === MeasureStatus.OCR_EMPTY).length,
    /* 処理完了率（要件定義書 §16.2）。 */
    completionRate: rows.length === 0 ? null : done.length / rows.length,
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
  };
}

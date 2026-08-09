/*
 * 検証結果の記録と、秘密情報の伏字化。
 *
 * ==================================================================
 * 方針
 * ==================================================================
 *   - results/raw/*.json は機械が書き、results/T*.md は人が書く。
 *     判定（Go / 条件付きGo / No-Go）は人の仕事なので、機械に書かせない。
 *   - 記録する前に必ず redact() を通す。リポジトリは公開されており、
 *     一度コミットすると履歴に残って取り消せない。
 *   - redact() は「既知の形」しか消せない。最後の確認は人間が行う前提で、
 *     README にもそう書いてある。ここを万能だと思わせないこと。
 * ==================================================================
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const resultsDir = resolve(here, '..', 'results');
const rawDir = resolve(resultsDir, 'raw');

/*
 * 伏せる対象。
 *
 * 前方一致で始まる token 状の文字列と、ヘッダーの値を狙う。
 * 「消しすぎ」は読みにくくなるだけだが、「消し漏れ」は取り返しがつかないので、
 * 迷ったら広めに倒す。
 */
const SECRET_PATTERNS = [
  /* APIキー・トークンの接頭辞（各社の実物に合わせて足す） */
  [/\b(sk-[A-Za-z0-9_-]{8,})/g, 'sk-<伏字>'],
  [/\b(whsec_[A-Za-z0-9_-]{8,})/g, 'whsec_<伏字>'],
  [/\b(EAA[A-Za-z0-9]{16,})/g, 'EAA<伏字>'],           /* Meta のアクセストークン */
  [/\b(ya29\.[A-Za-z0-9._-]{16,})/g, 'ya29.<伏字>'],   /* Google のアクセストークン */
  [/\b(1\/\/[A-Za-z0-9._-]{16,})/g, '1//<伏字>'],       /* Google のリフレッシュトークン */
  [/\b(AIza[A-Za-z0-9_-]{16,})/g, 'AIza<伏字>'],        /* Google APIキー */
  [/\b(eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]+)/g, '<JWT伏字>'],

  /* ヘッダーの値 */
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, '$1<伏字>'],
  [/("(?:authorization|x-api-key|apikey|client_secret|refresh_token|access_token)"\s*:\s*")[^"]+/gi, '$1<伏字>'],

  /* 実在するメールアドレス（docs と同じ基準で書かない） */
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<メールアドレス伏字>'],
];

/**
 * 秘密情報を伏せる。
 *
 * オブジェクトは JSON へ直してから走査し、構造を保ったまま返す。
 * 文字列以外（数値・真偽値）はそのまま。
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function redact(value) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    let out = value;
    for (const [pattern, replacement] of SECRET_PATTERNS) {
      out = out.replace(pattern, replacement);
    }
    return /** @type {T} */ (out);
  }

  if (Array.isArray(value)) {
    return /** @type {T} */ (value.map((item) => redact(item)));
  }

  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = redact(item);
    }
    return /** @type {T} */ (out);
  }

  return value;
}

/**
 * 1項目の実測値を results/raw/<trackId>.json へ追記する。
 *
 * 同じ項目を何度実行しても、最後の1件だけを残す。実行のたびに増えると
 * どれが最新か分からなくなるため。履歴が要るときは git log を見る。
 *
 * @param {{
 *   trackId: string,
 *   itemId: string,
 *   status: 'ok' | 'ng' | 'skipped' | 'error',
 *   note?: string,
 *   measurements?: Record<string, unknown>,
 *   at: string,
 * }} entry
 */
export function writeRaw(entry) {
  mkdirSync(rawDir, { recursive: true });

  const path = resolve(rawDir, `${entry.trackId}.json`);
  /** @type {Record<string, unknown>} */
  let current = {};

  if (existsSync(path)) {
    try {
      current = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      /*
       * 壊れていたら作り直す。検証の記録より、検証が止まらないことを優先する。
       * 壊れた内容は git に残っているので失われない。
       */
      current = {};
    }
  }

  current[entry.itemId] = redact({
    status: entry.status,
    note: entry.note ?? '',
    measurements: entry.measurements ?? {},
    at: entry.at,
  });

  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
}

/**
 * 環境変数を取る。BOM・前後空白を落とす（lib/event/config.mjs と同じ理由）。
 *
 * 無ければ null を返し、呼び出し側が「skipped」として扱えるようにする。
 * 検証の途中で例外を投げると、後続の項目まで実行されないため。
 *
 * @param {string} name
 * @returns {string | null}
 */
export function env(name) {
  const raw = process.env[name];

  if (typeof raw !== 'string') {
    return null;
  }

  const value = raw.replace(/^﻿/, '').trim();

  return value === '' ? null : value;
}

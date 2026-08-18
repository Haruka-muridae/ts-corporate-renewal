/*
 * 「設定」タブの値を、実行時のしきい値へ変える（v1.3 §16.6 / v2.0 §9.1）。
 *
 * ==================================================================
 * ここまで書いても、使われていなければ意味がない
 * ==================================================================
 * 設定タブは §9.1 が「閾値等の利用者別設定」と定めており、
 * schema.js が既定値を書き込み、sheets.js の readSettings() が読み、
 * gateway.js が口を持っていた。**それでも呼び出す場所が無かった**ため、
 * 利用者がシート上で値を変えても挙動は変わらなかった
 * （docs/system-design/receipt-ocr/03_detailed-design.md §3.4 の注記）。
 *
 * このファイルは「シートの文字列 → 実行時の設定」の変換だけを持つ。
 * 通信は sheets.js / gateway.js、適用は app.js が行う。
 * ==================================================================
 *
 * ==================================================================
 * 読めない値は既定へ落とす（安全側）
 * ==================================================================
 * 設定タブは利用者が自由に編集できる。空欄・全角・打ち間違い・
 * 数式の残骸が入りうる。**そこで例外を投げて画面を止めない。**
 * 既定値へ落として動き続け、「どの設定を無視したか」を名前で返す。
 *
 * 黙って落とさないのは、利用者が「変えたつもり」のまま使い続けることを
 * 避けるためである。値そのものは画面へ出さない（利用者の入力だが、
 * 出す必要が無い）。
 * ==================================================================
 */

import { normalizeAmount } from './amount.js';
import { DEFAULT_MIN_OCR_LENGTH } from './completion-policy.js';
import { DEFAULT_THRESHOLDS, MAX_SCORE } from './confidence.js';
import { SETTINGS_KEYS } from './schema.js';
import { DEFAULT_LIMITS } from './validate.js';

/*
 * 受け付ける範囲。**上限も下限も置く。**
 *
 * 例えば「金額の上限」に 1 を入れられると、すべての領収書が
 * 「上限超過」で検証不合格になり、原因が設定だと気付けない。
 * 極端な値は打ち間違いとみなし、既定へ落として名前を返す。
 */
export const RANGES = Object.freeze({
  maxAmount: Object.freeze({ min: 1000, max: 1000000000 }),
  pastDateLimitDays: Object.freeze({ min: 1, max: 36500 }),
  minOcrLength: Object.freeze({ min: 0, max: 10000 }),
  confidence: Object.freeze({ min: 0, max: MAX_SCORE }),
});

/* シートの値を整数として読む。読めなければ null（既定へ落とす合図）。 */
export function readInteger(raw, { min, max }) {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return null;
  }

  /*
   * 金額の正規化を流用する。全角数字・桁区切り（10,000,000）まで
   * 面倒を見てくれる。日数やスコアも整数なので、同じ扱いでよい。
   */
  const value = normalizeAmount(raw);

  if (value === null || !Number.isInteger(value)) {
    return null;
  }

  return value >= min && value <= max ? value : null;
}

/*
 * 真偽値。TRUE / FALSE を基本とし、シートのチェックボックスや
 * 手入力の揺れ（はい・オン・1）も受ける。読めなければ null。
 */
export function readBoolean(raw) {
  const text = String(raw ?? '').trim().toLowerCase();

  if (text === '') {
    return null;
  }

  if (['true', '1', 'yes', 'on', 'はい', '有効', '使う'].includes(text)) {
    return true;
  }

  if (['false', '0', 'no', 'off', 'いいえ', '無効', '使わない'].includes(text)) {
    return false;
  }

  return null;
}

/*
 * 設定タブの内容（設定名 → 値）を、実行時の設定へ変える。
 *
 * 戻り値:
 *   limits       … validate.js へ渡す（金額上限・過去日数・税の許容差）
 *   thresholds   … confidence.js の levelOf() へ渡す（高・中）
 *   minOcrLength … completion-policy.js の decideCompletion() へ渡す
 *   geminiEnabled… 同上。利用者が AI 補完を止めているか
 *   ignored      … 読めずに既定へ落とした設定名（画面に出す）
 *
 * **税の許容差（taxToleranceYen）は設定タブに無い。** 既定のままにする。
 * 設定名を勝手に増やすと、利用者のシートに無い行を前提にすることになる。
 */
export function resolveSettings(raw = {}) {
  const map = raw && typeof raw === 'object' ? raw : {};
  const ignored = [];

  const pick = (key, reader) => {
    const name = SETTINGS_KEYS[key];
    const rawValue = map[name];

    /* 行そのものが無いのは「未設定」。無視した設定として数えない。 */
    if (rawValue === null || rawValue === undefined || String(rawValue).trim() === '') {
      return null;
    }

    const value = reader(rawValue);

    if (value === null) {
      ignored.push(name);
    }

    return value;
  };

  const maxAmount = pick('maxAmount', (value) => readInteger(value, RANGES.maxAmount));
  const pastDateLimitDays = pick(
    'pastDateLimitDays',
    (value) => readInteger(value, RANGES.pastDateLimitDays),
  );
  const minOcrLength = pick('minOcrLength', (value) => readInteger(value, RANGES.minOcrLength));
  const geminiEnabled = pick('geminiEnabled', readBoolean);

  const high = pick('confidenceHigh', (value) => readInteger(value, RANGES.confidence));
  const medium = pick('confidenceMedium', (value) => readInteger(value, RANGES.confidence));

  /*
   * 高と中は互いに依存する。**片方だけ採ると、順序が逆転しうる**
   * （高=50・中=既定60 のような状態は、levelOf の分岐を意味の無いものにする）。
   * 片方でも読めない、または高 < 中 なら、両方とも既定へ落とす。
   */
  let thresholds = DEFAULT_THRESHOLDS;

  if (high !== null && medium !== null) {
    if (high >= medium) {
      thresholds = Object.freeze({ high, medium });
    } else {
      ignored.push(SETTINGS_KEYS.confidenceHigh, SETTINGS_KEYS.confidenceMedium);
    }
  } else if (high !== null || medium !== null) {
    /*
     * 片方だけ有効な場合も既定へ揃える。既定と混ぜたときに
     * 逆転しない保証が無いため（安全側）。
     */
    const known = high !== null ? SETTINGS_KEYS.confidenceHigh : SETTINGS_KEYS.confidenceMedium;

    if (!ignored.includes(known)) {
      ignored.push(known);
    }
  }

  return {
    limits: Object.freeze({
      ...DEFAULT_LIMITS,
      ...(maxAmount === null ? {} : { maxAmount }),
      ...(pastDateLimitDays === null ? {} : { pastDateLimitDays }),
    }),
    thresholds,
    minOcrLength: minOcrLength === null ? DEFAULT_MIN_OCR_LENGTH : minOcrLength,
    geminiEnabled: geminiEnabled === null ? true : geminiEnabled,
    /* 重複はまとめる（高・中の両方を落としたときに2回入るため）。 */
    ignored: [...new Set(ignored)],
  };
}

/* 何も読めなかったときの姿。app.js が初期値として使う。 */
export const FALLBACK_SETTINGS = Object.freeze(resolveSettings({}));

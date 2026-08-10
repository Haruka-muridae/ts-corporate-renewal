/*
 * 宛先の検証・重複排除・分割。**通信もDOMも持たない純粋な関数だけ。**
 * Node のテストランナー（tests/unit/card-mail.mjs）から直接検証する。
 *
 * ==================================================================
 * なぜ不正な宛先を「除いて送る」のではなく「見せて選ばせる」のか
 * ==================================================================
 * 台帳のメール列にはOCRの読み取りミスが残っていることがある。
 * 黙って除いて送ると、**送られなかった相手がいることに利用者が
 * 気づけない。** 不正な宛先は一覧で見せたうえで、「残りに送る」を
 * 利用者が選ぶ（app.js）。台帳の修正もここで促す。
 * ==================================================================
 */

import { BCC_BATCH_SIZE } from './config.js';

/*
 * メールアドレスの妥当性検査。
 *
 * RFC 5322 を完全に検査することはしない（quoted-string 等まで許すと
 * ヘッダーインジェクションの検査が複雑になる）。名刺に載る実在の
 * アドレスで使われる形だけを通す。
 */
const EMAIL_PATTERN = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export function isValidEmail(value) {
  if (typeof value !== 'string') {
    return false;
  }

  /* SMTPの実装上の上限。これより長いものは実在しないとみなす。 */
  if (value.length === 0 || value.length > 254) {
    return false;
  }

  return EMAIL_PATTERN.test(value);
}

/**
 * 宛先一覧を検証して、送信に使う形へ整える。
 *
 * 重複はアドレスの大文字小文字を無視して1つにまとめる（実在の
 * メールサーバーはほぼ大文字小文字を区別しないため）。送信には
 * 最初に現れた表記をそのまま使う。
 *
 * @param {unknown[]} rawValues 台帳から読んだ生の値
 * @returns {{ recipients: string[], invalid: string[], duplicateCount: number }}
 */
export function normalizeRecipients(rawValues) {
  const recipients = [];
  const invalid = [];
  const seen = new Set();
  let duplicateCount = 0;

  for (const raw of rawValues) {
    const value = typeof raw === 'string' ? raw.trim() : '';

    if (!isValidEmail(value)) {
      /* 何が弾かれたか利用者に見せるため、原形のまま集める。 */
      invalid.push(typeof raw === 'string' ? raw : String(raw));
      continue;
    }

    const key = value.toLowerCase();

    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }

    seen.add(key);
    recipients.push(value);
  }

  return { recipients, invalid, duplicateCount };
}

/** 宛先を1通ぶん（既定100件）ずつに分割する。 */
export function chunkRecipients(recipients, size = BCC_BATCH_SIZE) {
  const chunks = [];

  for (let index = 0; index < recipients.length; index += size) {
    chunks.push(recipients.slice(index, index + size));
  }

  return chunks;
}

/**
 * Stripe Webhook の署名検証（WebCrypto 版）。
 *
 * ------------------------------------------------------------------
 * lib/event/webhook-signature.mjs と同じ検証を、Node の crypto を使わずに
 * 行う。Workers ランタイムには node:crypto が無い（nodejs_compat を
 * 付けない方針は notifier-gate と同じ）ため、crypto.subtle だけで書く。
 *
 * 検証の内容（Stripe 公式「手動で検証」の手順どおり）:
 *   1. Stripe-Signature ヘッダーを t= と v1= に分解する
 *   2. "<t>.<生の本文>" を HMAC-SHA256（鍵 = whsec_…）で署名する
 *   3. v1 のどれかと定数時間で一致し、t が許容範囲内なら合格
 * ------------------------------------------------------------------
 */

/** 既定の許容時間（秒）。Stripe のライブラリの既定値と同じ。 */
export const DEFAULT_TOLERANCE_SECONDS = 300;

const encoder = new TextEncoder();

/** ヘッダーを t と v1 の一覧に分解する。形式が崩れていれば null。 */
export function parseSignatureHeader(header) {
  if (typeof header !== 'string' || header === '') {
    return null;
  }

  let timestamp = null;
  const signatures = [];

  header.split(',').forEach((part) => {
    const index = part.indexOf('=');

    if (index < 0) {
      return;
    }

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    if (key === 't') {
      timestamp = value;
    } else if (key === 'v1') {
      /* 鍵の入れ替え期間中は v1 が複数並ぶ。どれか1つが合えばよい。 */
      signatures.push(value.toLowerCase());
    }
  });

  if (timestamp === null || !/^[0-9]+$/.test(timestamp) || signatures.length === 0) {
    return null;
  }

  return { timestamp: Number(timestamp), signatures };
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** 長さの違いも含めて定数時間で比べる（途中で return しない）。 */
export function timingSafeEqualHex(a, b) {
  const left = String(a);
  const right = String(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;

  for (let i = 0; i < length; i += 1) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }

  return diff === 0;
}

/** "<t>.<body>" の HMAC-SHA256 を16進で返す。 */
export async function computeSignature(secret, timestamp, rawBody) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${rawBody}`));

  return toHex(signed);
}

/**
 * 署名を検証する。
 *
 * @return {{ok: boolean, reason: string}} 失敗理由はログ用。秘密は含めない。
 */
export async function verifyStripeSignature(rawBody, header, secret, {
  nowMs = Date.now(),
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
} = {}) {
  if (typeof secret !== 'string' || secret === '') {
    return { ok: false, reason: 'secret-missing' };
  }

  const parsed = parseSignatureHeader(header);

  if (!parsed) {
    return { ok: false, reason: 'header-malformed' };
  }

  const expected = await computeSignature(secret, parsed.timestamp, rawBody);
  let matched = false;

  /* 全部と比べてから判定する（どれで一致したかを時間で漏らさない）。 */
  parsed.signatures.forEach((signature) => {
    if (timingSafeEqualHex(signature, expected)) {
      matched = true;
    }
  });

  if (!matched) {
    return { ok: false, reason: 'signature-mismatch' };
  }

  const ageSeconds = Math.abs(Math.floor(nowMs / 1000) - parsed.timestamp);

  if (ageSeconds > toleranceSeconds) {
    return { ok: false, reason: 'timestamp-out-of-tolerance' };
  }

  return { ok: true, reason: '' };
}

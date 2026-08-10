/**
 * ライセンスの検証と、その結果のキャッシュ。
 *
 * ==================================================================
 * ここが V2 の要
 * ==================================================================
 * V1 は利用者の Apps Script だけで完結していたため、テンプレートを
 * コピーした人は解約後も通知を受け取り続けられた。V2 では
 *   - 判定（何を通知するか）
 *   - VAPID JWT の発行（そもそも push を送れるか）
 * の両方を運営側の Workers に置き、ライセンスが無ければどちらも返さない。
 * **テンプレートを改造しても迂回できない位置**に検証がある、というのが
 * この配置の理由である。
 * ==================================================================
 *
 * ==================================================================
 * 認証系 GAS が落ちているときの扱い（grace）
 * ==================================================================
 * Apps Script は稀に不調になる。そこで即座に通知を止めると、
 * 「払っているのに動かない」状態を運営の都合で作ることになる。
 * **直前まで有効だったライセンスに限り**最大72時間だけ継続させる。
 * 一度も検証できていないキーには猶予を与えない（fail closed）。
 * ==================================================================
 */

import {
  AUTH_GAS_TIMEOUT_MS,
  LICENSE_CACHE_TTL_MS,
  LICENSE_GRACE_MAX_MS,
  LICENSE_GRACE_RECHECK_MS,
  LICENSE_STATE,
} from './constants.mjs';

/**
 * ライセンスキーの形。
 *
 * 中身の正しさは認証系 GAS が決める。ここで見るのは「明らかに違うもの」を
 * 認証系まで運ばないための足切りだけ（base64url の文字だけからなる文字列）。
 */
const LICENSE_KEY_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;

/** ライセンスキーを正規化する。BOM と前後空白を落とすのは config.mjs と同じ方針。 */
export function normalizeLicenseKey(input) {
  return String(input === undefined || input === null ? '' : input)
    .replace(/^﻿/, '')
    .trim();
}

export function isLicenseKeyShaped(licenseKey) {
  return LICENSE_KEY_PATTERN.test(licenseKey);
}

/**
 * ライセンスキーの SHA-256（16進）。
 *
 * KV のキーとレート制限のキーはこれを使う。**生のキーを KV のキー名や
 * ログへ出さない**ため（キー名は運用画面から見えるうえ、キーそのものが
 * 通知を受け取る権利である）。
 */
export async function hashLicenseKey(licenseKey) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(licenseKey));
  const bytes = new Uint8Array(digest);
  let hex = '';

  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }

  return hex;
}

/** KV に置くレコードのキー。 */
export function licenseCacheKey(hash) {
  return `license:${hash}`;
}

/**
 * 認証系 GAS へ問い合わせる。
 *
 * 戻り値の reachable は「返事が読めたか」であり、valid とは別物。
 * 落ちている（reachable=false）ときだけ猶予の対象になるので、
 * 「無効という返事」と「返事が無い」を混ぜてはいけない。
 */
export async function verifyWithAuthGas({ licenseKey, env, fetchImpl = fetch }) {
  const url = String(env.AUTH_GAS_URL || '').trim();
  const secret = String(env.AUTH_GAS_SHARED_SECRET || '').trim();

  if (url === '' || secret === '') {
    /*
     * 設定漏れ。落ちているのと同じ扱いにはしない（猶予を与えると
     * 設定漏れに気づけないまま72時間動いてしまう）。
     */
    return { reachable: true, valid: false, plan: '', status: 'not-configured' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_GAS_TIMEOUT_MS);

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      /*
       * text/plain にするのは Apps Script のプリフライト回避の作法に合わせるため
       * （gas-auth/Main.gs のコメントと対）。共有シークレットは本文に入れる。
       * URL に載せると Apps Script 側の実行ログに残る。
       */
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'verifyNotifierLicense', secret, licenseKey }),
      signal: controller.signal,
      redirect: 'follow',
    });

    if (!response.ok) {
      return { reachable: false, valid: false, plan: '', status: `http-${response.status}` };
    }

    const body = await response.json();

    if (!body || body.ok !== true || !body.data) {
      /*
       * 形式が違う返事。Apps Script はエラー時に HTML を返すことがあり、
       * それを「無効」と読むと解約していない人の通知を止めてしまう。
       * 届かなかった扱い（猶予の対象）にする。
       */
      return { reachable: false, valid: false, plan: '', status: 'malformed' };
    }

    return {
      reachable: true,
      valid: body.data.valid === true,
      plan: String(body.data.plan || ''),
      status: String(body.data.status || ''),
    };
  } catch {
    return { reachable: false, valid: false, plan: '', status: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

async function readRecord(kv, key) {
  try {
    const raw = await kv.get(key);

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);

    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * ライセンスの状態を決める。
 *
 * 戻り値は { state, plan, reason }。reason はテストとログのためのもので、
 * 応答本文には入れない（利用者に見せる情報ではない）。
 */
export async function resolveLicense({ licenseKey, env, nowMs, fetchImpl = fetch }) {
  const key = normalizeLicenseKey(licenseKey);

  if (!isLicenseKeyShaped(key)) {
    return { state: LICENSE_STATE.EXPIRED, plan: '', reason: 'malformed-key' };
  }

  const hash = await hashLicenseKey(key);
  const cacheKey = licenseCacheKey(hash);
  const kv = env.LICENSE_CACHE;
  const record = kv ? await readRecord(kv, cacheKey) : null;
  const checkedAt = record && Number.isFinite(Number(record.checkedAt)) ? Number(record.checkedAt) : NaN;

  if (record && Number.isFinite(checkedAt)) {
    const age = nowMs - checkedAt;

    if (record.state === LICENSE_STATE.GRACE) {
      /* 猶予中は少し待ってから問い合わせ直す（LICENSE_GRACE_RECHECK_MS の理由を参照）。 */
      if (age >= 0 && age < LICENSE_GRACE_RECHECK_MS) {
        return graceOrExpired(record, nowMs, 'cache');
      }
    } else if (age >= 0 && age < LICENSE_CACHE_TTL_MS) {
      return { state: record.state, plan: String(record.plan || ''), reason: 'cache' };
    }
  }

  const verified = await verifyWithAuthGas({ licenseKey: key, env, fetchImpl });

  if (verified.reachable) {
    const state = verified.valid ? LICENSE_STATE.ACTIVE : LICENSE_STATE.EXPIRED;

    await writeRecord(kv, cacheKey, {
      v: 1,
      state,
      plan: verified.plan,
      checkedAt: nowMs,
      graceStartedAt: 0,
    }, Math.floor(LICENSE_CACHE_TTL_MS / 1000));

    return { state, plan: verified.plan, reason: 'verified' };
  }

  /*
   * 認証系まで届かなかった。**直前まで有効だったキーだけ**猶予に入れる。
   * 「無効」とキャッシュされているキーや、初めて見るキーは通さない。
   */
  if (!record || (record.state !== LICENSE_STATE.ACTIVE && record.state !== LICENSE_STATE.GRACE)) {
    return { state: LICENSE_STATE.EXPIRED, plan: '', reason: 'unverified' };
  }

  const graceStartedAt = Number(record.graceStartedAt) > 0 ? Number(record.graceStartedAt) : nowMs;
  const remainingMs = LICENSE_GRACE_MAX_MS - (nowMs - graceStartedAt);

  await writeRecord(kv, cacheKey, {
    v: 1,
    state: LICENSE_STATE.GRACE,
    plan: String(record.plan || ''),
    checkedAt: nowMs,
    graceStartedAt,
  /*
   * 猶予が尽きたら短い TTL で消えるに任せる。残しておいても
   * 「期限切れ」を返し続けるだけで、認証系が復帰したときは
   * レコードが無いほうが素直に verified からやり直せる。
   */
  }, Math.max(60, Math.floor(remainingMs / 1000)));

  return graceOrExpired({ ...record, graceStartedAt }, nowMs, 'grace');
}

function graceOrExpired(record, nowMs, reason) {
  const graceStartedAt = Number(record.graceStartedAt) > 0 ? Number(record.graceStartedAt) : nowMs;

  if (nowMs - graceStartedAt >= LICENSE_GRACE_MAX_MS) {
    return { state: LICENSE_STATE.EXPIRED, plan: '', reason: 'grace-exhausted' };
  }

  return { state: LICENSE_STATE.GRACE, plan: String(record.plan || ''), reason };
}

async function writeRecord(kv, key, value, ttlSeconds) {
  if (!kv) {
    return;
  }

  try {
    await kv.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, ttlSeconds) });
  } catch {
    /*
     * KV が書けなくても判定そのものは返せる。次回は必ず認証系へ問い合わせる
     * ことになるだけで、誤って通す方向には倒れない。
     */
  }
}

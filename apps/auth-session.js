/*
 * ログイン表示状態の保存層。
 * プロフィール情報の読み書きは、必ずこのモジュール経由で行う。
 *
 * ------------------------------------------------------------------
 * 保存方針
 * ------------------------------------------------------------------
 * 保存先は sessionStorage のみ。localStorage は使用しない。
 * タブを閉じたらプロフィール表示も消える、という状態にするため。
 *
 * 保存するもの（表示に必要な最小限）:
 *   sub / name / email / picture / emailVerified / expiresAt / v(形式バージョン)
 *
 * 保存しないもの:
 *   IDトークン（credential）そのもの / アクセストークン / refresh token /
 *   上記以外のclaim / cookie / URLパラメータ
 *
 * ここに入っているプロフィールは「未検証の表示用キャッシュ」である。
 * サーバー側で署名検証をしていないため、権限判定には使用しない。
 * ------------------------------------------------------------------
 */

import { GOOGLE_AUTH_CONFIG } from './auth-config.js';

/* 想定外に長い値でストレージを圧迫しないための上限。 */
const LIMITS = Object.freeze({
  sub: 128,
  name: 128,
  email: 254,
  picture: 2048,
});

/* JWTの exp は秒単位。極端に先の日時は不正とみなす（100日先まで許容）。 */
const MAX_LIFETIME_MS = 100 * 24 * 60 * 60 * 1000;

/*
 * sessionStorage を安全に取得する。
 * プライベートモードや設定によっては参照そのものが SecurityError を投げる。
 * 使用できない場合は null を返し、呼び出し側は保存なしで動作を継続する。
 */
function getStorage() {
  try {
    const storage = globalThis.sessionStorage;
    return storage ?? null;
  } catch {
    /* SecurityError など。ログインUI自体は動かせるので握りつぶす。 */
    return null;
  }
}

function toSafeString(value, maxLength) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  if (trimmed === '' || trimmed.length > maxLength) {
    return null;
  }

  return trimmed;
}

/*
 * プロフィール画像URLの検証。
 * https のみ許可する（javascript: や data: を弾く）。
 * 不正なら null を返し、UI側はイニシャル表示へ切り替える。
 */
function toSafePictureUrl(value) {
  const raw = toSafeString(value, LIMITS.picture);

  if (raw === null) {
    return null;
  }

  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/*
 * IDトークンのpayloadから、表示用プロフィールへ変換する。
 * 必須は sub と exp のみ。name / email / picture は欠けていても表示側で吸収する。
 * 変換できない場合は null を返す（例外は投げない）。
 */
export function sanitizeProfile(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const sub = toSafeString(payload.sub, LIMITS.sub);

  if (sub === null) {
    return null;
  }

  const exp = payload.exp;

  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) {
    return null;
  }

  const expiresAt = Math.floor(exp * 1000);

  if (expiresAt > Date.now() + MAX_LIFETIME_MS) {
    /* 期限が異常に先。壊れた値として扱う。 */
    return null;
  }

  const email = toSafeString(payload.email, LIMITS.email);

  return {
    sub,
    /* name が無い場合は given_name / family_name の組み立てを試す。 */
    name: toSafeString(payload.name, LIMITS.name)
      ?? toSafeString(
        [payload.family_name, payload.given_name]
          .filter((part) => typeof part === 'string' && part.trim() !== '')
          .join(' '),
        LIMITS.name,
      ),
    email: email !== null && email.includes('@') ? email : null,
    picture: toSafePictureUrl(payload.picture),
    emailVerified: payload.email_verified === true,
    expiresAt,
  };
}

/* 期限切れ判定。壊れた値も「期限切れ」として扱い、削除対象にする。 */
export function isProfileExpired(profile, now = Date.now()) {
  if (!profile || typeof profile !== 'object') {
    return true;
  }

  const { expiresAt } = profile;

  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return true;
  }

  return expiresAt <= now;
}

/* 保存する。失敗しても例外を外へ出さない（保存できなくても表示は続行する）。 */
export function saveProfile(profile) {
  const storage = getStorage();

  if (!storage || !profile) {
    return false;
  }

  try {
    storage.setItem(GOOGLE_AUTH_CONFIG.storageKey, JSON.stringify({
      v: GOOGLE_AUTH_CONFIG.storageVersion,
      sub: profile.sub,
      name: profile.name ?? null,
      email: profile.email ?? null,
      picture: profile.picture ?? null,
      emailVerified: profile.emailVerified === true,
      expiresAt: profile.expiresAt,
    }));
    return true;
  } catch {
    /* 容量超過・SecurityError など。 */
    return false;
  }
}

/* 削除する。存在しない場合も成功扱い。 */
export function clearProfile() {
  const storage = getStorage();

  if (!storage) {
    return false;
  }

  try {
    storage.removeItem(GOOGLE_AUTH_CONFIG.storageKey);
    return true;
  } catch {
    return false;
  }
}

/*
 * 読み出す。
 * 形式違い・JSON破損・バージョン不一致・期限切れは、その場で削除して null を返す。
 * 呼び出し側は「壊れたデータで画面が壊れる」ことを考えなくてよい。
 */
export function loadProfile() {
  const storage = getStorage();

  if (!storage) {
    return null;
  }

  let raw;

  try {
    raw = storage.getItem(GOOGLE_AUTH_CONFIG.storageKey);
  } catch {
    return null;
  }

  if (typeof raw !== 'string' || raw === '') {
    return null;
  }

  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch {
    clearProfile();
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || parsed.v !== GOOGLE_AUTH_CONFIG.storageVersion) {
    clearProfile();
    return null;
  }

  const sub = toSafeString(parsed.sub, LIMITS.sub);

  if (sub === null) {
    clearProfile();
    return null;
  }

  const profile = {
    sub,
    name: toSafeString(parsed.name, LIMITS.name),
    email: toSafeString(parsed.email, LIMITS.email),
    picture: toSafePictureUrl(parsed.picture),
    emailVerified: parsed.emailVerified === true,
    expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : null,
  };

  if (isProfileExpired(profile)) {
    clearProfile();
    return null;
  }

  return profile;
}

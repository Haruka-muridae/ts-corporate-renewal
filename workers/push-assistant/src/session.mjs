/**
 * HMAC 署名付き Cookie（仕様書 §5）。
 *
 * ==================================================================
 * サーバー側にセッション表を持たない理由
 * ==================================================================
 * D1 に sessions 表を作れば失効（revoke）を即時にできるが、
 * **毎リクエストで 1 回の D1 読み取り**が増える。Push Assistant の
 * 画面は起動時に /api/me → /api/events → /api/notifications と続けて
 * 叩くため、これがそのまま 3 倍になる。
 *
 * MVP の失効要件は「ログアウト」と「接続解除」だけで、どちらも
 * 利用者本人の操作である。Cookie を消せば端末からは消え、
 * 接続解除では D1 のトークンごと消えるので、Cookie が残っていても
 * カレンダーには到達できない（/api/events は google_tokens が要る）。
 * 署名だけで足りる、と判断した。
 *
 * 採らなかった案: JWT ライブラリ … 外部ライブラリを入れない方針。
 * ここで要るのは HMAC-SHA256 1 つで、alg 混同のような JWT 固有の
 * 落とし穴も持ち込まずに済む（アルゴリズムを本文に書かないため）。
 * ==================================================================
 *
 * 形式: `base64url(JSON) . base64url(HMAC-SHA256(base64url(JSON)))`
 *
 * **署名の対象は base64url した後の文字列**にしてある。JSON を
 * 再直列化してから検証すると、キーの順序が変わるだけで壊れるため。
 */

import {
  base64ToBytes,
  base64UrlEncode,
  timingSafeEqual,
  utf8Bytes,
} from './crypto-util.mjs';

/**
 * SESSION_SECRET の最低長（バイト）。HMAC-SHA256 の鍵として意味のある下限。
 * base64 の 32 バイトは 44 文字になるので、正しく登録されていれば弾かれない。
 */
export const MIN_SIGNING_KEY_BYTES = 32;

/**
 * 鍵素材の実効バイト数を見積もる。
 *
 * base64 / base64url として読めるならその復号後の長さ、読めなければ
 * UTF-8 のバイト数を使う。**登録の形を 1 つに縛らないため**
 * （運用者が base64 を貼っても、長い合言葉を貼っても通るようにしてある）。
 */
function signingKeyStrengthBytes(text) {
  const utf8Length = utf8Bytes(text).length;

  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) {
    try {
      return Math.max(utf8Length, base64ToBytes(text).length);
    } catch {
      /* base64 として読めなかっただけ。UTF-8 の長さで判断する。 */
    }
  }

  return utf8Length;
}

/**
 * SESSION_SECRET から HMAC の鍵を作る。
 *
 * **短い鍵を黙って受け入れない。** WebCrypto は 1 バイトの鍵でも importKey に
 * 成功するため、貼り付け事故（途中で切れた・空で登録された）が
 * 「セッションは発行できるが総当たりで偽造できる」状態として静かに残る。
 * wrangler secret put は貼り付けに失敗しても Success と表示するので、
 * 使う側で長さを見るしかない。
 *
 * **メッセージに値を入れない**（そのままログへ出るため）。長さも出さない。
 */
export async function importSigningKey(secret) {
  const text = String(secret ?? '').trim();

  if (text === '') {
    throw new Error('SESSION_SECRET が設定されていません。');
  }

  if (signingKeyStrengthBytes(text) < MIN_SIGNING_KEY_BYTES) {
    throw new Error(
      `SESSION_SECRET が短すぎます（${MIN_SIGNING_KEY_BYTES} バイト以上が必要）。`
      + ' 途中で切れていないか、空で登録されていないか確認してください。',
    );
  }

  return crypto.subtle.importKey(
    'raw',
    utf8Bytes(text),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/**
 * 値に署名する。payload はそのまま JSON にできるオブジェクト。
 *
 * `exp`（秒）を入れておくと verifyValue が期限を見る。Cookie の Max-Age は
 * ブラウザの都合でしかなく、**期限は署名の中に入っていないと意味が無い**
 * （Cookie を手で送り直せば Max-Age は無視できる）。
 */
export async function signValue(key, payload) {
  const encoded = base64UrlEncode(utf8Bytes(JSON.stringify(payload)));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8Bytes(encoded)));

  return `${encoded}.${base64UrlEncode(signature)}`;
}

/**
 * 署名を検証して中身を返す。
 *
 * 失敗の理由（reason）は**ログ用**であり、応答にそのまま出さない。
 * 「署名が違う」と「期限切れ」を利用者に区別させても得が無く、
 * 偽造の試行に手掛かりを与える。
 */
export async function verifyValue(key, token, { nowMs }) {
  const text = String(token ?? '');
  const dot = text.indexOf('.');

  if (dot <= 0 || dot === text.length - 1) {
    return { ok: false, reason: 'MALFORMED' };
  }

  const encoded = text.slice(0, dot);
  const provided = text.slice(dot + 1);

  let providedBytes;

  try {
    providedBytes = base64ToBytes(provided);
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }

  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8Bytes(encoded)));

  if (!timingSafeEqual(expected, providedBytes)) {
    return { ok: false, reason: 'BAD_SIGNATURE' };
  }

  let value;

  try {
    value = JSON.parse(new TextDecoder().decode(base64ToBytes(encoded)));
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'MALFORMED' };
  }

  if (typeof value.exp === 'number' && value.exp * 1000 <= nowMs) {
    return { ok: false, reason: 'EXPIRED' };
  }

  return { ok: true, value };
}

/**
 * Cookie ヘッダを名前→値の object にする。
 *
 * 同じ名前が複数あれば**最初のものを採る**。Path の違う Cookie が
 * 同名で並ぶことは無い設計だが、後勝ちにすると、より広い Path の
 * 古い Cookie で上書きされうる（ブラウザは狭い Path のものを先に送る）。
 */
export function parseCookies(header) {
  const out = {};

  for (const part of String(header ?? '').split(';')) {
    const trimmed = part.trim();

    if (trimmed === '') {
      continue;
    }

    const eq = trimmed.indexOf('=');

    if (eq <= 0) {
      continue;
    }

    const name = trimmed.slice(0, eq).trim();

    if (Object.prototype.hasOwnProperty.call(out, name)) {
      continue;
    }

    out[name] = trimmed.slice(eq + 1).trim();
  }

  return out;
}

/**
 * Set-Cookie の 1 行を作る。
 *
 * 属性は仕様書 §5 のとおり固定。
 *   HttpOnly … JavaScript から読めない（XSS でセッションを持ち出せない）
 *   Secure   … http では送らない
 *   SameSite=Lax … 他サイトからの POST に付かない。Origin 照合と二重で CSRF を防ぐ。
 *                  Strict にしないのは、Google からのリダイレクト（トップレベル GET）で
 *                  発行直後の Cookie を使えなくなるため
 *   Path     … /push-assistant/ 配下だけ。他のアプリへ送られない
 *
 * `maxAgeSec: 0` は削除の意味（値も空にする）。
 */
export function buildSetCookie(name, value, { path, maxAgeSec, secure = true }) {
  const parts = [
    `${name}=${value}`,
    `Path=${path}`,
    `Max-Age=${maxAgeSec}`,
    'HttpOnly',
    'SameSite=Lax',
  ];

  if (secure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

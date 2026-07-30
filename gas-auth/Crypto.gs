/**
 * 乱数・ハッシュ・鍵付きハッシュ。
 *
 * ------------------------------------------------------------------
 * Apps Script の制約
 * ------------------------------------------------------------------
 * Apps Script には crypto.getRandomValues も PBKDF2 も無い。
 * 使えるのは Utilities の SHA-256 / HMAC-SHA256 と Utilities.getUuid()
 * （RFC 4122 v4。1つあたり122ビットの乱数）だけである。
 *
 * そこで:
 *   乱数   … 複数の UUID を連結して SHA-256 で圧縮する
 *   PBKDF2 … HMAC-SHA256 を仕様どおりに反復して自前で組む
 *
 * 反復回数は Apps Script の実行速度に律速される。
 * 詳細と、その弱さをどう補っているかは SECURITY_NOTES.md を参照。
 * ------------------------------------------------------------------
 */

/** バイト配列（GAS は符号付き -128..127）を16進文字列にする。 */
function bytesToHex_(bytes) {
  var out = '';

  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] & 0xff;
    out += (b < 16 ? '0' : '') + b.toString(16);
  }

  return out;
}

/** 16進文字列をバイト配列へ戻す。不正な文字列は空配列。 */
function hexToBytes_(hex) {
  var text = trimStr_(hex);

  if (text.length === 0 || text.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(text)) {
    return [];
  }

  var out = [];

  for (var i = 0; i < text.length; i += 2) {
    var value = parseInt(text.substr(i, 2), 16);
    /* シートやAPIへ渡すときに符号付きで扱えるようにしておく。 */
    out.push(value > 127 ? value - 256 : value);
  }

  return out;
}

/** URLに載せられる base64（+/ を -_ に、= を落とす）。 */
function base64UrlEncode_(bytes) {
  return Utilities.base64Encode(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * 推測困難なトークンを作る。
 * 戻り値は base64url（32バイト＝256ビット相当）。
 *
 * getUuid() を3つ使うのは、1つ（122ビット）に依存せず、
 * 実装差があっても十分な予測不能性を確保するため。
 */
function randomToken_() {
  var material = [
    Utilities.getUuid(),
    Utilities.getUuid(),
    Utilities.getUuid(),
    String(nowMs_()),
    String(Math.random())
  ].join('|');

  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    material,
    Utilities.Charset.UTF_8
  );

  return base64UrlEncode_(digest);
}

/** ソルト（16バイト）を16進文字列で作る。 */
function randomSalt_() {
  var material = Utilities.getUuid() + '|' + Utilities.getUuid() + '|' + String(nowMs_());
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    material,
    Utilities.Charset.UTF_8
  );

  return bytesToHex_(digest.slice(0, 16));
}

/** 識別子（シートの主キー）。秘密ではないので UUID をそのまま使う。 */
function newId_(prefix) {
  return (prefix ? prefix + '_' : '') + Utilities.getUuid();
}

/** HMAC-SHA256。鍵と値は文字列。戻り値は16進。 */
function hmacHex_(value, key) {
  var bytes = Utilities.computeHmacSha256Signature(String(value), String(key));
  return bytesToHex_(bytes);
}

/** SHA-256。戻り値は16進。 */
function sha256Hex_(value) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value),
    Utilities.Charset.UTF_8
  );

  return bytesToHex_(bytes);
}

/**
 * 一定時間で比較する。
 *
 * `a === b` は先頭が違えば即座に false を返すため、
 * 比較にかかった時間から「どこまで合っていたか」が漏れうる。
 * 長さの違いも隠すため、長さの不一致でも全体を走査する。
 */
function timingSafeEqual_(a, b) {
  var left = String(a === null || a === undefined ? '' : a);
  var right = String(b === null || b === undefined ? '' : b);

  var length = Math.max(left.length, right.length);
  var diff = left.length ^ right.length;

  for (var i = 0; i < length; i++) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }

  return diff === 0;
}

/**
 * PBKDF2-HMAC-SHA256（出力32バイト固定）。
 *
 * RFC 8018 の PBKDF2 を、出力長 = ハッシュ長 の場合に限って実装する。
 *   T = U1 xor U2 xor ... xor Uc
 *   U1 = HMAC(P, S || INT(1))
 *   Ui = HMAC(P, U(i-1))
 *
 * 出力を32バイトに固定しているため、ブロック連結（INT(2) 以降）は不要。
 *
 * @param {string} password  利用者のパスワード
 * @param {string} saltHex   16進のソルト
 * @param {number} iterations 反復回数（1以上）
 * @return {string} 16進32バイト
 */
function pbkdf2Sha256Hex_(password, saltHex, iterations) {
  var count = Math.max(1, Math.floor(Number(iterations) || 1));
  var passwordBytes = stringToUtf8Bytes_(password);
  var saltBytes = hexToBytes_(saltHex);

  /* S || INT(1)。ビッグエンディアンの 32bit 整数。 */
  var block = saltBytes.concat([0, 0, 0, 1]);

  var u = Utilities.computeHmacSha256Signature(block, passwordBytes);
  var t = u.slice(0);

  for (var i = 1; i < count; i++) {
    u = Utilities.computeHmacSha256Signature(u, passwordBytes);

    for (var j = 0; j < t.length; j++) {
      /* 符号付き8bit同士の XOR は符号付き8bitに収まる。 */
      t[j] = t[j] ^ u[j];
    }
  }

  return bytesToHex_(t);
}

/**
 * 文字列を UTF-8 のバイト配列にする。
 * Utilities.newBlob(...).getBytes() が最も確実（サロゲートペアも正しく扱う）。
 */
function stringToUtf8Bytes_(value) {
  return Utilities.newBlob(String(value === null || value === undefined ? '' : value)).getBytes();
}

/**
 * Stripe の署名ヘッダー（t=...,v1=...）を検証する。
 *
 * ------------------------------------------------------------------
 * この関数が使える場面は限られる（重要）
 * ------------------------------------------------------------------
 * Apps Script の doPost(e) には **HTTPヘッダーが渡らない**。
 * したがって Stripe が付ける Stripe-Signature ヘッダーを、
 * Apps Script 単体では受け取れない。
 *
 * この関数は次の2つの経路で使う。
 *   1. 署名をクエリ等で転送してくれる中継（Cloudflare Worker など）を置く場合
 *   2. 自動テスト
 *
 * 中継を置かない構成では Webhook.gs の「Stripe APIへの照会」で
 * 真正性を確認する。詳細は STRIPE_SETUP.md / SECURITY_NOTES.md を参照。
 * ------------------------------------------------------------------
 *
 * @param {string} payload   受信した生のリクエストボディ
 * @param {string} header    Stripe-Signature の値
 * @param {string} secret    whsec_ で始まる署名シークレット
 * @param {number} toleranceSeconds 許容する時刻ずれ（既定300秒）
 * @param {number} nowSeconds 現在時刻（テスト用。省略時は現在）
 * @return {{ok: boolean, reason: string}}
 */
function verifyStripeSignature_(payload, header, secret, toleranceSeconds, nowSeconds) {
  var tolerance = Number(toleranceSeconds);

  if (!isFinite(tolerance) || tolerance <= 0) {
    tolerance = 300;
  }

  var now = Number(nowSeconds);

  if (!isFinite(now) || now <= 0) {
    now = Math.floor(nowMs_() / 1000);
  }

  if (trimStr_(secret) === '') {
    return { ok: false, reason: 'NO_SECRET' };
  }

  var headerText = trimStr_(header);

  if (headerText === '') {
    return { ok: false, reason: 'NO_HEADER' };
  }

  var timestamp = '';
  var signatures = [];
  var parts = headerText.split(',');

  for (var i = 0; i < parts.length; i++) {
    var pair = parts[i].split('=');

    if (pair.length < 2) {
      continue;
    }

    var name = trimStr_(pair[0]);
    /* 値そのものに = が含まれても壊れないよう、最初の = で割った残りを使う。 */
    var value = trimStr_(parts[i].slice(parts[i].indexOf('=') + 1));

    if (name === 't') {
      timestamp = value;
    } else if (name === 'v1') {
      signatures.push(value);
    }
  }

  if (timestamp === '' || signatures.length === 0) {
    return { ok: false, reason: 'MALFORMED_HEADER' };
  }

  var timestampNumber = Number(timestamp);

  if (!isFinite(timestampNumber) || timestampNumber <= 0) {
    return { ok: false, reason: 'MALFORMED_HEADER' };
  }

  /* 古い署名の再送（リプレイ）を弾く。 */
  if (Math.abs(now - timestampNumber) > tolerance) {
    return { ok: false, reason: 'TIMESTAMP_OUT_OF_RANGE' };
  }

  var expected = hmacHex_(timestamp + '.' + String(payload), secret);
  var matched = false;

  for (var k = 0; k < signatures.length; k++) {
    /* 早期 return しない。どの署名で一致したかを時間差で漏らさない。 */
    if (timingSafeEqual_(expected, signatures[k])) {
      matched = true;
    }
  }

  return matched ? { ok: true, reason: '' } : { ok: false, reason: 'SIGNATURE_MISMATCH' };
}

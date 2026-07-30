/**
 * 小さな共通処理。
 * 依存を持たない純粋な関数だけを置く。
 */

/** 文字列を trim して返す。文字列以外（数値・Date・null）は文字列化してから trim。 */
function trimStr_(value) {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    return value.trim();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return String(value).trim();
}

/**
 * メールアドレスを正規化する。
 * 前後の空白を除去し、小文字化する。
 * ドット除去やプラス以降の切り捨ては **行わない**
 * （Gmail 以外では別アドレスとして扱われるため）。
 */
function normalizeEmail_(value) {
  return trimStr_(value).toLowerCase();
}

/**
 * メールアドレスとして成立している形かを確認する。
 * RFC の完全な検証はしない。実務上の誤入力を弾くための最低限。
 */
function isValidEmail_(value) {
  var email = trimStr_(value);

  if (email === '' || email.length > 254) {
    return false;
  }

  return /^[^\s@,;:<>"'\\]+@[^\s@,;:<>"'\\.]+(\.[^\s@,;:<>"'\\.]+)+$/.test(email);
}

/**
 * ログ用にメールアドレスを伏せる。
 *   taro@example.com → t***@example.com
 * ローカル部が1文字なら先頭も伏せる。
 */
function maskEmail_(value) {
  var email = normalizeEmail_(value);

  if (email === '') {
    return '';
  }

  var at = email.indexOf('@');

  if (at <= 0) {
    return '***';
  }

  var local = email.slice(0, at);
  var domain = email.slice(at);
  var head = local.length >= 2 ? local.charAt(0) : '';

  return head + '***' + domain;
}

/**
 * User-Agent を短い要約へ落とす。
 * 端末の識別ではなく「どの種類のブラウザか」を残すだけ。
 * 個人を特定しうる長い文字列はログへ入れない。
 */
function summarizeUserAgent_(value) {
  var ua = trimStr_(value);

  if (ua === '') {
    return 'unknown';
  }

  var platform = 'other';

  if (/iPhone|iPad|iPod/i.test(ua)) {
    platform = 'ios';
  } else if (/Android/i.test(ua)) {
    platform = 'android';
  } else if (/Windows/i.test(ua)) {
    platform = 'windows';
  } else if (/Mac OS X|Macintosh/i.test(ua)) {
    platform = 'mac';
  } else if (/Linux/i.test(ua)) {
    platform = 'linux';
  }

  var browser = 'other';

  if (/Edg\//i.test(ua)) {
    browser = 'edge';
  } else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) {
    browser = 'chrome';
  } else if (/Firefox\//i.test(ua)) {
    browser = 'firefox';
  } else if (/Safari\//i.test(ua)) {
    browser = 'safari';
  }

  return platform + '/' + browser;
}

/** ISO 8601（UTC）の文字列。シートには文字列として書く。 */
function toIso_(date) {
  var value = (date instanceof Date) ? date : new Date(date);

  if (isNaN(value.getTime())) {
    return '';
  }

  return value.toISOString();
}

/** 現在時刻（ミリ秒）。テストで差し替えやすいよう1か所に集約する。 */
function nowMs_() {
  return new Date().getTime();
}

function nowIso_() {
  return toIso_(new Date(nowMs_()));
}

/**
 * シートの値を時刻（ミリ秒）へ変換する。
 * 空・不正な値は 0（＝未設定）として扱う。
 */
function parseTimeMs_(value) {
  if (value instanceof Date) {
    var direct = value.getTime();
    return isNaN(direct) ? 0 : direct;
  }

  var text = trimStr_(value);

  if (text === '') {
    return 0;
  }

  var parsed = Date.parse(text);
  return isNaN(parsed) ? 0 : parsed;
}

/** シートの真偽値。TRUE / true / 1 / はい を真とする。 */
function parseBool_(value) {
  if (value === true) {
    return true;
  }

  var text = trimStr_(value).toUpperCase();

  return text === 'TRUE' || text === '1' || text === 'YES' || text === 'はい';
}

/** シートへ書く真偽値の表記。 */
function boolToCell_(value) {
  return value ? 'TRUE' : 'FALSE';
}

/** 数値。負数・非数値は 0 に丸める。 */
function parseCount_(value) {
  var num = Number(trimStr_(value));

  if (!isFinite(num) || num < 0) {
    return 0;
  }

  return Math.floor(num);
}

/**
 * 長すぎる文字列を切り詰める。
 * ログやシートに想定外の巨大な値を残さないため。
 */
function clip_(value, maxLength) {
  var text = trimStr_(value);
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

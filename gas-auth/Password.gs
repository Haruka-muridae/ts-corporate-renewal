/**
 * パスワードのハッシュ化と照合。
 *
 * ------------------------------------------------------------------
 * 保存形式
 * ------------------------------------------------------------------
 *   password_salt … 利用者ごとに異なるランダム16バイト（16進）
 *   password_hash … "pbkdf2$sha256$<反復回数>$<16進64文字>"
 *
 * 反復回数を値の中に持たせているため、あとから回数を増やしても
 * 既存利用者がログインできなくなることはない。
 * 現行設定と違う回数で保存されていたら、ログイン成功時に静かに作り直す。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * pepper（追加の鍵）
 * ------------------------------------------------------------------
 * PBKDF2 の出力に、Script Properties の PASSWORD_PEPPER で
 * HMAC-SHA256 を掛けてから保存する。
 *
 * pepper はスプレッドシートに存在しない。
 * したがってシートだけが漏れても、総当たりには pepper が必要になる。
 * Apps Script では反復回数を大きくできない（1回のログインが遅くなる）ため、
 * この二重化で不足を補っている。SECURITY_NOTES.md に詳細を書く。
 * ------------------------------------------------------------------
 *
 * 平文パスワードはこのファイルの外へ出さない。
 * ログにも、戻り値にも、例外メッセージにも含めない。
 */

var PASSWORD_ALGORITHM = 'pbkdf2';
var PASSWORD_DIGEST = 'sha256';

/**
 * 未登録メールアドレスに対しても照合と同じだけ時間を使うためのダミー。
 * 実在しないユーザーの応答が速いと、登録の有無を推測されてしまう。
 */
var DUMMY_SALT_HEX = '00112233445566778899aabbccddeeff';

/** 現在の反復回数（設定シートで変更できる）。 */
function getPbkdf2Iterations_() {
  var value = getSettingNumber_('PBKDF2_ITERATIONS', 10000);

  /* 極端に小さい値を設定されても安全側へ寄せる。 */
  if (!isFinite(value) || value < 1000) {
    return 1000;
  }

  return Math.floor(value);
}

/** pepper。未設定でも動作はするが、その旨を1度だけ警告する。 */
function getPasswordPepper_() {
  var pepper = getProperty_(PROP.PASSWORD_PEPPER);

  if (pepper === '') {
    Logger.log('警告: PASSWORD_PEPPER が未設定です。setupAuthSystem() を実行してください。');
  }

  return pepper;
}

/**
 * パスワードを保存できる形にする。
 * @return {{hash: string, salt: string}}
 */
function hashPassword_(password, saltHex, iterations) {
  var salt = trimStr_(saltHex) === '' ? randomSalt_() : trimStr_(saltHex);
  var count = iterations || getPbkdf2Iterations_();
  var derived = pbkdf2Sha256Hex_(password, salt, count);
  var peppered = hmacHex_(derived, getPasswordPepper_());

  return {
    hash: [PASSWORD_ALGORITHM, PASSWORD_DIGEST, count, peppered].join('$'),
    salt: salt
  };
}

/** 保存形式を分解する。壊れていれば null。 */
function parsePasswordHash_(stored) {
  var text = trimStr_(stored);

  if (text === '') {
    return null;
  }

  var parts = text.split('$');

  if (parts.length !== 4) {
    return null;
  }

  if (parts[0] !== PASSWORD_ALGORITHM || parts[1] !== PASSWORD_DIGEST) {
    return null;
  }

  var iterations = Number(parts[2]);

  if (!isFinite(iterations) || iterations < 1) {
    return null;
  }

  return { iterations: Math.floor(iterations), hash: parts[3] };
}

/**
 * 照合する。
 * @return {{ok: boolean, needsRehash: boolean}}
 */
function verifyPassword_(password, storedHash, saltHex) {
  var parsed = parsePasswordHash_(storedHash);

  if (!parsed || trimStr_(saltHex) === '') {
    return { ok: false, needsRehash: false };
  }

  var derived = pbkdf2Sha256Hex_(password, saltHex, parsed.iterations);
  var peppered = hmacHex_(derived, getPasswordPepper_());
  var matched = timingSafeEqual_(peppered, parsed.hash);

  return {
    ok: matched,
    needsRehash: matched && parsed.iterations !== getPbkdf2Iterations_()
  };
}

/**
 * 存在しない利用者に対して、照合と同じ計算量を消費する。
 * 結果は使わない。返り値も常に false。
 */
function consumeDummyVerification_(password) {
  var derived = pbkdf2Sha256Hex_(password, DUMMY_SALT_HEX, getPbkdf2Iterations_());
  hmacHex_(derived, getPasswordPepper_());
  return false;
}

/**
 * パスワードの強さを確認する。
 * 画面と同じ条件をサーバー側でも必ず確認する（画面の検証に依存しない）。
 *
 * @return {{ok: boolean, message: string}}
 */
function validatePasswordStrength_(password) {
  var min = getSettingNumber_('PASSWORD_MIN_LENGTH', 12);
  var max = getSettingNumber_('PASSWORD_MAX_LENGTH', 128);

  if (typeof password !== 'string') {
    return { ok: false, message: 'パスワードを入力してください。' };
  }

  if (password.length === 0) {
    return { ok: false, message: 'パスワードを入力してください。' };
  }

  /* 空白だけのパスワードを弾く。 */
  if (password.trim().length === 0) {
    return { ok: false, message: 'パスワードに空白以外の文字を含めてください。' };
  }

  if (password.length < min) {
    return { ok: false, message: 'パスワードは' + min + '文字以上で設定してください。' };
  }

  if (password.length > max) {
    return { ok: false, message: 'パスワードは' + max + '文字以内で設定してください。' };
  }

  /* 同じ文字だけの並びを弾く（12文字あっても強くはない）。 */
  if (/^(.)\1+$/.test(password)) {
    return { ok: false, message: '同じ文字の繰り返しは設定できません。' };
  }

  return { ok: true, message: '' };
}

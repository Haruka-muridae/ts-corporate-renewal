/*
 * 暗号まわりの検証。
 *
 * ここが間違っていると、他のすべてが崩れる。
 * 特に PBKDF2 は「動いている」だけでは足りず、
 * **仕様どおりの値になっているか** を Node の標準実装と突き合わせる。
 */

import { pbkdf2Sync, createHmac } from 'node:crypto';

import { check, section, finish, fatal } from '../../apps/tests/helpers/assert.mjs';
import { createGasEnvironment } from '../helpers/gas-harness.mjs';

try {
  const env = createGasEnvironment();
  const gas = env.api;

  /* ---------------------------------------------------------------- */
  section('16進とbase64url');

  check(
    'bytesToHex_ が符号付きバイトを正しく16進にする',
    gas.bytesToHex_([0, 1, -1, -128, 127]) === '0001ff807f',
    gas.bytesToHex_([0, 1, -1, -128, 127]),
  );

  check(
    'hexToBytes_ は bytesToHex_ の逆になる',
    gas.bytesToHex_(gas.hexToBytes_('0001ff807f')) === '0001ff807f',
  );

  check('hexToBytes_ は奇数長を拒否する', gas.hexToBytes_('abc').length === 0);
  check('hexToBytes_ は16進以外を拒否する', gas.hexToBytes_('zz').length === 0);

  const encoded = gas.base64UrlEncode_(gas.hexToBytes_('fbff'));
  check(
    'base64UrlEncode_ は + / = を含まない',
    !/[+/=]/.test(encoded),
    encoded,
  );

  /* ---------------------------------------------------------------- */
  section('乱数');

  const tokens = new Set();

  for (let i = 0; i < 200; i += 1) {
    tokens.add(gas.randomToken_());
  }

  check('randomToken_ は200回呼んでも重複しない', tokens.size === 200, tokens.size);

  const sampleToken = gas.randomToken_();
  check(
    'randomToken_ は256ビット相当（base64urlで43文字）',
    sampleToken.length === 43,
    sampleToken.length,
  );

  check(
    'randomToken_ はURLに載せられる文字だけ',
    /^[A-Za-z0-9_-]+$/.test(sampleToken),
    sampleToken,
  );

  const salts = new Set();

  for (let i = 0; i < 200; i += 1) {
    salts.add(gas.randomSalt_());
  }

  check('randomSalt_ は200回呼んでも重複しない', salts.size === 200, salts.size);
  check('randomSalt_ は16バイト（32文字の16進）', gas.randomSalt_().length === 32);

  /* ---------------------------------------------------------------- */
  section('PBKDF2-HMAC-SHA256（Nodeの標準実装と一致すること）');

  /*
   * 自前実装が「それらしい値」を返しているだけでは意味がない。
   * RFC 8018 どおりかを、Node の pbkdf2Sync と1バイト単位で突き合わせる。
   */
  const vectors = [
    { password: 'password', saltHex: '73616c74', iterations: 1 },
    { password: 'password', saltHex: '73616c74', iterations: 2 },
    { password: 'password', saltHex: '73616c74', iterations: 4096 },
    { password: 'Password-With-Symbols!#$%', saltHex: '00112233445566778899aabbccddeeff', iterations: 1000 },
    /* 日本語（マルチバイト）を含む場合。UTF-8 の扱いを間違えるとここで落ちる。 */
    { password: 'パスワード漢字テスト', saltHex: 'ffeeddccbbaa99887766554433221100', iterations: 500 },
    /* サロゲートペア（絵文字）。 */
    { password: 'pass🔐word', saltHex: 'aabbccddeeff00112233445566778899', iterations: 300 },
  ];

  for (const vector of vectors) {
    const mine = gas.pbkdf2Sha256Hex_(vector.password, vector.saltHex, vector.iterations);
    const expected = pbkdf2Sync(
      Buffer.from(vector.password, 'utf8'),
      Buffer.from(vector.saltHex, 'hex'),
      vector.iterations,
      32,
      'sha256',
    ).toString('hex');

    check(
      `PBKDF2 が一致する（${vector.iterations}回 / ${vector.password.slice(0, 12)}）`,
      mine === expected,
      `mine=${mine} expected=${expected}`,
    );
  }

  check(
    'PBKDF2 は反復回数が違えば別の値になる',
    gas.pbkdf2Sha256Hex_('x', '00', 10) !== gas.pbkdf2Sha256Hex_('x', '00', 11),
  );

  check(
    'PBKDF2 はソルトが違えば別の値になる',
    gas.pbkdf2Sha256Hex_('x', '00', 10) !== gas.pbkdf2Sha256Hex_('x', '01', 10),
  );

  check(
    'PBKDF2 の反復回数は1未満でも1回として扱う（0除算や無限ループを起こさない）',
    gas.pbkdf2Sha256Hex_('x', '00', 0) === gas.pbkdf2Sha256Hex_('x', '00', 1),
  );

  /* ---------------------------------------------------------------- */
  section('HMAC と定数時間比較');

  const hmacExpected = createHmac('sha256', 'secret-key').update('message').digest('hex');
  check(
    'hmacHex_ が Node の HMAC-SHA256 と一致する',
    gas.hmacHex_('message', 'secret-key') === hmacExpected,
  );

  check('timingSafeEqual_ は同じ文字列で true', gas.timingSafeEqual_('abc', 'abc'));
  check('timingSafeEqual_ は違う文字列で false', !gas.timingSafeEqual_('abc', 'abd'));
  check('timingSafeEqual_ は長さ違いで false', !gas.timingSafeEqual_('abc', 'abcd'));
  check('timingSafeEqual_ は空文字同士で true', gas.timingSafeEqual_('', ''));
  check('timingSafeEqual_ は null を空文字として扱う', gas.timingSafeEqual_(null, ''));
  check(
    'timingSafeEqual_ は先頭が一致しても最後まで見る',
    !gas.timingSafeEqual_('aaaaaaaaab', 'aaaaaaaaac'),
  );

  /* ---------------------------------------------------------------- */
  section('Stripe 署名の検証');

  const secret = 'whsec_test_secret_value';
  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const timestamp = 1_800_000_000;

  function signPayload(ts, body, key) {
    return createHmac('sha256', key).update(`${ts}.${body}`).digest('hex');
  }

  const validHeader = `t=${timestamp},v1=${signPayload(timestamp, payload, secret)}`;

  check(
    '正しい署名を受け入れる',
    gas.verifyStripeSignature_(payload, validHeader, secret, 300, timestamp).ok,
  );

  check(
    '署名が違えば拒否する',
    gas.verifyStripeSignature_(payload, `t=${timestamp},v1=${'0'.repeat(64)}`, secret, 300, timestamp)
      .reason === 'SIGNATURE_MISMATCH',
  );

  check(
    '本文が改ざんされていれば拒否する',
    !gas.verifyStripeSignature_(`${payload} `, validHeader, secret, 300, timestamp).ok,
  );

  check(
    'シークレットが違えば拒否する',
    !gas.verifyStripeSignature_(payload, validHeader, 'whsec_other', 300, timestamp).ok,
  );

  check(
    '古い署名（許容範囲外）を拒否する',
    gas.verifyStripeSignature_(payload, validHeader, secret, 300, timestamp + 301)
      .reason === 'TIMESTAMP_OUT_OF_RANGE',
  );

  check(
    '未来すぎる署名も拒否する',
    gas.verifyStripeSignature_(payload, validHeader, secret, 300, timestamp - 301)
      .reason === 'TIMESTAMP_OUT_OF_RANGE',
  );

  check(
    '許容範囲の境界（ちょうど300秒）は受け入れる',
    gas.verifyStripeSignature_(payload, validHeader, secret, 300, timestamp + 300).ok,
  );

  check(
    'ヘッダーが無ければ拒否する',
    gas.verifyStripeSignature_(payload, '', secret, 300, timestamp).reason === 'NO_HEADER',
  );

  check(
    'シークレット未設定なら拒否する',
    gas.verifyStripeSignature_(payload, validHeader, '', 300, timestamp).reason === 'NO_SECRET',
  );

  check(
    '形式が壊れたヘッダーを拒否する',
    gas.verifyStripeSignature_(payload, 'garbage', secret, 300, timestamp)
      .reason === 'MALFORMED_HEADER',
  );

  check(
    'v1 が無いヘッダーを拒否する',
    gas.verifyStripeSignature_(payload, `t=${timestamp}`, secret, 300, timestamp)
      .reason === 'MALFORMED_HEADER',
  );

  /* Stripe は鍵の入れ替え期間に v1 を複数付ける。どれか1つ合えばよい。 */
  const multiHeader = `t=${timestamp},v1=${'0'.repeat(64)},v1=${signPayload(timestamp, payload, secret)}`;
  check('v1 が複数あり片方が正しければ受け入れる', gas.verifyStripeSignature_(payload, multiHeader, secret, 300, timestamp).ok);

  /* ---------------------------------------------------------------- */
  section('メールアドレスの正規化とマスキング');

  check('前後の空白を除去する', gas.normalizeEmail_('  A@B.com  ') === 'a@b.com');
  check('小文字化する', gas.normalizeEmail_('Taro.YAMADA@Example.COM') === 'taro.yamada@example.com');
  check(
    'プラス以降は残す（別アドレスとして扱う）',
    gas.normalizeEmail_('a+tag@example.com') === 'a+tag@example.com',
  );

  check('正しい形式を受け入れる', gas.isValidEmail_('taro@example.com'));
  check('@が無ければ拒否する', !gas.isValidEmail_('taro.example.com'));
  check('ドメインにドットが無ければ拒否する', !gas.isValidEmail_('taro@example'));
  check('空文字を拒否する', !gas.isValidEmail_(''));
  check('空白入りを拒否する', !gas.isValidEmail_('a b@example.com'));
  check('カンマ入りを拒否する（ヘッダー注入の入口を塞ぐ）', !gas.isValidEmail_('a,b@example.com'));
  check('改行入りを拒否する', !gas.isValidEmail_('a\nb@example.com'));
  check('255文字以上を拒否する', !gas.isValidEmail_(`${'a'.repeat(250)}@example.com`));

  check('maskEmail_ はローカル部を伏せる', gas.maskEmail_('taro@example.com') === 't***@example.com');
  check('maskEmail_ は1文字のローカル部も伏せる', gas.maskEmail_('a@example.com') === '***@example.com');
  check('maskEmail_ は空文字で空文字', gas.maskEmail_('') === '');

  check(
    'summarizeUserAgent_ は端末を特定しうる詳細を落とす',
    gas.summarizeUserAgent_('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Safari/604.1')
      === 'ios/safari',
  );

  check('summarizeUserAgent_ は空でも壊れない', gas.summarizeUserAgent_('') === 'unknown');

  finish();
} catch (error) {
  fatal(error);
}

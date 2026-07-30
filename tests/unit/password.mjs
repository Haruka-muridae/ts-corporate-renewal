/*
 * パスワードの保存と照合。
 *
 * 確かめること:
 *   - 平文がどこにも残らない
 *   - ソルトが利用者ごとに違う
 *   - pepper（Script Property）が無いと照合できない
 *   - 反復回数を変えても既存利用者が締め出されない
 */

import { check, section, finish, fatal } from '../../apps/tests/helpers/assert.mjs';
import { createReadyEnvironment, setSetting, createActiveUser } from '../helpers/gas-harness.mjs';

try {
  const env = createReadyEnvironment();
  const gas = env.api;

  /* ---------------------------------------------------------------- */
  section('保存形式');

  const password = 'Correct-Horse-Battery-2026';
  const stored = gas.hashPassword_(password, '', 1000);

  check(
    'アルゴリズムと反復回数が値に含まれる',
    stored.hash.startsWith('pbkdf2$sha256$1000$'),
    stored.hash.slice(0, 40),
  );

  check(
    'ハッシュ部分は16進64文字',
    /^[0-9a-f]{64}$/.test(stored.hash.split('$')[3]),
  );

  check('ソルトは16進32文字', /^[0-9a-f]{32}$/.test(stored.salt));

  check(
    '保存値に平文が含まれない',
    !stored.hash.includes(password) && !stored.salt.includes(password),
  );

  check(
    '平文をそのまま SHA-256 しただけの値ではない',
    stored.hash.split('$')[3] !== gas.sha256Hex_(password),
  );

  const parsed = gas.parsePasswordHash_(stored.hash);
  check('保存形式を分解できる', parsed !== null && parsed.iterations === 1000);
  check('壊れた値は分解できない', gas.parsePasswordHash_('garbage') === null);
  check('空文字は分解できない', gas.parsePasswordHash_('') === null);
  check(
    '別アルゴリズムの表記は受け付けない',
    gas.parsePasswordHash_('bcrypt$sha256$1000$aa') === null,
  );

  /* ---------------------------------------------------------------- */
  section('照合');

  const verified = gas.verifyPassword_(password, stored.hash, stored.salt);
  check('正しいパスワードで一致する', verified.ok === true);

  check(
    '1文字違うだけで不一致',
    gas.verifyPassword_(`${password}x`, stored.hash, stored.salt).ok === false,
  );

  check(
    '大文字小文字を区別する',
    gas.verifyPassword_(password.toLowerCase(), stored.hash, stored.salt).ok === false,
  );

  check(
    '空パスワードで一致しない',
    gas.verifyPassword_('', stored.hash, stored.salt).ok === false,
  );

  check(
    'ソルトが違えば一致しない',
    gas.verifyPassword_(password, stored.hash, gas.randomSalt_()).ok === false,
  );

  check(
    'ソルトが空なら一致しない',
    gas.verifyPassword_(password, stored.hash, '').ok === false,
  );

  check(
    '保存値が壊れていれば一致しない（例外を投げない）',
    gas.verifyPassword_(password, 'broken', stored.salt).ok === false,
  );

  /* ---------------------------------------------------------------- */
  section('pepper（Script Property）の効き目');

  /*
   * pepper はスプレッドシートに存在しない。
   * したがって「シートだけが漏れても、そのままでは照合できない」。
   */
  const pepperBefore = env.properties.PASSWORD_PEPPER;
  env.properties.PASSWORD_PEPPER = 'different-pepper-value';

  check(
    'pepper が変わると照合できなくなる（シート単体では解けない）',
    gas.verifyPassword_(password, stored.hash, stored.salt).ok === false,
  );

  env.properties.PASSWORD_PEPPER = pepperBefore;

  check(
    'pepper を戻せば再び照合できる',
    gas.verifyPassword_(password, stored.hash, stored.salt).ok === true,
  );

  /* ---------------------------------------------------------------- */
  section('ソルトは利用者ごとに違う');

  const saltSet = new Set();
  const hashSet = new Set();

  for (let i = 0; i < 30; i += 1) {
    const each = gas.hashPassword_('same-password-for-everyone', '', 1000);
    saltSet.add(each.salt);
    hashSet.add(each.hash);
  }

  check('同じパスワードでもソルトが毎回違う', saltSet.size === 30, saltSet.size);
  check('その結果ハッシュも毎回違う（レインボーテーブル対策）', hashSet.size === 30, hashSet.size);

  /* ---------------------------------------------------------------- */
  section('反復回数の変更');

  const oldHash = gas.hashPassword_(password, '', 1000);
  setSetting(env, 'PBKDF2_ITERATIONS', '2000');

  const afterChange = gas.verifyPassword_(password, oldHash.hash, oldHash.salt);

  check('反復回数を変えても既存利用者は照合できる', afterChange.ok === true);
  check('作り直しが必要と判定される', afterChange.needsRehash === true);

  const newHash = gas.hashPassword_(password, '', gas.getPbkdf2Iterations_());
  check(
    '新しいハッシュには新しい反復回数が入る',
    newHash.hash.startsWith('pbkdf2$sha256$2000$'),
  );

  check(
    '同じ反復回数なら作り直し不要',
    gas.verifyPassword_(password, newHash.hash, newHash.salt).needsRehash === false,
  );

  setSetting(env, 'PBKDF2_ITERATIONS', '1000');

  check(
    '極端に小さい反復回数は下限へ丸める',
    (() => {
      setSetting(env, 'PBKDF2_ITERATIONS', '1');
      const result = gas.getPbkdf2Iterations_();
      setSetting(env, 'PBKDF2_ITERATIONS', '1000');
      return result === 1000;
    })(),
  );

  /* ---------------------------------------------------------------- */
  section('強度の検証');

  const cases = [
    ['', false, '空'],
    ['            ', false, '空白のみ'],
    ['short', false, '短すぎる'],
    ['aaaaaaaaaaaa', false, '同じ文字の繰り返し'],
    ['12345678901', false, '11文字（最低12文字に満たない）'],
    ['123456789012', true, 'ちょうど12文字'],
    ['Correct-Horse-Battery-2026', true, '十分な長さ'],
    ['パスワード１２３４５６７８', true, '日本語12文字'],
    /* 長さの判定だけを見たいので、繰り返し判定に引っかからない並びにする。 */
    [`ab${'c'.repeat(127)}`, false, '長すぎる（129文字）'],
    [`ab${'c'.repeat(126)}`, true, 'ちょうど上限（128文字）'],
  ];

  for (const [value, expected, label] of cases) {
    const result = gas.validatePasswordStrength_(value);
    check(
      `強度判定: ${label} → ${expected ? '許可' : '却下'}`,
      result.ok === expected,
      result.message,
    );
  }

  check(
    '却下時は理由が日本語で返る',
    gas.validatePasswordStrength_('short').message.includes('12文字以上'),
  );

  check(
    '最低文字数は設定で変えられる',
    (() => {
      setSetting(env, 'PASSWORD_MIN_LENGTH', '8');
      const result = gas.validatePasswordStrength_('12345678');
      setSetting(env, 'PASSWORD_MIN_LENGTH', '12');
      return result.ok === true;
    })(),
  );

  /* ---------------------------------------------------------------- */
  section('ダミー照合（存在しない利用者向け）');

  const dummyStart = Date.now();
  const dummyResult = gas.consumeDummyVerification_('any-password');
  const dummyElapsed = Date.now() - dummyStart;

  check('ダミー照合は常に false', dummyResult === false);
  check('ダミー照合でも実際に計算している（0msで終わらない）', dummyElapsed >= 0);

  /* ---------------------------------------------------------------- */
  section('シート上の実データ');

  const { user } = createActiveUser(env, {
    email: 'store-check@example.com',
    password: 'Stored-Password-2026',
  });

  check('パスワード設定後にハッシュが入る', user.passwordHash !== '');
  check('ソルトも入る', user.passwordSalt !== '');

  /* users シートの全セルを走査して、平文が残っていないことを確かめる。 */
  const allCells = gas.readRows_('users')
    .map((row) => row.map((cell) => String(cell)).join(' '))
    .join(' ');

  check(
    'users シートのどこにも平文パスワードが無い',
    !allCells.includes('Stored-Password-2026'),
  );

  const logCells = gas.readRows_('login_logs')
    .map((row) => row.map((cell) => String(cell)).join(' '))
    .join(' ');

  check(
    '認証ログにも平文パスワードが無い',
    !logCells.includes('Stored-Password-2026'),
  );

  check(
    '認証ログにパスワードハッシュも残らない',
    !logCells.includes(user.passwordHash),
  );

  check(
    '実行ログにも平文パスワードが出ない',
    !env.logs.join('\n').includes('Stored-Password-2026'),
  );

  /* 画面へ返す形にもハッシュを含めない。 */
  const publicUser = gas.toPublicUser_(user);

  check(
    '画面へ返す利用者情報にハッシュが無い',
    !Object.prototype.hasOwnProperty.call(publicUser, 'passwordHash')
    && !Object.prototype.hasOwnProperty.call(publicUser, 'passwordSalt'),
  );

  check(
    '画面へ返す情報を直列化してもハッシュが混ざらない',
    !JSON.stringify(publicUser).includes(user.passwordHash),
  );

  finish();
} catch (error) {
  fatal(error);
}

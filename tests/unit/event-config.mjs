/*
 * 環境変数の取り込みの検証。
 *
 * ==================================================================
 * なぜ要るか
 * ==================================================================
 *   Vercel へ環境変数を登録する経路によっては、値の先頭に BOM（U+FEFF）や
 *   前後の空白・改行が紛れ込むことがある。BOM が付いたまま HTTP ヘッダーへ
 *   入れると次の例外になり、原因が分かりにくい。
 *
 *     Cannot convert argument to a ByteString because the character at
 *     index 0 has a value of 65279 which is greater than 255.
 *
 *   実際にこれで管理画面へログインできなくなったため、読み取り時に落とす。
 * ==================================================================
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

import {
  baseUrl,
  calendarConfig,
  calendarWriteConfig,
  calendarWriteConfigOrNull,
  gmailConfig,
  stripeSecretKey,
  supabaseAuthConfig,
  supabaseConfig,
} from '../../lib/event/config.mjs';

/* 文字コードから組み立てる。ソースに直接書くと見分けが付かないため。 */
const BOM = String.fromCharCode(0xfeff);

const saved = { ...process.env };

function restore() {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) {
      delete process.env[key];
    }
  }

  Object.assign(process.env, saved);
}

try {
  /* ---------------------------------------------------------------- */
  section('BOMの除去');

  process.env.SUPABASE_URL = `${BOM}https://example.supabase.co`;
  process.env.SUPABASE_ANON_KEY = `${BOM}anon-key`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = `${BOM}service-key`;

  const auth = supabaseAuthConfig();
  const service = supabaseConfig();

  check('URLの先頭のBOMを落とす',
    auth.url === 'https://example.supabase.co', JSON.stringify(auth.url));
  check('anonキーのBOMを落とす', auth.anonKey === 'anon-key', JSON.stringify(auth.anonKey));
  check('service roleキーのBOMを落とす',
    service.serviceRoleKey === 'service-key', JSON.stringify(service.serviceRoleKey));

  check('BOMが複数付いていても落とす',
    (() => {
      process.env.SUPABASE_ANON_KEY = `${BOM}${BOM}anon-key`;
      return supabaseAuthConfig().anonKey === 'anon-key';
    })());

  /*
   * 落とせていないと、この時点で例外になる。
   * 実際の失敗はここで起きていた。
   */
  let headerError = null;

  try {
    // eslint-disable-next-line no-new
    new Headers({ apikey: supabaseAuthConfig().anonKey });
  } catch (error) {
    headerError = error;
  }

  check('HTTPヘッダーの値として使える', headerError === null, headerError?.message);

  /* ---------------------------------------------------------------- */
  section('前後の空白と改行');

  process.env.SUPABASE_ANON_KEY = '  anon-key\n';
  check('前後の空白と改行を落とす', supabaseAuthConfig().anonKey === 'anon-key',
    JSON.stringify(supabaseAuthConfig().anonKey));

  process.env.SUPABASE_ANON_KEY = '\r\nanon-key\r\n';
  check('CRLFも落とす', supabaseAuthConfig().anonKey === 'anon-key',
    JSON.stringify(supabaseAuthConfig().anonKey));

  /* ---------------------------------------------------------------- */
  section('空とみなす値');

  const emptyValues = [BOM, '   ', '\n', ''];

  emptyValues.forEach((value) => {
    process.env.SUPABASE_ANON_KEY = value;

    let threw = false;

    try {
      supabaseAuthConfig();
    } catch (error) {
      threw = error instanceof Error && error.message.includes('SUPABASE_ANON_KEY');
    }

    check(`${JSON.stringify(value)} は未設定として扱う`, threw);
  });

  /* 例外に値そのものを載せない。 */
  process.env.SUPABASE_ANON_KEY = '';
  let missingError = null;

  try {
    supabaseAuthConfig();
  } catch (error) {
    missingError = error;
  }

  check('例外には変数名だけを出す',
    missingError.message === '環境変数 SUPABASE_ANON_KEY が設定されていません',
    missingError.message);

  /* ---------------------------------------------------------------- */
  section('ほかの設定でも同じ扱いにする');

  process.env.SUPABASE_ANON_KEY = 'anon-key';
  process.env.STRIPE_SECRET_KEY = `${BOM}sk_test_dummy `;
  process.env.NEXT_PUBLIC_BASE_URL = `${BOM}https://example.com/event/ `;
  process.env.GOOGLE_CLIENT_ID = `${BOM}client-id`;
  process.env.GOOGLE_CLIENT_SECRET = `${BOM}client-secret`;
  process.env.GMAIL_REFRESH_TOKEN = `${BOM}refresh-token`;
  process.env.MAIL_FROM = `${BOM}TS <a@example.com>`;

  check('Stripeのキー', stripeSecretKey() === 'sk_test_dummy', stripeSecretKey());

  /* 末尾のスラッシュも落として、URLの組み立てで二重にならないようにする。 */
  check('公開URLの土台', baseUrl() === 'https://example.com/event', baseUrl());

  const gmail = gmailConfig();

  check('Gmailのクライアントの値',
    gmail.credentials.clientId === 'client-id'
      && gmail.credentials.clientSecret === 'client-secret'
      && gmail.credentials.refreshToken === 'refresh-token');
  check('送信元', gmail.from === 'TS <a@example.com>', gmail.from);

  /* ---------------------------------------------------------------- */
  section('カレンダーの設定');

  process.env.GOOGLE_CALENDAR_ID = `${BOM}primary `;
  process.env.GOOGLE_CALENDAR_REFRESH_TOKEN = `${BOM}calendar-refresh-token\n`;

  const calendar = calendarConfig();

  check('カレンダーID', calendar.calendarId === 'primary', calendar.calendarId);
  check('OAuthクライアントはメール送信と共用する',
    calendar.credentials.clientId === 'client-id'
      && calendar.credentials.clientSecret === 'client-secret');
  check('リフレッシュトークンはメール送信と別に持つ',
    calendar.credentials.refreshToken === 'calendar-refresh-token'
      && calendar.credentials.refreshToken !== gmail.credentials.refreshToken);

  /* ---------------------------------------------------------------- */
  section('カレンダー書き込みの設定');

  process.env.GOOGLE_CALENDAR_WRITE_REFRESH_TOKEN = `${BOM}calendar-write-token\r\n`;

  const calendarWrite = calendarWriteConfig();

  check('書き込み用でもBOMと改行を落とす',
    calendarWrite.credentials.refreshToken === 'calendar-write-token',
    JSON.stringify(calendarWrite.credentials.refreshToken));
  check('カレンダーIDとOAuthクライアントは読み取り用と共用する',
    calendarWrite.calendarId === 'primary'
      && calendarWrite.credentials.clientId === calendar.credentials.clientId
      && calendarWrite.credentials.clientSecret === calendar.credentials.clientSecret);
  check('リフレッシュトークンは読み取り用と別に持つ（readonly に書き込み権限を与えない）',
    calendarWrite.credentials.refreshToken !== calendar.credentials.refreshToken);

  check('設定済みなら OrNull 版も同じ値を返す',
    calendarWriteConfigOrNull()?.credentials.refreshToken === 'calendar-write-token');

  delete process.env.GOOGLE_CALENDAR_WRITE_REFRESH_TOKEN;

  /* 書き戻しは補助機能。未設定は「無効」であって「異常」ではない。 */
  check('未設定なら OrNull 版は null を返す（決済やメールを止めない）',
    calendarWriteConfigOrNull() === null);
  let calendarWriteError = null;

  try {
    calendarWriteConfig();
  } catch (error) {
    calendarWriteError = error;
  }

  check('書き込み用が未設定なら変数名だけを出して止める',
    calendarWriteError?.message
      === '環境変数 GOOGLE_CALENDAR_WRITE_REFRESH_TOKEN が設定されていません',
    calendarWriteError?.message);

  /* 書き込み用が無くても、読み取り（開催日の同期）は従来どおり動く。 */
  check('書き込み用が無くても読み取り用は使える',
    calendarConfig().credentials.refreshToken === 'calendar-refresh-token');

  delete process.env.GOOGLE_CALENDAR_REFRESH_TOKEN;
  let calendarError = null;

  try {
    calendarConfig();
  } catch (error) {
    calendarError = error;
  }

  check('未設定なら変数名だけを出して止める',
    calendarError?.message === '環境変数 GOOGLE_CALENDAR_REFRESH_TOKEN が設定されていません',
    calendarError?.message);

  restore();
  finish();
} catch (error) {
  restore();
  fatal(error);
}

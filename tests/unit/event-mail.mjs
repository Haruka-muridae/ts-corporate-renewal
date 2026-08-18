/*
 * 参加確定メールの検証（実装仕様書 6.1）。
 *
 * ==================================================================
 * 特に確かめること
 * ==================================================================
 *   - 仕様書6.1の項目がすべて本文に載ること
 *   - 出禁の申告があるとき、割引の内訳と理由を書かないこと
 *   - ヘッダーに改行を差し込めないこと（メールヘッダーインジェクション）
 *   - 日本語の件名が RFC 2047 で符号化され、1語75文字を超えないこと
 *   - 資格情報や本文が例外メッセージへ漏れないこと
 * ==================================================================
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

import {
  buildRawMessage,
  encodeHeaderWord,
  toBase64Url,
  getAccessToken,
  sendMail,
} from '../../lib/event/mail/gmail.mjs';

import {
  buildConfirmationMail,
  formatEventDateLabel,
  formatEventDateTime,
  formatYen,
  CONTACT_EMAIL,
} from '../../lib/event/mail/confirmation.mjs';

import { calculatePrice } from '../../lib/event/pricing.mjs';

const EVENT = {
  name: 'TSAMビジネス&フレンド交流会',
  startAt: '2026-08-30T14:30:00+09:00',
  endAt: '2026-08-30T16:00:00+09:00',
  venue: 'CAFE&BAR ZERA\n東京都渋谷区道玄坂1丁目17-4 道玄坂ビル4F',
};

const APPLICATION = {
  name: '山田 太郎',
  receiptNumber: 'TSAM-0001',
  industry: 'it',
  occupation: 'engineer',
  position: 'manager',
  ageGroup: '24+',
};

try {
  /* ---------------------------------------------------------------- */
  section('日時と金額の表示');

  check('開催日時が日本時間で「年月日（曜）時:分〜時:分」になる',
    formatEventDateTime(new Date(EVENT.startAt), new Date(EVENT.endAt))
      === '2026年8月30日（日）14:30〜16:00',
    formatEventDateTime(new Date(EVENT.startAt), new Date(EVENT.endAt)));

  check('サーバーの時間帯に関わらずJSTで表示する（UTC表記の入力）',
    formatEventDateTime(new Date('2026-08-30T05:30:00Z'), new Date('2026-08-30T07:00:00Z'))
      === '2026年8月30日（日）14:30〜16:00');

  check('終了時刻がなければ開始のみ',
    formatEventDateTime(new Date(EVENT.startAt), null) === '2026年8月30日（日）14:30');

  check('金額に桁区切りが入る', formatYen(11000) === '11,000円', formatYen(11000));
  check('4桁でも桁区切りが入る', formatYen(3300) === '3,300円', formatYen(3300));

  check('formatEventDateLabel は「年月日」だけ（時刻を含まない）',
    formatEventDateLabel(EVENT.startAt) === '2026年8月30日',
    formatEventDateLabel(EVENT.startAt));

  check('formatEventDateLabel もサーバーの時間帯に関わらずJST（UTC表記の入力）',
    formatEventDateLabel('2026-08-30T05:30:00Z') === '2026年8月30日');

  /* ---------------------------------------------------------------- */
  section('本文に載る項目（仕様書6.1）');

  const payment = calculatePrice(APPLICATION);
  const mail = buildConfirmationMail({ event: EVENT, application: APPLICATION, payment });

  check('交流会名', mail.text.includes('TSAMビジネス&フレンド交流会'));
  check('開催日時', mail.text.includes('2026年8月30日（日）14:30〜16:00'));
  check('開催場所', mail.text.includes('CAFE&BAR ZERA') && mail.text.includes('道玄坂ビル4F'));
  check('受付番号', mail.text.includes('TSAM-0001'));
  check('支払金額', mail.text.includes('4,400円（税込）'), mail.text.match(/お支払金額.*/)?.[0]);
  check('適用された割引（業界）', mail.text.includes('業界割引（IT）'));
  check('適用された割引（職種）', mail.text.includes('職種割引（エンジニア）'));
  check('適用された割引（立場）', mail.text.includes('立場割引（管理職）'));
  check('名札を着用いただく旨', mail.text.includes('名札を着用いただきます'));
  check('名札に年齢を記載しない旨', mail.text.includes('年齢は記載いたしません'));
  check('キャンセルポリシーの再掲（返金不可）',
    mail.text.includes('キャンセル・返金は、一切お受けしておりません'));
  check('譲渡が可能である旨', mail.text.includes('第三者へお譲りいただくことは可能です'));
  check('問い合わせ先', mail.text.includes(CONTACT_EMAIL));
  check('領収書はStripeから届く旨', mail.text.includes('Stripeより別途'));

  check('件名に交流会名と受付番号が入る',
    mail.subject.includes('TSAMビジネス&フレンド交流会') && mail.subject.includes('TSAM-0001'),
    mail.subject);

  check('件名に開催日が入る（開催日が複数あるため、どの回への確認かを示す）',
    mail.subject.includes('2026年8月30日'), mail.subject);

  check('宛名が入る', mail.text.startsWith('山田 太郎 様'));

  check('会場の2行目が字下げされて続く（行頭に住所が来ない）',
    !mail.text.split('\n').some((line) => line.startsWith('東京都渋谷区')));

  /* ---------------------------------------------------------------- */
  section('割引がない場合');

  const noDiscountApplication = {
    ...APPLICATION, industry: 'other', occupation: 'other', position: 'other',
  };
  const noDiscount = buildConfirmationMail({
    event: EVENT,
    application: noDiscountApplication,
    payment: calculatePrice(noDiscountApplication),
  });

  check('割引の見出しを出さない', !noDiscount.text.includes('適用された割引'));
  check('通常価格が支払金額になる', noDiscount.text.includes('11,000円（税込）'));

  /* ---------------------------------------------------------------- */
  section('下限に張り付いた場合');

  const minApplication = { ...APPLICATION, position: 'executive', ageGroup: '18-23' };
  const minMail = buildConfirmationMail({
    event: EVENT,
    application: minApplication,
    payment: calculatePrice(minApplication),
  });

  check('支払金額は3,300円', minMail.text.includes('3,300円（税込）'));
  check('最低販売価格である旨の注記が入る',
    minMail.text.includes('最低販売価格を下回るため'));

  /* ---------------------------------------------------------------- */
  section('出禁の申告があった場合');

  const bannedApplication = { ...APPLICATION, isBannedDeclared: true };
  const bannedMail = buildConfirmationMail({
    event: EVENT,
    application: bannedApplication,
    payment: calculatePrice(bannedApplication),
  });

  check('支払金額は55,000円', bannedMail.text.includes('55,000円（税込）'));
  check('割引の内訳を書かない', !bannedMail.text.includes('適用された割引'));
  check('個別の割引名も出さない', !bannedMail.text.includes('業界割引'));
  check('理由を書かない', !bannedMail.text.includes('出入り禁止') && !bannedMail.text.includes('出禁'));
  check('受付番号などの他の項目は載る', bannedMail.text.includes('TSAM-0001'));

  /* ---------------------------------------------------------------- */
  section('受付番号がない場合');

  let noReceiptThrew = false;

  try {
    buildConfirmationMail({
      event: EVENT,
      application: { ...APPLICATION, receiptNumber: '' },
      payment,
    });
  } catch (error) {
    noReceiptThrew = error instanceof TypeError;
  }

  check('受付番号が未発行なら組み立てない', noReceiptThrew);

  /* ---------------------------------------------------------------- */
  section('件名の符号化');

  check('ASCIIのみならそのまま', encodeHeaderWord('Hello') === 'Hello');
  check('日本語は encoded-word になる',
    encodeHeaderWord('こんにちは').startsWith('=?UTF-8?B?'),
    encodeHeaderWord('こんにちは'));

  const longSubject = '【TSAMビジネス&フレンド交流会】お申し込みを承りました（受付番号 TSAM-0001）';
  const encoded = encodeHeaderWord(longSubject);

  check('長い件名は複数の encoded-word に分かれる', encoded.split(' ').length > 1,
    encoded.split(' ').length);

  check('各 encoded-word が75文字以内',
    encoded.split(' ').every((word) => word.length <= 75),
    Math.max(...encoded.split(' ').map((word) => word.length)));

  /* 分割しても復元できること。受信側は encoded-word を連結して解く。 */
  const decoded = encoded
    .split(' ')
    .map((word) => Buffer.from(word.slice('=?UTF-8?B?'.length, -2), 'base64').toString('utf8'))
    .join('');

  check('分割しても元の文字列に戻る', decoded === longSubject, decoded);

  /* ---------------------------------------------------------------- */
  section('メッセージの組み立て');

  const raw = buildRawMessage({
    from: 'architect@potenitas.com',
    to: 'taro@example.com',
    subject: mail.subject,
    text: mail.text,
  });

  check('From が入る', raw.includes('From: architect@potenitas.com'));
  check('To が入る', raw.includes('To: taro@example.com'));
  check('文字コードは UTF-8', raw.includes('Content-Type: text/plain; charset="UTF-8"'));
  check('本文は base64', raw.includes('Content-Transfer-Encoding: base64'));
  check('ヘッダーと本文が空行で区切られる', raw.includes('\r\n\r\n'));

  const [headerBlock, bodyBlock] = raw.split('\r\n\r\n');
  const decodedBody = Buffer.from(bodyBlock.replace(/\r\n/g, ''), 'base64').toString('utf8');

  check('本文が復元できる', decodedBody === mail.text);
  check('base64の各行が76文字以内',
    bodyBlock.split('\r\n').every((line) => line.length <= 76));
  check('件名は生の日本語のまま置かない', !headerBlock.includes('交流会】お申し込み'));

  check('Reply-To は指定したときだけ入る',
    !raw.includes('Reply-To:')
      && buildRawMessage({
        from: 'architect@potenitas.com',
        to: 'taro@example.com',
        subject: 'x',
        text: 'y',
        replyTo: 'architect@potenitas.com',
      }).includes('Reply-To: architect@potenitas.com'));

  /* ---------------------------------------------------------------- */
  section('ヘッダーインジェクション');

  const injections = [
    { name: '宛先に改行とヘッダー', field: 'to', value: 'a@example.com\r\nBcc: attacker@example.com' },
    { name: '宛先に改行（LFのみ）', field: 'to', value: 'a@example.com\nBcc: attacker@example.com' },
    { name: '送信元に改行', field: 'from', value: 'a@example.com\r\nFrom: spoof@example.com' },
    { name: '件名に改行', field: 'subject', value: '件名\r\nBcc: attacker@example.com' },
    { name: '返信先に改行', field: 'replyTo', value: 'a@example.com\r\nBcc: attacker@example.com' },
  ];

  injections.forEach(({ name, field, value }) => {
    const base = {
      from: 'architect@potenitas.com',
      to: 'taro@example.com',
      subject: '件名',
      text: '本文',
    };

    let threw = false;

    try {
      buildRawMessage({ ...base, [field]: value });
    } catch (error) {
      threw = error instanceof TypeError;
    }

    check(`${name}を拒否する`, threw);
  });

  const emptyCases = [
    { name: '宛先が空', input: { from: 'a@example.com', to: '', subject: 's', text: 't' } },
    { name: '件名が空', input: { from: 'a@example.com', to: 'b@example.com', subject: '', text: 't' } },
    { name: '本文が空', input: { from: 'a@example.com', to: 'b@example.com', subject: 's', text: '' } },
  ];

  emptyCases.forEach(({ name, input }) => {
    let threw = false;

    try {
      buildRawMessage(input);
    } catch (error) {
      threw = error instanceof TypeError;
    }

    check(`${name}なら組み立てない`, threw);
  });

  /* ---------------------------------------------------------------- */
  section('base64url');

  check('+ と / を - と _ に置き換える',
    toBase64Url('ûÿ') === '-_8' || !/[+/=]/.test(toBase64Url('ûÿ')),
    toBase64Url('ûÿ'));
  check('末尾の = を落とす', !toBase64Url('abcde').endsWith('='), toBase64Url('abcde'));

  /* ---------------------------------------------------------------- */
  section('送信の呼び出し');

  const calls = [];

  const fakeFetch = async (url, options) => {
    calls.push({ url, options });

    if (url.includes('oauth2.googleapis.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'ya29.test-token', expires_in: 3599 }),
      };
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'msg-1', threadId: 'thread-1' }),
    };
  };

  const sent = await sendMail({
    from: 'architect@potenitas.com',
    to: 'taro@example.com',
    subject: mail.subject,
    text: mail.text,
    credentials: {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
    },
    fetchImpl: fakeFetch,
  });

  check('トークン取得と送信の2回呼ぶ', calls.length === 2, calls.length);
  check('1回目はトークンの発行', calls[0].url.includes('oauth2.googleapis.com'));
  check('grant_type は refresh_token', calls[0].options.body.includes('grant_type=refresh_token'));
  check('2回目は Gmail API の送信', calls[1].url.includes('gmail/v1/users/me/messages/send'));
  check('取得したトークンを Bearer で渡す',
    calls[1].options.headers.Authorization === 'Bearer ya29.test-token');
  check('raw が base64url（記号を含まない）',
    !/[+/=]/.test(JSON.parse(calls[1].options.body).raw));
  check('送信結果のIDを返す', sent.id === 'msg-1' && sent.threadId === 'thread-1');

  /*
   * トークン取得は signal を受け取れるようにしたが（カレンダー同期が
   * 取得全体に制限時間を掛けるため）、メール送信は従来どおり制限時間を
   * 持たない。途中で切ると「送ったのか分からない」状態になるため。
   */
  check('メール送信では中断の指定を付けない',
    !('signal' in calls[0].options) && !('signal' in calls[1].options),
    JSON.stringify(Object.keys(calls[0].options)));

  const signalCalls = [];
  const signalFetch = async (url, options = {}) => {
    signalCalls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ access_token: 'ya29.test-token' }) };
  };

  const tokenSignal = AbortSignal.timeout(60_000);

  await getAccessToken({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refreshToken: 'refresh-token',
    fetchImpl: signalFetch,
    signal: tokenSignal,
  });

  check('渡されたときだけ中断の指定を付ける',
    signalCalls[0].options.signal === tokenSignal);

  /* ---------------------------------------------------------------- */
  section('失敗時に秘密を漏らさない');

  const failingFetch = async (url) => {
    if (url.includes('oauth2.googleapis.com')) {
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: 'invalid_grant', client_secret: 'client-secret' }),
      };
    }

    return { ok: true, status: 200, json: async () => ({}) };
  };

  let tokenError = null;

  try {
    await getAccessToken({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      fetchImpl: failingFetch,
    });
  } catch (error) {
    tokenError = error;
  }

  check('トークン取得の失敗を例外にする', tokenError instanceof Error);
  check('例外に client_secret を含めない',
    tokenError !== null && !tokenError.message.includes('client-secret'), tokenError?.message);
  check('例外に refresh_token を含めない',
    tokenError !== null && !tokenError.message.includes('refresh-token'));
  check('状態コードは伝える', tokenError !== null && tokenError.message.includes('400'));

  let missingCredentialError = null;

  try {
    await getAccessToken({ clientId: '', clientSecret: '', refreshToken: '' });
  } catch (error) {
    missingCredentialError = error;
  }

  check('資格情報が未設定なら通信前に止める', missingCredentialError instanceof TypeError);

  const sendFailFetch = async (url) => {
    if (url.includes('oauth2.googleapis.com')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'ya29.test-token' }) };
    }

    return { ok: false, status: 403, json: async () => ({}) };
  };

  let sendError = null;

  try {
    await sendMail({
      from: 'architect@potenitas.com',
      to: 'taro@example.com',
      subject: '件名',
      text: '本文',
      credentials: { clientId: 'c', clientSecret: 's', refreshToken: 'r' },
      fetchImpl: sendFailFetch,
    });
  } catch (error) {
    sendError = error;
  }

  check('送信の失敗を例外にする', sendError instanceof Error);
  check('例外にアクセストークンを含めない',
    sendError !== null && !sendError.message.includes('ya29.test-token'), sendError?.message);

  finish();
} catch (error) {
  fatal(error);
}

/*
 * 名刺メール配信API（lib/card-mail/）の検証。
 *
 * ==================================================================
 * 特に確かめること
 * ==================================================================
 *   - 宛先の検証と重複排除（OCR由来の壊れたアドレスを送信前に止める）
 *   - 不正な宛先が1件でもあれば全体を止め、どれが不正かを返すこと
 *   - BCCヘッダーに改行を差し込めないこと（メールヘッダーインジェクション）
 *   - BCCが長くてもヘッダー1行が RFC 5322 の998文字を超えないこと
 *   - 分割送信の境界（90件/通）と、途中失敗時に送信済み件数が分かること
 *   - APIトークンの照合（一致・不一致・未設定は全拒否）
 *   - 資格情報が例外メッセージへ漏れないこと
 * ==================================================================
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

import {
  MAX_RECIPIENTS_PER_REQUEST,
  BCC_BATCH_SIZE,
  isValidEmail,
  normalizeRecipients,
  parseSendRequest,
  chunkRecipients,
  extractBearerToken,
  tokenEquals,
  sendBulkMail,
} from '../../lib/card-mail/bulk.mjs';

import { buildBccHeader, buildRawMessage } from '../../lib/card-mail/gmail.mjs';

import { apiToken, gmailConfig } from '../../lib/card-mail/config.mjs';

const CREDENTIALS = { clientId: 'c', clientSecret: 's', refreshToken: 'r' };

/* Gmail API の偽物。トークン発行と送信を受け、送信内容を記録する。 */
function buildFetchStub({ failAtSendCall = Infinity } = {}) {
  const sentPayloads = [];
  let sendCalls = 0;

  const fetchImpl = async (url, options) => {
    if (String(url).includes('oauth2.googleapis.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'ya29.test-token' }),
      };
    }

    sendCalls += 1;

    if (sendCalls >= failAtSendCall) {
      return { ok: false, status: 429, json: async () => ({}) };
    }

    const raw = JSON.parse(options.body).raw;
    /* base64url を base64 に戻して復号する。 */
    const base64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    sentPayloads.push(Buffer.from(base64, 'base64').toString('utf8'));

    return {
      ok: true,
      status: 200,
      json: async () => ({ id: `msg-${sendCalls}`, threadId: `thread-${sendCalls}` }),
    };
  };

  return { fetchImpl, sentPayloads };
}

try {
  /* ---------------------------------------------------------------- */
  section('メールアドレスの検証');

  check('普通のアドレスを通す', isValidEmail('taro@example.com'));
  check('サブドメインを通す', isValidEmail('taro.yamada+tag@mail.example.co.jp'));
  check('@なしを弾く', !isValidEmail('example.com'));
  check('TLDなしを弾く', !isValidEmail('taro@localhost'));
  check('空白入りを弾く', !isValidEmail('taro @example.com'));
  check('改行入りを弾く（ヘッダーインジェクション）', !isValidEmail('taro@example.com\r\nBcc:x@y.jp'));
  check('カンマ入りを弾く（宛先の水増し）', !isValidEmail('a@b.jp,c@d.jp'));
  check('文字列以外を弾く', !isValidEmail(null) && !isValidEmail(42));
  check('255文字以上を弾く', !isValidEmail(`${'a'.repeat(250)}@ex.jp`));

  /* ---------------------------------------------------------------- */
  section('宛先の整形と重複排除');

  {
    const result = normalizeRecipients([
      ' Taro@example.com ',
      'taro@EXAMPLE.com',
      'hanako@example.jp',
      'こわれた宛先',
      '',
    ]);

    check('前後の空白を落とす', result.recipients.includes('Taro@example.com'));
    check('大文字小文字違いは1件にまとめる', result.recipients.length === 2,
      JSON.stringify(result.recipients));
    check('最初に現れた表記を送信に使う', result.recipients[0] === 'Taro@example.com');
    check('重複の件数を数える', result.duplicateCount === 1);
    check('不正な宛先を原形のまま集める',
      result.invalid.length === 2 && result.invalid.includes('こわれた宛先'),
      JSON.stringify(result.invalid));
  }

  /* ---------------------------------------------------------------- */
  section('リクエストの検証');

  const VALID_BODY = {
    subject: 'ご挨拶',
    text: '本文です。',
    recipients: ['taro@example.com', 'hanako@example.jp'],
  };

  {
    const parsed = parseSendRequest(VALID_BODY);
    check('正しい本文を通す', parsed.recipients.length === 2 && parsed.subject === 'ご挨拶');
    check('dryRun の既定は false', parsed.dryRun === false);
    check('replyTo の既定は null', parsed.replyTo === null);
  }

  check('dryRun: true を読み取る',
    parseSendRequest({ ...VALID_BODY, dryRun: true }).dryRun === true);

  /* 「truthyなら有効」にしない。文字列 "false" が有効扱いになる事故を防ぐ。 */
  check('dryRun が真偽値でなければ無効扱い',
    parseSendRequest({ ...VALID_BODY, dryRun: 'true' }).dryRun === false);

  function rejects(body, fragment) {
    try {
      parseSendRequest(body);
      return false;
    } catch (error) {
      return error instanceof TypeError && error.message.includes(fragment);
    }
  }

  check('オブジェクト以外を弾く', rejects(null, 'JSON') && rejects([], 'JSON'));
  check('件名なしを弾く', rejects({ ...VALID_BODY, subject: ' ' }, '件名'));
  check('本文なしを弾く', rejects({ ...VALID_BODY, text: '' }, '本文'));
  check('宛先なしを弾く', rejects({ ...VALID_BODY, recipients: [] }, '宛先'));
  check('宛先の上限超過を弾く',
    rejects(
      { ...VALID_BODY, recipients: Array.from({ length: MAX_RECIPIENTS_PER_REQUEST + 1 }, (_, i) => `u${i}@ex.jp`) },
      '多すぎます',
    ));
  check('不正な replyTo を弾く', rejects({ ...VALID_BODY, replyTo: 'こわれた' }, '返信先'));

  {
    let caught = null;

    try {
      parseSendRequest({ ...VALID_BODY, recipients: ['taro@example.com', 'こわれた宛先'] });
    } catch (error) {
      caught = error;
    }

    check('不正な宛先が混ざると全体を止める', caught instanceof TypeError);
    check('どの宛先が不正かを例外に載せる',
      caught !== null && Array.isArray(caught.invalidRecipients)
        && caught.invalidRecipients.includes('こわれた宛先'),
      JSON.stringify(caught?.invalidRecipients));
  }

  /* ---------------------------------------------------------------- */
  section('分割の境界');

  const many = (count) => Array.from({ length: count }, (_, i) => `user${i}@example.com`);

  check('90件は1通', chunkRecipients(many(BCC_BATCH_SIZE)).length === 1);
  check('91件は2通', chunkRecipients(many(BCC_BATCH_SIZE + 1)).length === 2);
  check('分割しても全宛先が残る',
    chunkRecipients(many(200)).flat().length === 200);

  /* ---------------------------------------------------------------- */
  section('APIトークンの照合');

  check('Bearer トークンを取り出す', extractBearerToken('Bearer abc123') === 'abc123');
  check('Bearer 以外の形式は null', extractBearerToken('Basic abc123') === null);
  check('ヘッダーなしは null', extractBearerToken(null) === null);

  check('一致するトークンを通す', tokenEquals('secret-token', 'secret-token'));
  check('不一致を弾く', !tokenEquals('secret-tokem', 'secret-token'));
  check('長さ違いを弾く', !tokenEquals('secret', 'secret-token'));
  check('期待値が空なら常に拒否（未設定＝全拒否）', !tokenEquals('', '') && !tokenEquals('x', ''));

  /* ---------------------------------------------------------------- */
  section('BCCヘッダーの組み立て');

  check('Bcc ヘッダーを組み立てる',
    buildBccHeader(['a@ex.jp', 'b@ex.jp']).startsWith('Bcc: a@ex.jp'));

  {
    let injected = null;

    try {
      buildBccHeader(['a@ex.jp', 'b@ex.jp\r\nSubject: 乗っ取り']);
    } catch (error) {
      injected = error;
    }

    check('BCC宛先への改行差し込みを止める', injected instanceof TypeError);
  }

  {
    const raw = buildRawMessage({
      from: 'architect@potenitas.com',
      to: 'architect@potenitas.com',
      subject: 'ご挨拶',
      text: '本文です。',
      bcc: many(BCC_BATCH_SIZE),
    });

    check('BCC付きメッセージに Bcc ヘッダーが入る', raw.includes('Bcc: user0@example.com'));
    check('全宛先がヘッダーに入る', raw.includes('user89@example.com'));
    check('どの行も998文字を超えない（RFC 5322）',
      raw.split('\r\n').every((line) => line.length <= 998),
      `最長 ${Math.max(...raw.split('\r\n').map((l) => l.length))} 文字`);
  }

  check('BCCなしなら Bcc ヘッダーを付けない',
    !buildRawMessage({
      from: 'a@ex.jp', to: 'b@ex.jp', subject: 's', text: 't',
    }).includes('Bcc:'));

  /* ---------------------------------------------------------------- */
  section('一斉送信の実行');

  {
    const { fetchImpl, sentPayloads } = buildFetchStub();

    const result = await sendBulkMail({
      subject: 'ご挨拶',
      text: '本文です。',
      recipients: many(200),
      from: 'architect@potenitas.com',
      credentials: CREDENTIALS,
      fetchImpl,
    });

    check('200件は3通に分かれる', result.batches.length === 3,
      JSON.stringify(result.batches));
    check('送信済み件数が全宛先数に一致する', result.sentCount === 200);
    check('通ごとの宛先数が 90/90/20 になる',
      result.batches.map((b) => b.recipientCount).join(',') === '90,90,20');
    check('メッセージIDが記録される', result.batches[0].messageId === 'msg-1');
    check('To が送信元自身になる（宛先を晒さない）',
      sentPayloads.every((p) => p.includes('To: architect@potenitas.com')));
    check('各通に宛先がBCCで入る',
      sentPayloads[0].includes('user0@example.com')
        && sentPayloads[2].includes('user199@example.com'));
  }

  {
    const { fetchImpl } = buildFetchStub({ failAtSendCall: 2 });
    let failure = null;

    try {
      await sendBulkMail({
        subject: 'ご挨拶',
        text: '本文です。',
        recipients: many(200),
        from: 'architect@potenitas.com',
        credentials: CREDENTIALS,
        fetchImpl,
      });
    } catch (error) {
      failure = error;
    }

    check('途中失敗を例外にする', failure instanceof Error);
    check('送信済み件数が例外に載る（1通目の90件）', failure?.sentCount === 90,
      String(failure?.sentCount));
    check('例外メッセージで進捗が分かる', failure?.message.includes('90 件'));
    check('例外に資格情報とトークンを含めない',
      failure !== null
        && !failure.message.includes('ya29.test-token')
        && !failure.message.includes(CREDENTIALS.clientSecret));
  }

  /* ---------------------------------------------------------------- */
  section('環境変数の読み取り');

  {
    /* このスイートは別プロセスで走るため、process.env を直接書き換えてよい。 */
    process.env.CARD_MAIL_API_TOKEN = '\ufeff token-with-bom \n';
    check('BOMと前後空白を落とす', apiToken() === 'token-with-bom');

    delete process.env.CARD_MAIL_API_TOKEN;

    let missing = null;

    try {
      apiToken();
    } catch (error) {
      missing = error;
    }

    check('未設定なら変数名入りの例外にする',
      missing instanceof Error && missing.message.includes('CARD_MAIL_API_TOKEN'));

    process.env.GOOGLE_CLIENT_ID = 'cid';
    process.env.GOOGLE_CLIENT_SECRET = 'csec';
    process.env.GMAIL_REFRESH_TOKEN = 'rtok';
    process.env.MAIL_FROM = 'architect@potenitas.com';

    const config = gmailConfig();
    check('Gmail の設定を組み立てる',
      config.from === 'architect@potenitas.com' && config.credentials.clientId === 'cid');
  }

  finish();
} catch (error) {
  fatal(error);
}

/*
 * 名刺メール配信アプリ（public/production-app/card-mail/）の検証。
 *
 * ==================================================================
 * 特に確かめること
 * ==================================================================
 *   - 宛先の検証と重複排除（OCR由来の壊れたアドレスを送信対象にしない）
 *   - 100件ずつの分割と、途中失敗時に「どこまで送れたか」が分かること
 *   - BCCヘッダーに改行を差し込めないこと（メールヘッダーインジェクション）
 *   - BCCが100件でもヘッダー1行が RFC 5322 の998文字を超えないこと
 *   - To・From を付けないこと（宛先を晒さない・送信者はGmailが入れる）
 *   - 台帳の解決が**検索だけ**で、見つからなくても作らないこと
 *   - メール列を見出しから探し、その列だけを読むこと
 *   - drive.file と gmail.send の**両方**の付与を検証すること
 *   - トークンが例外・画面用文言に漏れないこと
 * ==================================================================
 *
 * ブラウザ用モジュールを Node からそのまま import する（card-ocr の
 * テストと同じやり方）。TextEncoder と btoa は Node にもある。
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

import {
  BCC_BATCH_SIZE,
  DATA_TAB_NAME,
  EMAIL_COLUMN_HEADER,
  GMAIL_SEND_ENDPOINT,
  REQUIRED_SCOPES,
} from '../../public/production-app/card-mail/config.js';

import {
  chunkRecipients,
  isValidEmail,
  normalizeRecipients,
} from '../../public/production-app/card-mail/recipients.js';

import {
  base64FromUtf8,
  buildBccHeader,
  buildRawMessage,
  encodeHeaderWord,
  sendAllBatches,
  toBase64Url,
} from '../../public/production-app/card-mail/mail.js';

import {
  LedgerError,
  LedgerErrorCode,
  columnLetter,
  findEmailColumnIndex,
  isFileId,
  quoteTabTitle,
  readEmailColumn,
  resolveLedger,
} from '../../public/production-app/card-mail/ledger.js';

import { hasRequiredScopes } from '../../public/production-app/card-mail/drive-auth.js';

import {
  DriveErrorCode,
  mapHttpErrorToCode,
} from '../../public/production-app/card-mail/drive-api.js';

const many = (count) => Array.from({ length: count }, (_, i) => `user${i}@example.com`);

/* base64url を復号する（Gmail へ渡る raw の中身を検査するため）。 */
function decodeRaw(raw) {
  const base64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf8');
}

try {
  /* ---------------------------------------------------------------- */
  section('メールアドレスの検証');

  check('普通のアドレスを通す', isValidEmail('taro@example.com'));
  check('サブアドレス付きを通す', isValidEmail('taro.yamada+tag@mail.example.co.jp'));
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
    ]);

    check('前後の空白を落とす', result.recipients.includes('Taro@example.com'));
    check('大文字小文字違いは1件にまとめる', result.recipients.length === 2,
      JSON.stringify(result.recipients));
    check('最初に現れた表記を送信に使う', result.recipients[0] === 'Taro@example.com');
    check('重複の件数を数える', result.duplicateCount === 1);
    check('不正な宛先を原形のまま集める（利用者に見せるため）',
      result.invalid.length === 1 && result.invalid[0] === 'こわれた宛先',
      JSON.stringify(result.invalid));
  }

  /* ---------------------------------------------------------------- */
  section('分割の境界（要件: 100件ずつ）');

  check('1通の宛先数は100（無償Gmailの1通100宛先に、Toなしで収まる）',
    BCC_BATCH_SIZE === 100);
  check('100件は1通', chunkRecipients(many(100)).length === 1);
  check('101件は2通', chunkRecipients(many(101)).length === 2);
  check('250件は3通（100/100/50）',
    chunkRecipients(many(250)).map((c) => c.length).join(',') === '100,100,50');
  check('分割しても全宛先が残る', chunkRecipients(many(250)).flat().length === 250);

  /* ---------------------------------------------------------------- */
  section('メッセージの組み立て');

  check('日本語をUTF-8でbase64にする',
    Buffer.from(base64FromUtf8('こんにちは'), 'base64').toString('utf8') === 'こんにちは');
  check('base64url に + / = が現れない', !/[+/=]/.test(toBase64Url('日本語テキスト???>>>')));
  check('ASCIIだけの件名はそのまま', encodeHeaderWord('Hello') === 'Hello');
  check('日本語の件名は encoded-word になる', encodeHeaderWord('ご挨拶').startsWith('=?UTF-8?B?'));
  check('encoded-word は1語75文字以内',
    encodeHeaderWord('長い件名'.repeat(30)).split(' ').every((word) => word.length <= 75));

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
      subject: 'ご挨拶',
      text: '本文です。',
      bcc: many(BCC_BATCH_SIZE),
    });

    check('Bcc に全宛先が入る',
      raw.includes('user0@example.com') && raw.includes('user99@example.com'));
    check('To を付けない（宛先を晒さない）', !/^To:/m.test(raw));
    check('From を付けない（Gmailが本人のアドレスを入れる）', !/^From:/m.test(raw));
    check('どの行も998文字を超えない（RFC 5322）',
      raw.split('\r\n').every((line) => line.length <= 998),
      `最長 ${Math.max(...raw.split('\r\n').map((l) => l.length))} 文字`);
    check('本文がbase64で入る', raw.includes(base64FromUtf8('本文です。')));
  }

  {
    let subjectInjected = null;

    try {
      buildRawMessage({ subject: '件名\r\nBcc: x@y.jp', text: '本文', bcc: ['a@ex.jp'] });
    } catch (error) {
      subjectInjected = error;
    }

    check('件名への改行差し込みを止める', subjectInjected instanceof TypeError);
  }

  check('件名なしを弾く', (() => {
    try {
      buildRawMessage({ subject: ' ', text: '本文', bcc: ['a@ex.jp'] });
      return false;
    } catch (error) {
      return error instanceof TypeError;
    }
  })());

  check('本文なしを弾く', (() => {
    try {
      buildRawMessage({ subject: '件名', text: '', bcc: ['a@ex.jp'] });
      return false;
    } catch (error) {
      return error instanceof TypeError;
    }
  })());

  /* ---------------------------------------------------------------- */
  section('スコープの検証');

  const SCOPE_STRING = REQUIRED_SCOPES.join(' ');

  check('必要な2スコープは drive.file と gmail.send',
    SCOPE_STRING.includes('drive.file') && SCOPE_STRING.includes('gmail.send')
      && REQUIRED_SCOPES.length === 2);
  check('両方付与されていれば通す', hasRequiredScopes({ scope: SCOPE_STRING }));
  check('drive.file だけでは弾く（読めるのに送れない事故を防ぐ）',
    !hasRequiredScopes({ scope: REQUIRED_SCOPES[0] }));
  check('gmail.send だけでは弾く',
    !hasRequiredScopes({ scope: REQUIRED_SCOPES[1] }));
  check('scope が無ければ弾く', !hasRequiredScopes({}));

  /* ---------------------------------------------------------------- */
  section('台帳の解決（検索のみ・作らない）');

  check('列番号をA1記法にする（0→A、26→AA）',
    columnLetter(0) === 'A' && columnLetter(25) === 'Z' && columnLetter(26) === 'AA');
  check("タブ名の ' を '' にする", quoteTabTitle("名刺'データ") === "'名刺''データ'");
  check('ファイルIDの形を検査する',
    isFileId('abcDEF123456789_-x') && !isFileId('short') && !isFileId(null));

  check('見出しからメール列を探す',
    findEmailColumnIndex(['record_id', '氏名', EMAIL_COLUMN_HEADER, 'URL']) === 2);
  check('見出しの前後空白は許す',
    findEmailColumnIndex([` ${EMAIL_COLUMN_HEADER} `]) === 0);
  check('似た別の見出しは採らない（誤読は「見つからない」より深刻）',
    findEmailColumnIndex(['メール', 'メールアドレス2']) === -1);

  /* Drive/Sheets の偽物。検索と読み取りだけ応答し、呼び出しを記録する。 */
  function buildDriveStub({ folders = {}, sheetId = null, header = [], column = [] } = {}) {
    const calls = [];

    const fetchImpl = async (url, options = {}) => {
      const urlText = String(url);
      calls.push({ url: urlText, method: options.method ?? 'GET' });

      const json = (body) => ({ ok: true, status: 200, json: async () => body });

      if (urlText.startsWith('https://www.googleapis.com/drive/v3/files?')) {
        const q = new URL(urlText).searchParams.get('q') ?? '';

        for (const [name, entry] of Object.entries(folders)) {
          if (q.includes(`name='${name}'`)) {
            return json({ files: entry ? [{ id: entry }] : [] });
          }
        }

        if (q.includes("name='名刺管理'")) {
          return json({ files: sheetId ? [{ id: sheetId }] : [] });
        }

        return json({ files: [] });
      }

      if (urlText.includes('sheets.googleapis.com')) {
        if (urlText.includes(encodeURIComponent('1:1'))) {
          return json({ values: [header] });
        }

        return json({ values: column.map((value) => [value]) });
      }

      return { ok: false, status: 404, json: async () => ({}) };
    };

    return { fetchImpl, calls };
  }

  {
    const stub = buildDriveStub({
      folders: { 'TSAM AI': 'root-folder-id', '名刺データ': 'app-folder-id' },
      sheetId: 'sheet-id-123456',
    });

    const id = await resolveLedger({ token: 'ya29.secret-token', fetchImpl: stub.fetchImpl });

    check('TSAM AI／名刺データ／名刺管理 の順で解決する', id === 'sheet-id-123456');
    check('作成のPOSTを一度も発行しない（読み取り専用）',
      stub.calls.every((call) => call.method === 'GET'),
      JSON.stringify(stub.calls.map((c) => c.method)));
  }

  {
    const stub = buildDriveStub({
      folders: { 'TSAM AI': 'root-folder-id', '名刺データ': null },
    });

    let missing = null;

    try {
      await resolveLedger({ token: 'ya29.secret-token', fetchImpl: stub.fetchImpl });
    } catch (error) {
      missing = error;
    }

    check('台帳が無ければ LEDGER_NOT_FOUND（作らない）',
      missing instanceof LedgerError && missing.code === LedgerErrorCode.LEDGER_NOT_FOUND);
    check('例外にトークンを含めない',
      missing !== null && !`${missing.message} ${missing.detail}`.includes('ya29'));
  }

  {
    const stub = buildDriveStub({
      header: ['record_id', '氏名', EMAIL_COLUMN_HEADER],
      column: [' taro@example.com ', '', 'hanako@example.jp'],
    });

    const values = await readEmailColumn('sheet-id-123456', { token: 't', fetchImpl: stub.fetchImpl });

    check('メール列の値を上から順に読む（空セルは除く）',
      values.join(',') === 'taro@example.com,hanako@example.jp', JSON.stringify(values));

    const columnCall = stub.calls.find((call) => call.url.includes(encodeURIComponent('C2:C')));
    check('見出しで見つけた列（C列）だけを読む（他の個人情報の列を取得しない）',
      Boolean(columnCall), stub.calls.map((c) => c.url).join('\n'));
    check('タブ名は名刺データ',
      stub.calls.some((call) => call.url.includes(encodeURIComponent(`'${DATA_TAB_NAME}'`))));
    check('読み取りもGETのみ（書き込み系のリクエストを出さない）',
      stub.calls.every((call) => call.method === 'GET'));
  }

  {
    const stub = buildDriveStub({ header: ['record_id', '氏名'] });

    let noColumn = null;

    try {
      await readEmailColumn('sheet-id-123456', { token: 't', fetchImpl: stub.fetchImpl });
    } catch (error) {
      noColumn = error;
    }

    check('メール列が無ければ COLUMN_NOT_FOUND',
      noColumn instanceof LedgerError && noColumn.code === LedgerErrorCode.COLUMN_NOT_FOUND);
  }

  /* ---------------------------------------------------------------- */
  section('一斉送信の実行');

  /* Gmail API の偽物。送信内容を記録し、指定した通で失敗させられる。 */
  function buildGmailStub({ failAtCall = Infinity } = {}) {
    const sent = [];
    let calls = 0;

    const fetchImpl = async (url, options = {}) => {
      if (String(url) !== GMAIL_SEND_ENDPOINT) {
        return { ok: false, status: 404, json: async () => ({}) };
      }

      calls += 1;

      if (calls >= failAtCall) {
        return { ok: false, status: 429, json: async () => ({}) };
      }

      sent.push(decodeRaw(JSON.parse(options.body).raw));

      return { ok: true, status: 200, json: async () => ({ id: `msg-${calls}` }) };
    };

    return { fetchImpl, sent };
  }

  {
    const stub = buildGmailStub();
    const chunks = chunkRecipients(many(250));
    const progress = [];

    const result = await sendAllBatches({
      subject: 'ご挨拶',
      text: '本文です。',
      chunks,
      token: 'ya29.secret-token',
      fetchImpl: stub.fetchImpl,
      onProgress: (done, total) => progress.push(`${done}/${total}`),
    });

    check('250件は3通で送られる', result.batchCount === 3 && stub.sent.length === 3);
    check('送信済み件数が全宛先数に一致する', result.sentCount === 250);
    check('1通目に user0、3通目に user249 が入る',
      stub.sent[0].includes('user0@example.com') && stub.sent[2].includes('user249@example.com'));
    check('進捗が通ごとに知らされる', progress.join(' ') === '0/3 1/3 2/3 3/3', progress.join(' '));
  }

  {
    const stub = buildGmailStub({ failAtCall: 3 });
    const chunks = chunkRecipients(many(250));
    let failure = null;

    try {
      await sendAllBatches({
        subject: 'ご挨拶',
        text: '本文です。',
        chunks,
        token: 'ya29.secret-token',
        fetchImpl: stub.fetchImpl,
      });
    } catch (error) {
      failure = error;
    }

    check('途中失敗を例外にする', failure instanceof Error);
    check('送信済みの通数が例外に載る（3通中2通）', failure?.batchesDone === 2,
      String(failure?.batchesDone));
    check('送信済みの件数が例外に載る（200件）', failure?.sentCount === 200,
      String(failure?.sentCount));
    check('例外にトークンを含めない',
      failure !== null
        && !`${failure.message} ${failure.cause?.message ?? ''} ${failure.cause?.detail ?? ''}`
          .includes('ya29.secret-token'));
  }

  /* ---------------------------------------------------------------- */
  section('レビュー指摘の回帰');

  {
    /*
     * 件名の折り返し（レビュー所見3）。入力欄が許す上限（250文字）の
     * 日本語件名で、Subject 行が RFC 5322 の998文字を超えないこと。
     */
    const raw = buildRawMessage({ subject: '長'.repeat(250), text: '本文です。', bcc: ['a@ex.jp'] });
    const lines = raw.split('\r\n');

    check('250文字の日本語件名でも全行998文字以内（Subjectの折り返し）',
      lines.every((line) => line.length <= 998),
      `最長 ${Math.max(...lines.map((l) => l.length))} 文字`);
    check('折り返した件名の継続行は空白で始まる（folding）',
      lines.filter((line) => line.startsWith(' =?UTF-8?B?')).length > 0);
    check('Cc ヘッダーも無い', !/^Cc:/m.test(raw));
  }

  {
    /* ヘッダー最終関門の強化（レビュー所見7）。検証を経ない呼び出しでも通さない。 */
    const rejectsBcc = (address) => {
      try {
        buildBccHeader([address]);
        return false;
      } catch (error) {
        return error instanceof TypeError;
      }
    };

    check('カンマ入りの宛先はヘッダー組み立てでも止める（宛先の水増し）',
      rejectsBcc('a@b.jp,c@d.jp'));
    check('タブ入りの宛先も止める', rejectsBcc('a@b\t.jp'));
    check('セミコロン入りの宛先も止める', rejectsBcc('a@b.jp;c@d.jp'));
  }

  {
    /*
     * 401/403 の分類（レビュー指摘のテストの穴）。card-mail は
     * drive-api.js を独自に複製しているため、「403でトークンを捨てない」
     * 判定の土台をここで固定する。
     */
    check('401 は UNAUTHORIZED（トークンを捨ててよい唯一の分類）',
      mapHttpErrorToCode(401) === DriveErrorCode.UNAUTHORIZED);
    check('403+rateLimitExceeded は RATE_LIMITED（待てば直る）',
      mapHttpErrorToCode(403, 'userRateLimitExceeded') === DriveErrorCode.RATE_LIMITED);
    check('403+storageQuotaExceeded は STORAGE_FULL',
      mapHttpErrorToCode(403, 'storageQuotaExceeded') === DriveErrorCode.STORAGE_FULL);
    check('素の403 は FORBIDDEN',
      mapHttpErrorToCode(403, 'insufficientPermissions') === DriveErrorCode.FORBIDDEN);
  }

  {
    /* localStorage に入るのがファイルIDだけであることの表明。 */
    const store = new Map();

    globalThis.localStorage = {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)); },
      removeItem: (key) => { store.delete(key); },
    };

    try {
      const stub = buildDriveStub({
        folders: { 'TSAM AI': 'root-folder-id', '名刺データ': 'app-folder-id' },
        sheetId: 'sheet-id-123456',
      });

      await resolveLedger({ token: 'ya29.secret-token', fetchImpl: stub.fetchImpl });

      check('localStorage に入るのはファイルIDの形の値だけ',
        store.size > 0 && [...store.values()].every((value) => isFileId(value)),
        JSON.stringify([...store.entries()]));
      check('localStorage にトークンが入らない',
        ![...store.values()].some((value) => value.includes('ya29')));
    } finally {
      delete globalThis.localStorage;
    }
  }

  {
    /* 進捗表示の失敗が送信計画を壊さないこと（レビュー所見6）。 */
    const stub = buildGmailStub();

    const result = await sendAllBatches({
      subject: 'ご挨拶',
      text: '本文です。',
      chunks: chunkRecipients(many(150)),
      token: 'ya29.secret-token',
      fetchImpl: stub.fetchImpl,
      onProgress: () => {
        throw new Error('表示側の不具合');
      },
    });

    check('進捗コールバックが例外を投げても送信は完走する',
      result.sentCount === 150 && result.batchCount === 2);
  }

  finish();
} catch (error) {
  fatal(error);
}

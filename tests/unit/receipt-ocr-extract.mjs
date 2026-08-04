/*
 * ルール抽出の検証（v1.3 §10.1〜§10.10）。
 * 対象仕様: docs/specs/receipt-ocr-v1.3.md、docs/specs/receipt-ocr-v2.md §7
 *
 * ------------------------------------------------------------------
 * 誤読系を必ず入れる
 * ------------------------------------------------------------------
 * §10 の各項目は「こう読める」より「こう読み違える」を防ぐために
 * 書かれている。正常系だけ通しても、守りたいものが守れていない。
 *
 * ここで見る誤読:
 *   「1.000」を 1 と読む（§10.1）
 *   「お預り」を合計と取り違える（§10.4）
 *   ポイント失効日等の未来日を利用日にする（§10.2 / §13.2）
 *   T の無い13桁を登録番号として採用する（§10.6）
 *   電話番号とレシートNo.を取り違える（§10.5 / §10.7）
 * ------------------------------------------------------------------
 *
 * 通信は行わない（純関数のみ）。
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

try {
  const amount = await import('../../public/production-app/receipt-ocr/amount.js');
  const extract = await import('../../public/production-app/receipt-ocr/extract.js');
  const status = await import('../../public/production-app/receipt-ocr/status.js');

  const { normalizeAmount, findAmounts } = amount;
  const { toLines, parseDate } = extract;
  const { REGISTRATION_STATUS, TAX_NOTATION } = status;

  /* ================================================================ */
  section('§10.1 金額の正規化');

  check('「1,000」→ 1000', normalizeAmount('1,000') === 1000);
  check('「¥1000」→ 1000', normalizeAmount('¥1000') === 1000);
  check('「1000円」→ 1000', normalizeAmount('1000円') === 1000);
  check('全角「１，０００」→ 1000', normalizeAmount('１，０００') === 1000);
  check('「￥ 1,234,567」→ 1234567', normalizeAmount('￥ 1,234,567') === 1234567);

  /* §10.1 が名指しした誤読。 */
  check('★「1.000」を 1 と解釈しない', normalizeAmount('1.000') !== 1);
  check('★「1.000」はカンマ誤認として 1000 にする', normalizeAmount('1.000') === 1000);
  check('★「1.234.567」も桁区切りとして扱う', normalizeAmount('1.234.567') === 1234567);

  /* 桁区切りとして説明がつかないものは、推測で直さず null。 */
  check('★「1.5」は変換失敗（null）', normalizeAmount('1.5') === null);
  check('★「1,00」は変換失敗（null）', normalizeAmount('1,00') === null);
  check('「約1000」は変換失敗（null）', normalizeAmount('約1000') === null);

  /* 変換失敗は 0 にしない。0 にすると §13.1 の「0円より大きい」をすり抜ける。 */
  check('★変換失敗は null であって 0 ではない', normalizeAmount('---') === null);
  check('空文字は null', normalizeAmount('') === null);
  check('null は null', normalizeAmount(null) === null);
  check('小数の数値は null', normalizeAmount(12.5) === null);

  check('会計表記の △ は負数', normalizeAmount('△1,000') === -1000);
  check('括弧書きも負数', normalizeAmount('(1,000)') === -1000);

  check('行から金額を拾える',
    JSON.stringify(findAmounts('合計 ¥1,200')) === JSON.stringify([1200]));

  check('複数の金額を拾える',
    findAmounts('お預り ¥2,000 お釣り ¥800').length === 2);

  /* ---------------------------------------------------------------- */
  section('§10.2 利用日（ラベル近接必須）');

  check('2026年8月2日', parseDate('2026年8月2日') === '2026-08-02');
  check('2026/08/02', parseDate('2026/08/02') === '2026-08-02');
  check('2026-08-02', parseDate('2026-08-02') === '2026-08-02');
  check('2026.08.02', parseDate('2026.08.02') === '2026-08-02');
  check('令和8年8月2日', parseDate('令和8年8月2日') === '2026-08-02');
  check('R8.8.2', parseDate('R8.8.2') === '2026-08-02');
  check('26/08/02（2桁年）', parseDate('26/08/02') === '2026-08-02');
  check('存在しない日付は null', parseDate('2026-02-30') === null);
  check('日付でない文字列は null', parseDate('ありがとうございました') === null);

  {
    const result = extract.extractUsedOn(toLines([
      'セブンイレブン',
      '利用日 2026年8月1日',
      '合計 ¥1,200',
    ].join('\n')));

    check('ラベル近接で取れる', result.value === '2026-08-01');
    check('ラベル近接フラグが立つ', result.labelAdjacent === true);
    check('候補1件で確定する', result.confirmed === true && result.candidates === 1);
  }

  {
    /* ★誤読系：ポイント失効日（未来日）を利用日にしない。 */
    const result = extract.extractUsedOn(toLines([
      'セブンイレブン',
      '2026年8月1日',
      'ポイント失効日 2027年3月31日',
      '合計 ¥1,200',
    ].join('\n')));

    check('★ラベルの無い日付は拾わない', result.value === null);
    check('★ポイント失効日を利用日にしない', result.value !== '2027-03-31');
    check('ラベルで特定できなければ確定しない（補完か要確認へ）', result.confirmed === false);
  }

  {
    /* ラベル付きの取引日があれば、他に未来日があっても正しく取る。 */
    const result = extract.extractUsedOn(toLines([
      '取引日 2026/08/01',
      'クーポン有効期限 2026/12/31',
      'カード有効期限 30/09',
    ].join('\n')));

    check('★ラベル付きの取引日だけを採る', result.value === '2026-08-01');
  }

  {
    /* ラベル近接の候補が複数あれば確定しない。 */
    const result = extract.extractUsedOn(toLines([
      '利用日 2026/08/01',
      '発行日 2026/08/03',
    ].join('\n')));

    check('候補が複数なら確定しない', result.confirmed === false);
    check('候補数を数えている', result.candidates === 2);
  }

  /* ---------------------------------------------------------------- */
  section('§10.4 合計金額（お預り・お釣りを採用しない）');

  {
    /* ★誤読系：お預り優先の取り違え。合計より大きい金額が混在する典型。 */
    const result = extract.extractTotalAmount(toLines([
      '小計 ¥1,100',
      '消費税 ¥100',
      '合計 ¥1,200',
      'お預り ¥2,000',
      'お釣り ¥800',
    ].join('\n')));

    check('★合計を正しく取る', result.value === 1200);
    check('★お預り(2000)を合計にしない', result.value !== 2000);
    check('★お釣り(800)を合計にしない', result.value !== 800);
    check('★小計(1100)を優先しない', result.value !== 1100);
    check('確定してよい', result.confirmed === true);
    check('合計ラベル近接で取れている', result.labelAdjacent === true);
  }

  {
    /* 消費税合計は「合計」の字を含むが、合計金額ではない。 */
    const result = extract.extractTotalAmount(toLines([
      '消費税合計 ¥100',
      '合計 ¥1,200',
    ].join('\n')));

    check('★消費税合計を合計金額にしない', result.value === 1200);
  }

  {
    /* クレジット支払額は現金併用時に合計と一致しないため根拠にしない。 */
    const result = extract.extractTotalAmount(toLines([
      '合計 ¥3,000',
      'クレジット支払 ¥2,000',
      '現金 ¥1,000',
    ].join('\n')));

    check('★クレジット支払額を合計にしない', result.value === 3000);
  }

  {
    /* 合計が取れず小計だけがある場合は、小計を候補にするが確定しない。 */
    const result = extract.extractTotalAmount(toLines(['小計 ¥1,100'].join('\n')));

    check('小計は候補にはなる', result.value === 1100);
    check('小計だけでは確定しない', result.confirmed === false);
    check('合計ラベル近接ではない', result.labelAdjacent === false);
  }

  {
    /* 候補が複数残った場合はルールで確定しない（§10.4 末尾）。 */
    const result = extract.extractTotalAmount(toLines([
      '合計 ¥1,200',
      'お支払額 ¥1,500',
    ].join('\n')));

    check('候補が複数なら確定しない', result.confirmed === false);
    check('候補数を数えている', result.candidates === 2);
  }

  check('ご請求額も合計として拾う',
    extract.extractTotalAmount(toLines(['ご請求額 ¥5,500'])).value === 5500);

  check('現計も合計として拾う',
    extract.extractTotalAmount(toLines(['現計 ¥980'])).value === 980);

  /* ---------------------------------------------------------------- */
  section('§10.6 適格請求書登録番号（T必須・状態3値）');

  {
    const result = extract.extractRegistrationNumber(toLines([
      '登録番号 T1234567890123',
    ]));

    check('T付き13桁を採用する', result.value === 'T1234567890123');
    check('状態は「取得済み」', result.status === REGISTRATION_STATUS.FOUND);
  }

  {
    /* ★誤読系：T の無い13桁に T を補って採用してはならない。 */
    const result = extract.extractRegistrationNumber(toLines([
      '登録番号 1234567890123',
    ]));

    check('★T無し13桁を登録番号として採用しない', result.value === null);
    check('★ラベルはあるので「読取失敗」', result.status === REGISTRATION_STATUS.UNREADABLE);
    check('★値を補正しない', result.value !== 'T1234567890123');
  }

  {
    const result = extract.extractRegistrationNumber(toLines([
      'セブンイレブン',
      '合計 ¥1,200',
    ]));

    check('★記載が無ければ「記載なし（免税の可能性）」',
      result.status === REGISTRATION_STATUS.ABSENT);
    check('「読取失敗」と区別する', result.status !== REGISTRATION_STATUS.UNREADABLE);
  }

  check('★電話番号の数字列を登録番号にしない',
    extract.extractRegistrationNumber(toLines(['TEL 03-1234-5678'])).value === null);

  /*
   * 実機で見つかった誤判定（2026-08-04）。
   * 市販の領収証用紙は登録番号欄が印刷されており、免税事業者は空欄で渡す。
   * 「欄はあるが何も書いていない」は記載なしであって、読取失敗ではない。
   */
  {
    const result = extract.extractRegistrationNumber(toLines([
      '領収証',
      '株式会社サンプル商事',
      '登録番号',
      '',
    ].join('\n')));

    check('★登録番号欄が空欄なら「記載なし（免税の可能性）」',
      result.status === REGISTRATION_STATUS.ABSENT);
    check('★空欄を「読取失敗」にしない',
      result.status !== REGISTRATION_STATUS.UNREADABLE);
  }

  check('★登録番号欄の下の電話番号を「番号が書いてある」と読まない',
    extract.extractRegistrationNumber(toLines([
      '登録番号',
      'TEL 03-1234-5678',
    ].join('\n'))).status === REGISTRATION_STATUS.ABSENT);

  check('★登録番号欄の下の裸の電話番号も拾わない（桁数で見分ける）',
    extract.extractRegistrationNumber(toLines([
      '登録番号',
      '03-1234-5678',
    ].join('\n'))).status === REGISTRATION_STATUS.ABSENT);

  check('欄が改行で割れて13桁が入っていれば「読取失敗」',
    extract.extractRegistrationNumber(toLines([
      '登録番号',
      '1234567890123',
    ].join('\n'))).status === REGISTRATION_STATUS.UNREADABLE);

  check('インボイスの語だけがあっても、数字が無ければ「記載なし」',
    extract.extractRegistrationNumber(toLines(['インボイス対応'])).status
      === REGISTRATION_STATUS.ABSENT);

  check('チェックデジットは加点材料として計算できる',
    typeof extract.checkDigitValid('T1234567890123') === 'boolean');

  check('形式が違えばチェックデジットは false',
    extract.checkDigitValid('T123') === false);

  /* ---------------------------------------------------------------- */
  section('§10.7 / §10.5 電話番号とレシートNo.の取り違え');

  {
    const lines = toLines([
      'セブンイレブン 大手町店',
      'TEL 03-1234-5678',
      'レシートNo. 0001',
    ].join('\n'));

    const phone = extract.extractPhoneNumber(lines);
    const receipt = extract.extractReceiptNumber(lines, phone.value);

    check('電話番号を取れる', phone.value === '0312345678');
    check('レシートNo.を取れる', receipt.value === '0001');
    check('★電話番号をレシートNo.にしない', receipt.value !== '0312345678');
    check('★レシートNo.を電話番号にしない', phone.value !== '0001');
  }

  {
    /* ★誤読系：ラベルの無い数字列は、どちらにも採用しない。 */
    const lines = toLines(['0312345678', '9876543210'].join('\n'));

    check('★ラベル無しの数字列を電話番号にしない',
      extract.extractPhoneNumber(lines).value === null);
    check('★ラベル無しの数字列をレシートNo.にしない',
      extract.extractReceiptNumber(lines).value === null);
  }

  check('区切りがあればラベル無しでも電話番号と分かる',
    extract.extractPhoneNumber(toLines(['03-1234-5678'])).value === '0312345678');

  check('括弧区切りも電話番号と分かる',
    extract.extractPhoneNumber(toLines(['(03)1234-5678'])).value === '0312345678');

  check('伝票番号ラベルでもレシートNo.を取れる',
    extract.extractReceiptNumber(toLines(['伝票番号 12345'])).value === '12345');

  {
    /* 電話番号として採った数字は、レシートNo.には回さない。 */
    const receipt = extract.extractReceiptNumber(toLines(['No. 0312345678']), '0312345678');
    check('★電話番号と同じ数字はレシートNo.にしない', receipt.value === null);
  }

  /* ---------------------------------------------------------------- */
  section('§10.9 消費税内訳（印字どおり・表記区分を併記）');

  {
    const result = extract.extractTaxBreakdown(toLines([
      '8%対象 ¥1,080',
      '8%消費税 ¥80',
      '10%対象 ¥1,100',
      '10%消費税 ¥100',
      '（税込）',
    ].join('\n')));

    check('8%対象額を取れる', result.tax8Base === 1080);
    check('8%消費税額を取れる', result.tax8Amount === 80);
    check('10%対象額を取れる', result.tax10Base === 1100);
    check('10%消費税額を取れる', result.tax10Amount === 100);
    check('★表記区分を併記する（税込）', result.notation === TAX_NOTATION.INCLUSIVE);
    check('★印字どおりに記録する（税抜へ換算しない）', result.tax8Base === 1080);
  }

  check('外税表記なら「税抜」',
    extract.extractTaxBreakdown(toLines(['10%対象 ¥1,000', '外税 ¥100'])).notation
      === TAX_NOTATION.EXCLUSIVE);

  check('★税込・税抜が判別できなければ「不明」',
    extract.extractTaxBreakdown(toLines(['10%対象 ¥1,000'])).notation === TAX_NOTATION.UNKNOWN);

  check('税率の数字（8・10）を金額として拾わない',
    extract.extractTaxBreakdown(toLines(['8%対象 ¥1,080'])).tax8Base === 1080);

  check('消費税合計を取れる',
    extract.extractTaxBreakdown(toLines(['消費税 ¥100'])).taxTotal === 100);

  /* ---------------------------------------------------------------- */
  section('§10.10 支払方法');

  check('現金', extract.extractPaymentMethod(toLines(['現金 ¥1,000'])).value === '現金');
  check('クレジットカード',
    extract.extractPaymentMethod(toLines(['VISA ****1234'])).value === 'クレジットカード');
  check('コード決済',
    extract.extractPaymentMethod(toLines(['PayPay 決済'])).value === 'コード決済');
  check('交通系IC',
    extract.extractPaymentMethod(toLines(['Suica 残高 ¥3,000'])).value === '交通系IC');
  check('電子マネー',
    extract.extractPaymentMethod(toLines(['nanaco'])).value === '電子マネー');
  check('振込', extract.extractPaymentMethod(toLines(['お振込にて'])).value === '振込');
  check('該当なしなら null',
    extract.extractPaymentMethod(toLines(['ありがとうございました'])).value === null);

  /* ---------------------------------------------------------------- */
  section('§10.3 支払先（電話番号・住所の行を採用しない）');

  {
    const result = extract.extractPayee(toLines([
      '領収書',
      '株式会社サンプル商事',
      '東京都千代田区大手町1-1-1',
      'TEL 03-1234-5678',
    ].join('\n')));

    check('法人名の行を採る', result.value === '株式会社サンプル商事');
    check('★住所の行を採らない', !String(result.value).includes('東京都'));
    check('★電話番号の行を採らない', !String(result.value).includes('TEL'));
    check('★「領収書」の見出し行を採らない', result.value !== '領収書');
    check('確定してよい', result.confirmed === true);
  }

  {
    /* 店舗マスタ：電話番号一致を最優先の照合キーとする（§10.7）。 */
    const master = [{ keyword: 'セブン', officialName: '株式会社セブン-イレブン・ジャパン', phoneNumber: '03-1234-5678', accountCandidate: '会議費' }];
    const lines = toLines(['セブンイレブン 大手町店', 'TEL 03-1234-5678']);

    const result = extract.extractPayee(lines, { storeMaster: master, phoneDigits: '0312345678' });

    check('★電話番号一致を最優先する', result.masterMatch === 'phone');
    check('マスタの正式名称を使う', result.value === '株式会社セブン-イレブン・ジャパン');
  }

  {
    const master = [{ keyword: 'セブンイレブン', officialName: '株式会社セブン-イレブン・ジャパン', accountCandidate: '会議費' }];
    const result = extract.extractPayee(toLines(['セブンイレブン 大手町店']), { storeMaster: master });

    check('電話番号が無ければキーワードで照合する', result.masterMatch === 'keyword');
  }

  /*
   * 実機で見つかった誤採用（2026-08-04）。
   * 日付は領収証のどこにでも印字され、店名より上に来ることもある。
   */
  {
    const result = extract.extractPayee(toLines([
      '2026年8月1日',
      'まるまるマート',
      '合計 ¥500',
    ].join('\n')));

    check('★日付の行を店名にしない', result.value !== '2026年8月1日');
    check('日付を飛ばして次の候補を採る', result.value === 'まるまるマート');
  }

  for (const dateLine of ['2026年8月1日', '2026/08/02', '令和8年8月2日', '26/08/02']) {
    check(`★日付だけの行（${dateLine}）は候補にしない`,
      extract.extractPayee(toLines(dateLine)).value === null);
  }

  /*
   * 実機で見つかった誤採用（2026-08-04）。
   * 手書き領収証の題字は崩れており、「領取 証」のように誤読される。
   */
  for (const title of ['領収証', '領収書', 'レシート', '領取 証', '領 収 証', '受取証', 'お買上票']) {
    check(`★題字（${title}）を店名にしない`,
      extract.extractPayee(toLines(title)).value === null);
  }

  {
    const result = extract.extractPayee(toLines([
      '領取 証',
      '2026年8月1日',
      'まるまるマート',
    ].join('\n')));

    check('★誤読された題字と日付を飛ばして店名へ届く', result.value === 'まるまるマート');
  }

  /*
   * 宛名の除外（2026-08-04 予防対応）。
   * 宛名はたいてい法人名で書かれるため、ここだけは法人格の例外を認めない。
   */
  for (const addressee of ['上様', '御中', '各位', '山田太郎 様', '株式会社クライアント 御中']) {
    check(`★宛名（${addressee}）を店名にしない`,
      extract.extractPayee(toLines(addressee)).value === null);
  }

  check('★宛名は法人格があっても除外する',
    extract.extractPayee(toLines('株式会社クライアント 御中')).value === null);

  {
    /* 領収証の実際の並び。宛名が発行者より上に来る。 */
    const result = extract.extractPayee(toLines([
      '領収証',
      '株式会社クライアント 御中',
      '2026年8月1日',
      '株式会社サンプル商事',
    ].join('\n')));

    check('★宛名を飛ばして発行者へ届く', result.value === '株式会社サンプル商事');
    check('★自社名（宛名）を支払先にしない', result.value !== '株式会社クライアント 御中');
  }

  check('行の途中の「様」は宛名とみなさない',
    extract.extractPayee(toLines('王様のパン工房')).value === '王様のパン工房');

  /*
   * ★実機で採用してしまったゴミ行（2026-08-04）。
   * 手書き領収証の複数の欄が1行へ潰れた形。
   * 行全体が日付でもなく、行末が「様」でもないため、両方の除外をすり抜けた。
   */
  {
    const GARBAGE = '様 様 2027 年 7 月 29 日 729';

    check('★欄が潰れた混在行を店名にしない',
      extract.extractPayee(toLines(GARBAGE)).value === null);

    const result = extract.extractPayee(toLines([
      '領収証',
      GARBAGE,
      'まるまるマート',
    ].join('\n')));

    check('★混在行を飛ばして店名へ届く', result.value === 'まるまるマート');
  }

  check('★単独で立つ「様」は行末でなくても宛名とみなす',
    extract.extractPayee(toLines('様 2026年8月1日')).value === null);

  check('★区切りに空白が入った日付も混在行として外す',
    extract.extractPayee(toLines('2027 年 7 月 29 日 729')).value === null);

  check('★「7月29日」だけの行も外す',
    extract.extractPayee(toLines('7月29日 729')).value === null);

  check('★令和表記が混ざる行も外す',
    extract.extractPayee(toLines('令和 8 年 発行')).value === null);

  check('法人格があれば混在行でも採る（外しすぎない）',
    extract.extractPayee(toLines('株式会社サンプル商事 2027 年 7 月 29 日')).confirmed === true);

  {
    /* 法人格が読めている行は、日付や題字が同居していても採ってよい。 */
    const withDate = extract.extractPayee(toLines('株式会社サンプル商事 2026年8月1日'));

    check('法人名に日付が同居していても採る',
      withDate.value === '株式会社サンプル商事 2026年8月1日');
    check('確定してよい', withDate.confirmed === true);
  }

  check('「〜店」で終わる行も店舗名として確定してよい（§10.3-3）',
    extract.extractPayee(toLines(['まるまる商店', '合計 ¥500'].join('\n'))).confirmed === true);

  {
    /* 法人格も「店」も無く、手がかりが「先頭付近」しかない場合。 */
    const result = extract.extractPayee(toLines(['まるまるマート', '合計 ¥500'].join('\n')));

    check('候補としては出す', result.value === 'まるまるマート');
    check('★手がかりが位置だけならルールで確定しない', result.confirmed === false);
  }

  /* ---------------------------------------------------------------- */
  section('§10.8 勘定科目（候補のみ・確定しない）');

  {
    const master = [{ keyword: 'セブン', officialName: 'セブン', accountCandidate: '会議費', summaryDefault: '打合せ' }];
    const result = extract.extractAccountCandidate({ payee: 'セブン', storeMaster: master });

    check('マスタの科目を候補にする', result.value === '会議費');
    check('出所を「店舗マスタ」と記録する', result.source === '店舗マスタ');
    check('摘要初期値も引く', result.summaryDefault === '打合せ');
  }

  check('マスタに無ければ候補なし',
    extract.extractAccountCandidate({ payee: 'どこか', storeMaster: [] }).value === null);

  /* ---------------------------------------------------------------- */
  section('まとめて抽出（extractAll）');

  {
    const OCR = [
      '領収書',
      '株式会社サンプル商事',
      '東京都千代田区大手町1-1-1',
      'TEL 03-1234-5678',
      '登録番号 T1234567890123',
      '取引日 2026年8月1日',
      'レシートNo. 0001',
      '小計 ¥1,100',
      '10%対象 ¥1,100',
      '10%消費税 ¥100',
      '合計 ¥1,200',
      'お預り ¥2,000',
      'お釣り ¥800',
      '現金',
    ].join('\n');

    const result = extract.extractAll(OCR);
    const values = extract.toValues(result);

    check('必須3項目が揃う',
      values.usedOn === '2026-08-01'
      && values.payee === '株式会社サンプル商事'
      && values.totalAmount === 1200);

    check('★お預りに引きずられない', values.totalAmount === 1200);
    check('登録番号が取れる', values.registrationNumber === 'T1234567890123');
    check('電話番号が取れる', values.phoneNumber === '0312345678');
    check('レシートNo.が取れる', values.receiptNumber === '0001');
    check('★電話番号とレシートNo.が別の値', values.phoneNumber !== values.receiptNumber);
    check('支払方法が取れる', values.paymentMethod === '現金');
    check('税率別内訳が取れる', values.tax10Base === 1100 && values.tax10Amount === 100);
  }

  {
    /* 何も読めなかった場合。値は null のまま、状態だけが残る。 */
    const result = extract.extractAll('');
    const values = extract.toValues(result);

    check('空のOCRでも例外を投げない', typeof values === 'object');
    check('必須項目は空のまま', values.usedOn === '' && values.payee === '' && values.totalAmount === '');
    check('登録番号は「記載なし」', values.registrationStatus === REGISTRATION_STATUS.ABSENT);
    check('確定しない', result.usedOn.confirmed === false && result.totalAmount.confirmed === false);
  }

  finish();
} catch (error) {
  fatal(error);
}

/*
 * 検証・信頼度・補完要否・保存前確認の検証。
 * 対象仕様: receipt-ocr-v1.3.md §11 / §13 / §14 / §15 / §16.1、
 *           receipt-ocr-v2.md §8
 *
 * 通信は行わない（純関数のみ）。
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

try {
  const validate = await import('../../public/production-app/receipt-ocr/validate.js');
  const confidence = await import('../../public/production-app/receipt-ocr/confidence.js');
  const policy = await import('../../public/production-app/receipt-ocr/completion-policy.js');
  const review = await import('../../public/production-app/receipt-ocr/review.js');
  const status = await import('../../public/production-app/receipt-ocr/status.js');
  const schema = await import('../../public/production-app/receipt-ocr/schema.js');
  const extract = await import('../../public/production-app/receipt-ocr/extract.js');
  const record = await import('../../public/production-app/receipt-ocr/record.js');
  const ai = await import('../../public/production-app/receipt-ocr/ai-complete.js');

  const { REVIEW_STATUS, DUPLICATE_STATUS, EXTRACTION_METHOD, CONFIDENCE_LEVEL } = status;
  const NOW = new Date('2026-08-03T00:00:00Z');

  /* ================================================================ */
  section('§13.1 金額検証');

  check('正の金額は通る', validate.validateAmount('1200').ok === true);
  check('0円は通さない', validate.validateAmount('0').ok === false);
  check('負の金額は通さない', validate.validateAmount('-100').ok === false);
  check('上限以上は通さない', validate.validateAmount('10000000').ok === false);
  check('正規化に失敗したら通さない', validate.validateAmount('1.5').ok === false);
  check('★変換失敗を 0 として扱わない',
    validate.validateAmount('1.5').amount === null);

  {
    /* 税額の逆算が合えば加点材料になる（外税表記）。 */
    const result = validate.validateAmount(1100, {
      tax: { tax10Base: 1000, tax10Amount: 100, tax8Base: null, tax8Amount: null },
    });

    check('税額の逆算が合えば整合とする', result.taxConsistent === true);
    check('警告は出さない', result.warnings.length === 0);
  }

  {
    /* 内税表記でも逆算できる。 */
    const result = validate.validateAmount(1100, {
      tax: { tax10Base: 1100, tax10Amount: 100, tax8Base: null, tax8Amount: null },
    });

    check('税込表記の逆算も整合とする', result.taxConsistent === true);
  }

  {
    const result = validate.validateAmount(1100, {
      tax: { tax10Base: 1000, tax10Amount: 500, tax8Base: null, tax8Amount: null },
    });

    check('★逆算が合わなくても即エラーにしない（§13.1）', result.ok === true);
    check('警告として記録する', result.warnings.some((w) => w.includes('逆算')));
    check('整合フラグは立てない', result.taxConsistent === false);
  }

  {
    /* ★値引き行があれば検算をスキップし、その旨を警告に残す。 */
    const result = validate.validateAmount(900, {
      lines: ['合計 ¥900', 'クーポン値引 -¥200'],
      tax: { tax10Base: 1000, tax10Amount: 100, tax8Base: null, tax8Amount: null },
    });

    check('★値引きがあれば検算を省略する', result.taxConsistent === false);
    check('★「値引きあり・検算省略」を記録する',
      result.warnings.includes('値引きあり・検算省略'));
    check('検算を省略しても金額自体は通る', result.ok === true);
  }

  {
    /* 「8％対象＋10％対象 ≒ 合計」は税込と特定できたときだけの参考検証。 */
    const inclusive = validate.checkBaseSum(2200, {
      notation: '税込', tax8Base: 1100, tax10Base: 1100,
    });

    check('税込と特定できれば参考検証を行う', inclusive.applicable === true);
    check('一致すれば整合', inclusive.consistent === true);

    const unknown = validate.checkBaseSum(2200, {
      notation: '不明', tax8Base: 1100, tax10Base: 1100,
    });

    check('★表記区分が不明なら参考検証を行わない', unknown.applicable === false);
  }

  check('★参考検証の不一致は警告どまり（要確認の単独根拠にしない）',
    validate.checkBaseSum(9999, { notation: '税込', tax8Base: 1100, tax10Base: 1100 }).warning !== null);

  /* ---------------------------------------------------------------- */
  section('§13.2 日付検証');

  check('過去の日付は通る',
    validate.validateDate('2026-08-01', { now: NOW }).ok === true);

  check('当日も通る',
    validate.validateDate('2026-08-03', { now: NOW }).ok === true);

  {
    /* ★誤読系：未来日はポイント失効日等の誤取得を示唆する。 */
    const result = validate.validateDate('2027-03-31', { now: NOW });

    check('★未来日は通さない', result.ok === false);
    check('★理由を示す', result.warnings.some((w) => w.includes('未来')));
  }

  check('★1年より古い日付は要確認',
    validate.validateDate('2025-01-01', { now: NOW }).ok === false);

  check('1年以内なら通る',
    validate.validateDate('2025-09-01', { now: NOW }).ok === true);

  check('日付として読めなければ通さない',
    validate.validateDate('', { now: NOW }).ok === false);

  /* ---------------------------------------------------------------- */
  section('§13.4 必須項目検証');

  check('必須は 支払先 / 利用日 / 合計金額 / 原本画像URL の4つ',
    JSON.stringify(validate.REQUIRED_FIELDS)
      === JSON.stringify(['payee', 'usedOn', 'totalAmount', 'originalUrl']));

  check('揃っていれば通る',
    validate.validateRequired({
      payee: 'A', usedOn: '2026-08-01', totalAmount: 1200, originalUrl: 'https://x',
    }).ok === true);

  {
    const result = validate.validateRequired({ payee: '', usedOn: '2026-08-01', totalAmount: 1200, originalUrl: 'https://x' });

    check('欠けていれば通さない', result.ok === false);
    check('欠けた項目を挙げる', result.missing.includes('payee'));
  }

  check('★原本画像URLも必須（v1.3 §13.4）',
    validate.validateRequired({ payee: 'A', usedOn: '2026-08-01', totalAmount: 1200, originalUrl: '' }).ok === false);

  /* ---------------------------------------------------------------- */
  section('§14 信頼度（コード側で算出・自己申告値は使わない）');

  {
    const result = confidence.scoreOf({
      usedOn: { labelAdjacent: true, candidates: 1 },
      totalAmount: { labelAdjacent: true, candidates: 1 },
      payee: { masterMatch: 'phone' },
      taxConsistent: true,
      agreements: { usedOn: true, totalAmount: true, payee: true },
    });

    check('満点は 200 点', result.max === 200);
    check('全部そろえば満点', result.score === 200);
    check('内訳を返す', result.detail.length > 0);
  }

  check('ラベル近接だけなら 30 点',
    confidence.scoreOf({ usedOn: { labelAdjacent: true, candidates: 2 } }).score === 30);

  check('★値引きで検算省略なら減点',
    confidence.scoreOf({ discountSkipped: true }).score === 0);

  check('スコアは 0 未満にならない',
    confidence.scoreOf({ discountSkipped: true }).score >= 0);

  check('高しきい値以上は「高」',
    confidence.levelOf(120) === CONFIDENCE_LEVEL.HIGH);
  check('中しきい値以上は「中」',
    confidence.levelOf(60) === CONFIDENCE_LEVEL.MEDIUM);
  check('それ未満は「低」',
    confidence.levelOf(59) === CONFIDENCE_LEVEL.LOW);

  check('★Gemini の自己申告値を受け取る口が無い',
    !JSON.stringify(confidence.POINTS).includes('confidence'));

  check('★経路（Gemini 未使用）による加点を持たない',
    !JSON.stringify(confidence.POINTS).toLowerCase().includes('unused'));

  /* ---------------------------------------------------------------- */
  section('§11 Gemini 補完の要否');

  const confirmed = {
    usedOn: { confirmed: true, value: '2026-08-01' },
    payee: { confirmed: true, value: 'A' },
    totalAmount: { confirmed: true, value: 1200, candidates: 1 },
    tax: {},
    phoneNumber: { value: null },
    receiptNumber: { value: null },
  };

  const okValidation = { amount: { ok: true }, date: { ok: true } };

  check('全部確定していれば補完は要らない',
    policy.needsCompletion(confirmed, okValidation).needed === false);

  check('利用日が未確定なら補完が要る',
    policy.needsCompletion({ ...confirmed, usedOn: { confirmed: false } }, okValidation).needed === true);

  check('支払先が未確定なら補完が要る',
    policy.needsCompletion({ ...confirmed, payee: { confirmed: false } }, okValidation).needed === true);

  check('★合計金額の候補が複数なら補完が要る',
    policy.needsCompletion(
      { ...confirmed, totalAmount: { confirmed: false, candidates: 2 } },
      okValidation,
    ).reasons.some((r) => r.includes('候補が複数')));

  check('金額検証に落ちたら補完が要る',
    policy.needsCompletion(confirmed, { amount: { ok: false }, date: { ok: true } }).needed === true);

  check('★日付が読めているのに検証で落ちたら矛盾とみなす',
    policy.needsCompletion(confirmed, { amount: { ok: true }, date: { ok: false } }).needed === true);

  check('★税額が合計を超えていたら矛盾とみなす',
    policy.needsCompletion(
      { ...confirmed, tax: { taxTotal: 99999 } },
      okValidation,
    ).needed === true);

  check('★電話番号とレシートNo.が同じなら矛盾とみなす',
    policy.needsCompletion(
      { ...confirmed, phoneNumber: { value: '0312345678' }, receiptNumber: { value: '0312345678' } },
      okValidation,
    ).needed === true);

  /* ---------------------------------------------------------------- */
  section('§11 補完しない条件（順序に意味がある）');

  const needy = { ...confirmed, usedOn: { confirmed: false } };

  check('補完不要なら実行しない',
    policy.decideCompletion({ extracted: confirmed, validation: okValidation, ocrText: 'x'.repeat(100), hasApiKey: true }).run === false);

  {
    /* ★OCR が短ければ、キーがあっても補完しない（誤補完の防止）。 */
    const result = policy.decideCompletion({
      extracted: needy,
      validation: okValidation,
      ocrText: '短い',
      hasApiKey: true,
      geminiEnabled: true,
    });

    check('★OCRが30文字未満なら補完しない', result.run === false);
    check('★理由は ocr-too-short', result.reason === policy.SKIP_REASON.OCR_TOO_SHORT);
    check('★要確認にする', result.needsReview === true);
  }

  {
    const result = policy.decideCompletion({
      extracted: needy, validation: okValidation, ocrText: 'x'.repeat(100),
      hasApiKey: true, geminiEnabled: false,
    });

    check('設定で停止していれば補完しない', result.run === false);
    check('理由は disabled', result.reason === policy.SKIP_REASON.DISABLED);
    check('要確認にする', result.needsReview === true);
  }

  {
    /* v2.0 §4：キー未設定はスキップして要確認のまま残す。 */
    const result = policy.decideCompletion({
      extracted: needy, validation: okValidation, ocrText: 'x'.repeat(100), hasApiKey: false,
    });

    check('★キー未設定なら補完をスキップする', result.run === false);
    check('★理由は no-api-key', result.reason === policy.SKIP_REASON.NO_API_KEY);
    check('★要確認のまま残す', result.needsReview === true);
  }

  check('条件が揃えば実行する',
    policy.decideCompletion({
      extracted: needy, validation: okValidation, ocrText: 'x'.repeat(100), hasApiKey: true,
    }).run === true);

  /* ---------------------------------------------------------------- */
  section('v2.0 §8 保存前確認画面');

  {
    const model = review.buildReviewModel({
      values: { usedOn: '2026-08-01', payee: '株式会社サンプル', totalAmount: 1200 },
      confidenceLevel: CONFIDENCE_LEVEL.HIGH,
    });

    check('項目が並ぶ', model.rows.length === review.REVIEW_FIELDS.length);
    check('見出しは列定義から取る',
      model.rows.find((r) => r.key === 'totalAmount').label === '合計金額');
    check('値が入る', model.rows.find((r) => r.key === 'payee').value === '株式会社サンプル');
    check('信頼度が高ければ強調しない', model.highlightCount === 0);
  }

  {
    /* ★必須項目が空なら強調する。 */
    const model = review.buildReviewModel({
      values: { usedOn: '', payee: '株式会社サンプル', totalAmount: 1200 },
      confidenceLevel: CONFIDENCE_LEVEL.HIGH,
    });

    check('★欠けた必須項目を強調する',
      model.rows.find((r) => r.key === 'usedOn').highlight === true);
  }

  {
    /* ★突合で食い違った項目は強調し、AI 側の値も見せる。 */
    const model = review.buildReviewModel({
      values: { totalAmount: 2000 },
      reconciliation: {
        fields: { totalAmount: { status: ai.RECONCILE.CONFLICT, aiValue: '1200', needsReview: true } },
      },
      confidenceLevel: CONFIDENCE_LEVEL.HIGH,
    });

    const row = model.rows.find((r) => r.key === 'totalAmount');

    check('★食い違いを強調する', row.highlight === true);
    check('★AI 側の値も見せる（人が選べるように）', row.aiValue === '1200');
  }

  check('★信頼度が低ければ全体を強調する',
    review.buildReviewModel({
      values: { usedOn: '2026-08-01', payee: 'A', totalAmount: 1 },
      confidenceLevel: CONFIDENCE_LEVEL.LOW,
    }).highlightCount === review.REVIEW_FIELDS.length);

  /* ---------------------------------------------------------------- */
  section('v2.0 §8 手修正の優先と記録');

  {
    const before = { usedOn: '2026-08-01', payee: 'まちがい', totalAmount: 1200 };
    const result = review.applyEdits(before, { payee: 'ただしい' });

    check('★修正した値が優先される', result.values.payee === 'ただしい');
    check('修正していない値はそのまま', result.values.usedOn === '2026-08-01');
    check('修正した項目を記録する', result.changed.includes('payee'));
    check('修正ありと分かる', result.edited === true);
  }

  check('前後の空白だけの違いは修正とみなさない',
    review.applyEdits({ payee: 'A' }, { payee: '  A  ' }).edited === false);

  check('何も直さなければ修正なし',
    review.applyEdits({ payee: 'A' }, {}).edited === false);

  /* ---------------------------------------------------------------- */
  section('§15 ステータス3軸（processingStatus を持たない）');

  check('reviewStatus は3値',
    Object.keys(REVIEW_STATUS).length === 3);
  check('duplicateStatus は3値',
    Object.keys(DUPLICATE_STATUS).length === 3);
  check('extractionMethod は4値',
    Object.keys(EXTRACTION_METHOD).length === 4);

  check('★processingStatus の列を持たない',
    schema.columnIndex(schema.DATA_COLUMNS, 'processingStatus') === -1);
  check('★idempotencyKey の列を持たない',
    schema.columnIndex(schema.DATA_COLUMNS, 'idempotencyKey') === -1);
  check('★登録者（申告値）の列を持たない',
    !schema.headersOf(schema.DATA_COLUMNS).some((h) => h.includes('登録者')));

  check('ルールだけなら RULE',
    status.decideExtractionMethod({ usedRule: true }) === EXTRACTION_METHOD.RULE);
  check('AI だけなら GEMINI',
    status.decideExtractionMethod({ usedGemini: true }) === EXTRACTION_METHOD.GEMINI);
  check('両方使えば HYBRID',
    status.decideExtractionMethod({ usedRule: true, usedGemini: true }) === EXTRACTION_METHOD.HYBRID);
  check('★手修正は MANUAL（他より優先）',
    status.decideExtractionMethod({ usedRule: true, usedGemini: true, edited: true }) === EXTRACTION_METHOD.MANUAL);

  check('重複判定の結果を列の値へ移せる',
    status.toDuplicateStatus('exact') === DUPLICATE_STATUS.EXACT
    && status.toDuplicateStatus('similar') === DUPLICATE_STATUS.CANDIDATE
    && status.toDuplicateStatus('none') === DUPLICATE_STATUS.NONE);

  /* ---------------------------------------------------------------- */
  section('保存する1件の組み立て');

  {
    const built = review.buildRecord({
      values: { usedOn: '2026-08-01', payee: 'A', totalAmount: 1200 },
      edited: true,
      usedRule: true,
      usedGemini: true,
      validation: { ok: true, warnings: [] },
      confidence: { score: 150, level: CONFIDENCE_LEVEL.HIGH },
      duplicateStatus: DUPLICATE_STATUS.NONE,
      recordId: 'RCP-20260803-ABCDEF',
      imageHash: 'abc',
      original: { name: 'r.jpg', id: 'file1', url: 'https://x' },
      now: '2026-08-03 10:00:00',
    });

    check('★手修正なら extractionMethod は MANUAL',
      built.extractionMethod === EXTRACTION_METHOD.MANUAL);
    check('検証が通れば要確認にしない',
      built.reviewStatus === REVIEW_STATUS.NOT_REQUIRED);
    check('★科目確定フラグの初期値は「未確定」', built.accountConfirmed === '未確定');
    check('補完実施を記録する', built.completionUsed === '実施');
    check('信頼度スコアと区分を記録する',
      built.confidenceScore === 150 && built.confidenceLevel === CONFIDENCE_LEVEL.HIGH);
    check('原本情報を記録する',
      built.originalFileId === 'file1' && built.originalUrl === 'https://x');
  }

  check('★検証に落ちたら要確認',
    review.buildRecord({
      values: {}, validation: { ok: false, warnings: ['金額を数値として読み取れませんでした'] },
      duplicateStatus: DUPLICATE_STATUS.NONE,
    }).reviewStatus === REVIEW_STATUS.REQUIRED);

  check('★突合で食い違えば要確認',
    review.buildRecord({
      values: {}, validation: { ok: true, warnings: [] },
      reconciliation: { needsReview: true, fields: { totalAmount: { needsReview: true } } },
      duplicateStatus: DUPLICATE_STATUS.NONE,
    }).reviewStatus === REVIEW_STATUS.REQUIRED);

  check('★「要確認のまま保存」を選べる',
    review.buildRecord({
      values: {}, validation: { ok: true, warnings: [] }, keepReview: true,
      duplicateStatus: DUPLICATE_STATUS.NONE,
    }).reviewStatus === REVIEW_STATUS.REQUIRED);

  check('警告内容を1つの列にまとめる',
    review.buildRecord({
      values: {}, validation: { ok: false, warnings: ['値引きあり・検算省略'] },
      duplicateStatus: DUPLICATE_STATUS.NONE,
    }).warnings.includes('値引き'));

  /* ---------------------------------------------------------------- */
  section('§16.1 列構成（v1.3 準拠・スキーマ版 1.0）');

  check('★スキーマ版は 1.0', schema.SCHEMA_VERSION === '1.0');
  check('★ドラフト表記が残っていない', !schema.SCHEMA_VERSION.includes('draft'));
  check('列数は 34', schema.DATA_COLUMNS.length === 34);

  check('先頭は管理ID', schema.DATA_COLUMNS[0].header === '管理ID');
  check('末尾は更新日時',
    schema.DATA_COLUMNS[schema.DATA_COLUMNS.length - 1].header === '更新日時');

  check('★v1.3 の並び（利用日→支払先→電話番号）を保つ',
    schema.columnIndex(schema.DATA_COLUMNS, 'usedOn') + 1 === schema.columnIndex(schema.DATA_COLUMNS, 'payee')
    && schema.columnIndex(schema.DATA_COLUMNS, 'payee') + 1 === schema.columnIndex(schema.DATA_COLUMNS, 'phoneNumber'));

  check('★8％が10％より先（v1.3 M2〜M5 の順）',
    schema.columnIndex(schema.DATA_COLUMNS, 'tax8Base')
      < schema.columnIndex(schema.DATA_COLUMNS, 'tax10Base'));

  check('金額列は数値として書く指定がある',
    schema.columnOf(schema.DATA_COLUMNS, 'totalAmount').kind === 'number');

  check('OCR原文タブは 管理ID / OCR原文 / 保存日時（v1.3 §16.2）',
    JSON.stringify(schema.headersOf(schema.OCR_TEXT_COLUMNS))
      === JSON.stringify(['管理ID', 'OCR原文', '保存日時']));

  check('店舗マスタは7列（v1.3 §16.3）',
    schema.STORE_MASTER_COLUMNS.length === 7);

  check('★店舗マスタに電話番号列がある（照合の最優先キー）',
    schema.columnIndex(schema.STORE_MASTER_COLUMNS, 'phoneNumber') >= 0);

  check('設定の既定値に OCR文字数の最低基準 30 がある（v1.3 §11）',
    schema.DEFAULT_SETTINGS.some((row) => row[0] === schema.SETTINGS_KEYS.minOcrLength && row[1] === 30));

  check('v1.3 の列レター対応表を残している',
    schema.COLUMN_MAP_NOTE.L === 'M' && schema.COLUMN_MAP_NOTE.M2 === 'O');

  /* ---------------------------------------------------------------- */
  section('管理ID と行の組み立て');

  check('★管理IDは RCP-YYYYMMDD-6文字',
    /^RCP-\d{8}-[0-9A-Z]{6}$/.test(record.newRecordId(NOW, () => 0.5)));

  {
    const row = record.toDataRow({ totalAmount: '1,200', payee: 'A' });

    check('★金額列は数値で書く',
      row[schema.columnIndex(schema.DATA_COLUMNS, 'totalAmount')] === 1200);
    check('文字列列はそのまま',
      row[schema.columnIndex(schema.DATA_COLUMNS, 'payee')] === 'A');
    check('列数が定義と一致', row.length === 34);
  }

  check('★読めなかった金額は空欄（0にしない）',
    record.toDataRow({ totalAmount: '1.5' })[schema.columnIndex(schema.DATA_COLUMNS, 'totalAmount')] === '');

  /* ---------------------------------------------------------------- */
  section('抽出→検証→信頼度の通し');

  {
    const OCR = [
      '株式会社サンプル商事',
      'TEL 03-1234-5678',
      '取引日 2026年8月1日',
      '10%対象 ¥1,100',
      '10%消費税 ¥100',
      '合計 ¥1,100',
    ].join('\n');

    const extracted = extract.extractAll(OCR);
    const values = { ...extract.toValues(extracted), originalUrl: 'https://x' };
    const result = validate.validateAll(values, { lines: extracted.lines, tax: extracted.tax, now: NOW });

    check('検証を通る', result.ok === true);

    const score = confidence.scoreOf({
      usedOn: extracted.usedOn,
      totalAmount: extracted.totalAmount,
      payee: extracted.payee,
      taxConsistent: result.amount.taxConsistent,
    });

    check('ラベル近接と候補1件と税額整合で加点される', score.score >= 130);
    check('信頼度は「高」', confidence.levelOf(score.score) === CONFIDENCE_LEVEL.HIGH);
    check('この状態なら補完は不要',
      policy.needsCompletion(extracted, result).needed === false);
  }

  {
    /* ★誤読系の通し：お預りを合計と取り違えたら、検証で止まるべき。 */
    const OCR = [
      'まるまるマート',
      'ポイント失効日 2027年3月31日',
      '合計 ¥1,200',
      'お預り ¥2,000',
    ].join('\n');

    const extracted = extract.extractAll(OCR);
    const values = { ...extract.toValues(extracted), originalUrl: 'https://x' };
    const result = validate.validateAll(values, { lines: extracted.lines, tax: extracted.tax, now: NOW });

    check('★合計は 1200（お預りに引きずられない）', extracted.totalAmount.value === 1200);
    check('★ラベルの無い未来日を利用日にしない', extracted.usedOn.value === null);
    check('必須項目が欠けるので検証に落ちる', result.ok === false);
    check('★この状態は補完が要る', policy.needsCompletion(extracted, result).needed === true);
    check('保存すれば要確認になる',
      review.buildRecord({ values, validation: result, duplicateStatus: DUPLICATE_STATUS.NONE }).reviewStatus
        === REVIEW_STATUS.REQUIRED);
  }

  finish();
} catch (error) {
  fatal(error);
}

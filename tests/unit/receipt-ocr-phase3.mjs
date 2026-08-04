/*
 * 領収書スキャナ フェーズ3（Gemini補完）の検証。
 * 対象仕様: docs/specs/receipt-ocr-v2.md
 *
 * 見るもの:
 *   §7 12.2〜12.5  独立抽出・Structured Output・サニタイズ・リトライ1回・
 *                  confidence不使用・evidence必須
 *   §13            evidence照合（OCR原文に実在しない値は不採用）
 *   §5-⑦          ブラウザ内での突合
 *   §12            KEY-001 / KEY-002 / AI-002
 *
 * ------------------------------------------------------------------
 * Gemini の応答はすべてスタブする
 * ------------------------------------------------------------------
 * fetch を偽物に差し替え、実際の API とは通信しない。
 * ここに出てくる 'AIzaTESTKEYNOTREAL' は形だけの文字列であり、実キーではない。
 * ------------------------------------------------------------------
 *
 * 補完の要否判定（v1.3 §11）は v1.3 が未提供のため対象外。
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

let fetchLog = [];
let fetchHandler = null;

globalThis.fetch = async (url, options = {}) => {
  fetchLog.push({
    url: String(url),
    method: options.method ?? 'GET',
    headers: options.headers ?? {},
    body: options.body ?? null,
  });

  const response = fetchHandler ? await fetchHandler(String(url), options, fetchLog.length) : { status: 200, body: {} };

  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    json: async () => response.body ?? {},
    text: async () => response.text ?? '',
  };
};

function resetFetch(handler) {
  fetchLog = [];
  fetchHandler = handler;
}

/* Gemini の応答をそれらしい形で包む。 */
function geminiReply(payload) {
  return {
    status: 200,
    body: { candidates: [{ content: { parts: [{ text: typeof payload === 'string' ? payload : JSON.stringify(payload) }] } }] },
  };
}

const KEY = 'AIzaTESTKEYNOTREAL';

try {
  const ai = await import('../../public/production-app/receipt-ocr/ai-complete.js');
  const schema = await import('../../public/production-app/receipt-ocr/schema.js');

  const { RECONCILE, reconcileField, reconcile, evidenceExists, sanitizeText, parseResponse } = ai;

  const OCR = [
    '領収書',
    'セブンイレブン 大手町店',
    'TEL 03-1234-5678',
    '2026年8月1日',
    '合計 ¥1,200',
    'お預り ¥2,000',
    'お釣り ¥800',
    'レシートNo. 0001',
    'T1234567890123',
  ].join('\n');

  /* ================================================================ */
  section('§7 独立抽出（ルール候補をプロンプトに含めない）');

  {
    const prompt = ai.buildPrompt(OCR);

    check('OCR原文はプロンプトに入る', prompt.includes('セブンイレブン 大手町店'));

    check('buildPrompt は引数を1つしか取らない（候補を渡す口が無い）',
      ai.buildPrompt.length === 1);

    /* ルール候補を渡そうとしても、入る場所が無いことを確かめる。 */
    const withCandidates = ai.buildPrompt(OCR, { payee: 'ローソン', totalAmount: '9999' });

    check('第2引数を渡しても候補は混ざらない',
      !withCandidates.includes('ローソン') && !withCandidates.includes('9999'));

    /* v1.3 §12.4 のプロンプト要件。 */
    check('事実のみを求める指示が入っている', prompt.includes('事実として読み取れる情報のみ'));
    check('推測での補完を禁じる指示が入っている', prompt.includes('金額を推測で補完しないでください'));
    check('不明な項目の扱いを指示している', prompt.includes('不明な項目'));
    check('根拠を原文から写す指示が入っている', prompt.includes('実際に現れる部分'));
    check('§12.4 の抽出項目を列挙している',
      ['支払先', '利用日', '合計金額', '支払方法', 'レシートNo.', '電話番号', '勘定科目候補', '摘要']
        .every((item) => prompt.includes(item)));
  }

  /* ---------------------------------------------------------------- */
  section('§7 Structured Output（evidence 必須・confidence なし）');

  {
    const s = ai.responseSchema();

    check('全項目が required', s.required.length === ai.COMPLETION_FIELDS.length);

    check('各項目は value と evidence の対',
      ai.COMPLETION_FIELDS.every((f) =>
        JSON.stringify(s.properties[f].required) === JSON.stringify(['value', 'evidence'])));

    check('confidence を要求しない',
      !JSON.stringify(s).includes('confidence'));

    check('補完項目は列定義に存在するキーだけ',
      ai.COMPLETION_FIELDS.every((f) => schema.columnIndex(schema.DATA_COLUMNS, f) >= 0));
  }

  {
    resetFetch(async () => geminiReply({
      usedOn: { value: '2026-08-01', evidence: '2026年8月1日' },
      payee: { value: 'セブンイレブン 大手町店', evidence: 'セブンイレブン 大手町店' },
      totalAmount: { value: '1200', evidence: '合計 ¥1,200' },
      receiptNumber: { value: '0001', evidence: 'レシートNo. 0001' },
      phoneNumber: { value: '03-1234-5678', evidence: 'TEL 03-1234-5678' },
      registrationNumber: { value: 'T1234567890123', evidence: 'T1234567890123' },
      paymentMethod: { value: '', evidence: '' },
      addressee: { value: '', evidence: '' },
      note: { value: '', evidence: '' },
    }));

    const result = await ai.complete({ apiKey: KEY, ocrText: OCR });

    check('応答を項目ごとに読める', result.totalAmount.value === '1200');

    const sent = JSON.parse(fetchLog[0].body);

    check('Structured Output を要求している',
      sent.generationConfig.responseMimeType === 'application/json'
      && Boolean(sent.generationConfig.responseSchema));

    check('温度を 0 にしている', sent.generationConfig.temperature === 0);

    check('キーはヘッダーで送る', fetchLog[0].headers['x-goog-api-key'] === KEY);
    check('キーを URL に載せない', !fetchLog[0].url.includes('AIza'));
  }

  /* ---------------------------------------------------------------- */
  section('§7 サニタイズ');

  {
    /* 制御文字はコードから組み立てる。実体で書くとこのファイルが壊れる。 */
    const withControl = ['a', String.fromCharCode(0), 'b', String.fromCharCode(31), 'cd'].join('');

    check('制御文字を落とす', sanitizeText(withControl) === 'abcd');
  }

  check('改行とタブも落とす', sanitizeText('a\nb\tc') === 'abc');
  check('前後の空白を落とす', sanitizeText('  値  ') === '値');
  check('長すぎる値は切る', sanitizeText('あ'.repeat(500)).length === 200);
  check('文字列でなければ空文字', sanitizeText(null) === '' && sanitizeText(123) === '');

  check('壊れた JSON は null（例外にしない）',
    parseResponse('{壊れている') === null);

  check('配列を返されても null', parseResponse('[1,2]') === null);

  check('項目が object でなければ空の対に落とす',
    parseResponse(JSON.stringify({ usedOn: 'ただの文字列' })).usedOn.value === '');

  check('知らない項目は取り込まない',
    parseResponse(JSON.stringify({ 悪意: { value: 'x', evidence: 'x' } })).悪意 === undefined);

  /* ---------------------------------------------------------------- */
  section('§13 evidence 照合（原文に実在しない値は不採用）');

  check('原文にある根拠は通る', evidenceExists('合計 ¥1,200', OCR) === true);
  check('空白の入り方が違っても通る', evidenceExists('合計¥1,200', OCR) === true);
  check('原文に無い根拠は通さない', evidenceExists('合計 ¥9,999', OCR) === false);
  check('空の根拠は通さない', evidenceExists('', OCR) === false);
  check('空白だけの根拠も通さない', evidenceExists('   ', OCR) === false);

  {
    /* 幻覚：原文に無い金額を、それらしい根拠付きで返してきた場合。 */
    const result = reconcileField({
      ruleValue: '',
      ai: { value: '9999', evidence: '合計 ¥9,999' },
      ocrText: OCR,
    });

    check('根拠が原文に無ければ採用しない', result.status === RECONCILE.REJECTED);
    check('値を空のままにする', result.value === '');
    check('要確認にする', result.needsReview === true);
  }

  {
    /* ルール側に値があり、AI の根拠が確かめられない場合はルールを残す。 */
    const result = reconcileField({
      ruleValue: '1200',
      ai: { value: '9999', evidence: '存在しない根拠' },
      ocrText: OCR,
    });

    check('ルールの値は残る', result.value === '1200');
    check('AI の値は採らない', result.status === RECONCILE.REJECTED);
    check('ルールが読めているので要確認にしない', result.needsReview === false);
  }

  /* ---------------------------------------------------------------- */
  section('§5-⑦ 突合');

  check('一致したら採用する',
    reconcileField({ ruleValue: '1200', ai: { value: '1200', evidence: '合計 ¥1,200' }, ocrText: OCR }).status
      === RECONCILE.AGREED);

  check('空白差は一致とみなす',
    reconcileField({ ruleValue: '03-1234-5678', ai: { value: '03-1234-5678 ', evidence: 'TEL 03-1234-5678' }, ocrText: OCR }).status
      === RECONCILE.AGREED);

  /* ---------------------------------------------------------------- */
  section('§5-⑦ 書き方の違いを食い違いと呼ばない（2026-08-04 実機）');

  {
    /*
     * ★実機で出た誤判定。
     * ルールはハイフン無し、AI はハイフン付きで同じ番号を返す。
     */
    const PHONE_OCR = 'TEL 070-1240-0971';
    const result = reconcileField({
      ruleValue: '07012400971',
      ai: { value: '070-1240-0971', evidence: 'TEL 070-1240-0971' },
      ocrText: PHONE_OCR,
      field: 'phoneNumber',
    });

    check('★電話番号のハイフン差を一致とみなす', result.status === RECONCILE.AGREED);
    check('★要確認にしない', result.needsReview === false);
    check('シートにはルール側の書き方を残す', result.value === '07012400971');
  }

  check('★金額の桁区切りと通貨記号の差を一致とみなす',
    reconcileField({
      ruleValue: '1200',
      ai: { value: '¥1,200', evidence: '合計 ¥1,200' },
      ocrText: OCR,
      field: 'totalAmount',
    }).status === RECONCILE.AGREED);

  check('★日付の書式差を一致とみなす',
    reconcileField({
      ruleValue: '2026-08-01',
      ai: { value: '2026年8月1日', evidence: '2026年8月1日' },
      ocrText: OCR,
      field: 'usedOn',
    }).status === RECONCILE.AGREED);

  check('★登録番号のハイフン差を一致とみなす',
    reconcileField({
      ruleValue: 'T1234567890123',
      ai: { value: 'T-1234567890123', evidence: 'T1234567890123' },
      ocrText: OCR,
      field: 'registrationNumber',
    }).status === RECONCILE.AGREED);

  check('★レシートNo.の空白差を一致とみなす',
    reconcileField({
      ruleValue: '0001',
      ai: { value: ' 0001 ', evidence: 'レシートNo. 0001' },
      ocrText: OCR,
      field: 'receiptNumber',
    }).status === RECONCILE.AGREED);

  /* 正規化しても値が違えば、きちんと食い違いとして扱う。 */
  check('別の電話番号は食い違いのまま',
    reconcileField({
      ruleValue: '07012400971',
      ai: { value: '070-9999-9999', evidence: 'TEL 070-1240-0971' },
      ocrText: 'TEL 070-1240-0971',
      field: 'phoneNumber',
    }).status === RECONCILE.CONFLICT);

  check('別の金額は食い違いのまま',
    reconcileField({
      ruleValue: '2000',
      ai: { value: '¥1,200', evidence: '合計 ¥1,200' },
      ocrText: OCR,
      field: 'totalAmount',
    }).status === RECONCILE.CONFLICT);

  check('★T の有無は意味が違うので一致にしない',
    reconcileField({
      ruleValue: 'T1234567890123',
      ai: { value: '1234567890123', evidence: 'T1234567890123' },
      ocrText: OCR,
      field: 'registrationNumber',
    }).status === RECONCILE.CONFLICT);

  {
    /* 比較用の正規化を直接見る。 */
    check('金額は数値へ寄せて比べる',
      ai.comparableValue('totalAmount', '¥1,200') === '1200'
      && ai.comparableValue('totalAmount', '1200') === '1200');

    check('日付は YYYY-MM-DD へ寄せて比べる',
      ai.comparableValue('usedOn', '2026年8月1日') === '2026-08-01'
      && ai.comparableValue('usedOn', '2026/08/01') === '2026-08-01');

    check('電話番号は記号を落として比べる',
      ai.comparableValue('phoneNumber', '070-1240-0971') === '07012400971');

    check('★支払先は記号を落とさない（店名の一部でありうる）',
      ai.comparableValue('payee', '株式会社サンプル-商事') === '株式会社サンプル-商事');

    check('読めない金額は文字列として比べる（取り違えない）',
      ai.comparableValue('totalAmount', '約1000') === '約1000');
  }

  check('全項目の突合でも項目ごとの正規化が効く',
    reconcile({
      ruleValues: { phoneNumber: '07012400971', totalAmount: '1200' },
      aiValues: {
        phoneNumber: { value: '070-1240-0971', evidence: 'TEL 070-1240-0971' },
        totalAmount: { value: '¥1,200', evidence: '合計 ¥1,200' },
      },
      ocrText: `${OCR}\nTEL 070-1240-0971`,
    }).needsReview === false);

  {
    /* ルールが読めなかった項目を AI が埋める。これが「補完」。 */
    const result = reconcileField({
      ruleValue: '',
      ai: { value: '0001', evidence: 'レシートNo. 0001' },
      ocrText: OCR,
    });

    check('ルールが空なら AI の値で埋める', result.status === RECONCILE.FILLED);
    check('埋めた値が入る', result.value === '0001');
    check('出所が AI だと分かる', result.source === 'ai');
    check('埋めただけでは要確認にしない', result.needsReview === false);
  }

  {
    /*
     * 食い違い。お預り 2,000 を合計と取り違えた場合を想定する。
     * どちらも自動では採らない（§15.1「誤った値を高信頼で提示 0件」）。
     */
    const result = reconcileField({
      ruleValue: '2000',
      ai: { value: '1200', evidence: '合計 ¥1,200' },
      ocrText: OCR,
    });

    check('食い違いは conflict', result.status === RECONCILE.CONFLICT);
    check('要確認にする', result.needsReview === true);
    check('AI 側の値も残して人に見せる', result.aiValue === '1200');
    check('自動でどちらかに確定しない', result.value === '2000' && result.aiValue === '1200');
  }

  check('どちらも空なら empty',
    reconcileField({ ruleValue: '', ai: { value: '', evidence: '合計 ¥1,200' }, ocrText: OCR }).status
      === RECONCILE.EMPTY);

  check('AI の応答が無くてもルールの値は残る',
    reconcileField({ ruleValue: '1200', ai: null, ocrText: OCR }).value === '1200');

  {
    const result = reconcile({
      ruleValues: { totalAmount: '2000', payee: 'セブンイレブン 大手町店' },
      aiValues: {
        totalAmount: { value: '1200', evidence: '合計 ¥1,200' },
        payee: { value: 'セブンイレブン 大手町店', evidence: 'セブンイレブン 大手町店' },
      },
      ocrText: OCR,
    });

    check('項目ごとの結果が並ぶ',
      result.fields.totalAmount.status === RECONCILE.CONFLICT
      && result.fields.payee.status === RECONCILE.AGREED);

    check('1つでも食い違えば全体を要確認にする', result.needsReview === true);
  }

  check('全項目そろって一致すれば要確認にしない',
    reconcile({
      ruleValues: { payee: 'セブンイレブン 大手町店' },
      aiValues: { payee: { value: 'セブンイレブン 大手町店', evidence: 'セブンイレブン 大手町店' } },
      ocrText: OCR,
    }).needsReview === false);

  /* ---------------------------------------------------------------- */
  section('§7 リトライは1回だけ');

  {
    let calls = 0;

    resetFetch(async () => {
      calls += 1;
      return calls === 1 ? geminiReply('{壊れている') : geminiReply({ usedOn: { value: '2026-08-01', evidence: '2026年8月1日' } });
    });

    const result = await ai.complete({ apiKey: KEY, ocrText: OCR, fields: ['usedOn'] });

    check('壊れた応答なら1回だけやり直す', calls === 2);
    check('やり直しで読めれば採る', result.usedOn.value === '2026-08-01');
  }

  {
    let calls = 0;

    resetFetch(async () => {
      calls += 1;
      return geminiReply('こわれたまま');
    });

    const result = await ai.complete({ apiKey: KEY, ocrText: OCR, fields: ['usedOn'] });

    check('2回とも読めなければ諦める（3回目を試さない）', calls === 2);
    check('補完なしとして null を返す', result === null);
  }

  /* ---------------------------------------------------------------- */
  section('§12 KEY / AI 系のエラー');

  {
    /* 直前の節の記録が残っていると「呼んでいない」を見誤る。ここで空にする。 */
    resetFetch(null);

    let thrown = null;

    try {
      await ai.complete({ apiKey: '', ocrText: OCR });
    } catch (error) {
      thrown = error;
    }

    check('キー未設定は KEY-001', thrown?.code === 'KEY-001');
    check('原本は保存済みだと伝える', thrown?.progress === 'original-saved');
    check('キーが無いときは呼び出しを行わない', fetchLog.length === 0);
  }

  {
    resetFetch(async () => ({ status: 403, body: {} }));

    let thrown = null;

    try {
      await ai.complete({ apiKey: KEY, ocrText: OCR });
    } catch (error) {
      thrown = error;
    }

    check('キーが無効・権限不足は KEY-002', thrown?.code === 'KEY-002');
  }

  {
    resetFetch(async () => ({ status: 429, body: {} }));

    let thrown = null;

    try {
      await ai.complete({ apiKey: KEY, ocrText: OCR });
    } catch (error) {
      thrown = error;
    }

    check('クォータ超過は AI-002', thrown?.code === 'AI-002');
  }

  {
    resetFetch(async () => ({ status: 403, body: {} }));

    try {
      await ai.complete({ apiKey: KEY, ocrText: OCR });
    } catch {
      /* 失敗しても、別のキーで再試行しないことを見たい。 */
    }

    check('会社キーへフォールバックしない（呼び出しは1回）', fetchLog.length === 1);
    check('宛先は Gemini API のみ',
      fetchLog.every((call) => call.url.startsWith('https://generativelanguage.googleapis.com/')));
  }

  finish();
} catch (error) {
  fatal(error);
}

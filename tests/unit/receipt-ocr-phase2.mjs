/*
 * 領収書スキャナ フェーズ2のうち、v2.0 が単独で規定している部分の検証。
 * 対象仕様: docs/specs/receipt-ocr-v2.md
 *
 * 見るもの:
 *   §0.2 / §6  OCRエンジンの差し替え（案A / 案C）
 *   §9.5       OCR一時ドキュメントの即時削除
 *   §10        重複判定（完全一致・類似・レシートNo.による除外）
 *   §13        数式インジェクション対策込みの行の組み立て
 *   §5-⑨      シート保存の順序
 *   §12        Gemini 側のエラー分類とモデルの404フォールバック1回
 *
 * ------------------------------------------------------------------
 * 実通信を行わない
 * ------------------------------------------------------------------
 * fetch は偽物へ差し替える。実キー・実トークンは登場しない。
 * ここで使う 'test-key' 等は、形だけの文字列である。
 * ------------------------------------------------------------------
 *
 * ルール抽出（v1.3 §10）と信頼度スコアリング（v1.3 §13〜14）は
 * v1.3 が未提供のため、このスイートの対象外である。
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

/* ---------- fetch の偽物 ---------- */

let fetchLog = [];
let fetchHandler = null;

globalThis.fetch = async (url, options = {}) => {
  /*
   * 本文も控える（2026-08-18 追加）。multipart の boundary と
   * 一時ドキュメントの名前を確かめるために要る。
   */
  let body = '';

  if (typeof options.body === 'string') {
    body = options.body;
  } else if (options.body && typeof options.body.text === 'function') {
    body = await options.body.text();
  }

  fetchLog.push({
    url: String(url),
    method: options.method ?? 'GET',
    headers: options.headers ?? {},
    body,
  });

  const response = fetchHandler
    ? await fetchHandler(String(url), options)
    : { status: 200, body: {} };

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

try {
  const duplicate = await import('../../public/production-app/receipt-ocr/duplicate.js');
  const record = await import('../../public/production-app/receipt-ocr/record.js');
  const schema = await import('../../public/production-app/receipt-ocr/schema.js');
  const ocr = await import('../../public/production-app/receipt-ocr/ocr.js');
  const ocrDrive = await import('../../public/production-app/receipt-ocr/ocr-drive.js');
  const ocrGemini = await import('../../public/production-app/receipt-ocr/ocr-gemini.js');
  const gemini = await import('../../public/production-app/receipt-ocr/gemini-client.js');
  const sheets = await import('../../public/production-app/receipt-ocr/sheets.js');
  const config = await import('../../public/production-app/receipt-ocr/config.js');

  const { DUPLICATE_KIND, evaluateDuplicate, describeDuplicate, toRows } = duplicate;

  /* ================================================================ */
  section('§0.2 / §6 OCRエンジンの差し替え');

  check('案A（drive）と案C（gemini）の両方が登録されている',
    Boolean(ocr.ENGINES.drive) && Boolean(ocr.ENGINES.gemini));

  check('2つのエンジンが同じ形の窓口を持つ',
    typeof ocr.ENGINES.drive.recognize === 'function'
    && typeof ocr.ENGINES.gemini.recognize === 'function'
    && typeof ocr.ENGINES.drive.requiresApiKey === 'boolean'
    && typeof ocr.ENGINES.gemini.requiresApiKey === 'boolean');

  check('切り替えは静的設定 1か所（config.OCR_ENGINE）',
    ocr.activeEngine(config.OCR_ENGINE).ENGINE_ID === config.OCR_ENGINE);

  check('案A はキー不要（§4 末尾）', ocr.requiresApiKey('drive') === false);
  check('案C はキー必須（§0.2 の表）', ocr.requiresApiKey('gemini') === true);

  check('設定が壊れていても落ちず案Aへ寄せる',
    ocr.activeEngine('存在しない').ENGINE_ID === 'drive');

  {
    /* 案Cを選びキーが無ければ KEY-001。会社キーへ落とさない（§13）。 */
    let thrown = null;

    try {
      await ocr.recognize({ blob: new Blob(['x']), apiKey: '', engineId: 'gemini' });
    } catch (error) {
      thrown = error;
    }

    check('案C でキー未設定なら KEY-001 で止まる', thrown?.code === 'KEY-001');
  }

  /* ---------------------------------------------------------------- */
  section('§9.5 案A：一時ドキュメントを必ず消す');

  {
    resetFetch(async (url, options) => {
      if (options.method === 'POST' && url.includes('/upload/')) {
        return { status: 200, body: { id: 'tmpdoc1' } };
      }

      if (url.includes('/export')) {
        return { status: 200, text: '領収書\n合計 1,200円' };
      }

      return { status: 204, body: null };
    });

    const result = await ocrDrive.recognize({
      blob: new Blob(['image'], { type: 'image/jpeg' }),
      accessToken: 'token-for-test',
      displayName: 'r.jpg',
    });

    check('読み取った文字を返す', result.text.includes('1,200'));
    check('エンジン名を添える', result.engine === 'drive');

    check('変換時に日本語を指定する',
      fetchLog.some((call) => call.url.includes('ocrLanguage=ja')));

    check('Googleドキュメントとして上げる（＝OCRが走る）',
      fetchLog.some((call) => call.method === 'POST' && call.url.includes('/upload/')));

    check('一時ドキュメントを DELETE する',
      fetchLog.some((call) => call.method === 'DELETE' && call.url.includes('tmpdoc1')));

    check('共有設定を行わない',
      fetchLog.every((call) => !/permissions/i.test(call.url)));
  }

  {
    /* 取得が失敗しても削除は実行する（finally）。 */
    resetFetch(async (url, options) => {
      if (options.method === 'POST' && url.includes('/upload/')) {
        return { status: 200, body: { id: 'tmpdoc2' } };
      }

      if (url.includes('/export')) {
        return { status: 500, body: {} };
      }

      return { status: 204, body: null };
    });

    let thrown = null;

    try {
      await ocrDrive.recognize({ blob: new Blob(['x']), accessToken: 'token-for-test' });
    } catch (error) {
      thrown = error;
    }

    check('取得に失敗すると例外になる', thrown !== null);
    check('失敗しても一時ドキュメントは消す',
      fetchLog.some((call) => call.method === 'DELETE' && call.url.includes('tmpdoc2')));
  }

  /* ---------------------------------------------------------------- */
  section('§9.5 一時ドキュメントの名前と boundary（findings #6・#7）');

  {
    const uploads = [];

    resetFetch(async (url, options) => {
      if (options.method === 'POST' && url.includes('/upload/')) {
        uploads.push(String(options.headers?.['Content-Type'] ?? ''));
        return { status: 200, body: { id: `tmpdoc-${uploads.length}` } };
      }

      if (url.includes('/export')) {
        return { status: 200, text: '合計 500円' };
      }

      return { status: 204, body: null };
    });

    const first = await ocrDrive.recognize({
      blob: new Blob(['image'], { type: 'image/jpeg' }),
      accessToken: 'token-for-test',
      displayName: '領収書_2026-08.jpg',
    });

    const uploadCall = fetchLog.find((call) => call.method === 'POST' && call.url.includes('/upload/'));

    check('一時ドキュメントは固定の接頭辞で名付ける',
      uploadCall.body.includes(ocrDrive.TEMP_DOC_PREFIX));

    check('**利用者のファイル名を一時ドキュメント名に入れない**',
      !uploadCall.body.includes('領収書_2026-08'));

    check('削除できたことを戻り値で伝える（握りつぶさない）', first.deleted === true);

    /* boundary は内容から決めない（findings #7）。 */
    const boundary = uploads[0].replace('multipart/related; boundary=', '');

    check('boundary は乱数由来（内容から決めない）',
      boundary.startsWith('tsam-') && boundary.length > 20);

    /* 改訂前は `ocr-<サイズ>-<MIMEの長さ>` だった。この形に戻さない。 */
    check('boundary を内容から組み立てた形にしない',
      !/^ocr-\d+-\d+$/.test(boundary));

    check('boundary が本文の区切りとして使われている',
      uploadCall.body.includes(`--${boundary}`));

    await ocrDrive.recognize({
      blob: new Blob(['image'], { type: 'image/jpeg' }),
      accessToken: 'token-for-test',
    });

    check('同じ画像でも boundary は毎回変わる', uploads[0] !== uploads[1]);

    check('名前の判定は接頭辞（旧名も拾う）',
      ocrDrive.isTempDocName('receipt-ocr-tmp-1-0') === true
      && ocrDrive.isTempDocName('ocr-tmp-領収書.jpg') === true
      && ocrDrive.isTempDocName('自分のメモ') === false);

    check('名前は接頭辞＋時刻＋通し番号',
      ocrDrive.buildTempDocName(1700000000000, 2) === 'receipt-ocr-tmp-1700000000000-2');
  }

  {
    /* 削除に失敗しても例外にせず、残っていることを伝える。 */
    resetFetch(async (url, options) => {
      if (options.method === 'POST' && url.includes('/upload/')) {
        return { status: 200, body: { id: 'tmpdoc-stuck' } };
      }

      if (url.includes('/export')) {
        return { status: 200, text: '合計 500円' };
      }

      return { status: 500, body: {} };
    });

    const result = await ocrDrive.recognize({
      blob: new Blob(['image'], { type: 'image/jpeg' }),
      accessToken: 'token-for-test',
    });

    check('削除に失敗しても読み取り結果は返す', result.text.includes('500'));
    check('**消せなかったことを伝える（deleted=false）**', result.deleted === false);
  }

  {
    /* 起動時の孤児回収（findings #6）。 */
    const now = Date.UTC(2026, 7, 18, 12, 0, 0);
    const deleted = [];

    resetFetch(async (url, options) => {
      if (options.method === 'DELETE') {
        deleted.push(url);
        return { status: 204, body: null };
      }

      return {
        status: 200,
        body: {
          files: [
            { id: 'old1', name: 'receipt-ocr-tmp-1-0', createdTime: '2026-08-18T10:00:00Z' },
            { id: 'old2', name: 'ocr-tmp-領収書.jpg', createdTime: '2026-08-01T00:00:00Z' },
            { id: 'busy', name: 'receipt-ocr-tmp-2-0', createdTime: '2026-08-18T11:59:00Z' },
            { id: 'mine', name: '自分のメモ ocr-tmp- 用', createdTime: '2026-01-01T00:00:00Z' },
          ],
        },
      };
    });

    const outcome = await ocrDrive.collectOrphanTempDocs({ accessToken: 'token-for-test', now });

    check('消し損ねた一時ドキュメントを回収する', outcome.deleted === 2 && outcome.found === 2);

    check('旧名（ocr-tmp-）も回収する', deleted.some((url) => url.includes('old2')));

    check('**処理中の可能性があるもの（作成直後）は消さない**',
      outcome.skipped === 1 && !deleted.some((url) => url.includes('busy')));

    check('接頭辞で始まらない利用者のファイルは消さない',
      !deleted.some((url) => url.includes('mine')));

    {
      const query = new URL(fetchLog[0].url).searchParams.get('q') ?? '';

      check('探すのは Google ドキュメントだけ（画像や台帳を巻き込まない）',
        query.includes('vnd.google-apps.document'), query);

      check('新旧どちらの接頭辞も探す',
        query.includes(ocrDrive.TEMP_DOC_PREFIX)
        && query.includes(ocrDrive.LEGACY_TEMP_DOC_PREFIX), query);

      check('ゴミ箱の中は数えない', query.includes('trashed = false'), query);
    }
  }

  /* ---------------------------------------------------------------- */
  section('§6 / §12 Gemini：キーの送り方とエラー分類');

  /*
   * 2026-08-18 の修正（findings #3）。
   * **400 をキーの問題にしない。** 400 はこちらの要求の形が不正という意味で、
   * キーを疑わせると利用者はキーを作り直し、それでも直らないことになる。
   */
  check('**400 はキーの問題ではない（AI-003）**', gemini.mapGeminiError(400) === 'AI-003');
  check('401 はキーの問題（KEY-002）', gemini.mapGeminiError(401) === 'KEY-002');
  check('403 もキーの問題（KEY-002）', gemini.mapGeminiError(403) === 'KEY-002');
  check('429 はクォータ超過（AI-002）', gemini.mapGeminiError(429) === 'AI-002');
  check('404 はモデル不明（フォールバック対象）', gemini.mapGeminiError(404) === 'MODEL-404');
  check('503 は Google 側の一時障害（SRV-001）', gemini.mapGeminiError(503) === 'SRV-001');
  check('500 も SRV-001', gemini.mapGeminiError(500) === 'SRV-001');

  {
    resetFetch(async () => ({
      status: 200,
      body: { candidates: [{ content: { parts: [{ text: 'よみとり結果' }] } }] },
    }));

    const out = await ocrGemini.recognize({
      blob: new Blob(['image'], { type: 'image/jpeg' }),
      apiKey: 'AIzaTESTKEYNOTREAL',
    });

    check('本文を取り出せる', out.text === 'よみとり結果');

    check('キーはヘッダー（x-goog-api-key）で送る',
      fetchLog[0].headers['x-goog-api-key'] === 'AIzaTESTKEYNOTREAL');

    check('キーを URL に載せない',
      fetchLog.every((call) => !call.url.includes('AIza')));

    check('宛先は Gemini API のみ（§13）',
      fetchLog.every((call) => call.url.startsWith('https://generativelanguage.googleapis.com/')));

    check('設定したモデルを使う',
      fetchLog[0].url.includes(config.GEMINI.model));
  }

  {
    /* §6：404 のときだけ1回フォールバックする。 */
    let attempts = 0;

    resetFetch(async (url) => {
      attempts += 1;

      if (url.includes(config.GEMINI.model)) {
        return { status: 404, body: {} };
      }

      return { status: 200, body: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } };
    });

    const out = await gemini.generate({ apiKey: 'AIzaTESTKEYNOTREAL', body: {} });

    check('404 なら控えのモデルへ落ちる', out.model === config.GEMINI.fallbackModel);
    check('フォールバックは1回だけ（合計2回の呼び出し）', attempts === 2);
  }

  {
    /* 両方 404 でも、3回目は試さない。 */
    let attempts = 0;

    resetFetch(async () => {
      attempts += 1;
      return { status: 404, body: {} };
    });

    let thrown = null;

    try {
      await gemini.generate({ apiKey: 'AIzaTESTKEYNOTREAL', body: {} });
    } catch (error) {
      thrown = error;
    }

    check('両方だめなら OCR-001', thrown?.code === 'OCR-001');
    check('3回目を試さない（クォータを黙って使わない）', attempts === 2);
  }

  {
    resetFetch(async () => ({ status: 429, body: {} }));

    let thrown = null;

    try {
      await gemini.generate({ apiKey: 'AIzaTESTKEYNOTREAL', body: {} });
    } catch (error) {
      thrown = error;
    }

    check('クォータ超過は AI-002 として伝わる', thrown?.code === 'AI-002');
  }

  {
    let thrown = null;

    try {
      await gemini.generate({ apiKey: '   ', body: {} });
    } catch (error) {
      thrown = error;
    }

    check('キーが空なら KEY-001（会社キーへ落とさない）', thrown?.code === 'KEY-001');
  }

  /* ================================================================
     §10 重複判定
     ================================================================ */
  section('§10 完全一致（保存しない）');

  const existing = toRows({
    recordId: ['R001', 'R002'],
    imageHash: ['aaa111', 'bbb222'],
    usedOn: ['2026-08-01', '2026-08-02'],
    payee: ['セブンイレブン', 'ローソン'],
    totalAmount: ['1,200', '980'],
    receiptNumber: ['0001', ''],
  });

  check('列ごとの配列を行へ組み直せる',
    existing.length === 2 && existing[0].recordId === 'R001');

  check('行番号はヘッダーの次から数える',
    existing[0].rowNumber === 2 && existing[1].rowNumber === 3);

  {
    const result = evaluateDuplicate({ imageHash: 'aaa111' }, existing);
    check('同じハッシュは exact', result.kind === DUPLICATE_KIND.EXACT);
    check('既存の管理IDを返す', result.match.recordId === 'R001');

    const described = describeDuplicate(result);
    check('DUP-001 を出す', described.code === 'DUP-001');
    check('保存させない', described.canSave === false);
    check('管理IDと行を文言に含む',
      described.text.includes('R001') && described.text.includes('2行目'));
  }

  check('大文字小文字が違っても同一とみなす',
    evaluateDuplicate({ imageHash: 'AAA111' }, existing).kind === DUPLICATE_KIND.EXACT);

  check('ハッシュが無ければ完全一致の判定はしない',
    evaluateDuplicate({ imageHash: '' }, existing).kind === DUPLICATE_KIND.NONE);

  /* ---------------------------------------------------------------- */
  section('§10 類似（警告のみ・保存は利用者の判断）');

  {
    const result = evaluateDuplicate({
      imageHash: 'zzz999',
      usedOn: '2026-08-01',
      payee: 'セブンイレブン',
      totalAmount: '1200',
      receiptNumber: '',
    }, existing);

    check('同日・同店舗・同金額は similar', result.kind === DUPLICATE_KIND.SIMILAR);

    const described = describeDuplicate(result);
    check('警告のみで保存は妨げない', described.canSave === true);
    check('DUP-001 は出さない', described.code === null);
    check('相手の管理IDを示す', described.text.includes('R001'));
  }

  check('桁区切りの有無で取り違えない',
    evaluateDuplicate({
      imageHash: 'zzz', usedOn: '2026-08-01', payee: 'セブンイレブン', totalAmount: '¥1,200',
    }, existing).kind === DUPLICATE_KIND.SIMILAR);

  check('支払先の空白差は無視する',
    evaluateDuplicate({
      imageHash: 'zzz', usedOn: '2026-08-01', payee: 'セブン イレブン', totalAmount: '1200',
    }, existing).kind === DUPLICATE_KIND.SIMILAR);

  check('金額が違えば類似ではない',
    evaluateDuplicate({
      imageHash: 'zzz', usedOn: '2026-08-01', payee: 'セブンイレブン', totalAmount: '1300',
    }, existing).kind === DUPLICATE_KIND.NONE);

  check('日付が違えば類似ではない',
    evaluateDuplicate({
      imageHash: 'zzz', usedOn: '2026-08-05', payee: 'セブンイレブン', totalAmount: '1200',
    }, existing).kind === DUPLICATE_KIND.NONE);

  check('3項目が揃わなければ類似判定をしない',
    evaluateDuplicate({ imageHash: 'zzz', usedOn: '2026-08-01', payee: '' }, existing).kind
      === DUPLICATE_KIND.NONE);

  /* ---------------------------------------------------------------- */
  section('§10 レシートNo.が両方あって異なるときは警告しない');

  check('番号が異なれば別のレシートとみなす',
    evaluateDuplicate({
      imageHash: 'zzz',
      usedOn: '2026-08-01',
      payee: 'セブンイレブン',
      totalAmount: '1200',
      receiptNumber: '0002',
    }, existing).kind === DUPLICATE_KIND.NONE);

  check('番号が同じなら警告する',
    evaluateDuplicate({
      imageHash: 'zzz',
      usedOn: '2026-08-01',
      payee: 'セブンイレブン',
      totalAmount: '1200',
      receiptNumber: '0001',
    }, existing).kind === DUPLICATE_KIND.SIMILAR);

  check('こちらの番号が無ければ（分からないので）警告する',
    evaluateDuplicate({
      imageHash: 'zzz',
      usedOn: '2026-08-01',
      payee: 'セブンイレブン',
      totalAmount: '1200',
      receiptNumber: '',
    }, existing).kind === DUPLICATE_KIND.SIMILAR);

  check('相手の番号が無ければ（分からないので）警告する',
    evaluateDuplicate({
      imageHash: 'zzz',
      usedOn: '2026-08-02',
      payee: 'ローソン',
      totalAmount: '980',
      receiptNumber: '9999',
    }, existing).kind === DUPLICATE_KIND.SIMILAR);

  check('照合に使う列は6つだけ（全列を取らない）',
    duplicate.DUPLICATE_COLUMN_KEYS.length === 6
    && !duplicate.DUPLICATE_COLUMN_KEYS.includes('note'));

  /* ================================================================
     §5-⑨ / §13 行の組み立てと保存
     ================================================================ */
  section('§13 行の組み立て（列定義の並びに従う）');

  {
    const row = record.toDataRow({ recordId: 'R1', payee: 'セブンイレブン', totalAmount: 1200 });

    check('列数が定義と一致する', row.length === schema.DATA_COLUMNS.length);

    check('値は定義された位置に入る',
      row[schema.columnIndex(schema.DATA_COLUMNS, 'payee')] === 'セブンイレブン'
      && row[schema.columnIndex(schema.DATA_COLUMNS, 'totalAmount')] === 1200);

    check('未設定の列は空文字（undefined を残さない）',
      row.every((value) => value !== undefined && value !== null));
  }

  /* v1.3 §16.1 A列：RCP-YYYYMMDD-ランダム6文字。 */
  check('管理IDは日付から作り、形が安定している',
    /^RCP-\d{8}-[0-9A-Z]{6}$/.test(record.newRecordId(new Date('2026-08-03T01:00:00Z'), () => 0.5)));

  {
    /* 危険な値が混じっても、書き込みの直前で無害化される。 */
    const row = record.toDataRow({ payee: '=HYPERLINK("http://x","x")' });
    const escaped = sheets.escapeRow(row);

    check('数式に見える値は先頭を無害化して書く',
      escaped[schema.columnIndex(schema.DATA_COLUMNS, 'payee')].startsWith("'="));

    check('無害化しても中身は削らない',
      escaped[schema.columnIndex(schema.DATA_COLUMNS, 'payee')].includes('HYPERLINK'));
  }

  /* ---------------------------------------------------------------- */
  section('§5-⑨ 保存の順序（本体 → OCR原文）');

  {
    const appended = [];

    resetFetch(async (url, options) => {
      if (url.includes(':append')) {
        appended.push({ url, body: JSON.parse(options.body) });
      }

      return { status: 200, body: {} };
    });

    await record.saveRecord({
      accessToken: 'token-for-test',
      spreadsheetId: 'sprd1',
      record: { recordId: 'R9', payee: 'テスト', createdAt: '2026-08-03 10:00:00', extractionMethod: 'drive' },
      ocrText: 'よみとった文字',
    });

    check('2行が書かれる（本体・OCR原文）', appended.length === 2);

    check('先に本体を書く',
      decodeURIComponent(appended[0].url).includes(schema.TABS.data));

    check('あとで OCR原文を書く',
      decodeURIComponent(appended[1].url).includes(schema.TABS.ocrText));

    check('OCR原文は管理IDで紐付く',
      appended[1].body.values[0][0] === 'R9');

    check('原文の本文も入っている',
      appended[1].body.values[0].includes('よみとった文字'));
  }

  {
    /* 原文が無ければ本体だけ書く（空行を作らない）。 */
    const appended = [];

    resetFetch(async (url, options) => {
      if (url.includes(':append')) appended.push(JSON.parse(options.body));
      return { status: 200, body: {} };
    });

    await record.saveRecord({
      accessToken: 'token-for-test',
      spreadsheetId: 'sprd1',
      record: { recordId: 'R10' },
      ocrText: '',
    });

    check('OCR原文が空なら本体だけを書く', appended.length === 1);
  }

  {
    /* 書き込みに失敗したら SHEET-001。到達点は「原本保存済み」。 */
    resetFetch(async () => ({ status: 500, body: {} }));

    let thrown = null;

    try {
      await record.saveRecord({
        accessToken: 'token-for-test',
        spreadsheetId: 'sprd1',
        record: { recordId: 'R11' },
        ocrText: '',
      });
    } catch (error) {
      thrown = error;
    }

    /*
     * 2026-08-18 変更（findings #5）。500番台は「シートへの書き込みに
     * 失敗しました」ではなく、待てば直ることが伝わる SRV-001 にする。
     * 到達点（原本保存済み）は従来どおり添える。
     */
    check('Google 側の一時障害は SRV-001', thrown?.code === 'SRV-001');
    check('到達点は「原本保存済み」のまま', thrown?.progress === 'original-saved');
    check('原本は保存済みだと伝える', thrown?.progress === 'original-saved');
  }

  finish();
} catch (error) {
  fatal(error);
}

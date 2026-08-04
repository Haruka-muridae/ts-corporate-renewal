/*
 * 名刺OCR フェーズ0 検証ページ（public/production-app/card-ocr/poc/）の検証。
 *
 * ------------------------------------------------------------------
 * 実APIへ通信しない
 * ------------------------------------------------------------------
 * Gemini も Google API も呼ばない。fetch はすべてスタブする。
 * keystore-spec-v1.md §7 と同じ方針で、要件定義書 §13.4 が要求している。
 *
 * ここで確かめるのは「キーの扱い」「送信先」「応答の解釈」であって、
 * Gemini の分類精度ではない。精度はフェーズ0の実測で見る
 * （docs/specs/card-ocr-phase0-plan.md §5-12）。
 * ------------------------------------------------------------------
 */

import { readFile } from 'node:fs/promises';
import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

const POC_DIR = new URL('../../public/production-app/card-ocr/poc/', import.meta.url);

try {
  const gemini = await import('../../public/production-app/card-ocr/poc/gemini.js');
  const prompt = await import('../../public/production-app/card-ocr/poc/prompt.js');
  const sanitize = await import('../../public/production-app/card-ocr/poc/sanitize.js');

  /* ---------------------------------------------------------------- */
  section('数式インジェクション対策（要件定義書 FR-18）');

  const escapeCases = [
    ['=1+1', "'=1+1"],
    ['=HYPERLINK("http://evil.example","x")', '\'=HYPERLINK("http://evil.example","x")'],
    ['+81312345678', "'+81312345678"],
    ['-5', "'-5"],
    ['@example.com', "'@example.com"],
    ['株式会社サンプル商事', '株式会社サンプル商事'],
    ['taro@example.com', 'taro@example.com'],
    ['', ''],
  ];

  for (const [input, expected] of escapeCases) {
    check(
      `escapeCellText(${JSON.stringify(input).slice(0, 30)})`,
      sanitize.escapeCellText(input) === expected,
      sanitize.escapeCellText(input),
    );
  }

  check('null でも壊れない', sanitize.escapeCellText(null) === '');
  check('undefined でも壊れない', sanitize.escapeCellText(undefined) === '');

  const long = 'あ'.repeat(sanitize.SHORT_CELL_MAX_LENGTH + 100);
  check(
    '上限を超えたら切り詰める',
    sanitize.escapeCellText(long).length === sanitize.SHORT_CELL_MAX_LENGTH,
    String(sanitize.escapeCellText(long).length),
  );

  check(
    'OCR本文は上限が広い',
    sanitize.escapeOcrText('あ'.repeat(2000)).length === 2000,
  );

  /* ---------------------------------------------------------------- */
  section('プロンプトと構造化出力の定義（FR-12 / FR-13）');

  check('プロンプトにバージョンが付いている', prompt.PROMPT_VERSION !== '');
  check(
    '推測を禁じる指示が入っている',
    prompt.SYSTEM_INSTRUCTION.includes('補わない') && prompt.SYSTEM_INSTRUCTION.includes('推測しない'),
  );
  check(
    '行順が原稿と一致しない前提が入っている',
    prompt.SYSTEM_INSTRUCTION.includes('行の順序は原稿と一致しない'),
  );

  check(
    'confidence を持たせていない',
    !('confidence' in prompt.CARD_SCHEMA.properties),
  );
  check(
    'uncertainFields を持っている',
    prompt.CARD_SCHEMA.properties.uncertainFields?.type === 'array',
  );

  for (const field of ['companyName', 'fullName', 'email', 'phone', 'uncertainFields']) {
    check(`必須項目に ${field} がある`, prompt.CARD_SCHEMA.required.includes(field));
  }

  const request = prompt.buildGeminiRequest('テスト');
  check('履歴を持たせない（1リクエスト1名刺）', request.contents.length === 1);
  check('JSON で返させる', request.generationConfig.responseMimeType === 'application/json');
  check('スキーマを渡している', request.generationConfig.responseSchema === prompt.CARD_SCHEMA);
  check('出力上限の既定は400トークン', request.generationConfig.maxOutputTokens === 400);
  check('温度は0（分類であって創作ではない）', request.generationConfig.temperature === 0);

  check(
    'サンプルは行順違いで同じ行を持つ',
    prompt.SAMPLE_ORDERED.split('\n').sort().join('|')
      === prompt.SAMPLE_SHUFFLED.split('\n').sort().join('|'),
  );
  check(
    'サンプルの行順は入れ替わっている',
    prompt.SAMPLE_ORDERED !== prompt.SAMPLE_SHUFFLED,
  );
  check(
    'サンプルは example.com など架空のドメインだけを使う',
    /@example\.com/.test(prompt.SAMPLE_ORDERED) && !/@(?!example\.com)[a-z0-9.-]+\.[a-z]{2,}/i.test(prompt.SAMPLE_ORDERED),
  );

  /* ---------------------------------------------------------------- */
  section('Gemini 呼び出し（キーの扱いと送信先）');

  const okBody = {
    candidates: [{
      content: {
        parts: [{
          text: JSON.stringify({
            companyName: '株式会社サンプル商事',
            fullName: '見本 太郎',
            email: 'taro.mihon@example.com',
            phone: '03-1234-5678',
            uncertainFields: [],
          }),
        }],
      },
    }],
  };

  /* 呼び出しを記録するスタブ。実通信はしない。 */
  function makeStub(response) {
    const calls = [];

    const impl = async (url, options) => {
      calls.push({ url: String(url), options });
      return response;
    };

    return { impl, calls };
  }

  function jsonResponse(body, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  }

  const KEY = 'AIzaTESTKEY_not_a_real_key_0000000000';

  {
    const stub = makeStub(jsonResponse(okBody));
    const result = await gemini.classifyCardText('テキスト', { apiKey: KEY, fetchImpl: stub.impl });

    check('分類結果を返す', result.fullName === '見本 太郎');
    check('1回だけ呼ぶ', stub.calls.length === 1);

    const call = stub.calls[0];

    check(
      '送信先は generativelanguage.googleapis.com のみ',
      new URL(call.url).host === gemini.GEMINI_HOST,
      call.url,
    );
    check(
      '要件定義書 §12 の3系統以外へ出ていない',
      ['generativelanguage.googleapis.com', 'www.googleapis.com', 'sheets.googleapis.com']
        .includes(new URL(call.url).host),
    );

    /* キーの扱い。ここが崩れると keystore-spec-v1.md §2 に反する。 */
    check('キーは x-goog-api-key ヘッダーで送る', call.options.headers['x-goog-api-key'] === KEY);
    check('キーが URL に出ていない', !call.url.includes(KEY));
    check('キーが本文に出ていない', !String(call.options.body).includes(KEY));
    check('当社ドメインへは送っていない', !call.url.includes('tsam-ai.com'));
    check('画像を送っていない', !String(call.options.body).includes('inlineData'));
    check('POST で送る', call.options.method === 'POST');
  }

  {
    const stub = makeStub(jsonResponse(okBody));
    await gemini.classifyCardText('テキスト', { apiKey: `  ${KEY}  `, fetchImpl: stub.impl });
    check('キーの前後の空白を落として送る', stub.calls[0].options.headers['x-goog-api-key'] === KEY);
  }

  /* ---------------------------------------------------------------- */
  section('Gemini のエラー処理（§15 のコードへの対応）');

  const errorCases = [
    [0, gemini.GeminiErrorCode.KEY_MISSING, 'KEY-001', ''],
    [401, gemini.GeminiErrorCode.KEY_REJECTED, 'KEY-002', KEY],
    [403, gemini.GeminiErrorCode.KEY_REJECTED, 'KEY-002', KEY],
    [429, gemini.GeminiErrorCode.RATE_LIMITED, 'AI-002', KEY],
  ];

  for (const [status, expectedCode, expectedErrorCode, key] of errorCases) {
    const stub = makeStub(jsonResponse({}, status));
    let caught = null;

    try {
      await gemini.classifyCardText('テキスト', {
        apiKey: key,
        fetchImpl: stub.impl,
        /* 404 以外はフォールバックしないことを確かめるため既定のまま。 */
      });
    } catch (error) {
      caught = error;
    }

    check(`status ${status} → ${expectedCode}`, caught?.code === expectedCode, caught?.code);
    check(
      `status ${status} の画面表示は ${expectedErrorCode}`,
      gemini.describeGeminiError(caught).errorCode === expectedErrorCode,
    );
    check(`status ${status} の例外にキーが含まれない`, !String(caught?.message ?? '').includes(KEY));
  }

  {
    /* 404 のときだけフォールバックモデルで1回試す。 */
    const calls = [];
    const impl = async (url) => {
      calls.push(String(url));
      return calls.length === 1 ? jsonResponse({}, 404) : jsonResponse(okBody);
    };

    const result = await gemini.classifyCardText('テキスト', { apiKey: KEY, fetchImpl: impl });

    check('404 でフォールバックモデルを1回試す', calls.length === 2);
    check('1回目は主モデル', calls[0].includes(gemini.DEFAULT_MODEL));
    check('2回目はフォールバックモデル', calls[1].includes(gemini.FALLBACK_MODEL));
    check('フォールバックで結果が返る', result.fullName === '見本 太郎');
  }

  {
    /* 429 では再試行しない。無料枠のクォータを削るだけになる。 */
    const calls = [];
    const impl = async () => { calls.push(1); return jsonResponse({}, 429); };

    try {
      await gemini.classifyCardText('テキスト', { apiKey: KEY, fetchImpl: impl });
    } catch { /* 期待どおり */ }

    check('429 では再試行しない', calls.length === 1);
  }

  {
    const stub = makeStub(jsonResponse({ candidates: [{ content: { parts: [{ text: '{壊れた' }] } }] }));
    let caught = null;

    try {
      await gemini.classifyCardText('テキスト', { apiKey: KEY, fetchImpl: stub.impl });
    } catch (error) { caught = error; }

    check('壊れたJSONは AI-003', gemini.describeGeminiError(caught).errorCode === 'AI-003');
  }

  {
    const partial = { candidates: [{ content: { parts: [{ text: JSON.stringify({ companyName: 'x' }) }] } }] };
    const stub = makeStub(jsonResponse(partial));
    let caught = null;

    try {
      await gemini.classifyCardText('テキスト', { apiKey: KEY, fetchImpl: stub.impl });
    } catch (error) { caught = error; }

    check('必須項目が欠けたら AI-004', gemini.describeGeminiError(caught).errorCode === 'AI-004');
  }

  {
    const impl = async () => { throw new Error('offline'); };
    let caught = null;

    try {
      await gemini.classifyCardText('テキスト', { apiKey: KEY, fetchImpl: impl });
    } catch (error) { caught = error; }

    check('通信失敗は AI-001', gemini.describeGeminiError(caught).errorCode === 'AI-001');
    check('通信失敗の例外にキーが含まれない', !String(caught?.message ?? '').includes(KEY));
  }

  /* ---------------------------------------------------------------- */
  section('Google 連携の設定（google-config.js）');

  const gconfig = await import('../../public/production-app/card-ocr/poc/google-config.js');

  check(
    '要求スコープは drive.file の1つだけ',
    gconfig.DRIVE_SCOPE === 'https://www.googleapis.com/auth/drive.file',
    gconfig.DRIVE_SCOPE,
  );
  check(
    'GIS の読み込み先は承認済みのURLのみ',
    gconfig.GIS_SCRIPT_URL === 'https://accounts.google.com/gsi/client',
    gconfig.GIS_SCRIPT_URL,
  );
  check(
    'クライアントIDが設定済み',
    gconfig.isClientIdConfigured() === true,
  );
  check(
    'クライアントIDは Google の形式',
    /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(gconfig.GOOGLE_CLIENT_ID),
    gconfig.GOOGLE_CLIENT_ID,
  );
  check(
    'テスト環境（/apps/）の既存クライアントIDとは別のものを使う（§6-2 の決定）',
    gconfig.GOOGLE_CLIENT_ID
      !== '603018562548-a0fs4g4eetdhg5jrfjbh5qqos547g69r.apps.googleusercontent.com',
  );
  check(
    'プレースホルダは未設定と判定される',
    gconfig.isClientIdConfigured(gconfig.CLIENT_ID_PLACEHOLDER) === false,
  );
  check('空文字は未設定', gconfig.isClientIdConfigured('') === false);
  check('空白だけも未設定', gconfig.isClientIdConfigured('   ') === false);
  check('文字列以外も未設定', gconfig.isClientIdConfigured(null) === false);
  check(
    '実際のIDは設定済みと判定する',
    gconfig.isClientIdConfigured('123-abc.apps.googleusercontent.com') === true,
  );

  /* ---------------------------------------------------------------- */
  section('Google 連携（drive-auth.js。GIS はスタブする）');

  const auth = await import('../../public/production-app/card-ocr/poc/drive-auth.js');
  const loader = await import('../../public/production-app/card-ocr/poc/gis-loader.js');

  const TEST_CLIENT_ID = '000000-test.apps.googleusercontent.com';
  const TEST_TOKEN = 'ya29.TEST_ACCESS_TOKEN_not_real';

  /*
   * GIS のスタブ。globalThis.google を置くと isGisLoaded() が真になり、
   * loadGisScript() は即座に解決する。**実スクリプトは読み込まれない。**
   */
  function stubGis(behavior) {
    const calls = [];

    globalThis.google = {
      accounts: {
        oauth2: {
          initTokenClient(options) {
            calls.push(options);
            return {
              requestAccessToken(requestOptions) {
                calls.push({ requestOptions });
                behavior(options, requestOptions);
              },
            };
          },
          hasGrantedAllScopes(response, scope) {
            const granted = typeof response?.scope === 'string' ? response.scope.split(/\s+/) : [];
            return granted.includes(scope);
          },
        },
      },
    };

    return calls;
  }

  function clearGis() {
    delete globalThis.google;
    loader.resetGisLoader();
  }

  check('スタブ前は GIS 未読込と判定する', loader.isGisLoaded() === false);

  {
    /*
     * クライアントID未設定なら、GIS を読み込まずに落ちる。
     *
     * 既定値は設定済みになったため、未設定の状態を明示的に渡して確かめる。
     * ここで見たいのは「未設定のときに外部通信を出さないこと」であり、
     * 既定値が何かではない。
     */
    clearGis();
    let caught = null;

    try {
      await auth.ensureAccessToken({ clientId: gconfig.CLIENT_ID_PLACEHOLDER });
    } catch (error) { caught = error; }

    check('未設定なら CLIENT_ID_MISSING', caught?.code === auth.DriveAuthErrorCode.CLIENT_ID_MISSING);
    check(
      '未設定のときは GIS を読み込まない（外部通信を出さない）',
      globalThis.google === undefined,
    );
    check(
      '未設定の画面表示は OAUTH-001',
      auth.describeDriveAuthError(caught).errorCode === 'OAUTH-001',
    );
  }

  {
    /* 正常系。 */
    const calls = stubGis((options) => {
      options.callback({
        access_token: TEST_TOKEN,
        scope: gconfig.DRIVE_SCOPE,
        expires_in: 3600,
      });
    });

    const token = await auth.ensureAccessToken({ clientId: TEST_CLIENT_ID });

    check('トークンを取得できる', token === TEST_TOKEN);
    check('取得後は有効なトークンを持つ', auth.hasValidAccessToken() === true);

    const init = calls[0];

    check('クライアントIDを渡している', init.client_id === TEST_CLIENT_ID);
    check(
      '要求スコープは drive.file の1つだけ',
      init.scope === gconfig.DRIVE_SCOPE,
      init.scope,
    );
    check(
      'ドライブ全体を読むスコープを要求していない',
      !/auth\/drive(\s|$)/.test(init.scope) && !init.scope.includes('drive.readonly'),
    );

    /* 2回目はキャッシュを使い、ポップアップを開き直さない。 */
    const before = calls.length;
    const again = await auth.ensureAccessToken({ clientId: TEST_CLIENT_ID });

    check('2回目はキャッシュを返す', again === TEST_TOKEN);
    check('2回目はトークンクライアントを作り直さない', calls.length === before);

    auth.clearAccessToken();
    check('解除するとトークンを持たない', auth.hasValidAccessToken() === false);
    check('解除後は取り出せない', auth.getCachedAccessToken() === null);
  }

  {
    /* スコープを外されたまま同意された場合は弾く。 */
    stubGis((options) => {
      options.callback({ access_token: TEST_TOKEN, scope: '', expires_in: 3600 });
    });

    let caught = null;

    try {
      await auth.ensureAccessToken({ clientId: TEST_CLIENT_ID });
    } catch (error) { caught = error; }

    check('スコープ未付与は SCOPE_NOT_GRANTED', caught?.code === auth.DriveAuthErrorCode.SCOPE_NOT_GRANTED);
    check('スコープ未付与ならトークンを保持しない', auth.hasValidAccessToken() === false);
  }

  {
    /* トークンが空で返ってきた場合。 */
    stubGis((options) => {
      options.callback({ access_token: '', scope: gconfig.DRIVE_SCOPE, expires_in: 3600 });
    });

    let caught = null;

    try {
      await auth.ensureAccessToken({ clientId: TEST_CLIENT_ID });
    } catch (error) { caught = error; }

    check('空トークンは UNKNOWN', caught?.code === auth.DriveAuthErrorCode.UNKNOWN);
    check('空トークンを保持しない', auth.hasValidAccessToken() === false);
  }

  {
    /* 同意画面で拒否・閉じられた場合。 */
    const cases = [
      ['popup_closed', auth.DriveAuthErrorCode.POPUP_CLOSED],
      ['popup_failed_to_open', auth.DriveAuthErrorCode.POPUP_BLOCKED],
      ['access_denied', auth.DriveAuthErrorCode.ACCESS_DENIED],
      ['something_else', auth.DriveAuthErrorCode.UNKNOWN],
    ];

    for (const [reason, expected] of cases) {
      stubGis((options) => { options.error_callback({ type: reason }); });

      let caught = null;

      try {
        await auth.ensureAccessToken({ clientId: TEST_CLIENT_ID });
      } catch (error) { caught = error; }

      check(`${reason} → ${expected}`, caught?.code === expected, caught?.code);
      check(`${reason} の画面表示が用意されている`, auth.describeDriveAuthError(caught).errorCode === 'OAUTH-001');
    }
  }

  {
    /* forceConsent のときは prompt=consent を渡し、キャッシュを使わない。 */
    let requested = null;

    stubGis((options, requestOptions) => {
      requested = requestOptions;
      options.callback({ access_token: TEST_TOKEN, scope: gconfig.DRIVE_SCOPE, expires_in: 3600 });
    });

    await auth.ensureAccessToken({ clientId: TEST_CLIENT_ID });
    check('通常は prompt を指定しない', requested?.prompt === undefined);

    requested = null;
    await auth.ensureAccessToken({ clientId: TEST_CLIENT_ID, forceConsent: true });
    check('forceConsent では prompt=consent', requested?.prompt === 'consent');

    auth.clearAccessToken();
  }

  {
    /* GIS が読み込めても oauth2 が無い場合。 */
    globalThis.google = { accounts: {} };
    let caught = null;

    try {
      await auth.ensureAccessToken({ clientId: TEST_CLIENT_ID });
    } catch (error) { caught = error; }

    check('oauth2 が無ければ GIS_LOAD_FAILED', caught?.code === auth.DriveAuthErrorCode.GIS_LOAD_FAILED);
  }

  {
    /* 例外にトークンを含めない。 */
    stubGis((options) => { options.error_callback({ type: 'access_denied' }); });

    let caught = null;

    try {
      await auth.ensureAccessToken({ clientId: TEST_CLIENT_ID });
    } catch (error) { caught = error; }

    check('例外メッセージにトークンが含まれない', !String(caught?.message ?? '').includes(TEST_TOKEN));
    check('例外メッセージにクライアントIDが含まれない', !String(caught?.message ?? '').includes(TEST_CLIENT_ID));
  }

  check(
    'hasDriveScope は文字列判定にも落ちる',
    (() => {
      clearGis();
      return auth.hasDriveScope({ scope: gconfig.DRIVE_SCOPE }) === true
        && auth.hasDriveScope({ scope: '' }) === false
        && auth.hasDriveScope(null) === false;
    })(),
  );

  clearGis();

  /* ---------------------------------------------------------------- */
  section('Drive API の下回り（drive-api.js）');

  const driveApi = await import('../../public/production-app/card-ocr/poc/drive-api.js');

  check(
    '通信先は要件定義書 §12 の Drive だけ',
    driveApi.DRIVE_FILES_ENDPOINT.startsWith('https://www.googleapis.com/drive/v3/')
      && driveApi.DRIVE_UPLOAD_ENDPOINT.startsWith('https://www.googleapis.com/upload/drive/v3/'),
  );

  check(
    'HTTPステータスをエラーコードへ対応させる',
    driveApi.mapHttpErrorToCode(401) === driveApi.DriveErrorCode.UNAUTHORIZED
      && driveApi.mapHttpErrorToCode(403) === driveApi.DriveErrorCode.FORBIDDEN
      && driveApi.mapHttpErrorToCode(404) === driveApi.DriveErrorCode.NOT_FOUND
      && driveApi.mapHttpErrorToCode(429) === driveApi.DriveErrorCode.RATE_LIMITED
      && driveApi.mapHttpErrorToCode(500) === driveApi.DriveErrorCode.UNKNOWN,
  );

  check(
    '401 の画面表示は OAUTH-002（再連携を促す）',
    driveApi.describeDriveError(new driveApi.DriveError(driveApi.DriveErrorCode.UNAUTHORIZED)).errorCode === 'OAUTH-002',
  );

  check(
    'クエリのシングルクォートをエスケープする',
    driveApi.escapeQueryValue("a'b") === "a\\'b",
  );
  check(
    'クエリのバックスラッシュをエスケープする',
    driveApi.escapeQueryValue('a\\b') === 'a\\\\b',
  );

  {
    const query = driveApi.buildChildQuery('名刺データ', driveApi.DRIVE_FOLDER_MIME, 'PARENT');

    check('検索クエリに名前を含む', query.includes("name='名刺データ'"));
    check('検索クエリに種別を含む', query.includes(driveApi.DRIVE_FOLDER_MIME));
    check('検索クエリはゴミ箱を除く', query.includes('trashed=false'));
    check('**検索クエリは親を必ず含む**', query.includes("'PARENT' in parents"));
  }

  check(
    '親を指定しなければ root を条件にする',
    driveApi.buildChildQuery('x', 'y').includes("'root' in parents"),
  );

  check(
    '例外にトークンが含まれない',
    new driveApi.DriveError(driveApi.DriveErrorCode.FORBIDDEN, 403, 'reason').message === 'drive:FORBIDDEN',
  );

  /* ---------------------------------------------------------------- */
  section('保存構造の解決（drive-storage.js。fetch をスタブする）');

  const storage = await import('../../public/production-app/card-ocr/poc/drive-storage.js');

  check('フォルダ名は要件定義書 FR-07 のとおり', storage.ROOT_FOLDER_NAME === 'TSAM AI');
  check('アプリフォルダ名は 名刺データ', storage.APP_FOLDER_NAME === '名刺データ');
  check('台帳名は 名刺管理', storage.SPREADSHEET_NAME === '名刺管理');
  check(
    'card-scanner のフォルダ名を使っていない',
    storage.APP_FOLDER_NAME !== '名刺スキャナ',
  );

  /* localStorage の代わり。テスト間で状態を持ち越さない。 */
  function installStorage() {
    const store = new Map();

    globalThis.localStorage = {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)); },
      removeItem: (key) => { store.delete(key); },
    };

    return store;
  }

  /*
   * Drive/Sheets のスタブ。実APIへは通信しない。
   * URL と method から応答を決め、呼び出しを記録する。
   */
  function makeDriveStub({ existing = new Map(), failVerify = null } = {}) {
    const calls = [];
    let idSeq = 0;

    const impl = async (url, options = {}) => {
      const method = options.method ?? 'GET';
      const text = String(url);
      calls.push({ url: text, method });

      /* files.get（キャッシュ検証） */
      const getMatch = /\/drive\/v3\/files\/([^?]+)\?/.exec(text);

      if (getMatch && method === 'GET' && !text.includes('/export')) {
        const id = decodeURIComponent(getMatch[1]);

        if (failVerify && failVerify.id === id) {
          return { ok: false, status: failVerify.status, json: async () => ({}) };
        }

        const meta = existing.get(id);

        if (!meta) {
          return { ok: false, status: 404, json: async () => ({}) };
        }

        return { ok: true, status: 200, json: async () => meta };
      }

      /* files.list（検索） */
      if (text.includes('/drive/v3/files?') && method === 'GET') {
        const q = new URL(text).searchParams.get('q') ?? '';
        const found = [...existing.entries()]
          .filter(([, meta]) => q.includes(`name='${meta.name}'`) && q.includes(`mimeType='${meta.mimeType}'`))
          .map(([id, meta]) => ({ id, name: meta.name, modifiedTime: meta.modifiedTime ?? '2026-01-01T00:00:00Z' }));

        return { ok: true, status: 200, json: async () => ({ files: found }) };
      }

      /* files.create（フォルダ作成） */
      if (text.includes('/drive/v3/files?') && method === 'POST') {
        idSeq += 1;
        const id = `new-folder-${idSeq}`;
        const meta = JSON.parse(String(options.body));
        existing.set(id, { name: meta.name, mimeType: meta.mimeType, parents: meta.parents ?? [] });

        return { ok: true, status: 200, json: async () => ({ id, name: meta.name }) };
      }

      /* spreadsheets.create */
      if (text.includes('sheets.googleapis.com/v4/spreadsheets?') && method === 'POST') {
        idSeq += 1;
        const id = `new-sheet-${idSeq}`;
        existing.set(id, { name: storage.SPREADSHEET_NAME, mimeType: driveApi.GOOGLE_SHEET_MIME, parents: [] });

        return { ok: true, status: 200, json: async () => ({ spreadsheetId: id }) };
      }

      /*
       * 親の付け替え（spreadsheets.create は親を指定できないため）。
       * 実際の Drive はここで parents が更新されるので、スタブでも更新する。
       * これを省くと、次回のキャッシュ検証が親の不一致で落ちてしまう。
       */
      if (method === 'PATCH' && text.includes('addParents=')) {
        const id = decodeURIComponent(/\/files\/([^?]+)\?/.exec(text)?.[1] ?? '');
        const parent = new URL(text).searchParams.get('addParents');
        const meta = existing.get(id);

        if (meta) {
          existing.set(id, { ...meta, parents: [...(meta.parents ?? []), parent] });
        }

        return { ok: true, status: 200, json: async () => ({ id, parents: [parent] }) };
      }

      /* 見出し行の書き込みなど */
      return { ok: true, status: 200, json: async () => ({}) };
    };

    return { impl, calls, existing };
  }

  {
    /* 初回: すべて作成される。 */
    installStorage();
    const stub = makeDriveStub();
    const result = await storage.ensureStorage({ token: 'T', fetchImpl: stub.impl });

    check('初回はフォルダを作成する', result.steps.app === 'created', result.steps.app);
    check('初回は台帳を作成する', result.steps.spreadsheet === 'created', result.steps.spreadsheet);
    check('createdAny が真', result.createdAny === true);
    check('3階層ぶんのIDが揃う', Boolean(result.appFolderId && result.imageFolderId && result.spreadsheetId));

    check(
      '通信先は Drive と Sheets のみ',
      stub.calls.every((call) => {
        const host = new URL(call.url).host;
        return host === 'www.googleapis.com' || host === 'sheets.googleapis.com';
      }),
    );

    /* 2回目: キャッシュから解決し、作成しない。 */
    const stub2 = makeDriveStub({ existing: stub.existing });
    const again = await storage.ensureStorage({ token: 'T', fetchImpl: stub2.impl });

    check('2回目はキャッシュから解決する', again.steps.app === 'cache', again.steps.app);
    check('2回目は台帳もキャッシュ', again.steps.spreadsheet === 'cache', again.steps.spreadsheet);
    check('**2回目は何も作らない**', again.createdAny === false);
    check('同じIDを返す', again.appFolderId === result.appFolderId);
    check(
      '2回目は作成のPOSTを出していない',
      !stub2.calls.some((call) => call.method === 'POST' && call.url.includes('/drive/v3/files?')),
    );
  }

  {
    /* キャッシュが消えても、検索で復旧して作り直さない。 */
    installStorage();
    const first = makeDriveStub();
    const created = await storage.ensureStorage({ token: 'T', fetchImpl: first.impl });

    installStorage();  /* キャッシュだけ消す。Drive 上の実体は残る */

    const second = makeDriveStub({ existing: first.existing });
    const recovered = await storage.ensureStorage({ token: 'T', fetchImpl: second.impl });

    check('**キャッシュが消えても検索で復旧する**', recovered.steps.app === 'search', recovered.steps.app);
    check('復旧時は作り直さない', recovered.createdAny === false);
    check('同じフォルダを指す', recovered.appFolderId === created.appFolderId);
  }

  {
    /* キャッシュが 404 なら捨てて作り直す。 */
    installStorage();
    const first = makeDriveStub();
    await storage.ensureStorage({ token: 'T', fetchImpl: first.impl });

    /* Drive 上の実体を消した状況を作る。 */
    const emptied = makeDriveStub({ existing: new Map() });
    const rebuilt = await storage.ensureStorage({ token: 'T', fetchImpl: emptied.impl });

    check('実体が消えていれば作り直す', rebuilt.steps.app === 'created', rebuilt.steps.app);
  }

  {
    /* 401 ではキャッシュを捨てない（認可の問題であり、実体が消えたのではない）。 */
    installStorage();
    const first = makeDriveStub();
    const created = await storage.ensureStorage({ token: 'T', fetchImpl: first.impl });

    const rootId = [...first.existing.entries()]
      .find(([, meta]) => meta.name === storage.ROOT_FOLDER_NAME)?.[0];

    const unauthorized = makeDriveStub({
      existing: first.existing,
      failVerify: { id: rootId, status: 401 },
    });

    let caught = null;

    try {
      await storage.ensureStorage({ token: 'T', fetchImpl: unauthorized.impl });
    } catch (error) { caught = error; }

    check('401 は投げ返す', caught?.code === driveApi.DriveErrorCode.UNAUTHORIZED);
    check(
      '**401 でキャッシュを捨てない**',
      globalThis.localStorage.getItem('tsam-card-ocr-root-folder-id') === rootId,
    );

    /* 認可が戻れば、そのまま同じIDで解決できる。 */
    const restored = makeDriveStub({ existing: first.existing });
    const after = await storage.ensureStorage({ token: 'T', fetchImpl: restored.impl });

    check('認可が戻れば同じIDで解決する', after.appFolderId === created.appFolderId);
  }

  {
    /* 保存領域が使えなくても解決自体は成立する。 */
    delete globalThis.localStorage;
    const stub = makeDriveStub();
    const result = await storage.ensureStorage({ token: 'T', fetchImpl: stub.impl });

    check('localStorage が無くても解決できる', Boolean(result.appFolderId));
  }

  installStorage();

  check(
    'キャッシュに入れるのはIDだけ（名刺データを入れない）',
    Object.values(storage.STORAGE_KEYS).every((key) => /id$/.test(key)),
  );

  /* ---------------------------------------------------------------- */
  section('Drive OCR（drive-ocr.js。fetch をスタブする）');

  const ocr = await import('../../public/production-app/card-ocr/poc/drive-ocr.js');

  check('OCR言語ヒントは ja（要件定義書 FR-08 の5）', ocr.OCR_LANGUAGE === 'ja');
  check('空テキスト時の再試行は最大3回（FR-08 の3）', ocr.MAX_OCR_ATTEMPTS === 3);
  check(
    '一時ドキュメント名は識別できる接頭辞を持つ',
    ocr.buildTempDocName(123).startsWith(ocr.TEMP_DOC_PREFIX),
  );

  /*
   * OCR のスタブ。アップロード → エクスポート → 削除 の3手順を追う。
   * Blob はテストでも作れる（Node 18 以降のグローバル）。
   */
  function makeOcrStub({ texts = ['読み取れたテキスト'], deleteOk = true } = {}) {
    const calls = [];
    let uploads = 0;

    const impl = async (url, options = {}) => {
      const method = options.method ?? 'GET';
      const text = String(url);
      calls.push({ url: text, method });

      if (text.includes('/upload/drive/v3/files')) {
        uploads += 1;
        return { ok: true, status: 200, json: async () => ({ id: `temp-${uploads}` }) };
      }

      if (text.includes('/export?')) {
        const body = texts[Math.min(uploads - 1, texts.length - 1)] ?? '';
        return { ok: true, status: 200, text: async () => body };
      }

      if (method === 'DELETE') {
        return deleteOk
          ? { ok: true, status: 204, json: async () => ({}) }
          : { ok: false, status: 500, json: async () => ({}) };
      }

      return { ok: true, status: 200, json: async () => ({ files: [] }) };
    };

    return { impl, calls };
  }

  {
    const stub = makeOcrStub();
    const blob = new Blob(['dummy'], { type: 'image/jpeg' });
    const result = await ocr.ocrImage({ token: 'T', blob, fetchImpl: stub.impl });

    check('テキストを取得できる', result.text === '読み取れたテキスト');
    check('1回で成功する', result.attempts === 1);
    check('一時ドキュメントを削除できた', result.deleted === true);

    const upload = stub.calls.find((call) => call.url.includes('/upload/drive/v3/files'));

    check('multipart でアップロードする', upload.url.includes('uploadType=multipart'));
    check('**ocrLanguage=ja を渡す**', upload.url.includes('ocrLanguage=ja'));
    check('POST で送る', upload.method === 'POST');

    check(
      '**text/plain でエクスポートする**',
      stub.calls.some((call) => call.url.includes('/export?') && call.url.includes('mimeType=text%2Fplain')),
    );
    check(
      '**一時ドキュメントを削除する**',
      stub.calls.some((call) => call.method === 'DELETE'),
    );

    const order = stub.calls.map((call) => {
      if (call.url.includes('/upload/')) return 'upload';
      if (call.url.includes('/export?')) return 'export';
      if (call.method === 'DELETE') return 'delete';
      return 'other';
    }).filter((kind) => kind !== 'other');

    check('順序は upload → export → delete', order.join('>') === 'upload>export>delete', order.join('>'));
  }

  {
    /* 空テキストなら消してからやり直す。 */
    const stub = makeOcrStub({ texts: ['', '', '3回目で取れた'] });
    const blob = new Blob(['dummy'], { type: 'image/jpeg' });
    const result = await ocr.ocrImage({ token: 'T', blob, fetchImpl: stub.impl });

    check('空なら再試行する', result.attempts === 3, String(result.attempts));
    check('再試行後のテキストを返す', result.text === '3回目で取れた');
    check(
      '再試行のたびに削除する',
      stub.calls.filter((call) => call.method === 'DELETE').length === 3,
    );
  }

  {
    /* 3回とも空なら OCR-002。 */
    const stub = makeOcrStub({ texts: ['', '', ''] });
    const blob = new Blob(['dummy'], { type: 'image/jpeg' });
    let caught = null;

    try {
      await ocr.ocrImage({ token: 'T', blob, fetchImpl: stub.impl });
    } catch (error) { caught = error; }

    check('3回とも空なら OCR_EMPTY', caught?.code === ocr.OcrErrorCode.EMPTY);
    check('画面表示は OCR-002', ocr.describeOcrError(caught).errorCode === 'OCR-002');
    check(
      '**失敗しても一時ドキュメントは全て消す**',
      stub.calls.filter((call) => call.method === 'DELETE').length === 3,
    );
  }

  {
    /* エクスポートが失敗しても削除は実行する（finally）。 */
    let deleted = 0;

    const impl = async (url, options = {}) => {
      const text = String(url);

      if (text.includes('/upload/drive/v3/files')) {
        return { ok: true, status: 200, json: async () => ({ id: 'temp-x' }) };
      }

      if (text.includes('/export?')) {
        return { ok: false, status: 500, json: async () => ({}) };
      }

      if ((options.method ?? 'GET') === 'DELETE') {
        deleted += 1;
        return { ok: true, status: 204, json: async () => ({}) };
      }

      return { ok: true, status: 200, json: async () => ({}) };
    };

    const blob = new Blob(['dummy'], { type: 'image/jpeg' });
    let caught = null;

    try {
      await ocr.ocrImage({ token: 'T', blob, fetchImpl: impl });
    } catch (error) { caught = error; }

    check('エクスポート失敗は投げ返す', caught !== null);
    check('**エクスポートが失敗しても削除は実行する**', deleted === 1);
  }

  {
    /* 削除に失敗しても全体は失敗にしない。 */
    const stub = makeOcrStub({ deleteOk: false });
    const blob = new Blob(['dummy'], { type: 'image/jpeg' });
    const result = await ocr.ocrImage({ token: 'T', blob, fetchImpl: stub.impl });

    check('削除失敗でも全体は成功', result.text === '読み取れたテキスト');
    check('削除できなかったことを返す', result.deleted === false);
  }

  {
    /* 孤児回収。接頭辞で始まるものだけを消す。 */
    const deletedIds = [];

    const impl = async (url, options = {}) => {
      const text = String(url);

      if ((options.method ?? 'GET') === 'DELETE') {
        deletedIds.push(decodeURIComponent(/files\/([^?]+)$/.exec(text)?.[1] ?? ''));
        return { ok: true, status: 204, json: async () => ({}) };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          files: [
            { id: 'a', name: `${ocr.TEMP_DOC_PREFIX}111` },
            { id: 'b', name: `${ocr.TEMP_DOC_PREFIX}222` },
            { id: 'c', name: '利用者の大切な資料' },
          ],
        }),
      };
    };

    const result = await ocr.collectOrphanTempDocs({ token: 'T', fetchImpl: impl });

    check('孤児を2件見つける', result.found === 2, String(result.found));
    check('2件とも削除する', result.deleted === 2);
    check(
      '**接頭辞で始まらないファイルは消さない**',
      !deletedIds.includes('c'),
      deletedIds.join(','),
    );
  }

  /* ---------------------------------------------------------------- */
  section('ページ本体のソース検査（守るべき制約）');

  const pocSource = await readFile(new URL('poc.js', POC_DIR), 'utf8');
  const htmlSource = await readFile(new URL('index.html', POC_DIR), 'utf8');
  const sources = [pocSource, await readFile(new URL('gemini.js', POC_DIR), 'utf8'),
    await readFile(new URL('prompt.js', POC_DIR), 'utf8'),
    await readFile(new URL('sanitize.js', POC_DIR), 'utf8'),
    await readFile(new URL('google-config.js', POC_DIR), 'utf8'),
    await readFile(new URL('gis-loader.js', POC_DIR), 'utf8'),
    await readFile(new URL('drive-auth.js', POC_DIR), 'utf8'),
    await readFile(new URL('drive-api.js', POC_DIR), 'utf8'),
    await readFile(new URL('drive-ocr.js', POC_DIR), 'utf8')];

  /*
   * drive-storage.js は保存先IDのキャッシュに localStorage を使うため、
   * 「直接触っていない」の一律検査からは外す。要件定義書 §FR-21 が
   * 「スプレッドシートIDキャッシュ … ブラウザ（localStorage）」と定めている。
   * 禁じられているのは KeyStore の迂回であって、IDキャッシュではない。
   */
  const storageSource = await readFile(new URL('drive-storage.js', POC_DIR), 'utf8');

  check(
    '保存先キャッシュにキーや名刺データを入れていない',
    !/tsam-api-keys|accessToken|access_token/.test(storageSource),
  );
  check(
    'テスト環境（apps/）から import していない（drive-storage.js）',
    !/from\s+['"][^'"]*\/apps\//.test(storageSource),
  );

  check(
    'guardPage() を通している',
    pocSource.includes('guardPage'),
  );
  check(
    'setScreenDepth(3) を設定している（3階層下）',
    pocSource.includes('setScreenDepth(3)'),
  );
  check(
    'KeyStore を経由してキーを取る',
    pocSource.includes("KeyStore.get(PROVIDERS.gemini)"),
  );

  /*
   * 「使っていない」の検査は、実際の呼び出し形にだけ一致させる。
   * 語そのものを禁じると、禁止理由を説明したコメントまで引っかかり、
   * 説明を書けなくなる。
   */
  for (const source of sources) {
    check(
      'localStorage を直接触っていない（keystore-spec §2-1）',
      !/localStorage\s*[.[]/.test(source),
    );
    check(
      'テスト環境（apps/）から import していない',
      !/from\s+['"][^'"]*\/apps\//.test(source),
    );
    check(
      'キーを console へ出していない',
      !/console\.(log|error|warn|info)/.test(source),
    );
  }

  check(
    'innerHTML を使っていない（§14.3）',
    !/\.innerHTML/.test(pocSource),
  );
  check(
    '検索避けを入れている（検証ページのため）',
    /name="robots"\s+content="noindex/.test(htmlSource),
  );
  check(
    '撤去予定であることを画面に出している',
    htmlSource.includes('検証用のページです') && htmlSource.includes('撤去'),
  );

  check(
    'クライアントIDの定義は google-config.js の1箇所だけ',
    sources.filter((source) => /GOOGLE_CLIENT_ID\s*=/.test(source)).length === 1,
  );
  check(
    'トークンを Storage へ書いていない',
    !sources.some((source) => /(local|session)Storage\s*[.[]/.test(source)),
  );

  /*
   * 許可された外部ホスト以外がソースに現れないこと。
   *
   * accounts.google.com は docs/external-dependency-approvals.md で
   * 承認済みの GIS 配信元。
   * tsam-ai.com と *.vercel.app は当社自身のオリジンで、外部通信先ではない
   * （google-config.js が生成元として登録した値をコメントで示している）。
   */
  const allowedHosts = [
    'generativelanguage.googleapis.com',
    'www.googleapis.com',
    'sheets.googleapis.com',
    'accounts.google.com',
    'tsam-ai.com',
  ];

  const isOwnOrigin = (host) => allowedHosts.includes(host) || host.endsWith('.vercel.app');

  for (const source of sources) {
    const hosts = [...source.matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]);
    const unexpected = hosts.filter((host) => !isOwnOrigin(host) && !host.endsWith('example.com'));

    check(
      '許可されていない外部ホストがソースに無い',
      unexpected.length === 0,
      unexpected.join(', '),
    );
  }

  finish();
} catch (error) {
  fatal(error);
}

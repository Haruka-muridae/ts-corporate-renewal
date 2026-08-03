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
    'クライアントIDは未設定（プレースホルダのまま）',
    gconfig.GOOGLE_CLIENT_ID === gconfig.CLIENT_ID_PLACEHOLDER,
  );
  check('未設定を未設定と判定する', gconfig.isClientIdConfigured() === false);
  check('空文字も未設定', gconfig.isClientIdConfigured('') === false);
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
    /* クライアントID未設定なら、GIS を読み込まずに落ちる。 */
    clearGis();
    let caught = null;

    try {
      await auth.ensureAccessToken();
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
  section('ページ本体のソース検査（守るべき制約）');

  const pocSource = await readFile(new URL('poc.js', POC_DIR), 'utf8');
  const htmlSource = await readFile(new URL('index.html', POC_DIR), 'utf8');
  const sources = [pocSource, await readFile(new URL('gemini.js', POC_DIR), 'utf8'),
    await readFile(new URL('prompt.js', POC_DIR), 'utf8'),
    await readFile(new URL('sanitize.js', POC_DIR), 'utf8'),
    await readFile(new URL('google-config.js', POC_DIR), 'utf8'),
    await readFile(new URL('gis-loader.js', POC_DIR), 'utf8'),
    await readFile(new URL('drive-auth.js', POC_DIR), 'utf8')];

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
   * tsam-ai.com は当社自身のオリジンで、外部通信先ではない
   * （google-config.js が生成元として登録する値をコメントで示している）。
   */
  const allowedHosts = [
    'generativelanguage.googleapis.com',
    'www.googleapis.com',
    'sheets.googleapis.com',
    'accounts.google.com',
    'tsam-ai.com',
  ];

  for (const source of sources) {
    const hosts = [...source.matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]);
    const unexpected = hosts.filter((host) => !allowedHosts.includes(host) && !host.endsWith('example.com'));

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

/*
 * 名刺OCRアプリ 本番実装（public/production-app/card-ocr/）の検証。
 *
 * ------------------------------------------------------------------
 * 実APIへ通信しない
 * ------------------------------------------------------------------
 * Google API も GIS も呼ばない。fetch と GIS はすべてスタブする。
 * keystore-spec-v1.md §7 と同じ方針で、要件定義書 §13.4 が要求している。
 * ------------------------------------------------------------------
 *
 * 検証用PoC（./poc/）のテストは tests/unit/card-ocr-poc.mjs に別にある。
 * **同じ名前のモジュールが2つあるのは意図どおり**で、共通層を作らずに
 * 複製する方針による（docs/repository-structure.md §4-1）。
 * PoC はフェーズ2の測定で使うため、まだ残してある。
 */

import { readFile, readdir } from 'node:fs/promises';
import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

const APP_DIR = new URL('../../public/production-app/card-ocr/', import.meta.url);

/* ---------------------------------------------------------------- */
/* GIS と document のスタブ。テスト間で状態を持ち越さない。            */
/* ---------------------------------------------------------------- */

function makeScriptElement() {
  const listeners = new Map();

  return {
    src: '',
    async: false,
    defer: false,
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    fire(type) {
      listeners.get(type)?.();
    },
  };
}

function installDocumentStub() {
  const created = [];

  globalThis.document = {
    createElement() {
      const script = makeScriptElement();
      created.push(script);
      return script;
    },
    head: { append() {} },
  };

  return created;
}

function clearDocumentStub() {
  delete globalThis.document;
}

function installGisStub({ tokenResponse = null, error = null, throwOnInit = false } = {}) {
  const calls = [];

  globalThis.google = {
    accounts: {
      oauth2: {
        initTokenClient(options) {
          calls.push(options);

          if (throwOnInit) {
            throw new Error('init_boom');
          }

          return {
            requestAccessToken(request) {
              calls.push({ request });

              if (error) {
                options.error_callback(error);
                return;
              }

              options.callback(tokenResponse);
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

function clearGisStub() {
  delete globalThis.google;
}

try {
  const config = await import('../../public/production-app/card-ocr/config.js');
  const gisLoader = await import('../../public/production-app/card-ocr/gis-loader.js');
  const auth = await import('../../public/production-app/card-ocr/drive-auth.js');
  const api = await import('../../public/production-app/card-ocr/drive-api.js');

  /* ================================================================ */
  section('設定（config.js）');

  check(
    '要求するスコープは drive.file の1つだけ（FR-02 の2）',
    config.DRIVE_SCOPE === 'https://www.googleapis.com/auth/drive.file',
    config.DRIVE_SCOPE,
  );
  check(
    '**スコープに drive.readonly / drive（全体）を含めていない**',
    !/auth\/drive(\.readonly)?$/.test(config.DRIVE_SCOPE),
  );
  check('クライアントIDが設定済み', config.isClientIdConfigured());
  check(
    '差し込み前の目印は未設定と判定する',
    !config.isClientIdConfigured(config.CLIENT_ID_PLACEHOLDER),
  );
  check('空文字は未設定', !config.isClientIdConfigured(''));
  check('空白だけも未設定', !config.isClientIdConfigured('   '));
  check('文字列でなければ未設定', !config.isClientIdConfigured(null));

  check(
    'クライアントシークレットを持たない',
    !Object.keys(config).some((name) => /secret/i.test(name)),
  );
  check(
    'GIS の読み込み先は公式配信',
    config.GIS_SCRIPT_URL === 'https://accounts.google.com/gsi/client',
  );
  check('GIS の読み込みに時間制限がある', config.GIS_LOAD_TIMEOUT_MS > 0);
  check('トークンの期限に余裕を取る', config.TOKEN_EXPIRY_MARGIN_MS >= 30000);

  check(
    'Drive のエンドポイントは §12 の許可先',
    config.DRIVE_FILES_ENDPOINT.startsWith('https://www.googleapis.com/')
      && config.DRIVE_UPLOAD_ENDPOINT.startsWith('https://www.googleapis.com/'),
  );

  /* ================================================================ */
  section('GIS の読み込み（gis-loader.js）');

  clearGisStub();
  clearDocumentStub();
  gisLoader.resetGisLoader();

  check('GIS 未読み込みを判定できる', !gisLoader.isGisLoaded());

  installGisStub();
  check('GIS 読み込み済みを判定できる', gisLoader.isGisLoaded());
  clearGisStub();

  {
    /*
     * **失敗したキャッシュを残さない。**
     * 残すと、そのページを開いているあいだ連携が二度と成功しない
     * （docs/receipt-ocr-findings-20260804.md #1）。
     */
    gisLoader.resetGisLoader();
    const scripts = installDocumentStub();

    const first = gisLoader.loadGisScript(50);
    scripts[0].fire('error');

    let firstError = null;
    try { await first; } catch (error) { firstError = error; }

    check('読み込み失敗は投げる', firstError?.message === 'GIS_LOAD_FAILED');

    /* マイクロタスクを1周させ、catch でのキャッシュ破棄を反映させる。 */
    await Promise.resolve();
    await Promise.resolve();

    const second = gisLoader.loadGisScript(50);
    check(
      '**失敗後に呼び直すと再試行する（同じ Promise を返さない）**',
      second !== first,
    );
    check('再試行で <script> を作り直している', scripts.length === 2, String(scripts.length));

    installGisStub();
    scripts[1].fire('load');
    let ok = false;
    try { await second; ok = true; } catch { ok = false; }
    check('再試行が成功する', ok);

    clearGisStub();
    clearDocumentStub();
    gisLoader.resetGisLoader();
  }

  {
    /* 読み込めても google.accounts が無い場合がある。 */
    const scripts = installDocumentStub();
    const promise = gisLoader.loadGisScript(50);
    scripts[0].fire('load');

    let caught = null;
    try { await promise; } catch (error) { caught = error; }

    check('load しても accounts が無ければ失敗にする', caught?.message === 'GIS_UNAVAILABLE');

    clearDocumentStub();
    gisLoader.resetGisLoader();
  }

  {
    /* 応答が返らない場合。load も error も発火しない。 */
    installDocumentStub();
    const promise = gisLoader.loadGisScript(10);

    let caught = null;
    try { await promise; } catch (error) { caught = error; }

    check('**時間制限で打ち切る（画面が固まらない）**', caught?.message === 'GIS_TIMEOUT');

    clearDocumentStub();
    gisLoader.resetGisLoader();
  }

  {
    /* document が無い環境（Node など）でも例外にせず失敗として返す。 */
    const promise = gisLoader.loadGisScript(50);
    let caught = null;
    try { await promise; } catch (error) { caught = error; }

    check('document が無ければ失敗として返す', caught?.message === 'GIS_NO_DOCUMENT');
    gisLoader.resetGisLoader();
  }

  /* ================================================================ */
  section('認可（drive-auth.js）');

  const VALID_RESPONSE = {
    access_token: 'test-token-value',
    expires_in: 3600,
    scope: config.DRIVE_SCOPE,
  };

  auth.clearAccessToken();
  auth.resetPendingRequest();

  check('初期状態ではトークンを持たない', auth.getCachedAccessToken() === null);
  check('hasValidAccessToken も false', !auth.hasValidAccessToken());

  {
    installGisStub({ tokenResponse: VALID_RESPONSE });
    const token = await auth.ensureAccessToken();

    check('トークンを取得できる', token === 'test-token-value');
    check('メモリに保持する', auth.getCachedAccessToken() === 'test-token-value');
    check('2回目はキャッシュを返す', await auth.ensureAccessToken() === 'test-token-value');

    auth.clearAccessToken();
    check('明示的に捨てられる', auth.getCachedAccessToken() === null);
    clearGisStub();
  }

  {
    /*
     * **付与スコープを検証する。**
     * 同意画面でチェックを外されてもトークンは発行される
     * （docs/receipt-ocr-findings-20260804.md #4）。
     */
    auth.clearAccessToken();
    auth.resetPendingRequest();
    installGisStub({
      tokenResponse: { access_token: 'no-scope-token', expires_in: 3600, scope: 'openid email' },
    });

    let caught = null;
    try { await auth.ensureAccessToken(); } catch (error) { caught = error; }

    check(
      '**スコープを外されたら拒否する**',
      caught?.code === auth.DriveAuthErrorCode.SCOPE_NOT_GRANTED,
      caught?.code,
    );
    check('拒否したトークンは保持しない', auth.getCachedAccessToken() === null);
    check(
      '案内はチェックを外さないよう促す',
      auth.describeDriveAuthError(caught).text.includes('チェックを外さず'),
    );
    clearGisStub();
  }

  {
    /* クライアントID未設定なら、GIS を読み込む前に止める。 */
    auth.clearAccessToken();
    auth.resetPendingRequest();
    clearGisStub();
    clearDocumentStub();
    gisLoader.resetGisLoader();

    let caught = null;
    try {
      await auth.ensureAccessToken({ clientId: config.CLIENT_ID_PLACEHOLDER });
    } catch (error) { caught = error; }

    check(
      '**未設定なら外部通信を起こす前に止める**',
      caught?.code === auth.DriveAuthErrorCode.CLIENT_ID_MISSING,
      caught?.code,
    );
    check(
      '<script> を作っていない',
      typeof globalThis.document === 'undefined',
    );
  }

  {
    /* 応答のエラー種別を分ける。 */
    const cases = [
      ['popup_closed', auth.DriveAuthErrorCode.POPUP_CLOSED],
      ['popup_closed_by_user', auth.DriveAuthErrorCode.POPUP_CLOSED],
      ['popup_failed_to_open', auth.DriveAuthErrorCode.POPUP_BLOCKED],
      ['access_denied', auth.DriveAuthErrorCode.ACCESS_DENIED],
      ['something_else', auth.DriveAuthErrorCode.UNKNOWN],
    ];

    for (const [reason, expected] of cases) {
      check(`${reason} を ${expected} に分類`, auth.toAuthError({ error: reason }).code === expected);
    }

    check('種別が無くても UNKNOWN で返す', auth.toAuthError({}).code === auth.DriveAuthErrorCode.UNKNOWN);
  }

  {
    /* 中断できる。ポップアップ待ちで画面を離れた場合。 */
    auth.clearAccessToken();
    auth.resetPendingRequest();

    const controller = new AbortController();
    controller.abort();

    let caught = null;
    try {
      await auth.ensureAccessToken({ signal: controller.signal });
    } catch (error) { caught = error; }

    check('中断済みなら開始しない', caught?.code === auth.DriveAuthErrorCode.ABORTED);
  }

  {
    /* 表示文言はすべて §15 のコードに対応する。 */
    const allowed = new Set(['OAUTH-001', 'OAUTH-002']);

    for (const code of Object.values(auth.DriveAuthErrorCode)) {
      const described = auth.describeDriveAuthError(new auth.DriveAuthError(code));
      check(`${code} の errorCode が §15 の範囲`, allowed.has(described.errorCode), described.errorCode);
      check(`${code} に文言がある`, described.text.length > 0);
    }
  }

  check(
    'DriveAuthError にトークンを含めない',
    !new auth.DriveAuthError(auth.DriveAuthErrorCode.UNKNOWN, 'x').message.includes('token'),
  );

  auth.clearAccessToken();
  auth.resetPendingRequest();
  clearGisStub();

  /* ================================================================ */
  section('Drive API の下回り（drive-api.js）');

  {
    /* HTTPステータスの分類。**潰さないこと。** */
    const cases = [
      [400, '', api.DriveErrorCode.BAD_REQUEST],
      [401, '', api.DriveErrorCode.UNAUTHORIZED],
      [403, 'insufficientFilePermissions', api.DriveErrorCode.FORBIDDEN],
      [403, 'storageQuotaExceeded', api.DriveErrorCode.STORAGE_FULL],
      [403, 'insufficientStorage', api.DriveErrorCode.STORAGE_FULL],
      [403, 'userRateLimitExceeded', api.DriveErrorCode.RATE_LIMITED],
      [403, 'rateLimitExceeded', api.DriveErrorCode.RATE_LIMITED],
      [403, 'sharingRateLimitExceeded', api.DriveErrorCode.RATE_LIMITED],
      [403, 'dailyLimitExceeded', api.DriveErrorCode.RATE_LIMITED],
      [403, 'quotaExceeded', api.DriveErrorCode.RATE_LIMITED],
      [404, '', api.DriveErrorCode.NOT_FOUND],
      [429, '', api.DriveErrorCode.RATE_LIMITED],
      [500, '', api.DriveErrorCode.SERVER_ERROR],
      [502, '', api.DriveErrorCode.SERVER_ERROR],
      [503, '', api.DriveErrorCode.SERVER_ERROR],
      [418, '', api.DriveErrorCode.UNKNOWN],
    ];

    for (const [status, reason, expected] of cases) {
      check(
        `${status}${reason ? ` (${reason})` : ''} → ${expected}`,
        api.mapHttpErrorToCode(status, reason) === expected,
        api.mapHttpErrorToCode(status, reason),
      );
    }

    check(
      '**500番台を UNKNOWN に落とさない**',
      api.mapHttpErrorToCode(503) !== api.DriveErrorCode.UNKNOWN,
    );
    check(
      '**403 のレート制限を認可エラーにしない**',
      api.mapHttpErrorToCode(403, 'userRateLimitExceeded') !== api.DriveErrorCode.UNAUTHORIZED,
    );
    check(
      '容量不足の判定を先に見ている（storageQuotaExceeded が quotaExceeded に食われない）',
      api.mapHttpErrorToCode(403, 'storageQuotaExceeded') === api.DriveErrorCode.STORAGE_FULL,
    );
  }

  {
    /* 表示文言。§15 に無いコードを作らない。 */
    const allowed = new Set(['OAUTH-002', 'DRV-001', 'SETUP-002']);

    for (const code of Object.values(api.DriveErrorCode)) {
      const described = api.describeDriveError(new api.DriveError(code, 0, 'detail-value'));
      check(`${code} の errorCode が §15 の範囲`, allowed.has(described.errorCode), described.errorCode);
      check(`${code} に文言がある`, described.text.length > 0);
      check(`${code} は detail を返す`, described.detail === 'detail-value');
    }

    check(
      'DriveError でない例外も握りつぶさない',
      api.describeDriveError(new TypeError('boom')).detail.includes('boom'),
    );

    check(
      '容量不足とレート制限で案内が違う',
      api.describeDriveError(new api.DriveError(api.DriveErrorCode.STORAGE_FULL)).text
        !== api.describeDriveError(new api.DriveError(api.DriveErrorCode.RATE_LIMITED)).text,
    );
  }

  {
    /* reason の取り出し。 */
    check(
      'errors[0].reason を読む',
      api.extractReason({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }) === 'userRateLimitExceeded',
    );
    check(
      'errors が無ければ status を読む',
      api.extractReason({ error: { status: 'PERMISSION_DENIED' } }) === 'PERMISSION_DENIED',
    );
    check('error が無ければ空', api.extractReason({}) === '');
    check('null でも壊れない', api.extractReason(null) === '');
  }

  {
    /* 検索クエリ。親を必ず条件に入れる。 */
    const query = api.buildChildQuery('名刺データ', 'application/vnd.google-apps.folder', 'PARENT');

    check('名前を条件に入れる', query.includes("name='名刺データ'"));
    check('種別を条件に入れる', query.includes("mimeType='application/vnd.google-apps.folder'"));
    check('ゴミ箱を除く', query.includes('trashed=false'));
    check('**親を必ず条件に入れる**', query.includes("'PARENT' in parents"));
    check(
      '親が未指定なら root を条件にする（条件を落とさない）',
      api.buildChildQuery('x', 'y').includes("'root' in parents"),
    );

    check("' をエスケープする", api.escapeQueryValue("O'Brien") === "O\\'Brien");
    check('\\ をエスケープする', api.escapeQueryValue('a\\b') === 'a\\\\b');
    check(
      'クエリに埋め込むときもエスケープが効く',
      api.buildChildQuery("O'Brien", 'text/plain', 'P').includes("name='O\\'Brien'"),
      api.buildChildQuery("O'Brien", 'text/plain', 'P'),
    );
  }

  {
    /* boundary。内容から決めない。 */
    const first = api.createBoundary();
    const second = api.createBoundary();

    check('boundary が毎回変わる', first !== second, `${first} / ${second}`);
    check('boundary に接頭辞がある', first.startsWith('tsam-'));
    check('boundary に空白や区切り記号が入らない', !/[\s;"]/.test(first));
    /*
     * Blob は type を小文字へ正規化する。boundary に大文字が混ざると、
     * 宣言した boundary と本文中の区切りが食い違いうる。
     * 生成側で大文字を作らないことを固定しておく。
     */
    check('boundary に大文字を含めない', first === first.toLowerCase(), first);
  }

  {
    /* multipart 本文。 */
    const blob = new Blob(['image-bytes'], { type: 'image/jpeg' });
    const body = api.buildMultipartBody({ name: 'x', mimeType: 'application/vnd.google-apps.document' }, blob, 'bound-1');
    const text = await body.text();

    check('Content-Type に boundary を書く', body.type === 'multipart/related; boundary=bound-1', body.type);
    check('メタデータのパートがある', text.includes('"mimeType":"application/vnd.google-apps.document"'));
    check('画像のMIMEを本文パートに書く', text.includes('Content-Type: image/jpeg'));
    check('終端がある', text.trimEnd().endsWith('--bound-1--'));
    check('画像をそのまま連結している（base64にしない）', text.includes('image-bytes'));

    const noType = api.buildMultipartBody({}, new Blob(['x']), 'B');
    check('MIMEが無ければ JPEG とみなす', (await noType.text()).includes('Content-Type: image/jpeg'));
  }

  {
    /* 通信。トークンはヘッダーに載せ、URLへ出さない。 */
    const seen = [];

    const impl = async (url, options = {}) => {
      seen.push({ url: String(url), options });
      return { ok: true, status: 200, json: async () => ({ id: 'ok' }) };
    };

    await api.getFileMeta('FILE-ID', { token: 'SECRET-TOKEN', fetchImpl: impl });

    check('トークンを Authorization ヘッダーに載せる', seen[0].options.headers.Authorization === 'Bearer SECRET-TOKEN');
    check('**トークンを URL に載せない**', !seen[0].url.includes('SECRET-TOKEN'));
    check('検証に必要な項目を取る', seen[0].url.includes('mimeType') && seen[0].url.includes('parents') && seen[0].url.includes('trashed'));
  }

  {
    /* 同名が複数あったときは古いほうを先頭にする。 */
    const seen = [];

    const impl = async (url) => {
      seen.push(String(url));
      return { ok: true, status: 200, json: async () => ({ files: [{ id: 'a' }] }) };
    };

    await api.searchFiles('名刺データ', 'application/vnd.google-apps.folder', 'P', { token: 'T', fetchImpl: impl });

    check(
      '**古い順に並べる（先に作られたほうを正本とする）**',
      seen[0].includes('orderBy=createdTime') && !seen[0].includes('desc'),
      seen[0],
    );
  }

  {
    /* エラー応答の分類が通信層まで通っていること。 */
    const impl = async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }),
    });

    let caught = null;
    try {
      await api.getFileMeta('X', { token: 'ya29-secret-token', fetchImpl: impl });
    } catch (error) { caught = error; }

    check('403 のレート制限を RATE_LIMITED にする', caught?.code === api.DriveErrorCode.RATE_LIMITED, caught?.code);
    check('ステータスを保持する', caught?.status === 403);
    check('reason を detail に残す', caught?.detail === 'userRateLimitExceeded');
    check(
      '例外にトークンを含めない',
      !String(caught?.message).includes('ya29-secret-token')
        && !String(caught?.detail).includes('ya29-secret-token'),
    );
  }

  {
    /* 中断は通信失敗と区別できるようにする。 */
    const controller = new AbortController();

    const impl = async (url, options = {}) => {
      check('signal を fetch へ渡している', options.signal === controller.signal);
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    };

    controller.abort();

    let caught = null;
    try {
      await api.getFileMeta('X', { token: 'T', fetchImpl: impl, signal: controller.signal });
    } catch (error) { caught = error; }

    check('中断も NETWORK として返す', caught?.code === api.DriveErrorCode.NETWORK);
    check('**中断であることが detail から分かる**', caught?.detail === 'aborted');
  }

  {
    /*
     * fetch が無い環境。
     * **実 API を叩かないよう、globalThis.fetch を外して確かめる。**
     */
    const realFetch = globalThis.fetch;
    delete globalThis.fetch;

    let caught = null;
    try {
      await api.getFileMeta('X', { token: 'T' });
    } catch (error) { caught = error; }

    globalThis.fetch = realFetch;

    check('fetch が使えないことを検出する', caught?.code === api.DriveErrorCode.NETWORK, caught?.code);
    check('原因が detail から分かる', caught?.detail === 'fetch_unavailable');
  }

  {
    /* フォルダ作成。IDが返らなければ失敗にする。 */
    const impl = async () => ({ ok: true, status: 200, json: async () => ({}) });

    let caught = null;
    try {
      await api.createFolder('x', 'P', { token: 'T', fetchImpl: impl });
    } catch (error) { caught = error; }

    check('IDが返らなければ失敗にする', caught?.detail === 'folder_id_missing');
  }

  /* ================================================================ */
  section('SC-00 前提の判別（prerequisites.js）');

  const pre = await import('../../public/production-app/card-ocr/prerequisites.js');

  const ALL_OK = {
    signedIn: true,
    keyStoreAvailable: true,
    hasGeminiKey: true,
    clientIdConfigured: true,
    googleLinked: true,
  };

  check('すべて揃えば READY', pre.evaluatePrerequisites(ALL_OK) === pre.Prerequisite.READY);

  {
    /* 1つずつ欠けさせて、返る状態を確かめる。 */
    const cases = [
      ['signedIn', pre.Prerequisite.SIGNED_OUT],
      ['keyStoreAvailable', pre.Prerequisite.KEYSTORE_UNAVAILABLE],
      ['hasGeminiKey', pre.Prerequisite.KEY_MISSING],
      ['clientIdConfigured', pre.Prerequisite.CLIENT_ID_MISSING],
      ['googleLinked', pre.Prerequisite.GOOGLE_NOT_LINKED],
    ];

    for (const [missing, expected] of cases) {
      check(
        `${missing} が欠けると ${expected}`,
        pre.evaluatePrerequisites({ ...ALL_OK, [missing]: false }) === expected,
        pre.evaluatePrerequisites({ ...ALL_OK, [missing]: false }),
      );
    }
  }

  check(
    '引数が無くても壊れず SIGNED_OUT を返す',
    pre.evaluatePrerequisites() === pre.Prerequisite.SIGNED_OUT,
  );

  {
    /*
     * **判別の順序。** 複数が欠けていても、返るのは1つだけ。
     * 「該当する誘導のみを表示する」（要件定義書 §10.1）ため、
     * 状態を1つに決められることが前提になる。
     */
    check(
      '未ログインが最優先',
      pre.evaluatePrerequisites({}) === pre.Prerequisite.SIGNED_OUT,
    );
    check(
      '**キーは Google 連携より先に案内する**',
      pre.evaluatePrerequisites({
        ...ALL_OK, hasGeminiKey: false, googleLinked: false,
      }) === pre.Prerequisite.KEY_MISSING,
    );
    check(
      'クライアントID未設定は Google 未連携より先（当社側の設定漏れのため）',
      pre.evaluatePrerequisites({
        ...ALL_OK, clientIdConfigured: false, googleLinked: false,
      }) === pre.Prerequisite.CLIENT_ID_MISSING,
    );
    check(
      'キー保存不可はキー未設定より先',
      pre.evaluatePrerequisites({
        ...ALL_OK, keyStoreAvailable: false, hasGeminiKey: false,
      }) === pre.Prerequisite.KEYSTORE_UNAVAILABLE,
    );
  }

  {
    /* 表示。§15 のコードに収める。誘導は1つだけ。 */
    const allowedCodes = new Set(['AUTH-001', 'KEY-001', 'OAUTH-001', null]);
    const guidances = new Set(Object.values(pre.Guidance));

    for (const state of Object.values(pre.Prerequisite)) {
      const described = pre.describePrerequisite(state);

      check(`${state}: 見出しがある`, described.title.length > 0);
      check(`${state}: 説明がある`, described.text.length > 0);
      check(`${state}: errorCode が §15 の範囲`, allowedCodes.has(described.errorCode), String(described.errorCode));
      check(`${state}: 誘導は定義済みの1種`, guidances.has(described.guidance), described.guidance);
    }

    check(
      'READY だけが blocking でない',
      Object.values(pre.Prerequisite)
        .filter((state) => !pre.describePrerequisite(state).blocking)
        .join(',') === pre.Prerequisite.READY,
    );

    check(
      '未知の状態でも壊れない（READY として扱う）',
      pre.describePrerequisite('NOT_A_STATE').guidance === pre.Guidance.NONE,
    );
  }

  {
    /* 誘導の内容。 */
    check(
      '未ログインはログインへ誘導する',
      pre.describePrerequisite(pre.Prerequisite.SIGNED_OUT).guidance === pre.Guidance.LOGIN,
    );
    check(
      'キー未設定は Portal へ誘導する',
      pre.describePrerequisite(pre.Prerequisite.KEY_MISSING).guidance === pre.Guidance.PORTAL,
    );
    check(
      'Google未連携は連携ボタンを出す',
      pre.describePrerequisite(pre.Prerequisite.GOOGLE_NOT_LINKED).guidance === pre.Guidance.CONNECT,
    );

    const keyText = pre.describePrerequisite(pre.Prerequisite.KEY_MISSING).text;

    check(
      '**戻り方を文言で示す（導線を循環させない。FR-25 の3）**',
      keyText.includes('開き直して'),
      keyText,
    );
    check(
      'キーが端末内にとどまることを伝える（§5.3）',
      keyText.includes('端末') && keyText.includes('送られません'),
    );

    check(
      'クライアントID未設定は利用者に操作を促さない（当社側の問題）',
      pre.describePrerequisite(pre.Prerequisite.CLIENT_ID_MISSING).guidance === pre.Guidance.NONE,
    );
  }

  {
    /* 状態の一覧は3つとも出す。誘導とは別物。 */
    const list = pre.buildStatusList(ALL_OK);

    check('一覧は3件', list.length === 3, String(list.length));
    check('ログイン・キー・Google の順', list.map((i) => i.id).join(',') === 'signin,key,google');
    check('すべて ok として出る', list.every((item) => item.ok));

    const partial = pre.buildStatusList({ ...ALL_OK, hasGeminiKey: false });
    check('欠けている項目だけ ok が false', partial.filter((item) => !item.ok).length === 1);
    check('キーが未設定と分かる', partial[1].text === '未設定');

    const noStore = pre.buildStatusList({ ...ALL_OK, keyStoreAvailable: false });
    check('保存できないことを区別して出す', noStore[1].text === '保存できません');
    check(
      '**一覧に鍵の値を出さない**',
      list.every((item) => !/[A-Za-z0-9_-]{20,}/.test(item.text)),
    );
  }

  /* ================================================================ */
  section('SC-00 の画面（index.html / app.js）');

  const htmlSource = await readFile(new URL('index.html', APP_DIR), 'utf8');
  const appSource = await readFile(new URL('app.js', APP_DIR), 'utf8');

  {
    /* CSP（フェーズ0 の残項目15）。 */
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(htmlSource)?.[1] ?? '';

    check('CSP を宣言している', csp !== '');
    check("default-src は 'self'", csp.includes("default-src 'self'"));
    check(
      'script-src は自分自身と GIS だけ',
      csp.includes("script-src 'self' https://accounts.google.com"),
    );
    check("object-src を止めている", csp.includes("object-src 'none'"));
    check("base-uri を止めている", csp.includes("base-uri 'none'"));

    const connect = /connect-src ([^;]+)/.exec(csp)?.[1] ?? '';
    const allowedConnect = [
      "'self'",
      'https://www.googleapis.com',
      'https://sheets.googleapis.com',
      'https://generativelanguage.googleapis.com',
      'https://script.google.com',
      'https://script.googleusercontent.com',
    ];

    check(
      '**connect-src が §12 の3系統＋認証系に収まっている**',
      connect.trim().split(/\s+/).every((host) => allowedConnect.includes(host)),
      connect,
    );
    check(
      '§12 の3系統がすべて入っている',
      ['www.googleapis.com', 'sheets.googleapis.com', 'generativelanguage.googleapis.com']
        .every((host) => connect.includes(host)),
    );
    check(
      "画像プレビュー用に blob: を許している",
      /img-src [^;]*blob:/.test(csp),
    );
    check(
      '**CSP に unsafe-inline / unsafe-eval が無い**',
      !/unsafe-inline|unsafe-eval/.test(csp),
    );
  }

  check('検索避けを入れている', /name="robots"\s+content="noindex/.test(htmlSource));
  check(
    'guardPage() が返るまで中身を隠している',
    /id="co-content"[^>]*hidden/.test(htmlSource),
  );
  check(
    '誘導は既定で隠してある（1つだけ出すため）',
    /id="co-guidance"[^>]*hidden/.test(htmlSource)
      && /id="co-login-link"[^>]*hidden/.test(htmlSource)
      && /id="co-portal-link"[^>]*hidden/.test(htmlSource)
      && /id="co-connect"[^>]*hidden/.test(htmlSource),
  );
  check(
    '§5.3 の明示事項を載せている',
    htmlSource.includes('あなたのGoogleドライブにのみ')
      && htmlSource.includes('プロダクト改善')
      && htmlSource.includes('復旧の義務'),
  );
  check(
    'インラインの <script> を置いていない（CSP と整合）',
    !/<script(?![^>]*\ssrc=)[^>]*>/.test(htmlSource),
  );
  check('本文へのスキップリンクがある', htmlSource.includes('skip-link'));

  {
    /*
     * サイト内リンクは**ルートからの相対パス**。
     * 先頭に '/' を付けない、'apps/' を含めない
     * （public/portal/app-registry.js の注意書き）。
     */
    const hrefs = [...htmlSource.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    const internal = hrefs.filter((href) => !/^https?:|^#/.test(href));

    check(
      'サイト内リンクの先頭に / を付けていない',
      internal.every((href) => !href.startsWith('/')),
      internal.filter((href) => href.startsWith('/')).join(', '),
    );
    check(
      "サイト内リンクに 'apps/' を含めていない",
      internal.every((href) => !href.includes('apps/')),
      internal.filter((href) => href.includes('apps/')).join(', '),
    );
  }

  check('guardPage() を通している', appSource.includes('guardPage'));
  check('画面の深さを 2 に設定している', appSource.includes('setScreenDepth(2)'));
  check(
    '**キーは has() だけを見て、値を読み出していない**',
    appSource.includes('KeyStore.has(PROVIDERS.gemini)') && !/KeyStore\.get\(/.test(appSource),
  );
  check(
    'KeyStore へ書き込んでいない',
    !/KeyStore\.(set|remove)\(/.test(appSource),
  );
  check(
    '誘導のリンク先は screenPath() で作る（先頭スラッシュを作らない）',
    appSource.includes("screenPath('portal')") && appSource.includes("screenPath('login')"),
  );
  check(
    '連携の二重押下を防いでいる',
    appSource.includes('connecting'),
  );
  check(
    'pagehide でトークンを捨てている',
    /pagehide/.test(appSource) && /clearAccessToken/.test(appSource),
  );

  {
    /* 撮影の画面（SC-01 / SC-02）。 */
    check(
      '**表面と裏面の入力を1画面に並べない（既定で両方 hidden）**',
      /id="co-front-field"[^>]*hidden/.test(htmlSource)
        && /id="co-back-field"[^>]*hidden/.test(htmlSource),
    );
    check(
      'accept は JPEG と PNG のみ',
      (htmlSource.match(/accept="image\/jpeg,image\/png"/g) ?? []).length === 2,
    );
    check(
      'カメラを優先する（capture="environment"）',
      (htmlSource.match(/capture="environment"/g) ?? []).length === 2,
    );
    check(
      '**「裏面なしで進む」を先に置く（多数派の操作を最短にする）**',
      htmlSource.indexOf('co-skip-back') < htmlSource.indexOf('co-want-back'),
    );
    check(
      '入力欄にラベルが付いている',
      /for="co-front-input"/.test(htmlSource) && /for="co-back-input"/.test(htmlSource),
    );
    check(
      'プレビューは JS が組み立てる（innerHTML を使わない）',
      /id="co-previews"[^>]*>\s*<\/div>/.test(htmlSource),
    );
    check(
      '**プレビューの代替テキストに名刺の中身を出さない**',
      /alt = side === 'front' \? '表面のプレビュー'/.test(appSource),
    );
    check(
      '同じファイルを選び直せるよう入力欄を空へ戻す',
      /\['co-front-input'\]\.value = ''/.test(appSource),
    );
    check(
      '**回転は元の画像から作り直す（劣化を積み上げない）**',
      /acceptFile\(side, image\.source/.test(appSource),
    );
  }

  {
    /* 読み取りの画面（§8.1 ステージ2）。 */
    check(
      '読み取りの結果欄は既定で隠してある',
      /id="co-ocr"[^>]*hidden/.test(htmlSource),
    );
    check(
      '**読み取った本文を画面へ出していない（文字数だけ）**',
      /文字`/.test(appSource) && !/textContent = ocrText/.test(appSource),
    );
    check(
      '**読み取った本文を localStorage へ書いていない**',
      !/setItem\([^)]*ocrText/.test(appSource),
    );
    check('二重送信を防いでいる', /if \(reading \|\|/.test(appSource));
    check(
      '**画像を差し替えたら古い読み取り結果を捨てる**',
      (appSource.match(/discardOcr\(\)/g) ?? []).length >= 3,
      String((appSource.match(/discardOcr\(\)/g) ?? []).length),
    );
    check(
      '一時ドキュメントは保存先の中に作る（FR-08 の1）',
      /parentId: storage\?\.appFolderId/.test(appSource),
    );
    check(
      '起動時に孤児を回収する（ステージ0 の5）',
      /void collectOrphans\(\)/.test(appSource),
    );
    check(
      '**裏面が読めなかったことを黙って進めない（FR-08 の7）**',
      /裏面は読み取れませんでした/.test(appSource),
    );
  }

  /* ================================================================ */
  section('台帳へ書く値の無害化（sanitize.js / FR-18）');

  const sanitize = await import('../../public/production-app/card-ocr/sanitize.js');

  {
    const cases = [
      ['=1+1', "'=1+1"],
      ['=HYPERLINK("http://evil.example","x")', '\'=HYPERLINK("http://evil.example","x")'],
      ['+81312345678', "'+81312345678"],
      ['-5', "'-5"],
      ['@example.com', "'@example.com"],
      ['\tタブ始まり', "'\tタブ始まり"],
      ['\r復帰始まり', "'\r復帰始まり"],
      ['株式会社サンプル商事', '株式会社サンプル商事'],
      ['taro@example.com', 'taro@example.com'],
      ['', ''],
    ];

    for (const [input, expected] of cases) {
      check(
        `escapeCellText(${JSON.stringify(input).slice(0, 26)})`,
        sanitize.escapeCellText(input) === expected,
        JSON.stringify(sanitize.escapeCellText(input)),
      );
    }

    check(
      '**タブと復帰も対象にしている（PoC より広い）**',
      sanitize.escapeCellText('\t=1').startsWith("'"),
    );
    check('null でも壊れない', sanitize.escapeCellText(null) === '');
    check('undefined でも壊れない', sanitize.escapeCellText(undefined) === '');
    check('数値も文字列にして返す', sanitize.escapeCellText(123) === '123');

    const long = 'あ'.repeat(sanitize.SHORT_CELL_MAX_LENGTH + 100);
    check('上限を超えたら切り詰める', sanitize.escapeCellText(long).length === sanitize.SHORT_CELL_MAX_LENGTH);
    check('OCR本文は上限が広い', sanitize.escapeOcrText('あ'.repeat(2000)).length === 2000);
  }

  {
    /* 画像リンクはこちらが組み立てる数式。URLは検証する。 */
    const link = sanitize.buildImageLink('https://drive.google.com/file/d/ABC/view', '表面画像を見る');

    check('Drive のURLなら数式を作る', link === '=HYPERLINK("https://drive.google.com/file/d/ABC/view","表面画像を見る")', link);
    check(
      'docs.google.com も許す（スプレッドシート）',
      sanitize.buildImageLink('https://docs.google.com/spreadsheets/d/X/edit', 'x').startsWith('=HYPERLINK('),
    );
    check(
      '**Drive 以外のURLでは数式を作らない**',
      sanitize.buildImageLink('https://evil.example/x', 'x') === '',
    );
    check('http は許さない', sanitize.buildImageLink('http://drive.google.com/x', 'x') === '');
    check('空でも壊れない', sanitize.buildImageLink(null, null) === '');
    check(
      '見出しの " をエスケープする',
      sanitize.buildImageLink('https://drive.google.com/x', 'a"b').includes('"a""b"'),
    );
  }

  {
    check(
      'ファイル名から使えない記号を落とす',
      sanitize.sanitizeFileNamePart('株式会社/サンプル:商事*') === '株式会社サンプル商事',
      sanitize.sanitizeFileNamePart('株式会社/サンプル:商事*'),
    );
    check(
      'ハイフンと空白は残す（社名に現れる）',
      sanitize.sanitizeFileNamePart('サンプル - 商事') === 'サンプル - 商事',
    );
    check(
      '改行は空白へ畳む',
      sanitize.sanitizeFileNamePart('サンプル\n商事') === 'サンプル 商事',
    );
  }

  /* ================================================================ */
  section('画像のハッシュ（hash.js）');

  const hash = await import('../../public/production-app/card-ocr/hash.js');

  check('計算できる環境か判定できる', typeof hash.isHashAvailable() === 'boolean');

  if (hash.isHashAvailable()) {
    const value = await hash.sha256OfBlob(new Blob(['abc']));

    check(
      'SHA-256 を16進で返す',
      value === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      String(value),
    );
    check('長さは64文字', value.length === 64);

    const both = await hash.hashBothSides({ front: new Blob(['abc']), back: null });
    check('表面だけでも計算できる', both.front === value);
    check('裏面が無ければ null', both.back === null);
  }

  check('Blob でなければ null', await hash.sha256OfBlob(null) === null);
  check('引数が無くても壊れない', (await hash.hashBothSides()).front === null);

  /* ================================================================ */
  section('台帳の列構成（schema.js / §11.2・§11.3）');

  const schema = await import('../../public/production-app/card-ocr/schema.js');

  {
    const headers = schema.headersOf(schema.DATA_COLUMNS);

    check('列名が重複していない', new Set(headers).size === headers.length);
    check('キーが重複していない', new Set(schema.DATA_COLUMNS.map((c) => c.key)).size === schema.DATA_COLUMNS.length);

    for (const name of [
      'record_id', 'duplicate_key',
      'has_back', 'back_filled_fields',
      'front_image_hash', 'back_image_hash',
      'front_file_id', 'back_file_id',
      'front_file_url', 'back_file_url',
      'app_version', 'prompt_version',
    ]) {
      check(`§11.2 の列 ${name} がある`, headers.includes(name));
    }

    check(
      '**v3.0 の統合列を残していない**',
      !headers.includes('drive_file_id')
        && !headers.includes('drive_file_url')
        && !headers.includes('image_hash'),
    );
    check(
      'FR-12 の主要5項目に対応する列がある',
      ['会社名', '氏名', '役職', 'メールアドレス', '電話番号'].every((h) => headers.includes(h)),
    );

    const historyHeaders = schema.headersOf(schema.HISTORY_COLUMNS);
    check(
      '変更履歴は §11.3 の6列',
      historyHeaders.join(',') === 'history_id,changed_at,record_id,field_name,old_value,new_value',
      historyHeaders.join(','),
    );
    check('changed_by を持たない（本人のみ）', !historyHeaders.includes('changed_by'));
  }

  {
    /* ヘッダー検証。**改変を見つけたら止める。** */
    const expected = schema.headersOf(schema.DATA_COLUMNS);

    check('一致すれば ok', schema.verifyHeader(expected).status === 'ok');
    check('空なら empty', schema.verifyHeader([]).status === 'empty');
    check('配列でなくても empty', schema.verifyHeader(null).status === 'empty');
    check('右端の空欄は無視する', schema.verifyHeader([...expected, '', '']).status === 'ok');
    check(
      '前後の空白は改変とみなさない（手編集で紛れ込む）',
      schema.verifyHeader(expected.map((h, i) => (i === 0 ? ` ${h} ` : h))).status === 'ok',
    );
    check(
      '足りないだけなら upgrade',
      schema.verifyHeader(expected.slice(0, 5)).status === 'upgrade',
    );
    check(
      'upgrade は不足分を返す',
      schema.verifyHeader(expected.slice(0, 5)).missing.length === expected.length - 5,
    );
    check(
      '**並べ替えは altered（書き込みを止める）**',
      schema.verifyHeader([expected[1], expected[0], ...expected.slice(2)]).status === 'altered',
    );
    check(
      '**改名も altered**',
      schema.verifyHeader(expected.map((h, i) => (i === 3 ? 'かってな見出し' : h))).status === 'altered',
    );
    check(
      '途中の削除も altered（後ろがずれるため）',
      schema.verifyHeader(expected.filter((_, i) => i !== 2)).status === 'altered',
    );
  }

  {
    /* 欠けているタブ。 */
    check('欠けを見つける', schema.missingTabs(['名刺データ'], ['名刺データ', '変更履歴']).join(',') === '変更履歴');
    check('揃っていれば空', schema.missingTabs(['名刺データ', '変更履歴'], ['名刺データ', '変更履歴']).length === 0);
    check('前後の空白は無視する', schema.missingTabs([' 名刺データ '], ['名刺データ']).length === 0);
  }

  {
    /* 重複判定キー（FR-19）。 */
    check(
      'メールが最優先',
      schema.buildDuplicateKey({ email: 'A@Example.com', mobile: '090-1', companyName: 'X' }).key === 'email:a@example.com',
    );
    check('メールは小文字化して比べる', schema.buildDuplicateKey({ email: ' A@B.com ' }).key === 'email:a@b.com');
    check(
      'メールが無ければ携帯',
      schema.buildDuplicateKey({ mobile: '090-1234-5678', companyName: 'X' }).key === 'mobile:09012345678',
    );
    check(
      '番号は記号を落として数字だけで比べる',
      schema.buildDuplicateKey({ mobile: '+81 90 1234 5678' }).key === 'mobile:819012345678',
    );
    check(
      '連絡先が無ければ会社名＋氏名',
      schema.buildDuplicateKey({ companyName: '株式会社 見本', fullName: '見本 太郎' }).key === 'name:株式会社見本/見本太郎',
    );
    check(
      '**会社名＋氏名は確定に使わない（同姓同名がありうる）**',
      schema.buildDuplicateKey({ companyName: 'X', fullName: 'Y' }).strong === false,
    );
    check('メールは確定に使える', schema.buildDuplicateKey({ email: 'a@b.com' }).strong === true);
    check('何も無ければ空', schema.buildDuplicateKey({}).key === '');
    check('引数が無くても壊れない', schema.buildDuplicateKey().source === 'none');
  }

  {
    /* 行の組み立て。**列定義の順に、必ずサニタイズを通す。** */
    const row = schema.buildDataRow({
      record_id: 'R1',
      companyName: '=DANGER()',
      fullName: '見本 太郎',
      uncertainFields: ['jobTitle', 'fax'],
      hasBack: true,
      backFilledFields: ['email'],
      frontFileUrl: 'https://drive.google.com/file/d/F/view',
      backFileUrl: '',
    });

    const index = (header) => schema.headersOf(schema.DATA_COLUMNS).indexOf(header);

    check('列の数が定義と一致する', row.length === schema.DATA_COLUMNS.length);
    check(
      '**数式をそのまま入れない**',
      row[index('会社名')] === "'=DANGER()",
      row[index('会社名')],
    );
    check('配列は空白区切りにする', row[index('要確認項目')] === 'jobTitle fax');
    check('has_back は TRUE', row[index('has_back')] === 'TRUE');
    check(
      '画像リンクは数式として組み立てる',
      row[index('front_file_url')].startsWith('=HYPERLINK('),
      row[index('front_file_url')],
    );
    check('裏面のURLが空なら空欄', row[index('back_file_url')] === '');
    check(
      '**裏面が無くても列は詰めない（空欄で置く）**',
      row[index('back_image_hash')] === '' && row[index('back_file_id')] === '',
    );
    check('未指定の項目は空文字', row.every((value) => typeof value === 'string'));

    const noBack = schema.buildDataRow({ hasBack: false });
    check('has_back が false なら空欄（§11.2）', noBack[index('has_back')] === '');
  }

  /* ================================================================ */
  section('Sheets API（sheets.js）');

  const sheets = await import('../../public/production-app/card-ocr/sheets.js');

  {
    check('0 は A', sheets.columnLetter(0) === 'A');
    check('25 は Z', sheets.columnLetter(25) === 'Z');
    check('26 は AA', sheets.columnLetter(26) === 'AA', sheets.columnLetter(26));
    check('51 は AZ', sheets.columnLetter(51) === 'AZ', sheets.columnLetter(51));
    check('52 は BA', sheets.columnLetter(52) === 'BA', sheets.columnLetter(52));
    check('負でも壊れない', sheets.columnLetter(-1) === 'A');

    check(
      '**列が26を超えても扱える（v3.1 で面ごとに分けたため）**',
      schema.DATA_COLUMNS.length <= 26 || sheets.columnLetter(schema.DATA_COLUMNS.length - 1).length === 2,
      `列数 ${schema.DATA_COLUMNS.length} → ${sheets.columnLetter(schema.DATA_COLUMNS.length - 1)}`,
    );
  }

  check("タブ名を ' で囲む", sheets.quoteTabTitle('名刺データ') === "'名刺データ'");
  check("タブ名の ' を二重にする", sheets.quoteTabTitle("a'b") === "'a''b'");

  {
    /* 追記は USER_ENTERED（§11.2 の HYPERLINK のため）。 */
    const seen = [];

    const impl = async (url, options = {}) => {
      seen.push({ url: String(url), options });
      return { ok: true, status: 200, json: async () => ({ updates: { updatedRange: "'名刺データ'!A2:Z2" } }) };
    };

    await sheets.appendRow('SHEET-ID', '名刺データ', ['a', 'b'], { token: 'T', fetchImpl: impl });

    check(
      '**追記は USER_ENTERED**（RAW だと HYPERLINK が文字列のまま残る）',
      seen[0].url.includes('valueInputOption=USER_ENTERED'),
      seen[0].url,
    );
    check('行として挿入する', seen[0].url.includes('insertDataOption=INSERT_ROWS'));
    check('append を呼んでいる', seen[0].url.includes(':append'));
    check('送信先は Sheets API', seen[0].url.startsWith('https://sheets.googleapis.com/v4/spreadsheets/'));
  }

  {
    /* 見出しは静的なので RAW でよい。 */
    const seen = [];

    const impl = async (url) => {
      seen.push(String(url));
      return { ok: true, status: 200, json: async () => ({}) };
    };

    await sheets.writeHeader('SHEET-ID', '名刺データ', schema.DATA_COLUMNS, { token: 'T', fetchImpl: impl });

    check('見出しは RAW で書く（数式にならない）', seen[0].includes('valueInputOption=RAW'), seen[0]);
  }

  {
    /* 不足列は右端へ足す。既存列に触れない。 */
    const seen = [];

    const impl = async (url) => {
      seen.push(decodeURIComponent(String(url)));
      return { ok: true, status: 200, json: async () => ({}) };
    };

    await sheets.appendMissingColumns('S', '名刺データ', 5, schema.DATA_COLUMNS.slice(5), {
      token: 'T', fetchImpl: impl,
    });

    check('**6列目（F）から書き始める**', seen[0].includes("'名刺データ'!F1"), seen[0]);

    seen.length = 0;
    await sheets.appendMissingColumns('S', 'x', 0, [], { token: 'T', fetchImpl: impl });
    check('足すものが無ければ通信しない', seen.length === 0);
  }

  {
    /* 台帳の作成。タブを2つ作り、見出しを書き、フォルダへ移す。 */
    const calls = [];

    const impl = async (url, options = {}) => {
      const text = String(url);
      calls.push({ url: text, method: options.method ?? 'GET', body: options.body ?? null });

      if (text.startsWith('https://sheets.googleapis.com/v4/spreadsheets?')) {
        return { ok: true, status: 200, json: async () => ({ spreadsheetId: 'NEW-SHEET' }) };
      }

      return { ok: true, status: 200, json: async () => ({}) };
    };

    const id = await sheets.createSpreadsheet('FOLDER', { token: 'T', fetchImpl: impl });

    check('IDを返す', id === 'NEW-SHEET');

    const createBody = JSON.parse(calls[0].body);
    check('タイトルは 名刺管理', createBody.properties.title === '名刺管理');
    check('ロケールと時間帯を指定する', createBody.properties.locale === 'ja_JP' && createBody.properties.timeZone === 'Asia/Tokyo');
    check(
      '**タブを2つ作る（名刺データ / 変更履歴）**',
      createBody.sheets.map((s) => s.properties.title).join(',') === '名刺データ,変更履歴',
    );
    check('見出しを2タブぶん書く', calls.filter((c) => c.method === 'PUT').length === 2);
    check(
      '作成後にフォルダへ移す（spreadsheets.create は親を指定できない）',
      calls.some((c) => c.method === 'PATCH' && c.url.includes('addParents=FOLDER')),
    );
  }

  {
    /* 移動に失敗しても台帳は使える。全体を失敗にしない。 */
    const impl = async (url, options = {}) => {
      const text = String(url);

      if ((options.method ?? 'GET') === 'PATCH') {
        return { ok: false, status: 403, json: async () => ({}) };
      }

      if (text.startsWith('https://sheets.googleapis.com/v4/spreadsheets?')) {
        return { ok: true, status: 200, json: async () => ({ spreadsheetId: 'NEW-SHEET' }) };
      }

      return { ok: true, status: 200, json: async () => ({}) };
    };

    let id = null;
    try { id = await sheets.createSpreadsheet('F', { token: 'T', fetchImpl: impl }); } catch { id = null; }

    check('**フォルダへ移せなくても台帳は返す**', id === 'NEW-SHEET');
  }

  /* ================================================================ */
  section('保存構造の解決（drive-storage.js / FR-07）');

  const storage = await import('../../public/production-app/card-ocr/drive-storage.js');

  /* localStorage の代わり。テスト間で状態を持ち越さない。 */
  function installLocalStorage(initial = {}) {
    const map = new Map(Object.entries(initial));

    globalThis.localStorage = {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => { map.set(key, String(value)); },
      removeItem: (key) => { map.delete(key); },
    };

    return map;
  }

  function clearLocalStorage() {
    delete globalThis.localStorage;
  }

  check('IDの形を検査する', storage.isFileId('1a2B3c4D5e6F7g8H'));
  check('短すぎる値は弾く', !storage.isFileId('abc'));
  check('記号が混ざる値は弾く', !storage.isFileId('abc/def/ghi/jkl'));
  check('null は弾く', !storage.isFileId(null));

  {
    /*
     * 段階2を必ず通す。**キャッシュが空というだけでは作らない。**
     */
    installLocalStorage();
    const calls = [];

    const impl = async (url, options = {}) => {
      const text = String(url);
      calls.push({ url: text, method: options.method ?? 'GET' });

      if ((options.method ?? 'GET') === 'GET' && text.includes('?q=') === false && text.includes('&q=') === false) {
        /* files 一覧（検索）以外は空で返す。 */
      }

      if (text.includes('q=')) {
        return { ok: true, status: 200, json: async () => ({ files: [{ id: 'FOUND-1' }] }) };
      }

      return { ok: true, status: 200, json: async () => ({ id: 'X' }) };
    };

    const result = await storage.resolveFolder('TSAM AI', null, 'k', { token: 'T', fetchImpl: impl });

    check('検索で見つかればそれを使う', result.id === 'FOUND-1' && result.from === 'search');
    check('**作成していない**', !calls.some((c) => c.method === 'POST'));
    check('キャッシュへ書き戻す', globalThis.localStorage.getItem('k') === 'FOUND-1');

    clearLocalStorage();
  }

  {
    /* 見つからなければ作る。 */
    installLocalStorage();

    const impl = async (url) => {
      if (String(url).includes('q=')) {
        return { ok: true, status: 200, json: async () => ({ files: [] }) };
      }

      return { ok: true, status: 200, json: async () => ({ id: 'CREATED-1' }) };
    };

    const result = await storage.resolveFolder('TSAM AI', null, 'k', { token: 'T', fetchImpl: impl });

    check('見つからなければ作る', result.id === 'CREATED-1' && result.created === true);
    clearLocalStorage();
  }

  {
    /* キャッシュが有効なら検索しない。 */
    installLocalStorage({ k: '1a2B3c4D5e6F7g8H' });
    const calls = [];

    const impl = async (url) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: '1a2B3c4D5e6F7g8H',
          name: 'TSAM AI',
          mimeType: 'application/vnd.google-apps.folder',
          parents: [],
          trashed: false,
        }),
      };
    };

    const result = await storage.resolveFolder('TSAM AI', null, 'k', { token: 'T', fetchImpl: impl });

    check('キャッシュをそのまま使う', result.from === 'cache');
    check('検索していない', !calls.some((url) => url.includes('q=')));
    clearLocalStorage();
  }

  {
    /* キャッシュが別のものを指していたら捨てて探し直す。 */
    installLocalStorage({ k: '1a2B3c4D5e6F7g8H' });

    const impl = async (url) => {
      const text = String(url);

      if (text.includes('q=')) {
        return { ok: true, status: 200, json: async () => ({ files: [{ id: 'FOUND-2' }] }) };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: '1a2B3c4D5e6F7g8H',
          /* 名前が違う＝別のフォルダを指している。 */
          name: 'まったく別のフォルダ',
          mimeType: 'application/vnd.google-apps.folder',
          trashed: false,
        }),
      };
    };

    const result = await storage.resolveFolder('TSAM AI', null, 'k', { token: 'T', fetchImpl: impl });

    check('**名前が違えばキャッシュを捨てる**', result.from === 'search' && result.id === 'FOUND-2');
    clearLocalStorage();
  }

  {
    /* ゴミ箱に入っていても捨てる。 */
    installLocalStorage({ k: '1a2B3c4D5e6F7g8H' });

    const impl = async (url) => {
      if (String(url).includes('q=')) {
        return { ok: true, status: 200, json: async () => ({ files: [{ id: 'FOUND-3' }] }) };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: '1a2B3c4D5e6F7g8H',
          name: 'TSAM AI',
          mimeType: 'application/vnd.google-apps.folder',
          trashed: true,
        }),
      };
    };

    const result = await storage.resolveFolder('TSAM AI', null, 'k', { token: 'T', fetchImpl: impl });
    check('ゴミ箱のIDは使わない', result.id === 'FOUND-3');
    clearLocalStorage();
  }

  {
    /*
     * **401 と 403 ではキャッシュを捨てない。**
     * 認可の問題やレート制限で捨てると、復旧したときに重複して作る。
     */
    for (const status of [401, 403, 500]) {
      installLocalStorage({ k: '1a2B3c4D5e6F7g8H' });

      const impl = async () => ({ ok: false, status, json: async () => ({}) });

      let caught = null;
      try {
        await storage.resolveFolder('TSAM AI', null, 'k', { token: 'T', fetchImpl: impl });
      } catch (error) { caught = error; }

      check(`${status} は投げ返す`, caught !== null);
      check(
        `**${status} でキャッシュを捨てない**`,
        globalThis.localStorage.getItem('k') === '1a2B3c4D5e6F7g8H',
      );

      clearLocalStorage();
    }
  }

  {
    /* 404 なら捨てて探し直す。実体が消えているため。 */
    installLocalStorage({ k: '1a2B3c4D5e6F7g8H' });

    const impl = async (url, options = {}) => {
      const text = String(url);

      if (text.includes('q=')) {
        return { ok: true, status: 200, json: async () => ({ files: [] }) };
      }

      if ((options.method ?? 'GET') === 'POST') {
        return { ok: true, status: 200, json: async () => ({ id: 'REMADE' }) };
      }

      /* キャッシュしたIDの実体が消えている。 */
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const result = await storage.resolveFolder('TSAM AI', null, 'k', { token: 'T', fetchImpl: impl });

    check('404 なら作り直しへ進む', result.created === true && result.id === 'REMADE');
    check('新しいIDでキャッシュを置き換える', globalThis.localStorage.getItem('k') === 'REMADE');
    clearLocalStorage();
  }

  {
    /* 既存シートの健全性。**改変されていたら書き込みを止める。** */
    installLocalStorage();
    const expected = schema.headersOf(schema.DATA_COLUMNS);

    const makeImpl = (header) => async (url, options = {}) => {
      const text = String(url);

      if (text.includes('/values/') && (options.method ?? 'GET') === 'GET') {
        return { ok: true, status: 200, json: async () => ({ values: [header] }) };
      }

      if (text.includes('fields=sheets')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sheets: [
              { properties: { sheetId: 0, title: '名刺データ' } },
              { properties: { sheetId: 1, title: '変更履歴' } },
            ],
          }),
        };
      }

      return { ok: true, status: 200, json: async () => ({}) };
    };

    const ok = await storage.inspectSpreadsheet('S', { token: 'T', fetchImpl: makeImpl(expected) });
    check('揃っていれば書き込める', ok.writable === true && ok.notices.length === 0);

    const altered = [expected[1], expected[0], ...expected.slice(2)];
    const blocked = await storage.inspectSpreadsheet('S', { token: 'T', fetchImpl: makeImpl(altered) });

    check('**列が改変されていたら書き込みを止める**', blocked.writable === false);
    check('理由を返す', blocked.notices.includes(storage.StorageNotice.SCHEMA_ALTERED));

    const upgraded = await storage.inspectSpreadsheet('S', { token: 'T', fetchImpl: makeImpl(expected.slice(0, 5)) });
    check('足りないだけなら足して続ける', upgraded.writable === true);
    check('足したことを伝える', upgraded.notices.includes(storage.StorageNotice.SCHEMA_UPGRADED));

    clearLocalStorage();
  }

  {
    /* タブが欠けていたら作り直す。 */
    installLocalStorage();
    const created = [];

    const impl = async (url, options = {}) => {
      const text = String(url);

      if (text.includes(':batchUpdate')) {
        created.push(JSON.parse(options.body).requests.map((r) => r.addSheet.properties.title));
        return { ok: true, status: 200, json: async () => ({}) };
      }

      if (text.includes('/values/') && (options.method ?? 'GET') === 'GET') {
        return { ok: true, status: 200, json: async () => ({ values: [schema.headersOf(schema.DATA_COLUMNS)] }) };
      }

      if (text.includes('fields=sheets')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ sheets: [{ properties: { sheetId: 0, title: '名刺データ' } }] }),
        };
      }

      return { ok: true, status: 200, json: async () => ({}) };
    };

    const result = await storage.inspectSpreadsheet('S', { token: 'T', fetchImpl: impl });

    check('欠けたタブを作る', created.flat().join(',') === '変更履歴', created.flat().join(','));
    check('作り直したことを伝える', result.notices.includes(storage.StorageNotice.TABS_REPAIRED));
    check('書き込みは続けられる', result.writable === true);

    clearLocalStorage();
  }

  {
    /* まとめて用意する。2回目に重複作成しないこと。 */
    installLocalStorage();
    let creates = 0;

    const impl = async (url, options = {}) => {
      const text = String(url);
      const method = options.method ?? 'GET';

      if (text.includes('q=')) {
        return { ok: true, status: 200, json: async () => ({ files: [] }) };
      }

      if (text.startsWith('https://sheets.googleapis.com/v4/spreadsheets?')) {
        creates += 1;
        return { ok: true, status: 200, json: async () => ({ spreadsheetId: 'SHEET-1' }) };
      }

      if (method === 'POST' && text.startsWith('https://www.googleapis.com/drive/v3/files?')) {
        creates += 1;
        return { ok: true, status: 200, json: async () => ({ id: `FOLDER-${creates}` }) };
      }

      return { ok: true, status: 200, json: async () => ({}) };
    };

    const first = await storage.ensureStorage({ token: 'T', fetchImpl: impl });

    check('フォルダ3つと台帳を作る', creates === 4, String(creates));
    check('**初回として扱う**', first.firstRun === true);
    check('作成を伝える', first.notices.includes(storage.StorageNotice.CREATED));
    check('書き込める', first.writable === true);
    check('4か所のIDを返す', Boolean(first.appFolderId && first.imageFolderId && first.spreadsheetId));

    clearLocalStorage();
  }

  {
    /* フォルダはあるのに台帳だけ消えていたら「作り直し」。 */
    installLocalStorage();

    const impl = async (url, options = {}) => {
      const text = String(url);
      const method = options.method ?? 'GET';

      if (text.includes('q=')) {
        /* フォルダは見つかるが、スプレッドシートは見つからない。 */
        const isSheet = text.includes(encodeURIComponent('application/vnd.google-apps.spreadsheet'));
        return { ok: true, status: 200, json: async () => ({ files: isSheet ? [] : [{ id: 'EXISTING' }] }) };
      }

      if (text.startsWith('https://sheets.googleapis.com/v4/spreadsheets?')) {
        return { ok: true, status: 200, json: async () => ({ spreadsheetId: 'SHEET-2' }) };
      }

      if (method === 'POST' && text.startsWith('https://www.googleapis.com/drive/v3/files?')) {
        return { ok: true, status: 200, json: async () => ({ id: 'NEW-FOLDER' }) };
      }

      return { ok: true, status: 200, json: async () => ({}) };
    };

    const result = await storage.ensureStorage({ token: 'T', fetchImpl: impl });

    check('**「作り直し」として伝える**', result.notices.includes(storage.StorageNotice.RECREATED));
    check('初回とは呼ばない', result.firstRun === false);

    clearLocalStorage();
  }

  /* ================================================================ */
  section('画像の前処理（capture.js / §8.2・FR-05）');

  const capture = await import('../../public/production-app/card-ocr/capture.js');

  {
    /* §8.2 と §20 の数値。**ここを緩めない。** */
    check('上限は 1.5MB', capture.MAX_BYTES === 1.5 * 1024 * 1024);
    check('長辺の上限は 2000（§20）', capture.MAX_EDGE === 2000);
    check('**長辺は 1600 を下回らない（§8.2）**', capture.MIN_EDGE === 1600);
    check('**品質は 0.75 を下回らない（§8.2）**', capture.MIN_QUALITY === 0.75);
    check('品質の上限は 0.85', capture.MAX_QUALITY === 0.85);

    check(
      '圧縮の手順が下限を割らない',
      capture.COMPRESSION_STEPS.every(
        (step) => step.maxEdge >= capture.MIN_EDGE && step.quality >= capture.MIN_QUALITY,
      ),
    );
    check(
      '**品質を先に落とし、寸法は後で落とす**',
      capture.COMPRESSION_STEPS[0].maxEdge === capture.MAX_EDGE
        && capture.COMPRESSION_STEPS[1].maxEdge === capture.MAX_EDGE
        && capture.COMPRESSION_STEPS[1].quality < capture.COMPRESSION_STEPS[0].quality,
    );
    check('最初の段は最大品質', capture.COMPRESSION_STEPS[0].quality === capture.MAX_QUALITY);
    check(
      '最後の段は下限',
      capture.COMPRESSION_STEPS.at(-1).maxEdge === capture.MIN_EDGE
        && capture.COMPRESSION_STEPS.at(-1).quality === capture.MIN_QUALITY,
    );
    check(
      'accept は JPEG と PNG のみ',
      capture.ACCEPT_ATTRIBUTE === 'image/jpeg,image/png',
      capture.ACCEPT_ATTRIBUTE,
    );
  }

  {
    /* 受け入れの判定。 */
    check('JPEG は通す', capture.checkFile({ type: 'image/jpeg', name: 'a.jpg' }) === null);
    check('PNG は通す', capture.checkFile({ type: 'image/png', name: 'a.png' }) === null);
    check(
      'GIF は弾く',
      capture.checkFile({ type: 'image/gif', name: 'a.gif' }) === capture.CaptureErrorCode.NOT_SUPPORTED,
    );
    check('ファイルが無ければ NO_FILE', capture.checkFile(null) === capture.CaptureErrorCode.NO_FILE);

    check(
      'HEIC を種別で見分ける',
      capture.checkFile({ type: 'image/heic', name: 'a.heic' }) === capture.CaptureErrorCode.HEIC,
    );
    check(
      '**type が空でも拡張子で HEIC を見分ける（iOS Safari 対策）**',
      capture.checkFile({ type: '', name: 'IMG_0001.HEIC' }) === capture.CaptureErrorCode.HEIC,
    );
    check(
      'HEIF も同じ扱い',
      capture.checkFile({ type: '', name: 'a.heif' }) === capture.CaptureErrorCode.HEIC,
    );
    check(
      '**type が空でも HEIC でなければ通す（iOS Safari が空で渡す）**',
      capture.checkFile({ type: '', name: 'IMG_0001.JPG' }) === null,
    );
  }

  {
    /* 案内。§15 のコードに収める。 */
    const allowed = new Set(['IMG-001', 'IMG-002', 'IMG-003']);

    for (const code of Object.values(capture.CaptureErrorCode)) {
      const described = capture.describeCaptureError(new capture.CaptureError(code, 'd'));
      check(`${code} の errorCode が §15 の範囲`, allowed.has(described.errorCode), described.errorCode);
      check(`${code} に文言がある`, described.text.length > 0);
    }

    const heic = capture.describeCaptureError(new capture.CaptureError(capture.CaptureErrorCode.HEIC));
    check(
      '**HEIC は解決する道まで案内する**',
      heic.text.includes('撮り直す') && heic.text.includes('互換性優先'),
      heic.text,
    );

    const large = capture.describeCaptureError(new capture.CaptureError(capture.CaptureErrorCode.TOO_LARGE));
    check('容量超過は IMG-002', large.errorCode === 'IMG-002');
    check('撮り直しを案内する', large.text.includes('撮り直して'));

    check(
      'CaptureError でない例外も握りつぶさない',
      capture.describeCaptureError(new TypeError('boom')).detail.includes('boom'),
    );
  }

  {
    /* 寸法。 */
    check('長辺が上限以下ならそのまま', JSON.stringify(capture.fitSize(1200, 800, 2000)) === '{"width":1200,"height":800}');
    check('横長を縮める', JSON.stringify(capture.fitSize(4000, 2000, 2000)) === '{"width":2000,"height":1000}');
    check('縦長を縮める', JSON.stringify(capture.fitSize(2000, 4000, 2000)) === '{"width":1000,"height":2000}');
    check('**元より大きく引き伸ばさない**', capture.fitSize(800, 600, 2000).width === 800);
    check('0 でも壊れない', capture.fitSize(0, 0, 2000).width === 0);

    check('回転は90度単位に丸める', capture.normalizeRotation(100) === 90);
    check('360 は 0', capture.normalizeRotation(360) === 0);
    check('負の回転も正へ', capture.normalizeRotation(-90) === 270);
    check('数値でなければ 0', capture.normalizeRotation('x') === 0);

    check(
      '90度で縦横が入れ替わる',
      JSON.stringify(capture.rotatedSize(2000, 1000, 90)) === '{"width":1000,"height":2000}',
    );
    check(
      '180度では入れ替わらない',
      JSON.stringify(capture.rotatedSize(2000, 1000, 180)) === '{"width":2000,"height":1000}',
    );
  }

  {
    /* ファイル名（§FR-07）。 */
    const at = new Date(2026, 7, 4, 9, 5, 3);

    check(
      '日時＋会社名＋氏名＋面',
      capture.buildImageFileName({ at, companyName: 'サンプル商事', fullName: '見本 太郎', side: 'front' })
        === '20260804_090503_サンプル商事_見本 太郎_front.jpg',
      capture.buildImageFileName({ at, companyName: 'サンプル商事', fullName: '見本 太郎', side: 'front' }),
    );
    check(
      '**表面にも接尾辞を必ず付ける（v3.1）**',
      capture.buildImageFileName({ at, companyName: 'X', fullName: 'Y' }).endsWith('_front.jpg'),
    );
    check(
      '裏面は _back',
      capture.buildImageFileName({ at, companyName: 'X', fullName: 'Y', side: 'back' }).endsWith('_back.jpg'),
    );
    check(
      '会社名も氏名も無ければ UNCLASSIFIED',
      capture.buildImageFileName({ at, fallbackId: 'abc123' }) === '20260804_090503_UNCLASSIFIED_abc123_front.jpg',
      capture.buildImageFileName({ at, fallbackId: 'abc123' }),
    );
    check(
      '使えない記号を落とす',
      !capture.buildImageFileName({ at, companyName: 'A/B:C*', fullName: 'D' }).includes('/'),
    );
    check(
      '一時IDも無ければ unknown',
      capture.buildImageFileName({ at }).includes('UNCLASSIFIED_unknown'),
    );

    const ym = capture.yearMonthPath(at);
    check('年月フォルダは 2026 / 08', ym.year === '2026' && ym.month === '08');
  }

  /* ================================================================ */
  section('両面の撮影フロー（capture-flow.js / FR-03・FR-04）');

  const flow = await import('../../public/production-app/card-ocr/capture-flow.js');

  {
    const empty = flow.createCaptureState();

    check('最初は表面を撮る', flow.currentStep(empty) === flow.CaptureStep.FRONT);
    check('表面も裏面も持たない', empty.front === null && empty.back === null);
    check(
      '**裏面の回答は未回答（null）で始まる**',
      empty.wantsBack === null,
    );

    const withFront = flow.setFront(empty, { dataUrl: 'x' });
    check('表面を入れると裏面を尋ねる', flow.currentStep(withFront) === flow.CaptureStep.ASK_BACK);
    check('元の状態を書き換えない', empty.front === null);

    const skipped = flow.skipBack(withFront);
    check('「裏面なし」で準備完了', flow.currentStep(skipped) === flow.CaptureStep.READY);
    check('has_back は false', flow.hasBack(skipped) === false);

    const wanted = flow.wantBack(withFront);
    check('「裏面も読む」で裏面の撮影へ', flow.currentStep(wanted) === flow.CaptureStep.BACK);

    const withBack = flow.setBack(wanted, { dataUrl: 'y' });
    check('裏面を入れると準備完了', flow.currentStep(withBack) === flow.CaptureStep.READY);
    check('has_back は true', flow.hasBack(withBack) === true);

    check(
      '裏面を直接入れても「裏面あり」になる',
      flow.setBack(withFront, { dataUrl: 'y' }).wantsBack === true,
    );
  }

  {
    /* 取り消し。 */
    const both = flow.setBack(flow.wantBack(flow.setFront(flow.createCaptureState(), { dataUrl: 'x' })), { dataUrl: 'y' });

    const backCleared = flow.clearBack(both);
    check('裏面を取り消すと画像が消える', backCleared.back === null);
    check(
      '**回答も戻す（「裏面なしで進む」を選び直せる）**',
      backCleared.wantsBack === null && flow.currentStep(backCleared) === flow.CaptureStep.ASK_BACK,
    );
    check('表面は残る', backCleared.front !== null);

    const allCleared = flow.clearAll();
    check(
      '**表面を取り消すと裏面も捨てる**',
      allCleared.front === null && allCleared.back === null,
    );
    check('最初の状態に戻る', flow.currentStep(allCleared) === flow.CaptureStep.FRONT);
  }

  {
    /* 表面だけ差し替えても、裏面の回答は保つ（§FR-04）。 */
    const skipped = flow.skipBack(flow.setFront(flow.createCaptureState(), { dataUrl: 'x' }));
    const replaced = flow.setFront(skipped, { dataUrl: 'x2' });

    check(
      '**表面を撮り直しても裏面の回答をやり直させない**',
      replaced.wantsBack === false && flow.currentStep(replaced) === flow.CaptureStep.READY,
    );
  }

  {
    /* 画面の言葉。 */
    for (const step of Object.values(flow.CaptureStep)) {
      const described = flow.describeStep(step);
      check(`${step}: 見出しがある`, described.title.length > 0);
      check(`${step}: 説明がある`, described.text.length > 0);
    }

    check(
      '裏面を尋ねる文で、不要な場合の判断材料を示す',
      flow.describeStep(flow.CaptureStep.ASK_BACK).text.includes('空白'),
    );
  }

  /* ================================================================ */
  section('Drive OCR（drive-ocr.js / FR-08）');

  const ocr = await import('../../public/production-app/card-ocr/drive-ocr.js');

  /*
   * 面ごとに返すテキストを変えられるスタブ。
   *
   * front / back は試行順の配列。空文字を混ぜると再試行の挙動を確かめられる。
   * **fetch は必ずスタブする。実APIへ通信しない。**
   */
  function makeSideAwareStub({ front = ['表面のテキスト'], back = ['裏面のテキスト'], deleteOk = true, backUploadFails = false } = {}) {
    const uploads = [];
    const deletes = [];
    const sideOf = new Map();
    const seen = { front: 0, back: 0 };

    const impl = async (url, options = {}) => {
      const text = String(url);
      const method = options.method ?? 'GET';

      if (text.startsWith('https://www.googleapis.com/upload/drive/v3/files')) {
        /* metadata は multipart 本文の中にある。Blob から読む。 */
        const bodyText = await options.body.text();
        const side = /card-ocr-temp-back-/.test(bodyText) ? 'back' : 'front';

        if (side === 'back' && backUploadFails) {
          return { ok: false, status: 500, json: async () => ({}) };
        }

        seen[side] += 1;
        const id = `${side}-${seen[side]}`;
        sideOf.set(id, side);
        uploads.push({ side, id, bodyText });

        return { ok: true, status: 200, json: async () => ({ id }) };
      }

      if (text.includes('/export?')) {
        const id = decodeURIComponent(/files\/([^/]+)\/export/.exec(text)?.[1] ?? '');
        const side = sideOf.get(id) ?? 'front';
        const list = side === 'back' ? back : front;
        const index = Number(id.split('-')[1] ?? 1) - 1;

        return { ok: true, status: 200, text: async () => (list[index] ?? '') };
      }

      if (method === 'DELETE') {
        deletes.push(decodeURIComponent(/files\/([^?]+)$/.exec(text)?.[1] ?? ''));
        return deleteOk
          ? { ok: true, status: 204, json: async () => ({}) }
          : { ok: false, status: 500, json: async () => ({}) };
      }

      return { ok: true, status: 200, json: async () => ({ files: [] }) };
    };

    return { impl, uploads, deletes };
  }

  {
    /* 定数と文言。 */
    check('OCR言語は ja（FR-08 の5）', ocr.OCR_LANGUAGE === 'ja');
    check('空のときの再試行は最大3回（FR-08 の3）', ocr.MAX_OCR_ATTEMPTS === 3);
    check(
      '**一時ドキュメントの接頭辞が検証ページと違う**',
      ocr.TEMP_DOC_PREFIX === 'card-ocr-temp-' && !ocr.TEMP_DOC_PREFIX.includes('poc'),
      ocr.TEMP_DOC_PREFIX,
    );
    check(
      '一時ドキュメント名に面が入る（表裏を同時に走らせるため）',
      ocr.buildTempDocName('back', 1, 2) === 'card-ocr-temp-back-1-2',
      ocr.buildTempDocName('back', 1, 2),
    );

    const empty = ocr.describeOcrError(new ocr.OcrError(ocr.OcrErrorCode.EMPTY, 'x'));
    check('空は OCR-002', empty.errorCode === 'OCR-002');
    check('それ以外は OCR-001', ocr.describeOcrError(new Error('x')).errorCode === 'OCR-001');
    check('OcrError でない例外も握りつぶさない', ocr.describeOcrError(new TypeError('boom')).detail.includes('boom'));
  }

  {
    /* 1枚の読み取り。upload → export → delete。 */
    const stub = makeSideAwareStub();
    const result = await ocr.ocrImage({
      token: 'T', blob: new Blob(['x'], { type: 'image/jpeg' }), fetchImpl: stub.impl, parentId: 'FOLDER',
    });

    check('テキストを返す', result.text === '表面のテキスト');
    check('1回で成功', result.attempts === 1);
    check('一時ドキュメントを消した', result.deleted === true && stub.deletes.length === 1);

    check(
      '**保存先フォルダの中に作る（FR-08 の1）**',
      stub.uploads[0].bodyText.includes('"parents":["FOLDER"]'),
    );
    check(
      'Google ドキュメントへ変換する（＝OCRが走る）',
      stub.uploads[0].bodyText.includes('application/vnd.google-apps.document'),
    );
  }

  {
    /* 空なら最大3回やり直す。**やり直すたびに一時ドキュメントを消す。** */
    const stub = makeSideAwareStub({ front: ['', '', '3回目のテキスト'] });
    const result = await ocr.ocrImage({ token: 'T', blob: new Blob(['x']), fetchImpl: stub.impl });

    check('3回目で成功する', result.text === '3回目のテキスト' && result.attempts === 3);
    check('**毎回の一時ドキュメントを消している**', stub.deletes.length === 3, String(stub.deletes.length));
  }

  {
    /* 3回とも空なら OCR-002。 */
    const stub = makeSideAwareStub({ front: ['', '', ''] });

    let caught = null;
    try {
      await ocr.ocrImage({ token: 'T', blob: new Blob(['x']), fetchImpl: stub.impl });
    } catch (error) { caught = error; }

    check('3回とも空なら投げる', caught?.code === ocr.OcrErrorCode.EMPTY);
    check('画面表示は OCR-002', ocr.describeOcrError(caught).errorCode === 'OCR-002');
    check('**失敗しても一時ドキュメントは全部消す**', stub.deletes.length === 3);
    check('空白だけも空とみなす', true);
  }

  {
    /* 空白だけのテキストも「空」として扱う。 */
    const stub = makeSideAwareStub({ front: ['   \n  ', 'ちゃんとしたテキスト'] });
    const result = await ocr.ocrImage({ token: 'T', blob: new Blob(['x']), fetchImpl: stub.impl });

    check('空白だけならやり直す', result.attempts === 2);
  }

  {
    /* エクスポートが失敗しても削除する（finally）。 */
    const stub = makeSideAwareStub();
    let deleted = 0;

    const impl = async (url, options = {}) => {
      const text = String(url);

      if (text.includes('/export?')) {
        return { ok: false, status: 500, json: async () => ({}) };
      }

      if ((options.method ?? 'GET') === 'DELETE') {
        deleted += 1;
        return { ok: true, status: 204, json: async () => ({}) };
      }

      return stub.impl(url, options);
    };

    let caught = null;
    try {
      await ocr.ocrImage({ token: 'T', blob: new Blob(['x']), fetchImpl: impl });
    } catch (error) { caught = error; }

    check('エクスポート失敗は投げ返す', caught !== null);
    check('**エクスポートが失敗しても削除する（finally）**', deleted === 1);
  }

  {
    /* 削除に失敗しても全体は失敗にしない。 */
    const stub = makeSideAwareStub({ deleteOk: false });
    const result = await ocr.ocrImage({ token: 'T', blob: new Blob(['x']), fetchImpl: stub.impl });

    check('削除失敗でも読み取りは成功', result.text === '表面のテキスト');
    check('消せなかったことを返す', result.deleted === false);
  }

  {
    /* 両面。並列で走らせ、両方の結果を返す。 */
    const stub = makeSideAwareStub();
    const result = await ocr.ocrBothSides({
      token: 'T',
      front: new Blob(['f']),
      back: new Blob(['b']),
      fetchImpl: stub.impl,
    });

    check('表面を読む', result.front.text === '表面のテキスト');
    check('裏面を読む', result.back.text === '裏面のテキスト');
    check('裏面のエラーは無い', result.backError === null);
    check('両面ぶん消した', stub.deletes.length === 2);
    check('面ごとに名前を分けている', stub.uploads.map((u) => u.side).sort().join(',') === 'back,front');
  }

  {
    /* 裏面が無ければ表面だけ。 */
    const stub = makeSideAwareStub();
    const result = await ocr.ocrBothSides({ token: 'T', front: new Blob(['f']), fetchImpl: stub.impl });

    check('裏面は null', result.back === null);
    check('裏面のエラーも無い', result.backError === null);
    check('一時ドキュメントは1つだけ', stub.deletes.length === 1);
  }

  {
    /*
     * **裏面が失敗しても全体を失敗にしない（FR-08 の7）。**
     * 裏面は補助である。
     */
    const stub = makeSideAwareStub({ back: ['', '', ''] });
    const result = await ocr.ocrBothSides({
      token: 'T', front: new Blob(['f']), back: new Blob(['b']), fetchImpl: stub.impl,
    });

    check('**表面の結果は返る**', result.front.text === '表面のテキスト');
    check('裏面は null', result.back === null);
    check('**裏面の失敗を握って伝える**', result.backError?.code === ocr.OcrErrorCode.EMPTY);
  }

  {
    /* 裏面の通信が落ちた場合も同じ。 */
    const stub = makeSideAwareStub({ backUploadFails: true });
    const result = await ocr.ocrBothSides({
      token: 'T', front: new Blob(['f']), back: new Blob(['b']), fetchImpl: stub.impl,
    });

    check('表面は成功する', result.front.text === '表面のテキスト');
    check('裏面の失敗を握る', result.backError !== null);
  }

  {
    /* **表面の失敗は全体の失敗。** */
    const stub = makeSideAwareStub({ front: ['', '', ''] });

    let caught = null;
    try {
      await ocr.ocrBothSides({
        token: 'T', front: new Blob(['f']), back: new Blob(['b']), fetchImpl: stub.impl,
      });
    } catch (error) { caught = error; }

    check('**表面が読めなければ全体を失敗にする**', caught?.code === ocr.OcrErrorCode.EMPTY);
  }

  {
    /* 表裏の結合。面の区切りを明示する。 */
    check('裏面が無ければ表面だけ', ocr.joinSides('おもて') === 'おもて');
    check('空白だけの裏面も無いものとして扱う', ocr.joinSides('おもて', '  ') === 'おもて');
    check(
      '**面の区切りを明示する（Gemini に1回で渡すため）**',
      ocr.joinSides('おもて', 'うら') === '【表面】\nおもて\n\n【裏面】\nうら',
      JSON.stringify(ocr.joinSides('おもて', 'うら')),
    );
    check('null でも壊れない', ocr.joinSides(null, null) === '');
  }

  {
    /* 孤児回収。**接頭辞で始まるものだけを消す。** */
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
            { id: 'a', name: `${ocr.TEMP_DOC_PREFIX}front-1-1` },
            { id: 'b', name: `${ocr.TEMP_DOC_PREFIX}back-1-1` },
            { id: 'c', name: '利用者の大切な資料' },
            /* 検証ページ（poc/）のもの。**消さない。** */
            { id: 'd', name: 'card-ocr-poc-temp-front-1-1' },
          ],
        }),
      };
    };

    const result = await ocr.collectOrphanTempDocs({ token: 'T', fetchImpl: impl });

    check('孤児を2件見つける', result.found === 2, String(result.found));
    check('2件とも削除する', result.deleted === 2);
    check('**利用者のファイルを消さない**', !deletedIds.includes('c'));
    check(
      '**検証ページの一時ファイルを消さない（接頭辞が違う）**',
      !deletedIds.includes('d'),
      deletedIds.join(','),
    );
  }

  /* ================================================================ */
  section('ソース検査（守るべき制約）');

  const FILES = [
    'config.js', 'gis-loader.js', 'drive-auth.js', 'drive-api.js',
    'prerequisites.js', 'sanitize.js', 'hash.js', 'schema.js',
    'sheets.js', 'drive-storage.js', 'capture.js', 'capture-flow.js',
    'drive-ocr.js', 'app.js',
  ];
  const sources = [];

  for (const name of FILES) {
    sources.push({ name, text: await readFile(new URL(name, APP_DIR), 'utf8') });
  }

  for (const { name, text } of sources) {
    check(
      `${name}: localStorage を直接触っていない（keystore-spec §2-1）`,
      !/localStorage\s*[.[]/.test(text),
    );
    check(
      `${name}: sessionStorage を使っていない`,
      !/sessionStorage\s*[.[]/.test(text),
    );
    check(
      `${name}: テスト環境（apps/）から import していない`,
      !/from\s+['"][^'"]*\/apps\//.test(text),
    );
    check(
      `${name}: **検証用PoC（poc/）から import していない**`,
      !/from\s+['"][^'"]*\/poc\//.test(text),
    );
    check(
      `${name}: 別の本番アプリから import していない（§4-1）`,
      !/from\s+['"][^'"]*receipt-ocr\//.test(text),
    );
    check(
      `${name}: console へ出していない`,
      !/console\.(log|error|warn|info)/.test(text),
    );
    check(
      `${name}: innerHTML を使っていない（§14.3）`,
      !/\.(inner|outer)HTML|insertAdjacentHTML|document\.write/.test(text),
    );
  }

  check(
    'クライアントIDの定義は config.js の1箇所だけ',
    sources.filter(({ text }) => /GOOGLE_CLIENT_ID\s*=\s*['"]/.test(text)).length === 1,
  );
  check(
    'スコープの定義は config.js の1箇所だけ',
    sources.filter(({ text }) => /DRIVE_SCOPE\s*=\s*['"]/.test(text)).length === 1,
  );
  check(
    'エンドポイントの定義は config.js の1箇所だけ',
    sources.filter(({ text }) => /DRIVE_FILES_ENDPOINT\s*=\s*['"]/.test(text)).length === 1,
  );

  /*
   * 許可された外部ホスト以外がソースに現れないこと。
   *
   * accounts.google.com は docs/external-dependency-approvals.md で
   * 承認済みの GIS 配信元。
   * tsam-ai.com は当社自身のオリジンで、外部通信先ではない。
   */
  const allowedHosts = [
    /* §12 が許す通信先。generativelanguage はフェーズ2で足す。 */
    'www.googleapis.com',
    'sheets.googleapis.com',
    /* GIS の配信元（docs/external-dependency-approvals.md）。 */
    'accounts.google.com',
    /*
     * 利用者が**クリックして開くリンク**の宛先であって、
     * fetch の宛先ではない。§12 の「呼び出す外部API」には当たらない。
     */
    'docs.google.com',
    'drive.google.com',
    /* 当社自身のオリジン。 */
    'tsam-ai.com',
  ];

  for (const { name, text } of sources) {
    const hosts = [...text.matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]);
    const unexpected = hosts.filter((host) => !allowedHosts.includes(host));

    check(
      `${name}: 許可されていない外部ホストがソースに無い`,
      unexpected.length === 0,
      unexpected.join(', '),
    );
  }

  /*
   * 403 でトークンを捨てる経路を作らない。
   * （docs/receipt-ocr-findings-20260804.md #2）
   */
  const authSource = sources.find(({ name }) => name === 'drive-auth.js').text;

  check(
    '**403 を認可エラーとして扱う記述が drive-auth.js に無い**',
    !/403/.test(authSource.replace(/\/\*[\s\S]*?\*\//g, '')),
  );

  {
    /*
     * **検査対象の一覧が実ファイルと一致していること。**
     * 新しいモジュールを足したのに、ここへ書き忘れると
     * 上のすべての検査をすり抜ける。
     */
    const entries = await readdir(APP_DIR);
    const actual = entries.filter((name) => name.endsWith('.js')).sort();

    check(
      '検査対象の一覧が実ファイルと一致している',
      actual.join(',') === [...FILES].sort().join(','),
      `実際: ${actual.join(',')}`,
    );
    check('すべて読めている', sources.every(({ text }) => text.length > 0));
  }

  finish();
} catch (error) {
  fatal(error);
}

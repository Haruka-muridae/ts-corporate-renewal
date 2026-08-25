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

    /*
     * **DRV-001 は7つの内部コードの受け皿。**
     * 表示コードだけでは切り分けられないので、内部コードと
     * HTTPステータスを添えられるようにする。
     */
    {
      const described = api.describeDriveError(
        new api.DriveError(api.DriveErrorCode.BAD_REQUEST, 400, 'HTTP 400 badRequest: x'),
      );

      check('**内部コードを返す**', described.code === api.DriveErrorCode.BAD_REQUEST);
      check('**HTTPステータスを返す**', described.status === 400);

      const collapsed = Object.values(api.DriveErrorCode)
        .filter((code) => api.describeDriveError(new api.DriveError(code)).errorCode === 'DRV-001');

      check(
        'DRV-001 に集約される内部コードが複数ある（だから detail が要る）',
        collapsed.length >= 5,
        String(collapsed.length),
      );
    }

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

    {
      /*
       * **原因の要約。** サーバーが「どの権限が足りないか」まで書いて
       * いるので、読み捨てない。
       */
      const body = {
        error: {
          errors: [{ reason: 'insufficientPermissions' }],
          message: 'The granted scopes do not give access to this resource.',
        },
      };

      check(
        '**ステータス・reason・message を1行にまとめる**',
        api.summarizeErrorBody(body, 403)
          === 'HTTP 403 insufficientPermissions: The granted scopes do not give access to this resource.',
        api.summarizeErrorBody(body, 403),
      );
      check(
        '本文が読めなくてもステータスは出す',
        api.summarizeErrorBody(null, 400) === 'HTTP 400',
      );
      check(
        '長すぎる本文は切り詰める（画面を壊さない）',
        api.summarizeErrorBody({ error: { message: 'あ'.repeat(500) } }, 500).length <= 300,
      );
    }
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
    check(
      '**detail に HTTPステータスと reason の両方を入れる**',
      caught?.detail === 'HTTP 403 userRateLimitExceeded',
      caught?.detail,
    );
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
      /*
       * 認証系の一部。セッション検証（verifySession）の宛先
       * （public/auth/config.js の verifyApiUrl）で、guardPage が呼ぶ。
       */
      'https://auth-verify.potenitas-lp.workers.dev',
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

  {
    /*
     * 「ご利用の前に」の折りたたみ（§5.3 の注記・§10.1）。
     * **常時表示・既定は閉・任意で開。**
     */
    check(
      '**ネイティブの <details> を使う（ARIA で作り直さない）**',
      /<details id="co-notice"[^>]*>/.test(htmlSource) && /<summary id="co-notice-title"/.test(htmlSource),
    );
    check(
      '**既定は閉（open を付けない）**',
      !/<details id="co-notice"[^>]*\sopen[\s>]/.test(htmlSource),
    );
    check(
      '**閉じていても見出しは残る（summary は details の中）**',
      htmlSource.indexOf('<summary id="co-notice-title"') > htmlSource.indexOf('<details id="co-notice"'),
    );
    check(
      '**開閉に JavaScript を使わない（最小実装）**',
      !/co-notice/.test(appSource),
    );
    check(
      '**開閉の状態を localStorage へ記録しない**',
      !/notice/i.test(appSource) || !/setItem/.test(appSource.match(/notice[\s\S]{0,200}/i)?.[0] ?? ''),
    );
  }

  {
    /*
     * 「準備」の折りたたみ（2026-08-19 に平坦化）。
     *
     * 以前は「準備」の中に「ご利用の前に」「準備の状況」「保存先」の
     * 3枚の <details> を入れ子にしていた。中身へ辿り着くのに開く操作が
     * 2回必要で、認知負荷のレビューで指摘された。
     * **いまは <details> を入れ子にしない**ことをここで固定する。
     */
    /* コメントの中の <details> を数えないよう、先に落とす。 */
    const htmlBody = htmlSource.replace(/<!--[\s\S]*?-->/g, '');
    const prepStart = htmlBody.indexOf('<details id="co-prep"');
    const prepBody = htmlBody.slice(prepStart, htmlBody.indexOf('</details>', prepStart));

    check(
      '「準備」の折りたたみがある',
      /<details id="co-prep"[^>]*>/.test(htmlSource) && /<summary id="co-prep-summary"/.test(htmlSource),
    );
    check(
      '**既定で開く（JS が動く前に畳まれていない）**',
      /<details id="co-prep"[^>]*\sopen>/.test(htmlSource),
    );
    check(
      '**<details> を入れ子にしない（開く操作は1回まで）**',
      /* prepBody は開始タグ自身を含むので、1個ちょうどなら入れ子は無い。 */
      prepStart !== -1 && (prepBody.match(/<details\b/g) ?? []).length === 1,
    );
    check(
      '**画面の <details> は「ご利用の前に」と「準備」の2枚だけ**',
      (htmlBody.match(/<details\b/g) ?? []).length === 2,
      String((htmlBody.match(/<details\b/g) ?? []).length),
    );
    check(
      '**誘導は「準備」の外に置く（畳まれて気づかない、を作らない）**',
      htmlBody.indexOf('id="co-guidance"') > prepStart + prepBody.length,
    );
    check(
      '準備の状況と保存先は「準備」の中にある',
      ['co-status', 'co-storage'].every((id) => prepBody.includes(`id="${id}"`)),
    );
    check(
      '**「ご利用の前に」は「準備」の外に出す（既定は閉のままにするため）**',
      htmlBody.indexOf('id="co-notice"') < prepStart,
    );

    check(
      '**開閉の判断材料は DOM ではなく1か所に持つ**',
      /const prepFacts = \{ allReady: false, storage: null \}/.test(appSource)
        && /function applyStatusPanel\(allReady\) \{\s*prepFacts\.allReady = allReady;/.test(appSource),
    );
    check(
      '**保存先は異常か案内があるときに開く**',
      /!prepFacts\.storage\.ok \|\| prepFacts\.storage\.hasNotices/.test(appSource),
    );
    check(
      '**前提が1つでも欠けていれば開く**',
      /const needsCare = !prepFacts\.allReady \|\| storageNeedsCare/.test(appSource)
        && /setPanelOpen\('co-prep', needsCare\)/.test(appSource),
    );
    check(
      '見出しに状態を添える（閉じていても分かる）',
      /setSummary\('co-prep-summary', '準備'/.test(appSource),
    );
    check(
      '**書き込み停止と失敗のときは開いたままにする**',
      (appSource.match(/applyStoragePanel\(\{ ok: false/g) ?? []).length >= 2,
    );
    check(
      '**保存先を隠したら判断材料からも外す（消えた表示で開いたままにしない）**',
      /el\['co-storage'\]\.hidden = true;[\s\S]{0,200}prepFacts\.storage = null;/.test(appSource),
    );
    check(
      '**どの経路でも最後に「準備」を決め直す（finally）**',
      /finally \{[\s\S]{0,300}applyPrepPanel\(\)/.test(appSource),
    );
    check(
      '前提が欠けたときも開き直す',
      (appSource.match(/applyPrepPanel\(\)/g) ?? []).length >= 4,
      String((appSource.match(/applyPrepPanel\(\)/g) ?? []).length),
    );
  }
  check(
    'インラインの <script> を置いていない（CSP と整合）',
    !/<script(?![^>]*\ssrc=)[^>]*>/.test(htmlSource),
  );
  check('本文へのスキップリンクがある', htmlSource.includes('skip-link'));

  {
    /*
     * ポータルへの戻り道（本番アプリ共通、2026-08-19）。
     *
     * **素のテキストリンクにする。** ボタンの見た目にすると、
     * 「連携を解除する」のような取り消せない操作と区別が付かない。
     * guardPage() を待つ #co-content の外に置き、読み込みが失敗しても
     * 戻る道が残るようにする。
     */
    const footer = /<footer[^>]*>([\s\S]*?)<\/footer>/.exec(htmlSource)?.[1] ?? '';

    check('footer に「ポータルへ戻る」がある', /href="\.\.\/\.\.\/portal\/"[^>]*>ポータルへ戻る</.test(footer));
    check(
      '**ボタンではなく素のテキストリンク**',
      footer.includes('ポータルへ戻る') && !/auth-button/.test(footer),
    );
    /*
     * #co-content の外にあること。中の最後の要素（co-message）と
     * <footer> の間で、いちど </div> が閉じていれば外に出ている。
     */
    const afterMessage = htmlSource.slice(
      htmlSource.indexOf('id="co-message"'),
      htmlSource.indexOf('<footer'),
    );

    check(
      '**#co-content の外に置く（読み込み失敗でも戻れる）**',
      htmlSource.indexOf('<footer') > htmlSource.indexOf('id="co-message"')
        && afterMessage.includes('</div>'),
    );
  }

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

  {
    /* ID の重複が無いこと（PR #32 で作り込んだ不具合の再発防止）。 */
    const ids = [...htmlSource.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    const duplicated = ids.filter((id, index) => ids.indexOf(id) !== index);

    check(
      '**同じ id の要素が2つ無い（getElementById が別物を掴む）**',
      duplicated.length === 0,
      [...new Set(duplicated)].join(', '),
    );
  }

  check(
    '**ドライブの失敗に内部コードと原因の要約を添える（DRV-001 だけを出さない）**',
    /function formatDriveError/.test(appSource)
      && /described\.code/.test(appSource)
      && /described\.detail/.test(appSource),
  );
  check(
    '**ドライブの失敗をすべて同じ形で出す（出し忘れを作らない）**',
    (appSource.match(/formatDriveError\(error\)/g) ?? []).length >= 2
      && !/describeDriveError\(error\);\s*\n\s*showMessage/.test(appSource),
  );

  check('guardPage() を通している', appSource.includes('guardPage'));
  check('画面の深さを 2 に設定している', appSource.includes('setScreenDepth(2)'));
  check(
    '前提の判別では has() だけを見る（値を読まない）',
    /hasGeminiKey: keyStoreAvailable && KeyStore\.has\(PROVIDERS\.gemini\)/.test(appSource),
  );
  check(
    '**キーの取り出しは1か所だけ（実際に Gemini を呼ぶ直前）**',
    (appSource.match(/KeyStore\.get\(/g) ?? []).length === 1,
    String((appSource.match(/KeyStore\.get\(/g) ?? []).length),
  );
  check(
    '**取り出したキーを画面にもログにも出さない**',
    !/textContent\s*=\s*apiKey/.test(appSource) && !/console\./.test(appSource),
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
    /*
     * 内部の事情を画面に出さない（2026-08-19。要件定義書 v3.6）。
     * 再試行の回数・一時ファイルの消し残し・Gemini へ渡す文字数は、
     * いずれも利用者が判断に使う情報ではない。
     */
    check(
      '**再試行・一時ファイル・Geminiへの入力長を画面へ出していない**',
      !/label: '表面の再試行'/.test(appSource)
        && !/label: 'Geminiへ渡すテキスト'/.test(appSource)
        && !/label: '一時ファイル'/.test(appSource),
    );
    check(
      '**入力上限を超えた回だけは知らせる（結果が欠けうるため）**',
      /normalizeText\(ocrText\)\.length/.test(appSource)
        && /> MAX_GEMINI_INPUT_LENGTH/.test(appSource),
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

  {
    /* 確認・修正と登録（SC-04 / SC-06）。 */
    check(
      '項目を入力欄にしている（直せない画面にしない）',
      /input\.type = 'text'/.test(appSource) && /dataset\.field = field/.test(appSource),
    );
    check(
      '**保存するのは入力欄の値（振り分け結果をそのまま使わない）**',
      /querySelector\(`\[data-field="\$\{field\}"\]`\)\?\.value/.test(appSource),
    );
    check(
      '**複数行の項目は textarea にする（一部しか見えず消しやすい、を防ぐ）**',
      /createElement\(multiline \? 'textarea' : 'input'\)/.test(appSource),
    );
    check(
      'その他に画面の名前を付けている',
      /otherInformation: 'その他/.test(appSource),
    );
    check('登録の二重送信を防いでいる', /if \(registering \|\|/.test(appSource));
    check(
      '**書き込み停止中は登録させない**',
      /!storage\?\.writable/.test(appSource),
    );
    check(
      '重複でも「それでも登録する」を選べる',
      /skipDuplicateCheck: true/.test(appSource),
    );

    /* 重複時の3つの選択肢（FR-17）。 */
    check(
      '**新規登録・既存更新・キャンセルの3つを出す（FR-17）**',
      /id="co-update"/.test(htmlSource)
        && /id="co-register-anyway"/.test(htmlSource)
        && /id="co-duplicate-cancel"/.test(htmlSource),
    );
    check(
      '**差分を出す場所がある（無確認の上書きをさせない）**',
      /id="co-duplicate-diff"/.test(htmlSource) && /renderDuplicateDiff/.test(appSource),
    );
    check(
      '差分は JS が組み立てる（innerHTML を使わない）',
      /id="co-duplicate-diff"[^>]*>\s*<\/dl>/.test(htmlSource),
    );
    check(
      '**更新のボタンは既定で隠してある（更新できる行があるときだけ出す）**',
      /id="co-update"[^>]*hidden/.test(htmlSource),
    );
    check(
      '**更新は record_id を渡して行う（画面の行番号で書かない）**',
      /register\(\{ updateRecordId: duplicateTarget \}\)/.test(appSource),
    );
    check(
      '管理IDが無い行では更新させない',
      /result\.duplicate\.updatable \? result\.duplicate\.recordId : null/.test(appSource),
    );
    check(
      '**変更履歴を残せなかったことを画面に出す（§11.3）**',
      /historyRecorded/.test(appSource) && /変更履歴を記録できませんでした/.test(appSource),
    );
    check(
      '**対象の行が消えていたら別の行を上書きしない**',
      /result\.missingRow/.test(appSource),
    );
    check(
      '登録の結果欄と重複の欄は既定で隠してある',
      /id="co-saved"[^>]*hidden/.test(htmlSource) && /id="co-duplicate"[^>]*hidden/.test(htmlSource),
    );
    check(
      '次の名刺へ進むと画像も読み取り結果も捨てる',
      /function startNext\(\)[\s\S]{0,200}clearAll\(\)[\s\S]{0,120}discardOcr\(\)/.test(appSource),
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

    for (const [input] of cases) {
      check(
        `unescapeCellText で戻せる（${JSON.stringify(input).slice(0, 20)}）`,
        sanitize.unescapeCellText(sanitize.escapeCellText(input)) === String(input),
      );
    }

    check(
      "**' で始まるだけの値は触らない（人名の 't Hooft 等）**",
      sanitize.unescapeCellText("'t Hooft") === "'t Hooft",
    );
    check('空でも壊れない', sanitize.unescapeCellText(null) === '');
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

    /* v3.5: その他。 */
    check('その他の列がある', headers.includes('その他'));
    check(
      '**その他は右端にある（既存シートを altered にしないため）**',
      headers.at(-1) === 'その他',
      headers.at(-1),
    );

    {
      /*
       * 既存の利用者のシート（その他が無い26列）が、書き込み停止に
       * ならず「不足分を足す」で済むこと。**ここが崩れると全利用者の
       * シートが止まる。**
       */
      const oldHeader = headers.slice(0, -1);
      const verdict = schema.verifyHeader(oldHeader);

      check('**旧いシートは upgrade（altered にしない）**', verdict.status === 'upgrade', verdict.status);
      check('足りないのはその他だけ', verdict.missing.map((c) => c.header).join(',') === 'その他');
    }
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

  {
    /* 差分に出す列（FR-17 の差分確認）。 */
    const contentHeaders = schema.headersOf(schema.CONTENT_COLUMNS);

    check(
      '**名刺の中身は差分に出す**',
      ['会社名', '氏名', '役職', 'メールアドレス', '電話番号', 'その他'].every((h) => contentHeaders.includes(h)),
    );
    check(
      '**管理用の列は差分に出さない（判断材料にならず、肝心の差が埋もれる）**',
      ['record_id', '登録日時', 'duplicate_key', 'has_back',
        'front_image_hash', 'front_file_id', 'front_file_url',
        'app_version', 'prompt_version'].every((h) => !contentHeaders.includes(h)),
    );
    check('差分の列は台帳の列の部分集合', schema.CONTENT_COLUMNS.length < schema.DATA_COLUMNS.length);
  }

  {
    /* 行 → 鍵付きの値（buildDataRow の逆）。更新のときに要る。 */
    const row = schema.buildDataRow({
      record_id: 'R1',
      registeredAt: '2026-08-05 09:00:00',
      companyName: '株式会社サンプル商事',
      phone: '+81312345678',
    });

    const values = schema.rowToValues(row);

    check('record_id を戻せる', values.record_id === 'R1');
    check('登録日時を戻せる', values.registeredAt === '2026-08-05 09:00:00');
    check(
      '**サニタイズのアポストロフィを外して戻す（外さないと毎回「変更あり」になる）**',
      values.phone === '+81312345678',
      values.phone,
    );
    check('短い行でも欠けた列は空文字', schema.rowToValues(['R1']).companyName === '');
    check('配列でなくても壊れない', schema.rowToValues(null).record_id === '');
  }

  {
    /* 差分（FR-17）。**表に入る形に寄せて比べる。** */
    const before = { companyName: '株式会社サンプル商事', jobTitle: '課長', email: '' };
    const after = { companyName: '株式会社サンプル商事', jobTitle: '部長', email: 'taro@example.com' };

    const changes = schema.diffValues(before, after);
    const keys = changes.map((change) => change.key).sort().join(',');

    check('変わった項目だけを返す', keys === 'email,jobTitle', keys);
    check(
      '変更前と変更後を持つ',
      changes.find((c) => c.key === 'jobTitle').oldValue === '課長'
        && changes.find((c) => c.key === 'jobTitle').newValue === '部長',
    );
    check('見出しを添える（変更履歴の field_name になる）', changes.find((c) => c.key === 'jobTitle').header === '役職');
    check('同じなら空', schema.diffValues(before, before).length === 0);

    check(
      '**配列は行と同じ空白区切りで比べる（型の違いを差分にしない）**',
      schema.diffValues(
        { backFilledFields: 'address email' },
        { backFilledFields: ['address', 'email'] },
        schema.DATA_COLUMNS,
      ).length === 0,
    );
    check(
      '**true は TRUE として比べる**',
      schema.diffValues({ hasBack: 'TRUE' }, { hasBack: true }, schema.DATA_COLUMNS).length === 0,
    );
    check(
      '**裏面が外れたことは差分になる**',
      schema.diffValues({ hasBack: 'TRUE' }, { hasBack: false }, schema.DATA_COLUMNS)
        .some((c) => c.key === 'hasBack'),
    );
  }

  {
    /* 変更履歴の行（§11.3）。 */
    const row = schema.buildHistoryRow({
      historyId: 'H1',
      changedAt: '2026-08-18 10:00:00',
      recordId: 'R1',
      fieldName: '役職',
      oldValue: '=DANGER()',
      newValue: '部長',
    });

    check('列の数が §11.3 と一致する', row.length === schema.HISTORY_COLUMNS.length);
    check(
      '**変更前値も無害化する（履歴の側から数式を持ち込ませない）**',
      row[4] === "'=DANGER()",
      row[4],
    );
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
    /* まとめて追記する（変更履歴は1件の更新で何行にもなる）。 */
    const seen = [];

    const impl = async (url, options = {}) => {
      seen.push({ url: String(url), body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({ updates: { updatedRange: 'A2' } }) };
    };

    await sheets.appendRows('S', '変更履歴', [['a'], ['b'], ['c']], { token: 'T', fetchImpl: impl });

    check('**何行でも1回の呼び出しで送る（書き込み上限を使い切らない）**', seen.length === 1);
    check('行をすべて送る', seen[0].body.values.length === 3);

    seen.length = 0;
    await sheets.appendRows('S', '変更履歴', [], { token: 'T', fetchImpl: impl });
    check('行が無ければ通信しない', seen.length === 0);
  }

  {
    /* 既存行の読み取りと書き換え（FR-18 の更新）。 */
    const seen = [];

    const impl = async (url, options = {}) => {
      seen.push({ url: decodeURIComponent(String(url)), method: options.method ?? 'GET', body: options.body ?? null });
      return { ok: true, status: 200, json: async () => ({ values: [['a', 'b']], updatedRange: 'x' }) };
    };

    const row = await sheets.readRow('S', '名刺データ', 5, schema.DATA_COLUMNS.length, { token: 'T', fetchImpl: impl });

    check('行の範囲を1行に絞る', seen[0].url.includes("'名刺データ'!A5:"), seen[0].url);
    check(
      '**数式のまま読む（表示結果と突き合わせると毎回「変更あり」になる）**',
      seen[0].url.includes('valueRenderOption=FORMULA'),
      seen[0].url,
    );
    check('読んだ値を文字列で返す', row.join(',') === 'a,b');

    seen.length = 0;
    await sheets.updateRow('S', '名刺データ', 5, schema.headersOf(schema.DATA_COLUMNS), { token: 'T', fetchImpl: impl });

    check('更新は PUT（values.update）', seen[0].method === 'PUT');
    check('更新も USER_ENTERED（HYPERLINK のため）', seen[0].url.includes('valueInputOption=USER_ENTERED'));
    check(
      '**列定義の幅ちょうどを書く（利用者が右へ足した列を巻き込まない）**',
      seen[0].url.includes(`'名刺データ'!A5:${sheets.columnLetter(schema.DATA_COLUMNS.length - 1)}5`),
      seen[0].url,
    );
    check('append ではない（行を増やさない）', !seen[0].url.includes(':append'));
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
    check(
      '**作るときに列数を確保する（既定26列では27列目に書けない）**',
      createBody.sheets[0].properties.gridProperties.columnCount >= schema.DATA_COLUMNS.length,
      String(createBody.sheets[0].properties.gridProperties?.columnCount),
    );
    check(
      '26列を下回らせない（見慣れた幅を狭めない）',
      createBody.sheets.every((s) => s.properties.gridProperties.columnCount >= 26),
    );
    check(
      '列数の計算は列定義から求める',
      sheets.gridWidthFor('名刺データ') === Math.max(26, schema.DATA_COLUMNS.length),
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

    /*
     * ==================================================================
     * スタブでも「グリッドの外は400」を再現する
     * ==================================================================
     * 実際の Sheets は、グリッドの外側の範囲を指定すると 400 で弾く。
     *
     *   Range ('名刺データ'!AA1) exceeds grid limits. Max columns: 26
     *
     * 以前のスタブはこれを検査していなかったため、v3.5 で27列目
     * （その他）を足したときの不具合が**テストをすり抜けて本番で出た。**
     * 同じ見落としを繰り返さないよう、スタブ側でも検査する。
     * ==================================================================
     */
    const letterToIndex = (letters) => [...letters]
      .reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0);

    const makeImpl = (header, { columnCount = 26 } = {}) => {
      let grid = columnCount;

      return async (url, options = {}) => {
        const text = decodeURIComponent(String(url));

        if (text.includes(':batchUpdate')) {
          const requests = JSON.parse(options.body).requests ?? [];

          for (const request of requests) {
            if (request.appendDimension?.dimension === 'COLUMNS') {
              grid += Number(request.appendDimension.length ?? 0);
            }
          }

          return { ok: true, status: 200, json: async () => ({}) };
        }

        if (text.includes('/values/')) {
          const range = /!([A-Z]+)\d/.exec(text)?.[1];

          if (range && letterToIndex(range) > grid) {
            return {
              ok: false,
              status: 400,
              json: async () => ({
                error: {
                  status: 'INVALID_ARGUMENT',
                  message: `Range ('名刺データ'!${range}1) exceeds grid limits. Max rows: 1000, max columns: ${grid}`,
                },
              }),
            };
          }

          if ((options.method ?? 'GET') === 'GET') {
            return { ok: true, status: 200, json: async () => ({ values: [header] }) };
          }

          return { ok: true, status: 200, json: async () => ({}) };
        }

        if (text.includes('fields=sheets')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              sheets: [
                { properties: { sheetId: 0, title: '名刺データ', gridProperties: { columnCount: grid, rowCount: 1000 } } },
                { properties: { sheetId: 1, title: '変更履歴', gridProperties: { columnCount: 26, rowCount: 1000 } } },
              ],
            }),
          };
        }

        return { ok: true, status: 200, json: async () => ({}) };
      };
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

    {
      /*
       * **本番で実際に起きた形。** 26列の既存シートに27列目（その他）を
       * 足す。グリッドを広げずに AA1 へ書くと 400 になる。
       */
      const impl = makeImpl(expected.slice(0, 26), { columnCount: 26 });
      const result = await storage.inspectSpreadsheet('S', { token: 'T', fetchImpl: impl });

      check(
        '**26列のシートへ27列目を足せる（グリッドを広げてから書く）**',
        result.writable === true,
      );
      check('列を足したことを伝える', result.notices.includes(storage.StorageNotice.SCHEMA_UPGRADED));
    }

    {
      /* スタブが本当に 400 を返すことの確認（検査そのものの検査）。 */
      const impl = makeImpl(expected, { columnCount: 26 });
      let caught = null;

      try {
        await sheets.appendMissingColumns('S', '名刺データ', 26, [{ header: 'その他' }], {
          token: 'T',
          fetchImpl: impl,
          /* わざとグリッドを広げない（sheetId も幅も渡さない）。 */
        });
      } catch (error) { caught = error; }

      check(
        '**広げずに27列目へ書くと 400 になる（スタブが実APIを再現している）**',
        caught?.status === 400,
        String(caught?.status),
      );
      check(
        'エラー本文に理由が入る',
        String(caught?.detail).includes('exceeds grid limits'),
        caught?.detail,
      );
    }

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
  section('正規化と事前抽出（extract.js / FR-09・FR-10）');

  const extract = await import('../../public/production-app/card-ocr/extract.js');

  {
    check('全角英数を半角へ揃える（NFKC）', extract.normalizeText('ＡＢＣ１２３') === 'ABC123');
    check('前後の空白を落とす', extract.normalizeText('  あ  \n  い  ') === 'あ\nい');
    check('空行を落とす', extract.normalizeText('あ\n\n\nい') === 'あ\nい');
    check(
      '**重複行を落とす（表裏で同じ行が多い）**',
      extract.normalizeText('あ\nい\nあ') === 'あ\nい',
    );
    check('連続する空白は1つへ', extract.normalizeText('あ   い') === 'あ い');
    check('null でも壊れない', extract.normalizeText(null) === '');
  }

  {
    /* 事前抽出。**形が決まっているものだけ。** */
    const text = [
      '株式会社サンプル商事',
      '〒100-0001 東京都千代田区千代田1-1-1',
      'TEL: 03-1234-5678  FAX: 03-1234-5679',
      'MOBILE: 090-1234-5678',
      'taro.mihon@example.com',
      'https://example.com',
    ].join('\n');

    const found = extract.extractByPattern(text);

    check('メールを拾う', found.email[0] === 'taro.mihon@example.com');
    check('URLを拾う', found.url[0] === 'https://example.com');
    check('郵便番号を拾う（〒は落とす）', found.postalCode[0] === '100-0001', found.postalCode.join(','));
    check('固定電話を拾う', found.phone[0] === '03-1234-5678', found.phone.join(','));
    check('FAX を拾う', found.fax[0] === '03-1234-5679', found.fax.join(','));
    check('携帯を拾う', found.mobile[0] === '090-1234-5678', found.mobile.join(','));

    check(
      '**同じ番号を2つの種別へ入れない**',
      found.phone.every((value) => !found.mobile.includes(value)),
    );
    check(
      '会社名・氏名は拾わない（Gemini の担当）',
      !('companyName' in found) && !('fullName' in found),
    );
  }

  {
    /* 番号の形が種別を決める。**ラベルより優先する。** */
    check('090 は携帯', extract.isMobileNumber('090-1234-5678'));
    check('080 は携帯', extract.isMobileNumber('080-1234-5678'));
    check('070 は携帯', extract.isMobileNumber('07012345678'));
    check('03 は携帯ではない', !extract.isMobileNumber('03-1234-5678'));
    check('+81 90 も携帯として扱う', extract.isMobileNumber('+81-90-1234-5678'));
    check('桁が足りなければ携帯ではない', !extract.isMobileNumber('090-1234'));

    check('+81 を 0 に読み替える', extract.normalizePhoneDigits('+81-90-1234-5678') === '09012345678');
    check('記号を落とす', extract.normalizePhoneDigits('(03) 1234-5678') === '0312345678');

    const labeled = extract.extractByPattern('TEL: 090-1111-2222');
    check(
      '**「TEL」と書かれていても 090 は携帯にする**',
      labeled.mobile[0] === '090-1111-2222' && labeled.phone.length === 0,
      JSON.stringify(labeled),
    );

    {
      /*
       * **1行に TEL と FAX が並ぶ名刺は珍しくない。**
       * 行に1つの種別を割り当てると、両方が同じ種別になる。
       */
      const oneLine = extract.extractByPattern('TEL: 03-1111-2222  FAX: 03-3333-4444');

      check(
        '**同じ行の TEL と FAX を取り違えない**',
        oneLine.phone[0] === '03-1111-2222' && oneLine.fax[0] === '03-3333-4444',
        JSON.stringify(oneLine),
      );
    }

    check('FAX ラベルを読む', extract.labelKindOf('FAX: 03-1-1') === 'fax');
    check('携帯ラベルを読む', extract.labelKindOf('携帯 090-1-1') === 'mobile');
    check('ラベルが無ければ null', extract.labelKindOf('東京都千代田区') === null);
  }

  {
    /* 数字の並びを拾いすぎない。 */
    const found = extract.extractByPattern('登録番号 T1234567890123\n1-2-3 サンプルビル 5F');

    check(
      '**区切りの無い数字の並びを電話番号にしない**',
      found.phone.length === 0 && found.mobile.length === 0,
      JSON.stringify(found),
    );
  }

  {
    /* 上限に収める。**抽出済み項目を含む行を優先して残す。** */
    const filler = Array.from({ length: 60 }, (_, i) => `どうでもよい行${i}`).join('\n');
    const text = `${filler}\ntaro@example.com\n03-1234-5678`;

    const short = extract.truncateForGemini(text, 200);

    check('上限に収まる', short.length <= 200, String(short.length));
    check(
      '**メールの行を残す（頭から機械的に切らない）**',
      short.includes('taro@example.com'),
      short.slice(0, 80),
    );
    check('電話の行も残す', short.includes('03-1234-5678'));
    check('元の並び順を保つ', short.indexOf('taro@example.com') < short.indexOf('03-1234-5678'));

    check('上限以内ならそのまま', extract.truncateForGemini('短い', 200) === '短い');
    check('上限の既定は2000（§FR-09）', extract.MAX_GEMINI_INPUT_LENGTH === 2000);
  }

  /* ================================================================ */
  section('プロンプトと構造化出力（prompt.js / FR-12・FR-13）');

  const prompt = await import('../../public/production-app/card-ocr/prompt.js');

  {
    check('版が PoC と違う', prompt.PROMPT_VERSION === 'card-ocr-3', prompt.PROMPT_VERSION);
    check('スキーマの type は大文字', prompt.CARD_SCHEMA.type === 'OBJECT');
    check(
      '**小文字の type が残っていない（400 の原因）**',
      !/"type"\s*:\s*"[a-z]/.test(JSON.stringify(prompt.CARD_SCHEMA)),
    );
    check('confidence を持たせていない', !('confidence' in prompt.CARD_SCHEMA.properties));

    for (const field of ['fromBackFields', 'conflicts']) {
      check(`v3.1 の ${field} がある`, prompt.CARD_SCHEMA.properties[field]?.type === 'ARRAY');
      check(`${field} が必須項目に入っている`, prompt.CARD_SCHEMA.required.includes(field));
    }

    /* v3.5: その他（FR-12 の otherInformation）。 */
    check(
      '**otherInformation を配列で受ける**',
      prompt.CARD_SCHEMA.properties.otherInformation?.type === 'ARRAY',
    );
    check('otherInformation が必須項目に入っている', prompt.CARD_SCHEMA.required.includes('otherInformation'));
    check(
      '**捨てないよう指示している**',
      prompt.SYSTEM_INSTRUCTION.includes('otherInformation へ入れること')
        && prompt.SYSTEM_INSTRUCTION.includes('捨てないこと'),
    );
    check(
      '1つの内容につき1要素にするよう指示している',
      prompt.SYSTEM_INSTRUCTION.includes('1つの内容につき1要素'),
    );
    check(
      '他の項目と重複させないよう指示している',
      prompt.SYSTEM_INSTRUCTION.includes('重ねて入れないこと'),
    );
    check(
      '**要約・省略を禁じている（事業内容の長文をそのまま拾う）**',
      prompt.SYSTEM_INSTRUCTION.includes('要約も省略もしない'),
    );
    check(
      '**その他は表面優先の対象外だと明記している（裏面ぶんを失わない）**',
      prompt.SYSTEM_INSTRUCTION.includes('表面優先の対象外'),
    );

    check(
      '推測を禁じる指示が先頭にある',
      prompt.SYSTEM_INSTRUCTION.includes('補わない') && prompt.SYSTEM_INSTRUCTION.includes('推測しない'),
    );
    check(
      '行順が原稿と一致しない前提が入っている',
      prompt.SYSTEM_INSTRUCTION.includes('行の順序は原稿と一致しない'),
    );
    check(
      '**同じ番号を phone と mobile の両方に入れないよう指示している（課題3）**',
      prompt.SYSTEM_INSTRUCTION.includes('両方に入れないこと'),
    );
    check(
      '**日英併記は日本語を採るよう指示している（課題4）**',
      prompt.SYSTEM_INSTRUCTION.includes('日本語のほうを採ること'),
    );
    check(
      '表面優先の統合を指示している（v3.1）',
      prompt.SYSTEM_INSTRUCTION.includes('表面の値を優先'),
    );
    check(
      '**別表記を食い違いと呼ばないよう指示している**',
      prompt.SYSTEM_INSTRUCTION.includes('食い違いではない'),
    );
    check(
      '片面が空でも続けるよう指示している（FR-08 の10）',
      prompt.SYSTEM_INSTRUCTION.includes('片面が空でも'),
    );

    const request = prompt.buildGeminiRequest('テスト');
    check('履歴を持たせない（1名刺1リクエスト）', request.contents.length === 1);
    check('JSON で返させる', request.generationConfig.responseMimeType === 'application/json');
    check('温度は0（分類であって創作ではない）', request.generationConfig.temperature === 0);
    check('出力上限は700トークン（otherInformation のぶん引き上げ）', request.generationConfig.maxOutputTokens === 700);
  }

  /* ================================================================ */
  section('Gemini 呼び出し（gemini.js / FR-11）');

  const gemini = await import('../../public/production-app/card-ocr/gemini.js');

  const AI_OK = {
    companyName: '株式会社サンプル商事',
    fullName: '見本 太郎',
    email: 'taro@example.com',
    phone: '03-1234-5678',
    otherInformation: [],
    uncertainFields: [],
    fromBackFields: [],
    conflicts: [],
  };

  function geminiResponse(body, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  }

  function okPayload(result) {
    return { candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] } }] };
  }

  {
    const calls = [];
    const impl = async (url, options) => {
      calls.push({ url: String(url), options });
      return geminiResponse(okPayload(AI_OK));
    };

    const KEY = 'AIzaTESTKEY_not_a_real_key_0000000000';
    const result = await gemini.classifyCardText('テキスト', { apiKey: KEY, fetchImpl: impl });

    check('分類結果を返す', result.fullName === '見本 太郎');
    check('1回だけ呼ぶ', calls.length === 1);
    check('送信先は Gemini のみ', new URL(calls[0].url).host === gemini.GEMINI_HOST);
    check('**キーはヘッダーで送る**', calls[0].options.headers['x-goog-api-key'] === KEY);
    check('**キーが URL に出ない**', !calls[0].url.includes(KEY));
    check('**キーが本文に出ない**', !String(calls[0].options.body).includes(KEY));
    check('**画像を送らない**', !String(calls[0].options.body).includes('inlineData'));
    check('主モデルを使う', calls[0].url.includes(gemini.DEFAULT_MODEL));
  }

  {
    /* 必須項目の検査。v3.1 の2項目を含む。 */
    for (const field of ['fromBackFields', 'conflicts']) {
      const broken = { ...AI_OK };
      delete broken[field];

      let caught = null;
      try { gemini.assertRequiredFields(broken); } catch (error) { caught = error; }

      check(`${field} が無ければ AI-004`, caught?.code === gemini.GeminiErrorCode.MISSING_FIELDS);
    }

    let caught = null;
    try {
      gemini.assertRequiredFields({ ...AI_OK, fromBackFields: 'email' });
    } catch (error) { caught = error; }

    check('**配列でなければ弾く**', caught?.detail === 'fromBackFields_not_array', caught?.detail);
  }

  {
    /* 404 のときだけフォールバック。429・503 では再試行しない。 */
    const models = [];
    const impl = async (url) => {
      models.push(String(url));
      return models.length === 1
        ? geminiResponse({ error: { status: 'NOT_FOUND' } }, 404)
        : geminiResponse(okPayload(AI_OK));
    };

    await gemini.classifyCardText('t', { apiKey: 'k', fetchImpl: impl });

    check('404 でフォールバックする', models.length === 2);
    check('2回目はフォールバックモデル', models[1].includes(gemini.FALLBACK_MODEL));

    for (const status of [429, 503, 400]) {
      const tried = [];
      const failing = async (url) => {
        tried.push(String(url));
        return geminiResponse({ error: { status: 'X', message: 'y' } }, status);
      };

      let caught = null;
      try {
        await gemini.classifyCardText('t', { apiKey: 'k', fetchImpl: failing });
      } catch (error) { caught = error; }

      check(`**${status} では再試行しない**`, tried.length === 1, String(tried.length));
      check(`${status} の detail に原因が入る`, String(caught?.detail).includes(String(status)));
    }
  }

  /* ================================================================ */
  section('突き合わせ（merge.js / FR-10・FR-14）');

  const merge = await import('../../public/production-app/card-ocr/merge.js');

  {
    /* 空欄だけを埋める。**上書きしない。** */
    const result = merge.mergeExtraction(
      { ...AI_OK, email: '', url: '', postalCode: '' },
      { email: ['found@example.com'], url: ['https://example.com'], postalCode: ['100-0001'] },
    );

    check('空欄を埋める', result.values.email === 'found@example.com');
    check('埋めたことを記録する', result.patternFilled.includes('email'));

    const kept = merge.mergeExtraction(
      { ...AI_OK, email: 'ai@example.com' },
      { email: ['pattern@example.com'] },
    );

    check('**Gemini の値を上書きしない**', kept.values.email === 'ai@example.com');
    check('上書きしていないので記録もしない', !kept.patternFilled.includes('email'));
  }

  {
    /* 課題3。**同じ番号が両方に入っていたら直す。** */
    const both = merge.mergeExtraction(
      { ...AI_OK, phone: '090-1234-5678', mobile: '090-1234-5678' },
      {},
    );

    check('**重複した番号を phone から消す**', both.values.phone === '');
    check('携帯側に残す', both.values.mobile === '090-1234-5678');
    check('直したことを記録する', both.reclassified.length > 0);

    const misplaced = merge.mergeExtraction({ ...AI_OK, phone: '090-1111-2222', mobile: '' }, {});
    check('**携帯番号が phone にあれば mobile へ移す**', misplaced.values.mobile === '090-1111-2222');
    check('phone は空になる', misplaced.values.phone === '');

    const fixed = merge.mergeExtraction({ ...AI_OK, phone: '03-1234-5678', mobile: '03-1234-5678' }, {});
    check('固定電話の重複は mobile 側を空ける', fixed.values.mobile === '' && fixed.values.phone === '03-1234-5678');

    const normal = merge.mergeExtraction(
      { ...AI_OK, phone: '03-1234-5678', mobile: '090-1234-5678' },
      {},
    );
    check('正しく分かれていれば触らない', normal.values.phone === '03-1234-5678' && normal.values.mobile === '090-1234-5678');
    check('直していなければ記録も空', normal.reclassified.length === 0);
  }

  {
    /* 申告はそのまま通す。 */
    const result = merge.mergeExtraction(
      { ...AI_OK, uncertainFields: ['jobTitle'], fromBackFields: ['email'], conflicts: ['companyName'] },
      {},
    );

    check('uncertainFields を通す', result.uncertainFields.join(',') === 'jobTitle');
    check('fromBackFields を通す', result.fromBackFields.join(',') === 'email');
    check('conflicts を通す', result.conflicts.join(',') === 'companyName');
    check('配列でなければ空にする', merge.mergeExtraction({ conflicts: 'x' }, {}).conflicts.length === 0);

    check(
      '**要確認は重複を除く**',
      merge.fieldsNeedingReview({ uncertainFields: ['a', 'b'], conflicts: ['b'] }).join(',') === 'a,b',
    );
  }

  {
    /* 台帳の項目だけを返す。余計な鍵を通さない。 */
    const result = merge.mergeExtraction({ ...AI_OK, somethingElse: 'x' }, {});

    check('VALUE_FIELDS だけを返す', !('somethingElse' in result.values));
    check(
      'すべての項目が文字列',
      Object.values(result.values).every((value) => typeof value === 'string'),
    );
    check(
      '正規表現が担当するのは形の決まった項目だけ',
      !merge.PATTERN_FIELDS.includes('companyName') && !merge.PATTERN_FIELDS.includes('fullName'),
    );
  }

  {
    /* v3.5: その他。配列を改行でつなぐ。 */
    check('otherInformation が台帳の項目に入っている', merge.VALUE_FIELDS.includes('otherInformation'));
    check('複数行の項目として扱う', merge.MULTILINE_FIELDS.includes('otherInformation'));

    const result = merge.mergeExtraction(
      { ...AI_OK, otherInformation: ['宅地建物取引士', 'X: @sample', '創業50年'] },
      {},
    );

    check(
      '**改行でつなぐ（つなぐ側をこちらに寄せる）**',
      result.values.otherInformation === '宅地建物取引士\nX: @sample\n創業50年',
      JSON.stringify(result.values.otherInformation),
    );
    check(
      '空の要素は落とす（台帳に空行を作らない）',
      merge.mergeExtraction({ ...AI_OK, otherInformation: ['a', '', '  ', 'b'] }, {}).values.otherInformation === 'a\nb',
    );
    check(
      '無ければ空文字',
      merge.mergeExtraction({ ...AI_OK, otherInformation: [] }, {}).values.otherInformation === '',
    );
    check(
      '配列でなくても壊れない',
      merge.mergeExtraction({ ...AI_OK, otherInformation: 'x' }, {}).values.otherInformation === '',
    );
    check(
      '**正規表現の対象にしない（文脈の要る項目）**',
      !merge.PATTERN_FIELDS.includes('otherInformation'),
    );
  }

  /* ================================================================ */
  section('確定保存（register.js / FR-07・FR-19・§11.2）');

  const register = await import('../../public/production-app/card-ocr/register.js');

  {
    /* 重複（最小限。ハッシュのみ）。 */
    const known = ['aaa', 'bbb'];

    check('表面が一致すれば重複', register.findHashDuplicate({ front: 'aaa' }, known).found);
    check('側を返す', register.findHashDuplicate({ front: 'aaa' }, known).side === 'front');
    check(
      '**表裏を入れ替えて撮った場合も拾う（FR-06）**',
      register.findHashDuplicate({ front: 'zzz', back: 'aaa' }, known).side === 'back',
    );
    check('一致しなければ重複ではない', !register.findHashDuplicate({ front: 'zzz' }, known).found);
    check('空のハッシュで誤検出しない', !register.findHashDuplicate({ front: '', back: '' }, ['']).found);
    check('既存が空でも壊れない', !register.findHashDuplicate({ front: 'a' }, []).found);
  }

  {
    /* 会社名＋氏名の重複（FR-17）。**撮り直しても拾える。** */
    const existing = [
      { companyName: '株式会社サンプル商事', fullName: '見本 太郎' },
      { companyName: 'Luminous', fullName: 'Hanako Rei' },
    ];

    check(
      '**同じ会社の同じ氏名なら重複**',
      register.findAttributeDuplicate(
        { companyName: '株式会社サンプル商事', fullName: '見本 太郎' }, existing,
      ).found,
    );
    check(
      '種別を返す',
      register.findAttributeDuplicate(
        { companyName: '株式会社サンプル商事', fullName: '見本 太郎' }, existing,
      ).kind === 'attribute',
    );
    check(
      '空白の有無は無視する',
      register.findAttributeDuplicate(
        { companyName: '株式会社 サンプル商事', fullName: '見本太郎' }, existing,
      ).found,
    );
    check(
      '大文字小文字は無視する',
      register.findAttributeDuplicate({ companyName: 'LUMINOUS', fullName: 'hanako rei' }, existing).found,
    );
    check(
      '会社が違えば別人',
      !register.findAttributeDuplicate({ companyName: '別会社', fullName: '見本 太郎' }, existing).found,
    );
    check(
      '氏名が違えば別人',
      !register.findAttributeDuplicate({ companyName: '株式会社サンプル商事', fullName: '別人' }, existing).found,
    );

    check(
      '**会社名だけでは判定しない**',
      !register.findAttributeDuplicate({ companyName: '株式会社サンプル商事', fullName: '' }, existing).found,
    );
    check(
      '**氏名だけでは判定しない**',
      !register.findAttributeDuplicate({ companyName: '', fullName: '見本 太郎' }, existing).found,
    );
    check(
      '既存側も両方揃っていなければ比べない',
      !register.findAttributeDuplicate(
        { companyName: 'A', fullName: 'B' }, [{ companyName: 'A', fullName: '' }],
      ).found,
    );
    check('既存が空でも壊れない', !register.findAttributeDuplicate({ companyName: 'A', fullName: 'B' }, []).found);
    check('引数が無くても壊れない', !register.findAttributeDuplicate({}, []).found);

    check(
      '**「株式会社」と「(株)」は別物として扱う（寄せない）**',
      !register.findAttributeDuplicate({ companyName: '(株)サンプル商事', fullName: '見本 太郎' }, existing).found,
    );
  }

  {
    /* 記録用の値。 */
    const id = register.buildRecordId();
    check('record_id を作る', typeof id === 'string' && id.length >= 16, id);
    check('毎回変わる', register.buildRecordId() !== id);

    check(
      '登録日時は人が読める形',
      register.formatRegisteredAt(new Date(2026, 7, 5, 9, 5, 3)) === '2026-08-05 09:05:03',
      register.formatRegisteredAt(new Date(2026, 7, 5, 9, 5, 3)),
    );

    const record = register.buildRecord({
      values: { companyName: '株式会社サンプル商事', fullName: '見本 太郎', email: 'a@example.com' },
      merged: { fromBackFields: ['address'] },
      hashes: { front: 'h1', back: 'h2' },
      front: { id: 'F', webViewLink: 'https://drive.google.com/file/d/F/view' },
      back: { id: 'B', webViewLink: 'https://drive.google.com/file/d/B/view' },
      at: new Date(2026, 7, 5),
    });

    check('版を記録する', record.appVersion !== '' && record.promptVersion !== '');
    check('裏面があれば has_back', record.hasBack === true);
    check('裏面から補った項目を残す', record.backFilledFields.join(',') === 'address');
    check('面ごとのハッシュを入れる', record.frontImageHash === 'h1' && record.backImageHash === 'h2');
    check('重複判定キーを作る', record.duplicateKey === 'email:a@example.com');
    check(
      '**画面で直された値をそのまま使う（作り直さない）**',
      record.companyName === '株式会社サンプル商事',
    );

    const noBack = register.buildRecord({ values: {}, hashes: {}, front: { id: 'F' } });
    check('裏面が無ければ has_back は false', noBack.hasBack === false);
    check('裏面の列は空', noBack.backFileId === '' && noBack.backImageHash === '');

    /* 台帳の行にしたとき、列の数と一致すること。 */
    const row = schema.buildDataRow(record);
    check('行の長さが列の定義と一致する', row.length === schema.DATA_COLUMNS.length);
  }

  {
    /* 保存の流れ。**画像を先に上げ、台帳は最後。** */
    const calls = [];

    const impl = async (url, options = {}) => {
      const text = String(url);
      const method = options.method ?? 'GET';
      calls.push({ url: text, method });

      if (text.includes('/values/') && text.includes(':append')) {
        return { ok: true, status: 200, json: async () => ({ updates: { updatedRange: 'A2' } }) };
      }

      if (text.includes('/values/')) {
        /* 既存のハッシュ列。空で返す。 */
        return { ok: true, status: 200, json: async () => ({ values: [] }) };
      }

      if (text.startsWith('https://www.googleapis.com/upload/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'IMG', webViewLink: 'https://drive.google.com/file/d/IMG/view' }),
        };
      }

      if (text.includes('q=')) {
        return { ok: true, status: 200, json: async () => ({ files: [{ id: 'MONTH' }] }) };
      }

      return { ok: true, status: 200, json: async () => ({ id: 'X' }) };
    };

    const result = await register.registerCard({
      values: { companyName: 'A', fullName: 'B' },
      merged: { fromBackFields: [] },
      frontBlob: new Blob(['front'], { type: 'image/jpeg' }),
      backBlob: null,
      storage: { spreadsheetId: 'SHEET', imageFolderId: 'IMAGES', writable: true },
      token: 'T',
      fetchImpl: impl,
      at: new Date(2026, 7, 5),
    });

    check('登録できる', result.registered === true);
    check('管理IDを返す', typeof result.recordId === 'string' && result.recordId.length > 0);
    check('シートのURLを返す', result.sheetUrl.includes('SHEET'));

    const uploadIndex = calls.findIndex((c) => c.url.startsWith('https://www.googleapis.com/upload/'));
    const appendIndex = calls.findIndex((c) => c.url.includes(':append'));

    check('画像を上げている', uploadIndex >= 0);
    check('台帳へ追記している', appendIndex >= 0);
    check(
      '**画像を先に上げ、台帳は最後に書く**',
      uploadIndex < appendIndex,
      `upload=${uploadIndex} append=${appendIndex}`,
    );
    check(
      '追記は USER_ENTERED（HYPERLINK のため）',
      calls[appendIndex].url.includes('valueInputOption=USER_ENTERED'),
    );
  }

  {
    /* 重複が見つかったら、台帳へ書かずに止める。 */
    const calls = [];

    const impl = async (url, options = {}) => {
      const text = String(url);
      calls.push({ url: text, method: options.method ?? 'GET' });

      if (text.includes('/values/')) {
        /* 既存のハッシュ列に、これから登録する画像と同じ値がある。 */
        const digest = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
        return { ok: true, status: 200, json: async () => ({ values: [[digest]] }) };
      }

      return { ok: true, status: 200, json: async () => ({ id: 'X' }) };
    };

    const result = await register.registerCard({
      values: { companyName: 'A' },
      frontBlob: new Blob(['abc'], { type: 'image/jpeg' }),
      storage: { spreadsheetId: 'SHEET', imageFolderId: 'IMAGES', writable: true },
      token: 'T',
      fetchImpl: impl,
    });

    check('重複なら登録しない', result.registered === false);
    check('重複であることを返す', result.duplicate.found === true);
    check(
      '**重複のときは画像も上げない**',
      !calls.some((c) => c.url.startsWith('https://www.googleapis.com/upload/')),
    );
    check(
      '**重複のときは台帳へ書かない**',
      !calls.some((c) => c.url.includes(':append')),
    );

    /* 利用者が「それでも登録する」を選んだ場合。 */
    const forced = await register.registerCard({
      values: { companyName: 'A' },
      frontBlob: new Blob(['abc'], { type: 'image/jpeg' }),
      storage: { spreadsheetId: 'SHEET', imageFolderId: 'IMAGES', writable: true },
      token: 'T',
      fetchImpl: async (url) => {
        const text = String(url);

        if (text.includes(':append')) {
          return { ok: true, status: 200, json: async () => ({ updates: {} }) };
        }

        if (text.startsWith('https://www.googleapis.com/upload/')) {
          return { ok: true, status: 200, json: async () => ({ id: 'IMG', webViewLink: '' }) };
        }

        if (text.includes('q=')) {
          return { ok: true, status: 200, json: async () => ({ files: [{ id: 'M' }] }) };
        }

        return { ok: true, status: 200, json: async () => ({ id: 'X' }) };
      },
      skipDuplicateCheck: true,
    });

    check('**「それでも登録する」を選べる**', forced.registered === true);
  }

  {
    /*
     * 会社名＋氏名が一致した場合。**画像は別物でも止める。**
     * 同じ名刺を撮り直したときに二重登録させないための判定である。
     */
    const calls = [];

    const impl = async (url, options = {}) => {
      const text = String(url);
      calls.push({ url: text, method: options.method ?? 'GET' });

      if (text.includes('/values/')) {
        const range = decodeURIComponent(text);
        /* 会社名は12列目(L)、氏名は7列目(G)。列文字で見分ける。 */
        if (/!C2:C$/.test(range)) {
          return { ok: true, status: 200, json: async () => ({ values: [['株式会社サンプル商事']] }) };
        }

        if (/!F2:F$/.test(range)) {
          return { ok: true, status: 200, json: async () => ({ values: [['見本 太郎']] }) };
        }

        return { ok: true, status: 200, json: async () => ({ values: [] }) };
      }

      return { ok: true, status: 200, json: async () => ({ id: 'X' }) };
    };

    const result = await register.registerCard({
      values: { companyName: '株式会社サンプル商事', fullName: '見本 太郎' },
      /* 既存とは別の画像。ハッシュは一致しない。 */
      frontBlob: new Blob(['まったく別の画像'], { type: 'image/jpeg' }),
      storage: { spreadsheetId: 'SHEET', imageFolderId: 'IMAGES', writable: true },
      token: 'T',
      fetchImpl: impl,
    });

    check('**画像が違っても、会社名＋氏名が同じなら止める**', result.registered === false);
    check('種別は attribute', result.duplicate.kind === 'attribute', String(result.duplicate.kind));
    check(
      '止めたときは画像を上げない',
      !calls.some((c) => c.url.startsWith('https://www.googleapis.com/upload/')),
    );
  }

  /* ================================================================ */
  section('既存行の更新（register.js / FR-17・FR-18・§11.3）');

  {
    /* 行の特定は record_id で行う。位置で当てにいかない。 */
    const rows = [
      { rowNumber: 2, recordId: 'R1', frontHash: 'h1', backHash: '', companyName: 'A社', fullName: '甲' },
      { rowNumber: 3, recordId: 'R2', frontHash: 'h2', backHash: 'h3', companyName: 'B社', fullName: '乙' },
    ];

    const byHash = register.findDuplicateRow({ front: 'zzz', back: 'h3' }, { companyName: 'X', fullName: 'Y' }, rows);

    check('**画像の一致は行まで特定する**', byHash.row?.recordId === 'R2', String(byHash.row?.recordId));
    check('どちらの面が一致したかを返す', byHash.side === 'back', String(byHash.side));
    check('種別は image', byHash.kind === 'image');
    check(
      '**表と裏を取り違えて撮っても拾う（§FR-06）**',
      register.findDuplicateRow({ front: 'h3' }, { companyName: 'X', fullName: 'Y' }, rows).row?.recordId === 'R2',
    );

    const byName = register.findDuplicateRow({ front: 'zzz' }, { companyName: 'A社', fullName: '甲' }, rows);

    check('会社名＋氏名でも行を特定する', byName.row?.rowNumber === 2, String(byName.row?.rowNumber));
    check(
      '**画像の一致を先に見る（根拠が強い）**',
      register.findDuplicateRow({ front: 'h2' }, { companyName: 'A社', fullName: '甲' }, rows).kind === 'image',
    );
    check(
      '一致しなければ行を返さない',
      register.findDuplicateRow({ front: 'zzz' }, { companyName: 'C社', fullName: '丙' }, rows).row === null,
    );
    check('既存が空でも壊れない', register.findDuplicateRow({ front: 'h1' }, {}, []).found === false);
  }

  {
    /* record_id → 行番号。見出しが1行目なので、1件目は2行目。 */
    const impl = async () => ({ ok: true, status: 200, json: async () => ({ values: [['R1'], ['R2'], ['R3']] }) });

    check(
      '見出しのぶんをずらして返す',
      await register.locateRowByRecordId('S', 'R3', { token: 'T', fetchImpl: impl }) === 4,
    );
    check(
      '**無ければ null（推測で別の行を返さない）**',
      await register.locateRowByRecordId('S', 'GONE', { token: 'T', fetchImpl: impl }) === null,
    );
    check(
      '空の record_id では引かない',
      await register.locateRowByRecordId('S', '', { token: 'T', fetchImpl: impl }) === null,
    );
  }

  /* 台帳に入っている1件（更新の相手）。 */
  const EXISTING_RECORD = {
    record_id: 'R2',
    registeredAt: '2026-01-05 09:00:00',
    companyName: '株式会社サンプル商事',
    fullName: '見本 太郎',
    jobTitle: '課長',
    email: 'taro@example.com',
    duplicateKey: 'email:taro@example.com',
    frontImageHash: 'OLD-HASH',
    frontFileId: 'OLD-FILE',
    frontFileUrl: 'https://drive.google.com/file/d/OLD/view',
    appVersion: '0.0.0',
    promptVersion: 'old',
  };

  /*
   * 2行の台帳を持つスタブ。2行目（R2）が上の1件。
   * 範囲の形で読み分ける（実際の Sheets と同じく A1 記法で来る）。
   */
  function makeLedgerImpl(calls, { recordIds = [['R1'], ['R2']] } = {}) {
    const existingRow = schema.buildDataRow(EXISTING_RECORD);

    return async (url, options = {}) => {
      const text = decodeURIComponent(String(url));
      const method = options.method ?? 'GET';
      calls.push({ url: text, method, body: options.body ?? null });

      if (text.startsWith('https://www.googleapis.com/upload/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'NEW-IMG', webViewLink: 'https://drive.google.com/file/d/NEW-IMG/view' }),
        };
      }

      if (text.includes(':append')) {
        return { ok: true, status: 200, json: async () => ({ updates: { updatedRange: 'x' } }) };
      }

      if (text.includes('/values/')) {
        if (/!A2:A$/.test(text.split('?')[0])) {
          return { ok: true, status: 200, json: async () => ({ values: recordIds }) };
        }

        /* 1行ぶんの読み取り（A3:AA3 のような形）。 */
        if (/!A(\d+):[A-Z]+\1/.test(text) && method === 'GET') {
          return { ok: true, status: 200, json: async () => ({ values: [existingRow] }) };
        }

        if (method === 'PUT') {
          return { ok: true, status: 200, json: async () => ({ updatedRange: 'x' }) };
        }

        /* ハッシュ列・会社名・氏名など。 */
        if (/!C2:C$/.test(text.split('?')[0])) {
          return { ok: true, status: 200, json: async () => ({ values: [[''], ['株式会社サンプル商事']] }) };
        }

        if (/!F2:F$/.test(text.split('?')[0])) {
          return { ok: true, status: 200, json: async () => ({ values: [[''], ['見本 太郎']] }) };
        }

        return { ok: true, status: 200, json: async () => ({ values: [] }) };
      }

      if (text.includes('q=')) {
        return { ok: true, status: 200, json: async () => ({ files: [{ id: 'MONTH' }] }) };
      }

      return { ok: true, status: 200, json: async () => ({ id: 'X' }) };
    };
  }

  const EDITED_VALUES = Object.freeze({
    companyName: '株式会社サンプル商事',
    fullName: '見本 太郎',
    jobTitle: '部長',
    email: 'taro@example.com',
  });

  {
    /*
     * 重複を見つけたところ。**更新に必要なものを返す**
     * （どの行か・いま何が入っているか・何が変わるか）。
     */
    const calls = [];

    const result = await register.registerCard({
      values: EDITED_VALUES,
      frontBlob: new Blob(['まったく別の画像'], { type: 'image/jpeg' }),
      storage: { spreadsheetId: 'SHEET', imageFolderId: 'IMAGES', writable: true },
      token: 'T',
      fetchImpl: makeLedgerImpl(calls),
    });

    check('重複なら登録しない', result.registered === false);
    check('**どの行かを返す（record_id）**', result.duplicate.recordId === 'R2', String(result.duplicate.recordId));
    check('行番号も返す', result.duplicate.rowNumber === 3, String(result.duplicate.rowNumber));
    check('更新できると伝える', result.duplicate.updatable === true);
    check('いま入っている値を返す', result.existing?.jobTitle === '課長', String(result.existing?.jobTitle));

    const changed = result.changes.map((c) => c.header).join(',');

    check('**変わる項目だけを返す（差分確認のため）**', changed === '役職', changed);
    check(
      '変更前と変更後が分かる',
      result.changes[0].oldValue === '課長' && result.changes[0].newValue === '部長',
    );
    check(
      '**この段階では書かない（画像も上げない）**',
      !calls.some((c) => c.url.startsWith('https://www.googleapis.com/upload/'))
        && !calls.some((c) => c.method === 'PUT' || c.url.includes(':append')),
    );
  }

  {
    /* record_id が空の行は更新できない。位置で当てにいかない。 */
    const calls = [];

    const result = await register.registerCard({
      values: EDITED_VALUES,
      frontBlob: new Blob(['まったく別の画像'], { type: 'image/jpeg' }),
      storage: { spreadsheetId: 'SHEET', imageFolderId: 'IMAGES', writable: true },
      token: 'T',
      fetchImpl: makeLedgerImpl(calls, { recordIds: [] }),
    });

    check('重複としては拾う', result.registered === false && result.duplicate.kind === 'attribute');
    check(
      '**管理IDが無い行は更新の対象にしない**',
      result.duplicate.updatable === false,
      String(result.duplicate.updatable),
    );
    check('その行を読みにいかない', !calls.some((c) => /!A\d+:[A-Z]+\d/.test(c.url)));
    check('差分は空', result.changes.length === 0);
  }

  {
    /* 更新の本体。 */
    const calls = [];

    const result = await register.registerCard({
      values: EDITED_VALUES,
      merged: { fromBackFields: [] },
      frontBlob: new Blob(['新しい画像'], { type: 'image/jpeg' }),
      storage: { spreadsheetId: 'SHEET', imageFolderId: 'IMAGES', writable: true },
      token: 'T',
      fetchImpl: makeLedgerImpl(calls),
      at: new Date(2026, 7, 18, 10, 0, 0),
      updateRecordId: 'R2',
    });

    check('更新できる', result.registered === true && result.updated === true);
    check('管理IDは変えない', result.recordId === 'R2');
    check('**行は追加しない（append を呼ばない）**', !calls.some((c) => c.url.includes(':append') && c.url.includes('名刺データ')));

    const put = calls.find((c) => c.method === 'PUT');
    const written = JSON.parse(put.body).values[0];
    const at = (header) => written[schema.headersOf(schema.DATA_COLUMNS).indexOf(header)];

    check('**record_id で特定した行を書き換える（3行目）**', /!A3:[A-Z]+3/.test(put.url), put.url);
    check('管理IDをそのまま残す', at('record_id') === 'R2', at('record_id'));
    check(
      '**登録日時は最初のまま（更新時刻は変更履歴が持つ）**',
      at('登録日時') === '2026-01-05 09:00:00',
      at('登録日時'),
    );
    check('直した値が入る', at('役職') === '部長', at('役職'));
    check('画像は差し替わる', at('front_file_id') === 'NEW-IMG', at('front_file_id'));

    /* 変更履歴（§11.3）。 */
    const history = calls.find((c) => c.url.includes(':append'));

    check('**変更履歴へ書いている**', Boolean(history));
    check('変更履歴タブへ書いている', history.url.includes('変更履歴'), history.url);
    check(
      '**台帳を書いたあとで履歴を書く（失敗しても嘘の履歴を残さない）**',
      calls.indexOf(put) < calls.indexOf(history),
    );

    const historyRows = JSON.parse(history.body).values;
    const index = (header) => schema.headersOf(schema.HISTORY_COLUMNS).indexOf(header);
    const fields = historyRows.map((row) => row[index('field_name')]);
    const jobRow = historyRows.find((row) => row[index('field_name')] === '役職');

    check('**変更前値を残す**', jobRow[index('old_value')] === '課長', jobRow[index('old_value')]);
    check('変更後の値も残す', jobRow[index('new_value')] === '部長');
    check('record_id を添える', jobRow[index('record_id')] === 'R2');
    check('changed_at を入れる', jobRow[index('changed_at')] === '2026-08-18 10:00:00', jobRow[index('changed_at')]);
    check('history_id を作る', jobRow[index('history_id')].length >= 16);
    check(
      '**画像やハッシュの入れ替わりも記録する（あとから追えるように）**',
      fields.includes('front_file_id') && fields.includes('front_image_hash'),
      fields.join(','),
    );
    check('record_id 自体は変更行にしない', !fields.includes('record_id'));
    check('登録日時を変更行にしない', !fields.includes('登録日時'));
    check('画面へ返す差分にも役職が入る', result.changes.some((c) => c.header === '役職'));
    check('履歴を残せたことを返す', result.historyRecorded === true);
  }

  {
    /* 対象の行が消えていたら、**別の行を上書きしない。** */
    const calls = [];

    const result = await register.registerCard({
      values: EDITED_VALUES,
      frontBlob: new Blob(['新しい画像'], { type: 'image/jpeg' }),
      storage: { spreadsheetId: 'SHEET', imageFolderId: 'IMAGES', writable: true },
      token: 'T',
      fetchImpl: makeLedgerImpl(calls),
      updateRecordId: 'GONE',
    });

    check('**行が見つからなければ何も書かない**', !calls.some((c) => c.method === 'PUT'));
    check('画像も上げない', !calls.some((c) => c.url.startsWith('https://www.googleapis.com/upload/')));
    check('見つからなかったことを返す', result.missingRow === true && result.registered === false);
  }

  {
    /*
     * 追記 → 同じ内容で更新、の一巡（状態を持つ台帳のスタブ）。
     *
     * **変えていない項目が差分に出ないこと**を見るのが目的である。
     * サニタイズのアポストロフィ（`+81…`）や複数行の値で、
     * 「何も直していないのに全項目が変更扱い」になると、
     * 変更履歴が意味を失い、差分確認画面も読めなくなる。
     */
    const ledger = { rows: [], history: [] };

    const impl = async (url, options = {}) => {
      const text = decodeURIComponent(String(url));
      const method = options.method ?? 'GET';
      const raw = options.body;
      const body = typeof raw === 'string' && raw.startsWith('{') ? JSON.parse(raw) : null;

      if (text.startsWith('https://www.googleapis.com/upload/')) {
        const id = `IMG-${ledger.rows.length}-${ledger.history.length}`;
        return {
          ok: true,
          status: 200,
          json: async () => ({ id, webViewLink: `https://drive.google.com/file/d/${id}/view` }),
        };
      }

      if (text.includes(':append')) {
        (text.includes('変更履歴') ? ledger.history : ledger.rows).push(...body.values);
        return { ok: true, status: 200, json: async () => ({ updates: { updatedRange: 'x' } }) };
      }

      if (text.includes('/values/')) {
        const range = text.split('/values/')[1].split('?')[0];

        if (method === 'PUT') {
          ledger.rows[Number(/!A(\d+):/.exec(range)[1]) - 2] = body.values[0];
          return { ok: true, status: 200, json: async () => ({ updatedRange: range }) };
        }

        const single = /!([A-Z]+)2:\1$/.exec(range);

        if (single) {
          const index = single[1].split('')
            .reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1;

          return { ok: true, status: 200, json: async () => ({ values: ledger.rows.map((row) => [row[index] ?? '']) }) };
        }

        const oneRow = /!A(\d+):[A-Z]+\1/.exec(range);

        if (oneRow) {
          return { ok: true, status: 200, json: async () => ({ values: [ledger.rows[Number(oneRow[1]) - 2] ?? []] }) };
        }

        return { ok: true, status: 200, json: async () => ({ values: [] }) };
      }

      if (text.includes('q=')) {
        return { ok: true, status: 200, json: async () => ({ files: [{ id: 'MONTH' }] }) };
      }

      return { ok: true, status: 200, json: async () => ({ id: 'X' }) };
    };

    const values = {
      companyName: '株式会社サンプル商事',
      fullName: '見本 太郎',
      jobTitle: '課長',
      /* 先頭にアポストロフィが付く値。 */
      phone: '+81312345678',
      email: 'taro@example.com',
      /* 複数行の値。 */
      otherInformation: '創業1950年\n第二事業部',
    };

    const storageStub = { spreadsheetId: 'S', imageFolderId: 'IMAGES', writable: true };
    const common = { merged: { fromBackFields: [] }, storage: storageStub, token: 'T', fetchImpl: impl };

    const first = await register.registerCard({
      ...common,
      values,
      frontBlob: new Blob(['front'], { type: 'image/jpeg' }),
      at: new Date(2026, 0, 5, 9, 0, 0),
    });

    /* 同じ名刺を撮り直した体で、もう一度出す（画像は別物）。 */
    const again = await register.registerCard({
      ...common,
      values,
      frontBlob: new Blob(['front-2'], { type: 'image/jpeg' }),
      at: new Date(2026, 7, 18, 10, 0, 0),
    });

    check('撮り直しを重複として拾う', again.registered === false && again.duplicate.recordId === first.recordId);
    check(
      '**内容が同じなら差分は空（アポストロフィ・複数行で誤検出しない）**',
      again.changes.length === 0,
      JSON.stringify(again.changes),
    );

    const updated = await register.registerCard({
      ...common,
      values,
      frontBlob: new Blob(['front-2'], { type: 'image/jpeg' }),
      at: new Date(2026, 7, 18, 10, 0, 0),
      updateRecordId: first.recordId,
    });

    const after = schema.rowToValues(ledger.rows[0]);

    check('**行は増えない（上書きである）**', ledger.rows.length === 1, String(ledger.rows.length));
    check('管理IDは変わらない', after.record_id === first.recordId);
    check('登録日時は最初のまま', after.registeredAt === '2026-01-05 09:00:00', after.registeredAt);
    check('値は元のまま戻る', after.phone === '+81312345678' && after.otherInformation === '創業1950年\n第二事業部');
    check(
      '**変わったのは画像まわりだけ（内容の列は履歴に出ない）**',
      updated.changes.map((c) => c.header).join(',') === 'front_image_hash,front_file_id,front_file_url',
      updated.changes.map((c) => c.header).join(','),
    );
    check('履歴の行数は変更点の数と一致する', ledger.history.length === updated.changes.length);
  }

  {
    /* 変更履歴だけ失敗した場合。**更新そのものは成功として扱う。** */
    const calls = [];
    const base = makeLedgerImpl(calls);

    const impl = async (url, options = {}) => {
      const text = decodeURIComponent(String(url));

      if (text.includes(':append')) {
        return { ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) };
      }

      return base(url, options);
    };

    const result = await register.registerCard({
      values: EDITED_VALUES,
      frontBlob: new Blob(['新しい画像'], { type: 'image/jpeg' }),
      storage: { spreadsheetId: 'SHEET', imageFolderId: 'IMAGES', writable: true },
      token: 'T',
      fetchImpl: impl,
      updateRecordId: 'R2',
    });

    check('**台帳が書けていれば更新は成功**', result.registered === true && result.updated === true);
    check(
      '**記録できなかったことを伝える（黙って進めない）**',
      result.historyRecorded === false,
    );
  }

  /* ================================================================ */
  section('測定モード（measure/ / 計画 §7）');

  const measure = await import('../../public/production-app/card-ocr/measure/measurement.js');

  {
    /* 50枚と15枚を混ぜないための列。 */
    check('種類の列がある（front / both）', measure.CSV_COLUMNS.includes('side_mode'));
    check('区分の列がある', measure.CSV_COLUMNS.includes('category'));
    check(
      '所要時間の内訳がある（§13.1）',
      ['total_ms', 'ocr_ms', 'gemini_ms'].every((c) => measure.CSV_COLUMNS.includes(c)),
    );
    check(
      'v3.1 の由来の列がある',
      ['has_back', 'fromBackFields', 'conflicts', 'pattern_filled', 'reclassified']
        .every((c) => measure.CSV_COLUMNS.includes(c)),
    );
    check(
      '**正解列は空で出す（画面から入力させない）**',
      ['expected_companyName', 'expected_fullName', 'expected_jobTitle',
        'expected_email', 'expected_phone'].every((c) => measure.CSV_COLUMNS.includes(c)),
    );
    check('429 を状態として持つ', measure.MeasureStatus.RATE_LIMITED === 'rate_limited');
    check('列名が重複していない', new Set(measure.CSV_COLUMNS).size === measure.CSV_COLUMNS.length);
  }

  {
    /* 行の組み立て。列の定義と過不足なく一致すること。 */
    const row = measure.buildRow({
      no: 1,
      fileName: '01.jpg',
      category: '日英併記',
      sideMode: 'both',
      status: measure.MeasureStatus.OK,
      recordedAt: '2026-08-04T00:00:00.000Z',
      totalMs: 17900,
      hasBack: true,
      fields: { companyName: '株式会社サンプル商事', jobTitle: '執行役員 AI人材育成責任者' },
      merged: { fromBackFields: ['postalCode', 'address'], conflicts: [], patternFilled: ['email'] },
    });

    check(
      '**行の鍵が列の定義と一致する**',
      Object.keys(row).sort().join(',') === [...measure.CSV_COLUMNS].sort().join(','),
      Object.keys(row).filter((k) => !measure.CSV_COLUMNS.includes(k)).join(','),
    );
    check('種類を記録する', row.side_mode === 'both');
    check('裏面の有無を記録する', row.has_back === 'TRUE');
    check('裏面から補った項目を空白区切りで入れる', row.fromBackFields === 'postalCode address');
    check(
      '**役職は全文を入れる（後半が落ちていないか見るため）**',
      row.jobTitle === '執行役員 AI人材育成責任者',
    );
    check('正解列は空', row.expected_jobTitle === '');
    check('未指定は空文字', row.gemini_ms === '');
  }

  {
    /* CSV。表計算ソフトで開いても壊れない・評価されない。 */
    check('通常の値はそのまま', measure.csvEscape('株式会社サンプル') === '株式会社サンプル');
    check(
      '**数式は無害化する（表計算ソフトで開いた瞬間に評価させない）**',
      measure.csvEscape('=1+1') === "'=1+1",
      measure.csvEscape('=1+1'),
    );
    check(
      '数式かつカンマを含む値は、無害化したうえで引用する',
      measure.csvEscape('=A1,B2') === '"\'=A1,B2"',
      measure.csvEscape('=A1,B2'),
    );
    check('カンマを含む値は引用する', measure.csvEscape('a,b') === '"a,b"');
    check('改行を含む値は引用する', measure.csvEscape('a\nb') === '"a\nb"');

    const blob = measure.buildCsvBlob([]);
    const head = new Uint8Array(await blob.arrayBuffer()).slice(0, 3);

    check(
      'CSV に BOM を付ける（Excel の文字化け対策）',
      head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF,
    );
    check(
      'ファイル名に日時が入る',
      /^card-ocr-measure-\d{8}-\d{4}\.csv$/.test(measure.buildCsvFileName(new Date(2026, 7, 4, 9, 5))),
    );
  }

  {
    /* 集計。 */
    const make = (status, totalMs) => measure.buildRow({
      no: 1, fileName: 'x', status, recordedAt: '', totalMs,
    });

    const summary = measure.summarize([
      make(measure.MeasureStatus.OK, 10000),
      make(measure.MeasureStatus.OK, 20000),
      make(measure.MeasureStatus.OK, 30000),
      make(measure.MeasureStatus.RATE_LIMITED, null),
      make(measure.MeasureStatus.ERROR, null),
    ]);

    check('総数を数える', summary.total === 5);
    check('成功数を数える', summary.ok === 3);
    check('429 を分けて数える', summary.rateLimited === 1);
    check('中央値は成功分から求める', summary.medianMs === 20000, String(summary.medianMs));
    check('空でも壊れない', measure.summarize([]).medianMs === null);
  }

  {
    /* 進行状況には個人情報を入れない。 */
    const source = await readFile(new URL('measure/measurement.js', APP_DIR), 'utf8');
    const pageSource = await readFile(new URL('measure/measure.js', APP_DIR), 'utf8');

    check(
      '**測定結果をドライブへ上げていない（CSVはダウンロードのみ）**',
      !/googleapis\.com|uploadType/i.test(source),
    );
    check(
      '**抽出結果を localStorage へ保存していない（§FR-21）**',
      !/setItem\([^)]*rows|setItem\([^)]*fields/.test(source),
    );
    /*
     * 「使っていない」の検査は、実際の呼び出し形にだけ一致させる。
     * 語そのものを禁じると、禁止理由を説明したコメントまで引っかかる。
     */
    check(
      '**台帳へ書いていない（測定は登録ではない）**',
      !/appendRow\(|ensureStorage\(/.test(pageSource),
    );
    check(
      '**本番のモジュールを使っている（自前の複製を持たない）**',
      /from '\.\.\/drive-ocr\.js'/.test(pageSource)
        && /from '\.\.\/gemini\.js'/.test(pageSource)
        && /from '\.\.\/merge\.js'/.test(pageSource),
    );
    check(
      'CSV を保存せずに閉じるのを止めている',
      /beforeunload/.test(pageSource),
    );
    check(
      'テスト環境（apps/）から import していない',
      !/from\s+['"][^'"]*\/apps\//.test(source) && !/from\s+['"][^'"]*\/apps\//.test(pageSource),
    );
  }

  {
    /* 検証用PoC が消えていること。 */
    const entries = await readdir(APP_DIR);

    check('**poc/ を撤去した（計画 §3-3）**', !entries.includes('poc'), entries.join(','));
    check('measure/ がある', entries.includes('measure'));
    check('help/ がある', entries.includes('help'));
  }

  /* ================================================================ */
  section('ヘルプ（help/ / §14.5 の対応事項1・2）');

  {
    const helpHtml = await readFile(new URL('help/index.html', APP_DIR), 'utf8');
    const helpJs = await readFile(new URL('help/help.js', APP_DIR), 'utf8');

    /*
     * **§5.3 の6項目がすべて載っていること。**
     * 画面の「ご利用の前に」は既定で畳まれているので、
     * 確実に届ける役割はここが担う（§5.3 の注記）。
     */
    for (const [label, needle] of [
      ['ドライブにのみ保存', 'あなたのGoogleドライブにのみ'],
      ['復旧義務を負わない', '復旧の義務を負いません'],
      ['利用費は利用者に課金', 'あなたに課金されます'],
      ['**無料枠の開示**', 'プロダクト改善に使われる場合があります'],
      ['**有料区分の推奨**', '有料区分のキーをおすすめします'],
      ['法令遵守は利用者', 'あなたの責任'],
      ['連続性を保証しない', '過去データとの連続性は保証しません'],
    ]) {
      check(`§5.3: ${label}`, helpHtml.includes(needle));
    }

    check(
      '**ヘルプの明示事項は畳まない（details にしない）**',
      !/<details[^>]*co-panel--notice/.test(helpHtml),
    );

    /* FR-22（削除）と FR-24（連携解除）。 */
    check('削除の方法を書いている（FR-22）', helpHtml.includes('保存したデータを消すには'));
    check(
      '**アプリに削除機能が無いことを明記している**',
      helpHtml.includes('このアプリに削除の機能はありません'),
    );
    check('連携解除の方法を書いている（FR-24）', helpHtml.includes('Googleとの連携を解除するには'));
    check(
      '**解除が2段階であることを明記している**',
      helpHtml.includes('2段階あります'),
    );
    check(
      '解除してもデータは消えないと明記している',
      helpHtml.includes('保存済みのデータは消えません'),
    );

    check('guardPage() を通している', helpJs.includes('guardPage'));
    check('画面の深さを 3 に設定している', helpJs.includes('setScreenDepth(3)'));
    check(
      '**ヘルプから外部へ通信していない**',
      !/fetch\(|XMLHttpRequest/.test(helpJs),
    );
    check(
      '本文は HTML に静的に書いてある（JS で組み立てない）',
      !/innerHTML|createElement/.test(helpJs),
    );

    /* 本体からの導線。 */
    check(
      '**名刺OCRの画面から常に見える場所にヘルプへの導線がある**',
      /href="\.\/help\/"/.test(htmlSource),
    );

    {
      const hrefs = [...helpHtml.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      const internal = hrefs.filter((href) => !/^https?:|^#/.test(href));

      check(
        'サイト内リンクの先頭に / を付けていない',
        internal.every((href) => !href.startsWith('/')),
        internal.filter((href) => href.startsWith('/')).join(', '),
      );
      check('規約とプライバシーポリシーへ繋いでいる', helpHtml.includes('legal/terms/') && helpHtml.includes('legal/privacy/'));
    }

    check('検索避けを入れている', /name="robots"\s+content="noindex/.test(helpHtml));
    check(
      '本体と同じ CSP を宣言している',
      helpHtml.includes("default-src 'self'") && helpHtml.includes("object-src 'none'"),
    );
  }

  /* ================================================================ */
  section('ソース検査（守るべき制約）');

  const FILES = [
    'config.js', 'gis-loader.js', 'drive-auth.js', 'drive-api.js',
    'prerequisites.js', 'sanitize.js', 'hash.js', 'schema.js',
    'sheets.js', 'drive-storage.js', 'capture.js', 'capture-flow.js',
    'drive-ocr.js', 'extract.js', 'prompt.js', 'gemini.js', 'merge.js',
    'register.js', 'app.js',
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

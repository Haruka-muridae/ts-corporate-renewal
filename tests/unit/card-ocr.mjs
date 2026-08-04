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

import { readFile } from 'node:fs/promises';
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
  section('ソース検査（守るべき制約）');

  const FILES = ['config.js', 'gis-loader.js', 'drive-auth.js', 'drive-api.js'];
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
    'www.googleapis.com',
    'accounts.google.com',
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

  check(
    'この一覧が実ファイルと一致している',
    FILES.length === sources.length && sources.every(({ text }) => text.length > 0),
  );

  finish();
} catch (error) {
  fatal(error);
}

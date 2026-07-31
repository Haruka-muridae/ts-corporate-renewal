/**
 * 設定・定数。
 *
 * ------------------------------------------------------------------
 * 設定値の置き場所は3層ある。優先順位は上から。
 * ------------------------------------------------------------------
 *   1. 認証設定スプレッドシート（settings シート）… 運用中に変えたい値
 *   2. Script Properties                          … 秘密情報と各種ID
 *   3. このファイルの DEFAULT_SETTINGS            … 出荷時の既定値
 *
 * 秘密情報（Stripeの秘密鍵、署名用シークレット等）は
 * **スプレッドシートに置かない**。必ず Script Properties に置く。
 * getSetting_() は秘密情報キーを読まない（SECRET_KEYS で遮断する）。
 * ------------------------------------------------------------------
 */

/** Script Properties のキー。 */
var PROP = {
  ROOT_FOLDER_ID: 'AUTH_ROOT_FOLDER_ID',
  AUTH_FOLDER_ID: 'AUTH_FOLDER_ID',
  USER_SPREADSHEET_ID: 'AUTH_USER_SPREADSHEET_ID',
  LOG_SPREADSHEET_ID: 'AUTH_LOG_SPREADSHEET_ID',
  CONFIG_SPREADSHEET_ID: 'AUTH_CONFIG_SPREADSHEET_ID',

  STRIPE_SECRET_KEY: 'STRIPE_SECRET_KEY',
  STRIPE_WEBHOOK_SECRET: 'STRIPE_WEBHOOK_SECRET',
  /** Webhook URL に付ける推測困難な合言葉（第一関門）。 */
  STRIPE_WEBHOOK_URL_KEY: 'STRIPE_WEBHOOK_URL_KEY',

  SESSION_SECRET: 'SESSION_SECRET',
  TOKEN_SECRET: 'TOKEN_SECRET',
  /** パスワードハッシュに掛ける追加の鍵。シートが漏れても単体では解けなくする。 */
  PASSWORD_PEPPER: 'PASSWORD_PEPPER',

  APP_BASE_URL: 'APP_BASE_URL',
  LOGIN_URL: 'LOGIN_URL',
  PORTAL_URL: 'PORTAL_URL'
};

/** 秘密情報。設定シートからは絶対に読まない。 */
var SECRET_KEYS = [
  PROP.STRIPE_SECRET_KEY,
  PROP.STRIPE_WEBHOOK_SECRET,
  PROP.STRIPE_WEBHOOK_URL_KEY,
  PROP.SESSION_SECRET,
  PROP.TOKEN_SECRET,
  PROP.PASSWORD_PEPPER
];

/** Drive 上のフォルダ名。 */
var DRIVE = {
  ROOT_FOLDER_NAME: 'TSAM AI',
  AUTH_FOLDER_NAME: 'Auth',
  USER_FILE_NAME: 'TSAM AI ユーザー管理',
  LOG_FILE_NAME: 'TSAM AI 認証ログ',
  CONFIG_FILE_NAME: 'TSAM AI 認証設定'
};

/** シート名。 */
var SHEETS = {
  USERS: 'users',
  PASSWORD_TOKENS: 'password_tokens',
  SESSIONS: 'sessions',
  STRIPE_EVENTS: 'stripe_events',

  LOGIN_LOGS: 'login_logs',
  ADMIN_ACTION_LOGS: 'admin_action_logs',
  SYSTEM_ERROR_LOGS: 'system_error_logs',

  SETTINGS: 'settings',
  PLANS: 'plans',
  CONSENT_ITEMS: 'consent_items',
  CONFIRM_SECTIONS: 'confirm_sections'
};

/** 各シートのヘッダー。列の順序はここが正本。 */
var HEADERS = {};
HEADERS[SHEETS.USERS] = [
  'user_id', 'email', 'password_hash', 'password_salt', 'role',
  'stripe_customer_id', 'stripe_subscription_id', 'subscription_status',
  'payment_exempt', 'account_status', 'last_login_at', 'login_failure_count',
  'locked_until', 'password_updated_at', 'created_at', 'updated_at'
];
HEADERS[SHEETS.PASSWORD_TOKENS] = [
  'token_id', 'user_id', 'token_hash', 'token_type', 'expires_at', 'used_at', 'created_at'
];
HEADERS[SHEETS.SESSIONS] = [
  'session_id', 'user_id', 'token_hash', 'remember_login', 'issued_at',
  'expires_at', 'revoked_at', 'last_access_at', 'user_agent_summary'
];
HEADERS[SHEETS.STRIPE_EVENTS] = [
  'event_id', 'event_type', 'received_at', 'processed_at', 'processing_status', 'error_message'
];
HEADERS[SHEETS.LOGIN_LOGS] = [
  'log_id', 'user_id', 'email_masked', 'result', 'failure_reason_code',
  'occurred_at', 'user_agent_summary'
];
HEADERS[SHEETS.ADMIN_ACTION_LOGS] = [
  'log_id', 'actor', 'action', 'target', 'detail', 'occurred_at'
];
HEADERS[SHEETS.SYSTEM_ERROR_LOGS] = [
  'log_id', 'scope', 'message', 'occurred_at'
];
HEADERS[SHEETS.SETTINGS] = ['key', 'value', 'description'];
HEADERS[SHEETS.PLANS] = [
  'plan_code', 'plan_name', 'stripe_price_id', 'amount', 'currency',
  'interval', 'features', 'enabled'
];
HEADERS[SHEETS.CONSENT_ITEMS] = [
  'item_id', 'label', 'required', 'sort_order', 'enabled'
];
HEADERS[SHEETS.CONFIRM_SECTIONS] = [
  'section', 'item_label', 'item_value', 'emphasis', 'sort_order'
];

/** users シートの列番号（1始まり）。HEADERS と必ず一致させる。 */
var USER_COL = {
  USER_ID: 1,
  EMAIL: 2,
  PASSWORD_HASH: 3,
  PASSWORD_SALT: 4,
  ROLE: 5,
  STRIPE_CUSTOMER_ID: 6,
  STRIPE_SUBSCRIPTION_ID: 7,
  SUBSCRIPTION_STATUS: 8,
  PAYMENT_EXEMPT: 9,
  ACCOUNT_STATUS: 10,
  LAST_LOGIN_AT: 11,
  LOGIN_FAILURE_COUNT: 12,
  LOCKED_UNTIL: 13,
  PASSWORD_UPDATED_AT: 14,
  CREATED_AT: 15,
  UPDATED_AT: 16
};

var TOKEN_COL = {
  TOKEN_ID: 1, USER_ID: 2, TOKEN_HASH: 3, TOKEN_TYPE: 4,
  EXPIRES_AT: 5, USED_AT: 6, CREATED_AT: 7
};

var SESSION_COL = {
  SESSION_ID: 1, USER_ID: 2, TOKEN_HASH: 3, REMEMBER_LOGIN: 4, ISSUED_AT: 5,
  EXPIRES_AT: 6, REVOKED_AT: 7, LAST_ACCESS_AT: 8, USER_AGENT_SUMMARY: 9
};

var EVENT_COL = {
  EVENT_ID: 1, EVENT_TYPE: 2, RECEIVED_AT: 3, PROCESSED_AT: 4,
  PROCESSING_STATUS: 5, ERROR_MESSAGE: 6
};

var PLAN_COL = {
  PLAN_CODE: 1, PLAN_NAME: 2, STRIPE_PRICE_ID: 3, AMOUNT: 4,
  CURRENCY: 5, INTERVAL: 6, FEATURES: 7, ENABLED: 8
};

/** consent_items シートの列（1始まり）。 */
var CONSENT_COL = {
  ITEM_ID: 1, LABEL: 2, REQUIRED: 3, SORT_ORDER: 4, ENABLED: 5
};

/** confirm_sections シートの列（1始まり）。 */
var CONFIRM_COL = {
  SECTION: 1, ITEM_LABEL: 2, ITEM_VALUE: 3, EMPHASIS: 4, SORT_ORDER: 5
};

/** アカウント状態。Stripe の契約状態とは別物。 */
var ACCOUNT_STATUS = {
  PENDING: 'pending',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  DISABLED: 'disabled',
  LOCKED: 'locked'
};

/** 契約状態（Stripe の subscription.status ＋ 管理者用の exempt）。 */
var SUBSCRIPTION_STATUS = {
  ACTIVE: 'active',
  TRIALING: 'trialing',
  PAST_DUE: 'past_due',
  CANCELED: 'canceled',
  UNPAID: 'unpaid',
  INCOMPLETE: 'incomplete',
  INCOMPLETE_EXPIRED: 'incomplete_expired',
  PAUSED: 'paused',
  EXEMPT: 'exempt'
};

var TOKEN_TYPE = {
  INITIAL_SETUP: 'initial_setup',
  PASSWORD_RESET: 'password_reset'
};

var ROLE = {
  ADMIN: 'admin',
  MEMBER: 'member'
};

/** 初期管理者。パスワードはここに書かない（書いてはならない）。 */
var INITIAL_ADMIN_EMAIL = 'architect@potenitas.com';

/**
 * 出荷時の既定値。運用中の変更は設定スプレッドシートで行う。
 * 値はすべて文字列として扱い、読み出し側で数値・真偽へ変換する。
 */
var DEFAULT_SETTINGS = {
  /* パスワード */
  PASSWORD_MIN_LENGTH: '12',
  PASSWORD_MAX_LENGTH: '128',
  /* PBKDF2 の反復回数。Apps Script の速度制約があるため運用で調整する。 */
  PBKDF2_ITERATIONS: '10000',

  /* ログイン失敗制限 */
  LOGIN_FAILURE_LIMIT: '5',
  LOCK_DURATION_MINUTES: '15',

  /* セッション */
  SESSION_TTL_HOURS: '12',
  REMEMBER_SESSION_TTL_DAYS: '30',

  /* トークン */
  INITIAL_TOKEN_TTL_HOURS: '72',
  RESET_TOKEN_TTL_MINUTES: '60',

  /* 契約状態の扱い */
  TRIALING_ALLOWED: 'TRUE',
  PAST_DUE_ALLOWED: 'FALSE',

  /* URL。空なら Script Properties → 既定の順に解決する。 */
  APP_BASE_URL: '',
  LOGIN_URL: '',
  PORTAL_URL: '',
  SUCCESS_URL: '',
  CANCEL_URL: '',
  PASSWORD_SETUP_URL: '',
  PASSWORD_RESET_URL: '',

  /* メール */
  MAIL_SENDER_NAME: 'TSAM AI',
  MAIL_ENABLED: 'TRUE',

  /* Checkout の乱用防止（1時間あたりの作成上限）。 */
  CHECKOUT_HOURLY_LIMIT: '60',

  /*
   * 同意を取得した利用規約の版。
   * 規約を改訂したらここを上げる。値が変わると、
   * 古い版で同意した申込みは受け付けなくなる。
   */
  TOS_VERSION: '1.0',

  /* 申込み前に赤枠で出す警告文。 */
  CONSENT_WARNING_TEXT: '本サービスは月額550円（税込）の1か月単位の自動更新契約です。解約されるまで毎月自動的に決済されます。AI機能のAPI利用料は月額料金に含まれず、利用者が各AIプロバイダーへ直接支払います。'
};

/**
 * APP_BASE_URL からの相対パス。
 * フロント側のディレクトリ構成と一致させること。
 */
var PATHS = {
  LOGIN: 'login/',
  PORTAL: 'portal/',
  PRICING: 'pricing/',
  PASSWORD_SETUP: 'password/setup/',
  PASSWORD_RESET: 'password/reset/',
  PAYMENT_SUCCESS: 'payment/success/',
  PAYMENT_CANCEL: 'payment/cancel/'
};

/** Web API から実行を許可する action。ホワイトリスト方式。 */
var ALLOWED_GET_ACTIONS = ['listPlans', 'publicConfig', 'health', 'listConsentConfig'];
var ALLOWED_POST_ACTIONS = [
  'login',
  'logout',
  'verifySession',
  'setupPassword',
  'requestPasswordReset',
  'resetPassword',
  'createCheckoutSession',
  'checkoutStatus'
];

/* ---------- 設定値の読み出し ---------- */

/** 1回の実行のあいだだけ設定を覚えておく（シート読み取りの往復を減らす）。 */
var settingsCache_ = null;

/** 設定シートを { key: value } として読む。読めない場合は空を返す。 */
function loadSettings_() {
  if (settingsCache_) {
    return settingsCache_;
  }

  var map = {};

  try {
    var sheet = getConfigSpreadsheet_().getSheetByName(SHEETS.SETTINGS);

    if (sheet) {
      var lastRow = sheet.getLastRow();

      if (lastRow >= 2) {
        var values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();

        for (var i = 0; i < values.length; i++) {
          var key = trimStr_(values[i][0]);

          if (key !== '') {
            map[key] = trimStr_(values[i][1]);
          }
        }
      }
    }
  } catch (err) {
    /* 設定が読めなくても既定値で動く。ここで例外を外へ出さない。 */
    Logger.log('loadSettings_ failed: ' + err);
  }

  settingsCache_ = map;
  return map;
}

/** テストと設定変更直後のために、覚えている設定を捨てる。 */
function clearSettingsCache_() {
  settingsCache_ = null;
}

/**
 * 設定値を1つ取り出す。
 * 優先順位: 設定シート → Script Properties → DEFAULT_SETTINGS。
 * 秘密情報キーは常に空文字を返す（設定シート経由で漏らさない）。
 */
function getSetting_(key) {
  if (SECRET_KEYS.indexOf(key) !== -1) {
    return '';
  }

  var sheetValue = loadSettings_()[key];

  if (sheetValue !== undefined && sheetValue !== '') {
    return sheetValue;
  }

  var propValue = getProperty_(key);

  if (propValue !== '') {
    return propValue;
  }

  return DEFAULT_SETTINGS[key] !== undefined ? DEFAULT_SETTINGS[key] : '';
}

function getSettingNumber_(key, fallback) {
  var raw = getSetting_(key);
  var num = Number(raw);

  if (raw === '' || !isFinite(num)) {
    return fallback;
  }

  return num;
}

function getSettingBool_(key, fallback) {
  var raw = String(getSetting_(key)).trim().toUpperCase();

  if (raw === '') {
    return fallback;
  }

  return raw === 'TRUE' || raw === 'YES' || raw === '1';
}

/** Script Property を読む。未設定は空文字。 */
function getProperty_(key) {
  try {
    var value = PropertiesService.getScriptProperties().getProperty(key);
    return typeof value === 'string' ? value.trim() : '';
  } catch (err) {
    return '';
  }
}

function setProperty_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, String(value));
}

/* ---------- URL の組み立て ---------- */

/** 末尾スラッシュを1つに揃える。 */
function withTrailingSlash_(url) {
  var value = trimStr_(url);

  if (value === '') {
    return '';
  }

  return value.charAt(value.length - 1) === '/' ? value : value + '/';
}

/** 公開サイトの基底URL。未設定なら空文字。 */
function getAppBaseUrl_() {
  return withTrailingSlash_(getSetting_('APP_BASE_URL'));
}

/**
 * 画面URLを解決する。
 * 設定シートで個別指定があればそれを、無ければ基底URL＋既定パスを使う。
 */
function resolveScreenUrl_(settingKey, defaultPath) {
  var explicit = trimStr_(getSetting_(settingKey));

  if (explicit !== '') {
    return explicit;
  }

  var base = getAppBaseUrl_();

  if (base === '') {
    return '';
  }

  return base + defaultPath;
}

function getLoginUrl_() { return resolveScreenUrl_('LOGIN_URL', PATHS.LOGIN); }
function getPortalUrl_() { return resolveScreenUrl_('PORTAL_URL', PATHS.PORTAL); }
function getSuccessUrl_() { return resolveScreenUrl_('SUCCESS_URL', PATHS.PAYMENT_SUCCESS); }
function getCancelUrl_() { return resolveScreenUrl_('CANCEL_URL', PATHS.PAYMENT_CANCEL); }
function getPasswordSetupUrl_() { return resolveScreenUrl_('PASSWORD_SETUP_URL', PATHS.PASSWORD_SETUP); }
function getPasswordResetUrl_() { return resolveScreenUrl_('PASSWORD_RESET_URL', PATHS.PASSWORD_RESET); }

/**
 * 初期セットアップ。
 *
 * エディタから setupAuthSystem() を1回実行する。
 * 何度実行しても、同じフォルダ・ファイル・シートを重複して作らない。
 *
 * 行うこと:
 *   1. マイドライブの「TSAM AI」フォルダを探し、無ければ作る
 *   2. その中の「Auth」フォルダを探し、無ければ作る
 *   3. ユーザー管理 / 認証ログ / 認証設定 の3ファイルを用意する
 *   4. 必要なシートとヘッダーを用意する
 *   5. フォルダIDと各スプレッドシートIDを Script Properties へ保存する
 *   6. 署名・トークン・pepper のシークレットを生成する（未設定のときだけ）
 *   7. 管理者レコードを作る
 *   8. 管理者の初期設定トークンを発行し、メールで案内する
 *   9. 結果をログへ出す
 */

/** 名前でフォルダを探し、無ければ作る。 */
function ensureFolder_(parent, name) {
  var iterator = parent.getFoldersByName(name);

  if (iterator.hasNext()) {
    return iterator.next();
  }

  return parent.createFolder(name);
}

/**
 * 名前でスプレッドシートを探し、無ければ作る。
 * 作った直後は「マイドライブ直下」に置かれるため、指定フォルダへ移す。
 */
function ensureSpreadsheet_(folder, name) {
  var iterator = folder.getFilesByName(name);

  while (iterator.hasNext()) {
    var file = iterator.next();

    if (file.getMimeType() === MimeType.GOOGLE_SHEETS) {
      return SpreadsheetApp.openById(file.getId());
    }
  }

  var created = SpreadsheetApp.create(name);
  var createdFile = DriveApp.getFileById(created.getId());

  createdFile.moveTo(folder);

  return created;
}

/**
 * シートとヘッダーを用意する。
 * すでにある場合はヘッダーだけ整え、データ行には触らない。
 */
function ensureSheet_(spreadsheet, sheetName) {
  var header = HEADERS[sheetName];
  var sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }

  sheet.getRange(1, 1, 1, header.length).setValues([header]);
  sheet.setFrozenRows(1);

  return sheet;
}

/** 新規作成直後の「シート1」を、他のシートが揃ってから片付ける。 */
function removeDefaultSheet_(spreadsheet) {
  var sheets = spreadsheet.getSheets();

  if (sheets.length <= 1) {
    return;
  }

  for (var i = 0; i < sheets.length; i++) {
    var name = sheets[i].getName();

    if ((name === 'シート1' || name === 'Sheet1') && HEADERS[name] === undefined) {
      spreadsheet.deleteSheet(sheets[i]);
      return;
    }
  }
}

/** 設定シートへ既定値を書く。すでにある行は上書きしない。 */
function ensureDefaultSettings_(sheet) {
  var lastRow = sheet.getLastRow();
  var existing = {};

  if (lastRow >= 2) {
    var values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();

    for (var i = 0; i < values.length; i++) {
      existing[trimStr_(values[i][0])] = true;
    }
  }

  var descriptions = {
    PASSWORD_MIN_LENGTH: 'パスワードの最低文字数',
    PASSWORD_MAX_LENGTH: 'パスワードの最大文字数',
    PBKDF2_ITERATIONS: 'パスワードハッシュの反復回数（大きいほど安全だが遅い）',
    LOGIN_FAILURE_LIMIT: '連続ログイン失敗の上限回数',
    LOCK_DURATION_MINUTES: '上限到達後のロック時間（分）',
    SESSION_TTL_HOURS: '通常ログインの有効期限（時間）',
    REMEMBER_SESSION_TTL_DAYS: 'ログイン状態を保持した場合の有効期限（日）',
    INITIAL_TOKEN_TTL_HOURS: '初期設定トークンの有効期限（時間）',
    RESET_TOKEN_TTL_MINUTES: 'パスワード再設定トークンの有効期限（分）',
    TRIALING_ALLOWED: 'trialing を利用可能として扱うか（TRUE/FALSE）',
    PAST_DUE_ALLOWED: 'past_due を利用可能として扱うか（TRUE/FALSE）',
    APP_BASE_URL: '公開サイトの基底URL（末尾スラッシュ付き）',
    LOGIN_URL: 'ログイン画面のURL（空なら基底URL＋login/）',
    PORTAL_URL: 'PortalのURL（空なら基底URL＋portal/）',
    SUCCESS_URL: '決済成功画面のURL（空なら基底URL＋payment/success/）',
    CANCEL_URL: '決済キャンセル画面のURL（空なら基底URL＋payment/cancel/）',
    PASSWORD_SETUP_URL: 'パスワード初期設定画面のURL',
    PASSWORD_RESET_URL: 'パスワード再設定画面のURL',
    MAIL_SENDER_NAME: 'メールの送信者名',
    MAIL_ENABLED: 'メール送信を行うか（TRUE/FALSE）',
    CHECKOUT_HOURLY_LIMIT: 'Checkout Session の1時間あたり作成上限',
    TOS_VERSION: '同意を取得した利用規約の版。改訂したら上げる（古い版の同意は無効になる）',
    CONSENT_WARNING_TEXT: '申込み前に赤枠で表示する警告文'
  };

  var keys = Object.keys(DEFAULT_SETTINGS);
  var added = 0;

  for (var k = 0; k < keys.length; k++) {
    var key = keys[k];

    if (existing[key]) {
      continue;
    }

    sheet.appendRow([key, DEFAULT_SETTINGS[key], descriptions[key] || '']);
    added++;
  }

  return added;
}

/** プランシートへ、書き換え前提の見本を1行だけ置く。 */
function ensureSamplePlan_(sheet) {
  if (sheet.getLastRow() >= 2) {
    return false;
  }

  sheet.appendRow([
    'standard',
    'スタンダード',
    '',
    '',
    'jpy',
    'month',
    'TSAM AI の各種アプリ\nメールサポート',
    'FALSE'
  ]);

  return true;
}

/**
 * 同意チェック項目の初期データを入れる。
 *
 * すでに行がある場合は何もしない。
 * 文言は運用側で編集される前提なので、上書きすると直した内容が消える。
 */
function ensureConsentItems_(sheet) {
  if (sheet.getLastRow() >= 2) {
    return 0;
  }

  var seed = [
    [
      'tos',
      '{terms}および{privacy}に同意します。',
      'TRUE', 1, 'TRUE'
    ],
    [
      'auto_renew',
      '月額550円（税込）・1か月ごとの自動更新契約であり、解約しない限り毎月決済されることを確認しました。',
      'TRUE', 2, 'TRUE'
    ],
    [
      'api_cost',
      'AI機能の利用に必要なAPI利用料は月額料金に含まれず、各AIプロバイダーへ利用者が直接支払うこと、使用量・課金額は利用者自身が管理することを理解しました。',
      'TRUE', 3, 'TRUE'
    ],
    [
      'cancel_policy',
      '解約後は支払済み期間の終了日まで利用でき、日割り・残存期間分の返金は行われないこと（{tokusho}）を確認しました。',
      'TRUE', 4, 'TRUE'
    ]
  ];

  for (var i = 0; i < seed.length; i++) {
    sheet.appendRow(seed[i]);
  }

  return seed.length;
}

/**
 * 契約条件の確認表の初期データを入れる。
 *
 * 特定商取引法が最終確認画面での表示を求める項目を網羅する。
 * 価格・自動更新・支払時期・契約期間・解約方法・返金条件・API料金。
 */
function ensureConfirmSections_(sheet) {
  if (sheet.getLastRow() >= 2) {
    return 0;
  }

  var seed = [
    ['料金と支払い', '月額料金', '550円（税込）', 'TRUE', 1],
    ['料金と支払い', '1年間継続の目安', '6,600円（税込）', 'FALSE', 2],
    ['料金と支払い', '支払方法', 'クレジットカード（Stripe）', 'FALSE', 3],
    ['料金と支払い', '支払時期', '初回決済日を基準に毎月自動決済', 'FALSE', 4],
    ['契約期間と自動更新', '契約期間', '1か月', 'FALSE', 5],
    ['契約期間と自動更新', '自動更新', 'あり（解約まで継続）', 'TRUE', 6],
    ['API利用料', '月額料金への含有', '含まれない', 'TRUE', 7],
    ['API利用料', '支払先', '各AIプロバイダーへ直接支払い', 'TRUE', 8],
    ['解約', '解約方法', '問い合わせ窓口（architect@potenitas.com）への申し出', 'FALSE', 9],
    ['解約', '解約後の利用', '支払済み期間の終了日まで利用可能', 'FALSE', 10],
    ['解約', '返金', '日割り・残存期間分の返金なし', 'TRUE', 11]
  ];

  for (var i = 0; i < seed.length; i++) {
    sheet.appendRow(seed[i]);
  }

  return seed.length;
}

/** シークレットを未設定のときだけ生成する。既存の値は絶対に上書きしない。 */
function ensureSecret_(propertyKey) {
  if (getProperty_(propertyKey) !== '') {
    return false;
  }

  setProperty_(propertyKey, randomToken_() + randomToken_());
  return true;
}

/**
 * 初期セットアップ。エディタから手動で実行する。
 */
function setupAuthSystem() {
  var report = [];

  /* ---- 1〜2. Drive の階層 ---- */
  var root = ensureFolder_(DriveApp.getRootFolder(), DRIVE.ROOT_FOLDER_NAME);
  var authFolder = ensureFolder_(root, DRIVE.AUTH_FOLDER_NAME);

  setProperty_(PROP.ROOT_FOLDER_ID, root.getId());
  setProperty_(PROP.AUTH_FOLDER_ID, authFolder.getId());

  report.push('フォルダ: マイドライブ/' + DRIVE.ROOT_FOLDER_NAME + '/' + DRIVE.AUTH_FOLDER_NAME);
  report.push('  ' + DRIVE.ROOT_FOLDER_NAME + ' = ' + root.getId());
  report.push('  ' + DRIVE.AUTH_FOLDER_NAME + ' = ' + authFolder.getId());

  /* ---- 3〜4. スプレッドシートとシート ---- */
  var userBook = ensureSpreadsheet_(authFolder, DRIVE.USER_FILE_NAME);
  ensureSheet_(userBook, SHEETS.USERS);
  ensureSheet_(userBook, SHEETS.PASSWORD_TOKENS);
  ensureSheet_(userBook, SHEETS.SESSIONS);
  ensureSheet_(userBook, SHEETS.STRIPE_EVENTS);
  removeDefaultSheet_(userBook);

  var logBook = ensureSpreadsheet_(authFolder, DRIVE.LOG_FILE_NAME);
  ensureSheet_(logBook, SHEETS.LOGIN_LOGS);
  ensureSheet_(logBook, SHEETS.ADMIN_ACTION_LOGS);
  ensureSheet_(logBook, SHEETS.SYSTEM_ERROR_LOGS);
  removeDefaultSheet_(logBook);

  var configBook = ensureSpreadsheet_(authFolder, DRIVE.CONFIG_FILE_NAME);
  var settingsSheet = ensureSheet_(configBook, SHEETS.SETTINGS);
  var plansSheet = ensureSheet_(configBook, SHEETS.PLANS);
  var consentSheet = ensureSheet_(configBook, SHEETS.CONSENT_ITEMS);
  var confirmSheet = ensureSheet_(configBook, SHEETS.CONFIRM_SECTIONS);
  removeDefaultSheet_(configBook);

  /* ---- 5. ID を保存（これ以降は名前で検索しない） ---- */
  setProperty_(PROP.USER_SPREADSHEET_ID, userBook.getId());
  setProperty_(PROP.LOG_SPREADSHEET_ID, logBook.getId());
  setProperty_(PROP.CONFIG_SPREADSHEET_ID, configBook.getId());

  report.push('スプレッドシート:');
  report.push('  ' + DRIVE.USER_FILE_NAME + ' = ' + userBook.getId());
  report.push('  ' + DRIVE.LOG_FILE_NAME + ' = ' + logBook.getId());
  report.push('  ' + DRIVE.CONFIG_FILE_NAME + ' = ' + configBook.getId());

  /* ID を保存したあとで設定を読み直す。 */
  clearSettingsCache_();

  var addedSettings = ensureDefaultSettings_(settingsSheet);
  var addedPlan = ensureSamplePlan_(plansSheet);

  report.push('設定: ' + addedSettings + ' 件の既定値を追加しました。');
  report.push('プラン: ' + (addedPlan ? '見本を1行追加しました（Price ID を入れて enabled=TRUE にしてください）。' : '既存の行を維持しました。'));

  var addedConsent = ensureConsentItems_(consentSheet);
  var addedConfirm = ensureConfirmSections_(confirmSheet);

  report.push('同意項目: ' + (addedConsent > 0 ? addedConsent + ' 件の初期データを追加しました。' : '既存の行を維持しました。'));
  report.push('確認表: ' + (addedConfirm > 0 ? addedConfirm + ' 行の初期データを追加しました。' : '既存の行を維持しました。'));

  clearSettingsCache_();

  /* ---- 6. シークレット ---- */
  var generated = [];

  if (ensureSecret_(PROP.SESSION_SECRET)) { generated.push(PROP.SESSION_SECRET); }
  if (ensureSecret_(PROP.TOKEN_SECRET)) { generated.push(PROP.TOKEN_SECRET); }
  if (ensureSecret_(PROP.PASSWORD_PEPPER)) { generated.push(PROP.PASSWORD_PEPPER); }
  if (ensureSecret_(PROP.STRIPE_WEBHOOK_URL_KEY)) { generated.push(PROP.STRIPE_WEBHOOK_URL_KEY); }

  report.push('シークレット: ' + (generated.length === 0
    ? '既存の値をそのまま使います。'
    : generated.join(', ') + ' を生成しました。'));

  /* ---- 7. 管理者レコード ---- */
  var adminResult = ensureAdminUser_();
  report.push('管理者: ' + adminResult.message);

  /* ---- 8. 初期設定の案内 ---- */
  if (adminResult.needsPassword) {
    var mailed = issueAdminSetupLink_(false);
    report.push('管理者の初期設定: ' + mailed.message);
  }

  /* ---- 9. 残りの手動作業 ---- */
  report.push('');
  report.push('--- 手動で設定が必要な項目 ---');
  report.push('Script Properties: ' + PROP.STRIPE_SECRET_KEY + ' / ' + PROP.STRIPE_WEBHOOK_SECRET);
  report.push('Script Properties: ' + PROP.APP_BASE_URL + '（例 https://tsam-ai.com/）');
  report.push('認証設定シート: plans の stripe_price_id と enabled');
  report.push('詳細は STRIPE_SETUP.md / AUTH_SETUP.md を参照してください。');

  var text = report.join('\n');
  Logger.log(text);

  logAdminAction_('setup', 'setupAuthSystem', '', 'settings_added=' + addedSettings);

  return text;
}

/**
 * 管理者レコードを用意する。
 *
 * パスワードはここで設定しない（コードに初期パスワードを書かない）。
 * 本人が初期設定リンクから設定するまで pending のまま。
 */
function ensureAdminUser_() {
  return withLock_(function () {
    var existing = findUserByEmail_(INITIAL_ADMIN_EMAIL);

    if (existing) {
      /* role と payment_exempt だけは、期待どおりか確かめて直す。 */
      var updates = {};

      if (trimStr_(existing.role).toLowerCase() !== ROLE.ADMIN) {
        updates[USER_COL.ROLE] = ROLE.ADMIN;
      }

      if (existing.paymentExempt !== true) {
        updates[USER_COL.PAYMENT_EXEMPT] = boolToCell_(true);
      }

      if (trimStr_(existing.subscriptionStatus) === '') {
        updates[USER_COL.SUBSCRIPTION_STATUS] = SUBSCRIPTION_STATUS.EXEMPT;
      }

      if (Object.keys(updates).length > 0) {
        updateUserCells_(existing, updates);
        logAdminAction_('setup', 'admin_repaired', existing.userId, '');
      }

      return {
        message: '既存の管理者レコードを確認しました。',
        needsPassword: existing.passwordHash === ''
      };
    }

    var created = createUser_({
      email: INITIAL_ADMIN_EMAIL,
      role: ROLE.ADMIN,
      subscriptionStatus: SUBSCRIPTION_STATUS.EXEMPT,
      paymentExempt: true,
      accountStatus: ACCOUNT_STATUS.PENDING
    });

    logAdminAction_('setup', 'admin_created', created.userId, maskEmail_(INITIAL_ADMIN_EMAIL));

    return { message: '管理者レコードを作成しました（パスワード未設定）。', needsPassword: true };
  });
}

/**
 * 管理者の初期設定リンクを発行する。
 *
 * @param {boolean} printToLog true にすると **実行ログへURLを出力する**。
 *   メールを受け取れない場合の緊急手段。
 *   使ったあとは Apps Script の実行ログを消すこと。
 */
function issueAdminSetupLink_(printToLog) {
  var user = findUserByEmail_(INITIAL_ADMIN_EMAIL);

  if (!user) {
    return { ok: false, message: '管理者レコードがありません。setupAuthSystem() を先に実行してください。' };
  }

  var issued = withLock_(function () {
    invalidateTokens_(user.userId, TOKEN_TYPE.INITIAL_SETUP);
    return issueToken_(user.userId, TOKEN_TYPE.INITIAL_SETUP);
  });

  var url = buildTokenUrl_(getPasswordSetupUrl_(), issued.token);

  if (url === '') {
    return {
      ok: false,
      message: 'パスワード初期設定URLが未設定です。認証設定シートの APP_BASE_URL を先に入力してください。'
    };
  }

  logAdminAction_('setup', 'admin_setup_link_issued', user.userId, 'printed=' + (printToLog === true));

  if (printToLog === true) {
    Logger.log('管理者の初期設定URL（使用後はこの実行ログを削除してください）:\n' + url);
    return { ok: true, message: '初期設定URLを実行ログへ出力しました。' };
  }

  var sent = sendInitialSetupMail_(INITIAL_ADMIN_EMAIL, issued.token, issued.expiresAtMs);

  return {
    ok: sent,
    message: sent
      ? INITIAL_ADMIN_EMAIL + ' へ初期設定の案内を送信しました。'
      : 'メールを送信できませんでした。printAdminSetupLink() で実行ログへ出力してください。'
  };
}

/**
 * 管理者の初期設定リンクをメールで送り直す。
 * エディタから手動で実行する。
 */
function sendAdminSetupLink() {
  var result = issueAdminSetupLink_(false);
  Logger.log(result.message);
  return result.message;
}

/**
 * 管理者の初期設定リンクを実行ログへ出力する。
 *
 * メールを受け取れないときの緊急手段。
 * **実行後は必ず実行ログを削除すること**（URLにトークンが含まれる）。
 */
function printAdminSetupLink() {
  var result = issueAdminSetupLink_(true);
  Logger.log(result.message);
  return result.message;
}

/**
 * 設定の抜けを点検する。デプロイ前に実行する。
 * 秘密情報の値そのものは出力せず、設定済みかどうかだけを出す。
 */
function checkAuthSetup() {
  var lines = [];

  var required = [
    [PROP.USER_SPREADSHEET_ID, 'ユーザー管理スプレッドシート'],
    [PROP.LOG_SPREADSHEET_ID, '認証ログスプレッドシート'],
    [PROP.CONFIG_SPREADSHEET_ID, '認証設定スプレッドシート'],
    [PROP.SESSION_SECRET, 'セッション署名用シークレット'],
    [PROP.TOKEN_SECRET, 'トークン署名用シークレット'],
    [PROP.PASSWORD_PEPPER, 'パスワード用 pepper'],
    [PROP.STRIPE_SECRET_KEY, 'Stripe シークレットキー'],
    [PROP.STRIPE_WEBHOOK_URL_KEY, 'Webhook URL の合言葉']
  ];

  for (var i = 0; i < required.length; i++) {
    var set = getProperty_(required[i][0]) !== '';
    lines.push((set ? '  OK  ' : '  未設定  ') + required[i][1] + '（' + required[i][0] + '）');
  }

  var optional = [[PROP.STRIPE_WEBHOOK_SECRET, 'Stripe Webhook 署名シークレット（中継を使う場合のみ必須）']];

  for (var j = 0; j < optional.length; j++) {
    var has = getProperty_(optional[j][0]) !== '';
    lines.push((has ? '  OK  ' : '  任意  ') + optional[j][1]);
  }

  lines.push('');
  lines.push('URL:');
  lines.push('  APP_BASE_URL = ' + (getAppBaseUrl_() || '（未設定）'));
  lines.push('  LOGIN_URL    = ' + (getLoginUrl_() || '（未設定）'));
  lines.push('  PORTAL_URL   = ' + (getPortalUrl_() || '（未設定）'));
  lines.push('  SUCCESS_URL  = ' + (getSuccessUrl_() || '（未設定）'));
  lines.push('  CANCEL_URL   = ' + (getCancelUrl_() || '（未設定）'));

  var plans = listPublicPlans_();
  lines.push('');
  lines.push('有効なプラン: ' + plans.length + ' 件');

  var text = lines.join('\n');
  Logger.log(text);
  return text;
}

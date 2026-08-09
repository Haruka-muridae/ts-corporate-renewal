/**
 * 初期セットアップ。
 *
 * サイドバー（SidebarSetup.html）の②から setupNotifier() を1回実行する。
 * **何度実行しても同じ結果になる**（優等）。鍵と接続キーは既にあれば作り直さない。
 * 作り直すと、録音アプリ側の設定と Push 購読が黙って無効になるためである。
 *
 * 行うこと:
 *   1. 4つのシートとヘッダーを用意する
 *   2. 設定の既定値を書く（未設定の項目だけ）
 *   3. VAPID の鍵を作る（無ければ）
 *   4. 接続キーを作る（無ければ）
 *   5. tick() の毎分トリガーを作る（同名の既存トリガーは消してから）
 */

/** サイドバーの②が呼ぶ。戻り値はそのまま画面へ出す。 */
function setupNotifier() {
  ensureSheets_();
  writeSettings_({});
  ensureVapidKeys_();
  ensureConnectKey_();
  ensureTickTrigger_();

  return getSetupStatus();
}

function ensureSheets_() {
  for (var i = 0; i < SHEET_ORDER.length; i++) {
    ensureSheet_(SHEET_ORDER[i]);
  }
}

/**
 * VAPID の鍵を用意する。
 *
 * 公開鍵は「非圧縮形式（0x04 + X + Y = 65バイト）の base64url」で保存する。
 * ブラウザの `applicationServerKey` がこの形しか受け取らないため、
 * PEM ではなくこちらを持つ。
 */
function ensureVapidKeys_() {
  if (getProperty_(PROP.VAPID_PRIVATE) !== '' && getProperty_(PROP.VAPID_PUBLIC) !== '') {
    return false;
  }

  requireJsrsasign_();

  var pair = KEYUTIL.generateKeypair('EC', 'secp256r1');

  setProperty_(PROP.VAPID_PRIVATE, KEYUTIL.getPEM(pair.prvKeyObj, 'PKCS8PRV'));
  setProperty_(PROP.VAPID_PUBLIC, hexToBase64Url_(pair.pubKeyObj.pubKeyHex));

  return true;
}

/**
 * 接続キーを用意する。
 *
 * Web アプリのURLは第三者にも推測されうるため、health 以外の全 API で
 * このキーを検証する（Api.gs）。32バイトあれば総当たりは成立しない。
 */
function ensureConnectKey_() {
  if (getProperty_(PROP.CONNECT_KEY) !== '') {
    return false;
  }

  setProperty_(PROP.CONNECT_KEY, randomBase64Url_(32));
  return true;
}

/**
 * 接続キーを作り直す。漏れた疑いがあるときだけ使う。
 * **録音アプリ側の設定は無効になる**ので、接続コードを貼り直してもらう。
 */
function resetConnectionKey() {
  setProperty_(PROP.CONNECT_KEY, randomBase64Url_(32));
  return getConnectionCode();
}

/**
 * tick() の毎分トリガーを作る。
 * 同名の既存トリガーを消してから作るので、実行するたびに増えることはない。
 */
function ensureTickTrigger_() {
  var triggers = ScriptApp.getProjectTriggers();

  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'tick') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  ScriptApp.newTrigger('tick').timeBased().everyMinutes(1).create();

  return true;
}

function hasTickTrigger_() {
  try {
    var triggers = ScriptApp.getProjectTriggers();

    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === 'tick') {
        return true;
      }
    }
  } catch (err) {
    /* 権限が無い状態（初回の承認前）では読めない。未作成として扱う。 */
  }

  return false;
}

/* ---------- サイドバーが読む状態 ---------- */

/**
 * セットアップの進み具合。サイドバーは、この5項目を ○/× で並べる。
 * **接続キーそのものはここに入れない**（表示は getConnectionCode() で明示的に取る）。
 */
function getSetupStatus() {
  var book = null;

  try {
    book = getBook_();
  } catch (err) {
    book = null;
  }

  var sheetsReady = true;

  if (book) {
    for (var i = 0; i < SHEET_ORDER.length; i++) {
      if (!book.getSheetByName(SHEET_ORDER[i])) {
        sheetsReady = false;
      }
    }
  } else {
    sheetsReady = false;
  }

  return {
    jsrsasign: hasJsrsasign_(),
    sheets: sheetsReady,
    keys: getProperty_(PROP.VAPID_PUBLIC) !== '' && getProperty_(PROP.VAPID_PRIVATE) !== '',
    connectKey: getProperty_(PROP.CONNECT_KEY) !== '',
    trigger: hasTickTrigger_(),
    deployed: webAppUrl_() !== '',
    version: NOTIFIER_VERSION
  };
}

/**
 * 録音アプリへ貼る接続コード。
 *
 * URL は「デプロイを管理」で公開したあとでなければ取れない。
 * 空文字なら、サイドバーは③（公開）がまだだと案内する。
 */
function getConnectionCode() {
  return {
    url: webAppUrl_(),
    key: getProperty_(PROP.CONNECT_KEY)
  };
}

function webAppUrl_() {
  try {
    var url = ScriptApp.getService().getUrl();
    return url ? String(url) : '';
  } catch (err) {
    return '';
  }
}

/* ---------- jsrsasign ---------- */

function hasJsrsasign_() {
  return typeof KEYUTIL !== 'undefined' && typeof KJUR !== 'undefined';
}

function requireJsrsasign_() {
  if (!hasJsrsasign_()) {
    throw new Error(
      'jsrsasign が読み込まれていません。lib_jsrsasign.gs の冒頭のスタブの下に、'
      + 'jsrsasign-all-min.js の中身を貼り付けてください（gas-notifier/README.md §2）。'
    );
  }
}

/**
 * jsrsasign が本当に使えるかを確かめる。
 *
 * **貼り付けの成否はここでしか分からない。** 貼り忘れ・順序違い・途中で切れた、
 * のいずれも「通知が届かない」という同じ症状になり、原因が見えない。
 * セットアップの途中と、トラブル時の切り分けで実行する。
 */
function verifyJsrsasign() {
  requireJsrsasign_();

  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    throw new Error(
      'lib_jsrsasign.gs のスタブが評価されていません。'
      + 'スタブ（navigator / window の定義）が jsrsasign 本体より上にあるか確認してください。'
    );
  }

  var pair = KEYUTIL.generateKeypair('EC', 'secp256r1');
  var privatePem = KEYUTIL.getPEM(pair.prvKeyObj, 'PKCS8PRV');
  var publicPem = KEYUTIL.getPEM(pair.pubKeyObj);

  var token = KJUR.jws.JWS.sign(
    'ES256',
    JSON.stringify({ typ: 'JWT', alg: 'ES256' }),
    JSON.stringify({
      aud: 'https://push.example.test',
      exp: Math.floor((Date.now() + VAPID_JWT_TTL_MS) / 1000),
      sub: 'mailto:verify@example.test'
    }),
    privatePem
  );

  if (!KJUR.jws.JWS.verify(token, publicPem, ['ES256'])) {
    throw new Error('ES256 の署名を検証できませんでした。jsrsasign の貼り付け内容を確認してください。');
  }

  var raw = hexToBase64Url_(pair.pubKeyObj.pubKeyHex);

  if (raw.length < 80) {
    throw new Error('公開鍵の形式が想定と異なります（非圧縮形式の65バイトではありません）。');
  }

  Logger.log('jsrsasign OK / ES256 署名と検証に成功しました。');

  return 'jsrsasign は正しく読み込まれています（ES256 の署名と検証に成功）。';
}

/* ---------- バイト列の変換 ---------- */

/** 16進文字列 → base64url（パディング無し）。VAPID の公開鍵に使う。 */
function hexToBase64Url_(hex) {
  var text = String(hex || '').replace(/[^0-9a-fA-F]/g, '');

  if (text.length === 0 || text.length % 2 !== 0) {
    throw new Error('16進文字列の長さが不正です。');
  }

  var bytes = [];

  for (var i = 0; i < text.length; i += 2) {
    var value = parseInt(text.substr(i, 2), 16);
    /* Apps Script のバイト配列は符号付き（-128..127）。 */
    bytes.push(value > 127 ? value - 256 : value);
  }

  return stripBase64Padding_(Utilities.base64EncodeWebSafe(bytes));
}

/**
 * ランダムな base64url 文字列。
 *
 * Apps Script には暗号用の乱数が無い。Utilities.getUuid() は v4 UUID
 * （122ビットのランダム）なので、必要バイト数ぶんつなげて使う。
 * Math.random() は使わない。
 */
function randomBase64Url_(byteLength) {
  var bytes = [];

  while (bytes.length < byteLength) {
    var hex = Utilities.getUuid().replace(/-/g, '');

    for (var i = 0; i + 1 < hex.length && bytes.length < byteLength; i += 2) {
      var value = parseInt(hex.substr(i, 2), 16);
      bytes.push(value > 127 ? value - 256 : value);
    }
  }

  return stripBase64Padding_(Utilities.base64EncodeWebSafe(bytes));
}

/** base64url の '=' を落とす。RFC 8292 の Authorization ヘッダーはパディング無し。 */
function stripBase64Padding_(text) {
  return String(text).replace(/=+$/, '');
}

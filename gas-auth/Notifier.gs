/**
 * カレンダー通知（notifier）のライセンス発行と照会。
 *
 * ==================================================================
 * この2つの action が果たす役割
 * ==================================================================
 *   issueNotifierLicense  … ログイン中の本人へライセンスキーを1つ渡す
 *   verifyNotifierLicense … Workers（notifier-gate）からの server-to-server 照会
 *
 * 通知が出るかどうかの最終判断は Workers 側にあるが、**その材料である
 * 「この人はいま権利があるか」を答えるのはここだけ**である。
 * 認証系が契約状態の正本を持っているため（users シート ＋ Stripe）。
 * ==================================================================
 *
 * ==================================================================
 * entitlement 方式にした理由（課金形態が未決だから）
 * ==================================================================
 * 「既存サブスクに同梱」で始めるが、将来アドオンにする可能性が残っている。
 * 判定条件をコードへ埋め込むと、そのときに実装変更・再デプロイが要る。
 *
 * 設定シートの NOTIFIER_ENTITLEMENT ひとつで切り替わる形にしてある。
 *   all_active        … 契約が有効な会員すべて（初期値）
 *   plan:<price_id>   … その価格の契約を持つ会員だけ
 * ==================================================================
 *
 * ==================================================================
 * 「無効」と「判定できなかった」を混ぜない
 * ==================================================================
 * Stripe へ問い合わせられなかった場合に valid:false を返すと、
 * **契約している人の通知が Stripe の不調だけで止まる。**
 * そのときは success:false（エラー応答）を返すこと。
 * Workers 側はエラー応答を「届かなかった」と読み、直前まで有効だった
 * ライセンスを猶予（grace）へ入れる。
 * workers/notifier-gate/src/license.mjs の verifyWithAuthGas と対で読むこと。
 * ==================================================================
 */

/** entitlement の書き方。 */
var NOTIFIER_ENTITLEMENT_ALL = 'all_active';
var NOTIFIER_ENTITLEMENT_PLAN_PREFIX = 'plan:';

/**
 * ライセンスキーを発行する（ログイン必須）。
 *
 * すでに発行済みなら**同じキーを返す**。作り直すと、そのキーで
 * セットアップ済みのテンプレートが全部動かなくなる。
 */
function issueNotifierLicense_(input) {
  var verified = verifySessionToken_(input && input.sessionToken);

  if (!verified.ok) {
    return { ok: false, errorPair: ERRORS.SESSION_INVALID };
  }

  var userId = verified.user.userId;

  /*
   * 「読んでから書く」処理なのでロックの中で行う。
   * ロックの外で読んだ user を使い回すと、同時に2回押されたときに
   * 別々のキーを発行して後勝ちになる（先に配ったキーが黙って死ぬ）。
   */
  var licenseKey = withLock_(function () {
    var user = findUserById_(userId);

    if (!user) {
      return '';
    }

    var existing = trimStr_(user.notifierLicenseKey);

    if (existing !== '') {
      return existing;
    }

    /* randomToken_ は 32バイト相当を base64url にした43文字を返す。 */
    var issued = randomToken_();
    var updates = {};

    updates[USER_COL.NOTIFIER_LICENSE_KEY] = issued;
    updateUserCells_(user, updates);

    return issued;
  });

  if (licenseKey === '') {
    return { ok: false, errorPair: ERRORS.SESSION_INVALID };
  }

  var entitlement = evaluateNotifierEntitlement_(findUserById_(userId));

  /*
   * 権利が無くてもキーは渡す。
   * 「キーはあるが通知は出ない（expired）」という状態にしておくと、
   * 契約後にセットアップをやり直さずに通知が始まる。
   * 画面は entitled を見て料金ページへの導線を出す。
   */
  return {
    ok: true,
    data: {
      licenseKey: licenseKey,
      entitled: entitlement.valid === true,
      plan: entitlement.plan
    }
  };
}

/**
 * ライセンスを照会する（Workers からの server-to-server 呼び出し）。
 *
 * 共有シークレットが合わないときは、キーの存在に触れずに定型エラーを返す。
 * 「そのキーは無い」と「シークレットが違う」を区別できると、
 * このエンドポイントがキーの総当たり確認に使える。
 */
function verifyNotifierLicense_(input) {
  if (!notifierSharedSecretMatches_(input && input.secret)) {
    return { ok: false, errorPair: ERRORS.INVALID_REQUEST };
  }

  var user = findUserByNotifierLicenseKey_(input.licenseKey);
  var entitlement = evaluateNotifierEntitlement_(user);

  if (entitlement.undetermined === true) {
    /* 判定できなかった。**valid:false ではなくエラーを返す**（冒頭の説明）。 */
    return { ok: false, errorPair: ERRORS.STRIPE_ERROR };
  }

  return {
    ok: true,
    data: {
      valid: entitlement.valid === true,
      plan: entitlement.plan,
      status: entitlement.status
    }
  };
}

/** 共有シークレットの照合。設定が無ければ常に不一致とする。 */
function notifierSharedSecretMatches_(candidate) {
  var expected = getProperty_(PROP.NOTIFIER_SHARED_SECRET);

  if (expected === '') {
    return false;
  }

  return timingSafeEqual_(candidate, expected);
}

/**
 * ライセンスキーから利用者を探す。
 *
 * 比較を timingSafeEqual_ で行うのは、応答時間から先頭何文字が
 * 合っているかを推測されないため（接続キーの照合と同じ考え）。
 */
function findUserByNotifierLicenseKey_(licenseKey) {
  var key = trimStr_(licenseKey);

  if (key === '') {
    return null;
  }

  var found = findRow_(SHEETS.USERS, function (values) {
    var stored = trimStr_(values[USER_COL.NOTIFIER_LICENSE_KEY - 1]);

    /* 未発行（空欄）の行が空文字のキーと一致しないよう、先に弾く。 */
    return stored !== '' && timingSafeEqual_(stored, key);
  });

  return found ? rowToUser_(found.rowNumber, found.values) : null;
}

/**
 * この利用者に通知の権利があるか。
 *
 * 戻り値は { valid, plan, status, undetermined }。
 *   status       … 運営が原因を追うための語。利用者には見せない
 *   undetermined … 判定できなかった（Stripe 不通など）。valid とは別物
 */
function evaluateNotifierEntitlement_(user) {
  if (!user) {
    return { valid: false, plan: '', status: 'not_found' };
  }

  /* 1. アカウントそのものが有効か（停止・無効・未設定を弾く）。 */
  if (trimStr_(user.accountStatus) !== ACCOUNT_STATUS.ACTIVE) {
    return { valid: false, plan: '', status: 'account_' + (trimStr_(user.accountStatus) || 'unknown') };
  }

  /* 2. 契約が有効か。trialing / past_due の扱いは設定に従う（既存の判定を再利用）。 */
  if (!isSubscriptionUsable_(user)) {
    return {
      valid: false,
      plan: '',
      status: trimStr_(user.subscriptionStatus) || 'no_subscription'
    };
  }

  /*
   * 3. 支払い免除（管理者・招待枠）はここで通す。
   *
   * plan: 指定の entitlement では価格IDを照合するが、免除の利用者は
   * そもそも Stripe の契約を持たない。免除を先に通さないと、
   * アドオン化した瞬間に管理者自身の通知が止まる。
   */
  if (user.paymentExempt === true) {
    return { valid: true, plan: 'exempt', status: 'exempt' };
  }

  var rule = trimStr_(getSetting_('NOTIFIER_ENTITLEMENT')) || NOTIFIER_ENTITLEMENT_ALL;

  /* 4-a. 全会員に同梱。 */
  if (rule === NOTIFIER_ENTITLEMENT_ALL) {
    return { valid: true, plan: NOTIFIER_ENTITLEMENT_ALL, status: 'active' };
  }

  /* 4-b. 特定プランのみ。 */
  if (rule.indexOf(NOTIFIER_ENTITLEMENT_PLAN_PREFIX) === 0) {
    var wanted = trimStr_(rule.slice(NOTIFIER_ENTITLEMENT_PLAN_PREFIX.length));

    if (wanted === '') {
      logSystemError_('notifier', 'NOTIFIER_ENTITLEMENT の plan: が空です');
      return { valid: false, plan: '', status: 'entitlement_misconfigured' };
    }

    var priced = findSubscriptionPriceIds_(user);

    if (!priced.ok) {
      /* Stripe へ届かなかった。無効とは言えない。 */
      return { valid: false, plan: '', status: 'stripe_unreachable', undetermined: true };
    }

    return {
      valid: priced.priceIds.indexOf(wanted) !== -1,
      plan: wanted,
      status: priced.priceIds.indexOf(wanted) !== -1 ? 'active' : 'plan_mismatch'
    };
  }

  /*
   * 4-c. 知らない書き方。**通さない。**
   *
   * 設定の打ち間違いで全員が通ってしまうより、止まって気づけるほうがよい。
   * 気づけるようにエラーログへ残す（黙って止まると原因を追えない）。
   */
  logSystemError_('notifier', 'NOTIFIER_ENTITLEMENT の値を解釈できません');

  return { valid: false, plan: '', status: 'entitlement_unknown' };
}

/**
 * 利用者の契約に含まれる価格IDを取り出す。
 *
 * users シートは価格IDを持っていない（契約IDまで）。列を足して Webhook で
 * 埋める案もあるが、既存データの移行が要るうえ Webhook の経路を触ることになる。
 * entitlement が plan: 指定のときだけ、そのつど Stripe へ聞くほうを採った。
 * 呼ばれるのは Workers のキャッシュが切れたときだけ（1利用者あたり6時間に1回）。
 */
function findSubscriptionPriceIds_(user) {
  var subscriptionId = trimStr_(user.stripeSubscriptionId);

  if (subscriptionId === '') {
    /* 契約IDが無い＝照合する対象が無い。これは「判定できた（該当なし）」。 */
    return { ok: true, priceIds: [] };
  }

  var result = stripeRequest_('get', 'subscriptions/' + encodeURIComponent(subscriptionId), null);

  if (!result.ok) {
    return { ok: false, priceIds: [] };
  }

  var items = (result.body && result.body.items && result.body.items.data) || [];
  var priceIds = [];

  for (var i = 0; i < items.length; i++) {
    var price = items[i] && items[i].price;
    var id = price ? trimStr_(price.id) : '';

    if (id !== '') {
      priceIds.push(id);
    }
  }

  return { ok: true, priceIds: priceIds };
}

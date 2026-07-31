/**
 * 申込み前の同意（利用規約への同意と契約条件の確認）。
 *
 * ------------------------------------------------------------------
 * 文言をコードに書かない
 * ------------------------------------------------------------------
 * チェックボックスの文言も、確認表の内容も、認証設定スプレッドシートで
 * 管理する（既存のプラン表示と同じ扱い）。
 * 文言を直すのに再デプロイを必要としないため、法務レビューの
 * 指摘に運用側だけで対応できる。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * 画面のチェックだけに依存しない（重要）
 * ------------------------------------------------------------------
 * 画面のチェックボックスは開発者ツールから外せる。
 * したがって createCheckoutSession の入口で、
 *   - required な項目がすべて同意されているか
 *   - 同意した規約の版が現行版と一致するか
 * をサーバー側で必ず確認する。満たさなければ決済へ進ませない。
 * ------------------------------------------------------------------
 */

/** 現在の利用規約の版。 */
function getTosVersion_() {
  return trimStr_(getSetting_('TOS_VERSION')) || '1.0';
}

/* ---------- 同意チェック項目 ---------- */

/** 行を同意項目オブジェクトへ変換する。 */
function rowToConsentItem_(values) {
  return {
    itemId: trimStr_(values[CONSENT_COL.ITEM_ID - 1]),
    label: trimStr_(values[CONSENT_COL.LABEL - 1]),
    required: parseBool_(values[CONSENT_COL.REQUIRED - 1]),
    sortOrder: parseCount_(values[CONSENT_COL.SORT_ORDER - 1]),
    enabled: parseBool_(values[CONSENT_COL.ENABLED - 1])
  };
}

/**
 * 画面へ出す同意項目。enabled のものだけを sort_order 順で返す。
 */
function listConsentItems_() {
  var rows = readRows_(SHEETS.CONSENT_ITEMS);
  var out = [];

  for (var i = 0; i < rows.length; i++) {
    var item = rowToConsentItem_(rows[i]);

    if (item.itemId === '' || !item.enabled) {
      continue;
    }

    out.push({
      itemId: item.itemId,
      label: item.label,
      required: item.required,
      sortOrder: item.sortOrder
    });
  }

  out.sort(function (a, b) { return a.sortOrder - b.sortOrder; });

  return out;
}

/** 同意が必須の項目IDの一覧。検証に使う。 */
function listRequiredConsentIds_() {
  var items = listConsentItems_();
  var out = [];

  for (var i = 0; i < items.length; i++) {
    if (items[i].required) {
      out.push(items[i].itemId);
    }
  }

  return out;
}

/* ---------- 契約条件の確認表 ---------- */

function rowToConfirmRow_(values) {
  return {
    section: trimStr_(values[CONFIRM_COL.SECTION - 1]),
    itemLabel: trimStr_(values[CONFIRM_COL.ITEM_LABEL - 1]),
    itemValue: trimStr_(values[CONFIRM_COL.ITEM_VALUE - 1]),
    emphasis: parseBool_(values[CONFIRM_COL.EMPHASIS - 1]),
    sortOrder: parseCount_(values[CONFIRM_COL.SORT_ORDER - 1])
  };
}

/**
 * 契約条件の確認表。
 * セクション見出しごとにまとめ、sort_order 順で返す。
 */
function listConfirmSections_() {
  var rows = readRows_(SHEETS.CONFIRM_SECTIONS);
  var parsed = [];

  for (var i = 0; i < rows.length; i++) {
    var row = rowToConfirmRow_(rows[i]);

    if (row.section === '' || row.itemLabel === '') {
      continue;
    }

    parsed.push(row);
  }

  parsed.sort(function (a, b) { return a.sortOrder - b.sortOrder; });

  /* セクション名の初出順にまとめる。 */
  var order = [];
  var bucket = {};

  for (var j = 0; j < parsed.length; j++) {
    var name = parsed[j].section;

    if (!bucket[name]) {
      bucket[name] = [];
      order.push(name);
    }

    bucket[name].push({
      label: parsed[j].itemLabel,
      value: parsed[j].itemValue,
      emphasis: parsed[j].emphasis
    });
  }

  var out = [];

  for (var k = 0; k < order.length; k++) {
    out.push({ section: order[k], items: bucket[order[k]] });
  }

  return out;
}

/* ---------- 画面へ返す設定 ---------- */

/**
 * 申込み画面が必要とする同意設定一式。
 * 認証は不要。秘密情報は含めない。
 */
function buildConsentConfig_() {
  return {
    tosVersion: getTosVersion_(),
    warningText: trimStr_(getSetting_('CONSENT_WARNING_TEXT')),
    consentItems: listConsentItems_(),
    confirmSections: listConfirmSections_()
  };
}

/* ---------- 検証 ---------- */

/**
 * 申込みに添えられた同意を検証する。
 *
 * @param {Object} input { agreedItems, tosVersion }
 * @return {{ok: boolean, reason: string}}
 */
function verifyConsent_(input) {
  var agreed = Array.isArray(input.agreedItems) ? input.agreedItems : null;

  if (agreed === null) {
    return { ok: false, reason: 'AGREED_ITEMS_MISSING' };
  }

  var version = trimStr_(input.tosVersion);

  if (version === '') {
    return { ok: false, reason: 'TOS_VERSION_MISSING' };
  }

  if (version !== getTosVersion_()) {
    /* 規約が改訂された。古い版の同意では受け付けない。 */
    return { ok: false, reason: 'TOS_VERSION_MISMATCH' };
  }

  /* 重複や余計な値が混ざっていても、必須が揃っているかだけを見る。 */
  var agreedSet = {};

  for (var i = 0; i < agreed.length; i++) {
    var id = trimStr_(agreed[i]);

    if (id !== '') {
      agreedSet[id] = true;
    }
  }

  var required = listRequiredConsentIds_();

  for (var j = 0; j < required.length; j++) {
    if (!agreedSet[required[j]]) {
      return { ok: false, reason: 'REQUIRED_NOT_AGREED:' + required[j] };
    }
  }

  return { ok: true, reason: '' };
}

/**
 * Checkout Session の metadata へ載せる同意の記録。
 * 何にいつ同意したかを、決済側にも残す。
 */
function buildConsentMetadata_(input) {
  var agreed = Array.isArray(input.agreedItems) ? input.agreedItems : [];
  var cleaned = [];

  for (var i = 0; i < agreed.length; i++) {
    var id = trimStr_(agreed[i]);

    if (id !== '' && cleaned.indexOf(id) === -1) {
      cleaned.push(id);
    }
  }

  return {
    tos_version: getTosVersion_(),
    tos_agreed_at: nowIso_(),
    /* Stripe の metadata は文字列しか持てないため、カンマ区切りにする。 */
    agreed_items: clip_(cleaned.join(','), 480)
  };
}

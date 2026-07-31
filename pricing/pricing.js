/*
 * 料金プラン選択と、申込み前の同意。
 *
 * ------------------------------------------------------------------
 * 表示内容の出どころ
 * ------------------------------------------------------------------
 * プラン、警告文、契約条件の確認表、同意チェック項目のいずれも
 * サーバー（認証設定スプレッドシート）から取得する。
 * HTMLやJSへ文言や料金を直書きしない。
 * 文言の変更に再デプロイが要らないようにするため。
 *
 * Stripe の Price ID はサーバーだけが持つ。
 * この画面が送るのはプランコードと同意内容だけ。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * 同意はサーバーでも確認される
 * ------------------------------------------------------------------
 * ここでのチェックボックス制御は、利用者に分かりやすくするためのもの。
 * 開発者ツールで disabled を外しても、サーバーが必須項目の充足と
 * 規約版の一致を確かめるため、同意なしでは決済へ進めない。
 * ------------------------------------------------------------------
 */

import { setScreenDepth, rootPath } from '../auth/config.js';
import {
  listPlans,
  listConsentConfig,
  createCheckoutSession,
  ApiError,
} from '../auth/api.js';
import {
  MESSAGES,
  createMessageArea,
  formatAmount,
  formatInterval,
} from '../auth/ui.js';

setScreenDepth(1);

const loadingElement = document.getElementById('pricing-loading');
const listElement = document.getElementById('pricing-plans');
const messageElement = document.getElementById('pricing-message');
const intervalElement = document.getElementById('pricing-terms-interval');

const consentSection = document.getElementById('pricing-consent');
const consentSelected = document.getElementById('pricing-consent-selected');
const consentWarning = document.getElementById('pricing-consent-warning');
const consentWarningBody = document.getElementById('pricing-consent-warning-body');
const consentSections = document.getElementById('pricing-consent-sections');
const consentItems = document.getElementById('pricing-consent-items');
const consentForm = document.getElementById('pricing-consent-form');
const consentSubmit = document.getElementById('pricing-consent-submit');
const consentBack = document.getElementById('pricing-consent-back');
const consentMessageElement = document.getElementById('pricing-consent-message');

const message = createMessageArea(messageElement);
const consentMessage = createMessageArea(consentMessageElement);

/* サーバーから取得した同意設定。取得できるまでは null。 */
let consentConfig = null;

/* いま選ばれているプラン。 */
let selectedPlan = null;

/* 進行中の申し込み。1つだけ許す。 */
let checkoutInFlight = false;

/*
 * 同意項目の文言に含まれる {terms} などを、法務ページへのリンクへ展開する。
 *
 * 文字列は textContent で入れ、リンクだけを要素として組み立てる。
 * innerHTML を使わないため、設定シート側の文言にマークアップが
 * 混ざっていても、それがそのまま実行されることはない。
 */
const LINK_TARGETS = Object.freeze({
  terms: { path: 'legal/terms/', text: '利用規約' },
  privacy: { path: 'legal/privacy/', text: 'プライバシーポリシー' },
  tokusho: { path: 'legal/tokusho/', text: '特定商取引法に基づく表記' },
});

function renderLabelInto(target, label) {
  const pattern = /\{(terms|privacy|tokusho)\}/g;
  let lastIndex = 0;
  let match = pattern.exec(label);

  while (match !== null) {
    if (match.index > lastIndex) {
      target.append(document.createTextNode(label.slice(lastIndex, match.index)));
    }

    const spec = LINK_TARGETS[match[1]];
    const link = document.createElement('a');
    link.href = `${rootPath()}${spec.path}`;
    link.textContent = spec.text;
    /* 申込みの途中で離脱させない。 */
    link.target = '_blank';
    link.rel = 'noopener';
    target.append(link);

    lastIndex = match.index + match[0].length;
    match = pattern.exec(label);
  }

  if (lastIndex < label.length) {
    target.append(document.createTextNode(label.slice(lastIndex)));
  }
}

/* ---------- プラン ---------- */

function buildPlanCard(plan) {
  const item = document.createElement('li');
  item.className = 'auth-plan';

  const name = document.createElement('h2');
  name.className = 'auth-plan__name';
  name.textContent = plan.planName || plan.planCode;
  item.append(name);

  const priceText = formatAmount(plan.amount, plan.currency);
  const intervalText = formatInterval(plan.interval);

  const price = document.createElement('p');
  price.className = 'auth-plan__price';

  if (priceText === '') {
    /* 料金が未確定のまま公開されている場合。推測して表示しない。 */
    price.textContent = '料金は準備中です';
  } else {
    price.textContent = priceText;

    if (intervalText !== '') {
      const interval = document.createElement('span');
      interval.className = 'auth-plan__interval';
      interval.textContent = `／${intervalText}（税込）`;
      price.append(interval);
    }
  }

  item.append(price);

  if (Array.isArray(plan.features) && plan.features.length > 0) {
    const features = document.createElement('ul');
    features.className = 'auth-plan__features';

    plan.features
      .map((line) => String(line).trim())
      .filter((line) => line !== '')
      .forEach((line) => {
        const feature = document.createElement('li');
        feature.textContent = line;
        features.append(feature);
      });

    if (features.childElementCount > 0) {
      item.append(features);
    }
  }

  const actions = document.createElement('div');
  actions.className = 'auth-plan__action';

  const button = document.createElement('button');
  button.className = 'auth-button';
  button.type = 'button';
  button.textContent = 'このプランを選ぶ';
  button.setAttribute('aria-label', `${plan.planName || plan.planCode}のプランを選ぶ`);
  button.dataset.planCode = plan.planCode;

  actions.append(button);
  item.append(actions);

  button.addEventListener('click', () => selectPlan(plan));

  return item;
}

/* ---------- 同意セクション ---------- */

/* 契約条件の確認表を描く。 */
function renderConfirmSections(sections) {
  consentSections.textContent = '';

  sections.forEach((section) => {
    const wrapper = document.createElement('section');
    wrapper.className = 'auth-consent__section';

    const title = document.createElement('h3');
    title.className = 'auth-consent__section-title';
    title.textContent = section.section;
    wrapper.append(title);

    const table = document.createElement('table');
    table.className = 'auth-consent__table';

    const body = document.createElement('tbody');

    (Array.isArray(section.items) ? section.items : []).forEach((row) => {
      const tr = document.createElement('tr');

      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = row.label;

      const td = document.createElement('td');
      td.textContent = row.value;

      /* 強調は色だけでなく太字でも示す（CSS 側で両方を当てる）。 */
      if (row.emphasis === true) {
        td.dataset.emphasis = 'true';
      }

      tr.append(th, td);
      body.append(tr);
    });

    table.append(body);
    wrapper.append(table);
    consentSections.append(wrapper);
  });
}

/* 同意チェックボックスを描く。 */
function renderConsentItems(items) {
  consentItems.textContent = '';

  items.forEach((item) => {
    const label = document.createElement('label');
    label.className = 'auth-consent__item';
    label.htmlFor = `consent-${item.itemId}`;

    const checkbox = document.createElement('input');
    checkbox.className = 'auth-consent__checkbox';
    checkbox.type = 'checkbox';
    checkbox.id = `consent-${item.itemId}`;
    checkbox.value = item.itemId;
    checkbox.dataset.required = item.required === true ? 'true' : 'false';

    checkbox.addEventListener('change', () => {
      updateSubmitState();

      if (checkbox.checked) {
        checkbox.removeAttribute('aria-invalid');
      }

      if (consentMessageElement.dataset.kind === 'error') {
        consentMessage.clear();
      }
    });

    const text = document.createElement('span');
    renderLabelInto(text, String(item.label ?? ''));

    if (item.required === true) {
      const required = document.createElement('span');
      required.className = 'auth-consent__required';
      required.textContent = '（必須）';
      text.append(required);
    }

    label.append(checkbox, text);
    consentItems.append(label);
  });
}

function listRequiredCheckboxes() {
  return [...consentItems.querySelectorAll('input[data-required="true"]')];
}

function listCheckedIds() {
  return [...consentItems.querySelectorAll('input[type="checkbox"]')]
    .filter((box) => box.checked)
    .map((box) => box.value);
}

/* 必須がすべてチェックされていればボタンを有効にする。 */
function updateSubmitState() {
  const allChecked = listRequiredCheckboxes().every((box) => box.checked);
  consentSubmit.disabled = !allChecked || checkoutInFlight;
}

/* プランを選んだら、確認と同意のセクションを出す。 */
function selectPlan(plan) {
  selectedPlan = plan;

  const priceText = formatAmount(plan.amount, plan.currency);
  const intervalText = formatInterval(plan.interval);
  const planName = plan.planName || plan.planCode;

  consentSelected.textContent = priceText === ''
    ? `選択中のプラン: ${planName}`
    : `選択中のプラン: ${planName}（${priceText}${intervalText === '' ? '' : ` ／ ${intervalText}`}）`;

  /* チェック状態を引き継がない。プランを選び直したら同意もやり直す。 */
  consentItems.querySelectorAll('input[type="checkbox"]').forEach((box) => {
    box.checked = false;
    box.removeAttribute('aria-invalid');
  });

  consentMessage.clear();
  updateSubmitState();

  consentSection.hidden = false;
  consentSection.scrollIntoView({ block: 'start', behavior: 'auto' });
}

/* ---------- 申し込み ---------- */

async function startCheckout() {
  if (checkoutInFlight || !selectedPlan || !consentConfig) {
    return;
  }

  /*
   * 送信直前にもう一度確かめる。
   * disabled を外して押された場合でも、ここで止まる。
   * 最終的な担保はサーバー側の検証。
   */
  const missing = listRequiredCheckboxes().filter((box) => !box.checked);

  if (missing.length > 0) {
    consentMessage.show('必須の項目にすべてチェックしてください。', 'error');
    missing[0].setAttribute('aria-invalid', 'true');
    missing[0].focus();
    return;
  }

  checkoutInFlight = true;
  consentMessage.clear();

  const idleLabel = consentSubmit.textContent;
  consentSubmit.disabled = true;
  consentSubmit.setAttribute('aria-busy', 'true');
  consentSubmit.textContent = '決済画面へ移動しています…';

  listElement.querySelectorAll('button[data-plan-code]').forEach((button) => {
    button.disabled = true;
  });

  try {
    const data = await createCheckoutSession({
      planCode: selectedPlan.planCode,
      agreedItems: listCheckedIds(),
      tosVersion: consentConfig.tosVersion,
    });

    if (!data?.checkoutUrl) {
      throw new ApiError('STRIPE_ERROR', '決済手続きを開始できませんでした。時間をおいて再度お試しください。');
    }

    /*
     * Stripe のホストする決済画面へ移動する。
     * replace ではなく assign にして、決済画面から「戻る」で戻れるようにする。
     */
    globalThis.location.assign(data.checkoutUrl);
  } catch (error) {
    checkoutInFlight = false;

    consentSubmit.removeAttribute('aria-busy');
    consentSubmit.textContent = idleLabel;
    updateSubmitState();

    listElement.querySelectorAll('button[data-plan-code]').forEach((button) => {
      button.disabled = false;
    });

    consentMessage.show(
      error instanceof ApiError ? error.userMessage : MESSAGES.network,
      'error',
    );
    consentMessage.focus();
  }
}

consentForm.addEventListener('submit', (event) => {
  event.preventDefault();
  startCheckout();
});

consentBack.addEventListener('click', () => {
  consentSection.hidden = true;
  selectedPlan = null;
  listElement.scrollIntoView({ block: 'start', behavior: 'auto' });
});

/* ---------- 起動 ---------- */

/* 支払周期の説明文を、実際のプランに合わせて具体化する。 */
function describeIntervals(plans) {
  const intervals = new Set(
    plans.map((plan) => formatInterval(plan.interval)).filter((text) => text !== ''),
  );

  if (intervals.size === 0) {
    return;
  }

  intervalElement.textContent = `${[...intervals].join('・')}でのお支払いです。`;
}

async function init() {
  try {
    /*
     * プランと同意設定を同時に取る。
     * 同意設定が取れなければ申し込みへ進ませない
     * （同意なしで決済へ進む抜け道を作らないため）。
     */
    const [planData, consentData] = await Promise.all([
      listPlans(),
      listConsentConfig(),
    ]);

    const plans = Array.isArray(planData?.plans) ? planData.plans : [];
    consentConfig = consentData ?? null;

    loadingElement.hidden = true;

    if (plans.length === 0) {
      message.show(
        '現在お申し込みいただけるプランがありません。お手数ですが、時間をおいて再度ご確認ください。',
        'info',
      );
      return;
    }

    if (!consentConfig || !Array.isArray(consentConfig.consentItems)) {
      message.show(
        'お申し込みの準備ができませんでした。時間をおいて再度お試しください。',
        'error',
      );
      return;
    }

    if (typeof consentConfig.warningText === 'string' && consentConfig.warningText !== '') {
      consentWarningBody.textContent = consentConfig.warningText;
      consentWarning.hidden = false;
    }

    renderConfirmSections(
      Array.isArray(consentConfig.confirmSections) ? consentConfig.confirmSections : [],
    );
    renderConsentItems(consentConfig.consentItems);
    updateSubmitState();

    plans.forEach((plan) => listElement.append(buildPlanCard(plan)));
    listElement.hidden = false;
    describeIntervals(plans);
  } catch (error) {
    loadingElement.hidden = true;

    message.show(
      error instanceof ApiError ? error.userMessage : MESSAGES.network,
      'error',
    );
  }
}

init();

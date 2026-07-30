/*
 * 料金プラン選択画面。
 *
 * ------------------------------------------------------------------
 * プラン情報の出どころ
 * ------------------------------------------------------------------
 * 料金・プラン名・機能はサーバー（認証設定スプレッドシートの plans シート）
 * から取得する。HTMLやJSへ料金を書かない。
 *
 * Stripe の Price ID はサーバー側だけが持つ。
 * この画面が送るのはプランコードだけで、Price ID は受け取りも送りもしない。
 * 受け取ると、書き換えて任意の価格で購入させられる余地が生まれる。
 * ------------------------------------------------------------------
 */

import { setScreenDepth } from '../auth/config.js';
import { listPlans, createCheckoutSession, ApiError } from '../auth/api.js';
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

const message = createMessageArea(messageElement);

/* 進行中の申し込み。1つだけ許す（二重に Checkout を作らない）。 */
let checkoutInFlight = false;

/* プラン1件分のカードを組み立てる。文字列はすべて textContent で入れる。 */
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
  button.textContent = 'このプランで申し込む';
  /* どのプランのボタンかを読み上げで区別できるようにする。 */
  button.setAttribute('aria-label', `${plan.planName || plan.planCode}のプランで申し込む`);
  button.dataset.planCode = plan.planCode;

  actions.append(button);
  item.append(actions);

  button.addEventListener('click', () => startCheckout(plan, button));

  return item;
}

/* Stripe Checkout を開始する。 */
async function startCheckout(plan, button) {
  if (checkoutInFlight) {
    return;
  }

  checkoutInFlight = true;
  message.clear();

  const idleLabel = button.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = '決済画面へ移動しています…';

  /* 進行中は他のプランのボタンも押させない。 */
  const allButtons = listElement.querySelectorAll('button[data-plan-code]');
  allButtons.forEach((other) => { other.disabled = true; });

  try {
    const data = await createCheckoutSession({ planCode: plan.planCode });

    if (!data?.checkoutUrl) {
      throw new ApiError('STRIPE_ERROR', '決済手続きを開始できませんでした。時間をおいて再度お試しください。');
    }

    /*
     * Stripe のホストする決済画面へ移動する。
     * replace ではなく assign にして、決済画面から「戻る」で
     * このプラン一覧へ戻れるようにする。
     */
    globalThis.location.assign(data.checkoutUrl);
  } catch (error) {
    checkoutInFlight = false;

    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = idleLabel;
    allButtons.forEach((other) => { other.disabled = false; });

    message.show(
      error instanceof ApiError ? error.userMessage : MESSAGES.network,
      'error',
    );
    message.focus();
  }
}

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
    const data = await listPlans();
    const plans = Array.isArray(data?.plans) ? data.plans : [];

    loadingElement.hidden = true;

    if (plans.length === 0) {
      message.show(
        '現在お申し込みいただけるプランがありません。お手数ですが、時間をおいて再度ご確認ください。',
        'info',
      );
      return;
    }

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

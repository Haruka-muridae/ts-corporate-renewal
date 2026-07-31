/*
 * 決済完了画面。
 *
 * ==================================================================
 * この画面が表示されたことは、契約が有効であることを意味しない
 * ==================================================================
 * この画面は Stripe からの戻り先にすぎず、URL を直接開くこともできる。
 * 利用者の登録と契約の反映は、すべて Webhook（サーバー側）が行う。
 *
 * したがってこの画面は:
 *   - セッションを発行しない
 *   - アカウントを作らない
 *   - 契約状態を変更しない
 *
 * 行うのは「案内メールを待ってよい状態か」の確認と表示だけ。
 * 確認できなくても、手続きが失敗したとは限らない（Webhook が遅れているだけの
 * 場合がある）ため、断定的な失敗表示はしない。
 * ==================================================================
 */

import { setScreenDepth } from '../../auth/config.js';
import { checkoutStatus } from '../../auth/api.js';
import { createMessageArea } from '../../auth/ui.js';

setScreenDepth(2);

const message = createMessageArea(document.getElementById('success-message'));
const emailNote = document.getElementById('success-email-note');

/* Stripe が付けて戻す ?session_id=cs_... を読む。形式を確認してから使う。 */
function readCheckoutSessionId() {
  try {
    const params = new URLSearchParams(globalThis.location?.search ?? '');
    const value = params.get('session_id') ?? '';

    return /^cs_[A-Za-z0-9_]+$/.test(value) ? value : '';
  } catch {
    return '';
  }
}

async function init() {
  const sessionId = readCheckoutSessionId();

  if (sessionId === '') {
    /*
     * 直接開かれた場合。手続きの状態は分からないので、
     * 案内だけを出して何も断定しない。
     */
    return;
  }

  try {
    const data = await checkoutStatus(sessionId);

    /* 伏せたメールアドレスだけを出す。全体は表示しない。 */
    if (data?.emailMasked) {
      emailNote.textContent = `${data.emailMasked} 宛にお送りします。数分かかることがあります。`;
    }

    if (data?.paymentStatus === 'paid' || data?.accountReady === true) {
      message.show('決済を確認しました。パスワード設定のご案内メールをご確認ください。', 'success');
      return;
    }

    message.show(
      'お手続きを受け付けました。登録の反映に数分かかる場合があります。'
      + 'しばらくしてもメールが届かない場合は、パスワード再設定からお手続きください。',
      'info',
    );
  } catch {
    /*
     * 確認に失敗しただけで、決済が失敗したとは限らない。
     * 断定せず、次に取れる行動だけを案内する。
     */
    message.show(
      'お手続きの状態を確認できませんでした。案内メールが届いているかご確認ください。',
      'info',
    );
  }
}

init();

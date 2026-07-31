/*
 * 決済完了・失敗ページに何を出すかを決める（実装仕様書 4.5）。
 *
 * ==================================================================
 * 方針
 * ==================================================================
 *   完了ページへ遷移したこと自体は「支払済み」の根拠にしない。
 *   確定はWebhookだけが行う（仕様書4.5）。この関数はDBに記録された状態を
 *   読んで、そのとき出せる案内を選ぶだけにする。
 *
 *   PayPay のようなリダイレクト型では、利用者が戻ってきた時点で
 *   まだ Webhook が届いていないことがある。その場合は「確認中」を出し、
 *   支払済みだと言い切らない。
 * ==================================================================
 */

/** 画面の状態。 */
export const RESULT_KINDS = [
  'paid',      // 支払済み。受付番号を出す
  'pending',   // 確認中。まだWebhookが届いていない
  'failed',    // 決済失敗
  'expired',   // 決済期限切れ
  'refunded',  // 返金済み（例外対応）
  'unknown',   // 申込が見つからない
];

/**
 * 申込と支払の記録から、画面に出す状態を決める。
 *
 * @param {{
 *   application: { status: string, receipt_number: string | null } | null,
 *   payment: { payment_status: string } | null,
 * }} input
 * @returns {{
 *   kind: string,
 *   receiptNumber: string | null,
 *   isConfirmed: boolean,
 *   canRetry: boolean,
 * }}
 */
export function resolveResultState({ application, payment }) {
  if (application === null || application === undefined) {
    return { kind: 'unknown', receiptNumber: null, isConfirmed: false, canRetry: false };
  }

  /*
   * 判断は applications.status を基準にする。
   * payments 側だけが先に更新されている状態は、Webhookの処理途中でしか
   * 起こらない。その場合も確定扱いにはしない。
   */
  switch (application.status) {
    case 'paid':
      return {
        kind: 'paid',
        /*
         * 支払済みなのに受付番号が無いのは、採番の途中で止まった場合。
         * 番号を空欄で見せず、確認中として扱う。
         */
        receiptNumber: application.receipt_number,
        isConfirmed: application.receipt_number !== null,
        canRetry: false,
      };

    case 'failed':
      return { kind: 'failed', receiptNumber: null, isConfirmed: false, canRetry: true };

    case 'expired':
      return { kind: 'expired', receiptNumber: null, isConfirmed: false, canRetry: true };

    case 'refunded':
      return {
        kind: 'refunded',
        receiptNumber: application.receipt_number,
        isConfirmed: false,
        canRetry: false,
      };

    /* received（申込受付済み）と awaiting（決済待ち）はどちらも確認中。 */
    default:
      return {
        kind: 'pending',
        receiptNumber: null,
        isConfirmed: false,
        /*
         * 決済を始めたが完了していない状態。もう一度決済へ進める。
         * 支払が実は成立していた場合は、Webhookが届いた時点で
         * 支払済みに変わる（二重請求にはならない）。
         */
        canRetry: payment?.payment_status !== 'succeeded',
      };
  }
}

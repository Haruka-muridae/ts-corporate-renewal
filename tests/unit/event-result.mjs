/*
 * 決済完了・失敗ページの表示状態の検証（実装仕様書 4.5）。
 *
 * ==================================================================
 * 特に確かめること
 * ==================================================================
 *   - 完了ページに来ただけでは「支払済み」と言い切らないこと
 *   - PayPay想定で、Webhookが届く前は「確認中」になること
 *   - 支払済みなのに受付番号が無い場合、番号を空欄で見せないこと
 * ==================================================================
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

import { resolveResultState, RESULT_KINDS } from '../../lib/event/payment-result.mjs';

try {
  /* ---------------------------------------------------------------- */
  section('支払済み');

  const paid = resolveResultState({
    application: { status: 'paid', receipt_number: 'TSAM-0001' },
    payment: { payment_status: 'succeeded' },
  });

  check('支払済みとして扱う', paid.kind === 'paid', paid.kind);
  check('受付番号を返す', paid.receiptNumber === 'TSAM-0001');
  check('確定として扱う', paid.isConfirmed === true);
  check('再試行は出さない', paid.canRetry === false);

  const paidWithoutNumber = resolveResultState({
    application: { status: 'paid', receipt_number: null },
    payment: { payment_status: 'succeeded' },
  });

  check('受付番号が未発行なら確定扱いにしない',
    paidWithoutNumber.isConfirmed === false, paidWithoutNumber.isConfirmed);
  check('空の受付番号を見せない', paidWithoutNumber.receiptNumber === null);

  /* ---------------------------------------------------------------- */
  section('確認中（Webhookが届く前）');

  /*
   * 完了ページへ遷移しただけの状態。ここで支払済みと表示してしまうと、
   * 実際には決済が成立していない場合に誤った案内になる（仕様書4.5）。
   */
  const awaiting = resolveResultState({
    application: { status: 'awaiting', receipt_number: null },
    payment: { payment_status: 'pending' },
  });

  check('確認中として扱う', awaiting.kind === 'pending', awaiting.kind);
  check('支払済みと言い切らない', awaiting.isConfirmed === false);
  check('受付番号は出さない', awaiting.receiptNumber === null);
  check('もう一度決済へ進める', awaiting.canRetry === true);

  const received = resolveResultState({
    application: { status: 'received', receipt_number: null },
    payment: null,
  });

  check('申込受付済みも確認中として扱う', received.kind === 'pending');

  /*
   * 支払だけ先に成立し、申込のステータス更新が途中で止まった場合。
   * 「もう一度決済へ」を出すと二重に払わせかねないため出さない。
   */
  const halfway = resolveResultState({
    application: { status: 'awaiting', receipt_number: null },
    payment: { payment_status: 'succeeded' },
  });

  check('支払が成立していれば再試行を出さない', halfway.canRetry === false);
  check('それでも確定とは言わない', halfway.isConfirmed === false);

  /* ---------------------------------------------------------------- */
  section('失敗と期限切れ');

  const failed = resolveResultState({
    application: { status: 'failed', receipt_number: null },
    payment: { payment_status: 'failed' },
  });

  check('決済失敗として扱う', failed.kind === 'failed');
  check('やり直せる', failed.canRetry === true);
  check('確定ではない', failed.isConfirmed === false);

  const expired = resolveResultState({
    application: { status: 'expired', receipt_number: null },
    payment: { payment_status: 'expired' },
  });

  check('期限切れとして扱う', expired.kind === 'expired');
  check('やり直せる', expired.canRetry === true);

  /* ---------------------------------------------------------------- */
  section('返金済み');

  const refunded = resolveResultState({
    application: { status: 'refunded', receipt_number: 'TSAM-0001' },
    payment: { payment_status: 'refunded' },
  });

  check('返金済みとして扱う', refunded.kind === 'refunded');
  check('確定ではない', refunded.isConfirmed === false);
  check('再試行は出さない', refunded.canRetry === false);
  check('受付番号は残す（問い合わせの手掛かり）',
    refunded.receiptNumber === 'TSAM-0001');

  /* ---------------------------------------------------------------- */
  section('申込が見つからない');

  [null, undefined].forEach((value) => {
    const unknown = resolveResultState({ application: value, payment: null });
    check(`application が ${String(value)} なら unknown`, unknown.kind === 'unknown');
    check('確定でも再試行でもない',
      unknown.isConfirmed === false && unknown.canRetry === false);
  });

  /* ---------------------------------------------------------------- */
  section('状態の一覧');

  check('返しうる種別がすべて一覧にある',
    ['paid', 'pending', 'failed', 'expired', 'refunded', 'unknown']
      .every((kind) => RESULT_KINDS.includes(kind)));

  finish();
} catch (error) {
  fatal(error);
}

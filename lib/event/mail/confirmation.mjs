/*
 * 参加確定メールの文面を組み立てる（実装仕様書 6.1）。
 *
 * 決済完了のWebhookを受けてから送る。送信そのものは lib/event/mail/gmail.mjs。
 * ここは文面の組み立てだけを行い、副作用を持たない。
 *
 * 載せる項目（仕様書 6.1）
 *   交流会名 / 開催日時 / 開催場所 / 受付番号 / 支払金額 / 適用された割引 /
 *   当日は名札を着用いただく旨 / キャンセルポリシー（返金不可）の再掲 / 問い合わせ先
 */

import { buildBreakdownLines } from '../pricing.mjs';

/** 問い合わせ先。特商法表記・詳細ページと同じ窓口にする。 */
export const CONTACT_EMAIL = 'architect@potenitas.com';

/*
 * 日時は日本時間で表示する。サーバーの時間帯設定に左右されないよう、
 * 明示的に Asia/Tokyo を指定して部品を取り出す。
 */
export function formatEventDateTime(startAt, endAt) {
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(startAt);

  const get = (type) => parts.find((part) => part.type === type)?.value ?? '';

  /* ja-JP の weekday: 'short' は「日」「月」…を返すため、そのまま使える。 */
  const label = `${get('year')}年${get('month')}月${get('day')}日（${get('weekday')}）`
    + `${get('hour')}:${get('minute')}`;

  if (!endAt) {
    return label;
  }

  const endParts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(endAt);

  const endHour = endParts.find((part) => part.type === 'hour')?.value ?? '';
  const endMinute = endParts.find((part) => part.type === 'minute')?.value ?? '';

  return `${label}〜${endHour}:${endMinute}`;
}

/** 3,300 を「3,300円」にする。 */
export function formatYen(amount) {
  return `${new Intl.NumberFormat('ja-JP').format(amount)}円`;
}

/**
 * 参加確定メールの件名と本文を作る。
 *
 * @param {{
 *   event: { name: string, startAt: Date | string | number, endAt?: Date | string | number, venue: string },
 *   application: {
 *     name: string, receiptNumber: string,
 *     industry: string, occupation: string, position: string, ageGroup: string,
 *   },
 *   payment: import('../pricing.mjs').PriceBreakdown,
 * }} input
 * @returns {{ subject: string, text: string }}
 */
export function buildConfirmationMail({ event, application, payment }) {
  if (!application?.receiptNumber) {
    /*
     * 受付番号は支払済みになった時点で発行する。
     * 空のまま送ると参加者が当日照会できないため、ここで止める。
     */
    throw new TypeError('受付番号が発行されていません');
  }

  const dateTime = formatEventDateTime(
    new Date(event.startAt),
    event.endAt ? new Date(event.endAt) : null,
  );

  const lines = [];

  lines.push(`${application.name} 様`);
  lines.push('');
  lines.push(`${event.name}へのお申し込みとお支払いを確認いたしました。`);
  lines.push('当日お会いできることを楽しみにしております。');
  lines.push('');
  lines.push('──────────────────');
  lines.push('ご参加内容');
  lines.push('──────────────────');
  lines.push(`交流会名　： ${event.name}`);
  lines.push(`開催日時　： ${dateTime}`);
  /* 会場は住所を含めて複数行になりうるため、2行目以降を字下げして続ける。 */
  lines.push(`開催場所　： ${String(event.venue).split('\n').join('\n　　　　　　 ')}`);
  lines.push(`受付番号　： ${application.receiptNumber}`);
  lines.push(`お支払金額： ${formatYen(payment.finalPrice)}（税込）`);
  lines.push('');

  /*
   * 適用された割引の内訳。
   * 出禁の申告があった場合、buildBreakdownLines は空を返す。
   * 確認画面と同じく、メールでも理由や内訳を書かない。
   */
  const discountLines = buildBreakdownLines(payment, application);

  if (discountLines.length > 0) {
    lines.push('適用された割引');
    lines.push(`　交流会参加費　　　 ${formatYen(payment.basePrice)}`);
    discountLines.forEach((line) => {
      lines.push(`　${line.label}　 ${formatYen(line.amount)}`);
    });

    if (payment.isMinPriceApplied) {
      lines.push('　※ 割引後の金額が最低販売価格を下回るため、3,300円（税込）となっています。');
    }

    lines.push('');
  }

  lines.push('──────────────────');
  lines.push('当日について');
  lines.push('──────────────────');
  lines.push('当日は、参加者の皆さまに名札を着用いただきます。');
  lines.push('名札には、氏名・会社名・業界・職種・立場を記載します。年齢は記載いたしません。');
  lines.push('');
  lines.push('──────────────────');
  lines.push('キャンセルについて');
  lines.push('──────────────────');
  lines.push('参加者ご都合によるキャンセル・返金は、一切お受けしておりません。');
  lines.push('ご欠席、遅刻、途中退出の場合も返金はいたしません。');
  lines.push('');
  lines.push('参加権を第三者へお譲りいただくことは可能です。期限はなく、開催前であれば');
  lines.push('いつでも承ります。ご希望の場合は下記の問い合わせ先までご連絡ください。');
  lines.push('受付番号は変更されません。');
  lines.push('');
  lines.push('──────────────────');
  lines.push('お問い合わせ');
  lines.push('──────────────────');
  lines.push(`${CONTACT_EMAIL}`);
  lines.push('TSアセットマネジメント合同会社');
  lines.push('');
  lines.push('※ 領収書は、決済時にStripeより別途メールでお送りしています。');

  return {
    subject: `【${event.name}】お申し込みを承りました（受付番号 ${application.receiptNumber}）`,
    text: lines.join('\n'),
  };
}

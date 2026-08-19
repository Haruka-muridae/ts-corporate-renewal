/*
 * 支払済みの人数と名簿をGoogleカレンダーの予定の「説明欄」へ書き戻す。
 *
 * ==================================================================
 * 方針
 * ==================================================================
 *   - 主催者がカレンダーを開くだけで各回の申込人数と参加者が分かるようにする。
 *     管理画面を開かせない（当日の現場で見るのはカレンダーのため）。
 *   - 名簿に載せるのは受付番号と氏名だけ。カレンダーはアプリの外（Google側、
 *     共有や通知で広がりうる場所）なので、当日の受付で照合できる最小限に絞る。
 *     フリガナ・メール・電話・会社名は載せない（db.listPaidAttendees が
 *     そもそも取得しない）。
 *   - 書き換えるのは説明欄（description）だけ。タイトル（summary）は
 *     calendar-sync.mjs が完全一致で突き合わせる同期キーなので、
 *     1文字でも足すとその回の取り込みが止まり、公開中の受付が消える。
 *     人数をタイトルに出したくなっても、ここでは絶対に触らない。
 *   - 説明欄は主催者の手書きメモ（会場への連絡事項など）が入りうる場所。
 *     自動更新するのはマーカーで囲んだブロックだけにして、
 *     それ以外の行は1文字も変えない。
 *   - 書き込み用のトークンは読み取り用（GOOGLE_CALENDAR_REFRESH_TOKEN）と
 *     別に持つ（config.mjs の calendarWriteConfig）。同期の読み取りに
 *     書き込み権限を与えないため。
 *   - 外部ライブラリを足さない。Calendar API v3 を fetch で直接叩く。
 *     アクセストークンの取得は mail/gmail.mjs の getAccessToken を再利用する
 *     （calendar-sync.mjs と同じ流儀）。
 *   - 資格情報・fetch・現在時刻はすべて引数で受け取る。
 *     このモジュールは process.env も実時計も直接読まない（テストのため）。
 *   - 例外にトークンや応答本文を含めない。HTTPの状態コードだけを外に出す。
 * ==================================================================
 */

import { getAccessToken } from './mail/gmail.mjs';

/*
 * 自動更新ブロックの開始・終了マーカー。
 *
 * 「編集しないでください」と書いてあるのは、手で消されるとブロックを
 * 見つけられず、次回の書き戻しで同じブロックがもう1つ増えるため。
 * 逆に言えば、消されても手書きメモは壊れない（見つからなければ追記する）。
 *
 * 文言を変えると、すでにカレンダーへ書き込んだ古いブロックを見つけられなく
 * なる（＝古いブロックが残ったまま新しいブロックが増える）。変更するときは
 * 既存の予定の説明欄を手で直す前提で行うこと。
 */
export const NOTE_BEGIN_MARKER = '―― 申込状況（自動更新・編集しないでください） ――';
export const NOTE_END_MARKER = '――――――――――――――――――――';

const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3/calendars';

/*
 * 名簿に使ってよい文字数の上限。
 *
 * Google カレンダーの説明欄は 8,192 文字まで。超えると更新そのものが
 * 400 で弾かれ、人数すら書き戻せなくなる。定員30名なら名簿は1,000文字にも
 * 届かないが、定員を大きくした回・手書きメモが長い予定でも「人数だけは必ず
 * 書ける」状態を保つため、名簿側に余裕のある上限を置いて超えたら名簿を落とす。
 */
export const ROSTER_MAX_LENGTH = 4000;

/*
 * 説明欄そのものの上限（Google カレンダーの制限）。
 *
 * 手書きメモが長い予定では、名簿が上限内でも合計で超えることがある。
 * 超えたら名簿を落として作り直す（人数だけは書き戻せるようにする）。
 */
const DESCRIPTION_MAX_LENGTH = 8192;

/** 名簿の1行に載せる氏名・受付番号の長さの上限（表示が崩れないように）。 */
const ROSTER_FIELD_MAX_LENGTH = 40;

/*
 * トークン交換＋GET＋PATCH の全体に掛ける制限時間。
 *
 * この処理は Stripe Webhook の中から呼ばれる。Google 側が応答しないときに
 * Webhook の応答まで引きずられると、Stripe から同じ通知が再送される。
 * 書き戻しは失敗しても支払の記録に影響しないので、早めに諦める。
 */
const REQUEST_TIMEOUT_MS = 8000;

/*
 * 定員として意味のある値かどうか。
 *
 * 0・負数・小数は設定ミス。capacity.mjs（isSoldOut / resolveCapacityStatus）が
 * これらを「定員なし」として扱うので、表示もそれに揃える。
 * 「定員0名」と書いて主催者に満席だと誤解させない。
 */
function hasCapacity(capacity) {
  return capacity !== null && capacity !== undefined
    && Number.isInteger(capacity) && capacity > 0;
}

/*
 * 「2026-08-19 10:30」の形にする。
 *
 * カレンダーの表示は主催者のタイムゾーン（JST）なので、書き込む時刻も
 * JST に揃える。UTC のまま書くと9時間ずれた時刻が並び、いつ更新されたのか
 * 分からなくなる。組み立て方（Intl + Asia/Tokyo + formatToParts）は
 * mail/confirmation.mjs の formatEventDateTime と同じ。
 *
 * hourCycle を明示するのは、hour12:false だけだと実装によって深夜0時が
 * 「24:00」になることがあるため（同じ日に 00:00 と 24:00 が混ざる）。
 */
function formatUpdatedAt(now) {
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(now);

  const get = (type) => parts.find((part) => part.type === type)?.value ?? '';

  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/*
 * 名簿に載せる文字を無害化する。
 *
 * 氏名は申込者が入力し、管理画面（譲渡）でも書き換えられる値。そのまま
 * 差し込むと、次の2つでブロックの構造が壊れる。
 *
 *   1. 改行を含む氏名 … 1行1名の並びが崩れ、行数と人数が合わなくなる。
 *      公開フォームは制御文字を弾く（application-input.mjs）が、
 *      管理画面の編集は弾いていない。
 *   2. 罫線（U+2015「―」）を含む氏名 … 開始・終了マーカーはこの文字だけで
 *      できている。氏名の中に終了マーカーと同じ並びを作られると、次回の
 *      書き戻しがそこをブロックの終わりだと解釈し、本物の終端との間に
 *      文字列が取り残されて説明欄が壊れていく。
 *
 * どちらも「氏名として意味のある文字」ではないので、表示前に落とす。
 * カタカナの長音符（ー、U+30FC）は別の符号位置なので影響を受けない。
 */
function sanitizeRosterText(value) {
  if (typeof value !== 'string') {
    return '';
  }

  const cleaned = value
    /* 改行・タブ・その他の制御文字は空白1つに寄せる。 */
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    /* マーカーに使う罫線は名簿から落とす（構造を壊させない）。 */
    .replace(/―/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length <= ROSTER_FIELD_MAX_LENGTH) {
    return cleaned;
  }

  /* 長すぎる値は切り詰める。切ったことが分かるように末尾へ印を付ける。 */
  return `${cleaned.slice(0, ROSTER_FIELD_MAX_LENGTH)}…`;
}

/*
 * 名簿の行を組み立てる。
 *
 * 上限を超えたら名簿を落として理由の1行だけを返す。人数（＝主催者が
 * 準備に使う数字）を書き戻せないほうが困るため、捨てるのは名簿のほうにする。
 * 黙って消すと「誰も来ないのか」と読まれるので、省略した旨は必ず書く。
 *
 * omit は、説明欄の全体（手書きメモを含む）が長すぎたときに
 * 呼び出し側から強制的に省略させるための指定。
 */
function buildRosterLines(attendees, omit = false) {
  if (!Array.isArray(attendees) || attendees.length === 0) {
    return [];
  }

  if (omit) {
    return [`名簿は長くなりすぎるため省略しました（${attendees.length}名分）`];
  }

  const lines = attendees.map((attendee, index) => {
    const receipt = sanitizeRosterText(attendee?.receiptNumber) || '（番号未発行）';
    const name = sanitizeRosterText(attendee?.name) || '（氏名なし）';

    return `${index + 1}. ${receipt} ${name}`;
  });

  const length = lines.join('\n').length;

  if (length > ROSTER_MAX_LENGTH) {
    return buildRosterLines(attendees, true);
  }

  return lines;
}

/**
 * 自動更新ブロックの中身を組み立てる。
 *
 * @param {{
 *   paidCount: number,
 *   capacity: number | null,
 *   attendees?: { receiptNumber: string | null, name: string }[],
 *   now: Date,
 * }} input
 * @returns {string}
 */
function buildNoteBlock({ paidCount, capacity, attendees, now, omitRoster = false }) {
  /*
   * 件数が数えられていないのに「0名」と書くと、主催者は「誰も申し込んでいない」
   * と読む。取り違えようのない誤りなので、黙って0にせず例外にする
   * （呼び出し側が失敗として記録し、説明欄は前回の内容のまま残る）。
   */
  if (!Number.isInteger(paidCount) || paidCount < 0) {
    throw new TypeError('支払済み人数が数値ではありません');
  }

  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('更新時刻が指定されていません');
  }

  const countLine = hasCapacity(capacity)
    ? `支払済み: ${paidCount}名 / 定員${capacity}名`
    : `支払済み: ${paidCount}名`;

  return [
    NOTE_BEGIN_MARKER,
    countLine,
    ...buildRosterLines(attendees, omitRoster),
    `更新: ${formatUpdatedAt(now)}`,
    NOTE_END_MARKER,
  ].join('\n');
}

/**
 * 既存の説明文に自動更新ブロックを差し込んだ文字列を返す（純粋関数）。
 *
 * ブロックが既にあればその区間だけを置き換え、無ければ末尾に追記する。
 * 手書きメモは1文字も変えない（末尾の余分な空行だけは詰める。追記した結果が
 * 実行のたびに伸びていかないようにするため）。
 *
 * ブロックの探索に lastIndexOf を使うのは、終了マーカーだけ手で消された
 * 場合に備えるため。開始マーカーが見つかっても終了マーカーが後ろに無ければ
 * ブロックの範囲を決められないので、置換せずに追記する。このとき最後の
 * 開始マーカー（＝いま追記したブロック）を次回の対象にすれば、
 * 取り残された開始マーカーと新しいブロックの間にある手書きメモを
 * 巻き込んで消すことがない。
 *
 * @param {string | null | undefined} existingDescription
 * @param {{
 *   paidCount: number,
 *   capacity: number | null,
 *   attendees?: { receiptNumber: string | null, name: string }[],
 *   now: Date,
 * }} note
 * @returns {string}
 */
export function buildDescriptionWithNote(
  existingDescription,
  { paidCount, capacity, attendees, now },
) {
  const existing = typeof existingDescription === 'string' ? existingDescription : '';

  /* ブロック以外（手書きメモ）を保ったまま、ブロックだけを差し込む。 */
  const compose = (block) => {
    const beginIndex = existing.lastIndexOf(NOTE_BEGIN_MARKER);

    if (beginIndex !== -1) {
      /*
       * 開始マーカーの本文より後ろから終了マーカーを探す。
       * 開始マーカー自体にも罫線が含まれるため、探索の開始位置をずらす。
       */
      const endIndex = existing.indexOf(
        NOTE_END_MARKER,
        beginIndex + NOTE_BEGIN_MARKER.length,
      );

      if (endIndex !== -1) {
        const before = existing.slice(0, beginIndex);
        const after = existing.slice(endIndex + NOTE_END_MARKER.length);

        return `${before}${block}${after}`;
      }
    }

    /* 説明欄が空（新しく作られた予定）なら、ブロックだけを置く。 */
    const trimmed = existing.replace(/\s+$/, '');

    if (trimmed === '') {
      return block;
    }

    /* 手書きメモとの間は1行空ける。読みやすさのためだけの空行。 */
    return `${trimmed}\n\n${block}`;
  };

  const description = compose(buildNoteBlock({ paidCount, capacity, attendees, now }));

  if (description.length <= DESCRIPTION_MAX_LENGTH) {
    return description;
  }

  /*
   * 手書きメモを含めた全体が説明欄の上限を超えた。
   *
   * この長さで PATCH すると Google 側で弾かれ、人数すら書き戻せない。
   * 手書きメモは主催者のものなので削らず、こちらが足している名簿を落とす。
   * それでも収まらない（メモだけで上限を超えている）場合は、そのまま送って
   * 失敗させる。こちらが消してよい文字はもう無い。
   */
  return compose(buildNoteBlock({ paidCount, capacity, attendees, now, omitRoster: true }));
}

/**
 * カレンダー予定の説明欄へ支払済み人数と名簿を書き戻す。
 *
 * GET で現在の説明欄を取り、ブロックを差し替えて PATCH で説明欄だけを送る。
 * PATCH に description 以外を入れないのは、タイトル・日時・参加者を
 * 巻き込んで書き換えないため（events.patch は送った項目だけを更新する）。
 *
 * 内容が変わらないときは PATCH を送らない。Webhook は1回の支払ごとに
 * 呼ばれるため、同じ内容の書き込みでカレンダーの更新履歴を埋めない。
 *
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   credentials: { clientId: string, clientSecret: string, refreshToken: string },
 *   calendarId: string,
 *   googleCalendarEventId: string,
 *   paidCount: number,
 *   capacity: number | null,
 *   attendees?: { receiptNumber: string | null, name: string }[],
 *   now: Date,
 *   signal?: AbortSignal,
 * }} input
 * @returns {Promise<{ updated: boolean, description: string }>}
 */
export async function writeAttendeeNote({
  fetchImpl = fetch,
  credentials,
  calendarId,
  googleCalendarEventId,
  paidCount,
  capacity,
  attendees,
  now,
  signal,
}) {
  if (!calendarId) {
    throw new TypeError('カレンダーIDが設定されていません');
  }

  if (!googleCalendarEventId) {
    /*
     * 手で登録した回（google_calendar_event_id が null）は書き戻す先が無い。
     * 呼び出し側で分岐するが、直接呼ばれたときのために念のため止める。
     */
    throw new TypeError('カレンダー予定のIDがありません');
  }

  if (!credentials?.clientId || !credentials?.clientSecret || !credentials?.refreshToken) {
    throw new TypeError('カレンダー書き込みの資格情報が設定されていません');
  }

  /* トークン交換・GET・PATCH をまとめて1つの制限時間で括る。 */
  const deadline = signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  const accessToken = await getAccessToken({ ...credentials, fetchImpl, signal: deadline });

  const base = `${CALENDAR_API_BASE}/${encodeURIComponent(calendarId)}`
    + `/events/${encodeURIComponent(googleCalendarEventId)}`;

  const current = await fetchImpl(base, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: deadline,
  });

  if (!current.ok) {
    /* 応答本文には予定の内容が載る。状態コードだけを外に出す。 */
    throw new Error(`カレンダー予定を取得できませんでした（HTTP ${current.status}）`);
  }

  const payload = await current.json();
  const before = typeof payload?.description === 'string' ? payload.description : '';
  const description = buildDescriptionWithNote(before, {
    paidCount, capacity, attendees, now,
  });

  if (description === before) {
    return { updated: false, description };
  }

  /*
   * sendUpdates=none を明示する。会場予約の予定には参加者（会場側）が
   * 入っていることがあり、既定の挙動に任せると人数を書き戻すたびに
   * 「予定が更新されました」の通知が飛びうる。運用の通知を増やさない。
   */
  const response = await fetchImpl(`${base}?sendUpdates=none`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ description }),
    signal: deadline,
  });

  if (!response.ok) {
    throw new Error(`カレンダー予定を更新できませんでした（HTTP ${response.status}）`);
  }

  return { updated: true, description };
}

/**
 * 書き戻しの口を作る。
 *
 * 設定（calendarWriteConfig の戻り値）が無い＝書き込み用トークンが未設定なら
 * null を返す。呼び出し側は「null なら書き戻しを見送る」だけを見ればよく、
 * 環境変数の有無をあちこちで判定しなくて済む。
 *
 * この関数自体は process.env を読まない（設定は引数で受け取る）。
 *
 * @param {{ calendarId: string, credentials: object } | null | undefined} calendarWrite
 * @param {typeof fetch} [fetchImpl]
 * @returns {{ write: (note: object) => Promise<{ updated: boolean, description: string }> } | null}
 */
export function createAttendeeNoteWriter(calendarWrite, fetchImpl) {
  if (!calendarWrite?.calendarId || !calendarWrite?.credentials) {
    return null;
  }

  return {
    write: ({ googleCalendarEventId, paidCount, capacity, attendees, now }) =>
      writeAttendeeNote({
        fetchImpl,
        calendarId: calendarWrite.calendarId,
        credentials: calendarWrite.credentials,
        googleCalendarEventId,
        paidCount,
        capacity,
        attendees,
        now,
      }),
  };
}

/**
 * 対象の回の支払済み人数と名簿を数え直し、カレンダーへ書き戻す。
 *
 * ==================================================================
 * 例外を投げない
 * ==================================================================
 * 呼び出し元は Stripe Webhook（支払確定・返金）と管理画面の申込者編集。
 * どちらも「すでに成立した処理」の後始末としてここへ来るため、書き戻しの
 * 失敗で本体を巻き戻してはならない。トークン未設定・手動登録の回・Google側の
 * 障害・DBの読み取り失敗のいずれも、何が起きたかを1行の日本語で返すだけにする。
 * 呼び出し側はその文字列を自分の記録（webhook_events.result・サーバーログ）に残す。
 *
 * @param {{
 *   config: object,
 *   db: Record<string, Function>,
 *   writer: { write: (note: object) => Promise<unknown> } | null,
 *   eventId?: string | null,
 *   applicationId?: string | null,
 *   now?: Date,
 * }} input
 * @returns {Promise<string>}
 */
export async function updateAttendeeNote({
  config,
  db,
  writer,
  eventId = null,
  applicationId = null,
  now = new Date(),
}) {
  if (writer === null || writer === undefined) {
    return 'カレンダーへの書き戻しは未設定のため見送りました';
  }

  try {
    /*
     * 申込側からしか呼べない経路（返金・管理画面の編集）は、申込を引いて
     * 回を特定する。回のIDが分かっている経路（支払確定）は同じ行を
     * もう一度読みに行かない。
     */
    const targetEventId = eventId ?? (
      applicationId === null
        ? null
        : (await db.findApplicationById(config, applicationId))?.event_id ?? null
    );

    if (targetEventId === null) {
      return 'カレンダーへの書き戻し: 対象の回を特定できませんでした';
    }

    const event = await db.findEventById(config, targetEventId);

    if (event === null) {
      return 'カレンダーへの書き戻し: 開催回が見つかりません';
    }

    if (!event.google_calendar_event_id) {
      /* 手で登録した回。書き戻す先が無いのは異常ではない。 */
      return 'カレンダーへの書き戻しは対象外（カレンダー連動ではない回）';
    }

    /*
     * 件数と名簿を別々に取る。件数は DB 側で数える正確な値（HEAD + count）で、
     * 名簿は表示用の行データ。名簿の取得が万一切り詰められても、
     * 主催者が準備に使う「人数」だけは正しい値が残るようにしておく。
     */
    const paidCount = await db.countPaidApplications(config, targetEventId);
    const rows = await db.listPaidAttendees(config, targetEventId);

    const attendees = (rows ?? []).map((row) => ({
      receiptNumber: row?.receipt_number ?? null,
      name: row?.name ?? '',
    }));

    await writer.write({
      googleCalendarEventId: event.google_calendar_event_id,
      paidCount,
      capacity: event.capacity ?? null,
      attendees,
      now,
    });

    return `カレンダーに支払済み${paidCount}名（名簿${attendees.length}件）を書き戻しました`;
  } catch (error) {
    return `カレンダーへの書き戻しに失敗（${error.message}）`;
  }
}

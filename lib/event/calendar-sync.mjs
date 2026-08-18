/*
 * Googleカレンダーの会場予約から開催日を取り込む（差分同期）。
 *
 * ==================================================================
 * 方針
 * ==================================================================
 *   - カレンダーが真実源。予定を消す・改題すればその回の受付は止まる。
 *     ただし行は消さない（申込・支払の記録が紐づいているため）。
 *   - 外部ライブラリを足さない。Calendar API v3 を fetch で直接叩く。
 *     アクセストークンの取得は mail/gmail.mjs の getAccessToken を再利用する
 *     （リフレッシュトークンからの交換は用途に依らず同じ手順のため）。
 *   - 資格情報・fetch・DB・現在時刻はすべて引数で受け取る。
 *     このモジュールは process.env も実時計も直接読まない（テストのため）。
 *   - 例外にトークンや応答本文を含めない。HTTPの状態コードだけを外に出す。
 *   - 表示する開催時間は「予定の開始+30分 〜 終了−30分」。
 *     前後30分は設営・撤収に使うため、参加者に見せる時間とは別。
 * ==================================================================
 */

import { getAccessToken } from './mail/gmail.mjs';
import { formatEventDateTime } from './mail/confirmation.mjs';

/**
 * 取り込む対象のカレンダー予定名。
 * 部分一致にすると個人の予定を巻き込むため、完全一致だけを見る。
 */
export const CALENDAR_EVENT_TITLE = '【SV顧客用】渋谷CAFEご予約';

/** 予定の前後で設営・撤収に充てる時間（分）。 */
export const SETUP_BUFFER_MINUTES = 30;

/** 同期の最短間隔（分）。読まれるたびにGoogleを叩かないための間引き。 */
export const SYNC_TTL_MINUTES = 10;

/** カレンダーを何ヶ月先まで見るか。 */
export const SYNC_WINDOW_MONTHS = 3;

/** 新しく作る回の既定の定員。 */
export const DEFAULT_CAPACITY = 30;

const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3/calendars';

/*
 * 1回あたりの取得件数とページ数の上限。
 *
 * 3ヶ月・週1回程度の想定なので本来は数件だが、主催者のカレンダーには
 * 対象外の予定（打合せ・個人の予定）も入っている。タイトルの絞り込みは
 * こちら側で行うため、ページに載るのは対象外を含めた全件になる。
 * 1ページ250件（Calendar API v3 の maxResults 上限）× 10ページで 2,500 件。
 *
 * ページ数に上限を置いているのは、応答が想定外（同じ nextPageToken を返し続ける等）
 * だったときに無限ループさせないため。上限に達してもなお続きがある場合は、
 * 「取れた分だけ」で先へ進むと、載らなかった回が「カレンダーに無い」と判定されて
 * 公開中の回が黙って止まる。そうならないよう例外にして同期ごと失敗させる
 * （syncIfStale が失敗として記録し、DBの現状はそのまま残る）。
 */
const PAGE_SIZE = 250;
const MAX_PAGES = 10;

/*
 * 取得全体（トークン交換＋全ページ）に掛ける制限時間。
 *
 * ページごとに掛けると、最悪 ページ数×制限時間 まで伸びる。ここは
 * 画面表示の裏で走る処理なので、全体で何秒までかを1つの signal で決める。
 */
const REQUEST_TIMEOUT_MS = 8000;

/**
 * 予定の時間帯に設営・撤収のバッファを当てて、参加者に見せる開催時間を出す。
 *
 * 開始+30分が終了−30分以上になる（＝60分以下の予約）場合は開催として成立しないため
 * null を返す。呼び出し側は取り込みを見送る。
 *
 * @param {string} startIso
 * @param {string} endIso
 * @param {number} [bufferMinutes]
 * @returns {{ startAt: string, endAt: string } | null}
 */
export function applyBuffer(startIso, endIso, bufferMinutes = SETUP_BUFFER_MINUTES) {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }

  const buffer = bufferMinutes * 60_000;
  const openAt = start + buffer;
  const closeAt = end - buffer;

  /* ちょうど60分の予約は開始と終了が一致する。開催時間が0なので見送る。 */
  if (openAt >= closeAt) {
    return null;
  }

  return {
    startAt: new Date(openAt).toISOString(),
    endAt: new Date(closeAt).toISOString(),
  };
}

/*
 * 表示期間の終わり。
 *
 * 月の加算は日付が繰り上がることがある（11/30 の3ヶ月後は 3/2 になる）が、
 * 「3ヶ月先まで」の目安として使うだけなので、ここでは許容する。
 */
function windowEnd(now, months) {
  const end = new Date(now.getTime());
  end.setUTCMonth(end.getUTCMonth() + months);
  return end;
}

/**
 * 対象期間のカレンダー予定を取る。
 *
 * singleEvents=true で繰り返し予定を各回に展開させる（こちらで展開規則を
 * 解釈しないで済む）。showDeleted=true にするのは、消された予定を
 * 「消された」と分かる形で受け取るため。付けないと単に一覧から居なくなり、
 * 取得漏れとの区別が付かない。
 *
 * 戻り値は「フィードに現れたID」を3つに分けて返す。受付を止めてよいかの
 * 判断に、取り込み対象かどうかだけでなく「証拠が残っているか」を使うため。
 *   occurrences        … 取り込む予定（対象の予定として生きている）
 *   cancelledIds       … 削除された予定（明示的な削除の証拠）
 *   unmatchedActiveIds … 生きてはいるが対象外の予定（改題・条件外化の証拠）
 * どれにも現れないIDは「痕跡ごと消えた」ことになり、取得異常と区別が付かない。
 *
 * @param {{
 *   calendarId: string,
 *   credentials: { clientId: string, clientSecret: string, refreshToken: string },
 *   fetchImpl?: typeof fetch,
 *   now: Date,
 *   signal?: AbortSignal,
 * }} input
 * @returns {Promise<{
 *   occurrences: { id: string, summary: string, startIso: string, endIso: string }[],
 *   cancelledIds: string[],
 *   unmatchedActiveIds: string[],
 * }>}
 */
export async function fetchCalendarOccurrences({
  calendarId,
  credentials,
  fetchImpl = fetch,
  now,
  signal,
}) {
  if (!calendarId) {
    throw new TypeError('カレンダーIDが設定されていません');
  }

  if (!credentials?.clientId || !credentials?.clientSecret || !credentials?.refreshToken) {
    throw new TypeError('カレンダー取得の資格情報が設定されていません');
  }

  /*
   * トークン交換と全ページの取得を1つの signal で括る。
   * 差し替え（テスト）が渡ってこない限り、ここで作った制限時間を使う。
   */
  const deadline = signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  const accessToken = await getAccessToken({ ...credentials, fetchImpl, signal: deadline });

  const timeMin = new Date(now.getTime()).toISOString();
  const timeMax = windowEnd(now, SYNC_WINDOW_MONTHS).toISOString();

  const occurrences = [];
  const cancelledIds = [];

  /*
   * 生きている（cancelled でない）予定のIDを、対象・対象外に関わらず控える。
   * 取り込まなかったIDは後で差分として取り出し、「改題などで対象から外れた」
   * 証拠として使う（一覧に居る＝取得は成功している、と分かるため）。
   */
  const activeIds = new Set();
  const matchedIds = new Set();

  let pageToken = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: 'true',
      showDeleted: 'true',
      orderBy: 'startTime',
      maxResults: String(PAGE_SIZE),
    });

    if (pageToken) {
      params.set('pageToken', pageToken);
    }

    const url = `${CALENDAR_API_BASE}/${encodeURIComponent(calendarId)}/events?${params.toString()}`;

    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: deadline,
    });

    if (!response.ok) {
      /*
       * 応答本文にはカレンダーの内容や資格情報の手掛かりが載りうるため、
       * 状態コードだけを外に出す（getAccessToken と同じ扱い）。
       */
      throw new Error(`カレンダーの予定を取得できませんでした（HTTP ${response.status}）`);
    }

    const payload = await response.json();

    for (const item of payload?.items ?? []) {
      if (!item?.id) {
        continue;
      }

      /*
       * 消された予定を先に振り分ける。
       *
       * 削除済みの項目は id と status しか返らないことがあり、summary で
       * 絞ると取りこぼす。IDで突き合わせるので、対象外の予定のIDが混ざっても
       * DBの行に当たらず、実害は無い。
       */
      if (item.status === 'cancelled') {
        cancelledIds.push(item.id);
        continue;
      }

      /* ここから下は「一覧に生きている予定」。取り込むかどうかとは別に控える。 */
      activeIds.add(item.id);

      /* タイトルの完全一致だけを取り込む（前後に空白があるものも対象外）。 */
      if (item.summary !== CALENDAR_EVENT_TITLE) {
        continue;
      }

      /*
       * 主催者自身が作った予定だけを取り込む。
       *
       * タイトルだけを条件にすると、第三者が同じ題名の予定を作って
       * このカレンダーへ招待するだけで、公開中の開催回を1つ増やせてしまう
       * （招待は承諾しなくても予定として一覧に載る）。
       *
       * organizer.self は「この予定の主催者がこのカレンダーの持ち主か」。
       * Google は真のときだけ self を付けるため、値が無い＝他人の予定。
       * organizer 自体を返さない応答に備えて creator.self を代わりに見る。
       */
      const ownedByHost = typeof item.organizer?.self === 'boolean'
        ? item.organizer.self === true
        : item.creator?.self === true;

      if (!ownedByHost) {
        continue;
      }

      /*
       * 誕生日・不在・集中時間などの自動生成される予定を除く。
       * eventType が無い応答（古いAPI応答・テストの簡略な入力）は
       * 従来どおり通常の予定として扱う。
       */
      if (typeof item.eventType === 'string' && item.eventType !== 'default') {
        continue;
      }

      /*
       * 終日予定は時刻を持たない（start.date のみ）。開催時間を決められず、
       * バッファも当てられないため取り込まない。
       */
      if (!item.start?.dateTime || !item.end?.dateTime) {
        continue;
      }

      matchedIds.add(item.id);

      occurrences.push({
        id: item.id,
        summary: item.summary,
        startIso: item.start.dateTime,
        endIso: item.end.dateTime,
      });
    }

    pageToken = payload?.nextPageToken ?? null;

    if (!pageToken) {
      break;
    }
  }

  /*
   * 上限まで読んでもまだ続きがある＝一覧が途中で切れている。
   *
   * 切れた分は「カレンダーに無い」と見分けが付かず、そのまま突き合わせると
   * 公開中の回が黙って止まる。取り込みを中止して失敗として記録する
   * （DBの現状は変わらないので、表示は直前の内容のまま続く）。
   */
  if (pageToken) {
    throw new Error(
      `カレンダーの予定が上限（${PAGE_SIZE * MAX_PAGES}件）を超えました`,
    );
  }

  /*
   * 生きているが取り込まなかった予定。
   *
   * 改題・主催者の条件外・eventType の除外・終日への変更などで対象から
   * 外れた予定がここに入る。「一覧には居る」ので取得は成功しており、
   * 該当の回の受付を止めてよい証拠になる。
   *
   * 60分以下の予定はここには入らない（取り込み対象として occurrences に
   * 載り、開催時間の判定は syncCalendarEvents 側で行うため）。入力ミスの
   * 可能性が高い予定で公開中の回を止めない、という既存の判断を保つ。
   */
  const unmatchedActiveIds = [...activeIds].filter((id) => !matchedIds.has(id));

  return { occurrences, cancelledIds, unmatchedActiveIds };
}

/** ISO文字列を同じ時刻かどうかで比べる（表記のゆれを無視する）。 */
function sameInstant(a, b) {
  if (!a || !b) {
    return !a && !b;
  }

  return Date.parse(a) === Date.parse(b);
}

/** 警告や記録に使う日本語の日時表記。 */
function labelOf(startAt, endAt) {
  return formatEventDateTime(new Date(startAt), endAt ? new Date(endAt) : null);
}

/**
 * カレンダーの内容をイベント行へ反映する。
 *
 * @param {{
 *   config: object,
 *   calendar: { calendarId: string, credentials: object },
 *   db: Record<string, Function>,
 *   fetchImpl?: typeof fetch,
 *   now: Date,
 * }} input
 * @returns {Promise<{
 *   created: number, updated: number, unpublished: number, skipped: number,
 *   unpublishSkipped: number,
 *   warnings: { eventId: string, message: string }[],
 * }>}
 */
export async function syncCalendarEvents({ config, calendar, db, fetchImpl, now }) {
  const nowIso = new Date(now.getTime()).toISOString();

  const { occurrences, cancelledIds, unmatchedActiveIds } = await fetchCalendarOccurrences({
    calendarId: calendar.calendarId,
    credentials: calendar.credentials,
    fetchImpl,
    now,
  });

  /*
   * 既存行の一覧は1回だけ取る。
   *   * 新しい回を作るときのひな型（名称・会場・価格・ポリシー）
   *   * カレンダーから消えた回を見つけるための突き合わせ
   * の両方に使う。取り込みの前に取るため、この一覧に今回作った行は入らない
   * （入っていても「消えた回」とは判定されない。処理したIDを除外するため）。
   */
  const existingRows = await db.listEventsForAdmin(config);
  const template = existingRows[0] ?? null;

  const cancelled = new Set(cancelledIds);
  /* 生きているが対象から外れた予定のID（改題など）。 */
  const unmatchedActive = new Set(unmatchedActiveIds ?? []);
  /* カレンダー側に生きている（＝受付を止めてはいけない）予定のID。 */
  const seenIds = new Set();

  let created = 0;
  let updated = 0;
  let unpublished = 0;
  let skipped = 0;
  let unpublishSkipped = 0;
  const warnings = [];

  for (const occurrence of occurrences) {
    const window = applyBuffer(occurrence.startIso, occurrence.endIso);

    if (window === null) {
      /*
       * 60分以下の予約。開催として成立しないので取り込まない。
       * すでに紐づく行がある場合も、勝手に受付を止めない（予約時間の
       * 入力ミスの可能性が高く、公開中の回を消すほうが影響が大きい）ため
       * 「見たID」に入れておく。
       */
      seenIds.add(occurrence.id);
      skipped += 1;
      continue;
    }

    seenIds.add(occurrence.id);

    /* ①IDで一致する行 → ②同じ日時の未リンク行（手で登録した行の引き取り）。 */
    let row = await db.findEventByCalendarEventId(config, occurrence.id);
    let adopted = false;

    if (row === null) {
      /* 開始だけでなく終了も一致する行に限る（同じ開始で長さが違う回を誤って引き取らない）。 */
      row = await db.findUnlinkedEventByDate(config, window.startAt, window.endAt);
      adopted = row !== null;
    }

    if (row === null) {
      /* ③どちらも無ければ新規。 */
      const result = await createEventFromCalendar({
        config, db, template, window, occurrence, nowIso, now,
      });

      if (result === 'created') {
        created += 1;
      } else if (result === 'skipped') {
        skipped += 1;
      } else if (result === 'no-template') {
        skipped += 1;
        warnings.push({
          eventId: '',
          message: `ひな型になるイベント行が無いため、${labelOf(window.startAt, window.endAt)}`
            + 'の回を作成できませんでした',
        });
      } else {
        /* 一意制約に当たった＝別の同期が先に作った。取り直して更新に回す。 */
        const existing = await db.findEventByCalendarEventId(config, occurrence.id);

        if (existing !== null) {
          const changed = await updateEventFromCalendar({
            config, db, row: existing, window, occurrence, nowIso, adopted: false,
          });

          if (changed.warning !== null) {
            warnings.push(changed.warning);
          }

          if (changed.contentChanged) {
            updated += 1;
          }
        }
      }

      continue;
    }

    const changed = await updateEventFromCalendar({
      config, db, row, window, occurrence, nowIso, adopted,
    });

    if (changed.warning !== null) {
      warnings.push(changed.warning);
    }

    if (changed.contentChanged) {
      updated += 1;
    }
  }

  /*
   * カレンダー側に見当たらなくなった回を止める。
   *
   * 対象は「カレンダーと紐づいていて」「公開中で」「これから開催」の行だけ。
   * 手で登録した行（未リンク）は同期の対象外なので触らない。過去回は
   * 止めても意味が無く、履歴を書き換えるだけなので触らない。
   */
  const stoppable = existingRows.filter((row) => (
    row.google_calendar_event_id
    && row.is_published === true
    && !seenIds.has(row.google_calendar_event_id)
    && Date.parse(row.event_date) >= now.getTime()
  ));

  /*
   * 止める根拠を、カレンダーに残った「痕跡」で分ける。
   *
   *   証拠あり … その予定のIDが cancelled（削除された）か、
   *              unmatchedActive（生きているが対象外＝改題など）で返ってきた。
   *              どちらも一覧が届いている証拠なので、取り込み対象が0件でも止める。
   *              「予定を消す・改題すれば受付が止まる」は運用の中核なので、
   *              次回開催が1件だけの通常状態でも必ず効かせる必要がある。
   *   痕跡なし … IDがフィードのどこにも現れなかった。予定を消したのか、
   *              一覧そのものが届いていないのか（障害・権限変更・カレンダーの
   *              取り違え）を区別できない。
   *
   * 取り込み対象が1件も無いときに限り、「痕跡なし」の回は止めずに残す。
   * 支払済みの参加者ごと受付が消えるより、止め損ねて管理画面で気づくほうが
   * 復旧しやすいため。この場合は last_status に理由を残す。
   */
  const evidenced = stoppable.filter((row) => (
    cancelled.has(row.google_calendar_event_id)
    || unmatchedActive.has(row.google_calendar_event_id)
  ));

  const vanished = stoppable.filter((row) => !(
    cancelled.has(row.google_calendar_event_id)
    || unmatchedActive.has(row.google_calendar_event_id)
  ));

  const holdBack = occurrences.length === 0 && vanished.length > 0;

  if (holdBack) {
    unpublishSkipped = vanished.length;
  }

  for (const row of holdBack ? evidenced : stoppable) {
    const paidCount = await db.countPaidApplications(config, row.id);
    const reason = cancelled.has(row.google_calendar_event_id)
      ? 'カレンダーの予定が削除されました'
      : 'カレンダーに対象の予定が見つかりません（削除・改題・時間帯の変更）';

    const patch = {
      is_published: false,
      synced_at: nowIso,
    };

    let warning = null;

    if (paidCount > 0) {
      const message = `${reason}。支払済みが${paidCount}件あるため、`
        + `参加者への連絡が必要です（${labelOf(row.event_date, row.event_end_at)}）`;

      patch.sync_warning = message;
      patch.sync_warning_at = nowIso;
      warning = { eventId: row.id, message };
    }

    await db.updateEvent(config, row.id, patch);

    unpublished += 1;

    if (warning !== null) {
      warnings.push(warning);
    }
  }

  return { created, updated, unpublished, skipped, unpublishSkipped, warnings };
}

/*
 * 新しい回を作る。
 *
 * 名称・説明・会場・価格・キャンセルポリシー・ポリシー版は直近の回から複製する。
 * これらは回ごとに変える運用をしていないので、カレンダーから決められる
 * 日時と定員だけを新しくする。ひな型が無い（1行も無い）場合は作らない。
 * 空の名称や価格0円の回を作るより、作らずに気づけるほうがよい。
 *
 * @returns {Promise<'created' | 'duplicate' | 'skipped' | 'no-template'>}
 */
async function createEventFromCalendar({
  config, db, template, window, occurrence, nowIso, now,
}) {
  if (template === null) {
    return 'no-template';
  }

  /*
   * 受付終了（apply_end_at）は開催開始に合わせる。開始がすでに過ぎている
   * 予定（進行中の回）は受付期間を作れない（events_apply_period に反する）ため、
   * 新規には取り込まない。
   */
  if (Date.parse(window.startAt) <= now.getTime()) {
    return 'skipped';
  }

  const { duplicate } = await db.insertEvent(config, {
    name: template.name,
    description: template.description,
    venue: template.venue,
    base_price: template.base_price,
    min_price: template.min_price,
    cancel_policy_text: template.cancel_policy_text,
    policy_version: template.policy_version,
    capacity: DEFAULT_CAPACITY,
    event_date: window.startAt,
    event_end_at: window.endAt,
    apply_start_at: nowIso,
    apply_end_at: window.startAt,
    is_published: true,
    google_calendar_event_id: occurrence.id,
    synced_at: nowIso,
  });

  return duplicate ? 'duplicate' : 'created';
}

/*
 * 既存の回にカレンダーの内容を反映する。
 *
 * synced_at は毎回書く（この行をいつ突き合わせたかが分かるように）。
 * 一方で「更新した」と数えるのは中身が変わったときだけにする。
 * 毎回の同期が更新件数として積み上がると、本当の変更に気づけなくなるため。
 *
 * @returns {Promise<{ contentChanged: boolean, warning: object | null }>}
 */
async function updateEventFromCalendar({
  config, db, row, window, occurrence, nowIso, adopted,
}) {
  const startChanged = !sameInstant(row.event_date, window.startAt);
  const endChanged = !sameInstant(row.event_end_at, window.endAt);
  const republished = row.is_published !== true;

  const patch = { synced_at: nowIso };

  if (adopted || row.google_calendar_event_id !== occurrence.id) {
    patch.google_calendar_event_id = occurrence.id;
  }

  if (startChanged) {
    patch.event_date = window.startAt;
    patch.apply_end_at = window.startAt;

    /*
     * 受付終了が受付開始より前になると events_apply_period に反する。
     * 開催が受付開始より前に動いた場合だけ、受付開始も併せて前へずらす。
     */
    if (Date.parse(window.startAt) <= Date.parse(row.apply_start_at)) {
      patch.apply_start_at = new Date(Date.parse(window.startAt) - 60_000).toISOString();
    }
  }

  if (endChanged) {
    patch.event_end_at = window.endAt;
  }

  if (republished) {
    /*
     * 一度止めた回がカレンダーに戻ってきた場合（改題を戻した・消して作り直した）。
     * 止めた理由として残した警告は解消済みなので消す。
     */
    patch.is_published = true;
    patch.sync_warning = null;
    patch.sync_warning_at = null;
  }

  let warning = null;

  if (startChanged || endChanged) {
    const paidCount = await db.countPaidApplications(config, row.id);

    if (paidCount > 0) {
      const message = '開催日時がカレンダー側で変更されました（旧: '
        + `${labelOf(row.event_date, row.event_end_at)} → 新: `
        + `${labelOf(window.startAt, window.endAt)}）。`
        + `支払済みが${paidCount}件あるため、参加者への連絡が必要です`;

      patch.sync_warning = message;
      patch.sync_warning_at = nowIso;
      warning = { eventId: row.id, message };
    }
  }

  await db.updateEvent(config, row.id, patch);

  return {
    contentChanged: startChanged || endChanged || republished || adopted,
    warning,
  };
}

/**
 * 前回の同期から十分な時間がたっていれば同期する。
 *
 * 画面の表示や申込ページから「ついでに」呼ぶため、例外を外へ出さない。
 * Google側の障害やトークンの失効で画面まで落とすと、DBに入っている
 * 現在の開催日すら見えなくなる。失敗は戻り値と last_status に残す。
 *
 * @param {{
 *   config: object,
 *   calendar: { calendarId: string, credentials: object },
 *   db: Record<string, Function>,
 *   fetchImpl?: typeof fetch,
 *   now: Date,
 * }} input
 * @returns {Promise<{
 *   synced: boolean, skipped: boolean,
 *   result: object | null, error: string | null,
 * }>}
 */
export async function syncIfStale({ config, calendar, db, fetchImpl, now }) {
  let claimed = false;

  try {
    claimed = await db.claimCalendarSync(config, {
      nowIso: new Date(now.getTime()).toISOString(),
      ttlMinutes: SYNC_TTL_MINUTES,
    });
  } catch (error) {
    /* 実行権の取得に失敗した時点で、DB自体が不調。同期は諦める。 */
    return { synced: false, skipped: true, result: null, error: messageOf(error) };
  }

  if (!claimed) {
    /* TTL内か、ほかのリクエストが同期中。Googleは叩かない。 */
    return { synced: false, skipped: true, result: null, error: null };
  }

  try {
    const result = await syncCalendarEvents({ config, calendar, db, fetchImpl, now });

    /*
     * 安全弁が働いた回（受付を止めなかった回）は件数だけでは分からない。
     * 管理画面が見る last_status に理由を残す。
     */
    const heldBack = result.unpublishSkipped > 0
      ? `。予定の痕跡が無く対象も0件のため${result.unpublishSkipped}件の受付停止を見送りました`
        + '（取得異常の可能性。要確認）'
      : '';

    await recordStatus(config, db, `成功: 追加${result.created} 更新${result.updated} `
      + `終了${result.unpublished} 見送り${result.skipped} 警告${result.warnings.length}`
      + heldBack);

    return { synced: true, skipped: false, result, error: null };
  } catch (error) {
    const message = messageOf(error);

    await recordStatus(config, db, `失敗: ${message}`);

    return { synced: false, skipped: false, result: null, error: message };
  }
}

/* 例外の文言だけを取り出す（トークンや応答本文は元から含めていない）。 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/* 結果の記録に失敗しても、同期そのものの成否は変えない。 */
async function recordStatus(config, db, statusText) {
  try {
    await db.updateCalendarSyncStatus(config, { statusText });
  } catch {
    /* 記録できないこと自体は同期の結果に影響しない。握りつぶす。 */
  }
}

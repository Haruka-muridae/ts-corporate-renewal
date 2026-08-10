/**
 * 通知するかどうかの判定（純関数のみ）。
 *
 * ==================================================================
 * V1 の gas-notifier/CalendarSync.gs から移してきたもの
 * ==================================================================
 * 判定の順序は要件書 §6 のとおりに固定する。
 *
 *   1. 削除済み（cancelled）        → キューから消す（FR-14）
 *   2. 終日予定                      → 「時間指定のみ」ON なら除外（FR-03/07）
 *   3. 自分の出欠                    → 取得（FR-04）
 *   4. その出欠が設定で ON か        → OFF なら除外（FR-05/09）
 *
 * 順序を入れ替えると、削除済みの終日予定が「終日だから除外」で止まり、
 * キューに残ったままになる。
 *
 * V1 との違いは入力だけ。V1 は Calendar API の生イベントを見ていたが、
 * V2 で Workers に届くのは**匿名化された骨格**である（§4.2）。
 *   - eventId は GAS が HMAC-SHA256 でハッシュ化した eid
 *   - 出欠（attendees の self）は GAS 側で解決済みの status 文字列
 *   - 終日かどうかは allDay の真偽値、開始時刻は ISO 文字列
 * 予定名・説明・参加者はここへ来ない。来ても受け取らない（validateEvents）。
 * ==================================================================
 *
 * ここは fetch も KV も触らない。Node のテストからそのまま呼べる。
 */

import {
  ALLOWED_DIGEST_FIELDS,
  ALLOWED_EVENT_FIELDS,
  ALLOWED_TIMINGS,
  DEFAULT_FEATURE,
  DEFAULT_SETTINGS,
  FEATURE_RULES,
  QUEUE_RETENTION_MS,
  RENOTIFY_THRESHOLD_MS,
  RESPONSE_STATUSES,
} from './constants.mjs';

/**
 * 真偽値へ寄せる。
 *
 * 文字列 'false' を Boolean() に渡すと true になる。同じ誤りが本番認証系で
 * 30日セッションの誤発行を起こしている（gas-auth/Main.gs のコメント）。
 * ここでも文字列を明示的に見る。
 */
export function toBool(value, fallback) {
  if (value === true || value === false) {
    return value;
  }

  const text = String(value === undefined || value === null ? '' : value).trim().toLowerCase();

  if (text === 'true' || text === '1' || text === 'on' || text === 'yes') {
    return true;
  }

  if (text === 'false' || text === '0' || text === 'off' || text === 'no') {
    return false;
  }

  return fallback;
}

/** 通知タイミング（分前）。選択肢に無い値は既定へ戻す。 */
export function toTiming(value, fallback = DEFAULT_SETTINGS.timingMin) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  const rounded = Math.round(number);

  return ALLOWED_TIMINGS.indexOf(rounded) === -1 ? fallback : rounded;
}

/**
 * 設定を正規化する。
 *
 * 利用者はテンプレートのスプレッドシートを手で編集できる。GAS 側でも
 * 丸めているが、**Workers はそれを信じない**。timing に文字列が入っただけで
 * 全員の通知が止まる、という壊れ方をさせないため、受け口でもう一度丸める。
 */
export function normalizeSettings(input) {
  const source = input && typeof input === 'object' ? input : {};
  const out = {};

  for (const key of RESPONSE_STATUSES) {
    out[key] = toBool(source[key], DEFAULT_SETTINGS[key]);
  }

  out.timedOnly = toBool(source.timedOnly, DEFAULT_SETTINGS.timedOnly);
  out.timingMin = toTiming(source.timingMin);

  return out;
}

/** イベントの機能名。未指定はカレンダー通知として扱う（§10-4 の既定値）。 */
export function eventFeature(event) {
  const name = String((event && event.feature) || '').trim();
  return name === '' ? DEFAULT_FEATURE : name;
}

/**
 * 1件の骨格を通知対象にするか決める。
 *
 * 戻り値は { include, reason, feature }。
 * reason は include === false のときだけ意味を持ち、ログとテストで使う。
 */
export function decideEvent(event, settings) {
  if (!event || typeof event !== 'object') {
    return { include: false, reason: 'invalid', feature: DEFAULT_FEATURE };
  }

  const feature = eventFeature(event);

  /* 1. 削除済み。ここを最初に見る（下の除外に先回りされないため）。 */
  if (event.cancelled === true) {
    return { include: false, reason: 'cancelled', feature };
  }

  const rules = FEATURE_RULES[feature];

  /*
   * 未登録の機能。判定を運営側へ置くのが V2 の目的なので、
   * テンプレート側が新しい feature を名乗っても通さない。
   */
  if (!rules) {
    return { include: false, reason: 'unknown-feature', feature };
  }

  /* 2. 終日予定。「時間指定の予定のみ」が ON なら通知しない（AC-04）。 */
  if (rules.allDayFilter && event.allDay === true && settings.timedOnly) {
    return { include: false, reason: 'all-day', feature };
  }

  if (rules.attendanceFilter) {
    const status = String(event.status || '').trim();

    /*
     * 3. 自分の出欠。
     *
     * 空文字は「自分が出席者として載っていない予定」を GAS が明示したもの。
     * 他人のカレンダーから流れてきた予定がここに来る（要件書 §6 補足）。
     */
    if (RESPONSE_STATUSES.indexOf(status) === -1) {
      return { include: false, reason: 'not-attendee', feature };
    }

    /* 4. その出欠が設定で ON か（AC-01/02/03）。 */
    if (settings[status] !== true) {
      return { include: false, reason: 'status-off', feature };
    }
  }

  return { include: true, reason: 'ok', feature };
}

/** 通知予定時刻。timingMin は「何分前か」。0 なら開始時刻ちょうど。 */
export function computeNotifyAt(startMs, timingMin) {
  return startMs - timingMin * 60 * 1000;
}

/** ISO 文字列をエポックミリ秒へ。読めなければ NaN。 */
export function toMs(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : NaN;
  }

  if (typeof value !== 'string' || value.trim() === '') {
    return NaN;
  }

  const parsed = Date.parse(value);

  return Number.isFinite(parsed) ? parsed : NaN;
}

/**
 * このイベントに使う通知タイミング（分前）。
 *
 * カレンダー以外の機能が「この1件だけ30分前に」と指定できるよう、
 * イベント単位の timingMin を受ける。指定が無ければ設定値を使う。
 */
export function resolveTimingMin(event, settings) {
  if (event && event.timingMin !== undefined && event.timingMin !== null) {
    const number = Number(event.timingMin);

    if (Number.isFinite(number) && number >= 0 && number <= 7 * 24 * 60) {
      return Math.round(number);
    }
  }

  return settings.timingMin;
}

/**
 * 送信済み一覧を引きやすい形へ畳む。
 *
 * キーは `feature|eid|timing` まで。開始時刻は**値の側**へ入れる。
 * 開始時刻までキーに含めると「1分ずれただけで別物」になり、
 * RENOTIFY_THRESHOLD_MS による引き継ぎ判定ができなくなる（B-05）。
 */
export function buildSentIndex(sentDigest) {
  const index = new Map();

  if (!Array.isArray(sentDigest)) {
    return index;
  }

  for (const entry of sentDigest) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const eid = String(entry.eid || '');

    if (eid === '') {
      continue;
    }

    const feature = eventFeature(entry);
    const timing = Number(entry.timing);
    const startAt = toMs(entry.startAt);
    const key = `${feature}|${eid}|${Number.isFinite(timing) ? Math.round(timing) : ''}`;
    const list = index.get(key) || [];

    list.push(startAt);
    index.set(key, list);
  }

  return index;
}

/**
 * すでに送信済みとして扱うか（B-05 の中身）。
 *
 * 同じ feature / eid / timing で送った記録のうち、**開始時刻の差が
 * RENOTIFY_THRESHOLD_MS 未満**のものが1件でもあれば送信済みとする。
 * 差がそれ以上なら別の通知＝再通知する。
 *
 * 記録側の開始時刻が読めない（古い形式・手編集で壊れた）場合は、
 * 開始時刻を問わず送信済みとみなす。**送りすぎるより送らないほうへ倒す。**
 */
export function isAlreadyNotified(sentIndex, feature, eid, timing, startMs) {
  const list = sentIndex.get(`${feature}|${eid}|${timing}`);

  if (!list) {
    return false;
  }

  for (const sentStart of list) {
    if (!Number.isFinite(sentStart)) {
      return true;
    }

    if (Math.abs(startMs - sentStart) < RENOTIFY_THRESHOLD_MS) {
      return true;
    }
  }

  return false;
}

/**
 * 受け取ったイベント配列の形を検査する。
 *
 * ------------------------------------------------------------------
 * 「送らない」ではなく「受け取らない」で守る
 * ------------------------------------------------------------------
 * 予定名・説明・参加者・メールアドレスを運営が一切預からないことが
 * V2 の売り（要件 DR-03/04）である。テンプレート側の実装ミスや、
 * 改造されたコピーからそれらが送られてきたときに、**運営のサーバーが
 * 受理してしまう状態を作らない**。許可した列挙以外のキーがあれば
 * 要求ごと拒否する。
 * ------------------------------------------------------------------
 *
 * 戻り値は { ok, message }。message は利用者に見せる定型文で、
 * 混入した値そのものは含めない（ログにも残さないため）。
 */
export function validateEvents(events) {
  if (!Array.isArray(events)) {
    return { ok: false, message: 'events は配列である必要があります。' };
  }

  for (const event of events) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      return { ok: false, message: 'events の要素はオブジェクトである必要があります。' };
    }

    for (const key of Object.keys(event)) {
      if (ALLOWED_EVENT_FIELDS.indexOf(key) === -1) {
        return { ok: false, message: `events に許可されていない項目が含まれています: ${key}` };
      }
    }

    if (String(event.eid || '').trim() === '') {
      return { ok: false, message: 'events の eid が空です。' };
    }
  }

  return { ok: true, message: '' };
}

/** sentDigest の形を検査する。理由は validateEvents と同じ。 */
export function validateSentDigest(sentDigest) {
  if (sentDigest === undefined || sentDigest === null) {
    return { ok: true, message: '' };
  }

  if (!Array.isArray(sentDigest)) {
    return { ok: false, message: 'sentDigest は配列である必要があります。' };
  }

  for (const entry of sentDigest) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, message: 'sentDigest の要素はオブジェクトである必要があります。' };
    }

    for (const key of Object.keys(entry)) {
      if (ALLOWED_DIGEST_FIELDS.indexOf(key) === -1) {
        return { ok: false, message: `sentDigest に許可されていない項目が含まれています: ${key}` };
      }
    }
  }

  return { ok: true, message: '' };
}

/**
 * 骨格の配列から「キューに載せるもの」と「キューから消すもの」を決める。
 *
 * 除外された予定は、理由を問わず remove に入れる（V1 の
 * applyCalendarItems_ が、対象外になった行をキューから消していたのと同じ）。
 * 辞退へ変えた場合・設定を OFF にした場合・削除された場合のいずれでも、
 * 残っているキュー行が消える。
 *
 * **送信済みのものも remove に入れる。** V2 のキューは「これから出す通知」
 * だけを持つ。送信済みかどうかの記録は sentDigest（利用者のシート）にあり、
 * キューに残しておく理由がない。
 */
export function evaluateEvents({ settings, events, sentDigest, nowMs }) {
  const normalized = normalizeSettings(settings);
  const sentIndex = buildSentIndex(sentDigest);
  const notify = [];
  const remove = [];
  const skipped = [];

  for (const event of Array.isArray(events) ? events : []) {
    const eid = String((event && event.eid) || '').trim();

    if (eid === '') {
      continue;
    }

    const decision = decideEvent(event, normalized);

    if (!decision.include) {
      remove.push({ eid, feature: decision.feature, reason: decision.reason });
      continue;
    }

    const startMs = toMs(event.startAt);

    if (!Number.isFinite(startMs)) {
      remove.push({ eid, feature: decision.feature, reason: 'no-start' });
      continue;
    }

    /* 古すぎる骨格（DR-03）。24時間先読みの範囲では本来出てこない。 */
    if (startMs < nowMs - QUEUE_RETENTION_MS) {
      remove.push({ eid, feature: decision.feature, reason: 'stale' });
      continue;
    }

    const timing = resolveTimingMin(event, normalized);

    if (isAlreadyNotified(sentIndex, decision.feature, eid, timing, startMs)) {
      remove.push({ eid, feature: decision.feature, reason: 'already-sent' });
      skipped.push({ eid, feature: decision.feature });
      continue;
    }

    notify.push({
      eid,
      feature: decision.feature,
      timing,
      startAt: new Date(startMs).toISOString(),
      notifyAt: new Date(computeNotifyAt(startMs, timing)).toISOString(),
    });
  }

  return { notify, remove, skipped, settings: normalized };
}

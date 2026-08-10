/**
 * カレンダーの同期。
 *
 * V2 では**判定を行わない。** ここがするのは3つだけ。
 *
 *   1. Advanced Calendar Service で予定を取る
 *   2. 予定を「骨格」へ落とす（匿名化。予定名はシートに残し、外へ出さない）
 *   3. ゲートの判定結果（notify / remove）を notify_queue へ反映する
 *
 * 判定の中身（出欠フィルタ・終日の扱い・再通知の閾値）は
 * workers/notifier-gate/src/evaluate.mjs にある。
 * この分離の理由は docs/notifier-design-notes.md §1。
 */

/* 同期の間隔。tick() は毎分動くが、Calendar API を叩くのは5分に1回でよい。 */
var SYNC_INTERVAL_MS = 5 * 60 * 1000;

/* 先読みする範囲。24時間より先の予定は次の同期で拾う。 */
var SYNC_WINDOW_MS = 24 * 60 * 60 * 1000;

/* キューと sent_log の保持期間。 */
var QUEUE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
var SENT_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/* ゲートへ渡す送信済み一覧の範囲。再通知の判定に使う（design-notes §4）。 */
var SENT_DIGEST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 毎分のトリガーから呼ばれる唯一の入口。
 *
 * LockService を取るのは、前の実行が長引いたときに重なって二重送信になるのを
 * 防ぐため。取れなければ黙って帰る（1分後にまた来る）。
 */
function tick() {
  var lock = LockService.getScriptLock();

  if (!lock.tryLock(0)) {
    return;
  }

  try {
    var now = Date.now();

    setProperty_(PROP.LAST_TICK_AT, String(now));

    var lastSync = toMs_(getProperty_(PROP.LAST_SYNC_AT));

    if (!isFinite(lastSync) || now - lastSync >= SYNC_INTERVAL_MS) {
      syncCalendar_(now);
      setProperty_(PROP.LAST_SYNC_AT, String(now));
    }

    sendDueNotifications_(now);
  } catch (err) {
    Logger.log('tick error: ' + (err && err.message ? err.message : err));
  } finally {
    lock.releaseLock();
  }
}

/**
 * カレンダーを同期して notify_queue を更新する。
 *
 * CalendarApp では responseStatus を取れないため Advanced Service を使う
 * （要件 FR-04）。
 */
function syncCalendar_(nowMs) {
  var response = Calendar.Events.list('primary', {
    timeMin: new Date(nowMs).toISOString(),
    timeMax: new Date(nowMs + SYNC_WINDOW_MS).toISOString(),
    singleEvents: true,
    showDeleted: true,
    maxResults: 250,
    orderBy: 'startTime'
  });

  return applyCalendarItems_((response && response.items) || [], nowMs);
}

/**
 * 取得した予定をゲートへ渡し、返ってきた予定表をキューへ反映する。
 *
 * 戻り値は { added, updated, removed, skipped, licenseState, error }。
 */
function applyCalendarItems_(items, nowMs) {
  var settings = readSettings_();
  var skeletons = [];
  var byEid = {};

  for (var i = 0; i < items.length; i++) {
    var event = items[i] || {};
    var id = String(event.id || '');

    if (id === '') {
      continue;
    }

    var eid = eventEid_(id);

    skeletons.push(buildEventSkeleton_(event, eid));
    byEid[eid] = event;
  }

  var evaluated = gateEvaluate_({
    settings: {
      accepted: settings.accepted,
      tentative: settings.tentative,
      needsAction: settings.needsAction,
      declined: settings.declined,
      timedOnly: settings.timedOnly,
      timingMin: settings.timing
    },
    events: skeletons,
    sentDigest: buildSentDigest_(nowMs)
  });

  if (evaluated.ok) {
    /*
     * 画面へ出すために覚えておく。**ここでしか本当の状態は分からない**
     * （ライセンスの判定は運営のゲートが行い、テンプレートは結果を見るだけ）。
     */
    setProperty_(PROP.LICENSE_STATE, evaluated.licenseState);
    setProperty_(PROP.LICENSE_CHECKED_AT, String(nowMs));
  }

  if (!evaluated.ok) {
    /*
     * 判定を受け取れなかった。**キューには触らない。**
     * 触ると、通信が一度失敗しただけで予定表が消える。
     */
    return {
      added: 0, updated: 0, removed: 0, skipped: skeletons.length,
      licenseState: evaluated.licenseState, error: evaluated.error
    };
  }

  var summary = applyGateDecision_(evaluated, byEid, nowMs);

  summary.licenseState = evaluated.licenseState;
  summary.error = '';

  return summary;
}

/** ゲートの notify / remove を notify_queue へ落とす。 */
function applyGateDecision_(evaluated, byEid, nowMs) {
  var rows = tableRead_(SHEET.QUEUE);
  var byKey = {};

  for (var r = 0; r < rows.length; r++) {
    byKey[String(rows[r].key)] = rows[r];
  }

  var keep = {};
  var summary = { added: 0, updated: 0, removed: 0, skipped: 0 };

  for (var i = 0; i < evaluated.notify.length; i++) {
    var item = evaluated.notify[i] || {};
    var eid = String(item.eid || '');
    var event = byEid[eid];

    if (eid === '' || !event) {
      /* 渡していない eid が返ってきた。無視する（キューを壊さない）。 */
      summary.skipped++;
      continue;
    }

    var key = queueKey_(eid, item.timing);
    var record = {
      key: key,
      eid: eid,
      eventId: String(event.id || ''),
      feature: String(item.feature || 'calendar'),
      timing: Number(item.timing),
      title: eventTitle_(event),
      startTime: toMs_(Date.parse(String(item.startAt || ''))),
      notifyAt: toMs_(Date.parse(String(item.notifyAt || ''))),
      updatedAt: nowMs
    };

    keep[key] = true;

    if (byKey[key]) {
      tableUpdate_(SHEET.QUEUE, byKey[key].__row, record);
      summary.updated++;
    } else {
      tableAppend_(SHEET.QUEUE, record);
      summary.added++;
    }
  }

  /* remove は eid の一覧。timing が違う行もまとめて消す。 */
  var removeSet = {};

  for (var d = 0; d < evaluated.remove.length; d++) {
    removeSet[String(evaluated.remove[d])] = true;
  }

  /*
   * 掃除は追加・更新を終えた状態を読み直して1回だけ行う。
   * 途中で消すと行番号がずれ、別の行を巻き添えにする。
   */
  var fresh = tableRead_(SHEET.QUEUE);
  var targets = [];

  for (var q = 0; q < fresh.length; q++) {
    var row = fresh[q];
    var startAt = toMs_(row.startTime);

    if (!isFinite(startAt) || startAt < nowMs - QUEUE_RETENTION_MS) {
      targets.push(row.__row);
      continue;
    }

    if (removeSet[String(row.eid)] === true && keep[String(row.key)] !== true) {
      targets.push(row.__row);
    }
  }

  summary.removed = deleteRowsByNumbers_(SHEET.QUEUE, targets);

  purgeSentLog_(nowMs);

  return summary;
}

/**
 * 予定を「骨格」へ落とす（純関数）。
 *
 * **ここに列挙した項目しか外へ出ない。** 予定名・説明・参加者・カレンダーIDを
 * 足さないこと。足しても Workers 側が要求ごと拒否する（design-notes §3）。
 */
function buildEventSkeleton_(event, eid) {
  var start = (event && event.start) || {};
  var timed = typeof start.dateTime === 'string' && start.dateTime !== '';
  var startMs = eventStartMs_(event);

  return {
    eid: eid,
    feature: 'calendar',
    startAt: isFinite(startMs) ? new Date(startMs).toISOString() : '',
    status: selfResponseStatus_(event),
    allDay: !timed,
    cancelled: String((event && event.status) || '') === 'cancelled'
  };
}

/**
 * 予定IDを運営へ渡せる形（eid）にする。
 *
 * 端末ごとの秘密鍵で HMAC-SHA256 にかけるため、同じ予定でも利用者が違えば
 * 別の値になり、運営側では突き合わせられない（design-notes §3）。
 */
function eventEid_(eventId) {
  var key = getProperty_(PROP.EID_HMAC_KEY);

  if (key === '') {
    throw new Error('EID_HMAC_KEY がありません。セットアップを実行してください。');
  }

  var bytes = Utilities.computeHmacSha256Signature(String(eventId), key);

  return stripBase64Padding_(Utilities.base64EncodeWebSafe(bytes));
}

/**
 * 自分の responseStatus を取り出す（純関数）。取れなければ ''。
 *
 * 主催者本人の attendees 行には responseStatus が入らないことがあるため
 * 'needsAction' 扱いにする。attendees が無い単独予定は organizer/creator で拾う。
 */
function selfResponseStatus_(event) {
  var attendees = event && event.attendees;

  if (Object.prototype.toString.call(attendees) === '[object Array]' && attendees.length > 0) {
    for (var i = 0; i < attendees.length; i++) {
      var attendee = attendees[i] || {};

      if (attendee.self === true) {
        var status = String(attendee.responseStatus || '').trim();

        if (RESPONSE_STATUSES.indexOf(status) !== -1) {
          return status;
        }

        return 'needsAction';
      }
    }

    return '';
  }

  var organizer = (event && event.organizer) || {};
  var creator = (event && event.creator) || {};

  if (organizer.self === true || creator.self === true) {
    return 'accepted';
  }

  return '';
}

/** 予定の開始時刻をエポックミリ秒で返す（純関数）。読めなければ NaN。 */
function eventStartMs_(event) {
  var start = (event && event.start) || {};

  if (typeof start.dateTime === 'string' && start.dateTime !== '') {
    var parsed = new Date(start.dateTime).getTime();
    return isFinite(parsed) ? parsed : NaN;
  }

  if (typeof start.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(start.date)) {
    /* 終日予定。UTC 0時ではなくスクリプトのタイムゾーンの0時が欲しい。 */
    var parts = start.date.split('-');
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])).getTime();
  }

  return NaN;
}

/** 予定名。空なら既定の文言にする。**この値は外へ出ない。** */
function eventTitle_(event) {
  var summary = String((event && event.summary) || '').trim();
  return summary === '' ? '（タイトルなし）' : summary;
}

/**
 * ゲートへ渡す送信済み一覧。
 *
 * 送るのは eid / feature / timing / 開始時刻だけ。予定名は含めない。
 * リスケの再通知判定に使う（design-notes §4）。
 */
function buildSentDigest_(nowMs) {
  var rows = tableRead_(SHEET.SENT_LOG);
  var out = [];

  for (var i = 0; i < rows.length; i++) {
    var sentAt = toMs_(rows[i].sentAt);

    if (!isFinite(sentAt) || sentAt < nowMs - SENT_DIGEST_WINDOW_MS) {
      continue;
    }

    out.push({
      eid: String(rows[i].eid),
      feature: String(rows[i].feature || 'calendar'),
      timing: Number(rows[i].timing),
      startAt: toIsoOrEmpty_(rows[i].startTime)
    });
  }

  return out;
}

/** sent_log の古い行を消す。放置すると読み書きが遅くなる。 */
function purgeSentLog_(nowMs) {
  var rows = tableRead_(SHEET.SENT_LOG);
  var targets = [];

  for (var i = 0; i < rows.length; i++) {
    var sentAt = toMs_(rows[i].sentAt);

    if (!isFinite(sentAt) || sentAt < nowMs - SENT_LOG_RETENTION_MS) {
      targets.push(rows[i].__row);
    }
  }

  return deleteRowsByNumbers_(SHEET.SENT_LOG, targets);
}

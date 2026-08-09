/**
 * カレンダーの同期と、通知対象かどうかの判定。
 *
 * ------------------------------------------------------------------
 * 判定の順序は要件書 §6 のとおりに固定する
 * ------------------------------------------------------------------
 *   1. 削除済み（status === 'cancelled'）      → キューから消す（FR-14）
 *   2. 終日予定（start.dateTime が無い）        → 「時間指定のみ」ONなら除外（FR-03/07）
 *   3. 自分の出欠（attendees の self === true） → 取得（FR-04）
 *   4. その出欠が設定でONか                     → OFFなら除外（FR-05/09）
 *
 * 順序を入れ替えると、削除済みの終日予定が「終日だから除外」で止まり、
 * キューに残ったままになる。
 * ------------------------------------------------------------------
 *
 * 判定そのもの（decideEvent_）は純関数にしてある。Calendar API も
 * シートも触らないので、Node のテストからそのまま呼べる。
 */

/* 同期の間隔。tick() は毎分動くが、Calendar API を叩くのは5分に1回でよい。 */
var SYNC_INTERVAL_MS = 5 * 60 * 1000;

/* 先読みする範囲。24時間より先の予定は次の同期で拾えばよい。 */
var SYNC_WINDOW_MS = 24 * 60 * 60 * 1000;

/* キューの保持期間。開始時刻がこれより古い行は消す（DR-03）。 */
var QUEUE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/* sent_log の保持期間。二重送信の判定に使う期間より十分長くとる。 */
var SENT_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 毎分のトリガーから呼ばれる唯一の入口。
 *
 * ここで LockService を取るのは、前の実行が長引いたときに次の実行が
 * 重なって二重送信になるのを防ぐため。取れなければ黙って帰る
 * （次の1分後にまた来るので、待つ意味がない）。
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
 * 1件の予定を通知対象にするか決める（純関数）。
 *
 * 戻り値は { include, reason, responseStatus }。
 * reason は include === false のときだけ意味を持ち、ログとテストで使う。
 */
function decideEvent_(event, settings) {
  if (!event || typeof event !== 'object') {
    return { include: false, reason: 'invalid', responseStatus: '' };
  }

  /* 1. 削除済み。ここを最初に見る（下の除外に先回りされないため）。 */
  if (String(event.status || '') === 'cancelled') {
    return { include: false, reason: 'cancelled', responseStatus: '' };
  }

  var start = event.start || {};
  var timed = typeof start.dateTime === 'string' && start.dateTime !== '';

  /* 2. 終日予定。「時間指定の予定のみ」が ON なら通知しない（AC-04）。 */
  if (!timed) {
    if (settings.timedOnly) {
      return { include: false, reason: 'all-day', responseStatus: '' };
    }

    if (typeof start.date !== 'string' || start.date === '') {
      return { include: false, reason: 'no-start', responseStatus: '' };
    }
  }

  /* 3. 自分の出欠。 */
  var status = selfResponseStatus_(event);

  if (status === '') {
    /*
     * 自分が出席者として載っていない予定。
     *
     * 他人のカレンダーから流れてきた予定や、共有カレンダーの予定が
     * ここに来る。要件書 §6 補足の推奨方針どおり通知対象外とする。
     * ただし attendees 自体が無い自作の単独予定は organizer.self で拾う
     * （拾わないと「一人で入れた作業予定」が全部通知されない）。
     */
    return { include: false, reason: 'not-attendee', responseStatus: '' };
  }

  /* 4. その出欠が設定で ON か（AC-01/02/03）。 */
  if (settings[status] !== true) {
    return { include: false, reason: 'status-off', responseStatus: status };
  }

  return { include: true, reason: 'ok', responseStatus: status };
}

/**
 * 自分の responseStatus を取り出す（純関数）。取れなければ ''。
 *
 * Google は主催者本人の attendees 行に responseStatus を入れないことがある。
 * その場合は 'accepted' ではなく 'needsAction' 扱いにする
 * （既定では両方 ON なので通知は出る。declined だけを外す設定でも
 * 主催者の予定が消えない、という側に倒している）。
 */
function selfResponseStatus_(event) {
  var attendees = event.attendees;

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

  /* attendees が無い＝自分だけの予定。作成者が自分なら参加扱いにする。 */
  var organizer = event.organizer || {};
  var creator = event.creator || {};

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
    /*
     * 終日予定。'2026-08-10' を new Date() に渡すと UTC の0時になり、
     * 日本時間では前日9時になってしまう。スクリプトのタイムゾーンでの
     * 0時が欲しいので、数値3つの形で組み立てる。
     */
    var parts = start.date.split('-');
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])).getTime();
  }

  return NaN;
}

/** 通知予定時刻（純関数）。timing は「何分前か」。0 なら開始時刻ちょうど。 */
function computeNotifyAt_(startMs, timingMinutes) {
  return startMs - timingMinutes * 60 * 1000;
}

/** 予定名。空なら既定の文言にする（通知のタイトルが空になるのを防ぐ）。 */
function eventTitle_(event) {
  var summary = String((event && event.summary) || '').trim();
  return summary === '' ? '（タイトルなし）' : summary;
}

/**
 * カレンダーを同期して notify_queue を更新する。
 *
 * Advanced Service（Calendar v3）を使う。CalendarApp では responseStatus を
 * 取れないため、こちらでなければ FR-04 が満たせない。
 */
function syncCalendar_(nowMs) {
  var settings = readSettings_();
  var response = Calendar.Events.list('primary', {
    timeMin: new Date(nowMs).toISOString(),
    timeMax: new Date(nowMs + SYNC_WINDOW_MS).toISOString(),
    singleEvents: true,
    showDeleted: true,
    maxResults: 250,
    orderBy: 'startTime'
  });

  var items = (response && response.items) || [];

  return applyCalendarItems_(items, settings, nowMs);
}

/**
 * 同期結果をキューへ反映する。Calendar API から切り離してあるので、
 * テストは items を直接渡して判定と upsert をまとめて確かめられる。
 */
function applyCalendarItems_(items, settings, nowMs) {
  var rows = tableRead_(SHEET.QUEUE);
  var byKey = {};

  for (var r = 0; r < rows.length; r++) {
    byKey[String(rows[r].key)] = rows[r];
  }

  /*
   * seen … 今回の同期に出てきた予定ID。
   * keep … 残すべきキュー行のキー。
   *
   * 「出てきたのに keep に無い」行だけを消す。**出てこなかった行は消さない。**
   * timeMin が現在時刻なので、開始済みの予定はもう一覧に載らない。
   * 一覧に無いことを削除の根拠にすると、通知直前の予定が消える。
   */
  var seen = {};
  var keep = {};
  var summary = { added: 0, updated: 0, removed: 0, skipped: 0 };

  for (var i = 0; i < items.length; i++) {
    var event = items[i] || {};
    var id = String(event.id || '');

    if (id === '') {
      continue;
    }

    seen[id] = true;

    var decision = decideEvent_(event, settings);
    var startMs = decision.include ? eventStartMs_(event) : NaN;

    if (!decision.include || !isFinite(startMs)) {
      /*
       * 対象外になった予定は、過去に入れたキュー行ごと消す（下の掃除で拾う）。
       * 削除（FR-14）だけでなく、出欠を辞退へ変えた場合や、
       * 設定を OFF にした場合もここを通る。
       */
      summary.skipped++;
      continue;
    }

    var wanted = queueKey_(id, settings.timing);

    /* timing を変えたときは、古い timing の行が keep に入らず消える。 */
    keep[wanted] = true;

    var record = {
      key: wanted,
      eventId: id,
      timing: settings.timing,
      title: eventTitle_(event),
      startTime: startMs,
      notifyAt: computeNotifyAt_(startMs, settings.timing),
      updatedAt: nowMs
    };

    if (byKey[wanted]) {
      /* 開始時刻が動いていれば通知予定時刻も引き直す（FR-13）。 */
      tableUpdate_(SHEET.QUEUE, byKey[wanted].__row, record);
      summary.updated++;
    } else {
      tableAppend_(SHEET.QUEUE, record);
      summary.added++;
    }
  }

  /*
   * 掃除は最後に1回だけ、追加・更新を終えた状態を読み直して行う。
   * 途中で消すと行番号がずれ、別の行を巻き添えにする。
   */
  var fresh = tableRead_(SHEET.QUEUE);
  var targets = [];

  for (var q = 0; q < fresh.length; q++) {
    var row = fresh[q];
    var startAt = toMs_(row.startTime);

    /* 古すぎる行（DR-03）。開始時刻が読めない壊れた行もここで消える。 */
    if (!isFinite(startAt) || startAt < nowMs - QUEUE_RETENTION_MS) {
      targets.push(row.__row);
      continue;
    }

    if (seen[String(row.eventId)] === true && keep[String(row.key)] !== true) {
      targets.push(row.__row);
    }
  }

  summary.removed = deleteRowsByNumbers_(SHEET.QUEUE, targets);

  purgeSentLog_(nowMs);

  return summary;
}

/** sent_log の古い行を消す。放置すると行数が増え続けて読み書きが遅くなる。 */
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

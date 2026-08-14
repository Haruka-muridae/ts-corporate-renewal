/*
 * カレンダーURL通知アプリ（docs/specs/calendar-url-notifier-requirements-v1.md）。
 *
 * 通知タップ後に開く URL を、予定から解決する。
 * ここで解決した URL は利用者のシートにだけ置かれ、運営のゲートへは渡らない。
 */

/* 予定に書かれた URL のうち、開いてよいホスト。空配列は「制限なし」。 */
var OPEN_URL_ALLOWED_HOSTS = [];

/* OPEN_BEFORE で指定できる上限（分）。同期の窓を超える指定は効かない。 */
var OPEN_URL_MAX_BEFORE_MIN = 24 * 60;

/**
 * 通知タップ時に開く URL を決める（要件 §2）。
 *
 * 上から順に探し、最初に見つかったものを採る。
 * 1〜3 は利用者や招待者が書いた値なので検証し、落ちた場合は次の候補へ回す。
 * **通知そのものは落とさない。** 4・5 が必ず残るため、戻り値が空になるのは
 * 予定ページを取得できなかったときだけである。
 */
function resolveOpenUrl_(event) {
  var description = openUrlPlainText_((event && event.description) || '');

  var candidates = [
    extractOpenUrlTag_(description),
    extractLocationUrl_((event && event.location) || ''),
    extractFirstUrl_(description)
  ];

  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i] !== '' && isAllowedOpenUrl_(candidates[i])) {
      return candidates[i];
    }
  }

  /* 以降は Google が生成したリンク。許可ホストの対象外とする。 */
  var hangout = String((event && event.hangoutLink) || '');

  if (isGoogleUrl_(hangout)) {
    return hangout;
  }

  var htmlLink = String((event && event.htmlLink) || '');

  return isGoogleUrl_(htmlLink) ? htmlLink : '';
}

/**
 * 予定ごとの通知分数（OPEN_BEFORE）。指定が無ければ NaN。
 *
 * 呼び出し側は NaN のとき設定画面の既定値を使う（要件 §2-1）。
 */
function resolveOpenBefore_(event) {
  var description = openUrlPlainText_((event && event.description) || '');
  var matched = /^[ \t>]*OPEN_BEFORE[ \t]*:[ \t]*(\S+)/im.exec(description);

  if (!matched) {
    return NaN;
  }

  if (!/^\d+$/.test(matched[1])) {
    return NaN;
  }

  var minutes = parseInt(matched[1], 10);

  return minutes > OPEN_URL_MAX_BEFORE_MIN ? NaN : minutes;
}

/** 説明欄の OPEN_URL: 行。 */
function extractOpenUrlTag_(description) {
  var matched = /^[ \t>]*OPEN_URL[ \t]*:[ \t]*(\S+)/im.exec(description);

  return matched ? matched[1] : '';
}

/** 場所欄が URL そのものの場合だけ採る。住所が入っていれば空。 */
function extractLocationUrl_(location) {
  var trimmed = String(location).trim();

  return /^https?:\/\//i.test(trimmed) ? trimmed.split(/\s/)[0] : '';
}

/** 説明欄の中で最初に現れる URL。 */
function extractFirstUrl_(description) {
  var matched = /https?:\/\/[^\s"'<>]+/.exec(description);

  return matched ? matched[0] : '';
}

/**
 * 説明欄はリッチテキスト（HTML）で返ることがある。
 * ほどかないと、自動リンク化された URL が <a href="..."> の中に埋もれる。
 */
function openUrlPlainText_(description) {
  return String(description || '')
    /*
     * リンクは href を本文側へ出してからタグを落とす。
     * 先にタグごと消すと、`<a href="URL">資料</a>` のように
     * **表示文字列に URL が入っていないリンク**の行き先が失われる。
     */
    .replace(/<a\b[^>]*href\s*=\s*["']?([^"'\s>]+)["']?[^>]*>/gi, ' $1 ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    /* &amp; は最後にほどく。先にほどくと &amp;lt; が < まで戻る。 */
    .replace(/&amp;/g, '&');
}

/**
 * 予定に書かれた URL を採用してよいか（要件 FR-08）。
 *
 * HTTPS のみ。OPEN_URL_ALLOWED_HOSTS が空でなければホストも照合する。
 */
function isAllowedOpenUrl_(url) {
  var value = String(url);

  if (/\s/.test(value)) {
    return false;
  }

  for (var i = 0; i < value.length; i++) {
    var code = value.charCodeAt(i);

    if (code < 33 || code === 127) {
      return false;
    }
  }

  var matched = /^https:\/\/([^\/?#]+)/i.exec(value);

  if (!matched) {
    /* http:// と形式不正はここで落ちる。 */
    return false;
  }

  var authority = matched[1];

  /* user:pass@ 付きは、見かけのホストを偽装できるため受け付けない。 */
  if (authority.indexOf('@') !== -1) {
    return false;
  }

  var host = authority.split(':')[0].toLowerCase();

  if (host === '' || !/^[a-z0-9.\-\[\]]+$/.test(host)) {
    return false;
  }

  if (OPEN_URL_ALLOWED_HOSTS.length === 0) {
    return true;
  }

  for (var h = 0; h < OPEN_URL_ALLOWED_HOSTS.length; h++) {
    var allowed = String(OPEN_URL_ALLOWED_HOSTS[h]).toLowerCase().replace(/^\./, '');

    if (allowed === '') {
      continue;
    }

    if (host === allowed || host.slice(-(allowed.length + 1)) === '.' + allowed) {
      return true;
    }
  }

  return false;
}

/** google.com 配下の HTTPS URL か。Meet リンクと予定ページの検証に使う。 */
function isGoogleUrl_(url) {
  var matched = /^https:\/\/([^\/?#]+)/i.exec(String(url || ''));

  if (!matched) {
    return false;
  }

  var host = matched[1].split(':')[0].toLowerCase();

  return host === 'google.com' || host.slice(-11) === '.google.com';
}

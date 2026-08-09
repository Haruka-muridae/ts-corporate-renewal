/*
 * Posts.gs — 投稿の記録
 *
 * ==================================================================
 * 成功も失敗も記録する
 * ==================================================================
 * 失敗を残さないと、**同じ失敗を何度も繰り返したことに気づけない。**
 * `error` 列に相手のエラー本文をそのまま入れる（言い換えない）。
 *
 * ==================================================================
 * ここが X の課金の歯止めになる
 * ==================================================================
 * 月次上限（`x.monthlyPostLimit`、既定60件）は**この記録を数えて**判定する。
 * X 側の支出上限とは別に、**件数でも止める**（手順書 §E-4）。
 * ==================================================================
 */

/** `2026-08-09T…` から `2026-08` を取る。**文字列のまま扱う。** */
function IssoPosts_monthKey(isoString) {
  var value = String(isoString === undefined || isoString === null ? '' : isoString);
  var matched = value.match(/^(\d{4})-(\d{2})/);

  return matched === null ? '' : matched[1] + '-' + matched[2];
}

/** 投稿を1件記録する。 */
function IssoPosts_record(store, input, deps) {
  deps = deps || {};

  var row = {
    post_id: IssoConfig_newId(ISSO_SHEET.POSTS, deps.uuid),
    theme_id: String(input.theme_id || ''),
    version_id: String(input.version_id || ''),
    platform: String(input.platform || ''),
    status: String(input.status || ''),
    posted_at: IssoConfig_now(deps.now),
    url: String(input.url || ''),
    error: String(input.error || '')
  };

  store.insert(ISSO_SHEET.POSTS, row);

  return row;
}

/** テーマの投稿履歴（新しい順）。 */
function IssoPosts_list(store, themeId) {
  var rows = store.findBy(ISSO_SHEET.POSTS, 'theme_id', themeId);

  rows.sort(function (a, b) {
    if (a.posted_at === b.posted_at) {
      return 0;
    }

    return a.posted_at < b.posted_at ? 1 : -1;
  });

  return rows;
}

/**
 * 今月の投稿試行数。
 *
 * **成功だけでなく失敗も数える。**
 * 課金は「投稿できたか」ではなく「リクエストを送ったか」で発生しうるので、
 * 成功だけ数えると、失敗を繰り返したときに歯止めにならない。
 *
 * **Helper への引き渡しは数えない**（外部への通信ではないため）。
 */
function IssoPosts_countMonth(store, platform, isoNow) {
  var month = IssoPosts_monthKey(isoNow);
  var rows = store.findBy(ISSO_SHEET.POSTS, 'platform', platform);
  var count = 0;

  for (var i = 0; i < rows.length; i++) {
    if (rows[i].status === ISSO_STATUS.POST_HANDED_TO_HELPER) {
      continue;
    }

    if (IssoPosts_monthKey(rows[i].posted_at) === month) {
      count += 1;
    }
  }

  return count;
}

/**
 * X の月次上限を読む。
 *
 * **数として読めない値は上限0として扱う**（＝投稿しない）。
 * 設定を手で書き換えられるようにしてあるので、
 * 「`むせいげん` と書いたら無制限になった」という壊れ方を避ける。
 * **課金に関わる値では、読めないときに緩む側へ倒さない。**
 */
function IssoPosts_monthlyLimit(store) {
  var raw = IssoSettings_get(store, 'x.monthlyPostLimit');
  var value = Number(String(raw).replace(/[,\s]/g, ''));

  if (!isFinite(value) || value < 0) {
    return 0;
  }

  return Math.floor(value);
}

/**
 * 上限に達していないか。達していれば理由付きで返す。
 *
 * @returns {{ ok: boolean, reason: string, used: number, limit: number }}
 */
function IssoPosts_checkMonthlyLimit(store, platform, isoNow) {
  if (platform !== ISSO_PLATFORM.X) {
    /* 課金が発生するのは X だけ。Threads は無料枠のため数えるだけにする。 */
    return { ok: true, reason: '', used: 0, limit: 0 };
  }

  var limit = IssoPosts_monthlyLimit(store);
  var used = IssoPosts_countMonth(store, platform, isoNow);

  if (used >= limit) {
    return {
      ok: false,
      used: used,
      limit: limit,
      reason: '今月の X への投稿が上限に達しています（' + used + '/' + limit + '件）。'
        + '設定の x.monthlyPostLimit で変えられます。'
    };
  }

  return { ok: true, reason: '', used: used, limit: limit };
}

/**
 * 投稿してよい版かを確かめ、版を返す。**駄目なら例外。**
 *
 * ==================================================================
 * ここが「事故を防ぐ」ところ
 * ==================================================================
 * 投稿は**取り消せない**（消せても、見た人には見えている）。
 * したがって**送る前に止める**。判定を Threads.gs と X.gs に分けて書くと、
 * 片方だけ緩むおそれがあるので1か所にまとめてある。
 *
 * @param {string} platform ISSO_PLATFORM のいずれか
 */
function IssoPosts_requirePostable(store, versionId, platform, deps) {
  deps = deps || {};

  var version = store.findById(ISSO_SHEET.VERSIONS, versionId);

  if (version === null) {
    throw new Error('版が見つかりません: ' + versionId);
  }

  /* 段階IDと投稿先を同じ語にしてあるので、そのまま突き合わせられる。 */
  if (version.stage !== platform) {
    throw new Error(
      'この版は ' + version.stage + ' の案です。' + platform + ' へは投稿できません。'
    );
  }

  /*
   * **採用していない案は投稿しない。**
   * 「採用」が「これで出す」という意思表示なので、
   * 下書きのまま押せてしまうと、選ぶ前のものが公開されうる。
   */
  if (version.adopted !== true) {
    throw new Error('採用していない案は投稿できません。先に採用してください。');
  }

  /*
   * **同じ版を二度投稿しない。**
   * 画面の二度押し・通信が遅いときの押し直しで、
   * **同じ文章が2回公開される**のが、この道具で一番起きやすい事故。
   */
  var history = store.findBy(ISSO_SHEET.POSTS, 'version_id', versionId);

  for (var i = 0; i < history.length; i++) {
    if (history[i].platform === platform && history[i].status === ISSO_STATUS.POST_OK) {
      throw new Error(
        'この版はすでに ' + platform + ' へ投稿済みです（' + history[i].posted_at + '）。'
      );
    }
  }

  var limit = IssoPosts_checkMonthlyLimit(store, platform, IssoConfig_now(deps.now));

  if (limit.ok !== true) {
    throw new Error(limit.reason);
  }

  return version;
}

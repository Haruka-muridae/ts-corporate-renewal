/**
 * notifier-gate の定数。
 *
 * ------------------------------------------------------------------
 * ここに集めた理由
 * ------------------------------------------------------------------
 * V1 では判定に関わる定数が gas-notifier/ の3ファイル（Store.gs /
 * CalendarSync.gs / Push.gs）に散っていた。利用者が自分のスプレッドシートへ
 * 貼るコードだった以上それでよかったが、V2 では判定が運営側へ移り、
 * 「値を変えたら全利用者の挙動が変わる」ものになった。
 * 1ファイルに集め、変更の影響範囲を目で追えるようにしている。
 * ------------------------------------------------------------------
 */

/** /v1/health で返す版。判定ロジックを変えたら上げる。 */
export const GATE_VERSION = '2.0.0';

/* 出欠の状態。Google Calendar API の responseStatus と同じ語をそのまま使う。 */
export const RESPONSE_STATUSES = ['accepted', 'tentative', 'needsAction', 'declined'];

/* 設定の既定値（要件 FR-06 / FR-07 / FR-11）。V1 の DEFAULT_SETTINGS と同じ。 */
export const DEFAULT_SETTINGS = {
  accepted: true,
  tentative: true,
  needsAction: true,
  declined: false,
  timedOnly: true,
  timingMin: 5,
};

/* 通知タイミング（分前）の選択肢。0 は「開始時刻ちょうど」。要件 FR-10。 */
export const ALLOWED_TIMINGS = [0, 5, 10, 15];

/**
 * 再通知の閾値（B-05 の解決）。
 *
 * 重複判定のキーへ開始時刻を含めると、リスケが正しく再通知される代わりに、
 * 主催者が1〜2分ずらすたびに別キーになって通知が連発する。
 * **旧 startAt との差がこれ未満なら「送信済みを引き継ぐ」**（＝再通知しない）。
 *
 * 比較の相手は常に **sentDigest に載っている送信時点の startAt** であり、
 * 直前の同期で見た値ではない。4分ずらしを2回繰り返した場合、
 * 元の予定からは8分動いているので再通知される（微修正の連発は防ぎつつ、
 * じわじわ動いた予定を取りこぼさない）。
 */
export const RENOTIFY_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * キューに残す下限。開始時刻がこれより古い予定は remove で返す（要件 DR-03）。
 * V1 の QUEUE_RETENTION_MS と同じ値。GAS 側の掃除と二重になるが、
 * Workers は無状態なので「古い骨格を渡されたら黙って捨てる」側も要る。
 */
export const QUEUE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * VAPID JWT の有効期間。RFC 8292 の上限は24時間だが、V1 と同じく12時間にする。
 * GAS は Script Properties へキャッシュし、期限まで使い回す（1日1〜2回の発行）。
 */
export const VAPID_JWT_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * ライセンス判定のキャッシュ期間。
 *
 * **これがそのまま「解約から通知が止まるまでの最長時間」になる。**
 * 短くすると認証系 GAS への問い合わせが増え、長くすると解約の反映が遅れる。
 * 6時間は docs/calendar-notifier-setup.md に明記してあるので、
 * 変えるならそちらも直すこと。
 */
export const LICENSE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * 認証系 GAS へ届かないときの猶予（grace）の上限。
 *
 * Apps Script は稀に数時間単位で不調になる。そこで通知が止まると
 * 「金を払っているのに動かない」状態になるため、**直前まで有効だった
 * ライセンスに限り**この期間だけ継続させる。
 * 一度も検証できていないキーには猶予を与えない（fail closed）。
 */
export const LICENSE_GRACE_MAX_MS = 72 * 60 * 60 * 1000;

/**
 * 猶予中に認証系 GAS へ問い合わせ直す間隔。
 *
 * 猶予に入ったからといって5分ごとに問い合わせ続けると、不調な相手を
 * 全利用者ぶん叩き続けることになる。復帰の検出が最大10分遅れるだけなので、
 * 間隔を空けるほうを採る。
 */
export const LICENSE_GRACE_RECHECK_MS = 10 * 60 * 1000;

/** 認証系 GAS への問い合わせを諦めるまでの時間。 */
export const AUTH_GAS_TIMEOUT_MS = 8 * 1000;

/** ライセンスの状態。この3つ以外は返さない。 */
export const LICENSE_STATE = {
  ACTIVE: 'active',
  GRACE: 'grace',
  EXPIRED: 'expired',
};

/**
 * レート制限。エンドポイントごとに「1キーあたり何回 / 何秒」。
 * evaluate は5分に1回の呼び出しを想定しているので、1分2回で十分に余裕がある。
 */
export const RATE_LIMITS = {
  evaluate: { limit: 2, windowSec: 60 },
  vapid: { limit: 4, windowSec: 60 * 60 },
  testNotify: { limit: 1, windowSec: 24 * 60 * 60 },
};

/** 既定の機能名。イベントに feature が無ければこれとして扱う。 */
export const DEFAULT_FEATURE = 'calendar';

/**
 * 機能ごとの判定ルール。
 *
 * ------------------------------------------------------------------
 * 通知基盤を機能横断で使えるようにするための入口
 * ------------------------------------------------------------------
 * カレンダー通知は「予定の骨格 → 通知するか」を決める1つの機能にすぎない。
 * 将来ほかの機能（例: 提出期限のリマインド）を同じ Push 基盤に載せるとき、
 * ここへ1行足せば通る形にしてある。
 *
 * **未登録の feature は remove で返す（通さない）。** 判定を運営側に置くのが
 * V2 の目的なので、利用者側のテンプレートが勝手に新しい feature を名乗って
 * 通知を出せる状態にはしない。
 * ------------------------------------------------------------------
 *
 *   attendanceFilter … 出欠（accepted / tentative / …）で絞るか
 *   allDayFilter     … 「時間指定のみ」設定で終日予定を落とすか
 */
export const FEATURE_RULES = {
  calendar: { attendanceFilter: true, allDayFilter: true },
};

/**
 * evaluate が受け取ってよいイベントのフィールド。
 *
 * **これ以外のキーが1つでもあれば要求ごと拒否する。** 予定名・説明・参加者・
 * メールアドレスを運営サーバーが受け取らないことが V2 の売り（DR-03/04）であり、
 * 「送らないよう気をつける」ではなく「送られても受け取らない」側で守る。
 */
export const ALLOWED_EVENT_FIELDS = [
  'eid',
  'feature',
  'startAt',
  'status',
  'allDay',
  'cancelled',
  'timingMin',
];

/** sentDigest の1件が持ってよいフィールド。理由は ALLOWED_EVENT_FIELDS と同じ。 */
export const ALLOWED_DIGEST_FIELDS = ['eid', 'feature', 'timing', 'startAt'];

/** 1回の evaluate で受け取るイベントの上限。24時間分の予定としては十分に多い。 */
export const MAX_EVENTS = 500;

/** 1回の vapid で発行する JWT の上限。端末が増えても push サービスは数種類しかない。 */
export const MAX_AUDIENCES = 10;

/**
 * VAPID JWT を発行してよい push サービスのホスト（サフィックス一致）。
 *
 * 制限する理由: JWT は「この鍵の持ち主からの要求である」という署名であり、
 * aud を自由に指定できると、ライセンスさえ持っていれば運営の鍵で
 * 任意の相手へ署名済みトークンを送れてしまう。用途は push 送信だけなので、
 * 実在する push サービスに限る。
 */
export const DEFAULT_PUSH_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'notify.windows.com',
  'push.apple.com',
];

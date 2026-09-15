/**
 * Push Assistant の定数（仕様書 §8-1）。
 *
 * ------------------------------------------------------------------
 * 1ファイルに集める理由
 * ------------------------------------------------------------------
 * notifier-gate/src/constants.mjs と同じ考え方。判定に関わる値が
 * schedule.mjs / tick.mjs / api.mjs に散ると、「この数字を変えたら
 * どこが変わるのか」を目で追えなくなる。通知の挙動を決める値は
 * すべてここに置き、他のモジュールは import して使う。
 *
 * **仕様書 §8-1 に載っている値を変えるときは、仕様書も同時に直すこと。**
 * ------------------------------------------------------------------
 */

/** /api/health で返す版。通知の判定を変えたら上げる。 */
export const SERVICE_NAME = 'push-assistant';
export const SERVICE_VERSION = '1.0.0';

/**
 * 通知タイミングの選択肢（仕様書 §8-1）。
 *
 * 0 は「開始時刻ちょうど」。将来 5 分前・30 分前を足すときはここへ
 * 1 行足すだけでよいが、**LOOKAHEAD_MS が最大 lead を覆っているか**を
 * 必ず確認する（覆っていないと Calendar 取得窓に入らず通知が出ない）。
 */
export const LEAD_OPTIONS = [
  { value: 10, label: '10分前' },
  { value: 0, label: '開始時刻' },
];

/** LEAD_OPTIONS の値だけを取り出したもの。設定の検証に使う。 */
export const LEAD_VALUES = LEAD_OPTIONS.map((option) => option.value);

/** 未設定の利用者に使う既定値。 */
export const DEFAULT_LEAD_MINUTES = [10];

/** 1 人が同時に選べる通知タイミングの上限（仕様書 §7 の PUT /api/settings）。 */
export const MAX_LEAD_SELECTION = 5;

/**
 * notify_at がこれより古い予定は「見送り（skipped）」にする。
 *
 * Cron は毎分動くが、Cloudflare 側の遅延やデプロイ中の停止で数分飛ぶことがある。
 * 飛んだ直後に「30 分前に始まった会議」の通知を出しても迷惑なだけなので、
 * 10 分を境に切る。切った事実は履歴（status=skipped）に残す。
 */
export const DUE_GRACE_MS = 10 * 60 * 1000;

/**
 * pending のまま notify_at からこれ以上経ったら failed にする。
 *
 * MAX_ATTEMPTS に達していなくても、push サービスが長時間 5xx を返し続ける
 * 状況では「もう届けても意味が無い」時点が来る。時間でも打ち切る。
 */
export const STALE_PENDING_MS = 15 * 60 * 1000;

/** 1 件の通知を送り直す最大回数。 */
export const MAX_ATTEMPTS = 3;

/**
 * 'sending' のまま取り残された行を、もう一度拾ってよくなるまでの時間。
 *
 * ------------------------------------------------------------------
 * これが無いと通知が永久に消える
 * ------------------------------------------------------------------
 * claimDueNotifications は pending → sending に移してから送信する。
 * その間に **isolate が落ちると（Free プランの CPU 10ms 超過、
 * デプロイによる置き換え、Cloudflare 側の障害）**、行は sending のまま残る。
 * 次の tick は pending しか拾わないので、その通知は二度と送られず、
 * 履歴にも「送信中」と表示され続ける。
 *
 * そこで、sending のまま一定時間たった行は「落ちた」とみなして拾い直す。
 * 短くすると、送信に手間取っているだけの行を二重に送りうる。
 * 1 tick は数秒で終わるので、5 分あれば取り違えない。
 * ------------------------------------------------------------------
 */
export const STUCK_SENDING_MS = 5 * 60 * 1000;

/**
 * Calendar 取得窓（先）。最大 lead（将来 30 分等）を必ず覆うこと。
 * 1 時間あれば lead=10 は余裕を持って覆え、取得件数も 50 件で足りる。
 */
export const LOOKAHEAD_MS = 60 * 60 * 1000;

/** Calendar 取得窓（後ろ）。DUE_GRACE_MS ぶんの取りこぼしを拾うため 1 分だけ余分に取る。 */
export const LOOKBEHIND_MS = DUE_GRACE_MS + 60 * 1000;

/**
 * 1 tick で処理する利用者の上限。
 *
 * Workers Free プランは **1 呼び出しあたり 50 サブリクエスト**。
 * 1 人あたりの内訳は「トークン更新 1 + Calendar 1 + push（最大
 * MAX_NOTIFICATIONS_PER_USER_TICK × 購読数）」。
 *
 * 定常状態（due な通知が無い分）は 1 人 2 回なので 15 人で 30。
 * 通知が出る分でも、送信は一部の利用者にしか発生しない。
 * **15 にしてあるのは、全員が同時に 1 件ずつ送る最悪ケース
 * （15 × 3 = 45）でも 50 を超えないため。** 20 だと 60 で溢れ、
 * 溢れた subrequest は例外になって tick が途中で止まる。
 *
 * 溢れないことより「毎分どの利用者にも順番が回ること」のほうが重要なので、
 * listActiveUsers は last_tick_at の古い順に並べてある（下の store）。
 * 利用者が増えたら Paid プランを検討する（README §8）。
 */
export const MAX_USERS_PER_TICK = 15;

/**
 * 1 tick で 1 人あたり送る通知の上限（仕様書には無い補足）。
 *
 * 上の subrequest 上限を守るために要る。通常は 1〜2 件しか due にならないので、
 * 5 件で足りる。溢れた分は pending のまま残り、次の tick で送られる。
 */
export const MAX_NOTIFICATIONS_PER_USER_TICK = 5;

/** push サービスに預けておく時間（秒）。端末が圏外でもこの間は再配達される。 */
export const PUSH_TTL_SEC = 600;

/**
 * VAPID JWT の有効期間。RFC 8292 の上限は 24 時間だが、notifier-gate と同じ 12 時間にする。
 * 送信のたびに発行するので短くても困らない。
 */
export const VAPID_JWT_TTL_MS = 12 * 60 * 60 * 1000;

/* ---------------- HTTP / セッション ---------------- */

/** セッション Cookie の名前と寿命（仕様書 §5）。 */
export const SESSION_COOKIE = 'pa_session';
export const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60;

/** OAuth の途中状態 Cookie。state と PKCE の code_verifier を入れる。 */
export const OAUTH_COOKIE = 'pa_oauth';
export const OAUTH_MAX_AGE_SEC = 600;

/**
 * 受け取る JSON 本文の上限（64KB）。
 * 一番大きいのは購読の登録で、それでも 1KB に満たない。
 */
export const MAX_BODY_BYTES = 64 * 1024;

/** GET /api/events が返す窓と件数（仕様書 §7）。 */
export const EVENTS_LOOKAHEAD_MS = 24 * 60 * 60 * 1000;
export const MAX_EVENTS_RESPONSE = 20;

/** GET /api/notifications が返す件数（仕様書 §7）。 */
export const NOTIFICATION_HISTORY_LIMIT = 50;

/* ---------------- Google ---------------- */

/**
 * カレンダー読み取りのスコープ。
 * **同意画面で外されていないか**をコールバックで確かめる相手でもある。
 */
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';

/** 要求するスコープ（仕様書 §4-3。これ以上広げない）。 */
export const GOOGLE_SCOPES = ['openid', 'email', CALENDAR_SCOPE];

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
export const CALENDAR_EVENTS_ENDPOINT = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

/** id_token の iss として認める値（Google は 2 種類を使い分ける）。 */
export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/** 1 回の Calendar 取得で受け取る件数。1 ページのみ（仕様書 §4-4）。 */
export const CALENDAR_MAX_RESULTS = 50;

/**
 * キャッシュしたアクセストークンを再利用してよい余裕。
 * 残り 60 秒を切っていたら、途中で切れるより先に取り直す。
 */
export const ACCESS_TOKEN_REUSE_MARGIN_MS = 60 * 1000;

/* ---------------- 表示・上限 ---------------- */

/** 開く URL の長さの上限（仕様書 §9）。 */
export const MAX_URL_LENGTH = 2048;

/** 通知に載せるタイトルの上限。push の本文は 4KB 弱しか入らない。 */
export const MAX_TITLE_LENGTH = 120;

/**
 * 通知テンプレート本文（notify_body）の上限（仕様書 §6・§8）。
 *
 * push の本文全体は 4KB 弱（MAX_PLAINTEXT_BYTES=3993）しか入らない。
 * タイトル・URL・JSON の枠も同じ枠を分け合うので、本文テンプレートは
 * 500 文字で切る。`{url}` 等を展開した **後** に切るため、展開結果が
 * 長くても暗号化前に必ずこの長さ以下になる。
 */
export const MAX_NOTIFY_BODY_LENGTH = 500;

/** 予定の説明から拾う URL の本数。1 件目しか使わないが、画面のために少し多めに持つ。 */
export const MAX_EXTRACTED_URLS = 5;

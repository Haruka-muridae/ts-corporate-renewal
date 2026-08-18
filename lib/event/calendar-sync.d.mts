/*
 * lib/event/calendar-sync.mjs の型定義。
 * ファイル名が .d.mts なのは、対象が .mjs だから。
 */

import type { SupabaseConfig } from "./config.mjs";
import type { GmailCredentials } from "./mail/gmail.mjs";

export declare const CALENDAR_EVENT_TITLE: string;
export declare const SETUP_BUFFER_MINUTES: number;
export declare const SYNC_TTL_MINUTES: number;
export declare const SYNC_WINDOW_MONTHS: number;
export declare const DEFAULT_CAPACITY: number;

/** 参加者に見せる開催時間（予定の開始+30分 〜 終了−30分）。 */
export type EventWindow = {
  startAt: string;
  endAt: string;
};

/** 60分以下の予定は開催時間が0以下になるため null を返す。 */
export declare function applyBuffer(
  startIso: string,
  endIso: string,
  bufferMinutes?: number,
): EventWindow | null;

export type CalendarOccurrence = {
  id: string;
  summary: string;
  startIso: string;
  endIso: string;
};

/*
 * カレンダーの資格情報は、型としてはメール送信と同じ3点。
 * アクセストークンの取得（getAccessToken）を共用しているため。
 */
export type CalendarSource = {
  calendarId: string;
  credentials: GmailCredentials;
};

/**
 * 取得はトークン交換を含めて1つの制限時間で括る。
 * signal を渡さなければ既定の制限時間で作る（テストでの差し替え用）。
 *
 * ページ数の上限まで読んでも続きがある場合は例外にする（切り詰めた一覧で
 * 突き合わせると、載らなかった回の受付が黙って止まるため）。
 */
export type CalendarFeed = {
  /** 取り込む対象の予定。 */
  occurrences: CalendarOccurrence[];
  /** 削除された予定のID（明示的な削除の証拠）。 */
  cancelledIds: string[];
  /**
   * 生きているが取り込み対象にならなかった予定のID
   * （改題・主催者が他人・eventType の除外・終日など）。
   * 一覧が届いている証拠なので、該当する回の受付を止めてよい根拠になる。
   */
  unmatchedActiveIds: string[];
};

export declare function fetchCalendarOccurrences(
  input: CalendarSource & {
    fetchImpl?: typeof fetch;
    now: Date;
    signal?: AbortSignal;
  },
): Promise<CalendarFeed>;

export type SyncWarning = {
  /** 新規作成に失敗した場合など、行が特定できないときは空文字。 */
  eventId: string;
  message: string;
};

export type SyncResult = {
  created: number;
  updated: number;
  unpublished: number;
  /** 60分以下・進行中などで取り込まなかった件数。 */
  skipped: number;
  /**
   * 安全弁で受付を止めなかった件数。
   *
   * 「予定のIDがフィードのどこにも現れない（削除の証拠も無い）」回が対象で、
   * かつ取り込み対象が1件も取れなかったとき（取得異常が疑われるとき）だけ
   * 0 より大きくなる。削除・改題の証拠がある回はここに入らず、必ず止まる。
   */
  unpublishSkipped: number;
  warnings: SyncWarning[];
};

/** lib/event/db.mjs の名前空間、またはテスト用の差し替え。 */
type EventDb = Record<string, (...args: never[]) => Promise<unknown>>;

export declare function syncCalendarEvents(input: {
  config: SupabaseConfig;
  calendar: CalendarSource;
  db: EventDb;
  fetchImpl?: typeof fetch;
  now: Date;
}): Promise<SyncResult>;

export declare function syncIfStale(input: {
  config: SupabaseConfig;
  calendar: CalendarSource;
  db: EventDb;
  fetchImpl?: typeof fetch;
  now: Date;
}): Promise<{
  synced: boolean;
  /** TTL内・他が同期中・DB不調で実行しなかった場合に true。 */
  skipped: boolean;
  result: SyncResult | null;
  error: string | null;
}>;

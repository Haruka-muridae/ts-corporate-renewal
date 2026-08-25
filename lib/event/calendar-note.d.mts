/*
 * lib/event/calendar-note.mjs の型定義。
 * ファイル名が .d.mts なのは、対象が .mjs だから。
 */

import type { SupabaseConfig } from "./config.mjs";
import type { GmailCredentials } from "./mail/gmail.mjs";

/** 自動更新ブロックの開始行。この文字列で既存ブロックを探す。 */
export declare const NOTE_BEGIN_MARKER: string;
/** 自動更新ブロックの終了行。 */
export declare const NOTE_END_MARKER: string;
/**
 * 名簿に使ってよい文字数の上限。超えたら名簿を落として人数だけを書く。
 * 説明欄全体（手書きメモを含む）が Google 側の上限を超えるときも同じく落とす。
 */
export declare const ROSTER_MAX_LENGTH: number;

/**
 * 名簿の1行。
 *
 * 受付番号と氏名だけを持つ。カレンダーはアプリの外なので、当日の受付で
 * 照合できる最小限に絞っている（フリガナ・メール・電話・会社名は持たない）。
 */
export type AttendeeEntry = {
  receiptNumber: string | null;
  name: string;
};

export type AttendeeNote = {
  /** 支払済み（applications.status='paid'）の件数。DB側で数えた正確な値。 */
  paidCount: number;
  /** events.capacity。null・0以下・小数は「定員なし」として扱う。 */
  capacity: number | null;
  /** 受付番号の昇順で並べた名簿。省略・空配列なら人数行だけを書く。 */
  attendees?: AttendeeEntry[];
  /** 「更新:」行に出す時刻。実時計はこのモジュールでは読まない。 */
  now: Date;
};

/**
 * 既存の説明文の手書き部分を保ったまま、自動更新ブロックだけを差し替える。
 * ブロックが無ければ末尾に追記する。null・空文字でも動く。
 */
export declare function buildDescriptionWithNote(
  existingDescription: string | null | undefined,
  note: AttendeeNote,
): string;

/**
 * Calendar API v3 で説明欄だけを更新する（GET → 差し替え → PATCH）。
 *
 * タイトル（summary）は同期の突き合わせキーなので送らない。
 * 内容が変わらないときは PATCH を送らず updated: false を返す。
 * 失敗は例外。文言にはトークンも応答本文も含めず、HTTPの状態コードだけを出す。
 */
export declare function writeAttendeeNote(
  input: AttendeeNote & {
    fetchImpl?: typeof fetch;
    /** 書き込み用のリフレッシュトークンを持つ資格情報（読み取り用とは別）。 */
    credentials: GmailCredentials;
    calendarId: string;
    /** events.google_calendar_event_id。手動登録の回（null）では呼ばない。 */
    googleCalendarEventId: string;
    signal?: AbortSignal;
  },
): Promise<{ updated: boolean; description: string }>;

/** 書き戻しの口。未設定の環境では null になる。 */
export type AttendeeNoteWriter = {
  write: (
    note: AttendeeNote & { googleCalendarEventId: string },
  ) => Promise<{ updated: boolean; description: string }>;
};

/**
 * 書き戻しの口を作る。設定（`calendarWriteConfig()` の戻り値、
 * 未設定なら null）から組み立て、未設定なら null を返す。
 */
export declare function createAttendeeNoteWriter(
  calendarWrite: { calendarId: string; credentials: GmailCredentials } | null,
  fetchImpl?: typeof fetch,
): AttendeeNoteWriter | null;

/** lib/event/db.mjs の名前空間、またはテスト用の差し替え。 */
type EventDb = Record<string, (...args: never[]) => Promise<unknown>>;

/**
 * 対象の回の支払済み人数と名簿を数え直してカレンダーへ書き戻す。
 *
 * **例外を投げない。** 何が起きたか（成功・見送り・失敗の理由）を
 * 1行の日本語で返すだけにしてある。呼び出し元（Webhook・管理画面）の
 * 本処理を書き戻しの失敗で巻き戻さないため。
 *
 * `eventId` と `applicationId` はどちらか一方を渡す。
 */
export declare function updateAttendeeNote(input: {
  config: SupabaseConfig;
  db: EventDb;
  writer: AttendeeNoteWriter | null;
  eventId?: string | null;
  applicationId?: string | null;
  now?: Date;
}): Promise<string>;

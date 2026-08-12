/*
 * AI議事録アプリ（meeting-minutes）への引継ぎデータの組み立てと保存。
 *
 * 対象仕様:
 *   docs/specs/meeting-minutes-requirements-v1.md §3-1・§5（アプリ間連携要件）
 *   docs/specs/audio-transcriber-requirements-v1.md「AI議事録への引継ぎ」
 *
 * ------------------------------------------------------------------
 * このファイルの責務
 * ------------------------------------------------------------------
 * 「引継ぎデータの形を組み立てて sessionStorage へ書き込む」ことだけを行う。
 * DOM・画面遷移・文言はここに置かない（script.js の責務）。
 * storage と現在時刻（now）は引数で受け取り、Node からそのまま
 * import してテストできる形にする（DOM を参照しない）。
 *
 * 有効期限（createdAt + 30分）の判定は受け側（meeting-minutes）が行う。
 * このファイルは書き込むだけで、期限は判定しない
 * （meeting-minutes-requirements-v1.md §5-3「引継ぎキーは実装時に一意な
 *   固定名を定め、双方の仕様書に記載する」に基づく取り決め）。
 * ------------------------------------------------------------------
 *
 * URLのクエリ・ハッシュへ本文を載せない（meeting-minutes-requirements-v1.md §5-1）。
 * 保存先は sessionStorage のみとし、本文をlocalStorageへ恒久保存しない。
 */

/*
 * 引継ぎキー。双方の仕様書（本アプリ・meeting-minutes）に同じ名前で記載する固定名。
 * 値を変えると、双方の実装が揃っていても引継ぎが成立しなくなる。
 */
export const HANDOFF_STORAGE_KEY = 'tsam-meeting-minutes-handoff-v1';

/* 引継ぎデータの形式バージョン。将来の形式変更が要るときはここを進める。 */
export const HANDOFF_VERSION = 1;

/* sourceApp は固定値。meeting-minutes 側はこの値で送信元を判定する。 */
const SOURCE_APP = 'audio-transcriber';

/* 保存結果の理由コード。画面側はこれを見て文言を出し分ける。 */
export const HandoffResultReason = Object.freeze({
  OK: 'ok',
  EMPTY_TRANSCRIPT: 'empty-transcript',
  STORAGE_UNAVAILABLE: 'storage-unavailable',
});

/*
 * metadata は「判明しているものだけ」を入れる。推測で埋めない
 * （meeting-minutes-requirements-v1.md §5-2「transcript 以外の項目は任意とする」）。
 *
 * speakers は、このアプリでは話者を構造化して特定できない
 * （本文中の「話者1：」等の表記は文字起こし本文の一部でしかない）ため、
 * 常に空配列にする。
 */
function buildMetadata(rawMetadata) {
  const source = rawMetadata && typeof rawMetadata === 'object' ? rawMetadata : {};
  const metadata = { speakers: [] };

  const title = typeof source.title === 'string' ? source.title.trim() : '';

  if (title !== '') {
    metadata.title = title;
  }

  const recordedAt = typeof source.recordedAt === 'string' ? source.recordedAt.trim() : '';

  if (recordedAt !== '') {
    metadata.recordedAt = recordedAt;
  }

  if (Number.isFinite(source.durationSeconds) && source.durationSeconds >= 0) {
    metadata.durationSeconds = source.durationSeconds;
  }

  return metadata;
}

/*
 * 引継ぎデータの形を組み立てる（sessionStorage へは書き込まない）。
 *
 * 文字起こしが空・空白のみの場合は組み立てず失敗を返す。
 * 呼び出し側（saveHandoff）はこれを使って書き込む前に検証する。
 */
export function buildHandoffPayload({ transcript, metadata } = {}, { now = () => new Date() } = {}) {
  const text = String(transcript ?? '');

  if (text.trim() === '') {
    return { ok: false, reason: HandoffResultReason.EMPTY_TRANSCRIPT };
  }

  return {
    ok: true,
    payload: {
      version: HANDOFF_VERSION,
      sourceApp: SOURCE_APP,
      createdAt: now().toISOString(),
      transcript: text,
      metadata: buildMetadata(metadata),
    },
  };
}

/*
 * 引継ぎデータを sessionStorage（互換オブジェクト）へ書き込む。
 *
 * storage は setItem を持つ Web Storage 互換オブジェクトを渡す
 * （テストでは Map ベースの偽物を渡せる）。
 * 未指定・書き込み失敗（プライベートモード・容量超過等）のときは
 * 書き込まずに理由を返す。
 */
export function saveHandoff({ transcript, metadata } = {}, { storage, now = () => new Date() } = {}) {
  const built = buildHandoffPayload({ transcript, metadata }, { now });

  if (!built.ok) {
    return built;
  }

  if (!storage || typeof storage.setItem !== 'function') {
    return { ok: false, reason: HandoffResultReason.STORAGE_UNAVAILABLE };
  }

  try {
    storage.setItem(HANDOFF_STORAGE_KEY, JSON.stringify(built.payload));
  } catch {
    /* 容量超過・書き込み禁止（プライベートモード等）。 */
    return { ok: false, reason: HandoffResultReason.STORAGE_UNAVAILABLE };
  }

  return { ok: true, reason: HandoffResultReason.OK };
}

/*
 * Google 連携の設定値。**差し替えるのはこのファイルだけ。**
 *
 * ==================================================================
 * クライアントIDを入れる場所
 * ==================================================================
 * 下の GOOGLE_CLIENT_ID を、Google Cloud で発行した値へ置き換える。
 * ほかのファイルにクライアントIDを書かないこと。
 *
 * 発行手順は docs/specs/card-ocr-phase0-plan.md §4-2 B。
 * 承認済みJavaScript生成元には次の2つを登録済み（2026-08-03）。
 *
 *   https://tsam-ai.com  … 本番
 *   https://ts-corporate-renewal-git-docs-c-17e1f8-architect-3362s-projects.vercel.app
 *                        … フェーズ0の検証用。**終わったら外す**（計画 §3-3）
 *
 * **クライアントIDは秘密ではない。** リポジトリに入れてよい
 * （既存の public/apps/auth-config.js も同じ扱い）。
 * クライアントシークレットは使わない。静的サイトに置けないため。
 * ==================================================================
 */

/* 未設定の目印。この値のままなら連携を開始しない。 */
export const CLIENT_ID_PLACEHOLDER = 'REPLACE_WITH_GOOGLE_CLIENT_ID';

/*
 * ★ 差し替える箇所はここ1つ。
 *
 * card-ocr 専用に新規発行したもの（2026-08-03）。
 * テスト環境 /apps/ が使う既存IDとは**別のクライアント**である
 * （フェーズ0計画 §6-2 の決定）。
 *
 * このIDで作成したファイルだけが drive.file の対象になるため、
 * card-scanner が作ったファイルはこのアプリからは見えない。これは意図どおり。
 */
export const GOOGLE_CLIENT_ID = '603018562548-6653ifft0dji8g93m9sba919rn0nv4li.apps.googleusercontent.com';

/*
 * 要求するスコープはこの1つだけ。**増やさないこと。**
 *
 * drive.file は「このクライアントIDが作成した、または利用者が明示的に
 * 選んだファイル」だけを対象とする権限で、ドライブ全体を読む権限ではない
 * （要件定義書 §FR-02 の2、§6 前提条件4）。
 *
 * スコープを増やすと利用者に再同意を求めることになり、
 * 「未確認アプリ」の警告や審査の要否にも影響する。
 */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/*
 * GIS の公式配信URL。
 *
 * docs/external-dependency-approvals.md で承認済みの読み込み先であり、
 * **ここ以外へ向けてはならない。** 自己ホスト・npm化・非公式ミラーへの
 * 差し替えも行わない（Google 側の更新に追従できなくなるため）。
 */
export const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';

/* 読み込みの打ち切り。通信が滞ったまま画面が固まるのを防ぐ。 */
export const GIS_LOAD_TIMEOUT_MS = 10000;

/*
 * クライアントIDが設定済みか。
 *
 * **未設定なら GIS を読み込まない。** 承認記録の条件どおり、
 * 画面を開いただけで外部通信を発生させないため、判定を先に行う。
 */
export function isClientIdConfigured(clientId = GOOGLE_CLIENT_ID) {
  if (typeof clientId !== 'string') {
    return false;
  }

  const value = clientId.trim();

  return value !== '' && value !== CLIENT_ID_PLACEHOLDER;
}

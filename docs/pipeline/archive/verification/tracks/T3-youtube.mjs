/*
 * T3: YouTube Data API
 *
 * 目的（検証計画 §3）: 「台本→動画→公開」の最終区間の成立条件を確定する。
 * **Phase 0 で最も期間を要する可能性が高い。初週に着手する。**
 *
 * guide §4 での追加: T3-7「ブラウザからの Resumable Upload 実証」。
 * §2-3 は「利用者のGoogleトークンでブラウザから直接アップロード」を前提にしている。
 * これが成立しないと、動画ファイルがサーバーを経由することになり、
 * 非保持方針（§2-1）の前提が崩れて設計をやり直すことになる。
 * **T3-7 は Phase 3 の前提条件であり、他の T3 項目より重い。**
 */

import { env } from '../lib/record.mjs';

const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/youtube/v3';

export const meta = {
  id: 'T3',
  title: 'YouTube Data API',
  goal: '公開アップロードの成立条件を確定する（監査・スコープ・クォータ）',

  /*
   * v0.5 で凍結。YouTube 連携が MVP 対象外になったため（guide §8）。
   * **削除しない。** 拡張フェーズで再開するときにそのまま使う。
   * 凍結の全体像は verification/pipeline/FROZEN.md。
   */
  frozen: true,
  frozenReason: 'v0.5 で YouTube 連携が MVP 対象外（guide §8）。拡張フェーズで再開する',
};

export const items = [
  {
    id: 'T3-1',
    kind: 'manual',
    title: 'GCP プロジェクト作成、OAuth 同意画面（テスト）、youtube.upload での認証',
    pass: 'テストユーザーで認証成功',
    owner: 'owner-tasks.md B-1〜B-6',
  },
  {
    id: 'T3-1b',
    kind: 'manual',
    title: '【重要】youtube.upload のスコープ分類を Console で実機確認',
    pass: 'センシティブ／制限付きのどちらかが確定する',
    owner:
      'owner-tasks.md C-1（**【停止】項目**）。'
      + ' 制限付きだと第三者セキュリティ評価が要り、費用と期間が桁で変わる。'
      + ' Console を開けば数分で分かるので、実装を進める前に確定させる',
    blockedBy: 'owner-tasks.md C-1',
  },
  {
    id: 'T3-2',
    kind: 'auto',
    title: 'videos.insert（Resumable Upload）でのテスト動画アップロード',
    pass: '非公開動画としてアップロード成功。中断・再開の挙動を確認',
    needs: ['GOOGLE_ACCESS_TOKEN', 'VERIFY_VIDEO_PATH'],
    async run(ctx) {
      const token = env('GOOGLE_ACCESS_TOKEN');
      const videoPath = env('VERIFY_VIDEO_PATH');

      if (token === null || videoPath === null) {
        return ctx.skip('GOOGLE_ACCESS_TOKEN / VERIFY_VIDEO_PATH が未設定');
      }

      /* セッションURLの発行までを確認する。実バイト送出は --publish 指定時のみ。 */
      const init = await ctx.fetchRaw(
        `${UPLOAD_API}/videos?uploadType=resumable&part=snippet,status`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Type': 'video/mp4',
          },
          body: JSON.stringify({
            snippet: { title: `[検証 T3-2] ${ctx.stamp}`, description: '検証用。削除予定。' },
            /* 監査未通過でも通るよう、明示的に private で上げる。 */
            status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
          }),
        },
      );

      const sessionUrl = init.headers.get('location');

      if (!init.ok || sessionUrl === null) {
        return ctx.fail('Resumable セッションを開始できない', {
          httpStatus: init.status,
          hasLocation: sessionUrl !== null,
        });
      }

      return ctx.pass('Resumable セッションの発行を確認', {
        sessionUrlIssued: true,
        /* セッションURLは資格情報に相当するため値を記録しない。 */
        bytesUploaded: ctx.publish ? 'TODO: --publish での実送出を実装する' : 'skipped',
      });
    },
  },
  {
    id: 'T3-3',
    kind: 'auto',
    title: 'クォータ実測',
    pass: 'videos.insert の消費ユニットを実測し、1日のアップロード可能本数を算出',
    needs: ['GOOGLE_ACCESS_TOKEN'],
    note:
      '**B-8（監査申請）の前提。** ここが終わるまで監査フォームのクォータ欄を'
      + ' 推測で埋めない（後で食い違って再提出になる）。'
      + ' 消費ユニットは API 応答からは分からないため、'
      + ' GCP の「割り当て」画面の前後差分を担当者が読む',
    async run(ctx) {
      const token = env('GOOGLE_ACCESS_TOKEN');

      if (token === null) {
        return ctx.skip('GOOGLE_ACCESS_TOKEN が未設定');
      }

      /* 到達性だけ確認し、実測値は担当者が Console の割り当て画面から追記する。 */
      const res = await ctx.fetchJson(
        `${YOUTUBE_API}/channels?part=id&mine=true`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      return res.ok
        ? ctx.pass('API に到達できた。消費ユニットは Console の割り当て画面で読む', {
            reachable: true,
            followUp: [
              'アップロード前後で「割り当て」画面の消費を読み、差分を記録する',
              '既定 10,000 ユニット/日 で何本上げられるかを算出して results/T3.md へ書く',
            ],
          })
        : ctx.fail('API に到達できない', { httpStatus: res.status, errorShape: res.json });
    },
  },
  {
    id: 'T3-4',
    kind: 'manual',
    title: 'API プロジェクト監査（コンプライアンス審査）の申請',
    pass: '未監査だと公開設定でも非公開に強制される制約の解除。要件と所要期間を記録',
    owner: 'owner-tasks.md B-8。申請文面は phase0/review-submissions.md §4',
  },
  {
    id: 'T3-5',
    kind: 'manual',
    title: 'OAuth 同意画面の本番公開（検証）要件',
    pass: '審査プロセスと必要物を整理',
    owner: 'owner-tasks.md C-1〜C-7。文面は phase0/review-submissions.md §3',
  },
  {
    id: 'T3-6',
    kind: 'manual',
    title: 'タイトル・概要・サムネイル設定のAPI反映',
    pass: 'FR-044 の生成物をそのまま反映できる',
    owner: 'T3-2 が通ってから。目視確認',
  },
  {
    id: 'T3-7',
    kind: 'browser',
    title: '【guide §4 追加】ブラウザからの Resumable Upload 実証',
    pass: 'ブラウザ → YouTube の直接アップロードが CORS で通り、中断・再開もできる',
    probe: 'probes/resumable-upload-youtube.html',
    note:
      '**Phase 3 の前提条件。** 成立しないと動画ファイルがサーバーを経由することになり、'
      + ' §2-1 の非保持方針が崩れる（一時保持の範囲が広がり、審査での説明も変わる）。'
      + ' 不成立の場合は guide §2-2 の「レンダリング完了後に利用者へ返却」へ倒し、'
      + ' サーバー側の一時ファイルの即時削除で担保する',
  },
];

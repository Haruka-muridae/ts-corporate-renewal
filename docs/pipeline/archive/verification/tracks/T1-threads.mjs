/*
 * T1: Threads API
 *
 * 目的（検証計画 §3）: OAuth 連携〜テキスト投稿〜結果取得を実アカウントで通す。
 *
 * guide §4 での追加: T1-6「ブラウザからの直接呼び出し（CORS）可否」。
 * これが可能なら投稿の中継サーバーを外せる。外せると、本文がサーバーを
 * 一度も通らなくなり、§2 の非保持の主張が「記録しない」から
 * 「そもそも通らない」に強くなる。審査での説明も楽になるため、
 * 単なる最適化ではなく設計上の分岐点として扱う。
 */

import { env } from '../lib/record.mjs';

/** Threads の Graph API のベース。バージョンは検証時点で最新を確認して上げる。 */
const THREADS_API = 'https://graph.threads.net/v1.0';

export const meta = {
  id: 'T1',
  title: 'Threads API',
  goal: 'OAuth 連携〜テキスト投稿〜結果取得を実アカウントで通す',
};

export const items = [
  {
    id: 'T1-1',
    kind: 'manual',
    title: 'Meta アプリ作成、Threads ユースケース追加、開発モードでのテスト投稿',
    pass: '自アカウントへ投稿成功',
    owner: 'owner-tasks.md D-1 / D-6',
  },
  {
    id: 'T1-2',
    kind: 'auto',
    title: 'コンテナ作成 → 公開の2段階フローとエラーパターン',
    pass: '状態遷移を PublishJob の状態（要件11章）へマッピングできる',
    needs: ['THREADS_ACCESS_TOKEN', 'THREADS_USER_ID'],
    async run(ctx) {
      const token = env('THREADS_ACCESS_TOKEN');
      const userId = env('THREADS_USER_ID');

      if (token === null || userId === null) {
        return ctx.skip('THREADS_ACCESS_TOKEN / THREADS_USER_ID が未設定');
      }

      /*
       * 実投稿はしない。コンテナ作成までを行い、公開は担当者が明示的に
       * --publish を付けたときだけ実行する。検証スクリプトが不意に
       * 実アカウントへ投稿するのは事故のもと。
       */
      const body = new URLSearchParams({
        media_type: 'TEXT',
        text: `[検証 T1-2] ${ctx.stamp}`,
        access_token: token,
      });

      const created = await ctx.fetchJson(
        `${THREADS_API}/${encodeURIComponent(userId)}/threads`,
        { method: 'POST', body },
      );

      if (!created.ok) {
        return ctx.fail('コンテナ作成に失敗', {
          httpStatus: created.status,
          errorShape: created.json?.error ?? null,
        });
      }

      const containerId = created.json?.id ?? null;

      if (!ctx.publish) {
        return ctx.pass('コンテナ作成まで確認（公開は --publish 指定時のみ）', {
          containerId,
          twoStepConfirmed: true,
        });
      }

      const published = await ctx.fetchJson(
        `${THREADS_API}/${encodeURIComponent(userId)}/threads_publish`,
        {
          method: 'POST',
          body: new URLSearchParams({ creation_id: containerId, access_token: token }),
        },
      );

      return published.ok
        ? ctx.pass('コンテナ作成→公開の2段階を確認', {
            containerId,
            publishedId: published.json?.id ?? null,
          })
        : ctx.fail('公開に失敗', {
            containerId,
            httpStatus: published.status,
            errorShape: published.json?.error ?? null,
          });
    },
  },
  {
    id: 'T1-3',
    kind: 'manual',
    title: 'App Review 申請（threads_basic / threads_content_publish）',
    pass: '審査要件・所要日数を記録。通過まではアプリ内下書きで代替（FR-065）',
    owner: 'owner-tasks.md D-9 / D-10。申請文面は phase0/review-submissions.md §2',
  },
  {
    id: 'T1-4',
    kind: 'auto',
    title: 'レート制限（threads_publishing_limit の取得を含む）',
    pass: '24h 250件上限を投稿キュー設計へ反映できる',
    needs: ['THREADS_ACCESS_TOKEN', 'THREADS_USER_ID'],
    async run(ctx) {
      const token = env('THREADS_ACCESS_TOKEN');
      const userId = env('THREADS_USER_ID');

      if (token === null || userId === null) {
        return ctx.skip('THREADS_ACCESS_TOKEN / THREADS_USER_ID が未設定');
      }

      const res = await ctx.fetchJson(
        `${THREADS_API}/${encodeURIComponent(userId)}/threads_publishing_limit`
        + `?fields=quota_usage,config&access_token=${encodeURIComponent(token)}`,
      );

      return res.ok
        ? ctx.pass('公開上限を取得できた', { limit: res.json?.data?.[0] ?? res.json })
        : ctx.fail('公開上限を取得できない', {
            httpStatus: res.status,
            errorShape: res.json?.error ?? null,
          });
    },
  },
  {
    id: 'T1-5',
    kind: 'manual',
    title: '文字数・改行・URL の扱い',
    pass: '500字上限とプレビュー表示仕様を確定',
    owner: '実文面での目視確認。プレビュー実装（Phase 1）の入力になる',
  },
  {
    id: 'T1-6',
    kind: 'browser',
    title: '【guide §4 追加】ブラウザからの直接呼び出し（CORS）可否',
    pass: 'ブラウザ → Threads API の投稿が CORS で通れば、中継APIを実装しない',
    probe: 'probes/cors-threads.html',
    note:
      'Node の fetch では CORS を検証できない（同一生成元ポリシーはブラウザの機構）。'
      + ' probes/ のページを実オリジンで開いて確認する。'
      + ' 通らない場合は無状態中継を実装する（guide §2-3 の既定）。',
  },
];

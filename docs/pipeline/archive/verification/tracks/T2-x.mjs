/*
 * T2: X API
 *
 * 目的（検証計画 §3）: 従量課金モデル下で、投稿1件あたりの実コストと運用方法を確定する。
 *
 * guide §2-3 / §6-1: **BYOキー方式（利用者自身の X APIキー）を第一候補**とする。
 * 承認は保留中のため、以下は両方式に切り替えられる形で組んである。
 *
 * 何が変わり、何が変わらないか:
 *   - 変わる: キーの出どころ（利用者の入力 か 環境変数）と、費用の負担者
 *   - 変わらない: 投稿API・エラー応答・レート制限ヘッダ・状態マッピング
 *
 * したがって T2-3（単価実測）と T2-4（エラー応答）は、どちらの方式でも
 * 同じ結果になる。**先に実施してよい。** 方式の承認を待つ必要があるのは
 * T2-1（支出上限）だけである。
 */

import { env } from '../lib/record.mjs';

const X_API = 'https://api.x.com/2';

/**
 * 検証に使う資格情報の出どころ。
 *
 * BYOキー方式では利用者のキーを使うため、検証でも「利用者役の1人分のキー」を
 * 環境変数で渡す。運営キー共有方式に切り替わっても、ここが読む変数名が
 * 変わるだけで、以降の検証内容は変わらない。
 */
function credentials() {
  const byo = env('X_MEMBER_ACCESS_TOKEN');

  if (byo !== null) {
    return { mode: 'byo', token: byo };
  }

  const shared = env('X_SHARED_ACCESS_TOKEN');

  return shared === null ? null : { mode: 'shared', token: shared };
}

export const meta = {
  id: 'T2',
  title: 'X API',
  goal: '投稿1件あたりの実コストと運用方法を確定する（BYOキー前提・切替可能）',
};

export const items = [
  {
    id: 'T2-1',
    kind: 'manual',
    title: 'プロジェクト作成・従量課金の有効化・支出上限設定',
    pass: '上限到達時に課金ではなく停止となることを確認',
    owner:
      '**§6-1 の承認待ち。** BYOキー方式なら利用者各自の作業になり、発注者作業は発生しない。'
      + ' 運営キー共有方式に決まった場合のみ発注者が実施する',
    blockedBy: 'guide §6-1',
  },
  {
    id: 'T2-2',
    kind: 'manual',
    title: 'OAuth 2.0 (PKCE) でのユーザー認証とトークンリフレッシュ',
    pass: 'リフレッシュ失敗時の再認証導線を設計へ反映',
    owner:
      'PKCE は公開クライアントの流儀なので、非保持構成と相性がよい'
      + '（client_secret をサーバーに置かずに済む可能性がある）。'
      + ' T3-1 の Google 側の判断（review-submissions.md §3-5）と揃えて検討する',
  },
  {
    id: 'T2-3',
    kind: 'auto',
    title: 'テキスト投稿（URL付き／なし）の単価実測',
    pass: '1投稿あたりコストを記録し、上限設計の入力にする',
    needs: ['X_MEMBER_ACCESS_TOKEN または X_SHARED_ACCESS_TOKEN'],
    async run(ctx) {
      const cred = credentials();

      if (cred === null) {
        return ctx.skip('X_MEMBER_ACCESS_TOKEN / X_SHARED_ACCESS_TOKEN が未設定');
      }

      if (!ctx.publish) {
        /*
         * 単価は「実際に課金される投稿」でしか測れない。事故防止のため、
         * --publish を明示したときだけ実投稿する。
         */
        return ctx.skip('実投稿を伴うため --publish 指定時のみ実行する');
      }

      const results = [];

      for (const variant of [
        { label: 'テキストのみ', text: `[検証 T2-3 a] ${ctx.stamp}` },
        { label: 'URL付き', text: `[検証 T2-3 b] ${ctx.stamp} https://tsam-ai.com/` },
      ]) {
        const res = await ctx.fetchJson(`${X_API}/tweets`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cred.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text: variant.text }),
        });

        results.push({
          variant: variant.label,
          ok: res.ok,
          httpStatus: res.status,
          postId: res.json?.data?.id ?? null,
          /* 単価はダッシュボード側でしか読めないため、担当者が後から追記する。 */
          unitCostUsd: null,
          rateLimitHeaders: res.rateLimit,
        });
      }

      return ctx.pass('投稿を実行した。単価は X の請求画面で確認して追記する', {
        mode: cred.mode,
        results,
        followUp: 'results/T2.md に単価を手で追記すること',
      });
    },
  },
  {
    id: 'T2-4',
    kind: 'auto',
    title: '投稿削除・エラー応答・レート制限ヘッダ',
    pass: 'FAILED→再試行の実装方針を確定',
    needs: ['X_MEMBER_ACCESS_TOKEN または X_SHARED_ACCESS_TOKEN'],
    async run(ctx) {
      const cred = credentials();

      if (cred === null) {
        return ctx.skip('X_MEMBER_ACCESS_TOKEN / X_SHARED_ACCESS_TOKEN が未設定');
      }

      /*
       * 意図的に不正な本文を送り、エラー応答の形とレート制限ヘッダを観測する。
       * 投稿は成立しないので課金されない（はず）。この「はず」も記録する。
       */
      const res = await ctx.fetchJson(`${X_API}/tweets`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cred.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: '' }),
      });

      return ctx.pass('エラー応答の形を観測した', {
        mode: cred.mode,
        httpStatus: res.status,
        errorShape: res.json,
        rateLimitHeaders: res.rateLimit,
        followUp: '失敗した呼び出しが課金対象かどうかを請求画面で確認して追記する',
      });
    },
  },
  {
    id: 'T2-5',
    kind: 'manual',
    title: '【BYOキー方式】利用者向けキー登録ガイドの成立性',
    pass: '非開発者が X Developer 登録〜キー取得を完了できる手順書が書ける',
    owner:
      'guide §2-3 が「BYOキーの登録手順ガイドをアプリ内に用意する」としている。'
      + ' 実際に1人で通しでやってみて、詰まる箇所を記録する。'
      + ' **ここが現実的でないなら §6-1 は否認すべき**という判断材料になる',
    blockedBy: 'guide §6-1',
  },
];

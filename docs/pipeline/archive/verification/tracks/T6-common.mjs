/*
 * T6: 共通基盤
 *
 * 元の目的（検証計画 §3）: 要件14章の非機能要件を満たす最小構成を確定する。
 *
 * guide §2 により、この トラックは中身が最も大きく変わった。
 *
 *   - T6-1（OAuthトークンの暗号化保管）は **実施しない。** 保管しないため。
 *     代わりに「トークンがサーバーに残らないこと」を確かめる T6-1' を置いた。
 *     消した項目を黙って消すと、あとで「なぜ検証していないのか」が分からなくなるので、
 *     置き換えた事実をここに残す。
 *   - T6-2（ジョブキューの冪等性）は縮小。サーバー側の予約投稿ジョブが無くなり
 *     リマインダー方式（§2-4）になったため、残るのはレンダリングジョブのみ。
 *   - 追加（guide §4）: カウンタ保存先の選定（T6-4）、Web Push の検証（T6-5）。
 */

import { env } from '../lib/record.mjs';

export const meta = {
  id: 'T6',
  title: '共通基盤',
  goal: '非保持構成で非機能要件を満たす最小構成を確定する',
};

export const items = [
  {
    id: 'T6-1',
    kind: 'auto',
    title: "【置き換え】トークン・本文がサーバー側に残らないことの確認",
    pass: 'DB・ログ・エラーレポートのいずれにも本文とトークンが存在しない',
    note:
      '元の T6-1「OAuthトークンの暗号化保管方式の選定」は、§2 により保管しないため実施しない。'
      + ' 代わりに「残っていないこと」を確かめる。'
      + ' **guide §7 の「非保持の証明」チェックリストの原型になる項目。**',
    async run(ctx) {
      /*
       * Phase 1 以降でしか本当の確認はできない（中継APIがまだ無い）。
       * いまの時点では、チェック項目を確定させ、実装時にそのまま使える形にしておく。
       */
      const checklist = [
        'サーバー側にコンテンツ用のテーブルが存在しない（Supabase のスキーマを目視）',
        'トークンを Vault・暗号化カラム・Cookie のいずれにも書いていない',
        '中継APIが本文・トークンを console.log へ出していない',
        'Vercel Functions のログに本文が出ていない（例外メッセージ経由の漏れを含む）',
        'エラーレポートに本文が添付されていない',
        'カウンタ表に利用者ID・媒体・回数・月しか列が無い',
      ];

      return ctx.pass('チェック項目を確定。実施は Phase 1 の実装後', {
        checklist,
        status: 'Phase 1 待ち',
      });
    },
  },
  {
    id: 'T6-2',
    kind: 'manual',
    frozen: true,
    title: '【凍結】レンダリングジョブの冪等性',
    pass: '同一ジョブの二重実行で動画が二重生成・二重アップロードされない',
    owner:
      '**対象が消滅したため凍結（v0.5）。**'
      + ' 元は「予約投稿ジョブとレンダリングジョブ」が対象だったが、'
      + ' 予約投稿は §2-4 でリマインダー方式になりサーバーの代理実行が無くなり、'
      + ' 残っていたレンダリングも guide §8 で拡張フェーズへ送られた。'
      + ' **サーバー側に冪等性を要するジョブが1つも無い状態。**'
      + ' 投稿の冪等性は利用者ローカルのキューと idempotencyKey で担保する（T6-3 側）',
  },
  {
    id: 'T6-3',
    kind: 'manual',
    title: '指数バックオフ再試行と最終失敗の通知経路',
    pass: 'FAILED 理由が利用者に表示される',
    owner:
      '再試行キューも利用者ローカルに持つ（§2-2、guide §4 Phase 2）。'
      + ' サーバー側にキューを作らない点が元の計画と違う',
  },
  {
    id: 'T6-4',
    kind: 'auto',
    title: '【guide §4 追加】カウンタ保存先の選定（スプレッドシート vs 最小Supabase）',
    pass: 'どちらを採るか、判断根拠つきで決まる',
    needs: ['（Supabase 側を測るなら）SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'],
    async run(ctx) {
      const url = env('SUPABASE_URL');
      const key = env('SUPABASE_SERVICE_ROLE_KEY');

      const comparison = {
        criteria: [
          '書き込み1回の所要時間（利用のたびに走るため、ここが遅いと体感に出る）',
          '同時書き込みの正しさ（カウンタは加算なので競合が起きる）',
          '運用の手間（既存の Apps Script 運用に乗るか、新しい系を増やすか）',
          '利用者数が増えたときの限界（スプレッドシートは全件走査が重くなる）',
          '**既存の tsam-event プロジェクトと分けるか**（分けないと交流会アプリと同居する）',
        ],
        sheetsNote:
          '本番認証系が既にスプレッドシート運用（gas-auth）を持っているため、'
          + ' 運用を増やさずに済む利点がある。'
          + ' ただし AUTH_SETUP.md「将来の移行について」が'
          + ' 「数百人規模で全件走査が重くなる」と既に警告している点に注意',
        supabaseNote:
          '交流会アプリが tsam-event を使っている。'
          + ' 同じプロジェクトに相乗りすると系が混ざる（CLAUDE.md の「片方の都合で'
          + ' もう片方を変えない」に反する）。**別プロジェクトを立てるべきか要判断**',
      };

      if (url === null || key === null) {
        return ctx.skip('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定。比較観点のみ記録', {
          comparison,
        });
      }

      const started = process.hrtime.bigint();
      const res = await ctx.fetchRaw(`${url.replace(/\/+$/, '')}/rest/v1/`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

      return ctx.pass('Supabase への到達時間を測定', {
        comparison,
        supabaseReachable: res.ok,
        roundTripMs: Math.round(elapsedMs),
        followUp: 'スプレッドシート側も同条件で測り、results/T6.md で並べる',
      });
    },
  },
  {
    id: 'T6-5',
    kind: 'browser',
    title: '【guide §4 追加】Web Push（予約リマインダー）の実装検証',
    pass: '許諾UI・指定時刻の発火・ワンタップ投稿までが通る（AC-05 読み替え版）',
    probe: 'probes/web-push.html',
    note: `**AC-05 の読み替えが成立するかどうかが懸かっている項目。**

確かめること:
  - 許諾UIの体験（拒否されたときに何を案内するか）
  - 指定時刻に発火するか。**端末がスリープ／ブラウザが閉じているときの挙動**
  - iOS Safari の制約（ホーム画面追加が要るか、通知が届くか）
  - 通知からアプリを開いてワンタップ投稿へ到達できるか

**iOS で成立しないなら AC-05 の読み替え自体を見直す必要がある**（guide §2-4）。
「タブが開いている間のみ有効な自動実行」オプションだけでは、
利用者の期待に対して弱すぎる可能性がある。ここは実測してから発注者へ報告する。`,
  },
];

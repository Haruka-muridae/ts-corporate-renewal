/**
 * notifier-gate の公開オリジン。**ここが正本。**
 *
 * ==================================================================
 * なぜ1か所に置くか
 * ==================================================================
 * このURLは4つの場所に現れる。
 *
 *   1. Workers の設定（workers/notifier-gate/wrangler.jsonc）
 *   2. 利用者の Apps Script（gas-notifier/ の Gate クライアント）
 *   3. 録音アプリのフロント（public/production-app/voice-recorder/notifier-config.js）
 *   4. 録音アプリの CSP（index.html の connect-src）
 *
 * これらは別の実行環境にあり、import で1つの値を共有できない
 * （GAS は ES モジュールを読めず、CSP は HTML の属性である）。
 * したがって「実行時に1か所」は原理的に作れない。
 *
 * 代わりに **「正本を1つ決め、ずれたらテストが落ちる」** 形にしてある。
 * このファイルが正本で、tests/unit/notifier-gate.mjs が
 * 下の GATE_ORIGIN_FILES を読んで一致を検査する。
 * どこか1か所だけ書き換えると、その時点でテストが落ちる。
 * ==================================================================
 *
 * ==================================================================
 * 独自ドメインへ移すとき
 * ==================================================================
 * workers.dev の既定ドメインは、Custom Domain を後から足しても
 * **無効にならず並行して有効なまま**である。したがって移行は
 *   1. 独自ドメインを Custom Domain として追加する
 *   2. この定数を新URLへ変え、上の4か所をテストに従って揃える
 *   3. 新しくセットアップする利用者から新URLを使う
 * の順で行え、**既にセットアップ済みの利用者は何もしなくてよい。**
 * 詳しくは workers/notifier-gate/README.md §8。
 * ==================================================================
 */

/** 公開オリジン（末尾スラッシュを付けない）。 */
export const NOTIFIER_GATE_ORIGIN = 'https://notifier-gate.potenitas-lp.workers.dev';

/**
 * この値が現れる場所。テストが一致を検査する。
 *
 * 新しく参照する場所を作ったら、ここへ足すこと。足し忘れても既存の検査は
 * 通ってしまうため、**参照を増やす変更では必ずこの配列を見直す。**
 */
export const GATE_ORIGIN_FILES = [
  {
    path: 'workers/notifier-gate/wrangler.jsonc',
    note: 'workers.dev での公開設定（サービス名がURLの先頭になる）',
    /* 設定に書くのはサービス名だけなので、URL そのものはコメントに現れる。 */
    expectOrigin: true,
  },
  {
    path: 'workers/notifier-gate/README.md',
    note: 'エンドポイント一覧・デプロイ手順・CSP 変更案',
    expectOrigin: true,
  },
  {
    path: 'public/production-app/voice-recorder/notifier-config.js',
    note: 'フロントの接続先（ヘルスチェックとライセンス状態の表示）',
    expectOrigin: true,
  },
  {
    path: 'gas-notifier/Gate.gs',
    note: '利用者のテンプレートからゲートを呼ぶときの接続先',
    expectOrigin: true,
  },
];

/**
 * 使ってはいけない、過去に検討した公開先。
 *
 * `api.potenitas.com` は当初の案だったが、ゾーン追加が要るため MVP では採らない
 * （2026-08-10 決定）。書き戻されていないことをテストで見張る。
 * potenitas.com 自体が未取得である点は docs/backlog.md の B-06 を参照。
 */
export const FORBIDDEN_GATE_ORIGINS = ['https://api.potenitas.com'];

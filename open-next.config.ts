/*
 * OpenNext（Cloudflare 用）のビルド設定。
 *
 * Next.js のビルド成果物を Cloudflare Workers で動く形へ変換するために使う。
 * `npm run build:cf` から呼ばれ、`.open-next/` を作る。
 *
 * ------------------------------------------------------------------
 * incrementalCache を設定していない
 * ------------------------------------------------------------------
 * 既定のテンプレートは R2 を使う増分キャッシュ（r2IncrementalCache）を
 * 有効にしている。ここでは**入れていない。**
 *
 * 理由は、このサイトが ISR を使っていないため。配信物の大半は public/ 配下の
 * 静的ファイルで、サーバー側で動くのは交流会申込（app/event/）だけである。
 * そこも都度実行で、再検証を伴う配信は無い。
 *
 * 入れると R2 バケットの事前作成が要り、作っていなければデプロイが落ちる。
 * 使わない仕組みのために失敗する余地を増やさない。
 *
 * ISR を使い始めるときは、ここで r2IncrementalCache を有効化し、
 * wrangler.jsonc の r2_buckets と WORKER_SELF_REFERENCE も併せて有効にすること
 * （3つが揃って初めて機能する）。
 * ------------------------------------------------------------------
 */

import { defineCloudflareConfig } from '@opennextjs/cloudflare';

export default defineCloudflareConfig({});

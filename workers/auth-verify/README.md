# auth-verify — セッション検証の代理（キャッシュ付き）

保護ページを開くたびに走るセッション検証を、Cloudflare 側で短時間キャッシュする独立した Worker。

仕様は [docs/specs/auth-verify-cache-spec-v1.md](../../docs/specs/auth-verify-cache-spec-v1.md)。

## 1. これは何を解決するか

保護ページは `guardPage()` の結果を待ってから描画する。その検証が認証系 Apps Script への往復で、**実測 1.85〜2.60 秒**かかっていた（コールドスタート時は最大 35 秒）。アプリを開くたびにこの空白が入る。

この Worker が「GAS が有効と答えた事実」を 30 分だけ覚えることで、**キャッシュ命中時は 0.1〜0.2 秒**になる。

## 2. 何をして、何をしないか

**する**

- `verifySession` を受け、キャッシュにあればそれを返す
- 無ければ既存の GAS `verifySession` へそのまま転送し、結果を覚える

**しない**

- **判定しない。** 有効かどうかを決めるのは GAS（sessions シート）だけ
- **アカウント状態・契約状態のロジックを複製しない。** 再検証のたびに GAS の既存判定がそのまま通る
- **ログイン・ログアウト・パスワード系を通さない。** これらはブラウザ → GAS 直のまま。パスワードをこの Worker へ通さないのは意図的な線引き
- **新しい秘密を持たない。** GAS へ送るのは利用者のセッショントークンだけで、GAS の `verifySession` は元から公開エンドポイント

この線引きにより、Apps Script 側は**一切変更しない**。ロールバックはフロントの宛先を戻すだけで済む。

## 3. デプロイ前に必要な作業

**① KV namespace（作成済み・2026-08-13）**

`VERIFY_CACHE` は作成済みで、id は `wrangler.jsonc` に記入済み。作り直す必要はない。

作り直す場合のコマンドは次のとおり。

```
wrangler kv namespace create VERIFY_CACHE --config workers/auth-verify/wrangler.jsonc
```

notifier-gate の `LICENSE_CACHE` とは**別の namespace にすること**。無料枠の書き込み上限（1,000/日）を食い合う量が見分けられなくなるため。

**② デプロイ**

```
npm run deploy:auth-verify
```

**`npm run deploy` はこの Worker を更新しない。** 逆もまた同じ（notifier-gate と同じ関係）。

**③ 動作確認（フロントを切り替える前に）**

```
curl -s -X POST https://auth-verify.potenitas-lp.workers.dev/ \
  -H 'Content-Type: text/plain;charset=utf-8' \
  -d '{"action":"verifySession","sessionToken":"invalid-dummy"}'
```

`{"success":false,"error":{"code":"SESSION_INVALID",...}}` が返れば疎通している。

## 4. フロントの切り替え

`public/auth/config.js` に `verifyApiUrl` を足し、`public/auth/api.js` の `verifySession` だけ宛先を変える。**未設定なら GAS 直のまま**というフェイルセーフの形にすること。

ロールバックは `verifyApiUrl` を消して再デプロイするだけ。**GAS は最初から無傷なので、戻す作業が無い。**

## 5. 触るときに壊しやすいところ

**① 応答の形**

gas-auth と**バイト互換**でなければならない。`public/auth/api.js` の `readResult` は `payload.success` と `payload.data` しか見ない。

```
成功: { success: true,  data: { user, expiresAt, remember } }
失敗: { success: false, error: { code, message } }
```

**notifier-gate は `{ ok: true }` 形で、これとは違う。**あちらを写すときに取り違えないこと。

**② 「無効」と「判定できない」を混ぜない**

`public/auth/session.js` は `SESSION_INVALID` を受け取るとトークンを消す。一方 HTTP が 2xx でなければ `NETWORK` として扱い、**トークンを残す**。

したがって:

| 状況 | 返すもの |
| --- | --- |
| GAS が無効と答えた | **200** + `SESSION_INVALID` |
| GAS へ届かない・応答が読めない・設定漏れ | **5xx**（`SESSION_INVALID` を返さない） |

ここを取り違えると、**GAS の障害のたびに全利用者のトークンが消える。**`tests/unit/auth-verify-cache.mjs` の「判定できないときに『無効』と答えない」の節がこれを固定している。

**③ GAS は HTML を返すことがある**

実行時例外や権限エラーのとき、GAS は JSON ではなく HTML のエラーページを返す。**これを「無効」と読み違えない。**notifier-gate が踏んだのと同じ罠。

**④ ログに本文を残さない**

リクエスト本文にはセッショントークンが入る。observability の設定で本文を残さないこと。

## 6. テスト

```
node tests/run.mjs auth-verify-cache
```

Workers ランタイムも Chrome も要らない。実時間も実通信も使わない（`now` と `fetchImpl` を差し替える）。

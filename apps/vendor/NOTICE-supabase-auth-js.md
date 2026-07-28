# 同梱ライブラリに関する表示 (NOTICE)

このディレクトリには、TSAM AI のログイン（Supabase Auth）のために
第三者ライブラリを同梱しています。本アプリのコードとは分離して配置しています。

## ライブラリ

- ライブラリ名        : Supabase Auth JS (GoTrue client)
- バージョン          : 2.110.8
- npmパッケージ名     : @supabase/auth-js
- 配布元 (npm)        : https://registry.npmjs.org/@supabase/auth-js/-/auth-js-2.110.8.tgz
- ソースリポジトリ    : https://github.com/supabase/supabase-js
- 原作者              : Supabase Inc. ほか貢献者
- ライセンス名        : MIT License
- ライセンス全文      : LICENSE-supabase-auth-js.txt

## 同梱ファイル

- ファイル            : supabase-auth-js-2.110.8.esm.js
- 形式                : ES Modules（単一ファイル。minify 済み）
- SHA-256             : 2b14251341a0d7be226ae24b740eb5f6d0ebe048743b187882812474263f90db
- サイズ              : 97,956 バイト

## なぜ CDN ではなく同梱するのか

ログイン画面で読み込むスクリプトを第三者のCDNに置くと、
そのCDNが改ざんされた場合に **入力されたパスワードを盗まれうる**。
ESM の `import` には Subresource Integrity（`integrity` 属性）を付けられないため、
CDN経由では改ざんを検知する手段がない。

同梱すれば、配信元はこのサイト自身だけになる。
`apps/knowledge/index.html` の CSP も `script-src 'self'` のまま変更しなくてよい。

既存の `apps/voice-recorder/vendor/lamejs.iife.js` と同じ方針である。

## なぜ supabase-js ではなく auth-js なのか

`@supabase/supabase-js`（フルSDK）は realtime / storage / postgrest / functions を
同梱するが、TSAM AI が使うのは認証だけである。
`@supabase/auth-js` は認証専用で、実行時依存も tslib のみ。
ログイン画面の読み込み量を最小にするためこちらを採用した。

将来 Supabase のデータベースを使う場合は、フルSDKへの差し替えを検討する。

## 再生成の手順

同梱ファイルは npm 配布物をそのままコピーしたものではなく、
`dist/module/` の複数ファイルを1つのESMへバンドルしたものである。
更新・検証は次の手順で再現できる（このリポジトリの外で実行すること）。

```sh
mkdir sbbuild && cd sbbuild
printf '{"name":"sbbuild","private":true,"type":"module"}' > package.json
npm install @supabase/auth-js@2.110.8 esbuild@0.25.12

cat > entry.mjs <<'EOF'
export { GoTrueClient, AuthError, isAuthApiError, isAuthError, AuthApiError, AuthRetryableFetchError } from '@supabase/auth-js';
EOF

./node_modules/.bin/esbuild entry.mjs \
  --bundle --format=esm --platform=browser --target=es2022 \
  --minify --legal-comments=none \
  --outfile=supabase-auth-js-2.110.8.esm.js

sha256sum supabase-auth-js-2.110.8.esm.js
```

出力の SHA-256 が上記と一致することを確認してから差し替える。

## 同梱物の確認結果

バンドル後のファイルに対して次を確認済み。

- Node.js 固有API（`process.` / `require(` / `__dirname` / `node:` 参照）が残っていない
- ハードコードされた外部ホストが存在しない
  （通信先は `apps/shared/supabase-config.js` で設定したプロジェクトURLのみ）

## 改変

内容の改変は行っていない。バンドル（複数ファイルの結合）と minify のみ。

## 更新時の注意

- バージョンを上げたら、このファイルの版・SHA-256・サイズを必ず更新する。
- ファイル名にバージョンを含めているため、更新時はファイル名も変わる。
  `apps/shared/supabase-client.js` の import 先を合わせて直すこと。
- `.gitattributes` に改行変換の除外設定がある。ファイル名を変えたら合わせて更新する。

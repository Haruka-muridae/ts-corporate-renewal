# apps/tests — 認証基盤のテスト

`/apps/` のログイン基盤（Phase 1〜3 と監査修正）を検証する。

**追加のnpmパッケージは使わない。** Node 標準機能と、
すでに入っている Chrome だけで動く。

---

## 実行方法

リポジトリのルートから実行する。

```sh
npm test              # 全部（Node + 実ブラウザ）
npm run test:unit     # Node のみ（Chrome 不要・速い）
npm run test:browser  # 実ブラウザのみ
npm run test:auth     # 認証まわりだけ
npm run test:audit    # 監査で追加した分だけ
```

`npm` を使わない場合。

```sh
node apps/tests/run.mjs
node apps/tests/run.mjs unit
node apps/tests/run.mjs browser
```

成功で終了コード 0、失敗で 1 を返す。

---

## 構成

```text
apps/tests/
  run.mjs                    実行役。スイートを子プロセスで動かし集計する
  helpers/
    assert.mjs               check / section / finish（結果行の出力）
    env.mjs                  Node 上でのブラウザ環境の再現
    fake-gotrue.mjs          偽の GoTrueClient
    static-server.mjs        静的配信（サブパス配信も再現）
    chrome.mjs               Chrome 起動と CDP 操作
    browser-harness.mjs      サーバー＋Chrome の起動と後片付け
  unit/                      Node で動くもの（Chrome 不要）
    shared.mjs               Phase 1 の共通基盤
    shared-dom.mjs           ストレージ・イベント経路
    auth.mjs                 ログイン・セッション・遷移判定
    supabase.mjs             Supabase プロバイダ
    paths.mjs                配信ベースパスと遷移先の検証
    audit.mjs                監査で追加した状態遷移の検査
  browser/                   実ブラウザで動くもの
    login-flow.mjs           ログイン〜ログアウトの一周
    phase3-screens.mjs       Phase 3 の画面
    audit.mjs                監査項目（偽装・bfcache・サブパス・隔離）
```

### スイートを別プロセスで動かす理由

各スイートは `globalThis`（localStorage / document / location）を
差し替え、モジュールの内部状態にも触れる。

1つのプロセスでまとめて読み込むと前のスイートの状態が次へ漏れ、
結果が実行順に依存する。子プロセスへ分けることで、
順番を入れ替えても同じ結果になる。

---

## Chrome の場所

自動で探す。見つからない場合は環境変数で指定する。

```sh
# Windows (PowerShell)
$env:CHROME_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"

# macOS / Linux
export CHROME_PATH=/usr/bin/google-chrome
```

Edge でも動く（Chromium系のため）。

---

## ポート

既定は HTTP `5311`〜、CDP `9411`〜（スイートごとに +1）。
衝突する場合は環境変数で変えられる。

```sh
TEST_PORT=6311 TEST_CDP_PORT=9611 npm test
```

「ポートが使用中」で失敗した場合、前回のテストが残っている可能性がある。

```powershell
netstat -ano | findstr :5311
```

---

## GitHub Pages のサブパス配信

同じサーバーが次の両方を受け付ける。

```text
http://127.0.0.1:5313/apps/login/                        独自ドメイン相当
http://127.0.0.1:5313/ts-corporate-renewal/apps/login/   プロジェクトPages相当
```

シンボリックリンクやファイル複製を作らずにサブパスを検証できる。

**注意**: 同じオリジンのため localStorage が共有される。
本番では別ドメインになるので、サブパスの検証に入る前に
明示的にストレージを消している。

---

## このテストで確認できないこと

すべて **偽のGoTrueクライアント** に対する検証である。
**実際の Supabase とは一度も通信していない。**

したがって次は確認できていない。

- Supabase が実際に返すエラーコードの綴り
- TOTP の QR 形式と共有鍵の文字種
- メールの到達とリンクのリダイレクト
- PKCE の code verifier の実挙動
- レート制限の実挙動

**「テストが通った＝安全」ではない。**
実接続で確認する項目は `apps/SUPABASE_CONNECTION_TEST.md` にまとめてある。

---

## 後片付け

テストは終了時に次を片付ける。

- Chrome プロセス（例外で落ちた場合も、プロセス終了フックで kill する）
- Chrome の一時プロファイル（`%TEMP%/tsam-chrome-*`）
- HTTP サーバー

`Ctrl+C` で中断した場合も片付ける。

残ってしまった場合は次で確認する。

```powershell
tasklist | findstr chrome
dir %TEMP%\tsam-chrome-*
```

---

## 同梱SDKの更新確認

認証ライブラリは自己ホストのため、Dependabot 等が追跡できない。

```sh
npm run check:vendor
```

版・SHA-256・NOTICE との整合・npm の最新版を表示する。
**確認だけで、自動更新はしない。**

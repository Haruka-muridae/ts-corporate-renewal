# apps/tests — 認証基盤のテスト

`/apps/` のログイン基盤（Phase 1〜3 と監査修正）を検証する。

**追加のnpmパッケージは使わない。** Node 標準機能と、
すでに入っている Chrome だけで動く。

---

## 必要なもの

| | 要件 |
|---|---|
| Node.js | **22.4 以上**（`package.json` の `engines` と一致。開発と CI は 24） |
| Chrome | Chrome または Chromium。Edge でも動く |

`helpers/chrome.mjs` は DevTools Protocol を叩くのに
グローバルの `WebSocket` を使う。これが下限を決めている。

| Node | グローバル `WebSocket` |
|---|---|
| 20.10 / 21.0 | `--experimental-websocket` を付ければ使える |
| **22.0** | **フラグ無しで使える** |
| **22.4** | **実験的でなくなる** |

出典: https://nodejs.org/api/globals.html#websocket （確認日 2026-07-28）

フラグ無しで動くのは 22.0 からだが、下限は **22.4** とする。
テストの土台が実験的APIのままでは、仕様が変わったときに
原因の分かりにくい壊れ方をするため。

Node 20 でも `npm run test:unit`（Chrome 不要）は動く。

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
node apps/tests/run.mjs runner   # 実行役自身の検査
```

成功で終了コード 0、失敗で 1 を返す。

**同時に2つ走らせないこと。** ポートを固定しているため互いに邪魔をする。

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

## タイムアウト

スイート1本ごとに上限がある。上限を超えると、そのスイートを
**プロセスツリーごと**終了して次へ進み、終了コード 1 で終わる。

| 対象 | 既定 | 環境変数 |
|---|---|---|
| Node のスイート | 120秒 | `TEST_TIMEOUT_UNIT_MS` |
| ブラウザのスイート | 300秒 | `TEST_TIMEOUT_BROWSER_MS` |
| 結果出力後の猶予 | 10秒 | `TEST_EXIT_GRACE_MS` |

```sh
# 遅い環境で伸ばす
TEST_TIMEOUT_BROWSER_MS=600000 npm test

# 打ち切りの挙動を確かめる（わざと落とす）
TEST_TIMEOUT_BROWSER_MS=3000 node apps/tests/run.mjs browser
```

### 「結果出力後の猶予」とは

スイートは `finish()` で `process.exit()` を呼ばず、自然終了に任せている
（Windows で内部ハンドルの警告が出るため）。

この作りでは、ハンドルが1つでも閉じ残るとプロセスが永久に終わらない。
そこで、結果を出したあと一定時間たっても終われない場合は強制終了する。

保険は `unref()` したタイマーで実装してあるため、
**正常に終われる場合は一度も発火しない。**

---

## 詰まったときの調べ方

```powershell
# Windows
tasklist | findstr chrome
netstat -ano | findstr :5313
dir %TEMP%\tsam-chrome-*
```

```sh
# macOS / Linux
pgrep -a -f 'chrome|chromium'
ss -ltnp | grep -E ':(53[0-9]{2}|94[0-9]{2})'
ls -d /tmp/tsam-chrome-*
```

**利用者が普段使っている Chrome を止めないこと。**
テストが起動したものは `--headless` と `tsam-chrome-` を含む。

前回の一時プロファイルは、次に `npm test` を実行したとき
**開始時に自動で片付ける**（タイムアウトで打ち切られた場合、
SIGKILL は捕まえられないため終了フックが動かない）。

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

## GitHub Actions

`.github/workflows/test.yml` が次のときに `npm test` を走らせる。

```text
Pull Request を出したとき
main へ push したとき
手動実行（workflow_dispatch）
```

| 項目 | 値 |
|---|---|
| 実行環境 | `ubuntu-latest` |
| Node | 24 |
| Chrome | `google-chrome` などを検出し `CHROME_PATH` へ設定。無ければ失敗 |
| 権限 | `contents: read` のみ |
| 上限 | 20分 |
| 同時実行 | 同じブランチの古い実行は取り消す |

### CI が触らないもの

**secrets を一切使わない。**

```text
Supabase へ接続しない（設定はプレースホルダーのまま）
Google OAuth の設定を読まない
Google Drive の認可を求めない
Workspace 紹介リンクへアクセスしない
外部へデプロイしない
```

通信するのは、テストが自分で立てる `127.0.0.1` の HTTP サーバーと、
Chrome の DevTools Protocol（ローカル）だけである。

ブラウザテストは CDP で外部ホストを遮断してから画面を開く。

---

## 実行役自身の検査

`unit/runner.mjs` が、実行役の後始末を検査する。

```text
正常終了・非ゼロ終了・タイムアウト
タイムアウト時に子と孫（Chrome 相当）が残らないこと
孫が掴んだポートが解放されること
起動に失敗しても固まらないこと
後始末を二重に呼んでも壊れないこと
一時プロファイルの掃除
Windows と POSIX の終了方法の違い
```

タイムアウトの検査には短い上限（1〜3秒）を渡すため、
待ち時間は数秒で済む。

---

## 同梱SDKの更新確認

認証ライブラリは自己ホストのため、Dependabot 等が追跡できない。

```sh
npm run check:vendor
```

版・SHA-256・NOTICE との整合・npm の最新版を表示する。
**確認だけで、自動更新はしない。**

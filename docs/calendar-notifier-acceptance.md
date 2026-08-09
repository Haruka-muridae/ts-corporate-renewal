# ブラウザ録音アプリ｜カレンダー通知 受け入れ検証の記録

検証日: **2026年8月9日**

対象機能: ブラウザ録音アプリ（`public/production-app/voice-recorder/`）の
Googleカレンダー通知（[gas-notifier/](../gas-notifier/) と Service Worker）。

| | |
| --- | --- |
| 対象要件 | `recording_calendar_requirements.docx` v1.0（AC-01〜09 / NFR-03） |
| 手順書 | [calendar-notifier-setup.md](./calendar-notifier-setup.md) |
| 運営者向け構成 | [gas-notifier/README.md](../gas-notifier/README.md) |
| 自動テスト | `tests/unit/voice-recorder-notifier.mjs`（220件）ほか。`npm test` 合計 3602件 |

---

## 検証環境

| | |
| --- | --- |
| OS | Windows 11 |
| ブラウザ | Google Chrome 151.0.7922.109 |
| 配信 | **`http://localhost:3000`（`npm run dev`）** |
| GAS | 利用者アカウントのテンプレートシートのコピー（実物） |
| カレンダー | 利用者アカウントの実カレンダー（検証A〜J2 の予定を作成） |

> **配信はローカルの開発サーバーである。** Push・Service Worker・GAS はいずれも
> 実物を使っており「モックで通した」検証ではないが、
> **本番（Cloudflare Workers）での配信確認は別に必要**である。
> 手順は [deployment-cloudflare.md](./deployment-cloudflare.md) §5
> （`sw.js` と `manifest.webmanifest` の Content-Type 確認）。§末尾の「残っている確認」も参照。

---

## 結果

すべて合格（✓）。

| 項目 | 結果 | 備考 |
|---|---|---|
| AC-01 参加予定(accepted)の通知 | ✓ | 検証A、12:56着信（5分前設定、ジッタ範囲内） |
| AC-02 辞退(declined)は通知しない | ✓ | 検証B、不着信＋`sent_log`に行なし |
| AC-03 未回答(needsAction)の通知 | ✓ | 検証C |
| AC-04 終日予定は通知しない | ✓ | 検証D、不着信＋`sent_log`に行なし |
| AC-05 通知内容(予定名+開始時刻+定型文) | ✓ | 「13:00から開始します。録音しますか？」時刻一致をスクリーンショットで確認 |
| AC-06 クリックで録音画面へ遷移 | ✓ | タブあり＝既存タブへフォーカス（検証C）、タブなし＝新タブで `/production-app/voice-recorder/?eventId=` を確認 |
| AC-07 録音が自動開始しない | ✓ | 遷移後に停止状態・マイク非使用を目視 |
| AC-08 同一予定の重複通知なし | ✓ | 2回目不着信＋`sent_log`各1行 |
| AC-09 設定変更が次回判定から反映 | ✓ | 未回答OFF保存後の新規招待が不着信 |
| ログイン経由のeventId復元(`1d91fb7`) | ✓ | ログアウト状態で通知クリック→ログイン→「対象: 検証J2」表示を確認 |
| NFR-03 ブラウザ非起動での受信 | ✓ | アプリのタブ非起動で受信を確認。**ブラウザプロセス完全終了時はデスクトップWeb Push共通の制約**（手順書 [§9](./calendar-notifier-setup.md) 参照） |
| セットアップ通し+接続テスト5項目 | ✓ | 初回ユーザーフローを通しで実施、スクリーンショット保存 |

### 補足

- **AC-02 / AC-04 は「不着信」だけで判定していない。** 通知が出ないことは、
  仕組みが動いていない場合と区別がつかない。`sent_log` に行が無いことを
  あわせて確認しており、「判定で除外された」ことまで見ている。
- **AC-08 も同様に `sent_log` の行数で見ている。** 2回目が届かないことと、
  記録が1行のままであることの両方を確認した。
- **NFR-03 の「非起動」はアプリのタブについてである。** ブラウザのプロセスまで
  終了させた場合は、`TTL: 300` 秒（通知予定時刻から5分以内）に復帰したときだけ届く。
  これはデスクトップ Web Push 共通の制約で、本機能の不具合ではない。
  意図と運用上の回避策は手順書 §9 に記載した。
- **ログイン経由の eventId 復元**は、この検証で見つかった不具合の修正
  （`1d91fb7`）に対する再確認である。修正前は、未ログインで通知を開くと
  ログイン後に Portal へ着き、どの予定の通知だったのかが失われていた。

---

## この検証で見つかり、修正したもの

| # | 事象 | 対応 |
|---|---|---|
| 1 | セットアップウィザードのサイドバーが開かず `Ui.showSidebar` の権限エラー | `appsscript.json` へ `script.container.ui` を追加（`a8b343e`）。`oauthScopes` を明示すると自動スコープ判定が無効になるため、UI権限も列挙が要る |
| 2 | 未ログインで通知をクリックすると、ログイン後に `?eventId=` が失われる | 画面ごとの許可パラメータ方式で復元（`1d91fb7`）。仕様は [login-page-detailed-spec-v3.md](./specs/login-page-detailed-spec-v3.md) §6 |

---

## 残っている確認

この記録の範囲外。**本番デプロイ後に実施すること。**

- [ ] `https://tsam-ai.com/production-app/voice-recorder/sw.js`
      が 200 かつ `application/javascript`
- [ ] `https://tsam-ai.com/production-app/voice-recorder/manifest.webmanifest`
      が 200 かつ `application/manifest+json`
- [ ] devtools → Application → Service Workers に
      `/production-app/voice-recorder/` スコープで activated
- [ ] 本番オリジンで通知を1件受信（Push の購読は**オリジンごと**に作られるため、
      localhost の購読はそのまま使えない。利用者は本番URLで接続テストをやり直す）

手順は [deployment-cloudflare.md](./deployment-cloudflare.md) §5。

> **オリジンが変わると購読は作り直しになる。** localhost で登録した Push 購読は
> 本番では使えない。本番公開後、利用者には録音アプリの「接続テスト」を
> もう一度押してもらう（同じ接続コードのまま、この端末の登録だけが作り直される）。

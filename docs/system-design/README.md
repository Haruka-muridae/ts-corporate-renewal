# system-design 索引

制定: 2026年8月18日

このリポジトリに同居する各アプリの**要件定義書〜詳細設計書**。他のプロダクトへ組み込む・移植することを想定した読者向けに、アプリごとに次の4文書を揃えている（章立てと執筆ルールは [_authoring-guide.md](./_authoring-guide.md)）。

1. `01_requirements.md` — 要件定義書（FR/NFR 付番）
2. `02_basic-design.md` — 基本設計書（構成図・設計判断）
3. `03_detailed-design.md` — 詳細設計書（処理フロー・データモデル・IF仕様）
4. `04_integration-guide.md` — 他プロダクトへの組み込みガイド

`docs/specs/` の既存仕様書と実装が引き続き**正**であり、本ディレクトリはそれらを置き換えない。食い違いを見つけた場合は本文書群のほうを疑い、実装・既存仕様書に揃えて直す。

## アプリ一覧

| アプリ | 実体 | 概要 |
| --- | --- | --- |
| [event-app](./event-app/) 交流会申込 | `app/event/` `lib/event/` `supabase/` | Next.js。申込・Stripe決済・Webhook・管理画面。Supabase（service role 経由のみ） |
| [auth-portal](./auth-portal/) 本番認証系 | `public/login/` ほか + `public/auth/` + `gas-auth/` | TSAM AI のログイン・Portal・料金/同意・パスワード・決済連携。Apps Script + スプレッドシート |
| [notifier-v2](./notifier-v2/) カレンダー通知 | `gas-notifier/` + `workers/notifier-gate/` | 配布用 Apps Script テンプレート + Cloudflare Workers のライセンスゲート |
| [receipt-ocr](./receipt-ocr/) 領収書OCR | `public/production-app/receipt-ocr/` | ブラウザ完結。Drive/Sheets + Gemini による領収書の読取・台帳記帳 |
| [card-ocr](./card-ocr/) 名刺OCR | `public/production-app/card-ocr/` | ブラウザ完結。名刺画像の読取・台帳「名刺管理」への登録 |
| [card-mail](./card-mail/) 名刺メール配信 | `public/production-app/card-mail/` | ブラウザ完結。台帳から宛先を読み利用者自身の Gmail から BCC 一斉送信 |
| [voice-recorder](./voice-recorder/) ブラウザ録音 | `public/production-app/voice-recorder/` | バックエンドなしの長時間録音。Drive への逐次保存 |
| [audio-transcriber](./audio-transcriber/) 音声文字起こし | `public/production-app/audio-transcriber/` | voice-recorder の保存フォルダを読み、Gemini で文字起こし |
| [short-script](./short-script/) 台本生成 | `public/production-app/short-script/` | 台本生成 + Companion 経由の音声・動画生成連携 |
| [meeting-minutes](./meeting-minutes/) AI議事録 | `public/production-app/meeting-minutes/` | 文字起こしを Gemini で議事録化。audio-transcriber からの引継ぎ、Drive への保存 |
| [calendar-url-notifier](./calendar-url-notifier/) カレンダーURL通知 | `public/production-app/calendar-url-notifier/` + `gas-notifier/` | カレンダー予定の URL を開く通知。notifier 基盤（gas-notifier + notifier-gate）を共用 |
| [note-post](./note-post/) note 下書き | `public/production-app/note-post/` | Gemini で note 記事の下書きを生成し 2 段階コピーで投稿支援 |
| [threads-post](./threads-post/) Threads 投稿 | `public/production-app/threads-post/` | Gemini で Threads 投稿文を生成し intent リンクで投稿 |
| [x-post](./x-post/) X 投稿 | `public/production-app/x-post/` | Gemini で X 投稿文を生成し intent リンクで投稿（threads-post からの複製系） |

## 読み方

- 移植・組み込みが目的なら、まず対象アプリの `04_integration-guide.md` から読む。依存関係マップと切り離しポイントがそこにある。
- 本番アプリ（`public/production-app/` 配下）同士は**共通層を作らず複製する**方針（[../repository-structure.md](../repository-structure.md) §4）。組み込み時も同じ考え方に従い、複製元の既知の不具合を持ち込まない。
- 各 `01_requirements.md` §9 の「未確定事項」は、コード・既存文書から確認できなかった運用状態（OAuth 審査状況、受け入れ検証の完了範囲など）を推測で埋めずに残したもの。組み込み前に発注者側で確認すること。

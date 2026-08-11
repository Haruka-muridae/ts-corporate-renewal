# Threads 投稿 MVP（gas-threads/）【旧版・デプロイしない】

> **2026-08-12: このディレクトリは旧版（v2.x・自分専用 GAS アプリ）の保管。**
> 現行の実装は Portal 掲載の
> [public/production-app/threads-post/](../public/production-app/threads-post/)（v3.0）。
> ここを残しているのは、予約リマインダーを**全く別機能**として作るときの
> 下敷きにするため（要件書 §9）。テスト（threads-mvp スイート）は
> 下敷きが壊れていないことの確認として維持している。

下書き保存・AI での投稿文生成・intent リンクでの投稿・予約リマインダー・
履歴記録だけの単機能 GAS アプリ。
要件は [docs/specs/threads-mvp-requirements-v1.md](../docs/specs/threads-mvp-requirements-v1.md)（実装の正。v2.2）。

**Threads の API・トークンは使わない。** 「Threads で投稿」は本文入りの
投稿画面（intent リンク）を開くだけで、最後の「投稿」ボタンは人が押す。
予約は、時刻になると本文と投稿リンク入りのメールが自分に届く。

このディレクトリは**配信されないソース**。gas-auth と同じく、
Apps Script エディタへ貼り付けて使う。

## 導入手順

1. 新しいスプレッドシートを作り、拡張機能 → Apps Script を開く
   （コンテナバインド。既存の一想のシート・プロジェクトは使わない）。
2. このディレクトリの `.gs` と `index.html` を同名で貼り付け、
   `appsscript.json`（プロジェクトの設定 → マニフェストを表示）も合わせる。
3. エディタから `setupThreadsMvp()` を1回実行する
   （シート3枚と5分ポーリングのトリガーが整う。何度実行しても増殖しない）。
4. Web アプリとしてデプロイする。**実行=自分／アクセス=自分のみ。**
5. （任意）「AIで生成」を使う場合のみ、Google AI Studio で API キーを取得し、
   Script Properties に `GEMINI_API_KEY` として設定する。モデルを変えたい
   ときは `GEMINI_MODEL`（既定 `gemini-2.0-flash`）。未設定でも生成以外は動く。

Meta（Threads）側の開発者登録・審査・トークン取得は**不要**。

シート（「下書き」「予約」「履歴」）は手動で作らない。
実行時に自動生成され、既存でヘッダーが一致すればそのまま使い、
不一致なら書き込まずに止まる（要件 §3.2）。

## 更新時の注意（gas-auth と同じ）

エディタで保存しただけでは公開中の Web アプリに反映されない。
「デプロイを管理」から既存デプロイを新バージョンへ更新する
（新規デプロイを作ると `/exec` URL が変わる）。

## テスト

```powershell
node tests/run.mjs threads-mvp
```

Node 上の偽 Apps Script 環境（[tests/helpers/gas-threads-harness.mjs](../tests/helpers/gas-threads-harness.mjs)）で
動かすため、Chrome も本物のシートも不要。

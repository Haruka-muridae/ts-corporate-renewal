# Potenitas Codex実装ガイド

**Version:** 1.0.0  
**Status:** Approved  
**Last Updated:** 2026-07-22

## 1. Codexの役割

Codexは、承認済み仕様を実装・検証します。未確定の事業情報、法務条件、実績、人物情報、URLを推測しません。コピーや9ブロックを改善目的で変更しません。

## 2. 作業開始時に読む順序

1. リポジトリの`AGENTS.md`
2. LP要件定義書
3. 本ディレクトリの`README.md`
4. 作業対象の責務別仕様書
5. 現在のコードとテスト

矛盾時は作業を止め、ファイル名、該当箇所、選択肢を報告します。

## 3. 絶対に守ること

- H1は`AIの正解は、誰も教えてくれない。`
- `可能性は、証明できる。`は第4ブロック
- 9ブロックの順序を変えない
- 実績と料金を折りたたまない
- 3料金枠を同格表示
- CTAは`相談する（無料）`
- 架空のレビュー、企業、人数、資格、URLを追加しない
- `AIスクール`、割引・限定・煽り表現を追加しない
- 個人情報をGA4へ送らない
- 本番URL未確定時はTODOまたはビルドエラーにする

## 4. 段階実装

### Phase 0: 監査

- 現在のファイル、Git状態、既存変更を確認
- 要件とコードの差分を報告
- 変更予定ファイルと検証手順を提示
- この段階では編集しない

### Phase 1: 基盤

- Next.js、TypeScript、Tailwind、静的export
- 環境変数検証
- lint、typecheck、test、build
- Cloudflare Pages設定

完了条件: 空の基盤が`out`へ静的生成される。

### Phase 2: コンテンツ構造

- 9ブロックをセマンティックHTMLで実装
- 確定コピーを同期
- アコーディオン、料金、フォームの見た目と操作

完了条件: JSがなくても主要本文を読める。

### Phase 3: メタデータ・構造化データ

- title、description、canonical、OGP
- robots、sitemap
- Organization、WebSite、WebPage、Service

完了条件: 本番URL以外の仮値がなく、検証ツールでエラーがない。

### Phase 4: フォーム・計測

- GAS送信
- 入力検証、失敗・成功状態
- GA4イベント
- `/thanks/` noindex

完了条件: 成功時だけ保存・通知・`generate_lead`が発生し、個人情報をGA4へ送らない。

### Phase 5: 品質

- アクセシビリティ
- レスポンシブ
- Core Web Vitals改善
- セキュリティヘッダー
- E2E、視覚確認

完了条件: `16_Testing_Specification.md`の公開必須項目を満たす。

## 5. 変更の単位

- 1フェーズをさらにレビュー可能な小さな変更へ分ける
- 1コミット1目的
- 無関係な整形・依存更新を混ぜない
- ユーザーの既存変更を上書きしない
- 削除、移行、依存追加は事前に理由を示す

推奨コミット例:

```text
chore: scaffold static Next.js site
feat: implement fixed LP content structure
feat: add metadata and structured data
feat: connect consultation form
test: add SEO and accessibility checks
```

## 6. 実装時の停止条件

次の場合は推測せず停止します。

- LP要件定義書を読めない
- 確定コピーに複数版がある
- 本番ドメイン、法人URL、連絡先が必要だが未確定
- 法務文書とLPの条件が違う
- GASエンドポイントの仕様が不明
- 既存の未コミット変更と衝突
- 静的exportで要求機能を実現できない

## 7. 実装報告の形式

```text
結果
- 完了した内容

変更ファイル
- path: 変更理由

検証
- 実行コマンドと結果
- 手動確認項目

未確定・未実施
- TODOと理由

次の安全な作業
- 1件だけ提示
```

## 8. Codexに渡す初回プロンプト

```text
Potenitas LPを実装します。

最初にAGENTS.md、LP要件定義書、docs/README.md、
docs/17_Codex_Implementation_Guide.mdを読み、現在のコードとGit状態を確認してください。

今回はPhase 0の監査だけを行ってください。
ファイルは変更せず、次を報告してください。

1. 現在の技術構成
2. 仕様とコードの差分
3. 未確定値
4. Phase 1で変更するファイル
5. 検証コマンド

確定コピー、9ブロック、料金、契約条件を推測または改変しないでください。
```

## 9. レビュー観点

- 正確性: 要件と一致するか
- 可逆性: 小さく戻せるか
- 静的互換: Cloudflare Pagesで動くか
- 可読性: HTMLで意味が伝わるか
- 非捏造: 未確定値を埋めていないか
- 品質: テストと手動確認があるか

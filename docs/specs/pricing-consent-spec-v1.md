# TSAM AI — 料金プラン・同意画面 詳細定義書(v1)

対象: `/pricing/index.html` + `pricing/pricing.js` + `gas-auth/Consent.gs` + `/legal/` 3ページ
位置づけ: 実装と突き合わせる確定仕様。本書と実装が食い違う場合は、本書を修正するか実装を直すかを必ず判断し、黙って乖離させないこと。
参照は「ファイル名・関数名・定数名」で行い、行番号は用いない。

関連: [login-page-detailed-spec-v3.md](./login-page-detailed-spec-v3.md)（ログイン画面。API 契約の基本形はそちら）

---

## 1. 画面の責務

- プランを選び、契約条件を確認し、同意したうえで Stripe Checkout へ進む導線を提供する
- **本質要件: 特定商取引法が最終確認画面に求める事項を、申込みボタンの直前で確認できる状態にする**
  - 価格 / 自動更新 / 支払時期 / 契約期間 / 解約方法 / 返金条件 / API料金が別途発生すること
- 到達経路: `/login/` の「サービスを申し込む」／直接アクセス。認証不要
- 離脱経路: Stripe Checkout（外部）／`/login/` へ戻る／`/legal/` 各ページ（別タブ）

---

## 2. 画面構成(上から順)

| # | 要素 | 仕様 |
|---|------|------|
| 1 | ロゴ | リンクはトップ(相対パス解決) |
| 2 | 見出し(h1) | 「料金プランの選択」 |
| 3 | 導入文 | 決済後にパスワード設定案内が届くことを明示 |
| 4 | メッセージ領域 | エラー `role="alert"` / 案内 `role="status"`。初期は空 |
| 5 | 読み込み中表示 | プラン取得中に表示。取得完了で消す |
| 6 | プラン一覧 | サーバー取得。**HTMLへ料金を直書きしない** |
| 7 | お申し込みの条件 | 静的な補足説明(支払周期・自動更新・解約・支払方法・ログインID) |
| 8 | **契約条件の確認と同意** | プラン選択まで `hidden`。§3 |
| 9 | リンク群 | ログインへ戻る / 利用規約 / プライバシーポリシー / 特定商取引法に基づく表記 |

### 禁止事項

- 料金・プラン名・同意文言・確認表の**ハードコード**（すべてサーバー取得）
- Stripe Price ID をフロントへ渡すこと・HTMLへ埋め込むこと
- 「準備中」の非リンク表示（/legal/ 公開により解消済み）

---

## 3. 同意セクション(id="pricing-consent")

プラン選択後に `hidden` を外して表示する。**別ページへは遷移しない**（1ページ2段構成）。

| # | 要素 | id | 仕様 |
|---|------|-----|------|
| 1 | 選択中プラン | `pricing-consent-selected` | プラン名・金額・支払周期 |
| 2 | 赤枠警告 | `pricing-consent-warning` | settings の `CONSENT_WARNING_TEXT`。空なら非表示。色だけに頼らず見出し語「ご確認ください」を添える |
| 3 | 契約条件の確認表 | `pricing-consent-sections` | `confirm_sections` をセクション見出しごとの表として描画 |
| 4 | 同意チェック | `pricing-consent-items` | `consent_items` をチェックボックスとして描画 |
| 5 | メッセージ領域 | `pricing-consent-message` | 未チェック時のエラー等 |
| 6 | 決済へ進むボタン | `pricing-consent-submit` | `required` 全チェックまで `disabled` |
| 7 | 選び直すボタン | `pricing-consent-back` | セクションを隠し、プラン一覧へ戻る |

### 差し込み記法

`consent_items.label` に含まれる `{terms}` `{privacy}` `{tokusho}` を、リンク要素へ展開する（`pricing.js:renderLabelInto`）。

| 記法 | 展開先 | 表示文字列 |
|------|--------|-----------|
| `{terms}` | `legal/terms/` | 利用規約 |
| `{privacy}` | `legal/privacy/` | プライバシーポリシー |
| `{tokusho}` | `legal/tokusho/` | 特定商取引法に基づく表記 |

`target="_blank"` + `rel="noopener"`。**理由: 申込みの途中で離脱させないため。**

**展開は textContent とリンク要素の組み立てで行い、innerHTML を使わない。** 設定シートの文言にマークアップが混ざっても実行されない構造を保つこと。

### 状態遷移

| 状態 | 表示 | 備考 |
|------|------|------|
| 初期 | 同意セクション `hidden` | プラン未選択 |
| プラン選択後 | セクション表示・全チェック解除・ボタン `disabled` | 選び直しても毎回リセット |
| 必須一部チェック | ボタン `disabled` のまま | 任意項目では代替できない |
| 必須全チェック | ボタン有効 | |
| 送信中 | `disabled` + 文言変更 + `aria-busy` + `checkoutInFlight` | プラン選択ボタンも無効化 |
| 送信失敗 | エラー文言 + ボタン復帰 | |

### アクセシビリティ

- 各チェックボックスに `label`（`htmlFor` で結び付け）
- 必須項目には「（必須）」を表示（色だけに頼らない）
- 未チェックで送信した場合、`role="alert"` のメッセージ + 該当項目へ `aria-invalid` とフォーカス
- 強調値は `data-emphasis="true"` で色と太字の両方を当てる

---

## 4. API契約(実装確定値)

### 4.1 listConsentConfig (GET・認証不要)

```
GET {apiUrl}?action=listConsentConfig
```

```json
{
  "success": true,
  "data": {
    "tosVersion": "1.0",
    "warningText": "本サービスは月額550円（税込）の1か月単位の…",
    "consentItems": [
      { "itemId": "tos", "label": "{terms}および{privacy}に同意します。", "required": true, "sortOrder": 1 }
    ],
    "confirmSections": [
      { "section": "料金と支払い", "items": [
        { "label": "月額料金", "value": "550円（税込）", "emphasis": true }
      ] }
    ]
  }
}
```

- `enabled = FALSE` の項目は返さない
- `sort_order` の昇順で返す
- `confirmSections` はセクション名の初出順にまとめる
- **秘密情報を含まない**（Price ID・鍵・ID の類は一切返さない）

### 4.2 createCheckoutSession (POST)

**リクエストに `agreedItems` と `tosVersion` を必須で追加した。**

```json
{
  "action": "createCheckoutSession",
  "planCode": "standard",
  "agreedItems": ["tos", "auto_renew", "api_cost", "cancel_policy"],
  "tosVersion": "1.0",
  "userAgent": "…"
}
```

`email` は任意（従来どおり）。

### 4.3 同意の検証(サーバー側・Consent.gs:verifyConsent_)

次のいずれかに当たる場合、`INVALID_REQUEST` で拒否する。**プランの解決より後、Stripe API 呼び出しより前に行う。**

| 条件 | 内部理由(ログのみ) |
|------|------------------|
| `agreedItems` が配列でない・存在しない | `AGREED_ITEMS_MISSING` |
| `tosVersion` が空 | `TOS_VERSION_MISSING` |
| `tosVersion` が現行 `TOS_VERSION` と不一致 | `TOS_VERSION_MISMATCH` |
| `required` な `item_id` が1つでも欠ける | `REQUIRED_NOT_AGREED:<item_id>` |

- 画面へ返すのは定型文「リクエストの形式が不正です。」のみ。**内部理由は `system_error_logs` にだけ残す**
- 余分な項目が混ざっていても、必須が揃っていれば通す（重複も無視）
- **理由: フロントのチェックボックスは開発者ツールで外せる。サーバー側で確かめなければ同意なしで決済へ進める。**

### 4.4 Checkout Session の metadata

同意の記録を決済側にも残す（`Consent.gs:buildConsentMetadata_`）。

| キー | 内容 |
|------|------|
| `plan_code` | プランコード（従来どおり） |
| `tos_version` | 同意時点の規約版 |
| `tos_agreed_at` | 同意日時(ISO 8601 UTC) |
| `agreed_items` | 同意項目をカンマ区切り（480文字で切り詰め） |

**理由: 後日「同意していない」と言われたとき、こちらのシートだけでなく Stripe 側の記録でも確認できるようにする。**

---

## 5. データ管理(認証設定スプレッドシート)

### consent_items シート

| 列 | 項目 | 内容 |
|---|------|------|
| A | `item_id` | 一意ID。検証のキーになるため変更に注意 |
| B | `label` | 表示文言。`{terms}` 等を差し込み可能 |
| C | `required` | TRUE でチェック必須 |
| D | `sort_order` | 表示順 |
| E | `enabled` | FALSE で非表示かつ検証対象外 |

### confirm_sections シート

| 列 | 項目 | 内容 |
|---|------|------|
| A | `section` | 見出し（同名でまとまる） |
| B | `item_label` | 項目名 |
| C | `item_value` | 内容 |
| D | `emphasis` | TRUE で赤字強調 |
| E | `sort_order` | 表示順 |

### settings シートの追加キー

| キー | 既定値 | 内容 |
|------|--------|------|
| `TOS_VERSION` | `1.0` | 同意を取得した規約の版。**改訂したら上げる**（古い版の同意は無効になる） |
| `CONSENT_WARNING_TEXT` | 月額550円…の警告文 | 赤枠に出す文言 |

### 初期データ(Setup.gs)

`setupAuthSystem()` が `ensureConsentItems_` / `ensureConfirmSections_` で投入する。

- **既存行がある場合は何もしない。** 運用側が編集した文言を上書きしない
- 同意項目 4件（`tos` / `auto_renew` / `api_cost` / `cancel_policy`、すべて `required`）
- 確認表 11行（料金と支払い / 契約期間と自動更新 / API利用料 / 解約）

---

## 6. 法務ページ(/legal/)

| パス | 内容 | 初期移行の原本 |
|------|------|------|
| `/legal/terms/` | 利用規約（全23条） | `docs/legal-source/legal-terms-v1.0.md` |
| `/legal/privacy/` | プライバシーポリシー（全16節） | `docs/legal-source/legal-privacy-v1.0.md` |
| `/legal/tokusho/` | 特定商取引法に基づく表記 | `docs/legal-source/legal-tokusho-v1.0.md` |

> **2026年7月31日以降、この3ページは生成物です。**
> 条文の正本はスプレッドシート「TSAM AI 法務文書」であり、
> `legal/*/index.html` を手で編集してはいけません。
> 生成と公開の仕組みは [legal-cms-spec-v1.md](./legal-cms-spec-v1.md) を参照してください。
> 上表の md は初期移行の原本（アーカイブ）です。
>
> 規約を改訂したときは `TOS_VERSION`（§5）も上げること。
> `publishLegalDocs()` が版の変化を検知して警告を出します。

- 静的HTML。`auth.css` の共通スタイルに準拠（白基調・読みやすい本文幅・スマホ優先）
- 各ページ冒頭に「2026年7月30日 制定 ／ Version 1.0」を表示
- 特商法の表は 320px では見出しと内容を積み上げ、768px 以上で2列にする

### 公開ページに含めないもの

| 対象 | 扱い |
|------|------|
| 「法務確認コメント」ブロック（計13件） | `docs/legal-review-notes.md` へ抽出して保存 |
| 冒頭の「重要：本書は法務草案…弁護士による確認を推奨」の枠 | 同上 |
| 末尾の「要確認リスト」「参考法令・公的資料」 | 公開せず、原稿 md にのみ残す |

**削除ではなく抽出。** 弁護士確認時のチェックリストとして使うため。

### インボイス欄

特商法の「支払方法」行の直後に2行を追加した（原稿 md にも反映済み）。

| 項目 | 内容 |
|------|------|
| 適格請求書発行事業者登録番号 | T3021003007473 |
| 請求書・領収書 | Stripe の領収書メールをもって代える。個別発行が必要な場合は問い合わせ窓口へ |

---

## 7. 解約方式(変更禁止)

**期間満了方式。** 解約後、支払済み期間の終了日まで利用可能（`cancel_at_period_end` 相当）。

法務文書3点すべてこの方式で統一済み。**即時停止方式にしないこと。**

- 利用規約 第5条第2項
- 特商法「解約後の利用」
- `confirm_sections` の「解約後の利用」行

---

## 8. 受け入れテスト(Done条件)

サーバー側（`tests/unit/consent.mjs`）:
- [ ] `listConsentConfig` の応答形状 / `enabled=FALSE` の除外 / `sort_order` 順
- [ ] `required` 欠落・`tosVersion` 不一致・配列でない・空配列で拒否
- [ ] 拒否理由が画面へ漏れず `system_error_logs` にのみ残る
- [ ] 余分な項目が混ざっても必須が揃えば通る
- [ ] 規約改訂（`TOS_VERSION` 変更）で古い同意が無効になる
- [ ] metadata に `tos_version` / `tos_agreed_at` / `agreed_items` が載る
- [ ] setup を2回実行しても行が重複せず、編集済み文言を上書きしない

画面（`tests/browser/auth-screens.mjs`）:
- [ ] プラン選択まで同意セクションが `hidden`
- [ ] 警告文・確認表・チェック項目がサーバー値で描画される
- [ ] 差し込み記法がリンクへ展開され、`{` が画面に残らない
- [ ] 未チェック／必須一部／任意のみでボタン無効、必須全チェックで有効
- [ ] 送信内容に `planCode` / `tosVersion` / `agreedItems` が載り、Price ID が載らない
- [ ] プランを選び直すとチェックがリセットされる
- [ ] `/legal/` 3ページの見出し・制定日・320px 横スクロールなし
- [ ] 法務確認コメント・草案注記・DRAFT・要確認リストが公開ページに無い
- [ ] 登録番号 T3021003007473 が `/legal/tokusho/` に表示される
- [ ] `/login/` `/pricing/` に「準備中」が残っていない

---

## 9. 既知の制約

1. **同意記録の保存先はStripeのmetadataとサーバーログのみ。** 利用者ごとの同意履歴を `users` シート等に持たせていない。誰がいつ何に同意したかを一覧したい場合は、Stripe ダッシュボードか `system_error_logs` を見ることになる
2. **規約改訂時、既存契約者への再同意フローは未実装。** `TOS_VERSION` を上げると新規申込みは新版で同意するが、既存利用者へ再同意を求める導線は無い
3. **法務文書は弁護士確認前の草案。** `docs/legal-review-notes.md` の13項目は未解決

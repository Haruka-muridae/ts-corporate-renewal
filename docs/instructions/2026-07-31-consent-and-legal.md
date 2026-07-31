# Claude Code 実装指示書

## 利用規約同意システム + 法務ページ(/legal/)

---

## 前提

- 対象ブランチ: origin/main から新規ブランチ(例 feat/consent-and-legal)
- 添付3ファイルを法務文書の原稿とする:
  - legal-terms-v1.0.md(利用規約)
  - legal-privacy-v1.0.md(プライバシーポリシー)
  - legal-tokusho-v1.0.md(特定商取引法に基づく表記)
- docs/specs/ の既存仕様書と矛盾する変更は、仕様書の同期更新とセットで行うこと
- 既存の認証・決済処理の挙動変更は本指示書に明記した範囲のみ

## 決定済みの方針(変更禁止)

1. **解約は期間満了方式**: 解約後も支払済み期間の終了日まで利用可能(cancel_at_period_end 前提)。法務文書の記載もこの方式で統一済み。即時停止方式にしないこと
2. 同意フローは「/pricing/ でプラン選択 → 契約条件確認+同意チェック → Stripe Checkout」。参考UIはステップ形式の契約確認画面(条件の表組み+赤枠警告+チェックリスト)
3. 同意チェック項目・確認表の文言は**コードに書かずスプレッドシート管理**(既存のプラン表示と同じ思想)。文言変更にデプロイ不要であること
4. **適格請求書発行事業者登録番号: T3021003007473**(作業1で特商法表記へ反映)

---

## 作業1: 法務ページ /legal/ の新設

### 構成

```
/legal/terms/    利用規約
/legal/privacy/  プライバシーポリシー
/legal/tokusho/  特定商取引法に基づく表記
```

- 静的HTML。auth.css の共通スタイル準拠(白基調・読みやすい本文幅・スマホ最優先)
- 各ページ冒頭に「2026年7月30日 制定 / Version 1.0」を表示
- 原稿mdの内容を忠実にHTML化する。ただし:
  - **「法務確認コメント」と記された表ブロック(計13箇所)は公開ページに含めない。** 削除ではなく docs/legal-review-notes.md へ抽出して保存する(弁護士確認時のチェックリストとして使うため)
  - 冒頭の「重要:本書は法務草案であり…弁護士による確認を推奨」の枠も公開ページから除外し、同じく review-notes へ移す
- 相対パス規約(setScreenDepth 相当)は既存画面と同じ方式に従う

### 特商法表記へのインボイス欄の追加

legal-tokusho-v1.0.md の表の「支払方法」行の直後に、以下の2行を追加してからHTML化すること:

| 項目 | 内容 |
|---|---|
| 適格請求書発行事業者登録番号 | T3021003007473 |
| 請求書・領収書 | Stripeが決済完了時に送付する領収書メールをもってこれに代える。適格請求書の個別発行が必要な場合は、問い合わせ窓口(architect@potenitas.com)へ連絡すること。 |

原稿md自体にもこの2行を反映し、公開HTMLと原稿を一致させること。

### 既存ページの差し替え

- /login/ /pricing/ ほか全画面のフッターの「利用規約(準備中)」「プライバシーポリシー(準備中)」リンクを /legal/terms/ /legal/privacy/ へ差し替え
- /pricing/ のフッターに「特定商取引法に基づく表記」リンクを追加
- 「準備中」の文言が残存していないことを grep で確認

---

## 作業2: 同意チェックリストのデータ化

### 認証設定スプレッドシートに2シートを新設

**consent_items シート**(同意チェックボックス)

| 列 | 内容 |
|---|---|
| item_id | 一意ID(例 tos, auto_renew, api_cost, cancel_policy) |
| label | チェックボックスの表示文言。{terms} {privacy} {tokusho} をリンクへ展開可能にする |
| required | TRUE/FALSE(TRUEはチェック必須) |
| sort_order | 表示順 |
| enabled | TRUE/FALSE |

**confirm_sections シート**(契約条件の確認表。参考UIの表組み部分)

| 列 | 内容 |
|---|---|
| section | 見出し(例: 料金と支払い / 契約期間と自動更新 / 解約) |
| item_label | 項目名(例: 月額料金) |
| item_value | 内容(例: 550円(税込)) |
| emphasis | TRUE で赤文字強調 |
| sort_order | 表示順 |

### Setup.gs

- setupAuthSystem() 実行時に両シートを冪等に作成し、初期データを投入する
- 初期データは本指示書末尾の「初期文言」を使用
- 既存行がある場合は上書きしない(文言の運用編集を壊さない)

### GAS API

- GET action **listConsentConfig** を追加(認証不要・ホワイトリスト登録)
  - 返すもの: enabled な consent_items(sort順) / confirm_sections(sort順) / tos_version(settings シートの TOS_VERSION、初期値 "1.0")
  - 秘密情報を含まないこと
- **createCheckoutSession の入口に同意検証を追加**:
  - リクエストに agreedItems(item_id 配列)と tosVersion を必須化
  - required な item_id がすべて含まれない、または tosVersion が現在の TOS_VERSION と一致しない場合は INVALID_REQUEST で拒否(フロントのチェックだけに依存しない)
  - Checkout Session の metadata に tos_version / tos_agreed_at(ISO) / agreed_items(カンマ区切り)を追加
- settings シートに TOS_VERSION を追加(ensureDefaultSettings_ に登録、既定 "1.0")

---

## 作業3: /pricing/ の同意フロー実装

参考UIに寄せた1ページ内2段構成(別ページ遷移にはしない):

1. **プラン選択**(既存のまま)
2. プラン選択後、**契約条件確認セクション**を表示:
   - 冒頭に赤枠警告(「本サービスは月額550円(税込)の1か月単位の自動更新契約です。…」— confirm_sections とは別に settings の CONSENT_WARNING_TEXT で管理)
   - confirm_sections をセクション見出しごとの表として描画
   - consent_items をチェックボックスとして描画({terms} 等はリンクに展開、target=_blank)
   - **required 全チェックで「同意して決済へ進む」ボタンが活性化**
3. ボタン押下 → agreedItems / tosVersion を付けて createCheckoutSession → Stripe へ遷移

- 文言・表内容をJS/HTMLへハードコードしない。listConsentConfig の応答のみで描画
- listConsentConfig 取得失敗時は申し込み不可(同意なしで決済へ進める抜け道を作らない)。エラー文言はフロント管理
- アクセシビリティ: チェックボックスに label、必須未チェックで進もうとした場合のエラーは role=alert + 該当項目へフォーカス

---

## 作業4: テスト

- listConsentConfig の応答形状 / enabled=FALSE の除外 / sort順
- createCheckoutSession: required 欠落・tosVersion 不一致で拒否、充足時に metadata が付くこと
- setup の冪等性(2回実行で行が重複しない・既存編集を上書きしない)
- ブラウザ: 未チェックでボタン非活性 / 全チェックで活性 / リンクが /legal/ を指す / 「準備中」残存ゼロ / 登録番号 T3021003007473 が /legal/tokusho/ に表示される / 5画面幅
- 既存テストすべて緑を維持

---

## 作業5: 仕様書の同期

- docs/specs/login-page-detailed-spec-v3.md を改訂:
  - §5.1 ホワイトリストに listConsentConfig を追記
  - 改訂履歴に追加
- /pricing/ の仕様は新規ファイル docs/specs/pricing-consent-spec-v1.md として作成(本指示書の作業2・3の内容を確定仕様の形式で。既存仕様書の書式に従う)

---

## 初期文言(シート投入用)

### consent_items

| item_id | label | required |
|---|---|---|
| tos | {terms}および{privacy}に同意します。 | TRUE |
| auto_renew | 月額550円(税込)・1か月ごとの自動更新契約であり、解約しない限り毎月決済されることを確認しました。 | TRUE |
| api_cost | AI機能の利用に必要なAPI利用料は月額料金に含まれず、各AIプロバイダーへ利用者が直接支払うこと、使用量・課金額は利用者自身が管理することを理解しました。 | TRUE |
| cancel_policy | 解約後は支払済み期間の終了日まで利用でき、日割り・残存期間分の返金は行われないこと({tokusho})を確認しました。 | TRUE |

### confirm_sections(抜粋。全量は特商法md「最終確認画面に表示すべき主要事項」を網羅すること)

- 料金と支払い: 月額料金=550円(税込・emphasis) / 1年間継続の目安=6,600円(税込) / 支払方法=クレジットカード(Stripe) / 支払時期=初回決済日基準で毎月自動決済
- 契約期間と自動更新: 契約期間=1か月 / 自動更新=あり(解約まで継続・emphasis)
- API利用料: 月額料金に含まれない・各AIプロバイダーへ直接支払い(emphasis)
- 解約: 方法=問い合わせ窓口(architect@potenitas.com)への申し出 / 解約後=支払済み期間の終了日まで利用可能 / 返金=日割り・残存期間分の返金なし(emphasis)

---

## 禁止事項

- 列挙耐性・セッション検証・Webhook 処理の変更
- consent 文言のハードコード
- /legal/ 原稿の内容改変(HTML化・インボイス欄追加・法務確認コメントの抽出のみ許可)
- main への直接コミット(ブランチ+マージ前確認の既存手順に従う)

## 提出物

1. 変更ファイル一覧
2. 新シートの構成と初期データ
3. API仕様の差分(listConsentConfig・createCheckoutSession)
4. テスト結果(全スイート)
5. 法務確認コメント抽出ファイル(docs/legal-review-notes.md)のパスと件数
6. 仕様書の更新内容
7. GAS側で貼り替えが必要なファイルの一覧(手動反映用)
8. マージ前確認(mainへ入るコミット一覧を提示して承認待ち)

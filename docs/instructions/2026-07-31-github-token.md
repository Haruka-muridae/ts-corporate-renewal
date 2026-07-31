# GitHub トークンの作成と設定（法務ページ公開用）

作成日: 2026年7月31日
対象: `publishLegalDocs()` を実行する管理者

---

## これは何か

スプレッドシート「TSAM AI 法務文書」から法務ページを公開すると、
Apps Script が GitHub のリポジトリへ直接コミットする。
そのために、**書き込み権限を持つトークン**を1つ用意する。

このトークンは `legal/terms/index.html` `legal/privacy/index.html`
`legal/tokusho/index.html` の3ファイルを書き換えるためだけに使う。

トークンが未設定のあいだ、`publishLegalDocs()` は何も送信せずに中断する。
プレビュー（`previewLegalDocs()`）はトークン無しでも使える。

---

## 1. Fine-grained personal access token を作る

Classic token（`ghp_` で始まるもの）は使わない。
権限をリポジトリ単位で絞れず、事故のときの影響範囲が広すぎる。

1. GitHub にログインし、右上のアイコン →
   **Settings** → 左メニュー最下部の **Developer settings**
2. **Personal access tokens** → **Fine-grained tokens** → **Generate new token**
3. 次のとおり設定する

| 項目 | 設定 |
| --- | --- |
| Token name | `tsam-ai-legal-publisher`（分かればよい） |
| Expiration | 運用に合わせて設定する。期限切れ時は §4 を参照 |
| Resource owner | リポジトリの所有者 |
| Repository access | **Only select repositories** → `ts-corporate-renewal` **だけ** |
| Permissions → Repository permissions → **Contents** | **Read and write** |
| 上記以外の Permissions | **すべて No access のまま** |

`Contents` 以外に触らないこと。Actions、Secrets、Administration などを
足すと、法務ページの公開に不要な権限をトークンへ持たせることになる。

4. **Generate token** を押す
5. 表示されたトークン（`github_pat_` で始まる文字列）をコピーする
   **この画面を閉じると二度と表示されない。**

---

## 2. Apps Script へ保存する

1. Apps Script プロジェクトを開く
2. 左メニューの **プロジェクトの設定**（歯車）
3. 下部の **スクリプト プロパティ** → **スクリプト プロパティを追加**
4. 次のとおり入力して保存する

| プロパティ | 値 |
| --- | --- |
| `GITHUB_TOKEN` | 手順1でコピーしたトークン |

保存したら、コピー元（クリップボード、メモ帳、チャットの履歴など）を消すこと。

### 保存先を間違えないこと

`GITHUB_TOKEN` は **Script Properties にだけ**置く。
認証設定スプレッドシートの `settings` シートへ書いてはならない。

コード側は `SECRET_KEYS` でこのキーを遮断しているため、
設定シートに書いても読まれない（＝公開は動かないまま、
トークンだけがスプレッドシートに残る）。

---

## 3. 公開先の確認

認証設定スプレッドシートの `settings` シートで、次の2つを確認する。

| キー | 既定値 | 意味 |
| --- | --- | --- |
| `GITHUB_REPO` | `Haruka-muridae/ts-corporate-renewal` | 公開先（`owner/repo`） |
| `GITHUB_BRANCH` | `main` | コミット先ブランチ |

これらは秘密ではないため、設定シートで変更できる。

---

## 4. 期限切れ・失効させたいとき

トークンには有効期限がある。切れると `publishLegalDocs()` が
「GitHub からの取得に失敗しました（401）」で止まる。

- **更新する**: 手順1〜2をやり直し、`GITHUB_TOKEN` の値を新しいものへ差し替える
- **失効させる**: GitHub の Fine-grained tokens 一覧から該当トークンを **Delete**

漏えいが疑われる場合は、**まず GitHub 側で Delete** する。
Script Properties から消すだけでは、流出したトークンは有効なままである。

---

## 5. 動作確認

1. GAS エディタで `previewLegalDocs()` を実行し、実行ログのURLで見た目を確かめる
2. `publishLegalDocs()` を実行する
3. 実行ログに次が出れば成功

```
公開しました。

変更: terms
スキップ: privacy, tokusho

コミット:
  terms: https://github.com/.../commit/...
```

条文を何も直していない状態で実行した場合は、
`変更のある文書はありませんでした。` と出る。これも正常である。

GitHub Pages への反映まで1〜2分かかる。

---

## 関連

- 仕様: [../specs/legal-cms-spec-v1.md](../specs/legal-cms-spec-v1.md)
- 同意フローと `TOS_VERSION`: [../specs/pricing-consent-spec-v1.md](../specs/pricing-consent-spec-v1.md)

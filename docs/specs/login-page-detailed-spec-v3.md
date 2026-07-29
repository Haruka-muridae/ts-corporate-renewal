# TSAM AI — ログインページ詳細定義書(v3)

対象: `/login/index.html` + `auth/` 共通層 + `gas-auth/`(ログイン関連部分)
位置づけ: 実装調査(2026-07-29)と設計レビューを経た確定仕様。**このコードベースを操作する実装者(Claude Code含む)が実装と突き合わせるための実務文書**であり、実装技術から独立した抽象仕様書ではない(意図的な設計判断。§14参照)。
本書と実装が食い違う場合は、本書を修正するか実装を直すかを必ず判断し、黙って乖離させないこと。
参照は ファイル名・関数名・定数名 で行う。行番号は用いない。

---

## 1. 画面の責務

- 認証専用画面とする。**本質要件: ログイン以外の情報(アプリ一覧・お知らせ・料金金額・事例・会社紹介等)を掲載しない**
- 上記要件の機械的検証として、現行テストは「本文テキスト総量500文字未満」を基準に用いる。文字数はテスト実装であって要件そのものではない。正当な理由(法的表示の追加等)で超える場合はテスト基準を見直してよいが、「認証以外を載せない」要件は維持する
- 到達経路: 直接アクセス / guardPage() によるリダイレクト(`?next=portal` 付き) / ログアウト後遷移
- 成功時の遷移先: `?next=` の画面名(許可リスト照合後)。現行は Portal 固定(§6)

---

## 2. レイアウト定義(上から順)

| # | 要素 | 仕様 |
|---|------|------|
| 1 | ロゴ | リンクはトップ(相対パス解決) |
| 2 | 見出し(h1) | 「ログイン」 |
| 3 | 導入文 | 1文以内 |
| 4 | メールアドレス入力 | `type="email"`、label 必須、`autocomplete="email"` |
| 5 | パスワード入力 | `type="password"`、label 必須、`autocomplete="current-password"`、表示切替付き |
| 6 | 表示切替ボタン | `aria-pressed` + `aria-label` を状態同期。`type="button"` |
| 7 | ログイン状態を保持 | checkbox `id="login-remember" name="remember"`。デフォルト OFF。OFF=12時間 / ON=30日 |
| 8 | ログインボタン | `type="submit"`。処理中 disabled + 文言変更 + aria-busy + isBusy |
| 9 | メッセージ領域 | エラー `role="alert"` / 案内 `role="status"`。初期は空 |
| 10 | パスワードをお忘れですか | → `/password/reset/`(相対パス) |
| 11 | 初めてご利用の方 / サービスを申し込む | → `/pricing/`。stripe.com 直リンク禁止 |
| 12 | フッター | 利用規約 / プライバシーポリシー |

### UI規約(本プロジェクトのハウスルール)

- **placeholder 不使用**: 一般的なアクセシビリティ必須要件ではなく、本プロジェクトのUI規約(labelの代替として使われる事故の予防 + テストの機械的検証を簡潔に保つため)。緩和する場合はテスト書き換えとセットで行うこと
- 禁止コンテンツ(§1の本質要件): 料金金額 / stripe.com 直リンク / アプリ一覧・お知らせ・ニュース・事例・会社紹介

---

## 3. 画面状態定義

| 状態 | 表示 | 備考 |
|------|------|------|
| 初期 | フォームのみ、メッセージ空 | |
| 送信中 | disabled + 文言変更 + aria-busy | requestSubmit 連打も isBusy で遮断 |
| 入力エラー | フォーカス移動 + aria-invalid + 「エラー:」接頭辞 | 修正で解除 |
| 認証失敗 | AUTH_FAILED 文言 | このコードのときのみパスワード欄へフォーカス |
| ロック中 | LOCKED 文言 | |
| 通信失敗 | NETWORK 文言 | |
| ストレージ利用不可 | 専用文言(現在 login.js 内。ui.js MESSAGES への移動が課題 §13) | |
| ログイン済みで到達 | verifySession → 有効なら即遷移 | フォームを見せない |

---

## 4. クライアント側バリデーション

- 未入力・形式不正の文言は `auth/ui.js` の MESSAGES(フロント管理)
- 送信前に trim。メール小文字化はサーバー側正規化と一致
- サーバー由来エラーの文言をフロントで作り直さない(`error.userMessage` をそのまま表示)。**理由: フロントで理由を推測・追記するとアカウント列挙耐性が崩れるため**

---

## 5. API 契約(実装確定値)

通信は `auth/api.js` のみを窓口とする。fetch 直呼び禁止。
`Content-Type: text/plain;charset=utf-8`。**理由: application/json はプリフライト(OPTIONS)を発生させるが、GAS Web アプリは OPTIONS に応答できないため、単純リクエストに収める必要がある**

### 5.1 action ホワイトリスト(Config.gs / Main.gs)

```
GET  : listPlans, publicConfig, health
POST : login, logout, verifySession, setupPassword,
       requestPasswordReset, resetPassword,
       createCheckoutSession, checkoutStatus
別経路: POST /exec?path=stripe-webhook&k=<合言葉>
```

REST パス形式を採らないのは GAS の単一エンドポイント制約による。将来別基盤へ移行する場合の変換点は `auth/api.js` に限定する(画面コードは影響を受けない構造を維持)。

### 5.2 login リクエスト

```json
{
  "action": "login",
  "email": "taro@example.com",
  "password": "…",
  "remember": false,
  "userAgent": "Mozilla/5.0 …"
}
```

- `remember` は boolean。フロント(login.js / api.js)・GAS(Main.gs)の3層すべてで `=== true` の厳密判定。**理由: `Boolean("false") === true` のような暗黙変換を許すと、型不正時に意図せず30日セッションが発行される。厳密判定なら型不正は短時間セッション側(安全側)に倒れる。**SDK等を将来作る場合は SDK 側で型を保証する
- `userAgent` は api.js が全 POST に自動付与(ログ用途のみ、最大300文字)。**クライアントから送る理由: GAS の doPost(e) は HTTP ヘッダーを受け取れず、サーバー側で User-Agent を取得できないため。**精度は参考程度と割り切る

### 5.3 login 成功レスポンス

```json
{
  "success": true,
  "data": {
    "sessionToken": "<base64url 43文字>",
    "expiresAt": "2026-07-29T12:00:00.000Z",
    "remember": false,
    "user": {
      "userId": "usr_<uuid>",
      "email": "taro@example.com",
      "role": "member",
      "accountStatus": "active",
      "subscriptionStatus": "active",
      "paymentExempt": false,
      "isAdmin": false
    }
  }
}
```

- ラッパーは `success` / `data`
- `expiresAt` は ISO 8601 UTC。**表示・参考値に限定する。**期限の判定はサーバー時刻のみで行い(verifySession が唯一の判断)、クライアントは expiresAt を認可判断に使わない
- user は toPublicUser_(Users.gs)の7フィールドのみ。password_hash / salt は構造上含まれない
- 画面側の制約: **user オブジェクトを localStorage へ保存しない。**表示等に使う場合も verifySession の結果を都度正とする

### 5.4 login 失敗レスポンス

**現行実装において**、login action 由来のコードは以下の2種:

| code | message | 内包する実際の理由(レスポンスでは区別不可) |
|------|---------|---------------------------------------------|
| AUTH_FAILED | メールアドレスまたはパスワードが正しくありません。 | 未登録 / 不一致 / account_status≠active / パスワード未設定 / 契約無効 / 形式不正 |
| LOCKED | ログインを一時的に制限しています。時間をおいて再度お試しください。 | ロック中 / 当該試行で上限到達 |

**将来コードを追加する場合の条件**(MFA_REQUIRED / PASSWORD_EXPIRED 等を想定): 追加コードが「そのアカウントが存在し、パスワードが正しい」ことを暴露する性質を持つ場合、パスワード照合成功後にのみ返すこと。照合前の状態(未登録・ロック等)と区別可能なコードを照合前に返してはならない(アカウント列挙耐性の維持)。

入口・例外側(全 action で発生しうる): INVALID_REQUEST / INVALID_ACTION / RATE_LIMITED / SERVER_ERROR(文言は Response.gs ERRORS)

- 内部理由(USER_NOT_FOUND / BAD_PASSWORD / ACCOUNT_NOT_ACTIVE / SUBSCRIPTION_INACTIVE / PASSWORD_NOT_SET / INVALID_INPUT)は login_logs の failure_reason_code 列にのみ記録し、レスポンスに含めない。**理由: アカウント列挙・状態探索の防止。**この振る舞いを変更する場合は本書 §5.4 の条件を満たすこと

### 5.5 verifySession(guardPage が使用)

リクエスト: `{ "action": "verifySession", "sessionToken": "…", "userAgent": "…" }`
成功: login と同形状の user + expiresAt + remember
失敗: 常に `SESSION_INVALID` 単一コード。内部理由(NOT_FOUND / REVOKED / EXPIRED / ACCOUNT_NOT_ACTIVE / SUBSCRIPTION_INACTIVE)は返さない。**理由: セッショントークン総当たりに対し、失効理由という追加情報を与えないため**

### 5.6 フォールバック

- フロント(api.js readResult): message 欠落・未知コード → NETWORK_MESSAGE。HTTP 非2xx / JSON パース失敗 → code 'NETWORK'
- GAS: fail_ は code 未指定→'UNKNOWN'、message 未指定→汎用文言。respond_ は errorPair 欠落→SERVER_ERROR
- 画面がコードで分岐するのは AUTH_FAILED のフォーカス制御1箇所のみ。分岐を増やす場合は §5.4 の列挙耐性条件と矛盾しないか確認すること

---

## 6. リダイレクト仕様

### 現行仕様

- パラメータは `?next=<画面名>` のみ。許可リスト ALLOWED_NEXT(session.js)は `['portal']` の1件
- リスト外・不正値はすべて 'portal' へ丸める(safeNextName)
- **任意URL・任意パスを受け取らない(恒久原則)。**理由: ログイン直後に外部サイトへ遷移させるオープンリダイレクトの踏み台を構造的に排除するため。実装コメント(session.js)にも同趣旨の記述あり
- guardPage() は元URLのパス・クエリ・ハッシュを引き継がない。既定値 'portal'

### 将来拡張(発動条件つき)

**保護対象画面が3つを超えた時点で**、次の再設計を行う:

1. ALLOWED_NEXT を SCREENS 定義(config.js)から導出し、画面追加時の多重修正(page / session / config)を解消する
2. 画面名ベースの元画面復帰(`?next=<画面名>` を guardPage が自動設定)を導入する
3. クエリ・ハッシュの復元が必要になった場合は、画面ごとに許可パラメータを個別検証する方式とする

いずれの場合も「任意URLを受け取らない」原則は維持する。保護対象ページを追加する際の現行手順: ①ページで `guardPage({ next: '<画面名>' })` を明示指定 ②ALLOWED_NEXT へ追加 ③SCREENS 定義を確認。

---

## 7. セッションの取り扱い

### 画面側

- 保存キー: `tsam-auth-session`。保存は session.js 経由のみ
- 保存するのはトークン文字列のみ。expiresAt / remember / user を localStorage に置かない
- 到達時に既存トークンがあれば verifySession、有効なら即遷移、無効なら破棄してフォーム表示

### 保存方式の設計判断

現行構成(GitHub Pages + GAS の別オリジン)では HttpOnly Cookie の発行・送信が成立しないため、localStorage を採用する。XSS 耐性は「秘密をJSに書かない・未サニタイズ innerHTML 禁止・外部スクリプト不読込」の運用で担保する。**将来、同一オリジンのバックエンド(Cloud Run 等)へ移行する場合は、HttpOnly / Secure / SameSite 付き Cookie への移行を再評価する**(Cookie 化した場合は CSRF 対策の再評価もセットで行うこと。§14)。

### Session fixation 対策(明文化)

- ログイン成功時は、既存のいかなるトークンも再利用せず、**必ず新規の暗号学的ランダムトークンを発行**する(Sessions.gs)
- ログイン前にクライアントが保持していたトークン(無効・期限切れ含む)は、ログイン成功時に破棄して新トークンで置き換える
- 同一トークンの継続使用(再ログインでの使い回し)を禁止する

### Token rotation(将来検討事項)

現行の 12時間 / 30日固定・検証時延長なしのセッションでは直ちに導入しない。**長期セッションの延長機能、権限昇格操作、管理画面、機密操作(決済情報変更等)を追加する時点で再検討**する。

---

## 8. サーバー側判定(確定仕様)

判定順序(Login.gs performLogin_):

1. メール正規化 → 2. ユーザー検索(不在時ダミー照合で同時間消費) → 3. ロック確認(照合せず終了) → 4. アカウント状態 → 5. パスワード照合(不一致で失敗回数+1) → 6. payment_exempt → 7. subscription_status → 8. セッション発行

設定値(実効層は settings シート。セットアップ時に DEFAULT_SETTINGS からコピー):

| キー | 値 |
|------|-----|
| LOGIN_FAILURE_LIMIT | 5 |
| LOCK_DURATION_MINUTES | 15 |
| SESSION_TTL_HOURS(通常) | 12 |
| セッション(remember) | 30日 |

- 運用者が値を変更する場所は settings シート。この4値は Script Properties に置かない
- 存在しないメールで利用者行を作らない(他人アドレス指定によるロック攻撃の防止) / 失敗更新・発行は withLock_ 内 / needsRehash は成功時に静かに再ハッシュ
- セッション期限の判定はサーバー時刻のみ。検証時の期限延長は行わない(実質無期限化の防止)

### パスワードポリシー(参考: 設定・再設定画面で適用)

12文字以上128文字以内 / 空白のみ禁止 / 同一文字の繰り返しのみ禁止(Password.gs validatePasswordStrength_)。
文字種混在・辞書チェック・再利用禁止・メール類似判定は未実装。追加する場合は同関数へ実装し本書を更新。

---

## 9. エラー文言の管理場所

| 種類 | 場所 |
|------|------|
| サーバー由来エラー全般 | GAS: Response.gs ERRORS |
| パスワード強度の個別理由 | GAS: Password.gs(動的生成) |
| 入力検証(未入力・形式) | フロント: ui.js MESSAGES |
| 通信失敗 / API 未設定 | フロント: api.js |
| ストレージ利用不可 | フロント: login.js 内(移動課題 §13) |

---

## 10. デザイン / アクセシビリティ

- auth.css の共通スタイル準拠。色・余白・角丸・Shadow・Font は CSS 変数管理
- 5画面幅(320/375/768/1024/1440)で横スクロールなし
- 外部通信はフォントのみ
- 全入力欄に label 関連付け / エラーは色+「エラー:」接頭辞 / alert・status の使い分け / aria-invalid の付与と解除 / Enter 送信 / aria-busy
- `<meta name="referrer" content="no-referrer">`

---

## 11. セキュリティ(画面側の遵守事項)

- HTML / JS に秘密情報を書かない
- 未サニタイズの innerHTML 代入禁止(textContent 優先)
- パスワードを console / ログ / URL に出さない
- localStorage のトークン偽造は guardPage(サーバー検証)で弾かれる構造を維持する。クライアント側の値を認可判断に使わない

---

## 12. 受け入れテスト(Done条件)

機能:
- [ ] 正常ログイン → next 画面へ遷移
- [ ] remember OFF/ON で expiresAt が 12時間 / 30日
- [ ] remember に文字列 "true" を送っても false 扱い(厳密判定の維持)
- [ ] AUTH_FAILED / LOCKED / RATE_LIMITED / NETWORK の文言出し分け
- [ ] AUTH_FAILED 時のみパスワード欄へフォーカス
- [ ] ログイン済みで /login/ 到達 → 即遷移
- [ ] 5回失敗で15分ロック、時間経過(モック)で解除
- [ ] 未登録アドレスで応答内容・応答時間が実在時と区別不可
- [ ] `?next=不正値` が portal に丸められる
- [ ] ログイン成功時に旧トークンと異なる新トークンが発行される(Session fixation 検証)
- [ ] パスワード変更後、旧セッションで verifySession が SESSION_INVALID になる(全失効の検証)

画面:
- [ ] 5画面幅で横スクロールなし / 二重送信防止(連打で submitCount=1)
- [ ] 禁止コンテンツ不掲載(現行テスト基準: 本文500文字未満)
- [ ] placeholder ゼロ / label 完備 / aria 同期 / コンソールエラーなし / 外部通信フォントのみ
- [ ] サブパス配信で破綻なし

---

## 13. 既知の課題(未解消)

1. 文言の二重定義: ui.js の notConfigured が未参照で、実表示は api.js 側の別文言。どちらかへ統一し未使用側を削除する
2. ストレージ利用不可文言の login.js 直書き。ui.js MESSAGES への移動が望ましい

---

## 14. 設計判断の記録(却下・保留した提案と理由)

本書はレビューで以下の提案を検討し、意図的に採用しなかった。再提案時はここを先に読むこと。

| 提案 | 判断 | 理由 |
|------|------|------|
| userAgent をサーバー側で取得 | 却下 | GAS doPost(e) は HTTP ヘッダーを受け取れない(構成上不可能) |
| REST パス形式への変更 | 却下 | GAS 単一エンドポイント制約。移行時の変換点は api.js に限定済み |
| remember の Boolean() 正規化 | 却下 | Boolean("false")===true の事故を招く。型不正は短時間セッション側に倒すフェイルセーフを優先 |
| CSRF トークンの追加 | 保留 | Cookie による暗黙認証が存在しない現行方式では古典的 CSRF が主要脅威でない。Cookie 化した時点で再評価 |
| Clock skew 対応 | 不要 | 期限判定はサーバー時刻のみ。クライアントの expiresAt は表示・参考値に限定(§5.3 に明文化済み) |
| login レスポンスから user を削除 | 保留 | 現画面は未使用だが verifySession と同形状を保つ価値があり、7フィールドに限定済み。API 縮小は破壊的変更のため次の互換性見直し時に判断 |
| 仕様書 / ADR / 実装資料の分割 | 却下 | 本書は実装と突き合わせる実務文書。分割による同期コストが単独運用の規模に見合わない。代替として本 §14 に判断理由を記録する |

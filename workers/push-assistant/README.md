# push-assistant

Google カレンダーの予定を毎分確認し、指定したタイミング（10分前／開始時刻）で
Web Push 通知を送る。**通知を1回タップすると、予定に紐づいた URL（Google Meet 等）が
そのまま開く。** ブラウザを閉じていても届く。

公開 URL: <https://tsam-ai.com/push-assistant/>

仕様の正本は [docs/specs/push-assistant-mvp-v1.md](../../docs/specs/push-assistant-mvp-v1.md)。
コードとこの README が食い違ったら、仕様書を見て両方をそろえる。

---

## 1. 役割と境界

```
Google Calendar → push-assistant（Cron が毎分確認）→ Web Push → 端末 → タップ → URL
```

**リポジトリ直下の `wrangler.jsonc`（`ts-corporate-renewal`／OpenNext）とは別サービス。**
デプロイも別に行う。`npm run deploy` はこの Worker を更新しないし、逆も同じ。

同じホスト（`tsam-ai.com`）を共有できるのは、Cloudflare が
**パス Route を Custom Domain より先に評価する**ため。`/push-assistant/*` だけが
この Worker に来て、他のパスは従来どおりメイン Worker が配信する。
したがってサイト本体への回帰の余地が無い（仕様書 §3-1）。

### notifier-gate との違い

| | notifier-gate | push-assistant |
| --- | --- | --- |
| 判定するもの | 利用者の GAS から送られた「予定の骨格」 | 自分で取った Google カレンダーの予定 |
| push を送るのは | 利用者の GAS | **この Worker 自身** |
| 予定名・URL | **受け取らない** | 受け取って D1 に保存する |
| ライセンス | 必要 | 不要（v1 はゲート無し） |

VAPID の署名コード（`src/vapid.mjs`）と鍵のスクリプトは notifier-gate から
**複製**してある（docs/repository-structure.md §4-1。共通層を作らない）。
**鍵ペアは別のものを使う。** 共有すると、片方をローテーションしたときに
もう片方の購読まで無効になる。

### 受け取るもの / 受け取らないもの

受け取る: Google の `sub`・メールアドレス・予定（名前・説明・場所・URL）・push 購読
受け取らない: パスワード。Google のトークンは受け取るが**暗号化して保存し、ブラウザへは返さない**

---

## 2. エンドポイント

すべて `/push-assistant/api/` 配下。応答は JSON（`Cache-Control: no-store`）。
成功 `{ ok: true, ... }`、失敗 `{ ok: false, error: { code, message } }`。
末尾スラッシュの有無は両方受け付ける。

| メソッド・パス | 認証 | 内容 |
| --- | --- | --- |
| `GET /api/health` | 不要 | `{ ok, service: 'push-assistant', version }` |
| `GET /api/auth/start` | 不要 | `pa_oauth` Cookie を発行して Google へ 302 |
| `GET /api/auth/callback` | 不要 | コード交換 → 保存 → `pa_session` 発行 → 画面へ 302。失敗時は `/push-assistant/?error=<code>` |
| `POST /api/auth/logout` | 要 | Cookie 削除のみ（データは残す） |
| `POST /api/auth/disconnect` | 要 | Google のトークン失効 → 利用者の全行を削除 → Cookie 削除 |
| `GET /api/me` | 不要 | `{ loggedIn, user, calendarConnected, tokenInvalid, settings, vapidPublicKey, subscriptionCount, leadOptions }` |
| `PUT /api/settings` | 要 | `{ notifyEnabled, leadMinutes }` → `{ settings }`（保存後の値） |
| `GET /api/events` | 要 | 今後 24 時間・最大 20 件 → `{ items: [...] }`。Calendar 失敗時は **502** |
| `POST /api/subscriptions` | 要 | 購読の登録（upsert）→ `{ subscriptionCount }` |
| `DELETE /api/subscriptions` | 要 | 自分の購読を削除 → `{ subscriptionCount }` |
| `POST /api/push/test` | 要 | 全購読へテスト通知 → `{ sent, failed }` |
| `GET /api/notifications` | 要 | 直近 50 件 → `{ items: [...] }` |

エラーコード: `UNAUTHORIZED`(401) / `FORBIDDEN_ORIGIN`(403) / `INVALID_REQUEST`(400) /
`NOT_CONNECTED`(409) / `TOKEN_INVALID`(409) / `CALENDAR_ERROR`(502) /
`NOT_CONFIGURED`(500) / `SERVER_ERROR`(500) / `NOT_FOUND`(404)

### 状態を変える要求には Origin が要る

`POST` / `PUT` / `DELETE` は `Origin` ヘッダが `APP_ORIGIN` と一致しなければ 403。
**Origin が無い場合も 403**（ブラウザは POST に必ず付ける。無いのは curl 等であり、
この API に用は無い）。Cookie は `SameSite=Lax` なので二重の防御になる。

---

## 3. データ（D1: `push_assistant`）

スキーマは [migrations/0001_init.sql](migrations/0001_init.sql)。4 つの表。

| 表 | 何が入るか |
| --- | --- |
| `users` | Google の `sub`・メール・通知設定（`lead_minutes` は JSON 配列） |
| `google_tokens` | **暗号化した**リフレッシュ／アクセストークン、`invalid_at` |
| `push_subscriptions` | endpoint・p256dh・auth。404/410 を受けたら `disabled_at` |
| `notifications` | 通知 1 件ぶんの履歴。`UNIQUE (user_id, event_id, event_start, lead_minutes)` |

### 二重通知を防いでいるのは UNIQUE 制約である

`INSERT OR IGNORE` と対で使う。**「先に SELECT して無ければ INSERT」にしてはいけない。**
Cron が重なると両方の SELECT が「無い」を見て 2 行入り、2 回通知される。
送信の確保も同じ考え方で、`UPDATE … WHERE id=? AND status='pending'` の
`meta.changes` を見て 1 件ずつ原子的に取る（`src/store.mjs` の `claimDueNotifications`）。

`event_start` をキーに含めているので、**予定がリスケされれば別キーになり、
新しい時刻で改めて通知される。**

### トークンは平文で置かない

D1 の中身はダッシュボードや `wrangler d1 execute` から読める。
リフレッシュトークンは期限が無く、1 行漏れたときの代償が大きい。
AES-256-GCM（鍵は Workers Secret の `TOKEN_ENCRYPTION_KEY`）で暗号化し、
`base64url(iv || ciphertext)` の 1 本の文字列として保存する。

**`TOKEN_ENCRYPTION_KEY` を差し替えると、既存の利用者は全員が再接続を要する。**
（復号できない行は `invalid_at` が立ち、画面に「接続し直してください」が出る）

---

## 4. VAPID 鍵

### 生成と、登録前の確認

```powershell
# 1) 作る
node workers/push-assistant/scripts/generate-vapid-keys.mjs

# 2) 登録する前に確かめる（1行目に秘密鍵、2行目に公開鍵を貼る）
#    入力を終えるには Ctrl+Z → Enter（PowerShell）／Ctrl+D（bash）
node workers/push-assistant/scripts/check-vapid-keys.mjs
```

`wrangler secret put` で登録した値は**読み返せない。** 1 文字でも貼り間違えると、
気づけるのが「本番で通知が届かないとき」になる。確認スクリプトは Worker と
同じコード（`src/vapid.mjs`）で読み込み・署名し、公開鍵で検証する。
通れば「形式が正しく、互いに対になっている」ことが確定する。

### ローテーションの代償

ブラウザの購読は `applicationServerKey`（= VAPID 公開鍵）に紐づく。
**鍵を差し替えると全利用者の購読が無効になり、各端末で通知を取り直す必要がある。**
やむを得ず差し替える場合は、`push_subscriptions` を空にして、
利用者に「通知をオンにし直す」よう案内する。

---

## 5. デプロイ手順（運用者が行う）

前提: `wrangler` はリポジトリの devDependencies に入っている。追加インストールは不要。

1. **D1 データベースを作る（2026-08-26 に作成済み）**

   ```powershell
   npx wrangler d1 create push_assistant --config workers/push-assistant/wrangler.jsonc
   ```

   出力された `database_id` を [wrangler.jsonc](wrangler.jsonc) の `d1_databases[0].database_id` へ貼る
   （公開値なのでコミットしてよい）。本番用は 2026-08-26 に作成し記入済み（region APAC）。
   **作り直すと通知履歴と購読が消える**ので、通常はこの手順を再実行しない。

2. **スキーマを流す**

   ```powershell
   npx wrangler d1 migrations apply push_assistant --remote --config workers/push-assistant/wrangler.jsonc
   ```

   `deploy` はマイグレーションを走らせない。**別のコマンドとして必ず実行する。**

3. **VAPID 鍵を作って確認する**（§4）

4. **シークレットを登録する**（5 件）

   ```powershell
   npx wrangler secret put GOOGLE_CLIENT_SECRET  --config workers/push-assistant/wrangler.jsonc
   npx wrangler secret put VAPID_PRIVATE_KEY     --config workers/push-assistant/wrangler.jsonc
   npx wrangler secret put VAPID_PUBLIC_KEY      --config workers/push-assistant/wrangler.jsonc
   npx wrangler secret put SESSION_SECRET        --config workers/push-assistant/wrangler.jsonc
   npx wrangler secret put TOKEN_ENCRYPTION_KEY  --config workers/push-assistant/wrangler.jsonc
   ```

   - `SESSION_SECRET` … 32 バイト以上の乱数（base64）
   - `TOKEN_ENCRYPTION_KEY` … **ちょうど 32 バイト**の乱数（base64）。長さが違うと
     起動時ではなく最初のログイン時に `NOT_CONFIGURED` になる

   作り方（どちらでもよい）:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

   > **空値で登録される事故に注意。** 貼り付けに失敗しても `wrangler` は Success と表示する。
   > 登録後は §5-7 の疎通確認まで通してから完了とすること。

5. **`wrangler.jsonc` の `GOOGLE_CLIENT_ID` を確認する（埋め済み）**

   **Push Assistant 専用の Web アプリ型クライアント**の ID を入れてある（公開値、`58460017181-…`）。
   2026-08-26 に録音アプリ共有クライアントから専用へ切り替えた（仕様書 §4-1、レビュー指摘 1）。
   録音アプリ・Meeting Assistant とは**別 ID**であることを `tests/unit/push-assistant.mjs` が固定している。

   **併せて \`ALLOWED_EMAILS\` を確認する。** 利用を許可するアドレス（カンマ区切り）で、
   既定は \`architect@potenitas.com\` の 1 件。

   > **この Worker は公開パスに置かれており、URL を知っていれば誰でも
   > Google ログインへ進める。** 許可リストが無いと、見知らぬ他人の
   > カレンダーを読み、そのリフレッシュトークンをこちらの D1 に抱えることになる。
   > **空にすると誰も接続できない（deny by default）。** 設定漏れを
   > 「全員許可」へ倒さないための既定であり、緩めないこと。
   > 未確認のアドレス（Google の \`email_verified\` が false）も拒否する。

6. **Google Cloud Console 側の設定**（専用クライアント `58460017181-…` に対して行う。忘れるとログインの最後で必ず失敗する）

   - このクライアントは**「ウェブ アプリケーション」タイプ**であること（でないとリダイレクト URI を登録できない）
   - 「承認済みのリダイレクト URI」へ `https://tsam-ai.com/push-assistant/api/auth/callback` を**追加**する
     （末尾スラッシュなし・`https`。Worker が送る値と 1 文字も違ってはいけない）
   - このクライアントのシークレットを `GOOGLE_CLIENT_SECRET`（secret）に登録する（§5-4、ファイル経由の bulk 登録が確実）
   - このクライアントが属するプロジェクトの OAuth 同意画面のスコープへ
     `https://www.googleapis.com/auth/calendar.events.readonly` を追加する（テスト状態ならテストユーザーに利用者を追加）
   - **同意画面を「本番」状態にする。** 「テスト」のままだと
     リフレッシュトークンが 7 日で失効し、毎週の再接続が要る（§8）

7. **変更をコミットしてから deploy する**

   `npm run deploy:push-assistant` は `scripts/predeploy-check.mjs` を先に走らせる。
   これは **(a) HEAD が `origin/main` を含むこと (b) 未コミットの実変更が無いこと**
   を確認し、どちらかを満たさなければデプロイを中止する
   （2026-08-18 の「古いクローンから本番を上書きした」事故への対策）。

   手順 1 で書いた `database_id` は**未コミットの変更として残っている。**
   そのままでは predeploy-check が止める。

   - `database_id` は秘密値ではない（D1 の識別子であり、これだけでは何もできない）。
     **コミットしてよい。** 通常はコミットしてから deploy する
   - どうしても未コミットのまま出す必要がある場合だけ `DEPLOY_ALLOW_DIRTY=1` を明示する

   `origin/main` を含んでいない作業コピーからは deploy しないこと
   （必要なら先に取り込む）。

   ```powershell
   npm run deploy:push-assistant
   curl https://tsam-ai.com/push-assistant/api/health
   ```

   `{"ok":true,"service":"push-assistant","version":"1.0.0"}` が返れば、
   Route・Worker・assets の配線は通っている。

8. **実際に 1 件通知を出して、端から端まで確かめる**

   > **ここを通すまで本番投入完了としない。** ここより手前は「配線が
   > つながった」ことしか示しておらず、この MVP の目的（通知が届き、
   > タップで URL が開く）は 1 度も確かめられていない。
   > D1 の SQL・Cron・VAPID・購読・Service Worker のうち、
   > どれか 1 つでも間違っていれば下のどこかで必ず止まる。

   まず `https://tsam-ai.com/push-assistant/` を開き、
   ログイン → 通知を許可 →［テスト通知］が届く、まで進める。
   そのうえで次の (a)〜(e) を順に確認する。

   (a) **テスト予定を 1 件入れる。** Google カレンダーに
       「**10 分後に開始**・Google Meet 付き」の予定を作る
       （10 分前通知が既定なので、作った直後の tick で due になる）。

   (b) **送信が 1 回だけ起きることを見る。**

   ```powershell
   npx wrangler tail --config workers/push-assistant/wrangler.jsonc
   ```

   `code=TICK_DONE` が毎分出るなかで、`code=NOTIFY_SENT` が **1 回だけ**
   出ること。2 回以上出たら二重通知防止（`notifications` の UNIQUE 制約と
   `INSERT OR IGNORE`）が効いていない。**そのまま運用してはいけない。**

   (c) **D1 の行を見る。**

   ```powershell
   npx wrangler d1 execute push_assistant --remote --config workers/push-assistant/wrangler.jsonc `
     --command "SELECT status, attempts, url_source FROM notifications ORDER BY id DESC LIMIT 5"
   ```

   その予定の行が **1 行だけ**あり、`status = sent`・`attempts = 1`
   であること（`url_source` は Meet 付きなら `conference`）。
   `attempts` が 2 以上なら送信に失敗して再送している。

   (d) **通知をタップして Meet が直接開くこと。** 中間画面を挟まず、
       1 回のタップで会議の URL に着くこと（要件そのもの）。

   (e) **サイト本体に回帰がないこと。** Route を 1 本足したので、
       `https://tsam-ai.com/`・`/event/`・`/apps/`・`/portal/` を開き、
       従来どおり表示されることを確認する
       （`/push-assistant/*` 以外はメイン Worker が配信し続けるはずだが、
       Route の書き間違いはここでしか気づけない）。

---

## 6. ローカルでの確認

```powershell
npx wrangler dev --config workers/push-assistant/wrangler.jsonc --test-scheduled
```

Cron は待たずに手で叩ける。

```powershell
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

ローカル D1 へスキーマを入れるには `--local` を付ける。

```powershell
npx wrangler d1 migrations apply push_assistant --local --config workers/push-assistant/wrangler.jsonc
```

**ローカルでは OAuth ログインを最後まで通せない。** セッション Cookie に `Secure` が
付いており http では保存されないうえ、Google のリダイレクト URI に localhost を
足すことになるため。ログインを伴う確認は本番（またはプレビュー）で行う。

秘密は `.dev.vars`（`.gitignore` 済み）に置く。**本番の値は使わず、使い捨ての鍵を作る**
（`node workers/push-assistant/scripts/generate-vapid-keys.mjs`、`SESSION_SECRET` と
`TOKEN_ENCRYPTION_KEY` は `randomBytes(32)` の base64）。

### 2026-08-26 に実施した確認（本番投入前）

- `wrangler deploy --dry-run`（wrangler 4.119.0）… 設定が受理され（`assets.run_worker_first: true`、
  Route、Cron、D1、vars すべて認識）、バンドルは約 90 KiB。
- `wrangler dev --test-scheduled` + ローカル D1 … 静的配信（HTML / `sw.js` は `no-cache`）、
  `/api/health`、`/api/me`、Origin 不一致の POST → 403、`/api/auth/start` の 302
  （PKCE・`prompt=consent`・`access_type=offline`・署名付き `pa_oauth`）、ログイン済み
  Cookie での `PUT /api/settings`（不正値は 400）・`POST/DELETE /api/subscriptions`・
  `GET /api/notifications`・`POST /api/push/test`・`__scheduled` の一周。
- `scripts/verify-tick-local.mjs` … §7 のとおり OK。
- `eslint`（リポジトリの設定）… 0 エラー・0 警告。

---

## 7. テスト

```powershell
node tests/run.mjs push-assistant       # バックエンド
node tests/run.mjs push-assistant-sw    # Service Worker（通知タップ）
node tests/run.mjs unit                 # 全体（回帰の確認）
```

Chrome も Workers ランタイムも要らない。`src/*.mjs` は WebCrypto と
`fetch`/`Request`/`Response` しか使っておらず、Node 22 にどちらもある。

### 何を固定しているか

仕様書 §12 の A〜G・I・J に対応する。とくに次の 2 つは、壊れると
「送信は成功しているのに通知が出ない」という追いにくい形になる。

- **Web Push の暗号化を往復で確かめる。** テスト側で受信者の鍵を作り、
  RFC 8291 の手順で自力で復号して平文の一致を見る（`decryptWebPush`）
- **VAPID の `Authorization` を分解して検査する。** `aud` が endpoint の
  origin であること、`exp` が 12 時間以内であること、署名が公開鍵で
  検証できること

単体テストの偽 store（`tests/helpers/push-assistant-fake-store.mjs`）はインターフェースだけを
再現しており、**`store.mjs` の SQL は実行していない。** SQL は次の 2 つで確かめる。

```powershell
# 実 D1（Miniflare のローカル SQLite）で Cron を 3 周させる。秘密は不要、外へは何も送らない
node workers/push-assistant/scripts/verify-tick-local.mjs
```

1. `verify-tick-local.mjs` … マイグレーションを実 SQLite に流し、Google と Push サービスだけを
   偽 fetch にして `runTick` を回す。「503 → 再試行 → 201 → sent → 再送なし」「終日は除外」
   「Meet URL が conference として解決」「アクセストークンは 1 周目だけ取得」を実物の SQL で見る
   （2026-08-26 に実施、OK）。
2. §6 の `wrangler dev` … API 経由で `users` / `google_tokens` / `push_subscriptions` /
   `notifications` の読み書きを一周させる（2026-08-26 に実施、OK）。

SQL を書き換えたら、この 2 つと §5 の手順 7〜8 を通し直すこと。

---

## 8. 既知の制限（仕様書 §14）

- **同意画面が「テスト」状態のままだと、リフレッシュトークンは 7 日で失効する。**
  再接続が要る。本番公開状態にすること（§5-6）
- iPhone は iOS 16.4 以降で、**ホーム画面に追加した PWA からのみ**通知許可を取得できる
- Workers Free プランは 1 呼び出し 50 サブリクエスト・CPU 10ms。
  1 人あたり「トークン更新 1 + Calendar 1 + push（最大
  `MAX_NOTIFICATIONS_PER_USER_TICK` × 購読数）」を使う。
  `MAX_USERS_PER_TICK` を **15** にしてあるのは、全員が同時に 1 件ずつ送る
  最悪ケース（15 × 3 = 45）でも 50 を超えないため。
  **利用者が 15 人を超えた場合も、通知が届かなくなるわけではない**
  （`users.last_tick_at` の古い順に処理するので、次の分に順番が回る）。
  ただし通知が最大で「人数 ÷ 15」分ぶん遅れうる。増えたら Paid プランを検討する
- **利用できるのは `ALLOWED_EMAILS` に載せたアドレスだけ。** 未設定なら
  誰も接続できない（deny by default）。利用者を増やすには vars を書き換えて
  deploy し直す必要がある（画面から招待する仕組みは無い）
- Calendar は `primary` のみ。複数カレンダーは対象外
- 1 ページ（50 件）のみ取得する。1 時間の窓に 50 件を超える予定がある場合は取りこぼす
- Cron が長時間止まっていた間の予定（10 分超）は `skipped` として履歴に残り、送られない
- **通知の本文の時刻は JST 固定。** 利用者のタイムゾーンを持っていないため、
  海外在住の利用者には合わない（開く URL とタップの挙動には影響しない）
- 本文中の URL は ASCII のみを拾う。非 ASCII をそのまま含む URL（IRI）は途中で切れる
  （Google Calendar / Meet の URL は percent-encoding 済みなので実害は無い）
- 本番認証系（`tsam-auth-session`）との連携と Portal 掲載は v1 では行わない（仕様書 §13）

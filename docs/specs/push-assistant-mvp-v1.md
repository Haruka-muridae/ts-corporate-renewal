# Push Assistant MVP 仕様書 v1.0

制定: 2026-08-26
対象: `workers/push-assistant/`（独立 Cloudflare Worker）、`tests/unit/push-assistant*.mjs`
公開 URL: `https://tsam-ai.com/push-assistant/`
状態: **実装完了・本番未投入**（本番投入に必要な操作は `workers/push-assistant/README.md` §5）

この文書は Push Assistant の**実装の正**である（CLAUDE.md「仕様書が実装の正」）。
コードと食い違う場合はどちらかを直して両方を揃える。参照はセクション番号（§n）で行う。

---

## 1. 目的

Google カレンダーの予定を取得し、指定したタイミング（10分前／開始時刻）で
スマホ・PC のブラウザへ Web Push 通知を送り、**通知を1回タップすると予定に紐づいた
URL（Google Meet 等）が直接開く**ことを、ブラウザを閉じていても成立させる。

```
Google Calendar → Push Assistant（Cron が定期確認）→ Web Push → 端末 → タップ → URL
```

MVP の完成条件（§12）を満たすことが最優先であり、機能追加より優先する。

## 2. スコープ外（v1）

Meeting Assistant との本格統合／Gmail・LINE 通知／AI による内容生成・判断／
ルールエンジン／組織向け管理画面／課金・Stripe・ライセンスゲート／ネイティブアプリ。
本番認証系（`tsam-auth-session`）との連携、Portal（`/portal/`）への掲載も v1 では行わない
（§13 の将来拡張）。

## 3. 全体構成（ADR-1）

### 3-1. 独立 Worker として作る

`workers/push-assistant/` を **`workers/notifier-gate/` と同じ流儀の独立 Worker** とし、
メインの OpenNext Worker（`ts-corporate-renewal`）には一切手を入れない。

理由:
- OpenNext が生成する `.open-next/worker.js` に `scheduled`（Cron）ハンドラを足す手段が
  このリポジトリに無く、足せたとしても本番サイト全体の配信物を変えることになる。
- 既存 Worker は Custom Domain（`tsam-ai.com`）で配信されている。Cloudflare の仕様では
  **同一ホスト上のパス Route は Custom Domain より先に評価される**
  （developers.cloudflare.com/workers/configuration/routing/custom-domains/ 「Interaction with Routes」）。
  したがって `tsam-ai.com/push-assistant/*` を本 Worker の Route にすれば、他のパスは
  従来どおりメイン Worker が配信し、回帰の余地が無い。

採らなかった案:
- `app/push-assistant/api/**/route.ts`（Next.js ルートハンドラ）… Cron が無い。
- `public/push-assistant/` に静的 UI を置き API だけ別 Worker（workers.dev）… 別オリジンになり
  Cookie セッションと CSP（`*.workers.dev` は禁止方針）が複雑化する。
- workers.dev のみで公開（notifier-gate 方式）… OAuth のリダイレクト URI と Service Worker の
  scope を本番 URL（`tsam-ai.com/push-assistant/`）に揃えられない。

### 3-2. 配信物

| パス | 実体 |
| --- | --- |
| `/push-assistant/`、`/push-assistant/app.js` 等の静的ファイル | `workers/push-assistant/public/` を Workers Static Assets（`ASSETS` バインディング）で配信。Worker が `/push-assistant` 接頭辞を剥がして `env.ASSETS.fetch()` へ渡す（`run_worker_first: true`） |
| `/push-assistant/api/*` | Worker の `fetch` ハンドラ（§7） |
| Cron（毎分） | Worker の `scheduled` ハンドラ（§8） |

`/push-assistant`（末尾スラッシュ無し）は Route に一致せずメイン Worker へ行くが、
Next.js の `trailingSlash: true` により `/push-assistant/` へ 308 される。

### 3-3. データストア: D1（ADR-2）

利用者・トークン・購読・通知履歴を **D1（`push_assistant` データベース）** に置く。

理由: 通知履歴と二重通知防止キーは「一意制約付きの行」として表現するのが最も単純で、
KV では原子的な INSERT OR IGNORE ができない。Free プランの範囲（読み 500万行/日、
書き 10万行/日）で十分に収まる。Supabase は交流会申込アプリ専用の系であり、
CLAUDE.md「片方の都合でもう片方を変えない」に従い使わない。

### 3-4. 通知実行: Cron Triggers（毎分）（ADR-3）

`* * * * *` の Cron で `scheduled` を起動し、対象ユーザーごとに
「Calendar 取得 → 通知対象判定 → Push 送信」を行う（§8）。

理由: 「ブラウザを閉じていても通知」は Cloudflare 側の定期実行でしか成立しない。
Durable Objects の alarm はより精密だが、MVP では毎分 Cron が最も単純で、
Free プランでもアカウントあたり 5 個まで使える（既存 Worker は Cron を使っていない）。

## 4. Google 連携（ADR-4）

### 4-1. OAuth クライアント

**新しい OAuth クライアントは作らない。** 既存の Web アプリ型クライアント
（録音アプリ／Meeting Assistant が使用中のもの。`public/production-app/voice-recorder/config.js`
と同じ ID）を流用し、Google Cloud Console で
「承認済みのリダイレクト URI」に `https://tsam-ai.com/push-assistant/api/auth/callback`
を追加し、そのクライアントシークレットを Worker のシークレット `GOOGLE_CLIENT_SECRET` に登録する。

採らなかった案:
- 交流会アプリの `GOOGLE_CLIENT_ID`（`scripts/get-calendar-refresh-token.mjs`）… **デスクトップアプリ型**のため
  https のリダイレクト URI を登録できない。
- Push Assistant 専用の Web アプリ型クライアントを新設する … 依頼条件（「新しい OAuth クライアントを勝手に追加しない」）
  により v1 では採らず、**運営者の判断事項**として残す（下記）。

#### 共有クライアントの代償と、専用クライアントとの比較（2026-08-26 レビュー指摘 1 への回答）

| 観点 | 共有（v1 の実装） | 専用 Web クライアントを新設 |
| --- | --- | --- |
| Google の審査（verification）・公開ステータス | **OAuth 同意画面はクライアント単位ではなく GCP プロジェクト単位**。同一プロジェクト（`603018562548`）に作る限り、専用クライアントでも sensitive scope（`calendar.events.readonly`）の審査状態は同じ同意画面に属し、6 本の既存アプリと切り離せない。切り離すには**別プロジェクト**が要る。なお同プロジェクトの既存デスクトップ型クライアントは既に `calendar.readonly`（sensitive）を使っており、同意画面に Calendar 系スコープが載ること自体は新しい状態ではない | 同上（同一プロジェクトなら差なし） |
| スコープの横断 | 同じクライアント ID で GIS（implicit）を使う既存アプリが要求するのは `drive.file` のみ。GIS の token client は要求したスコープのトークンしか返さない（`include_granted_scopes` を付けていない）ため、Push Assistant で許可した Calendar スコープが既存アプリのトークンに混ざることはない。ただし「同じアプリ名で Calendar の許可を求める」ことになり、利用者の同意画面上は既存アプリと区別されない | 同意画面に別名で出せる |
| 設定作業 | 既存クライアントへリダイレクト URI を 1 件追加＋そのクライアントシークレットを Worker へ登録 | クライアント作成＋リダイレクト URI＋シークレット登録。`GOOGLE_CLIENT_ID` を差し替え、`tests/unit/push-assistant.mjs` の「録音アプリと同一 ID」の固定を外す |
| リスク | シークレットが漏れた場合、同じクライアントを使う既存アプリのなりすましに使われうる（implicit フローのアプリは元々シークレットを使わないため、影響は「Push Assistant と同じ code flow を偽装できる」範囲） | 影響が Push Assistant に閉じる |

**判断**: v1 は共有のまま出せる（コード変更は不要）。専用クライアントに切り替える場合も `GOOGLE_CLIENT_ID` の差し替えとテスト 1 か所の変更だけで済むよう、コード側はクライアント ID を設定値としてのみ扱っている。
どちらにするかは本番投入前に運営者が決める（`workers/push-assistant/README.md` §5-6）。

#### 同意画面の公開ステータス

同意画面が「テスト」のままだと、Google はリフレッシュトークンを **7 日で失効**させる（§14）。
交流会アプリのカレンダー同期（`lib/event/calendar-sync.mjs`）が同じプロジェクトの長期リフレッシュトークンで
動いていることから、既に「本番」になっている可能性が高いが、コードからは判定できないため
Google Cloud Console で確認する。

### 4-2. フロー

Authorization Code Flow（`access_type=offline`、`prompt=consent`、PKCE S256、`state`）。
リフレッシュトークンは Worker 側で AES-256-GCM で暗号化して D1 に保存する（§6）。
アクセストークンはブラウザへ返さない。ブラウザが持つのは HMAC 署名付きセッション Cookie だけ（§5）。

### 4-3. スコープ（最小）

```
openid email https://www.googleapis.com/auth/calendar.events.readonly
```

- `openid` … 利用者の識別子（`sub`）。`email` … 接続中アカウントの表示用。
- `calendar.events.readonly` … `primary` カレンダーの予定読み取りのみ。`calendar.readonly`
  （カレンダー一覧・設定まで読める）より狭い。書き込み権限は持たない。

### 4-4. 予定の取得

`GET https://www.googleapis.com/calendar/v3/calendars/primary/events`
`singleEvents=true&orderBy=startTime&maxResults=50&timeMin=…&timeMax=…`
`fields=items(id,status,summary,description,location,start,end,htmlLink,hangoutLink,conferenceData(entryPoints(entryPointType,uri))),nextPageToken`

1 ページのみ（MVP。50 件を超える窓は想定しない）。

正規化後のイベント（`calendar.mjs` `normalizeEvent()` の出力）:

```
{ id, title, start (ISO), end (ISO), allDay (bool), description, location,
  conferenceUrl (string|null), htmlLink, urls: string[] /* description 内の URL 順 */ }
```

`status === 'cancelled'` は除外。`start.date`（`dateTime` 無し）は `allDay: true`（通知対象外 §8-2）。

## 5. 利用者の識別とセッション（ADR-5）

- 利用者 ID は Google の `sub`（id_token のクレーム）。id_token は Google のトークン
  エンドポイントから TLS 経由で直接受け取るため署名検証は行わず、`iss`・`aud`・`exp` を検査する
  （Google の公式ガイドと同じ扱い）。
- セッション Cookie `pa_session`: `base64url(JSON{sub,email,iat,exp}).base64url(HMAC-SHA256)`。
  鍵は `SESSION_SECRET`。属性 `HttpOnly; Secure; SameSite=Lax; Path=/push-assistant/; Max-Age=2592000`（30日）。
- OAuth の途中状態 Cookie `pa_oauth`: `state` と PKCE `code_verifier` を JSON にして同じ方式で署名。
  `Path=/push-assistant/api/auth/; Max-Age=600`。コールバックで `state` 一致を検証し、使用後に削除。
- 状態を変える API（POST/PUT/DELETE）は `Origin` ヘッダが `https://tsam-ai.com`（`APP_ORIGIN`）と
  一致しなければ 403（CSRF 対策。SameSite=Lax と二重）。
- **利用者は `ALLOWED_EMAILS`（vars、カンマ区切り）に載せたアドレスに限る。**
  コールバックで id_token の `email` を小文字・前後空白を除いて照合し、
  一致しなければ `/push-assistant/?error=NOT_ALLOWED` へ戻す。**このとき D1 に行を作らない**
  （許可していない相手のリフレッシュトークンを保持しないため）。
  `email_verified` が false のアドレスも拒否する。
  **`ALLOWED_EMAILS` が空なら誰も接続できない（deny by default）。**
  この Worker は公開パスにあり URL を知っていれば誰でもログインへ進めるため、
  設定漏れを「全員許可」へ倒さない。
- 同意画面はスコープごとにチェックを外せる。コールバックでトークン応答の `scope` に
  `calendar.events.readonly` が無ければ `?error=SCOPE_NOT_GRANTED` へ戻す
  （接続は成功したのに tick が毎分 403 を出し続ける状態を作らない）。
- 本番認証系（`tsam-auth-session`）は使わない（§13）。

## 6. データモデル（D1）

`workers/push-assistant/migrations/0001_init.sql`

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,                     -- Google sub
  email TEXT,
  notify_enabled INTEGER NOT NULL DEFAULT 1,
  lead_minutes TEXT NOT NULL DEFAULT '[10]', -- JSON 配列（分前）。将来 [5,10,30] のような複数通知へ拡張
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE google_tokens (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_enc TEXT NOT NULL,         -- AES-256-GCM（§9）
  access_token_enc TEXT,
  access_token_expires_at TEXT,
  scope TEXT,
  invalid_at TEXT,                         -- invalid_grant 等で使えなくなった時刻（再接続が必要）
  last_error TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  last_success_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  disabled_at TEXT                         -- 404/410 を受けた購読。送信対象から外す
);
CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  event_start TEXT NOT NULL,               -- ISO（UTC）
  lead_minutes INTEGER NOT NULL,           -- 通知種別（0 = 開始時刻、10 = 10分前）
  notify_at TEXT NOT NULL,
  title TEXT NOT NULL,
  open_url TEXT NOT NULL,
  url_source TEXT NOT NULL,                -- conference | description | location | calendar | app
  status TEXT NOT NULL,                    -- pending | sending | sent | failed | skipped
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, event_id, event_start, lead_minutes)  -- 二重通知防止キー（§8-4）
);
CREATE INDEX idx_notifications_due ON notifications(status, notify_at);
CREATE INDEX idx_notifications_user ON notifications(user_id, created_at DESC);
```

## 7. HTTP API

すべて `/push-assistant/api/` 配下。応答は JSON（`Cache-Control: no-store`）。
成功 `{ ok: true, ... }`、失敗 `{ ok: false, error: { code, message } }`（notifier-gate と同形）。
末尾スラッシュの有無は両方受け付ける。

| メソッド・パス | 認証 | 内容 |
| --- | --- | --- |
| `GET /api/health` | 不要 | `{ ok: true, service: 'push-assistant' }` |
| `GET /api/auth/start` | 不要 | `pa_oauth` Cookie を発行して Google へ 302 |
| `GET /api/auth/callback?code&state` | 不要 | コード交換 → `users`/`google_tokens` を upsert → `pa_session` 発行 → `/push-assistant/` へ 302。失敗時は `/push-assistant/?error=<code>` へ 302 |
| `POST /api/auth/logout` | 要 | Cookie 削除のみ（データは残す） |
| `POST /api/auth/disconnect` | 要 | Google のトークン失効（`https://oauth2.googleapis.com/revoke`、失敗しても続行）→ 利用者の全行を削除 → Cookie 削除 |
| `GET /api/me` | 不要 | `{ ok, loggedIn, user: {email} \| null, calendarConnected, tokenInvalid, settings: {notifyEnabled, leadMinutes}, vapidPublicKey, subscriptionCount, leadOptions: [{value:10,label:'10分前'},{value:0,label:'開始時刻'}] }`。`VAPID_PUBLIC_KEY` が未設定でも **500 にせず `vapidPublicKey: ''` を返す**（ここで落とすと画面が何も描けなくなる。画面側は空文字を「通知を有効にできない」として扱う） |
| `PUT /api/settings` | 要 | body `{ notifyEnabled: bool, leadMinutes: number[] }`。`leadMinutes` は `LEAD_OPTIONS` の値のみ、1〜5 個、重複不可。成功時は**保存後の値**を `{ ok:true, settings: { notifyEnabled, leadMinutes } }` で返す |
| `GET /api/events` | 要 | 今後 24 時間・最大 20 件。成功時 `{ ok:true, items: [ { id, title, start, end, allDay, openUrl, urlSource, notifications: [{leadMinutes, notifyAt, status}] } ] }`（配列のキー名は `items`。`status` は `notifications` 表にあればその値、無ければ `'planned'`。終日予定の `notifications` は空配列）。Calendar API 失敗時は `{ ok:false, error:{code:'CALENDAR_ERROR'} }` を **200 ではなく 502** で返し、画面は他の部分を描画し続ける |
| `POST /api/subscriptions` | 要 | body `{ subscription: PushSubscriptionJSON, userAgent? }`。`endpoint` は https のみ。同じ利用者の再登録は upsert。**別ユーザーが同じ endpoint を送ってきた場合は、旧行を削除して新規挿入し（履歴を引き継がない）、`log('warn','SUBSCRIPTION_REASSIGNED','from=<旧 user_id> to=<新 user_id>')` を残す**（端末の使い回しは許すが、無言で他人の購読を奪えないようにする。endpoint はログに書かない）。成功時 `{ ok:true, subscriptionCount }` |
| `DELETE /api/subscriptions` | 要 | body `{ endpoint }`。自分の購読だけ削除。成功時 `{ ok:true, subscriptionCount }`（POST と同じ形） |
| `POST /api/push/test` | 要 | 自分の全購読へテスト通知（URL は `/push-assistant/`）。結果 `{ ok:true, sent, failed }` |
| `GET /api/notifications` | 要 | 直近 50 件 `{ items: [{ id, title, notifyAt, leadMinutes, status, openUrl, urlSource, sentAt, attempts, lastError }] }` |

エラーコード: `UNAUTHORIZED`(401) / `FORBIDDEN_ORIGIN`(403) / `INVALID_REQUEST`(400) /
`NOT_CONNECTED`(409, Google 未接続) / `TOKEN_INVALID`(409, 再接続が必要) /
`CALENDAR_ERROR`(502) / `NOT_CONFIGURED`(500) / `SERVER_ERROR`(500) / `NOT_FOUND`(404)。

## 8. 通知の判定と送信（Cron）

### 8-1. 定数（`src/constants.mjs`）

```
LEAD_OPTIONS        = [{ value: 10, label: '10分前' }, { value: 0, label: '開始時刻' }]
DEFAULT_LEAD_MINUTES = [10]
DUE_GRACE_MS        = 10 * 60 * 1000   // notify_at がこれより古い予定は「見送り(skipped)」
STALE_PENDING_MS    = 15 * 60 * 1000   // pending のまま notify_at からこれ以上経てば failed
MAX_ATTEMPTS        = 3
LOOKAHEAD_MS        = 60 * 60 * 1000   // Calendar 取得窓（先）。最大 lead(将来 30 分等) を必ず覆う
LOOKBEHIND_MS       = DUE_GRACE_MS + 60 * 1000
MAX_USERS_PER_TICK  = 15               // Free の subrequest 上限(50/回)に収める。最悪ケース 15×(refresh 1 + calendar 1 + push 1) = 45
PUSH_TTL_SEC        = 600
MAX_NOTIFICATIONS_PER_USER_TICK = 5    // 1 tick で 1 人あたり送る上限。溢れた分は pending のまま次の tick へ
STUCK_SENDING_MS    = 5 * 60 * 1000    // 'sending' のまま取り残された行を拾い直すまでの時間
```

### 8-2. 判定（`src/schedule.mjs`、純関数）

```
planNotifications({ events, leadMinutes, nowMs, appUrl })
  → [{ eventId, eventStart, leadMinutes, notifyAtMs, title, openUrl, urlSource, due: 'due'|'future'|'stale' }]
```

- 終日予定（`allDay`）と `cancelled` は対象外。
- `notifyAtMs = startMs - lead*60*1000`。
- `due`: `nowMs - DUE_GRACE_MS <= notifyAtMs <= nowMs`。`future`: `notifyAtMs > nowMs`。`stale`: それ以前。
- 「開始時刻」（lead=0）の予定は開始後 DUE_GRACE_MS 以内なら due（Cron の遅延吸収）。

### 8-3. tick（`src/tick.mjs`）

```
runTick({ store, env, nowMs, fetchImpl, log }) → { users, planned, sent, failed, skipped, errors }
```

1. `store.listActiveUsers()`（`notify_enabled=1`、`google_tokens.invalid_at IS NULL`、有効な購読が 1 件以上）を最大 `MAX_USERS_PER_TICK` 件。
   **並び順は `ORDER BY COALESCE(u.last_tick_at, '') ASC, u.id ASC`**（前回処理が古い順、未処理が最優先）。
   処理した利用者は成功・失敗にかかわらず `store.touchUserTick(userId, nowIso)` で `users.last_tick_at` を更新する。
   id 順に固定すると、利用者が `MAX_USERS_PER_TICK` を超えた瞬間に**後ろの利用者へ永久に順番が回らない**
   （症状は「特定の人にだけ通知が来ない」で、ログにも出ない）。
2. ユーザーごとに **try/catch で隔離**（1 人の失敗が他へ波及しない。試験 I）。
   1. アクセストークン取得（キャッシュが 60 秒以上残っていれば再利用、無ければ refresh）。
      `invalid_grant` → `google_tokens.invalid_at` を記録して以後のユーザー処理をスキップ。
   2. Calendar 取得（窓: `now - LOOKBEHIND_MS` 〜 `now + LOOKAHEAD_MS`）。
   3. `planNotifications()`。`due` は `INSERT OR IGNORE`（status `pending`）、`stale` は `INSERT OR IGNORE`（status `skipped`）。
      既に行があれば何もしない（**二重通知防止**、試験 D）。
   4. `store.claimDueNotifications(userId, nowMs)`: `status='pending' AND notify_at <= now` の行を
      `UPDATE … SET status='sending' WHERE id=? AND status='pending'` で 1 件ずつ原子的に確保（Cron 重複起動でも二重送信しない）。
      **`status='sending'` のまま `updated_at` が `STUCK_SENDING_MS` より古い行も同時に拾い直す。**
      送信の途中で isolate が落ちる（CPU 上限超過・デプロイによる置き換え）と行が `sending` のまま残り、
      pending しか拾わない実装ではその通知が永久に届かないため。UPDATE の条件にも同じ時刻を入れてあるので、
      先に取ったほうが `updated_at` を今にした時点で後続の条件は成立せず、二重送信にはならない。
   5. 各行を全購読へ送信（§8-5）。1 件でも成功 → `sent`（`sent_at`）。全滅 → `attempts+1`、
      再試行可能なら `pending` に戻す、`attempts >= MAX_ATTEMPTS` または `notify_at` から `STALE_PENDING_MS` 経過なら `failed`（`last_error` に理由）。

### 8-4. 二重通知防止

キー `(user_id, event_id, event_start, lead_minutes)` の UNIQUE 制約と `INSERT OR IGNORE`。
予定の開始時刻が変われば別キー（＝リスケ後に改めて通知する）。行は due になった時点で
初めて作るため、リスケ前の古い時刻の行は生まれない。

### 8-5. Web Push 送信（`src/webpush.mjs`）

標準 Web Push（RFC 8030 / 8291 / 8292）を WebCrypto だけで実装する。外部ライブラリは使わない。

```
encryptPayload({ p256dh, auth, plaintext }) → { body: Uint8Array }         // RFC 8291 aes128gcm、単一レコード、rs=4096
buildVapidAuthorization({ endpoint, privateKey, publicKeyBase64Url, subject, nowMs }) → 'vapid t=…, k=…'
sendWebPush({ subscription, payload, vapid, fetchImpl, ttlSec, urgency }) → { ok, status, retryable, gone }
```

- `gone`（404/410）→ 購読を `disabled_at` で無効化。
- `retryable`（429/5xx/ネットワーク例外）→ 再試行対象。それ以外の 4xx → 非再試行。
- VAPID の JWT 署名は `workers/notifier-gate/src/vapid.mjs` から**複製**（`src/vapid.mjs`。複製元と日付を冒頭に記す。docs/repository-structure.md §4-1）。
- ペイロード（JSON、Service Worker が読む）:
  `{ v: 1, kind: 'event' | 'test', title, body, url, tag, notificationId? }`
  `tag` は `pa:<eventId>:<lead>`（同じ通知の重複表示を OS 側でも抑止）。

### 8-6. 通知タップ（`public/sw.js`）

`push` → `showNotification(title, { body, tag, data: { url }, renotify: false, icon })`。
`notificationclick` → `data.url` を `clients.matchAll({type:'window', includeUncontrolled:true})` で
探し、**同じ URL の窓があれば `focus()`、無ければ `openWindow(url)`**。中間画面は挟まない。
`data.url` が無い／`http(s)` でない場合は `registration.scope` を開く（SW 側でも再検証）。
`pushsubscriptionchange` → 再購読して `POST /api/subscriptions`。

## 9. 開く URL の決定（`src/open-url.mjs`、純関数）

```
resolveOpenUrl(event, { appUrl }) → { url, source }
```

優先順位（要件どおり）:
1. `conferenceUrl`（`conferenceData.entryPoints[type==='video'].uri`、無ければ `hangoutLink`）→ `source: 'conference'`
2. `description` 内の最初の URL → `'description'`
3. `location` が URL → `'location'`
4. `htmlLink`（Google カレンダーの予定ページ）→ `'calendar'`
5. `appUrl`（`https://tsam-ai.com/push-assistant/`）→ `'app'`

`isAllowedUrl(text)`: `new URL()` で解釈でき、`protocol` が `http:` / `https:`、
`username`/`password` が空、長さ 2048 以下、制御文字を含まない。これ以外は**その候補を捨てて次へ**。
`description` は HTML で返ることがあるため、`<a href="…">` の href と、タグ除去・エンティティ復元後の
本文中 `https?://…` の順で拾う（`extractUrls(text)`）。`javascript:`・`data:` 等は拒否（試験 G）。

## 10. セキュリティ

- OAuth トークン（access/refresh）はブラウザへ返さない。D1 には AES-256-GCM（鍵 `TOKEN_ENCRYPTION_KEY`、
  32 バイトを base64）で暗号化して保存。IV は 12 バイト乱数、`iv.ciphertext` を base64url で連結。
- ログにトークン・Cookie・購読の `auth`/`p256dh` を出さない。エラーは code と HTTP ステータスだけ記録
  **伏せ字（redact）で後から消すのではなく、そもそも転記しない方針を採る。**
  応答本文・アクセストークン・リフレッシュトークン・Cookie・購読の `auth`/`p256dh`/`endpoint`・
  メールアドレスは、**ログへ渡す文字列に一度も入れない**（入れてから伏せる作りは、
  伏せ忘れが 1 か所でもあれば漏れる）。ログに出してよいのは
  分類語・HTTP ステータス・件数・利用者 ID だけ。
- 全 SQL はプレースホルダ。すべての読み書きは `user_id` で絞る（他ユーザーの Calendar/購読へ到達不可）。
- 画面は `textContent` と DOM 生成のみで描画し、`innerHTML` に外部データを入れない。
- CSP（`index.html` の `<meta>`。既存アプリと同じ流儀）:
  `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
- Worker が返す全応答（静的ファイルを含む）に
  `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、
  `X-Frame-Options: DENY`、`Content-Security-Policy: frame-ancestors 'none'`。
  **`frame-ancestors` は `<meta>` では効かない**（CSP の仕様上 `frame-ancestors` /
  `report-uri` / `sandbox` は HTTP ヘッダ専用）。クリックジャッキングを実際に
  止めているのはヘッダのほうであり、`index.html` の meta に書いた
  `frame-ancestors` は無害だが効果が無い。**ヘッダ側が本体。**
  HTML と `sw.js` は `Cache-Control: no-cache`。
- `.env` はコミットしない。VAPID 秘密鍵・クライアントシークレット・セッション鍵・暗号鍵は
  すべて `wrangler secret put`。`wrangler.jsonc` の `vars` には公開値のみ。

## 11. 設定値（環境変数・シークレット）

| 名前 | 種別 | 内容 |
| --- | --- | --- |
| `APP_ORIGIN` | vars | `https://tsam-ai.com` |
| `APP_BASE_PATH` | vars | `/push-assistant` |
| `GOOGLE_CLIENT_ID` | vars | 流用する Web アプリ型クライアントの ID（公開値） |
| `ALLOWED_EMAILS` | vars | 利用を許可するメールアドレス（カンマ区切り）。**空なら誰も接続できない**（deny by default） |
| `VAPID_SUBJECT` | vars | `https://tsam-ai.com/push-assistant/` |
| `GOOGLE_CLIENT_SECRET` | secret | 同クライアントのシークレット |
| `VAPID_PRIVATE_KEY` | secret | JWK または PKCS#8（`scripts/generate-vapid-keys.mjs` の出力） |
| `VAPID_PUBLIC_KEY` | secret | base64url の 65 バイト公開鍵 |
| `SESSION_SECRET` | secret | 32 バイト以上の乱数（base64） |
| `TOKEN_ENCRYPTION_KEY` | secret | 32 バイトの乱数（base64） |
| `DB` | binding | D1 `push_assistant` |
| `ASSETS` | binding | 静的ファイル |

## 12. 完成条件と試験

| # | 観点 | 検証方法 |
| --- | --- | --- |
| A | Calendar 予定取得成功 | `tests/unit/push-assistant.mjs`（fetch 差し替えで Calendar API 応答を再現） |
| B | 10分前通知判定 | 同上（`planNotifications`） |
| C | 開始時刻通知判定 | 同上 |
| D | 通知済みの予定を再送しない | 同上（`runTick` を 2 回呼び、送信 1 回） |
| E | conference URL 抽出 | 同上（`resolveOpenUrl`） |
| F | description URL 抽出 | 同上 |
| G | 不正 URL を拒否 | 同上（`javascript:`, `data:`, `ftp:`, 認証情報付き, 制御文字） |
| H | notificationclick で URL が開く | `tests/unit/push-assistant-sw.mjs`（`sw.js` を偽 ServiceWorkerGlobalScope で実行） |
| I | Calendar API エラー時にアプリ全体が落ちない | `runTick` で 1 人目が 500 でも 2 人目へ送信される。`GET /api/events` が 502 を返しても他 API は動く |
| J | Push 送信失敗時に再実行可能 | 送信 5xx → `pending` のまま `attempts=1`、次 tick で再送。410 → 購読無効化 |
| K | 既存アプリに回帰がない | 既存ファイルの変更は `package.json`（deploy script 追加）と `tests/run.mjs`（スイート追加）のみ。`node tests/run.mjs unit` 全件 PASS |

## 13. 将来拡張（設計上の受け皿）

- 通知タイミングの追加（5分前・30分前・任意分・複数）: `LEAD_OPTIONS` に追加し `lead_minutes` 配列に入れるだけ。`LOOKAHEAD_MS` が最大 lead を覆うことを確認する。
- 本番認証系との連携／Portal 掲載: `guardPage()` を `index.html` に足し、`app-registry.js` に `href: 'push-assistant/'` を追加する。
- Meeting Assistant 統合: 通知ペイロードの `url` を Meeting Assistant の予定ページにする。

## 14. 既知の制限

- Google Cloud の OAuth 同意画面が「テスト」状態のままだと**リフレッシュトークンは 7 日で失効**する（再接続が必要になる）。本番公開状態にすること。
- iPhone は iOS 16.4 以降で、**ホーム画面に追加した PWA からのみ**通知許可を取得できる。
- Workers Free プランでは 1 呼び出し 50 サブリクエスト・CPU 10ms。`MAX_USERS_PER_TICK` は 15。
  利用者がこれを超えても通知は届く（`last_tick_at` の古い順に処理するので次の分に順番が回る）が、
  最大で「人数 ÷ 15」分ぶん遅れる。増えたら Paid プランを検討する。
- 利用者を増やすには `ALLOWED_EMAILS` を書き換えて deploy し直す必要がある（画面から招待する仕組みは無い）。
- Calendar は `primary` のみ。複数カレンダーは対象外。
- 通知は「due になった tick」で行を作るため、Cron が長時間止まっていた間の予定は `skipped` として履歴に残る（10 分超）。

## 15. 採用しなかった提案とその理由

- **本文なし Push（notifier v2 の tickle 方式）**: GAS に暗号化手段が無いための次善策だった。Workers は WebCrypto で RFC 8291 を実装できるため、往復無しで URL を通知に載せるほうが単純で、オフライン時にも SW が内容を持てる。
- **Durable Objects alarm による秒精度スケジュール**: 精度は上がるが構成要素が増える。MVP は毎分 Cron で足りる。
- **KV による送信済み管理**: 一意制約が無く、履歴一覧も作りづらい。
- **既存 notifier-gate へのエンドポイント追加**: ライセンスゲート前提の別サービスであり、稼働中の判定 API に Calendar 読み取りとトークン保管を混ぜると境界が崩れる。

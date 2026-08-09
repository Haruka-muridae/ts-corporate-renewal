# Platform Adapter ／ LlmClient 設計案

**対象**: コンテンツ自動展開・投稿アプリ（`app/pipeline/` + `lib/pipeline/`）
**作成日**: 2026年8月7日
**位置づけ**: **設計案。実装ではない。** Phase 0 の検証結果（特に T1-6 / T2-2 / T6-4）で
形が変わる箇所を明示してある。確定した時点で `lib/pipeline/` へ落とす。

**前提**: [implementation-guide.md](./implementation-guide.md) §2（データ非保持）・§3（技術スタック）。
規約は [../repository-structure.md](../repository-structure.md) §5（`.mjs` ＋ `.d.mts`、外部SDK不可）。

---

## 1. なぜ既存の設計をそのまま使えないか

要件定義書 14章 は Platform Adapter 方式を求め、10章 は `SocialAccount` に
`token_ref`（安全な保管領域への参照）を持たせている。**§2 でトークンを保管しなく
なったため、この `token_ref` を中心に据えた抽象が成立しない。**

そこで、アダプタの中心を「トークンの参照」から**「呼び出しがどこで実行されるか」**へ
置き換える。非保持構成では、媒体ごとに実行場所が違うことが本質的な差になるためである。

**MVP の対象は Threads / X / note の3媒体**（v0.5。YouTube は guide §8 の拡張フェーズ送り）。

| 媒体 | 認証情報の出どころ | 投稿の実行場所 | 決めるもの |
| --- | --- | --- | --- |
| Threads | 発注者アプリ ＋ 利用者のトークン（ブラウザ保持） | **T1-6 次第**（直接 or 中継） | T1-6 |
| X | **利用者自身のキー**（BYO 確定。公開クライアント + PKCE を第一候補） | 中継（ブラウザ直接不可） | T2-2（PKCE の可否） |
| note | 認証なし | ブラウザ（コピー＋遷移） | 確定 |
| ~~YouTube~~ | ~~発注者GCP ＋ 利用者のトークン~~ | ~~T3-7 次第~~ | **拡張フェーズ（v0.5）** |

**この表の「決めるもの」が埋まるまで、アダプタの実装を始めない。**
埋まる前に書くと、`execution` の分岐を後から足すことになり、
3媒体ぶんの書き直しが発生する。

> **v0.5 で1つ楽になった点**: YouTube が外れたことで、
> `execution: 'browser'` を要求する媒体が（T1-6 の結果次第の Threads を除いて）無くなった。
> **T3-7（ブラウザからの Resumable Upload）という重い前提条件が MVP から消えた**ため、
> アダプタの実装を始められる条件は T1-6 と T2-2 の2つだけになった。

---

## 2. Platform Adapter

### 2-1. 責務の線引き

アダプタが持つもの／持たないものを先に決める。ここが曖昧だと、
アダプタが少しずつ育って「もう1つのアプリ」になる。

| アダプタが持つ | アダプタが持たない |
| --- | --- |
| 媒体固有のAPI呼び出しと、その形の差の吸収 | 利用者データの保存（IndexedDB 層の責務） |
| 媒体固有の制約（文字数・レート制限）の申告 | 文章生成（`LlmClient` の責務） |
| 媒体のエラー → 共通の状態への写像 | 再試行の間隔・回数（呼び出し側のキューの責務） |
| 認証の開始URLの組み立てと、コールバックの解釈 | トークンの保存（利用者ブラウザの責務） |

### 2-2. インターフェース案

```ts
/** lib/pipeline/adapters/types.d.mts（案） */

/**
 * 媒体ID。**MVP は3媒体。**
 * 要件5章は4媒体だが、'youtube' は拡張フェーズで足す（guide §8）。
 */
export type PlatformId = 'threads' | 'x' | 'note';

/**
 * 呼び出しをどこで実行するか。
 *
 * 非保持構成では、これが媒体ごとの本質的な差になる。
 *   'browser' … 利用者のブラウザから直接。本文がサーバーを通らない
 *   'relay'   … 無状態中継を経由。CORS 不可、または秘密鍵が要る場合
 *   'manual'  … APIが無く、コピー＋遷移で人が行う（note）
 */
export type Execution = 'browser' | 'relay' | 'manual';

/** 利用者が持つ資格情報。**サーバーには保存されない。** */
export type Credential =
  /** 発注者アプリの OAuth で得た、利用者のアクセストークン。 */
  | { kind: 'member_oauth'; accessToken: string; expiresAt: string | null }
  /** 利用者自身が登録したAPIキー（X の BYOキー方式）。 */
  | { kind: 'member_api_key'; key: string; secret: string | null }
  /** 認証が要らない媒体（note）。 */
  | { kind: 'none' };

/** 投稿の入力。**生成物そのもの。ログへ出さない。** */
export interface PublishInput {
  readonly body: string;
  readonly mediaUrl?: string;
  /** 冪等キー。利用者ローカルで採番し、二重投稿を防ぐ。 */
  readonly idempotencyKey: string;
}

/** 投稿の結果。状態は要件11章のステートマシンに合わせる。 */
export interface PublishResult {
  readonly status: 'published' | 'failed';
  /** 媒体側の投稿ID。失敗時は null。 */
  readonly platformPostId: string | null;
  readonly url: string | null;
  /**
   * 失敗の理由。**媒体固有の文言をそのまま返さない。**
   * 利用者に見せる文言は呼び出し側が決める（FAILED 理由の表示・FR-064）。
   */
  readonly failure: {
    readonly code: 'auth' | 'rate_limit' | 'invalid_content' | 'platform' | 'network';
    readonly retryable: boolean;
    /** 再試行してよくなる時刻。レート制限のときだけ入る。 */
    readonly retryAfter: string | null;
    /** 開発者向けの詳細。**利用者のコンテンツを含めない。** */
    readonly detail: string;
  } | null;
}

/** 媒体の制約。生成側（LlmClient）が文字数目安の入力に使う。 */
export interface PlatformLimits {
  readonly maxChars: number | null;
  /** 24時間あたりの投稿上限。null は不明・無制限。 */
  readonly dailyPostLimit: number | null;
}

export interface PlatformAdapter {
  readonly id: PlatformId;
  readonly execution: Execution;
  readonly limits: PlatformLimits;

  /** 認可の開始URL。state はクライアントが発行して渡す（§3-1 の CSRF 対策）。 */
  buildAuthorizeUrl(input: { state: string; redirectUri: string }): string | null;

  /** 投稿前の検証。API を呼ばずに落とせるものはここで落とす。 */
  validate(input: PublishInput): { ok: true } | { ok: false; reason: string };

  /**
   * 投稿する。
   *
   * `execution` が 'relay' のときも、この関数のシグネチャは変わらない。
   * 中に fetch 先が中継APIになるだけ。呼び出し側は実行場所を意識しない。
   */
  publish(input: PublishInput, credential: Credential): Promise<PublishResult>;
}
```

### 2-3. `manual` アダプタ（note）を同じ型に載せる理由

note には公式APIが無い（検証計画 §2）。**それでも同じ `PlatformAdapter` として扱う。**

`publish()` は「クリップボードへ整形済み本文を載せ、下書き画面のURLを返す」実装になり、
`PublishResult.status` は常に `failed`（`code: 'platform'`、`retryable: false`）ではなく、
**`published` でも `failed` でもない第3の状態が要る**——ように見える。

そうはしない。**note の `publish()` は「遷移URLを返して終わり」とし、
公開されたかどうかは利用者が手で登録する**（T4-3）。つまり:

- `publish()` は `status: 'failed'` / `code: 'platform'` / `retryable: false` を返し、
  `detail` に「note は手動公開」と書く
- UI 側が note だけ別の導線（コピー＋遷移＋URL登録）を出す

型を歪めるより、**UI が媒体を1つ特別扱いするほうが素直**である。
`execution: 'manual'` はそのための印になっている。

---

## 3. X の BYOキー／運営キー切り替え（BYO で確定・切替可能に）

**指示どおり、BYOキー前提で設計しつつ切り替え可能にする。**

切り替えで変わるのは `Credential` の作り方**だけ**にする。`publish()` の中身は
どちらでも同じ（同じAPI・同じエラー・同じレート制限ヘッダ）。

```ts
/** lib/pipeline/adapters/x-credential.d.mts（案） */

export type XKeyMode = 'byo' | 'shared';

/**
 * X の資格情報をどこから取るか。
 *
 * 'byo'    … 利用者がアプリに登録したキー（ブラウザ内保存）
 * 'shared' … 発注者名義のキー（中継APIのサーバー側でのみ読む。ブラウザへ出さない）
 *
 * **この関数だけが両方式の差を知っている。** アダプタ本体も UI も知らない。
 * 将来、運営キー共有へ戻す判断が出た場合に触るのはここと設定値のみ。
 */
export function resolveXCredential(mode: XKeyMode, memberKey: Credential | null): Credential;
```

| | BYOキー | 運営キー共有 |
| --- | --- | --- |
| キーの置き場所 | 利用者ブラウザ | Vercel の環境変数（サーバーのみ） |
| 費用の負担者 | 利用者 | 発注者（利用者数に比例して青天井） |
| 上限制御 | 利用者自身の支出上限 | カウンタ ＋ `X_MONTHLY_BUDGET_USD` |
| 発注者の審査作業 | **不要** | プロジェクト作成・支出上限設定 |
| 利用者の手間 | X Developer 登録が要る（T2-5 で成立性を検証） | なし |

> **切り替えは「設定値の変更」で済ませ、コードの分岐を増やさない。**
> 両方式を同時に走らせる要件は無いため、モードは環境変数1つで決める。

---

## 4. LlmClient

> **v0.6 で全面的に差し替わった。設計の正は [phase1-design.md](./phase1-design.md) §3 に移した。**
> ここに二重に書くと片方が古くなるため、本節は経緯と要点だけを残す。

### 4-1. 何が変わったか

| | v0.5 まで | **v0.6** |
| --- | --- | --- |
| プロバイダ | Anthropic（運営契約） | **Gemini（Google AI）** |
| APIキー | 発注者のもの。サーバーが保持 | **利用者のBYOキー。ブラウザの localStorage のみ** |
| 呼び出し元 | サーバー中継（`/pipeline/api/llm/`） | **ブラウザから直接**（CORS は本番で実証済み） |
| 費用 | 運営負担 → 月次上限で原価防衛 | **利用者負担 → 上限を撤廃** |
| 構造化出力 | `output_config.format` | **`responseSchema`**（`type` は**大文字**） |
| 出力上限 | `max_tokens`（思考＋本文） | **`maxOutputTokens`**（出力のみ） |
| 段階別つまみ | `effort` | **無し。** モデル選択が実質的な調整つまみ |

### 4-2. 維持したもの

指示どおり、骨子は変えていない。

- 段階別（`threads` / `x` / `note` / `script` / `metadata`）に出力量と構造化出力を割り当てる
- `script` はスキーマで**シーン構造を強制**し、生成後に非空検証をかける（**AC-09 の担保**）
- プロンプト（`RULES`）はプロトタイプから流用。FR-033（事実の捏造禁止）を常時含める
- `fetchImpl` を差し替え可能にし、テストで実APIを叩かない
- `LlmClient` インターフェース（`generate(input)` → `{ output, usage }`）はそのまま。
  **呼び出し側はプロバイダ固有の語彙を知らない**

### 4-3. 中継APIが消えたことの含意

v0.5 の本節には「中継APIが守ること」（本文をログへ出さない・例外に入力を混ぜない等）を
書いていたが、**中継そのものが無くなったため不要になった。**

> **Phase 1 のサーバー処理はゼロ**（guide §3-2）。守るべきログ規約は、
> Phase 2 で Threads / X の中継を作る時点で改めて要る。**そのときに §4-4 相当を復活させる。**

代わりに要るのは**ブラウザ側でのキーの取り扱い**で、これは
[phase1-design.md](./phase1-design.md) §3-6 と既存の
[keystore-spec-v1.md](../specs/keystore-spec-v1.md) に従う。


## 5. 未確定のまま残していること

推測で埋めていない。Phase 0 の結果か発注者の判断で埋まる。

| # | 未確定 | 埋まる時点 | 埋まるまでどうするか |
| --- | --- | --- | --- |
| 1 | Threads の `execution`（`browser` か `relay` か） | T1-6 | `relay` を既定として設計。通れば削る |
| 2 | X の認証を公開クライアント + PKCE にできるか | T2-2 | PKCE を第一候補（v0.5）。不可なら機密クライアントで中継 |
| 3 | カウンタの保存先 | T6-4 | インターフェースだけ切り、実装は後。**Supabase を採る場合は pipeline 専用の別プロジェクト**（v0.5 決定。`tsam-event` への相乗り不可） |
| 4 | 段階ごとの `max_tokens` の実測 | Phase 1 | §4-3 の表は見込み値。実測して差し替える |
| 5 | `Stage` に `'script'` を残すか | guide §6-7（FR-043 の扱い） | 残す前提。**(a) を採る場合は `'script'` と `'metadata'` を落とす** |

**1 が決まる前にアダプタを実装しない。** 実行場所はアダプタの中心概念であり、
後から変えると3媒体ぶん書き直すことになる。

### 拡張フェーズで戻ってくる未確定事項（v0.5 で凍結）

| 未確定 | 埋まる時点 |
| --- | --- |
| YouTube の `execution` | T3-7（凍結） |
| Google OAuth を機密クライアントにするか公開＋PKCE にするか | T3-1（凍結）/ review-submissions.md §3-5 |

> `buildAuthorizeUrl()` は両方を許す形に切ってあるので、
> **再開時にインターフェースを変えずに YouTube を足せる。**

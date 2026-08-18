# receipt-ocr への指摘（2026年8月4日）

名刺OCR（`card-ocr`）のフェーズ0で見つけて直した内容のうち、
**領収書OCR（`receipt-ocr`）に未反映のもの**をまとめる。

> **2026-08-18 追記：#1〜#7 と #9 は `receipt-ocr` 側で修正済み。**
> 各項の末尾に「修正（2026-08-18）」として、実際に入れた内容を書き足した。
> **#8（OCRが空だったことを画面へ伝えていない）だけが未対応で残っている**
> （下記のとおり、直し方が「読み直しの回数」という仕様判断を伴うため）。
> 以下の本文（現象・影響）は指摘当時のまま残す。**修正の理由が読めなく
> なるため、過去形へ書き換えない。**
>
> あわせて、この文書の対象外だった**「設定」タブの未配線**（`readSettings()` に
> 呼び出し元が無く、シートの閾値が実行時に効いていなかった件。
> `docs/system-design/receipt-ocr/03_detailed-design.md` §3.4 に記録があった）も
> 同日に配線した。
>
> **本文中の `card-ocr/poc/...` へのリンクは切れている。** 検証用ディレクトリは
> 廃止され、同名のファイルが `public/production-app/card-ocr/` 直下にある
> （`poc/` を挟まないパスで読むこと）。

## この文書の位置づけ

- **（2026-08-04 時点）`receipt-ocr` のコードは変更していない。** 別の作業ラインの
  ものなので、指摘として残すに留める。直すかどうかは `receipt-ocr` 側で判断する
  （→ 2026-08-18 に修正した。上の追記を参照）
- 見つかった経緯は、`card-ocr` を実装するにあたって
  [repository-structure.md](./repository-structure.md) §4-1 の「共通層を作らず
  複製する」方針を決めるため、両アプリの全ファイルを突き合わせたこと
- 同 §4-3 のとおり、**`card-ocr` へ複製するときは直したうえで写す。**
  したがって `receipt-ocr` を直さないままでも `card-ocr` に不具合は入らない。
  ただし2つのアプリの挙動が食い違ったままになる
- 行番号は 2026年8月4日時点（`main` の `295ce09`）のもの。
  変わりうるので、探すときは関数名で当たること

## 一覧

| # | 現象 | 場所 | 重さ | 状態 |
| --- | --- | --- | --- | --- |
| 1 | GIS の読み込みに一度失敗すると、再読み込みまで Google 連携できない | `oauth.js` `loadGis` | **高** | 2026-08-18 修正済み |
| 2 | Drive のレート制限（403）で、有効なトークンを捨てて再連携を促す | `errors.js` `mapGoogleError` → `app.js` | **高** | 2026-08-18 修正済み |
| 3 | Gemini の 400 を「APIキーの問題」と案内する | `gemini-client.js` `mapGeminiError` | 中 | 2026-08-18 修正済み |
| 4 | 同意画面でスコープのチェックを外されても先へ進む | `oauth.js` `requestAccess` | 中 | 2026-08-18 修正済み |
| 5 | 429 と 5xx が 400 と一緒くたになり、無関係な文言が出る | `errors.js` `mapGoogleError` | 中 | 2026-08-18 修正済み |
| 6 | 消し損ねた一時ドキュメントを回収する経路が無い | `ocr-drive.js`（該当コードなし） | 中 | 2026-08-18 修正済み |
| 7 | multipart の boundary が内容から決まる | `ocr-drive.js` `uploadForOcr` | 低 | 2026-08-18 修正済み |

あわせて、**不具合ではないが書いたものが使われていない箇所**を2件（#8・#9）。
状態は #8 が未対応、#9 が 2026-08-18 修正済み（既定は無効の選択式）。

---

## 1. GIS の読み込みに一度失敗すると、再読み込みまで Google 連携できない

**重さ: 高**

### 現象

[oauth.js](../public/production-app/receipt-ocr/oauth.js) の `loadGis` は、
`gisPromise` に読み込みの Promise を保持して2回目以降を省く。
`script` の `error` で reject するが、**reject した Promise が
`gisPromise` に残り続ける。**

```js
let gisPromise = null;

function loadGis() {
  if (gisPromise) {
    return gisPromise;        // ← 失敗した Promise もここで返る
  }
  gisPromise = new Promise((resolve, reject) => {
    ...
    script.addEventListener('error', () => reject(new AppError('OAUTH-001', ...)));
  });
  return gisPromise;
}
```

### 影響

一時的な通信の失敗や、広告ブロッカーが一瞬効いただけでも、
**そのページを開いているあいだ Google 連携が二度と成功しない。**
利用者から見ると「連携ボタンを何度押しても同じエラーが出る」状態で、
ページを再読み込みするしか復旧手段が無い。案内文（`OAUTH-001`）は
「もう一度お試しください」なので、**案内どおりにしても直らない。**

加えて `<script>` の読み込みに時間制限が無いため、応答が返らない場合は
`error` も `load` も発火せず、待ち続ける。

### card-ocr での直し方

[gis-loader.js](../public/production-app/card-ocr/poc/gis-loader.js) を参照。

- 失敗したら `gisPromise` を `null` に戻す（`loadGis` の `catch`）
- 10秒のタイムアウトを置く（`GIS_LOAD_TIMEOUT_MS`）
- すでに読み込み済みかを `isGisLoaded()` で判定する
- テストのために `resetGisLoader()` を用意する

### 修正（2026-08-18）

`oauth.js` の `loadGis` を上記の形へ置き換えた（`card-ocr/gis-loader.js` を
複製し、エラーを `AppError` に合わせただけ。共通層は作らない）。

- 失敗時は `gisPromise` を捨てる（`gisPromise.catch` でキャッシュのみ破棄）
- `GIS_LOAD_TIMEOUT_MS = 10000` のタイムアウト（`gis_timeout`）
- 読み込めても `google.accounts.oauth2` が無い場合を `gis_unavailable` として別扱い
- `isGisLoaded()` / `resetGisLoader()` を公開

検証: `tests/unit/receipt-ocr.mjs`「§4-2 GIS の読み込み（失敗を握り続けない）」。
一度失敗させてから同じページで再試行し、`<script>` が作り直されることを見ている。

---

## 2. Drive のレート制限（403）で、有効なトークンを捨てて再連携を促す

**重さ: 高**

### 現象

[errors.js](../public/production-app/receipt-ocr/errors.js) の `mapGoogleError` は、
403 のうち容量不足だけを `DRV-003` にし、**それ以外の 403 をすべて
`OAUTH-001`（認可の問題）にしている。**

```js
if (status === 403) {
  return /storageQuotaExceeded|insufficientStorage|quotaExceeded/i.test(code)
    ? 'DRV-003'
    : 'OAUTH-001';
}
```

`OAUTH-001` は `GUIDE.REAUTH` を持つため、[app.js](../public/production-app/receipt-ocr/app.js)
が `forgetToken()` を呼んでトークンを破棄し、「未連携」に戻す。

### 影響

Drive API はレート制限を **403（`userRateLimitExceeded` / `rateLimitExceeded`）**
で返すことがある。このとき、**まだ有効なトークンを捨てて、利用者に
Google の同意画面をもう一度踏ませる。**

利用者から見ると「連携し直したのにまた失敗する」ことになり、
待てば直る問題を、待てば直らない問題に変えてしまう。

なお正規表現の `quotaExceeded` は `userRateLimitExceeded` に一致しない
（`quotaExceeded` という並びを含まないため）。

### card-ocr での直し方

[drive-api.js](../public/production-app/card-ocr/poc/drive-api.js) の
`mapDriveStatus` を参照。403 を `FORBIDDEN` として認可エラーと分け、
429 を `RATE_LIMITED` として独立させている。

**ただし `card-ocr` 側も 403 の内訳（容量不足とレート制限）を分けていない。**
`receipt-ocr` の `DRV-003`（容量不足）の判定は良いので、
統合するなら「容量不足 / レート制限 / 権限不足」の3つに分けるのが正しい。

### 修正（2026-08-18）

`errors.js` の `mapGoogleError` で 403 を3つに分けた（上記のとおり）。

| 403 の reason | コード | 誘導 |
| --- | --- | --- |
| `storageQuotaExceeded` / `insufficientStorage` | `DRV-003` | なし |
| `rateLimitExceeded` 系 / `dailyLimitExceeded` / `quotaExceeded` | `RATE-001`（新設） | **なし（トークンを捨てない）** |
| それ以外 | `DRV-004`（新設） | 再連携 |

- 正規表現の順序に意味がある（`storageQuotaExceeded` は `quotaExceeded` にも
  一致するため、容量不足を先に見る）
- `RATE-001` の `guide` は `GUIDE.NONE`。**ここを `REAUTH` にすると元の不具合に戻る**
- `drive.js` の `getFileMeta` は 403 を「触れない＝無い」として `null` に落とす
  経路を持っていたため、その catch へ `DRV-004` を足した。足さないと、
  記憶した ID へ触れなくなった利用者が §9.2-3 の名前検索へ進めなくなる

検証: `tests/unit/receipt-ocr.mjs`「§12 エラーコード」。
レート制限の各 reason と、`RATE-001` の誘導が再連携でないことを見ている。

---

## 3. Gemini の 400 を「APIキーの問題」と案内する

**重さ: 中**

### 現象

[gemini-client.js](../public/production-app/receipt-ocr/gemini-client.js) の
`mapGeminiError`:

```js
if (status === 400 || status === 401 || status === 403) {
  return 'KEY-002';
}
```

### 影響

400 は**リクエストの形が不正**という意味で、キーとは関係がない。
`responseSchema` の書き方、`generationConfig` の値、モデル名の指定など、
こちら側の作りが原因である。それを「APIキーを確認してください」と案内すると、
**利用者は自分のキーを疑い、作り直し、それでも直らない**ことになる。

`card-ocr` のフェーズ0で実際にこれが起きた。`responseSchema` の `type` を
小文字で送っていたために 400 が返り、キーの問題として表示されていた
（[specs/card-ocr-phase0-plan.md](./specs/card-ocr-phase0-plan.md) §7-5-2）。

### card-ocr での直し方

[gemini.js](../public/production-app/card-ocr/poc/gemini.js) の `mapStatus` を参照。

| ステータス | 分類 | 表示 |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | `AI-003`。「送信内容に問題があります」。**キーを疑わせない** |
| 401 / 403 | `KEY_REJECTED` | `KEY-002` |
| 404 | `MODEL_NOT_FOUND` | フォールバックモデルへ1回 |
| 429 | `RATE_LIMITED` | `AI-002` |
| 500番台 | `SERVER_ERROR` | 503 は「混雑」として別文言 |

### 修正（2026-08-18）

`gemini-client.js` の `mapGeminiError` を上表に合わせた。

- 400 → `AI-003`（新設）。文言は「AI への送信内容に問題がありました。
  アプリ側の不具合の可能性があります。**APIキーの再設定では直りません**」
- 401 / 403 → `KEY-002`（従来どおり）
- 500番台 → `SRV-001`（新設。Drive 側と共通）
- 通信断 → `NET-001`（新設）。`OCR-001`（読み取れなかった）と混ぜない

検証: `tests/unit/receipt-ocr-phase2.mjs`「§6 / §12 Gemini：キーの送り方とエラー分類」。

---

## 4. 同意画面でスコープのチェックを外されても先へ進む

**重さ: 中**

### 現象

[oauth.js](../public/production-app/receipt-ocr/oauth.js) の `requestAccess` の
`callback` は、`response.access_token` の有無しか見ていない。

Google の同意画面は、要求したスコープを利用者が**個別に外せる。**
外された場合でもトークン自体は発行されるため、この判定は通る。

### 影響

`drive.file` を外されたまま処理が始まり、**最初の Drive API 呼び出しで
初めて失敗する。** そのときのエラーは 403 なので、#2 と重なって
「トークンを捨てて再連携」になり、利用者は同じ画面で同じチェックを
外し続ける可能性がある。

失敗する場所も分かりにくい。保存先の作成（`provisioning`）まで進んでから
落ちるため、「連携はできたのに保存先が作れない」という見え方になる。

### card-ocr での直し方

[drive-auth.js](../public/production-app/card-ocr/poc/drive-auth.js) の
`hasDriveScope()` を参照。`google.accounts.oauth2.hasGrantedAllScopes` で
付与を確認し、足りなければ `SCOPE_NOT_GRANTED` として
**その場で拒否する**（`ensureAccessToken` 内）。案内も
「Google ドライブへの権限が許可されていません」と具体的にできる。

あわせて `pendingRequest` でポップアップの二重起動も防いでいる。

### 修正（2026-08-18）

`oauth.js` の `requestAccess` の `callback` で、`hasRequiredScope(response)` を
確かめてから受け入れるようにした。足りなければ `OAUTH-002`（新設）で
その場で拒否する。文言は「Google ドライブへのアクセスが許可されていません。
連携の画面でチェックを外さずに『続行』してください」。

- 判定は `google.accounts.oauth2.hasGrantedAllScopes` を優先し、
  無ければ応答の `scope` 文字列で見る
- **判定できないとき（`scope` が返らない）は通す。** ここで拒否側に倒すと、
  GIS の応答が変わったときに正しく許可した利用者まで弾いてしまう。
  その場合は従来どおり最初の Drive 呼び出しで失敗する（#2 の修正により、
  そこでトークンを捨てることはもう無い）
- `pending` フラグでポップアップの二重起動も止めた

検証: `tests/unit/receipt-ocr.mjs`「§4-2 GIS の読み込み」節の後半。

---

## 5. 429 と 5xx が 400 と一緒くたになり、無関係な文言が出る

**重さ: 中**

### 現象

[errors.js](../public/production-app/receipt-ocr/errors.js) の `mapGoogleError` は、
401 / 403 / 404 以外を**すべて `SHEET-001` にしている**（最終行の `return`）。
`SHEET-001` の文言は「シートへの書き込みに失敗しました。もう一度お試しください。」

[google-api.js](../public/production-app/receipt-ocr/google-api.js) の
`callGoogle` は、ネットワーク自体の失敗も同じ経路へ流す。

### 影響

- **Drive への画像アップロードが 429 で失敗しても「シートへの書き込みに
  失敗しました」と表示される。** 利用者は何が起きたか分からない
- 5xx（Google 側の一時的な障害）も同じ文言になる。**待てば直るのかどうかが
  伝わらない**
- ネットワーク断も同じ。「通信できません」と言うべき場面で
  シートの話をしている

500番台を「未知」に落としてはいないが、**中身の違う失敗を1つの文言に
まとめている**という点では同じ問題である。`card-ocr` のフェーズ0では、
これが原因で 503（混雑）を SYS-999 として何時間も誤診した。

### card-ocr での直し方

[drive-api.js](../public/production-app/card-ocr/poc/drive-api.js) の
`mapDriveStatus` と、[gemini.js](../public/production-app/card-ocr/poc/gemini.js) の
`summarizeErrorBody()` を参照。

- 429 を `RATE_LIMITED` として独立させる
- **エラー応答の本文を読んで、原因の要約を画面へ出す。**
  読み捨てると、あとから切り分けられない
- 503 は「混雑しています。時間をおいてお試しください」と、
  待てば直ることが伝わる文言にする

> **`card-ocr` 側にも同種の弱点が1つ残っている。** `drive-api.js` は
> 500番台を `UNKNOWN` に落としている。フェーズ1で直す。
> （2026-08-18 時点の `card-ocr/drive-api.js` は 500番台を `SERVER_ERROR` として
> 分けており、この弱点は解消済み。）

### 修正（2026-08-18）

`mapGoogleError` を「利用者が次に何をすればよいか」で分けた。

| 状況 | コード | 意味 |
| --- | --- | --- |
| 400 | `SYS-001`（新設） | こちらの組み立てが不正。利用者の操作では直らない |
| 429・403 のレート制限 | `RATE-001`（新設） | 待てば直る |
| 500番台 | `SRV-001`（新設） | Google 側の一時障害・混雑。待てば直る |
| 通信断 | `NET-001`（新設） | 通信を確かめる |
| 分類できないもの | `SHEET-001` | 従来どおりの受け皿 |

`google-api.js` の `callGoogle` / `callGoogleText` も、通信失敗を
`SHEET-001` から `NET-001` へ変えた。中断（`AbortError`）は
`detail: 'aborted'` として通信断と区別する。

**応答本文は画面へ出さない方針を維持した**（§13）。`card-ocr` は
`summarizeErrorBody()` で本文の要約を画面へ出しているが、`receipt-ocr` は
領収書の中身や利用者のファイル名が混じりうる値を画面へ運ばない設計なので、
`AppError.detail` に Google の定義した reason 識別子だけを残す
（例: `http_403_userRateLimitExceeded`）。**画面に出るのはコードと文言だけ。**

---

## 6. 消し損ねた一時ドキュメントを回収する経路が無い

**重さ: 中**

### 現象

[ocr-drive.js](../public/production-app/receipt-ocr/ocr-drive.js) の `recognize` は
`finally` で一時ドキュメントを消しており、**この点は正しい。**
問題は、その削除が失敗したときである。

`drive.js` の `deleteFile` は失敗を握って `false` を返すが、
`recognize` はその戻り値を見ていない。そして**残ったファイルを
あとから見つけて消す経路が、アプリのどこにも無い。**

### 影響

削除に失敗するのは、通信断・タブを閉じた・トークン失効といった場面で、
まれではあるが必ず起きる。回収する経路が無いと、**利用者のドライブに
`ocr-tmp-*` という名前のドキュメントが少しずつ溜まる。**

一時ドキュメントは OCR 結果のテキストを含むため、
**領収書の中身がドライブに残り続ける**ことになる。
「一時ファイルは即時に完全削除する」という設計方針が、
失敗経路で崩れている。

### card-ocr での直し方

[drive-ocr.js](../public/production-app/card-ocr/poc/drive-ocr.js) の
`collectOrphanTempDocs()` を参照。

- 一時ドキュメントの名前を **固定の接頭辞＋タイムスタンプ**にする
  （`receipt-ocr` は `ocr-tmp-${利用者のファイル名}` で、接頭辞はあるが
  利用者のファイル名が入るため検索条件が組みにくい）
- 起動時にその接頭辞で検索し、見つかったものを消す
- 結果を画面に出す（見つけた件数 / 消せた件数）

### 修正（2026-08-18）

`ocr-drive.js` に `collectOrphanTempDocs()` を足し、`app.js` の
プロビジョニング成功直後に呼ぶようにした（`ocr.js` の `collectOrphans()` 経由。
案C を選んでも画面側が分岐しなくて済むよう、窓口の形は揃えてある）。

- 一時ドキュメントの名前を `receipt-ocr-tmp-<時刻>-<通し番号>` に変えた。
  **利用者のファイル名を入れない**（検索条件が組めないうえ、
  領収書のファイル名がドライブ上に残ることになるため）
- 旧名 `ocr-tmp-*` も回収対象に含める（すでに溜まっている分を片づけるため）
- `name contains` で拾い、**接頭辞で始まるものだけ**に絞り直す
  （利用者自身のファイルを巻き込まないため）
- **作成から10分以内のものは消さない**（`ORPHAN_MIN_AGE_MS`）。
  複数タブで使っているとき、もう片方が処理中の一時ドキュメントを
  消しうるため。これは複製元（`card-ocr`）には無い上乗せ
- `recognize()` は削除の成否を `deleted` として返すようになった
  （`drive.js` の `deleteFile` の戻り値を握りつぶしていた）
- 見つけた件数・消せた件数は画面の案内へ書き足す（`appendInfo`）

検証: `tests/unit/receipt-ocr-phase2.mjs`「§9.5 一時ドキュメントの名前と boundary」。

---

## 7. multipart の boundary が内容から決まる

**重さ: 低**

### 現象

[ocr-drive.js](../public/production-app/receipt-ocr/ocr-drive.js) の `uploadForOcr`:

```js
const boundary = `ocr-${blob.size}-${blob.type.length}`;
```

同じく `drive.js` の `uploadImage` は `Math.random()` を使っている。

### 影響

boundary の要件は「**その本文の中に同じ並びが現れないこと**」である。
`ocr-123456-10` のような短い ASCII 列が JPEG のバイナリに現れる確率は
低いが、**低いと言える根拠が無い**（画像の中身は利用者が決める）。
現れた場合、multipart の解釈が壊れてアップロードが失敗する。

再現しないので、起きたときに原因を突き止めるのが難しい種類の問題である。

### card-ocr での直し方

[drive-api.js](../public/production-app/card-ocr/poc/drive-api.js) の
`createBoundary()` を参照。`crypto.randomUUID()` →
`crypto.getRandomValues()` → 時刻の三段で落とす。

### 修正（2026-08-18）

`drive.js` に `createBoundary()` を複製し、`uploadImage`（原本）と
`ocr-drive.js` の `uploadForOcr`（一時ドキュメント）の両方で使うようにした。

検証: `tests/unit/receipt-ocr-phase2.mjs`。同じ画像でも boundary が毎回変わること、
`ocr-<サイズ>-<MIMEの長さ>` の形に戻っていないことを見ている。

---

## 8. OCR が空だったことを画面へ伝えていない（不具合ではない）

[ocr.js](../public/production-app/receipt-ocr/ocr.js) の `recognize` は
`{ engine, text, empty }` を返すが、**`empty` を読む箇所が無い**
（[app.js](../public/production-app/receipt-ocr/app.js) の呼び出し）。

そのため、OCR が空文字を返しても抽出・検証へそのまま進み、
すべての項目が空の確認画面が出る。`errors.js` の `OCR-001`
（「文字を読み取れませんでした。要確認として保存するか選んでください」）へ
到達する経路が、実質的に存在しない。

`card-ocr` は空のとき最大3回まで読み直し（`drive-ocr.js` の `OCR_MAX_ATTEMPTS`）、
尽きたら `OCR-002` にしている。

### 状態（2026-08-18）: **未対応**

7件の欠陥修正の対象から外した。理由は次の2つ。

- **仕様の判断が要る。** `card-ocr` に合わせるなら「空なら最大◯回読み直す」に
  なるが、読み直しは利用者の Drive クォータを消費する。回数と、
  尽きたときの扱い（`OCR-001` で止めるか、空のまま確認画面へ進めるか）は
  仕様書 §12 の `OCR-001`（「要確認として保存するか選んでください」）の
  解釈にかかわる。実装だけで決めない
- 現状でも**データは壊れない。** 空文字のまま進むと必須項目検証で
  `required.ok=false` となり `reviewStatus=REQUIRED` になる。
  失われるのは「なぜ空なのか」という案内だけである

直すときは、読み直しの回数を設定タブへ置く（`OCR文字数の最低基準` の隣）か、
回数を仕様書で決めてから入れること。

## 9. 画像の縮小が実装されていない（不具合ではない）

[config.js](../public/production-app/receipt-ocr/config.js) に
`IMAGE_MAX_EDGE_PX = 2000` があるが、**リポジトリ全体で他に参照が無い。**
`app.js` は `selected.file` をそのまま `recognize` へ渡している。

高画素のスマートフォンで撮った写真がそのまま上がるため、
アップロードに時間がかかり、Drive の容量も余計に使う。

`card-ocr` は要件定義書 §8.2 で長辺1,600〜2,000px・1.5MB以下と定めており、
フェーズ2で `card-scanner/capture.js` の `shrinkToJpeg` を複製する予定。
共通化はしないが、**同じ問題を2回考えなくて済むよう、ここに書いておく。**

### 修正（2026-08-18）: 選択式で実装

`card-ocr/capture.js` の縮小部分を `receipt-ocr/image.js` へ複製した
（`fitSize` / `loadImage` / `shrinkToJpeg` / `isHeic`。撮影・回転・
ファイル名の組み立ては持ち込んでいない）。`IMAGE_MAX_EDGE_PX` は
`image.js` の `MAX_EDGE` として実際に参照されるようになった。

複製元と変えた点は3つ。**いずれも領収書に固有の事情による。**

- **既定は無効。** 画面のチェックボックスで利用者が選んだときだけ縮める。
  仕様書 §14 が「オプションを設ける」と書いており、常時実行ではない。
  領収書の原本は後から見返す証跡であり、こちらの都合で既定の画質を落とさない
- **失敗しても保存を止めない。** `card-ocr` は 1.5MB に収まらなければ
  `IMG-002` で撮り直しを求めるが、こちらは原本のまま上げて先へ進む
  （縮小は速さのための手段であって、保存の前提ではない）
- **SHA-256 は選ばれた元のファイルから取る**（従来どおり）。縮小後の
  バイト列はブラウザや実装で変わりうるため、そこから取ると同じ写真を
  2回上げたときに重複判定（§10）が働かなくなる

あわせて HEIC を `isHeic()` で見分け、「JPEG または PNG を選んでください」
ではなく、iPhone の設定を変える道まで案内するようにした。
**HEIC のブラウザ内変換自体は実装していない**（仕様書 §3.1 は
「変換できた場合のみ」としており、変換手段を持たない状態は仕様に反しない）。

---

## 逆方向 — `receipt-ocr` にあって `card-ocr` に無いもの

指摘ではなく、**`card-ocr` が取り込む側**の記録。フェーズ1で反映する。

| 内容 | 場所 |
| --- | --- |
| **CSP を `index.html` の meta で宣言** | `index.html`。`next.config.ts` を触らずに掛けられる |
| 数式エスケープの対象がタブ・CR も含む（`/^[=+\-@\t\r]/`） | `sheets.js` の `escapeFormula` |
| `valueInputOption=RAW` による二重防御 | `sheets.js` |
| 既存シートの健全性検査（列が改変されていたら書き込みを止める） | `provisioning.js` の `inspectSpreadsheet` |
| `AbortSignal` が全層に貫通している | `google-api.js` ほか |
| 画像の SHA-256 と重複判定 | `hash.js` |
| 保存先IDの形式検証 | `store.js` の `isFileId` |
| `pagehide` でトークンとプレビューURLを破棄 | `app.js` |
| 同名フォルダが重複したとき**古いほうを採り、そのことを案内する** | `drive.js` / `provisioning.js` の `DUPLICATE_STRUCTURE` |

最後の1件は方針が正反対だった（`card-ocr` は新しいほうを黙って採る）。
**`receipt-ocr` が正しい。** 先に作られたほうが正本であり、
どちらを使ったかを黙っているべきではない。`card-ocr` 側を合わせる。

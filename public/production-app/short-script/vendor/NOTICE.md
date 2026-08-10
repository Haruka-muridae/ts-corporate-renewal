# 同梱ライブラリに関する表示(NOTICE)

このディレクトリ(`vendor/`)は、スマホ完結版 体験試作(M1、mobile-lab)が
端末内で音声合成・字幕描画・動画多重化を行うために同梱している第三者ライブラリと
モデル・フォントの置き場所である。承認の経緯は
[docs/external-dependency-approvals.md](../../../../docs/external-dependency-approvals.md) の
「2-1. mobile-lab(スマホ完結版 体験試作)」を参照。

整合確認(SHA-256・npm最新版)は `npm run check:vendor:short-script-mobile` で行う。
分割・マニフェスト生成は `node scripts/short-script-vendor/build-manifest.mjs`
(このリポジトリのルートから実行)。生成物は
[vendor-manifest.json](./vendor-manifest.json)。

---

## piper-plus(`piper/`)

- npmパッケージ名 : `piper-plus`
- バージョン      : 0.6.0
- 配布元(npm)     : https://registry.npmjs.org/piper-plus/-/piper-plus-0.6.0.tgz
- ソースリポジトリ: https://github.com/ayutaz/piper-plus
- ライセンス      : MIT([LICENSE.md](./piper/LICENSE.md))
- 同梱ファイル    :
  - `src/**`(ESM本体。相対importで構成される複数ファイル)
  - `dist/rust-wasm/piper_plus_wasm.js`(wasm-bindgen生成のグルーコード)
  - `dist/rust-wasm/piper_plus_wasm_bg.wasm`(Rust製G2P。OpenJTalk+NAIST-JDIC同梱で
    約58MB。**25MiB超のため3分割**して同梱。分割・SHA-256は
    [vendor-manifest.json](./vendor-manifest.json) の `piper-plus.g2p-wasm` を参照)
- 第三者コンポーネント: OpenJTalk・HTS Engine API・MeCab・NAIST-JDIC(いずれも
  BSD-3-Clause)が wasm バイナリに静的リンクされている。全文は
  [THIRD-PARTY-LICENSES.md](./piper/THIRD-PARTY-LICENSES.md)(piper-plus配布物に同梱の原文)。

## つくよみちゃん ONNXモデル(`model/`)★未取得

- 配布元          : Hugging Face `ayousanz/piper-plus-tsukuyomi-chan`(このリポジトリ
  の配布元はここのみ。ミラーは確認できなかった)
- ライセンス      : MIT(モデル)。話者の利用条件として「つくよみちゃん」の
  クレジット表記が必要(M3でアプリ内・ヘルプへ表記する。§5未解決事項)
- 想定ファイル    : `tsukuyomi-chan-6lang-fp16.onnx`(約39.65MB)・`config.json`
- **状態: 未取得。** この試作の作成環境は huggingface.co への通信が組織の
  egressポリシーで全面遮断されており(403 policy denial。代替の配布経路も
  確認できなかった)、実物を取得できなかった。[vendor-manifest.json](./vendor-manifest.json)
  の `tsukuyomi.model` / `tsukuyomi.model-config` は `unavailable: true` として
  理由つきで記録している。偽のバイト列・偽のSHA-256は置いていない。
  読み込み側(`mobile-lab/app.js`)はモデルが揃うまで「音声を合成する」を
  無効化し、理由を画面に表示する。

## onnxruntime-web(`ort/`)

- npmパッケージ名 : `onnxruntime-web`
- バージョン      : 1.27.0
- 配布元(npm)     : https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.27.0.tgz
- ソースリポジトリ: https://github.com/microsoft/onnxruntime
- ライセンス      : MIT([LICENSE](./ort/LICENSE)。npm配布物にLICENSEが同梱されて
  いないため、上流リポジトリの `LICENSE` から複製)
- 同梱ファイル    : `ort.wasm.min.mjs`(CPU/wasmバックエンドのみの最小ビルド。
  WebGL/WebGPUバックエンドは含めない)・`ort-wasm-simd-threaded.wasm`(約13MB。
  単スレッドでも動作する。§2.2「SharedArrayBufferを要求しない」)
- 採用しなかったもの: `ort-wasm-simd-threaded.jsep.wasm`(WebGPU用。約26MB)・
  `.asyncify.wasm`・`.jspi.wasm` は本アプリでは使わないため同梱しない
  (VITS推論はint64テンソルを使い、WebGPUバックエンドでは動かないため。
  `piper/src/webgpu-session-manager.js` 冒頭のコメント参照)

## JASSUB(`jassub/`)

- npmパッケージ名 : `jassub`
- バージョン      : 2.5.14
- 配布元(npm)     : https://registry.npmjs.org/jassub/-/jassub-2.5.14.tgz
- ソースリポジトリ: https://github.com/ThaUnknown/jassub
- ライセンス      : `jassub` 本体はMIT([LICENSE](./jassub/LICENSE))。
  wasmバイナリには libass(LGPL-2.1-or-later)・FreeType(FTL)・その他
  (ISC / NTP / Zlib / BSL-1.0)が静的リンクされている。全文は
  [THIRD-PARTY-NOTICES.txt](./jassub/THIRD-PARTY-NOTICES.txt)
  (jassub本体のビルドスクリプト `build/license_fullnotice` から複製)。
- 同梱ファイル    : `dist/jassub.js`・`dist/worker/worker.js`・
  `dist/worker/renderers/*.js`・`dist/wasm/jassub-worker.js`・
  `dist/wasm/jassub-worker.wasm`(約2MB)・`dist/default.woff2`(JASSUB既定の
  フォールバックフォント。字幕自体は同梱のNoto Sans JPを使う)
- **採用しなかったもの**: SIMD最適化版の `jassub-worker-modern.wasm`
  (約2.1MB)は同梱しない。理由はサイズ削減(合計ダウンロード量を70MB台に
  近づける)。`mobile-lab/app.js` は `wasmUrl` と `modernWasmUrl` の両方を
  明示的に標準wasmへ向けており、既定の(未同梱の)modern wasmへは
  フォールバックしない。設計文書からの逸脱として報告済み。

## Mediabunny(`mediabunny/`)

- npmパッケージ名 : `mediabunny`
- バージョン      : 1.53.0
- 配布元(npm)     : https://registry.npmjs.org/mediabunny/-/mediabunny-1.53.0.tgz
- ソースリポジトリ: https://github.com/Vanilagy/mediabunny
- ライセンス      : **MPL-2.0**(設計文書 §4.3 で「要確認」としていたものを
  実物のLICENSEファイルで確認・確定。[LICENSE](./mediabunny/LICENSE))
- 同梱ファイル    : `mediabunny.min.mjs`(`dist/bundles/mediabunny.min.mjs`。
  単一バンドル、ソース非改変)

## Noto Sans JP(`fonts/`)

- 配布元          : Google Fonts 公式リポジトリ
  `https://github.com/google/fonts`(`ofl/notosansjp/`)
- ライセンス      : SIL Open Font License 1.1([OFL.txt](./fonts/OFL.txt))
- 同梱ファイル    : `NotoSansJP-Variable.ttf`(Variable Font、約9.2MB)
- **設計文書からの逸脱**:
  1. Hugging Faceと同様の理由でNPMパッケージ(`@fontsource/noto-sans-jp`)は
     Unicode範囲ごとに細分化されたサブセット配布のみで、単一の通常ウェイト
     ファイルを直接配布していなかったため採用せず、Google Fonts公式配布の
     Variable Fontを採用した。
  2. 設計文書は「日本語サブセットフォント(常用漢字+かな+記号、数MB)を基本」
     としていたが、本ファイルはサブセット化していないVariable Font(1ウェイト
     運用、既定インスタンスはRegular)。10MB未満(約9.2MB)であり、
     サブセット化パイプラインの保守コストを避ける判断をした
     (タスク指示の「10MB以下ならサブセット化不要」に従った)。

---

## 改変

いずれのライブラリも中身は改変していない(コピーのみ)。
`jassub-worker-modern.wasm` を同梱しない判断や、25MiB超ファイルの機械的な
バイト分割は「同梱するファイルの取捨選択・分割」であり、ライブラリ内部の
コード改変ではない。

## 更新時の注意

- 版を上げたら `node scripts/short-script-vendor/build-manifest.mjs` を
  再実行し、[vendor-manifest.json](./vendor-manifest.json) を作り直す。
- このNOTICE.mdのバージョン表記も合わせて更新する。
- `npm run check:vendor:short-script-mobile` でSHA-256の整合とnpm最新版を
  確認できる(自動更新はしない)。

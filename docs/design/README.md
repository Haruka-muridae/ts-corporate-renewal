# 詳細設計書ディレクトリ

本番アプリ（`public/production-app/`）と共通層（`public/auth/`）が
**どう出来ているか**を記述した文書群。

制定: 2026年8月18日

---

## この文書群の位置づけ

```
docs/specs/ ・ docs/requirements/（要件定義書・仕様書＝何を作るか）  ← 正
        ↑ 参照（§n で指す）
docs/design/（詳細設計書＝どう出来ているか）                        ← 下位
        ↑ 記述対象
public/production-app/ ・ public/auth/（実装）
```

| 食い違い | どちらが正か |
| --- | --- |
| 詳細設計書 ↔ 要件定義書・仕様書 | **要件定義書・仕様書** |
| 詳細設計書 ↔ 実装 | **実装**（設計書は実装を記述する文書だから） |
| 実装 ↔ 要件定義書・仕様書 | **要件定義書・仕様書。** 直さずに [findings-2026-08.md](./findings-2026-08.md) へ起票する |

**要件定義書に書いてあることを、ここへ写さない。参照する。**
（[../specs/README.md](../specs/README.md) の「二重管理をしない」と同じ方針。）

---

## 何のために書かれたか

**他のプロダクトへ組み込めるようにするため**である。

このリポジトリは「アプリ間で共通層を作らず、必要なら複製する」方針を採っている
（[../repository-structure.md](../repository-structure.md) §4-1）。
複製を前提にする以上、**複製する側が読むための文書**が要る。
各設計書の **§7「移植」** がその中心で、移植単位・置換点・前提・
持ち出してはいけないものを書いてある。

作業の経緯と手順は
[../instructions/2026-08-18-app-design-docs-handoff.md](../instructions/2026-08-18-app-design-docs-handoff.md)。

---

## 文書一覧

### 横断

| 文書 | 内容 |
| --- | --- |
| [component-catalog.md](./component-catalog.md) | 繰り返し使われている実装単位（9系統）の系譜・分岐・**一致率の実測** |
| [auth-shared-design-v1.md](./auth-shared-design-v1.md) | 共通層 `public/auth/`。**移植時に「まず外す」層の外し方**を含む |
| [findings-2026-08.md](./findings-2026-08.md) | 設計書を書く過程で見つかった乖離・課題（**コードは直していない**） |

### アプリ別

| アプリID | 文書 | 特徴（設計上の重心） |
| --- | --- | --- |
| `threads-post` | [threads-post-design-v1.md](./threads-post-design-v1.md) | 投稿系の**原型**。他2本はこれの差分 |
| `x-post` | [x-post-design-v1.md](./x-post-design-v1.md) | 280ウェイト計数 |
| `note-post` | [note-post-design-v1.md](./note-post-design-v1.md) | プリフィル不可のための2段階コピー |
| `voice-recorder` | [voice-recorder-design-v1.md](./voice-recorder-design-v1.md) | 90分の逐次エンコードと OPFS・再開可能アップロード |
| `audio-transcriber` | [audio-transcriber-design-v1.md](./audio-transcriber-design-v1.md) | 端末内 Whisper と Gemini の二択 |
| `meeting-minutes` | [meeting-minutes-design-v1.md](./meeting-minutes-design-v1.md) | **根拠のクライアント側照合** |
| `card-ocr` | [card-ocr-design-v1.md](./card-ocr-design-v1.md) | ルール抽出と Gemini の突き合わせ |
| `card-mail` | [card-mail-design-v1.md](./card-mail-design-v1.md) | 台帳を**読むだけ**・BCC 一斉送信 |
| `receipt-ocr` | [receipt-ocr-design-v1.md](./receipt-ocr-design-v1.md) | 判断と通信の分離・独立2経路 |
| `short-script` | [short-script-design-v1.md](./short-script-design-v1.md) | ローカル補助サービスとの NDJSON 連携 |
| `calendar-url-notifier` | [calendar-url-notifier-design-v1.md](./calendar-url-notifier-design-v1.md) | ブラウザ＋GAS＋Worker の3か所構成 |

---

## 章立て

全設計書で章番号と章名を揃えてある。横断して読めるようにするためで、
該当が無い章も「該当なし」と書いて残す。

| 章 | 内容 |
| --- | --- |
| §1 | 責務と境界 |
| §2 | モジュール構成 |
| §3 | 状態とデータ構造 |
| §4 | 主要フロー |
| §5 | 外部インターフェース |
| §6 | エラー設計 |
| **§7** | **移植（他プロダクトへの組み込み）** |
| §8 | テスト設計 |
| §9 | 設定値と環境依存 |
| §10 | 既知の制約・未解決 |
| §11 | 設計判断の記録 |
| §12 | 変更履歴 |

（`auth-shared-design-v1.md` は共通層のため章立てが一部異なる。）

---

## 移植するときの読み方

1. [component-catalog.md](./component-catalog.md) §2 で、欲しい部品がどの家族かを見る
2. その部品を持つアプリの設計書 **§7-1** で移植単位を確かめる
3. **§7-2** の置換点を潰す
4. **§7-3** の前提が移植先で満たせるかを確認する
5. **§7-4** を読む。**ここに書いてあるものは持ち出さない**
6. [component-catalog.md](./component-catalog.md) §5（共通の落とし穴）と
   [../repository-structure.md](../repository-structure.md) §4-3（複製元の欠陥を持ち込まない）を読む

---

## 書かないもの

**鍵・トークン・スプレッドシートID・内部URL・実在するメールアドレスを書かない。**

`docs/` は現在の配信構成では公開URLから404だが、GitHub のリポジトリでは読める。
一度コミットすれば履歴にも残る（[../specs/README.md](../specs/README.md) 末尾）。

設定値は**名前と意味だけ**を書き、実際の値は書かない。

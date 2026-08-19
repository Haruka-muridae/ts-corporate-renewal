# Codex / Claude Code 分業環境の移植手順

対象読者: 別リポジトリへこの分業環境（Codex=Orchestrator、Claude Code=唯一の
Implementation Worker）を移す人間。設計の背景説明はここには含めない。

## 実現内容

- Codex自身はコードを実装・修正しない。実装・修正はすべてClaude Codeへ委譲する。
- Claude Codeは`claude -p --output-format json`で非対話起動され、PowerShell
  ラッパー（`tools/claude-worker.ps1`）経由でBash Worker（`scripts/run-claude-worker.sh`）
  が呼ばれる。
- 見せる範囲（`--workspace`必須）、実行できるコマンド（Bash用PreToolUseフック）、
  残すログ（タスク本文は実行後に削除）の3点で、ネイティブWindows環境でOS-level
  sandboxが使えない前提を補っている。

## 前提

- Windows + Git for Windows（`bash.exe`・`cygpath.exe`）がインストール済み。
- Node.jsとnpmが使える。
- `@anthropic-ai/claude-code`がインストール済みで、`claude`コマンドが使え、
  ログイン済みであること。
- `claude --help`が`--settings`オプションを受け付けるバージョンであること
  （受け付けない場合、Bash Workerは起動を拒否する＝fail closed）。
- 移植先が実際のGitリポジトリであること。

## CLI

非対話実行は次の形。Worker内部でこのまま呼ばれる。

```
claude -p --output-format json --model <sonnet|opus> --max-turns <N> \
  --settings <このrunだけのsettings.json> --allowedTools ... --disallowedTools ...
```

`--settings`にはBash用PreToolUseフック（`scripts/claude-worker-bash-guard.mjs`）の
配線だけを書いた一時ファイルを渡す。

## コピー対象と扱い（A/B/C）

**A. そのままコピー（内容変更なし）**

- `tools/claude-worker.ps1`

**B. 要変更（移植先リポジトリに合わせて編集）**

- `scripts/run-claude-worker.sh`（骨格ごとコピーするが、`allowed_tools`/
  `disallowed_tools`配列は移植先の実コマンドに書き換えないと使えない。
  `npm test`等のコマンド名、`node tests/run.mjs`等のテストランナーのパスは
  現リポジトリ固有）。
- `scripts/claude-worker-bash-guard.mjs`（骨格ごとコピーするが、`SPECS`配列を
  上と対で一致させないと使えない。片方だけ変えるとallowedToolsで許可した
  はずのコマンドがフックで拒否される、または逆に想定外のコマンドが通って
  しまう）。
- `AGENTS.template.md` → 移行先`AGENTS.md`へマージ。
- `CLAUDE.template.md` → プレースホルダーを埋めて移行先`CLAUDE.md`として配置。
- `.gitignore.snippet` → 移行先`.gitignore`へ追記。

**C. コピー禁止**

- 現リポジトリの実際の`CLAUDE.md`（サイト固有の配信構成・システム構成の記述を含む）。
- 現リポジトリの`AGENTS.md`のうち、Codex/Claude運用節以外（サイト固有の実装方針）。
- `.env`系、`.dev.vars`系、`secure/`・`secrets/`・`customer-data/`・`contracts/`・
  `infra/prod/`配下のファイル。
- Secret・Credential・個人情報・本番URL・顧客情報。

## セットアップ

1. 外部ツール導入についてHumanの承認を得た上で、
   `npm install -g @anthropic-ai/claude-code`を実行し、認証を済ませる。
   `claude --version`、`claude auth status --json`を実行して疎通を確認し、
   `claude --help`の出力に`--settings`が含まれることを確認する。
2. 上記「コピー対象」のA・Bをすべて配置する（順序は`README.md`参照）。
3. `scripts/run-claude-worker.sh`のallowlistと`scripts/claude-worker-bash-guard.mjs`の
   `SPECS`を移植先の実コマンドに合わせて編集する。
4. `CLAUDE.template.md`の全プレースホルダーを実値で埋める。実在しない値は
   推測せずTODOのまま残す。
5. `AGENTS.template.md`を既存`AGENTS.md`へマージする。
6. `.gitignore`に`.claude-worker/`を追記する。
7. Git Bash・cygpath・claude CLIのパスが解決できることを確認する
   （`tools/claude-worker.ps1`は解決できない場合エラーで停止する＝fail closed）。

## スモークE2E

読み取り専用コマンド1つだけを実行させる、最小のタスクファイルで疎通確認する。
例えば「`git status`を実行して結果を報告してください」程度のタスクを渡し、次を確認する。

```powershell
.\tools\claude-worker.ps1 -Workspace . -TaskFile <タスクファイル>
```

- 終了コード0、かつ`.claude-worker/logs/<run-id>/result.json`がJSONとして読める。
- 同じrunディレクトリの`task.txt`が実行後に存在しない（自動削除の確認）。
- `metadata.json`にタスク本文が含まれていない（ログに残らない設計の確認）。
- allowlist外のコマンド（例: `git branch`や`rm`）を含むタスクを別途渡し、
  Claudeがそれを実行できずに拒否される（フックの`denied:`メッセージが返る）ことを確認する。

## 典型的な失敗例

- `claude`コマンドが見つからない → CLIが未インストール、またはPATH未設定。
- `--settings`未対応のCLIバージョン → Worker側がfail closedで起動を拒否する
  （エラーメッセージの通り。バージョンを上げるか対応版を使う）。
- `-Workspace`省略、またはリポジトリ外を指定 → 両方とも拒否される
  （リポジトリルート自体を対象にするのは、Humanがそのデータ範囲を明示承認した
  runに限る）。
- workspace配下にシンボリックリンク、または`.env`・`.dev.vars`・`secure/`・
  `secrets/`・`customer-data/`・`contracts/`・`infra/prod`が1つでもある → 起動前に
  拒否される。`.env.example`・`.dev.vars.example`（完全一致のみ）は例外。
- allowlistとSPECSがリポジトリのコマンドに合っていない → 想定した
  `npm run xxx`等が「許可リストに一致しないコマンド」として拒否される。
  BのallowlistとSPECSを両方見直す。

## Secret禁止

`.env`・API Key・Access Token・Secret・Password・Private Key・本番Credential・
顧客個人情報・契約書・機密資料・本番環境設定・Secret Managerの内容は、Claude Codeに
一切渡さない。渡す必要がある場合はinterface、type、mock、generated stub、schema、
dummy valueだけにする。Workerはこれを`--workspace`の事前走査とツール権限の両方で
強制するが、**移植後にallowlistや保護パスを拡張するときは、この方針を壊さないこと**。

## push / deploy 承認

`git push`、force push、remote変更、production deploy、SSH、sudo、Cloud IAM変更、
Secret Manager操作、本番Credential取得、本番DB操作は、移植後もWorker側の
`disallowedTools`とBashガードで拒否され続ける。これらとその他の破壊的操作は、
Humanの明示承認なしに行わない。承認は都度必要で、一度の承認が以降のrunすべてに
及ぶわけではない。

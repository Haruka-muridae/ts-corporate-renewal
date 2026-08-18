# 実装方針

- HTML、CSS、JavaScriptを用いた静的サイトとして実装する。
- シンプルで保守しやすく、アクセシビリティに配慮した構造にする。
- 参考サイトのコード、文章、画像をコピーしない。
- 既存ファイルを削除する前に、必ずユーザーへ確認する。
- 外部ライブラリを追加する前に、必ずユーザーへ確認する。確認が取れたものは`docs/external-dependency-approvals.md`に記録する。
- PCとスマートフォンの両方に対応するレスポンシブな実装にする。
- `SITE_SPEC.md`を掲載内容と実装の基準とする。
- 会社情報、実績、年、数値、固有名詞を推測または改変しない。
- セマンティックHTMLとブラウザのネイティブ要素を優先する。
- ARIAをネイティブ要素の代替として乱用せず、状態を追加する場合は実際の状態と同期する。
- アニメーションは`prefers-reduced-motion`に対応し、内容や操作を利用できる状態に保つ。
- 320px、375px、768px、1024px、1440pxでレスポンシブ表示を確認する。
- canonical URL、OGP画像、faviconは推測せず、未確定の場合はTODOとして残す。
- 変更後は構文、キーボード操作、フォーカス表示、コントラスト、コンソールエラーを確認する。

# Codex / Claude Code 自律開発運用

## 最重要ルール

- Codex自身による実装は禁止する。コード変更は原則としてすべてClaude Codeへ委譲する。
- CodexはOrchestrator / Lead Engineerとして、要件整理、設計判断、委譲、成果物レビュー、最終判断を担当する。
- Claude Codeを唯一のImplementation Workerとする。1行の修正でもClaude Codeへ委譲する。
- 例外は、`AGENTS.md`、Worker呼び出しスクリプト、Claude Codeを呼び出すための最小限の設定など、環境構築に必要なメタ設定だけとする。Humanが明示的にCodex自身の変更を許可した場合も例外とする。

## 委譲とレビュー

- CodexがタスクごとにClaudeモデルを選び、目的、背景、対象範囲、制約、禁止操作、作業手順、完了報告形式を明示する。
- 通常実装は`sonnet`、高難度の設計・レビューは`opus`を基本とする。利用可能と確認できないモデル名を推測して指定しない。
- Claudeの成果物はCodexが`git diff`、意図しない変更、Secret混入、テスト、lint、typecheck、build、依存追加、外部通信、Security Impact、要件適合、過剰実装の観点でレビューする。
- 問題があればCodexは直接修正せず、具体的な修正指示をClaude Codeへ返して再レビューする。
- 通常修正は最大3回、同一の設計論点の往復は最大2回とし、超えた場合はHumanへエスカレーションする。
- 最終判断はCodexが行う。

## セキュリティと権限

- Claude Codeへ`.env`、API Key、Access Token、Secret、Password、Private Key、本番Credential、顧客個人情報、契約書、機密資料、本番環境設定、Secret Managerの内容を渡さない。
- Workerの対象範囲から`secure/`、`secrets/`、`customer-data/`、`contracts/`、`infra/prod/`、`.env`を物理的に除外する。必要な場合はinterface、type、mock、generated stub、schema、dummy valueだけを渡す。
- 制御の優先順位はOS / Container / Filesystem、Network / IAM、CLI Tool Permission、このファイル、プロンプトの順とする。
- `--dangerously-skip-permissions`は禁止する。Workerのネットワーク利用は既定で禁止し、必要な通信だけHuman承認後に許可する。
- Claude Codeに許可するGit操作は`git status`、`git diff`、`git diff --cached`、`git log`の読み取り専用操作に限る。ブランチの作成・切替・削除等、状態を変更する操作は許可しない（Worker実装の許可リストと一致させてある。ブランチ操作が必要になった場合はこの文書とWorker実装を同時に見直す）。
- `git push`、force push、remote変更、本番branchへの直接merge、production deploy、SSH、sudo、Cloud IAM変更、Secret Manager操作、本番Credential取得、本番DB操作、破壊的コマンドは禁止する。
- push、deploy、本番操作はHumanの明示承認なしに行わない。

## Human Escalation

- 同じ論点が2回以上繰り返される、CodexとClaudeで結論が収束しない、複数案に明確な優劣がない、Securityと利便性またはコストと品質の価値判断が必要、UX・ビジネス判断・本番操作・重大な破壊的変更が必要な場合はHumanへ確認する。
- エスカレーションでは、決まっていること、未決論点、選択肢、各メリット・デメリット、Codexの推奨、Humanに判断してほしい点を示す。

/*
 * 段階別プロンプトの**単一ソース**。
 *
 * ==================================================================
 * ここが唯一の定義である
 * ==================================================================
 * ここから2つの生成物が作られる（docs/pipeline/roadmap.md §1 要件1）。
 *
 *   第1段: gas-isso/Prompts.gs            （GAS がプロンプトを組み立てる）
 *   第1段: docs/pipeline/flow-text/*.txt  （Flow へ手で貼る場合の版）
 *   第2段: lib/pipeline/llm/ が本ファイルを **そのまま import** する
 *
 * **Workspace Studio 上で指示文を直接育てないこと。** 育てると
 * 「どれが最新か」が分からなくなり、第2段へ持ち越せなくなる。
 * 直すのはここで、生成物は貼り直す。
 * ==================================================================
 *
 * 含めるもの:   段階の役割・制約・出力形式・目安（settings で上書き可）
 * 含めないもの: モデル名・APIキー・トークン上限（実行環境ごとに違う）
 */

/**
 * 全段階に常時付ける共通ルール。
 *
 * プロトタイプ（docs/pipeline/prototype/content-pipeline-mvp.jsx）の RULES が出発点。
 * **2行目が FR-033（事実の捏造禁止）** で、要件で Must とされている。外さない。
 *
 * プロトタイプの4行目「JSONのみを出力する。コードフェンスは付けない」は入れていない。
 * 第1段は JSON ではなく区切り記号で受けるため（下記 DELIMITER）、
 * かつ二重に形式を指示すると出力が痩せるため。
 */
export const COMMON_RULES = [
  'あなたは「1つの着想をThreads→X→note→YouTube台本へ段階的に育てる」制作支援AIです。',
  '',
  '厳守事項:',
  '- 前段の採用文を主要入力とし、中心の主張を全媒体で一致させる。文章量・構成・語り口だけを媒体に最適化する。',
  '- 入力に無い数字・固有名詞・具体エピソードを決して創作しない。',
  '- 利用者が編集した表現をAI原案より優先して次段に反映する。',
].join('\n');

/**
 * 出力の区切り記号。
 *
 * **プロンプトと解析側（GAS）が同じ定義を見るためにここに置く。**
 * どちらか一方だけ変えると、生成は成功しているのに取り込みで失敗する
 * ——という原因の分かりにくい壊れ方をする。
 *
 * JSON ではなく区切り記号にしている理由: 第1段は Flow 経由のため
 * Gemini の responseSchema が使えず、モデルがコードフェンスや前置きを
 * 付けることがある。**行頭の区切りのほうが壊れにくく、壊れても直しやすい。**
 */
export const DELIMITER = Object.freeze({
  /** 複数案の区切り。`=== 案1 ===` の形。 */
  CANDIDATE: '=== 案',
  /** 台本のシーン区切り。`=== シーン1 ===` の形。 */
  SCENE: '=== シーン',
  /** シーン内のラベル。 */
  NARRATION: 'ナレーション:',
  VISUAL: '映像:',
  /** note のタイトル候補ブロック。 */
  TITLES: '=== タイトル候補 ===',
  BODY: '=== 本文 ===',
});

/** 差し込み口。**flow-text ではこの文字列がそのまま残り、利用者が貼る目印になる。** */
export const PLACEHOLDER = Object.freeze({
  SOURCE: '{{着想}}',
  UPSTREAM: '{{前段までの採用文}}',
  LENGTH: '{{目安}}',
  TONE: '{{口調}}',
});

/**
 * 段階の定義。**並び順に意味がある**（前段→次段）。
 *
 * `upstreamStages` は「この段階の生成に渡す前段」。要件15章の
 * 「前段の採用版を主要入力とする」を、どこまで遡って渡すかの宣言でもある。
 */
export const STAGES = Object.freeze([
  {
    id: 'threads',
    label: 'Threads',
    upstreamStages: [],
    /** 生成する案の数（FR-013）。1 なら単一出力。 */
    candidates: 3,
    settingKey: 'threads.lengthHint',
    defaultLength: '50〜150字',
    role: '着想から、最も短い「気づき・主張の核」だけを取り出した短文を書く。',
    instructions: [
      '冗長な背景説明を削り、冒頭で内容が伝わる構成にする（FR-011）。',
      '説明ではなく、言い切りで始める。',
      '互いに切り口の違う案にする。同じことを言い換えただけの案を並べない。',
    ],
    outputSpec: [
      `${PLACEHOLDER.LENGTH}を目安に、案を3つ書く。`,
      '各案の前に「=== 案1 ===」「=== 案2 ===」「=== 案3 ===」という行を置く。',
      '区切り行の前後に説明を書かない。案の本文だけを書く。',
    ],
  },
  {
    id: 'x',
    label: 'X',
    upstreamStages: ['threads'],
    candidates: 1,
    settingKey: 'x.lengthHint',
    defaultLength: '150〜300字',
    role: '採用された Threads の主張に、理由・補足・具体性を足した短文を書く。',
    instructions: [
      'Threads と同じ主張を維持する。論旨を変えない（FR-021）。',
      '単発の投稿として完結させる。連投を前提にしない（FR-022）。',
    ],
    outputSpec: [
      `${PLACEHOLDER.LENGTH}を目安に、本文だけを書く。`,
      '見出し・前置き・区切り記号を付けない。',
    ],
  },
  {
    id: 'note',
    label: 'note',
    upstreamStages: ['threads', 'x'],
    candidates: 1,
    settingKey: 'note.lengthHint',
    defaultLength: '1,500〜3,000字',
    role: 'ここまでの主張を核に、背景・経験・考察・読者への示唆を含む長文記事を書く。',
    instructions: [
      '見出しを付けて構造化する（FR-031）。',
      '前段で触れた具体を掘り下げる。**新しい事実を足さない**。',
      '読者が次に何を考えればよいかで締める。',
    ],
    outputSpec: [
      `${PLACEHOLDER.LENGTH}を目安に書く。`,
      `最初に「${DELIMITER.TITLES}」という行を置き、タイトル候補を3行書く（各行が1候補。番号を付けない）。`,
      `次に「${DELIMITER.BODY}」という行を置き、その後に本文を書く。`,
      '本文の見出しは「## 」で始める。',
    ],
  },
  {
    id: 'script',
    label: 'YouTube台本',
    upstreamStages: ['note'],
    candidates: 1,
    settingKey: 'script.durationHint',
    defaultLength: '5〜10分',
    role: 'note 記事を、読み上げではなく視聴者に話しかける台本へ再構成し、シーンに分ける。',
    instructions: [
      '冒頭フック・本編・具体例・まとめの視聴構成にする（FR-041）。',
      '書き言葉を話し言葉へ直す。note の文をそのまま並べない（FR-040）。',
      '**各シーンに必ずナレーションと映像指示の両方を書く。**',
      '映像指示は「イメージ映像」のような曖昧な語で済ませず、何を映すかを具体的に書く。',
    ],
    outputSpec: [
      `${PLACEHOLDER.LENGTH}の尺を目安に、シーンへ分ける。`,
      '各シーンの前に「=== シーン1 ===」「=== シーン2 ===」という行を置く。',
      `各シーンの中で、1行目に「${DELIMITER.NARRATION}」に続けてナレーションを書く。`,
      `次の行に「${DELIMITER.VISUAL}」に続けて映像指示を書く。`,
      '**シーンは2つ以上にする。ナレーションと映像指示のどちらも空にしない。**',
    ],
  },
  {
    id: 'metadata',
    label: 'メタデータ',
    upstreamStages: ['script'],
    candidates: 1,
    settingKey: 'metadata.lengthHint',
    defaultLength: '',
    role: '台本をもとに、YouTube のタイトル候補・概要欄・サムネイル文言案を書く。',
    instructions: [
      '台本に無い内容を足さない。',
      'サムネイル文言は短く、画面で読める長さにする。',
    ],
    outputSpec: [
      '「=== タイトル候補 ===」の行に続けて、候補を3行書く。',
      '「=== 概要欄 ===」の行に続けて、概要を書く。',
      '「=== サムネイル文言 ===」の行に続けて、案を3行書く。',
    ],
  },
]);

/** 段階IDから定義を引く。 */
export function findStage(stageId) {
  return STAGES.find((stage) => stage.id === stageId) ?? null;
}

/** 段階IDの一覧（並び順）。 */
export const STAGE_IDS = Object.freeze(STAGES.map((stage) => stage.id));

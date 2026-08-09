/*
 * Prompts.gs — 段階別プロンプトの定義と組み立て
 *
 * ==================================================================
 * **このファイルは生成物です。手で編集しないでください。**
 * ==================================================================
 * 出どころ: lib/pipeline/prompts/definitions.mjs（単一ソース）
 * 作り直し: node lib/pipeline/prompts/build.mjs
 *
 * ここを手で直すと、第2段（会員向け）の LlmClient と食い違います。
 * 直すのは definitions.mjs です。
 * ==================================================================
 */

/* 差し込み口。issoRenderPrompt が参照する。 */
var ISSO_PROMPT_PLACEHOLDER = {
  "SOURCE": "{{着想}}",
  "UPSTREAM": "{{前段までの採用文}}",
  "LENGTH": "{{目安}}",
  "TONE": "{{口調}}"
};

/* 出力の区切り記号。**解析側（Generation.gs）はここを見る。** */
var ISSO_PROMPT_DELIMITER = {
  "CANDIDATE": "=== 案",
  "SCENE": "=== シーン",
  "NARRATION": "ナレーション:",
  "VISUAL": "映像:",
  "TITLES": "=== タイトル候補 ===",
  "BODY": "=== 本文 ==="
};

/* 段階の並び。前段→次段の順。 */
var ISSO_STAGE_IDS = ["threads","x","note","script","metadata"];

/* 段階の表示名。 */
var ISSO_STAGE_LABELS = {
  "threads": "Threads",
  "x": "X",
  "note": "note",
  "script": "YouTube台本",
  "metadata": "メタデータ"
};

/* 生成する案の数（FR-013）。 */
var ISSO_STAGE_CANDIDATES = {
  "threads": 3,
  "x": 1,
  "note": 1,
  "script": 1,
  "metadata": 1
};

/* 前段として渡す段階。要件15章「前段の採用版を主要入力とする」。 */
var ISSO_STAGE_UPSTREAM = {
  "threads": [],
  "x": [
    "threads"
  ],
  "note": [
    "threads",
    "x"
  ],
  "script": [
    "note"
  ],
  "metadata": [
    "script"
  ]
};

/* settings が空のときに使う目安。 */
var ISSO_STAGE_DEFAULT_LENGTH = {
  "threads": "50〜150字",
  "x": "150〜300字",
  "note": "1,500〜3,000字",
  "script": "5〜10分",
  "metadata": ""
};

/* settings のキー。 */
var ISSO_STAGE_SETTING_KEY = {
  "threads": "threads.lengthHint",
  "x": "x.lengthHint",
  "note": "note.lengthHint",
  "script": "script.durationHint",
  "metadata": "metadata.lengthHint"
};

/* 段階ごとの固定部分。差し込み口（{{…}}）が残っている。 */
var ISSO_PROMPT_TEMPLATES = {
  "threads": "あなたは「1つの着想をThreads→X→note→YouTube台本へ段階的に育てる」制作支援AIです。\n\n厳守事項:\n- 前段の採用文を主要入力とし、中心の主張を全媒体で一致させる。文章量・構成・語り口だけを媒体に最適化する。\n- 入力に無い数字・固有名詞・具体エピソードを決して創作しない。\n- 利用者が編集した表現をAI原案より優先して次段に反映する。\n\n# 今回の段階: Threads\n\n着想から、最も短い「気づき・主張の核」だけを取り出した短文を書く。\n\n## 書き方\n- 冗長な背景説明を削り、冒頭で内容が伝わる構成にする（FR-011）。\n- 説明ではなく、言い切りで始める。\n- 互いに切り口の違う案にする。同じことを言い換えただけの案を並べない。\n\n## 出力の形\n- {{目安}}を目安に、案を3つ書く。\n- 各案の前に「=== 案1 ===」「=== 案2 ===」「=== 案3 ===」という行を置く。\n- 区切り行の前後に説明を書かない。案の本文だけを書く。\n\n## 口調\n{{口調}}\n\n## 着想\n{{着想}}",
  "x": "あなたは「1つの着想をThreads→X→note→YouTube台本へ段階的に育てる」制作支援AIです。\n\n厳守事項:\n- 前段の採用文を主要入力とし、中心の主張を全媒体で一致させる。文章量・構成・語り口だけを媒体に最適化する。\n- 入力に無い数字・固有名詞・具体エピソードを決して創作しない。\n- 利用者が編集した表現をAI原案より優先して次段に反映する。\n\n# 今回の段階: X\n\n採用された Threads の主張に、理由・補足・具体性を足した短文を書く。\n\n## 書き方\n- Threads と同じ主張を維持する。論旨を変えない（FR-021）。\n- 単発の投稿として完結させる。連投を前提にしない（FR-022）。\n\n## 出力の形\n- {{目安}}を目安に、本文だけを書く。\n- 見出し・前置き・区切り記号を付けない。\n\n## 口調\n{{口調}}\n\n## 前段までの採用文（これを主要入力とする）\n{{前段までの採用文}}\n\n## 着想\n{{着想}}",
  "note": "あなたは「1つの着想をThreads→X→note→YouTube台本へ段階的に育てる」制作支援AIです。\n\n厳守事項:\n- 前段の採用文を主要入力とし、中心の主張を全媒体で一致させる。文章量・構成・語り口だけを媒体に最適化する。\n- 入力に無い数字・固有名詞・具体エピソードを決して創作しない。\n- 利用者が編集した表現をAI原案より優先して次段に反映する。\n\n# 今回の段階: note\n\nここまでの主張を核に、背景・経験・考察・読者への示唆を含む長文記事を書く。\n\n## 書き方\n- 見出しを付けて構造化する（FR-031）。\n- 前段で触れた具体を掘り下げる。**新しい事実を足さない**。\n- 読者が次に何を考えればよいかで締める。\n\n## 出力の形\n- {{目安}}を目安に書く。\n- 最初に「=== タイトル候補 ===」という行を置き、タイトル候補を3行書く（各行が1候補。番号を付けない）。\n- 次に「=== 本文 ===」という行を置き、その後に本文を書く。\n- 本文の見出しは「## 」で始める。\n\n## 口調\n{{口調}}\n\n## 前段までの採用文（これを主要入力とする）\n{{前段までの採用文}}\n\n## 着想\n{{着想}}",
  "script": "あなたは「1つの着想をThreads→X→note→YouTube台本へ段階的に育てる」制作支援AIです。\n\n厳守事項:\n- 前段の採用文を主要入力とし、中心の主張を全媒体で一致させる。文章量・構成・語り口だけを媒体に最適化する。\n- 入力に無い数字・固有名詞・具体エピソードを決して創作しない。\n- 利用者が編集した表現をAI原案より優先して次段に反映する。\n\n# 今回の段階: YouTube台本\n\nnote 記事を、読み上げではなく視聴者に話しかける台本へ再構成し、シーンに分ける。\n\n## 書き方\n- 冒頭フック・本編・具体例・まとめの視聴構成にする（FR-041）。\n- 書き言葉を話し言葉へ直す。note の文をそのまま並べない（FR-040）。\n- **各シーンに必ずナレーションと映像指示の両方を書く。**\n- 映像指示は「イメージ映像」のような曖昧な語で済ませず、何を映すかを具体的に書く。\n\n## 出力の形\n- {{目安}}の尺を目安に、シーンへ分ける。\n- 各シーンの前に「=== シーン1 ===」「=== シーン2 ===」という行を置く。\n- 各シーンの中で、1行目に「ナレーション:」に続けてナレーションを書く。\n- 次の行に「映像:」に続けて映像指示を書く。\n- **シーンは2つ以上にする。ナレーションと映像指示のどちらも空にしない。**\n\n## 口調\n{{口調}}\n\n## 前段までの採用文（これを主要入力とする）\n{{前段までの採用文}}\n\n## 着想\n{{着想}}",
  "metadata": "あなたは「1つの着想をThreads→X→note→YouTube台本へ段階的に育てる」制作支援AIです。\n\n厳守事項:\n- 前段の採用文を主要入力とし、中心の主張を全媒体で一致させる。文章量・構成・語り口だけを媒体に最適化する。\n- 入力に無い数字・固有名詞・具体エピソードを決して創作しない。\n- 利用者が編集した表現をAI原案より優先して次段に反映する。\n\n# 今回の段階: メタデータ\n\n台本をもとに、YouTube のタイトル候補・概要欄・サムネイル文言案を書く。\n\n## 書き方\n- 台本に無い内容を足さない。\n- サムネイル文言は短く、画面で読める長さにする。\n\n## 出力の形\n- 「=== タイトル候補 ===」の行に続けて、候補を3行書く。\n- 「=== 概要欄 ===」の行に続けて、概要を書く。\n- 「=== サムネイル文言 ===」の行に続けて、案を3行書く。\n\n## 口調\n{{口調}}\n\n## 前段までの採用文（これを主要入力とする）\n{{前段までの採用文}}\n\n## 着想\n{{着想}}"
};

/**
 * 差し込み口を埋める。値が空の行は落とし、直前の見出しも一緒に落とす。
 * lib/pipeline/prompts/render.mjs の render() と同じ規則。
 */
function issoRenderPrompt(template, values) {
  var lines = String(template).split('\n');
  var out = [];
  var names = Object.keys(ISSO_PROMPT_PLACEHOLDER);

  for (var i = 0; i < lines.length; i++) {
    var rendered = lines[i];
    var emptied = false;

    for (var j = 0; j < names.length; j++) {
      var placeholder = ISSO_PROMPT_PLACEHOLDER[names[j]];

      if (rendered.indexOf(placeholder) === -1) {
        continue;
      }

      var value = values[names[j]];
      value = (value === undefined || value === null) ? '' : String(value);

      if (value.replace(/^\s+|\s+$/g, '') === '') {
        emptied = true;
        break;
      }

      rendered = rendered.replace(placeholder, value);
    }

    if (emptied) {
      if (out.length > 0 && out[out.length - 1].indexOf('## ') === 0) {
        out.pop();
      }
      continue;
    }

    out.push(rendered);
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
}

/**
 * 前段までの採用文を整形する。
 * lib/pipeline/prompts/render.mjs の formatUpstream() と同じ規則。
 */
function issoFormatUpstream(upstream) {
  if (!upstream || !upstream.length) {
    return '';
  }

  var blocks = [];

  for (var i = 0; i < upstream.length; i++) {
    var item = upstream[i];
    var label = item.label || item.stage;
    var mark = item.editedByUser === true
      ? '（利用者が手直しした版。表現を尊重すること）'
      : '';

    blocks.push('### ' + label + mark + '\n' + item.body);
  }

  return blocks.join('\n\n');
}

/**
 * 段階のプロンプトを最後まで組み立てる。Generation.gs はこれを呼ぶ。
 * lib/pipeline/prompts/render.mjs の buildPrompt() と同じ規則。
 */
function issoBuildPrompt(stageId, input) {
  var template = ISSO_PROMPT_TEMPLATES[stageId];

  if (!template) {
    throw new Error('未定義の段階です: ' + stageId);
  }

  var source = String((input && input.source) || '').replace(/^\s+|\s+$/g, '');

  if (source === '') {
    throw new Error('着想が空です。プロンプトを組み立てられません。');
  }

  var length = String((input && input.length) || '').replace(/^\s+|\s+$/g, '');

  if (length === '') {
    length = ISSO_STAGE_DEFAULT_LENGTH[stageId];
  }

  return issoRenderPrompt(template, {
    SOURCE: source,
    UPSTREAM: issoFormatUpstream((input && input.upstream) || []),
    LENGTH: length,
    TONE: (input && input.tone) || ''
  });
}

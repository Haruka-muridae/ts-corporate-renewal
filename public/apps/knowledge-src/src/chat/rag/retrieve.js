/*
 * 検索結果から「AIへ渡す資料」を選ぶ。
 *
 * ------------------------------------------------------------------
 * 上位チャンクをそのまま全部つなげない
 * ------------------------------------------------------------------
 * 素朴に連結すると
 *   - 1つのファイルばかりが並ぶ
 *   - 同じ文が何度も入る
 *   - コンテキスト長を超えて先頭が捨てられる
 * という失敗をする。ここでは件数・偏り・重複・長さを明示的に制御する。
 *
 * 通信もDOM操作もしない純粋関数にしてあるため、全分岐を単体テストで確認できる。
 * ------------------------------------------------------------------
 */

/*
 * 質問文を検索語へ整える。
 *
 * ------------------------------------------------------------------
 * 自然文をそのまま投げない
 * ------------------------------------------------------------------
 * 「〜について教えて」「〜とは何ですか？」のような言い回しは、
 * どの資料にも現れないため検索の妨げになる。
 * 意味を変えない範囲で、質問特有の言い回しだけを落とす。
 *
 * 落としすぎると検索できなくなるため、結果が空になる場合は元の文を返す。
 * ------------------------------------------------------------------
 */
const QUESTION_TAILS = [
  'について教えてください', 'について教えて', 'について知りたい',
  'とは何ですか', 'とは何か', 'とはなんですか', 'とは',
  'を教えてください', 'を教えて', 'はどこですか', 'はどこ',
  'はいつですか', 'はいつ', 'はなぜですか', 'はなぜ',
  'ですか', 'でしょうか', 'ますか', 'かな',
];

const QUESTION_MARKS = /[?？。、!！]/g;

export function normalizeQuestion(question) {
  let text = String(question ?? '').trim();

  if (text === '') {
    return '';
  }

  text = text.replace(QUESTION_MARKS, ' ');

  /* 長いものから順に、末尾の言い回しだけを落とす。 */
  const tails = [...QUESTION_TAILS].sort((a, b) => b.length - a.length);
  let changed = true;

  while (changed) {
    changed = false;

    for (const tail of tails) {
      const trimmed = text.trimEnd();

      if (trimmed.endsWith(tail) && trimmed.length > tail.length) {
        text = trimmed.slice(0, trimmed.length - tail.length);
        changed = true;
        break;
      }
    }
  }

  const result = text.replace(/\s+/g, ' ').trim();

  /* 削りすぎたら元へ戻す。 */
  return result === '' ? String(question ?? '').trim() : result;
}

/* 文字列を「サロゲートペアを壊さずに」切り詰める。 */
export function safeTruncate(text, maxChars) {
  const source = String(text ?? '');
  const limit = Number(maxChars);

  if (!Number.isFinite(limit) || limit <= 0 || source.length <= limit) {
    return source;
  }

  let end = limit;
  const code = source.charCodeAt(end - 1);

  /* 上位サロゲートで切れる位置なら1文字戻す。 */
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }

  return source.slice(0, Math.max(0, end));
}

/* 重複判定用の正規化（空白と改行の違いを無視する）。 */
function normalizeForCompare(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/*
 * 質問から「照合に使う語」を取り出す。
 *
 * 日本語は2文字ずつ（bigram）、英数字は2文字以上の語として扱う。
 * 検索側のトークナイザと同じ考え方だが、ここでは
 * 「本当にその語が資料に出てくるか」を確かめるためだけに使う。
 */
/*
 * 助詞で切ってから bigram にする。
 *
 * ------------------------------------------------------------------
 * 「の」「は」をまたぐ bigram を数えない理由
 * ------------------------------------------------------------------
 * 「経費精算の申請期限」をそのまま bigram にすると
 *   経費 費精 精算 算の の申 申請 請期 期限
 * となり、「算の」「の申」は語ではなく、区切り方の都合でしかない。
 *
 * これを一致率に数えると、
 * 「経費の精算は翌月10日までに申請してください」という、
 * 質問に答えている資料でも一致率が 1/3 まで下がり、
 * 「根拠が弱い」と誤判定してしまう（実際にそうなった）。
 *
 * 助詞で区切ってから bigram にすると、
 *   経費 費精 精算 ／ 申請 請期 期限
 * となり、言い回しの違いに強くなる。
 * ------------------------------------------------------------------
 */
const PARTICLE_SPLIT = /について|における|に関する|から|まで|より|など|[のはをにがでともへ]/;

export function queryTerms(question) {
  const text = String(question ?? '');
  const terms = new Set();

  /* 英数字の語 */
  (text.match(/[A-Za-z0-9_]{2,}/g) ?? []).forEach((word) => terms.add(word.toLowerCase()));

  /* 日本語（ひらがな・カタカナ・漢字・長音）の連続を bigram にする */
  const runs = text.match(/[ぁ-ゖァ-ヺー一-鿿々]+/g) ?? [];

  runs.forEach((run) => {
    run.split(PARTICLE_SPLIT)
      .filter((segment) => segment !== '')
      .forEach((segment) => addBigrams(segment, terms));
  });

  /* 助詞だけで構成された質問（「とは」など）は、元の並びを使う。 */
  if (terms.size === 0) {
    runs.forEach((run) => addBigrams(run, terms));
  }

  return [...terms];
}

function addBigrams(segment, terms) {
  if (segment.length === 1) {
    terms.add(segment);
    return;
  }

  for (let i = 0; i < segment.length - 1; i += 1) {
    terms.add(segment.slice(i, i + 2));
  }
}

/*
 * 資料が質問と語レベルで重なっているかを確かめる。
 *
 * 検索は前方一致とあいまい一致を効かせているため、
 * 質問と1語も重ならない資料が上位に来ることがある。
 * その資料を根拠として渡すと、モデルが無関係な話を始める。
 * ここで「1語も出てこない資料」を落とす。
 */
export function hasLexicalOverlap(terms, source) {
  if (!Array.isArray(terms) || terms.length === 0) {
    return true;
  }

  const haystack = [
    String(source?.text ?? ''),
    String(source?.fileName ?? ''),
    String(source?.heading ?? ''),
    String(source?.folderName ?? ''),
  ].join('\n').toLowerCase();

  return terms.some((term) => haystack.includes(term));
}

/*
 * ファイルをまたいで順番に拾えるよう、ヒットを並べ替える。
 *
 * ------------------------------------------------------------------
 * なぜ必要か
 * ------------------------------------------------------------------
 * スコア順に上から取ると、長いファイルが上位を独占しやすい。
 * 同じ文書の似た段落ばかりが資料として渡り、
 * 「別のファイルに書いてある答え」を取りこぼす。
 *
 * そこで「各ファイルの1位」→「各ファイルの2位」…という順に並べ替える。
 * 各ラウンドの中ではスコア順を保つため、
 * 1位同士の優劣は崩れない（上位が不当に下がることはない）。
 * ------------------------------------------------------------------
 */
export function diversifyByFile(hits) {
  const list = Array.isArray(hits) ? [...hits] : [];

  list.sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0));

  const rounds = new Map();
  const seenPerFile = new Map();

  list.forEach((hit) => {
    const key = String(hit.fileId ?? '');
    const rank = seenPerFile.get(key) ?? 0;

    seenPerFile.set(key, rank + 1);

    const bucket = rounds.get(rank) ?? [];
    bucket.push(hit);
    rounds.set(rank, bucket);
  });

  return [...rounds.keys()]
    .sort((a, b) => a - b)
    .flatMap((rank) => rounds.get(rank));
}

/*
 * 検索ヒットから採用するチャンクを選ぶ。
 *
 * hits     … search() の hits（score 降順を想定するが、内部でも並べ替える）
 * options  … { topK, maxChunksPerFile, maxContextChars, minScoreRatio, diversify }
 *
 * 戻り値:
 *   { sources, dropped, totalChars, reason }
 *     sources … [{ id, chunkId, fileId, fileName, folderName, heading,
 *                  text, chunkIndex, score, driveUrl, truncated }]
 *     reason  … 'ok' | 'no-hits' | 'low-score'
 */
export function selectSources(hits, options = {}) {
  const topK = clampInt(options.topK, 1, 20, 5);
  /* 質問と1語も重ならない資料を落とすための照合語。 */
  const terms = options.question ? queryTerms(normalizeQuestion(options.question)) : [];
  const perFile = clampInt(options.maxChunksPerFile, 1, 5, 2);
  const maxChars = clampInt(options.maxContextChars, 500, 20000, 6000);
  const minScoreRatio = clampNumber(options.minScoreRatio, 0, 1, 0.2);

  const list = Array.isArray(hits) ? [...hits] : [];

  if (list.length === 0) {
    return { sources: [], dropped: [], totalChars: 0, reason: 'no-hits' };
  }

  list.sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0));

  const best = Number(list[0].score ?? 0);

  /*
   * しきい値は「元のスコア順の1位」に対して決める。
   * 並べ替えたあとの先頭に対して決めると、
   * 偏り解消のために前へ出た資料が基準になってしまう。
   */
  const ordered = options.diversify === false ? list : diversifyByFile(list);

  /*
   * 最上位のスコアに対して極端に低いものは、質問と無関係な可能性が高い。
   * 全体が低い場合（best が 0 に近い）は「関連資料なし」として扱う。
   */
  const threshold = best * minScoreRatio;

  if (best <= 0) {
    return { sources: [], dropped: [], totalChars: 0, reason: 'low-score' };
  }

  const perFileCount = new Map();
  const seenText = new Set();
  const seenChunk = new Set();
  const sources = [];
  const dropped = [];
  let totalChars = 0;

  for (const hit of ordered) {
    if (sources.length >= topK) {
      dropped.push({ chunkId: hit.chunkId, reason: 'topk' });
      continue;
    }

    if (Number(hit.score ?? 0) < threshold) {
      dropped.push({ chunkId: hit.chunkId, reason: 'low-score' });
      continue;
    }

    if (seenChunk.has(hit.chunkId)) {
      dropped.push({ chunkId: hit.chunkId, reason: 'duplicate-chunk' });
      continue;
    }

    const used = perFileCount.get(hit.fileId) ?? 0;

    if (used >= perFile) {
      dropped.push({ chunkId: hit.chunkId, reason: 'per-file-limit' });
      continue;
    }

    const normalized = normalizeForCompare(hit.text);

    if (normalized === '') {
      dropped.push({ chunkId: hit.chunkId, reason: 'empty' });
      continue;
    }

    /*
     * 前方一致・あいまい一致のせいで、質問と1語も重ならない資料が
     * 上位に来ることがある。根拠にできないので落とす。
     */
    if (terms.length > 0 && !hasLexicalOverlap(terms, hit)) {
      dropped.push({ chunkId: hit.chunkId, reason: 'no-overlap' });
      continue;
    }

    if (seenText.has(normalized)) {
      dropped.push({ chunkId: hit.chunkId, reason: 'duplicate-text' });
      continue;
    }

    /* 残り容量に収まる分だけ入れる。1件も入らない場合はそこで打ち切る。 */
    const remaining = maxChars - totalChars;

    if (remaining <= 200) {
      dropped.push({ chunkId: hit.chunkId, reason: 'context-full' });
      continue;
    }

    const text = safeTruncate(hit.text, remaining);
    const truncated = text.length < String(hit.text ?? '').length;

    sources.push({
      /* 番号は最後に付け直す（関連度順に [1][2]… となるようにする）。 */
      id: 0,
      chunkId: hit.chunkId,
      fileId: hit.fileId,
      fileName: hit.fileName ?? '',
      folderName: hit.folderName ?? '',
      heading: hit.heading ?? '',
      chunkIndex: Number(hit.chunkIndex ?? 0),
      score: Number(hit.score ?? 0),
      driveUrl: hit.driveUrl ?? '',
      snippet: hit.snippet ?? '',
      text,
      truncated,
    });

    totalChars += text.length;
    seenChunk.add(hit.chunkId);
    seenText.add(normalized);
    perFileCount.set(hit.fileId, used + 1);
  }

  if (sources.length === 0) {
    return { sources: [], dropped, totalChars: 0, reason: 'low-score' };
  }

  /*
   * 表示と引用番号は関連度順にする。
   * 選ぶ順序（偏り対策）と、見せる順序（分かりやすさ）は別で良い。
   */
  sources.sort((a, b) => b.score - a.score);
  sources.forEach((source, index) => { source.id = index + 1; });

  return { sources: mergeAdjacent(sources), dropped, totalChars, reason: 'ok' };
}

/*
 * 同じファイルの隣り合うチャンクを1件にまとめる。
 *
 * 分割位置はただの都合なので、隣り合った2つを別々の資料として渡すと
 *   - 同じ話が2件あるように見える
 *   - 引用番号が無駄に増える
 *   - 前後補完でさらに同じ文が重複する
 * ということが起きる。連続していれば、つなげて1件として扱う。
 */
export function mergeAdjacent(sources) {
  const list = Array.isArray(sources) ? [...sources] : [];

  if (list.length <= 1) {
    return list.map((source, index) => ({ ...source, id: index + 1 }));
  }

  /* ファイルごとに chunkIndex 昇順で見て、連続していれば連結する。 */
  const byFile = new Map();

  list.forEach((source) => {
    const bucket = byFile.get(source.fileId) ?? [];
    bucket.push(source);
    byFile.set(source.fileId, bucket);
  });

  const merged = [];

  byFile.forEach((bucket) => {
    const ordered = [...bucket].sort((a, b) => a.chunkIndex - b.chunkIndex);
    let current = null;

    ordered.forEach((source) => {
      const end = Number(current?.chunkIndexEnd ?? current?.chunkIndex);

      if (current && Number(source.chunkIndex) === end + 1) {
        current = {
          ...current,
          text: `${current.text}\n${source.text}`,
          chunkIndexEnd: Number(source.chunkIndex),
          score: Math.max(current.score, source.score),
          truncated: current.truncated || source.truncated,
          mergedFrom: [...(current.mergedFrom ?? [current.chunkId]), source.chunkId],
        };
        return;
      }

      if (current) {
        merged.push(current);
      }

      current = { ...source, chunkIndexEnd: Number(source.chunkIndex) };
    });

    if (current) {
      merged.push(current);
    }
  });

  merged.sort((a, b) => b.score - a.score);

  return merged.map((source, index) => ({ ...source, id: index + 1 }));
}

/*
 * 前後のチャンクで文脈を補う。
 *
 * neighborsByChunkId … chunkId → 前後を含むチャンク配列
 * 補った分もコンテキスト上限を超えない範囲でしか足さない。
 */
export function expandWithNeighbors(sources, neighborsByChunkId, { maxContextChars = 6000 } = {}) {
  const used = sources.reduce((sum, s) => sum + s.text.length, 0);
  let budget = Math.max(0, maxContextChars - used);

  return sources.map((source) => {
    const neighbors = neighborsByChunkId?.get?.(source.chunkId) ?? [];

    if (neighbors.length === 0 || budget <= 0) {
      return source;
    }

    /* まとめた資料は末尾の位置を基準に「後ろ」を判定する。 */
    const end = Number(source.chunkIndexEnd ?? source.chunkIndex);
    const inside = new Set(source.mergedFrom ?? [source.chunkId]);

    const before = neighbors.filter((n) => Number(n.chunkIndex) < source.chunkIndex && !inside.has(n.chunkId));
    const after = neighbors.filter((n) => Number(n.chunkIndex) > end && !inside.has(n.chunkId));

    /* 前後それぞれ、残り容量の1/4までを目安に足す。 */
    const share = Math.floor(budget / 4);
    const head = before.length > 0 ? safeTruncate(tail(before[before.length - 1].text, share), share) : '';
    const foot = after.length > 0 ? safeTruncate(after[0].text, share) : '';

    if (head === '' && foot === '') {
      return source;
    }

    const merged = [head, source.text, foot].filter((part) => part !== '').join('\n…\n');
    budget -= (merged.length - source.text.length);

    return { ...source, text: merged, expanded: true };
  });
}

/* 末尾から n 文字（サロゲートペアを壊さない）。 */
function tail(text, n) {
  const source = String(text ?? '');

  if (source.length <= n) {
    return source;
  }

  let start = source.length - n;
  const code = source.charCodeAt(start);

  /* 下位サロゲートから始まるなら1文字進める。 */
  if (code >= 0xdc00 && code <= 0xdfff) {
    start += 1;
  }

  return source.slice(start);
}

/* ファイル単位でまとめる（引用元の表示用）。 */
export function groupByFile(sources) {
  const map = new Map();

  sources.forEach((source) => {
    const entry = map.get(source.fileId) ?? {
      fileId: source.fileId,
      fileName: source.fileName,
      folderName: source.folderName,
      driveUrl: source.driveUrl,
      bestScore: 0,
      items: [],
    };

    entry.items.push(source);
    entry.bestScore = Math.max(entry.bestScore, source.score);
    map.set(source.fileId, entry);
  });

  return [...map.values()].sort((a, b) => b.bestScore - a.bestScore);
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.min(max, Math.max(min, n)));
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

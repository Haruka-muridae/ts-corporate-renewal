/*
 * 「その回答は、資料にどれだけ支えられているか」を数える。
 *
 * ------------------------------------------------------------------
 * なぜ必要か
 * ------------------------------------------------------------------
 * 小さなローカルLLMは、資料に書かれていないことでも、それらしく書く。
 * 検索が的外れだったときほど、もっともらしい嘘になりやすい。
 *
 * そこで「モデルに聞く前」に、質問と資料の重なりを機械的に測り、
 *   - 薄すぎる場合は、そもそも生成させない（決め打ちの文言で断る）
 *   - 生成する場合も、根拠の強さを★で開示する
 * という2段構えにしている。
 *
 * 判定はすべてこの純粋関数に閉じてあるため、単体テストで全分岐を確認できる。
 * モデルの気分に左右されない部分だけで判断する、というのが要点。
 * ------------------------------------------------------------------
 */

import { queryTerms, normalizeQuestion } from './retrieve.js';

/* 根拠の強さ。0 は「資料なし」。 */
export const GroundingLevel = Object.freeze({
  NONE: 0,
  VERY_LOW: 1,
  LOW: 2,
  MEDIUM: 3,
  HIGH: 4,
  VERY_HIGH: 5,
});

export const GROUNDING_LABEL_JA = Object.freeze({
  0: '根拠なし',
  1: '根拠が非常に弱い',
  2: '根拠が弱い',
  3: '根拠はふつう',
  4: '根拠が強い',
  5: '根拠が非常に強い',
});

/*
 * これを下回ると回答を作らない。
 *
 * 1（非常に弱い）は「質問の語がほとんど資料に無い」状態で、
 * この状態で生成させると、ほぼ確実に資料外の作文になる。
 */
export const MIN_ANSWERABLE_LEVEL = GroundingLevel.LOW;

/* 断るときの文言。画面・テストの両方から参照する。 */
export const UNANSWERABLE_MESSAGE = '同期済みナレッジから回答できませんでした。';

export const UNANSWERABLE_HINTS = Object.freeze([
  '質問に出てくる言葉を、資料で使われている表現に近づけてみてください。',
  '対象の資料がナレッジ管理画面で同期済みか、ご確認ください。',
  '資料を使わない一般的な回答が必要な場合は、回答モードを「資料を使わない」に切り替えてください。',
]);

/* ★の文字列表現（5段階）。 */
export function starsFor(level) {
  const n = Math.max(0, Math.min(5, Math.round(Number(level) || 0)));
  return `${'★'.repeat(n)}${'☆'.repeat(5 - n)}`;
}

/*
 * 1件の資料が、質問の語をどれだけ含むか（0〜1）。
 * 引用元の「一致率」として画面に出す。
 */
export function matchRatio(terms, source) {
  const list = Array.isArray(terms) ? terms : [];

  if (list.length === 0) {
    return 0;
  }

  const haystack = haystackOf(source);
  const hit = list.filter((term) => haystack.includes(term)).length;

  return hit / list.length;
}

/* 資料全体で、質問の語をどれだけ拾えたか。 */
export function termCoverage(terms, sources) {
  const list = Array.isArray(terms) ? terms : [];

  if (list.length === 0) {
    return { covered: [], missing: [], ratio: 1 };
  }

  const haystack = (Array.isArray(sources) ? sources : []).map(haystackOf).join('\n');
  const covered = list.filter((term) => haystack.includes(term));
  const missing = list.filter((term) => !haystack.includes(term));

  return { covered, missing, ratio: covered.length / list.length };
}

/*
 * 根拠の強さを判定する。
 *
 * options:
 *   question    … 利用者の質問（正規化前でよい）
 *   sources     … selectSources() が選んだ資料
 *   minLevel    … これ未満なら answerable=false
 *
 * 戻り値:
 *   { level, stars, label, coverage, missing, covered, bestMatch,
 *     answerable, reason, perSource }
 */
export function assessGrounding({ question, sources = [], minLevel = MIN_ANSWERABLE_LEVEL } = {}) {
  const list = Array.isArray(sources) ? sources : [];
  const terms = queryTerms(normalizeQuestion(question));

  if (list.length === 0) {
    return {
      level: GroundingLevel.NONE,
      stars: starsFor(0),
      label: GROUNDING_LABEL_JA[0],
      coverage: 0,
      covered: [],
      missing: terms,
      bestMatch: 0,
      /* 制限を 0 にしている場合だけ、資料なしでも生成を許す。 */
      answerable: GroundingLevel.NONE >= Number(minLevel),
      reason: 'no-sources',
      perSource: [],
    };
  }

  const { covered, missing, ratio } = termCoverage(terms, list);
  const perSource = list.map((source) => ({
    id: source.id,
    chunkId: source.chunkId,
    ratio: matchRatio(terms, source),
  }));

  const bestMatch = perSource.reduce((max, entry) => Math.max(max, entry.ratio), 0);

  const level = levelFor(ratio, bestMatch, list.length);

  return {
    level,
    stars: starsFor(level),
    label: GROUNDING_LABEL_JA[level],
    coverage: ratio,
    covered,
    missing,
    bestMatch,
    answerable: level >= minLevel,
    reason: level >= minLevel ? 'ok' : 'weak-grounding',
    perSource,
  };
}

/*
 * 段階の決め方。
 *
 * 主軸は「質問の語を資料がどれだけ含むか（coverage）」。
 * 加えて、1件の資料に集中して含まれている（bestMatch が高い）ほど
 * 引用として使いやすいので、ひと段階上げる。
 *
 * ------------------------------------------------------------------
 * しきい値を厳しくしすぎない
 * ------------------------------------------------------------------
 * 資料が質問に答えていても、言い回しが違えば被覆率は下がる。
 * 「経費精算については別途定めます」のように、
 * 話題は合っているが答えが書かれていない資料もある。
 *
 * そうした資料まで機械的に切ると、
 * 本来なら「資料には〜までしか書かれていません」と正しく答えられる場面まで
 * 断ってしまい、かえって使えないものになる。
 *
 * ここで断るのは「語がまったく、あるいはほとんど重ならない」場合に限り、
 * 残りは★の段階として開示して、利用者の判断に委ねる。
 * ------------------------------------------------------------------
 */
function levelFor(coverage, bestMatch, sourceCount) {
  if (sourceCount === 0 || coverage <= 0) {
    return GroundingLevel.NONE;
  }

  let level;

  if (coverage >= 0.7) {
    level = GroundingLevel.HIGH;
  } else if (coverage >= 0.5) {
    level = GroundingLevel.MEDIUM;
  } else if (coverage >= 0.3) {
    level = GroundingLevel.LOW;
  } else {
    level = GroundingLevel.VERY_LOW;
  }

  /* 1件の資料がほぼ全部の語を含むなら、根拠として明確。 */
  if (bestMatch >= 0.7 && level < GroundingLevel.VERY_HIGH) {
    level += 1;
  }

  return Math.min(GroundingLevel.VERY_HIGH, level);
}

/*
 * 回答本文の [n] を検証する。
 *
 * モデルは、渡していない番号を書くことがある（典型的な作り話）。
 * 表示前に検出して、画面で注意を出せるようにする。
 *
 * 戻り値:
 *   { cited, unknown, unused, ok }
 *     cited   … 実在する資料番号（昇順・重複なし）
 *     unknown … 資料に存在しない番号
 *     unused  … 渡したのに引用されなかった番号
 */
export function validateCitations(answerText, sources = []) {
  const text = String(answerText ?? '');
  const ids = new Set((Array.isArray(sources) ? sources : []).map((s) => Number(s.id)));

  const found = new Set();
  const matches = text.match(/\[(\d{1,3})\]/g) ?? [];

  matches.forEach((token) => {
    const n = Number(token.slice(1, -1));
    if (Number.isFinite(n)) {
      found.add(n);
    }
  });

  const cited = [...found].filter((n) => ids.has(n)).sort((a, b) => a - b);
  const unknown = [...found].filter((n) => !ids.has(n)).sort((a, b) => a - b);
  const unused = [...ids].filter((n) => !found.has(n)).sort((a, b) => a - b);

  return { cited, unknown, unused, ok: unknown.length === 0 && cited.length > 0 };
}

/*
 * 回答本文を [n] で分解する（表示用）。
 *
 * innerHTML を使わずに引用番号だけリンクにするため、
 * 「文字列」と「引用」の並びへ分けて返す。
 *   [{ type:'text', value }, { type:'citation', id, valid }]
 */
export function splitCitations(text, sources = []) {
  const source = String(text ?? '');
  const ids = new Set((Array.isArray(sources) ? sources : []).map((s) => Number(s.id)));
  const parts = [];

  let index = 0;
  const pattern = /\[(\d{1,3})\]/g;
  let match = pattern.exec(source);

  while (match !== null) {
    if (match.index > index) {
      parts.push({ type: 'text', value: source.slice(index, match.index) });
    }

    const id = Number(match[1]);
    parts.push({ type: 'citation', id, valid: ids.has(id) });

    index = match.index + match[0].length;
    match = pattern.exec(source);
  }

  if (index < source.length) {
    parts.push({ type: 'text', value: source.slice(index) });
  }

  return parts;
}

function haystackOf(source) {
  return [
    String(source?.text ?? ''),
    String(source?.fileName ?? ''),
    String(source?.heading ?? ''),
    String(source?.folderName ?? ''),
  ].join('\n').toLowerCase();
}

/*
 * 検索用トークナイザと MiniSearch の設定。
 *
 * ------------------------------------------------------------------
 * 日本語を検索できるようにするための実装（重要）
 * ------------------------------------------------------------------
 * MiniSearch の既定トークナイザは空白・記号で区切るため、
 * 日本語のように単語を空白で区切らない言語ではほとんどヒットしない。
 *
 * ここでは形態素解析器を持ち込まず、
 *   - 日本語（ひらがな・カタカナ・漢字）の連なり … bigram（2文字ずつ）へ分解
 *   - それ以外（英数字など）                     … 従来どおり区切り文字で分割
 * とすることで、辞書なしで部分一致を成立させる。
 *
 * 短所として、bigramのAND一致になるため「東京都」の検索が
 * 「東京」と「京都」を別々に含む文書へ当たることがある。
 * 取りこぼしよりは許容できると判断している。
 * 将来ベクトル検索を足す場合も、この全文検索はそのまま併用できる。
 * ------------------------------------------------------------------
 *
 * DOM に依存しない純モジュール（Worker からも Node からも読める）。
 */

/* ひらがな / カタカナ / 漢字 / 繰り返し記号 / 長音符 の連なり。 */
const JA_RUN = /[぀-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿々〆ー]+/g;

/* 日本語以外は「文字でも数字でもないもの」で区切る。 */
const NON_JA_SPLIT = /[^\p{L}\p{N}]+/u;

function pushNonJa(part, tokens) {
  if (part === '') {
    return;
  }

  part.split(NON_JA_SPLIT).forEach((token) => {
    if (token !== '') {
      tokens.push(token);
    }
  });
}

export function tokenize(text) {
  const source = String(text ?? '');

  if (source === '') {
    return [];
  }

  const tokens = [];
  let lastIndex = 0;
  let match;

  JA_RUN.lastIndex = 0;

  while ((match = JA_RUN.exec(source)) !== null) {
    pushNonJa(source.slice(lastIndex, match.index), tokens);

    const run = match[0];

    /*
     * bigram だけを出す。「語そのもの」を混ぜてはならない。
     * 本文中の日本語は長く連続するため（例: 「有給休暇について説明します」）
     * 語全体のトークンは文書側にほぼ現れない。検索語だけに語全体が入ると
     * combineWith: 'AND' で必ず外れる。文書側と検索側で同じ規則にする。
     *
     * 1文字だけの連なりはその文字を出す。1文字の検索語は
     * searchOptions.prefix により「その文字で始まるbigram」に当たる。
     */
    if (run.length === 1) {
      tokens.push(run);
      lastIndex = match.index + run.length;
      continue;
    }

    for (let i = 0; i < run.length - 1; i += 1) {
      tokens.push(run.slice(i, i + 2));
    }

    lastIndex = match.index + run.length;
  }

  pushNonJa(source.slice(lastIndex), tokens);

  return tokens;
}

export function processTerm(term) {
  const value = String(term ?? '').toLowerCase();
  return value === '' ? null : value;
}

/* MiniSearch のコンストラクタ／loadJSON へ渡す設定。両者で必ず同じものを使う。 */
export const MINISEARCH_OPTIONS = Object.freeze({
  idField: 'chunkId',
  fields: ['fileName', 'heading', 'text', 'folderName'],
  storeFields: ['fileId', 'fileName', 'heading', 'chunkIndex', 'updatedTime', 'driveUrl', 'text'],
  tokenize,
  processTerm,
  searchOptions: {
    boost: { fileName: 3, heading: 2, folderName: 1.2 },
    prefix: true,
    /*
     * bigram に対してあいまい検索を強く効かせると誤ヒットが増えるため、
     * 表記ゆれを拾える範囲に留める。
     */
    fuzzy: 0.15,
    combineWith: 'AND',
  },
});

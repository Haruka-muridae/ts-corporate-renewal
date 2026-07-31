/*
 * OCRが返した一続きのテキストを、名刺の項目へ振り分ける。
 *
 * このファイルは純粋関数だけで構成する。
 * DOM・fetch・Drive・Sheets・アクセストークンのいずれも参照しない。
 * 入力は文字列、出力はオブジェクト。だからブラウザのコンソールから
 * import しただけで単体で動作確認できる（この性質を壊さないこと）。
 *
 * ------------------------------------------------------------------
 * この方式の限界（設計の前提）
 * ------------------------------------------------------------------
 * Google ドライブのOCRが返すのはレイアウト情報を失った一続きのテキストである。
 * したがって次の区別ができる。
 *   ・書式が決まっているもの（メール・URL・郵便番号・電話・FAX）
 *   ・法人格を含む会社名
 * 一方、氏名・部署・役職の切り分けは原理的に安定しない。
 * 名刺の並び順は会社ごとに違い、テキストの順序だけでは
 * 「営業本部」「部長」「山田太郎」を確実に判別できない。
 *
 * そのため matched は「正規表現が実際に一致したか（自動入力の根拠があるか）」を
 * 返し、UI側が「要確認」を出せるようにしてある。
 * 氏名は positive なパターンではなく除外条件で選ぶため、値が入っても
 * matched を false のままにする（根拠が弱いことを画面に正直に出すため）。
 * ------------------------------------------------------------------
 */

import {
  createEmptyMatched,
  createEmptyValues,
  dedupeEmails,
  FIELDS,
  normalizeEmail,
} from './fields.js';

/* ==================================================================
 * 正規表現・キーワード定数
 * 判定ロジックから分離し、追加・修正はここだけで済むようにする。
 * ================================================================== */

/* 全角英数記号（！〜～）。全角スペースは別に扱う。 */
const FULLWIDTH_ASCII_RE = /[！-～]/g;
const FULLWIDTH_SPACE_RE = /　/g;

/*
 * ハイフンに見える文字。
 * U+2010–2015（ハイフン〜ダッシュ類） / U+2212（マイナス） / U+30FC（長音符）。
 * 長音符を含むのは「03ー1234」のような表記があるため。
 * ただし置換は数字に挟まれた位置だけに限定する（サービス→サ-ビスを防ぐ）。
 */
const DASH_CLASS = '\\u2010-\\u2015\\u2212\\u30FC\\uFF0D-';
const DASH_BETWEEN_DIGITS_RE = new RegExp(`(\\d)[ \\t]*[${DASH_CLASS}][ \\t]*(?=\\d)`, 'g');

/* ラベルの後ろの区切り記号（TEL. TEL: Tel/ など）を空白へ揃える。 */
const LATIN_LABEL_SEPARATOR_RE = /\b(TEL|FAX|PHONE|MOBILE|CELL)[ \t]*[.:/|]+[ \t]*/gi;
const JA_LABEL_SEPARATOR_RE = /(電話|携帯|ファクス|ファックス|直通|代表)[ \t]*[.:/|]+[ \t]*/g;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/*
 * URL。スキーム・www は任意。
 * 末尾のラベル（TLD）が既知のものに限る。これが無いと
 * 「Co.Ltd」のような社名表記までURLとして拾ってしまう。
 */
const URL_RE = /(?:https?:\/\/)?(?:www\.)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?:\/[^\s]*)?/g;
const KNOWN_TLDS = Object.freeze([
  'jp', 'com', 'net', 'org', 'info', 'biz', 'io', 'dev', 'app',
  'me', 'tech', 'site', 'work', 'shop', 'store', 'asia', 'tokyo',
  'co', 'ne', 'or', 'ac', 'go', 'gr', 'ed', 'lg', 'inc', 'llc',
]);
/* 優先して採用するURL（会社サイトである可能性が高いもの）。 */
const PREFERRED_URL_RE = /(?:^https?:\/\/)|(?:^www\.)|(?:\.co\.jp)|(?:\.com)|(?:\.jp$)|(?:\.net)/i;

/*
 * SNS・共有サービスのホスト。ここに当たったURLは website ではなく socialUrl へ回す。
 * 会社サイトとSNSが両方載っている名刺で、SNS側に上書きされるのを防ぐ。
 */
const SOCIAL_HOST_RE = /(?:^|\.)(x\.com|twitter\.com|facebook\.com|fb\.com|instagram\.com|linkedin\.com|note\.com|youtube\.com|youtu\.be|tiktok\.com|threads\.net|line\.me|lin\.ee|wantedly\.com|github\.com|qiita\.com|zenn\.dev|pinterest\.com|ameblo\.jp|hatenablog\.com|substack\.com|bento\.me|linktr\.ee)(?:\/|$)/i;

/* 郵便番号。〒付きを優先し、無い場合は前後が数字・ハイフンでないことを条件にする。 */
const POSTAL_WITH_MARK_RE = /〒[ \t]*(\d{3})-?[ \t]*(\d{4})/;
const POSTAL_BARE_RE = /(\d{3})-?(\d{4})/g;

/* 電話番号の並び。ハイフン付きを先に試す。 */
const PHONE_RE = /0\d{1,4}-\d{1,4}-\d{4}|0\d{9,10}/g;

/* 番号の直前に現れるラベル。最も右にあるものを採用する。 */
const PHONE_LABELS = Object.freeze([
  { kind: 'fax', re: /(FAX|Fax|fax|F\.|ファクス|ファックス)/g },
  { kind: 'mobile', re: /(携帯|Mobile|MOBILE|mobile|M\.|Cell|CELL|cell)/g },
  { kind: 'tel', re: /(TEL|Tel|tel|T\.|電話|直通|代表)/g },
]);

/* ラベルが無いときに携帯と見なす先頭3桁。 */
const MOBILE_PREFIX_RE = /^0(70|80|90)/;

/* 法人格。会社名の手がかりはこれだけに絞る。 */
const COMPANY_RE = /(株式会社|有限会社|合同会社|合資会社|合名会社|\(株\)|\(有\)|一般社団法人|一般財団法人|公益社団法人|公益財団法人|特定非営利活動法人|NPO法人|Co\.,?\s?Ltd\.?|Inc\.?|Corporation|LLC)/;

/* 都道府県・番地。住所行の手がかり。 */
const PREFECTURE_RE = /(東京都|北海道|京都府|大阪府|[一-龥]{2,3}県)/;
const STREET_RE = /(\d+丁目|\d+-\d+-\d+|\d+番地)/;
/* 住所の続き（ビル名・階）と判断する行。 */
const BUILDING_RE = /(ビル|階|棟|号室|F$|Ｆ$)/;
const BUILDING_MAX_LENGTH = 30;

/* 役職。 */
const TITLE_RE = /(代表取締役|取締役|執行役員|監査役|社長|副社長|専務|常務|本部長|部長|次長|課長|係長|主任|主席|顧問|マネージャー|リーダー|チーフ|CEO|COO|CTO|CFO|President|Director|Manager)/;

/* 部署。 */
const DEPARTMENT_RE = /(事業部|本部|部|課|室|センター|支店|営業所|支社|グループ|チーム|Division|Department)/;

/* 氏名に使える文字（漢字・ひらがな・カタカナ）。 */
const NAME_CHARS_RE = /^[぀-ゟ゠-ヿ一-鿿々〆ヶ]+$/;
const NAME_MIN_LENGTH = 2;
const NAME_MAX_LENGTH = 10;
/* 氏名の候補から外す文字。 */
const NAME_REJECT_RE = /[0-9@/]/;

/*
 * かなだけで構成された行（ふりがな）。漢字を1文字も含まないことが条件。
 * 「やまだ たろう」「ヤマダ タロウ」の両方を受ける。
 */
const KANA_ONLY_RE = /^[぀-ゟ゠-ヿー\s]+$/;
/* ふりがなのラベル。行頭に付いていることがあるので取り除く。 */
const KANA_LABEL_RE = /^(ふりがな|フリガナ|よみ|ヨミ|読み|kana|KANA|Kana)[ \t]*[:：]?[ \t]*/;

/* ==================================================================
 * 正規化
 * ================================================================== */

function toHalfWidth(text) {
  return text
    .replace(FULLWIDTH_ASCII_RE, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(FULLWIDTH_SPACE_RE, ' ');
}

/*
 * OCRのテキストを比較しやすい形へ整える。
 *
 * 1. 改行を \n に統一し、各行を trim して空行を落とす
 * 2. 全角英数記号を半角へ、全角スペースを半角へ
 * 3. ハイフンに見える文字を、数字に挟まれた位置だけ - へ統一する
 * 4. TEL. TEL: Tel/ のような区切りを空白へ揃える
 *
 * 3 を位置で限定するのは、カタカナの長音符を壊さないため。
 * 「サービス」「センター」を「サ-ビス」「セ-ンタ-」にしてはいけない。
 */
export function normalizeText(rawText) {
  if (typeof rawText !== 'string' || rawText === '') {
    return '';
  }

  const unified = rawText.replace(/\r\n?/g, '\n');

  const lines = unified
    .split('\n')
    .map((line) => toHalfWidth(line))
    .map((line) => line.replace(DASH_BETWEEN_DIGITS_RE, '$1-'))
    .map((line) => line
      .replace(LATIN_LABEL_SEPARATOR_RE, (match, label) => `${label} `)
      .replace(JA_LABEL_SEPARATOR_RE, (match, label) => `${label} `))
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line !== '');

  return lines.join('\n');
}

/* ==================================================================
 * 消費済み範囲の管理
 *
 * 破壊的な文字列置換で消していくと後の判定で位置がずれるため、
 * 「行番号 + 文字範囲」の集合として保持する。文字列自体は書き換えない。
 * ================================================================== */

function createConsumed(lineCount) {
  return Array.from({ length: lineCount }, () => []);
}

function markRange(consumed, lineIndex, start, end) {
  if (lineIndex < 0 || lineIndex >= consumed.length) {
    return;
  }
  consumed[lineIndex].push([start, end]);
}

function markWholeLine(consumed, lineIndex, lines) {
  if (lineIndex < 0 || lineIndex >= consumed.length) {
    return;
  }
  markRange(consumed, lineIndex, 0, lines[lineIndex].length);
}

/* 指定範囲がまだどの項目にも使われていないか。 */
function isRangeFree(consumed, lineIndex, start, end) {
  if (lineIndex < 0 || lineIndex >= consumed.length) {
    return false;
  }
  return consumed[lineIndex].every(([s, e]) => end <= s || start >= e);
}

function isLineTouched(consumed, lineIndex) {
  return consumed[lineIndex].length > 0;
}

/* 消費済み範囲を除いた残りの文字列。会社名などの切り出しに使う。 */
function remainingText(consumed, lineIndex, lines) {
  const text = lines[lineIndex];
  const ranges = [...consumed[lineIndex]].sort((a, b) => a[0] - b[0]);

  let out = '';
  let position = 0;

  ranges.forEach(([start, end]) => {
    if (start > position) {
      out += text.slice(position, start);
    }
    position = Math.max(position, end);
  });

  out += text.slice(position);

  return out.replace(/\s+/g, ' ').trim();
}

/* ==================================================================
 * 項目ごとの抽出
 * それぞれ小さく保ち、巨大な1関数にしない。
 * ================================================================== */

/*
 * メールアドレスを **すべて** 取り出す。
 *
 * 1枚の名刺に個人宛と代表宛が併記されることがあるため、1件目で打ち切らない。
 * 出現順を保ったまま返し、どれをメインにするかは利用者が確認画面で選ぶ。
 * 先頭を初期のメインにするのは、名刺では本人のアドレスが先に来ることが多いため。
 */
function extractEmails(lines, consumed) {
  const found = [];

  for (let i = 0; i < lines.length; i += 1) {
    const matches = [...lines[i].matchAll(EMAIL_RE)];

    for (const match of matches) {
      const start = match.index;
      const end = start + match[0].length;

      if (!isRangeFree(consumed, i, start, end)) {
        continue;
      }

      markRange(consumed, i, start, end);
      found.push(match[0].toLowerCase());
    }
  }

  return dedupeEmails(found);
}

function isKnownTld(candidate) {
  const host = candidate.replace(/^https?:\/\//i, '').split('/')[0];
  const labels = host.split('.').filter(Boolean);

  if (labels.length < 2) {
    return false;
  }

  return KNOWN_TLDS.includes(labels[labels.length - 1].toLowerCase());
}

function isSocialUrl(value) {
  const host = String(value).replace(/^https?:\/\//i, '').split('/')[0];
  return SOCIAL_HOST_RE.test(host) || SOCIAL_HOST_RE.test(value);
}

/*
 * URLを取り出し、会社サイトとSNS等に振り分ける。
 *
 * 戻り値: { website, socialUrl }
 *   website  … SNS以外のうち、最も会社サイトらしいもの1件
 *   socialUrl … SNS等。複数あれば改行区切りで連結する
 *
 * 分けるのは、SNSのURLで会社サイトの欄が埋まってしまうのを防ぐため。
 */
function extractUrls(lines, consumed) {
  const candidates = [];

  for (let i = 0; i < lines.length; i += 1) {
    const matches = [...lines[i].matchAll(URL_RE)];

    for (const match of matches) {
      const start = match.index;
      /* 末尾の句読点はURLに含めない。 */
      const raw = match[0].replace(/[.,;:。、]+$/, '');
      const end = start + raw.length;

      if (raw === '' || !isKnownTld(raw)) {
        continue;
      }

      /* メールとして採用済みの範囲は除外する。 */
      if (!isRangeFree(consumed, i, start, end)) {
        continue;
      }

      candidates.push({ lineIndex: i, start, end, value: raw });
    }
  }

  if (candidates.length === 0) {
    return { website: '', socialUrl: '' };
  }

  const socials = candidates.filter((item) => isSocialUrl(item.value));
  const sites = candidates.filter((item) => !isSocialUrl(item.value));

  const picked = [];
  let website = '';

  if (sites.length > 0) {
    const preferred = sites.find((item) => PREFERRED_URL_RE.test(item.value)) ?? sites[0];
    website = preferred.value;
    picked.push(preferred);
  }

  /* SNSは1件に絞らない。名刺に複数載っていれば全部残す。 */
  socials.forEach((item) => picked.push(item));

  picked.forEach((item) => markRange(consumed, item.lineIndex, item.start, item.end));

  return {
    website,
    socialUrl: socials.map((item) => item.value).join('\n'),
  };
}

function extractPostalCode(lines, consumed) {
  /* 〒付きを優先する。 */
  for (let i = 0; i < lines.length; i += 1) {
    const match = POSTAL_WITH_MARK_RE.exec(lines[i]);

    if (match) {
      const start = match.index;
      const end = start + match[0].length;

      if (isRangeFree(consumed, i, start, end)) {
        markRange(consumed, i, start, end);
        return { value: `${match[1]}-${match[2]}`, lineIndex: i, end };
      }
    }
  }

  /*
   * 〒が無い場合。
   * 電話番号の一部（03-1234-5678 の「234-5678」など）を拾わないよう、
   * 前後の文字が数字・ハイフンでないことを条件にする。
   */
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i];
    const matches = [...text.matchAll(POSTAL_BARE_RE)];

    for (const match of matches) {
      const start = match.index;
      const end = start + match[0].length;
      const before = start > 0 ? text[start - 1] : '';
      const after = end < text.length ? text[end] : '';

      if (/[\d-]/.test(before) || /[\d-]/.test(after)) {
        continue;
      }

      if (isRangeFree(consumed, i, start, end)) {
        markRange(consumed, i, start, end);
        return { value: `${match[1]}-${match[2]}`, lineIndex: i, end };
      }
    }
  }

  return { value: '', lineIndex: -1, end: 0 };
}

/* 番号の直前の文字列から、最も右にあるラベルの種類を返す。 */
function resolveLabelKind(prefix) {
  let best = null;

  PHONE_LABELS.forEach(({ kind, re }) => {
    const matches = [...prefix.matchAll(re)];

    if (matches.length === 0) {
      return;
    }

    const last = matches[matches.length - 1];

    if (!best || last.index > best.index) {
      best = { kind, index: last.index };
    }
  });

  return best?.kind ?? '';
}

/*
 * 電話・FAX・携帯を取り出す。
 *
 * 1行に複数入ることが多い（TEL 03-1234-5678 FAX 03-1234-5679）ため、
 * 行単位ではなく「ラベルと番号のペア」で走査する。
 * 直前の文字列に複数のラベルがある場合は、最も番号に近いものを採用する。
 *
 * 同種が2件目以降のときは extras へ回し、備考へ載せる。
 */
function extractPhones(lines, consumed) {
  const found = { tel: '', mobile: '', fax: '' };
  const extras = [];

  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i];
    const matches = [...text.matchAll(PHONE_RE)];
    let cursor = 0;

    for (const match of matches) {
      const start = match.index;
      const end = start + match[0].length;
      const prefix = text.slice(cursor, start);
      cursor = end;

      /* 郵便番号やURLとして使った範囲は対象外。 */
      if (!isRangeFree(consumed, i, start, end)) {
        continue;
      }

      const number = match[0];
      const labelKind = resolveLabelKind(prefix);

      let kind;

      if (labelKind === 'fax') {
        kind = 'fax';
      } else if (labelKind === 'mobile' || MOBILE_PREFIX_RE.test(number)) {
        kind = 'mobile';
      } else {
        /* TEL・電話・直通・代表、またはラベルが無い場合。 */
        kind = 'tel';
      }

      markRange(consumed, i, start, end);

      if (found[kind] === '') {
        found[kind] = number;
      } else {
        extras.push(number);
      }
    }
  }

  return { ...found, extras };
}

function extractCompany(lines, consumed) {
  for (let i = 0; i < lines.length; i += 1) {
    if (!COMPANY_RE.test(lines[i])) {
      continue;
    }

    /* 電話番号やURLとして消費済みの部分を除いた残りを社名とする。 */
    const rest = remainingText(consumed, i, lines);

    if (rest === '') {
      continue;
    }

    markWholeLine(consumed, i, lines);
    return { value: rest, lineIndex: i };
  }

  return { value: '', lineIndex: -1 };
}

/*
 * 住所を取り出す。次の順で探し、最初に見つかったものを採る。
 *   1. 郵便番号と同じ行の、郵便番号より後ろ
 *   2. 郵便番号の次の行
 *   3. 都道府県、または番地の並びを含む行
 * ビル名・階が次行に分かれている場合は連結する。
 */
function extractAddress(lines, consumed, postal) {
  const pick = (lineIndex, text) => {
    if (!text) {
      return null;
    }

    let value = text;
    markWholeLine(consumed, lineIndex, lines);

    const nextIndex = lineIndex + 1;

    if (nextIndex < lines.length
      && !isLineTouched(consumed, nextIndex)
      && lines[nextIndex].length <= BUILDING_MAX_LENGTH
      && BUILDING_RE.test(lines[nextIndex])) {
      value = `${value} ${lines[nextIndex]}`;
      markWholeLine(consumed, nextIndex, lines);
    }

    return value.replace(/\s+/g, ' ').trim();
  };

  /* 1. 郵便番号と同じ行の後ろ側 */
  if (postal.lineIndex >= 0) {
    const sameLine = lines[postal.lineIndex].slice(postal.end).trim();
    const picked = pick(postal.lineIndex, sameLine);

    if (picked) {
      return picked;
    }

    /* 2. 郵便番号の次の行 */
    const nextIndex = postal.lineIndex + 1;

    if (nextIndex < lines.length && !isLineTouched(consumed, nextIndex)) {
      const picked2 = pick(nextIndex, lines[nextIndex]);

      if (picked2) {
        return picked2;
      }
    }
  }

  /* 3. 都道府県・番地を含む行 */
  for (let i = 0; i < lines.length; i += 1) {
    if (isLineTouched(consumed, i)) {
      continue;
    }

    if (PREFECTURE_RE.test(lines[i]) || STREET_RE.test(lines[i])) {
      const picked = pick(i, lines[i]);

      if (picked) {
        return picked;
      }
    }
  }

  return '';
}

/*
 * 役職と部署。
 * 同じ行にある場合（営業部 部長）は分割する。
 * 空白があれば空白で、無ければ役職キーワードの位置で切る。
 */
function extractTitleAndDepartment(lines, consumed) {
  let title = '';
  let department = '';

  for (let i = 0; i < lines.length; i += 1) {
    if (isLineTouched(consumed, i) || title !== '') {
      continue;
    }

    const text = lines[i];

    if (!TITLE_RE.test(text)) {
      continue;
    }

    const parts = text.split(/\s+/).filter(Boolean);

    if (parts.length > 1) {
      const titleParts = parts.filter((part) => TITLE_RE.test(part));
      const deptParts = parts.filter((part) => !TITLE_RE.test(part) && DEPARTMENT_RE.test(part));

      title = titleParts.join(' ');
      department = deptParts.join(' ');
    } else {
      const match = TITLE_RE.exec(text);
      const head = text.slice(0, match.index).trim();

      title = text.slice(match.index).trim();

      if (head !== '' && DEPARTMENT_RE.test(head)) {
        department = head;
      }
    }

    markWholeLine(consumed, i, lines);
  }

  /* 役職と同じ行に無かった場合は、部署だけの行を探す。 */
  if (department === '') {
    for (let i = 0; i < lines.length; i += 1) {
      if (isLineTouched(consumed, i)) {
        continue;
      }

      if (COMPANY_RE.test(lines[i]) || !DEPARTMENT_RE.test(lines[i])) {
        continue;
      }

      department = lines[i];
      markWholeLine(consumed, i, lines);
      break;
    }
  }

  return { title, department };
}

/*
 * 氏名と氏名かな。最も外れる項目なので、条件をすべて満たす行だけを候補にする。
 * 候補が無ければ空文字を返す（適当な行を入れない）。
 *
 * 名刺では氏名の上にふりがなが載ることが多い。上から順に1件目を氏名とすると、
 * ふりがなの行を氏名として採ってしまうため、候補を先に全部集めてから
 *   ・漢字を含む候補 … 氏名
 *   ・かなだけの候補 … 氏名かな
 * に振り分ける。漢字の候補が無ければ、かなの先頭を氏名として扱う
 * （かな表記だけの名刺があるため、氏名を空にはしない）。
 *
 * 戻り値: { name, nameKana }
 */
function extractNameAndKana(lines, consumed) {
  const candidates = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (isLineTouched(consumed, i)) {
      continue;
    }

    const text = lines[i].replace(KANA_LABEL_RE, '').trim();

    if (text === '' || NAME_REJECT_RE.test(text)) {
      continue;
    }

    if (COMPANY_RE.test(text) || DEPARTMENT_RE.test(text) || TITLE_RE.test(text)) {
      continue;
    }

    const parts = text.split(/\s+/).filter(Boolean);

    /* 「姓 名」のように空白は1つまで。 */
    if (parts.length > 2) {
      continue;
    }

    if (!parts.every((part) => NAME_CHARS_RE.test(part))) {
      continue;
    }

    const length = parts.join('').length;

    if (length < NAME_MIN_LENGTH || length > NAME_MAX_LENGTH) {
      continue;
    }

    candidates.push({ lineIndex: i, text, kana: KANA_ONLY_RE.test(text) });
  }

  if (candidates.length === 0) {
    return { name: '', nameKana: '' };
  }

  const kanjiCandidate = candidates.find((item) => !item.kana);
  const kanaCandidate = candidates.find((item) => item.kana);

  /* 漢字の候補が無いときは、かなの先頭を氏名にする（かな欄は埋めない）。 */
  if (!kanjiCandidate) {
    markWholeLine(consumed, kanaCandidate.lineIndex, lines);
    return { name: kanaCandidate.text, nameKana: '' };
  }

  markWholeLine(consumed, kanjiCandidate.lineIndex, lines);

  if (!kanaCandidate) {
    return { name: kanjiCandidate.text, nameKana: '' };
  }

  markWholeLine(consumed, kanaCandidate.lineIndex, lines);

  return { name: kanjiCandidate.text, nameKana: kanaCandidate.text };
}

/* どの項目にも振り分けられなかった行と、2件目以降の電話番号。 */
function extractNote(lines, consumed, extras) {
  const leftovers = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (!isLineTouched(consumed, i)) {
      leftovers.push(lines[i]);
    }
  }

  return [...leftovers, ...extras].join('\n');
}

/* ==================================================================
 * 入口
 * ================================================================== */

/*
 * OCRテキストを項目へ振り分ける。
 *
 * 戻り値:
 *   values  … FIELDS の全キーを持つ。取れなかった項目は空文字
 *   matched … キーごとの真偽値。正規表現が実際に一致したか（自動入力の根拠）
 *   lines   … 正規化後の行の配列（画面での確認用）
 *
 * 高確度のものから順に取り、一度使った部分は後続の判定から除外する。
 * これにより、電話番号として消費した文字列を住所側で拾うことがない。
 */
export function parseCardText(rawText) {
  const normalized = normalizeText(rawText);
  const lines = normalized === '' ? [] : normalized.split('\n');

  const values = createEmptyValues();
  const matched = createEmptyMatched();

  if (lines.length === 0) {
    return { values, matched, lines };
  }

  const consumed = createConsumed(lines.length);

  /* 1. 書式が決まっているもの */
  values.emails = extractEmails(lines, consumed);
  values.primaryEmail = values.emails[0] ?? '';

  const urls = extractUrls(lines, consumed);
  values.website = urls.website;
  values.socialUrl = urls.socialUrl;

  const postal = extractPostalCode(lines, consumed);
  values.postalCode = postal.value;

  const phones = extractPhones(lines, consumed);
  values.tel = phones.tel;
  values.mobile = phones.mobile;
  values.fax = phones.fax;

  /* 2. キーワードを手がかりにするもの */
  const company = extractCompany(lines, consumed);
  values.company = company.value;

  values.address = extractAddress(lines, consumed, postal);

  const titleAndDepartment = extractTitleAndDepartment(lines, consumed);
  values.title = titleAndDepartment.title;
  values.department = titleAndDepartment.department;

  /* 3. 除外条件で選ぶもの */
  const person = extractNameAndKana(lines, consumed);
  values.name = person.name;
  values.nameKana = person.nameKana;

  /* 4. 残り */
  values.note = extractNote(lines, consumed, phones.extras);

  /*
   * matched は「positive なパターンが一致したか」を表す。
   *
   * 氏名は他項目に採用されなかった行を除外条件で選んでいるだけで、
   * 「氏名である」という根拠となるパターンは存在しない。
   * 値が入っていても false のままにし、UI側で「要確認」を出させる。
   * 備考も振り分けの結果ではないため false。
   */
  FIELDS.forEach((field) => {
    if (field.key === 'name' || field.key === 'nameKana' || field.key === 'note') {
      matched[field.key] = false;
      return;
    }

    matched[field.key] = values[field.key] !== '';
  });

  matched.emails = values.emails.length > 0;

  return { values, matched, lines };
}

/* ==================================================================
 * 表と裏の統合
 * ================================================================== */

/* 競合の判定用。表記ゆれ（空白・大文字小文字）だけを吸収する。 */
function normalizeForCompare(value) {
  return String(value ?? '').replace(/\s+/g, '').toLowerCase();
}

/*
 * 表面と裏面の解析結果を1件へまとめる。
 *
 * 方針:
 *   ・表面を優先する。裏面は「表面が空だった項目」を埋めるためだけに使う
 *   ・両面に値があって内容が違う場合、勝手に上書きしない。
 *     表面の値を採ったうえで conflicts に記録し、UI が両方を見せて選ばせる
 *   ・メールは単一値ではないため競合させず、和集合にする
 *
 * back が null（裏面なし）のときは front をそのまま返す。
 *
 * 戻り値:
 *   values    … 統合後の値
 *   matched   … 統合後の根拠。裏面から補完した項目は false（要確認を出す）
 *   conflicts … [{ key, label, frontValue, backValue, resolvable }]
 *
 * この関数も純粋関数のまま保つこと（DOM・fetch を持ち込まない）。
 */
export function mergeParsed(front, back) {
  const frontValues = front?.values ?? createEmptyValues();
  const frontMatched = front?.matched ?? createEmptyMatched();

  const values = createEmptyValues();
  const matched = createEmptyMatched();
  const conflicts = [];

  if (!back) {
    FIELDS.forEach((field) => {
      values[field.key] = frontValues[field.key] ?? '';
      matched[field.key] = frontMatched[field.key] === true;
    });

    values.emails = dedupeEmails(frontValues.emails);
    values.primaryEmail = frontValues.primaryEmail ?? values.emails[0] ?? '';
    matched.emails = frontMatched.emails === true;

    return { values, matched, conflicts };
  }

  const backValues = back.values ?? createEmptyValues();
  const backMatched = back.matched ?? createEmptyMatched();

  FIELDS.forEach((field) => {
    const frontValue = String(frontValues[field.key] ?? '');
    const backValue = String(backValues[field.key] ?? '');

    if (frontValue === '') {
      /*
       * 裏面から補完した項目は、根拠があっても matched を落とす。
       * 「どちらの面から来た値か」は画面から見えないため、必ず確認させる。
       */
      values[field.key] = backValue;
      matched[field.key] = false;
      return;
    }

    values[field.key] = frontValue;
    matched[field.key] = frontMatched[field.key] === true;

    if (backValue !== '' && normalizeForCompare(frontValue) !== normalizeForCompare(backValue)) {
      conflicts.push({
        key: field.key,
        label: field.label,
        frontValue,
        backValue,
        /* 入力欄が1つなので、裏面の値へ差し替えられる。 */
        resolvable: true,
      });
    }
  });

  /* メールは和集合。表面由来を先に並べる。 */
  const frontEmails = dedupeEmails(frontValues.emails);
  const backEmails = dedupeEmails(backValues.emails);
  const merged = dedupeEmails([...frontEmails, ...backEmails]);

  values.emails = merged;
  values.primaryEmail = frontValues.primaryEmail || backValues.primaryEmail || merged[0] || '';
  matched.emails = (frontMatched.emails === true) && backEmails.length === 0;

  const frontKeys = new Set(frontEmails.map((item) => normalizeEmail(item)));
  const added = backEmails.filter((item) => !frontKeys.has(normalizeEmail(item)));

  if (added.length > 0 && frontEmails.length > 0) {
    conflicts.push({
      key: 'emails',
      label: 'メールアドレス',
      frontValue: frontEmails.join('\n'),
      backValue: added.join('\n'),
      /* 競合ではなく追加なので、採用ボタンは出さない（すでに一覧へ入っている）。 */
      resolvable: false,
    });
  }

  return { values, matched, conflicts };
}

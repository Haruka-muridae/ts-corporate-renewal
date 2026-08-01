/*
 * アプリの配置（並び順とページ数）を決める層。
 *
 * ------------------------------------------------------------------
 * ここに閉じるもの
 * ------------------------------------------------------------------
 * localStorage の読み取りと JSON.parse の失敗処理を、このファイルの外へ出さない。
 * 描画側（portal.js）は「アプリの配列」を受け取るだけにする。
 *
 * 保存データは利用者が開発者ツールから書き換えられる場所である。
 * 壊れた値で画面が開かなくなるより、既定順へ戻って開くほうがよい。
 * したがって **この層は例外を投げない。**
 * ------------------------------------------------------------------
 *
 * 書き込み（並べ替えの保存）は第2便で実装する。
 * 現時点では読むだけで、このファイルは localStorage へ1バイトも書かない。
 *
 * 詳細は docs/specs/apps-grid-spec-v1.md。
 */

/* 配置データの保存キー。変えると既存利用者の並びが失われる。 */
export const LAYOUT_STORAGE_KEY = 'tsam-app-layout';

/*
 * 保存形式の版。
 * 形が変わったときに上げる。読み込み側は一致しなければ既定順へ倒す（§4-d）。
 */
export const LAYOUT_VERSION = 1;

/* 1ページの枠数。2列×4行。 */
export const PAGE_SIZE = 8;

/*
 * 最低ページ数。
 * アプリが0件でも2ページぶんの枠を出す。
 * 「1ページしかない」状態だとページ送りの存在自体が伝わらない。
 */
export const MIN_PAGES = 2;

/**
 * アプリ件数からページ数を出す。
 *
 *   0〜8件  → 2ページ（最低ページ数）
 *   9件     → 2ページ（ceil(9/8) = 2）
 *   17件    → 3ページ
 */
export function pageCountFor(appCount) {
  const count = Number(appCount);
  const safe = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;

  return Math.max(MIN_PAGES, Math.ceil(safe / PAGE_SIZE));
}

/**
 * 保存されている文字列を配置データへ直す。
 *
 * 読めない・形が違う・版が違う場合はすべて null を返す。
 * 呼び出し側は null を「保存が無い」と同じに扱えばよい（§4-d）。
 */
export function parseLayout(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return null;
  }

  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch {
    /* 壊れた JSON。既定順へ倒す。 */
    return null;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  /*
   * 版が違うものは読まない。
   * 中身の形が変わっている可能性があり、推測で解釈すると
   * 「並びが微妙に違う」という気づきにくい壊れ方をする。
   */
  if (parsed.version !== LAYOUT_VERSION) {
    return null;
  }

  if (!Array.isArray(parsed.order)) {
    return null;
  }

  /* 文字列でない要素・空文字は落とす。 */
  const order = parsed.order
    .filter((id) => typeof id === 'string')
    .map((id) => id.trim())
    .filter((id) => id !== '');

  return { version: LAYOUT_VERSION, order };
}

/* 保存先が使えない環境（プライベートモード等）でも画面は壊さない。 */
function getStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * 保存されている配置データを読む。無ければ null。
 *
 * localStorage を触るのはこの関数だけにする。
 */
export function readStoredLayout() {
  const storage = getStorage();

  if (!storage) {
    return null;
  }

  try {
    return parseLayout(storage.getItem(LAYOUT_STORAGE_KEY));
  } catch {
    return null;
  }
}

/**
 * 定義と保存データから、実際に並べる順序を決める。
 *
 * 規則（§4）:
 *   a. 保存済み order にある ID は、その順で先に出す
 *   b. order に無い既知アプリは、定義の順で末尾へ足す
 *   c. order にある未知 ID（定義に無い）は無視する
 *   d. 保存が無い・読めない・版違いなら、定義の順そのまま
 *
 * 戻り値は定義に入っていたオブジェクトそのもの（複製しない）。
 */
export function resolveAppOrder(registry, stored = null) {
  const apps = Array.isArray(registry) ? registry.filter((app) => app && typeof app === 'object') : [];

  /* id を持たない定義は並べようがないので落とす。 */
  const known = new Map();

  apps.forEach((app) => {
    const id = typeof app.id === 'string' ? app.id.trim() : '';

    if (id !== '' && !known.has(id)) {
      known.set(id, app);
    }
  });

  const defaults = [...known.values()];

  if (!stored || !Array.isArray(stored.order)) {
    return defaults;
  }

  const placed = new Set();
  const ordered = [];

  stored.order.forEach((id) => {
    /* c: 定義に無い ID は無視する。d と違い、ここでは既定順へ倒さない。 */
    if (!known.has(id) || placed.has(id)) {
      return;
    }

    placed.add(id);
    ordered.push(known.get(id));
  });

  /* b: order に載っていない既知アプリを、定義の順で末尾へ。 */
  defaults.forEach((app) => {
    if (!placed.has(app.id)) {
      ordered.push(app);
    }
  });

  return ordered;
}

/**
 * 並べる順序をページごとに切り分ける。
 *
 * 足りない枠は null で埋める。呼び出し側は null を「準備中」として描く。
 * 「空きは null」と決めておけば、描画側に件数計算が散らばらない。
 */
export function paginate(apps, pageCount = pageCountFor(apps.length)) {
  const pages = [];

  for (let page = 0; page < pageCount; page += 1) {
    const slots = [];

    for (let slot = 0; slot < PAGE_SIZE; slot += 1) {
      slots.push(apps[page * PAGE_SIZE + slot] ?? null);
    }

    pages.push(slots);
  }

  return pages;
}

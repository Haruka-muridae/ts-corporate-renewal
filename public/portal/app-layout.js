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
 *
 * v1 … order は「表示順」だった（全アプリが並び、順序だけを持つ）
 * v2 … order は「**お気に入りのID列**」（載っていないアプリはカタログへ）
 *
 * 同じ `order` という名前で意味が変わったため版を上げた。
 * v1 のデータを v2 として読むと、全アプリが勝手にお気に入りへ入る。
 * 読み込み側は一致しなければ既定（お気に入り空）へ倒す（§4-d）。
 */
export const LAYOUT_VERSION = 2;

/* 1ページの枠数。お気に入りは 2列×4行。 */
export const PAGE_SIZE = 8;

/* カタログ（全アプリ一覧）の1ページの枠数。2列×10行。 */
export const CATALOG_PAGE_SIZE = 20;

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
 * カタログのページ数。
 *
 * お気に入り側と違い、**最低ページ数を持たない**（埋め枠も置かない）。
 * カタログは「まだ選んでいないアプリの一覧」であって、
 * 枠を並べて見せるものではない。0件なら一文だけ出す。
 */
export function catalogPageCount(appCount) {
  const count = Number(appCount);
  const safe = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;

  return Math.max(1, Math.ceil(safe / CATALOG_PAGE_SIZE));
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

/* 定義を id で引ける形にする。id を持たないものは並べようがないので落とす。 */
function indexRegistry(registry) {
  const apps = Array.isArray(registry) ? registry.filter((app) => app && typeof app === 'object') : [];
  const known = new Map();

  apps.forEach((app) => {
    const id = typeof app.id === 'string' ? app.id.trim() : '';

    if (id !== '' && !known.has(id)) {
      known.set(id, app);
    }
  });

  return known;
}

/**
 * 定義と保存データから、**お気に入り**の並びを決める。
 *
 * 規則（§4）:
 *   a. 保存済み order にある ID は、その順で出す
 *   b. order に無い既知アプリは **お気に入りに入れない**（カタログへ回る）
 *   c. order にある未知 ID（定義に無い）は無視する
 *   d. 保存が無い・読めない・版違いなら、**お気に入りは空**
 *
 * v1 との違いは b と d。v1 では「載っていないものを末尾へ足す」
 * 「保存が無ければ全件」だった。v2 では order がお気に入りそのものなので、
 * 載っていない＝選ばれていない、を意味する。
 *
 * 戻り値は定義に入っていたオブジェクトそのもの（複製しない）。
 */
export function resolveFavorites(registry, stored = null) {
  const known = indexRegistry(registry);

  if (!stored || !Array.isArray(stored.order)) {
    /* d: 既定はお気に入り空。全アプリはカタログに出る。 */
    return [];
  }

  const placed = new Set();
  const favorites = [];

  stored.order.forEach((id) => {
    /* c: 定義に無い ID は無視する。重複も最初の1件だけ。 */
    if (!known.has(id) || placed.has(id)) {
      return;
    }

    placed.add(id);
    favorites.push(known.get(id));
  });

  return favorites;
}

/**
 * お気に入りに入っていないアプリ＝カタログ（全アプリ一覧）。
 *
 * 並びは**定義の順**。カタログ側の順序は利用者が決めるものではない。
 */
export function resolveCatalog(registry, favorites = []) {
  const known = indexRegistry(registry);
  const chosen = new Set((Array.isArray(favorites) ? favorites : []).map((app) => app?.id));

  return [...known.values()].filter((app) => !chosen.has(app.id));
}

/**
 * 並びの中で1件を別の位置へ移す（押しのけ方式）。
 *
 * 元の位置から抜き、目的の位置へ挿し込む。あいだの要素は1つずつずれる。
 * **入れ替え（swap）ではない。** 2件だけが入れ替わると、
 * 掴んだものが遠くへ飛んだように見える。
 *
 *   moveItem(['a','b','c','d'], 3, 0) → ['d','a','b','c']
 *
 * 範囲外の `to` は端へ寄せる。準備中の枠（アプリ数より後ろ）へ落としたときに
 * 「末尾へ」と解釈されるのは、この丸め込みによる。
 * `from` が範囲外なら、何もせず複製を返す。
 *
 * 元の配列は書き換えない。
 */
export function moveItem(list, from, to) {
  const items = Array.isArray(list) ? [...list] : [];
  const fromIndex = Number(from);

  if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= items.length) {
    return items;
  }

  const toRaw = Number(to);
  const last = items.length - 1;
  const toIndex = Number.isFinite(toRaw)
    ? Math.min(Math.max(Math.floor(toRaw), 0), last)
    : last;

  if (toIndex === fromIndex) {
    return items;
  }

  const [moved] = items.splice(fromIndex, 1);
  items.splice(toIndex, 0, moved);

  return items;
}

/**
 * 並びを保存する。保存できたかどうかを返す。
 *
 * 第1便では読むだけだったが、第2便で書き込みが要る。
 * 読み取りと同じくこの層に閉じ、描画側から localStorage を触らせない。
 *
 * 保存に失敗しても例外は投げない。画面上の並びは呼び出し側が保つ。
 */
export function writeStoredLayout(order) {
  const storage = getStorage();

  if (!storage) {
    return false;
  }

  const ids = (Array.isArray(order) ? order : [])
    .filter((id) => typeof id === 'string')
    .map((id) => id.trim())
    .filter((id) => id !== '');

  try {
    storage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({ version: LAYOUT_VERSION, order: ids }),
    );
    return true;
  } catch {
    /* 容量超過・書き込み禁止。保存できなかったことを返す。 */
    return false;
  }
}

/**
 * 保存を消す（「初期配置に戻す」）。
 *
 * 消したあとは保存が無い状態＝既定順（§4-d）へ戻る。
 * 空の order を書くのではなく、キーごと消す。
 */
export function clearStoredLayout() {
  const storage = getStorage();

  if (!storage) {
    return false;
  }

  try {
    storage.removeItem(LAYOUT_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
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

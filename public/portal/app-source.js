/*
 * アプリ一覧の取得元（暫定DB＝Googleスプレッドシート）。
 *
 * ==================================================================
 * シートの中身を信用しない
 * ==================================================================
 * ここへ入ってくるのは、**画面の外で編集される値**である。
 * 誰かが列を1つずらす、URL欄に `javascript:` を書く、
 * 名前欄にタグを書く、といったことが起こりうる。
 *
 * したがって、この層を通ったあとの値は次を満たすようにする。
 *
 *   - `href` は http:// か https:// で始まる絶対URLだけ
 *   - `id` と `name` は空でない文字列
 *   - 1行でも壊れていたら、その行だけ捨てる（全体は落とさない）
 *
 * **描画側は textContent と href への代入だけを行う。**
 * innerHTML へ流さないこと。ここで弾いていても、
 * 流す口があれば別の経路から入る。
 * ==================================================================
 *
 * 取得は Google の CSV 出力（gviz）へブラウザから直接 fetch する。
 * サーバーを1つも挟まないので、キーも中継も要らない。
 *
 * **シートが「リンクを知っている全員が閲覧可」になっていることが前提。**
 * 未設定のあいだは 401 が返る。その場合は取得失敗として扱い、
 * キャッシュか組み込みの一覧で描く（docs/specs/apps-grid-spec-v1.md §15）。
 */

/*
 * 対象のスプレッドシート。
 *
 * この値は配信される JS に含まれるため、閲覧者から見える。
 * 「リンクを知っている全員が閲覧可」の共有設定と同じ強さしかない。
 * **秘密にできる値ではないので、秘密にすべき情報をこのシートへ置かないこと。**
 *
 * 仕様書にはこの値を書いていない（docs/specs/README.md の
 * 「スプレッドシートIDを仕様書へ書かない」ルールによる）。
 * 差し替えるときはここだけを直す。
 */
const SHEET_ID = '1GJvEPDhbacM33OEi2WaL-m1d51H6wX-t3_X6_5tXFX8';

/* シート「アプリ一覧」。gid はシートのタブごとに変わる。 */
const SHEET_GID = '0';

/* 取得したものを置いておく場所。配置データ（tsam-app-layout）とは別。 */
export const CACHE_STORAGE_KEY = 'tsam-app-registry-cache';

/* キャッシュの形の版。形を変えたら上げる（読み込み側は一致しなければ捨てる）。 */
export const CACHE_VERSION = 1;

/* 応答が返らないときに、いつまでも待たない。 */
const FETCH_TIMEOUT_MS = 8000;

/** CSV 出力のURL。 */
export function sheetCsvUrl(id = SHEET_ID, gid = SHEET_GID) {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}`
    + `/gviz/tq?tqx=out:csv&gid=${encodeURIComponent(gid)}`;
}

/**
 * CSV を行×列へ分解する。
 *
 * 引用符の中のカンマ・改行・二重引用符（`""`）に対応する。
 * 正規表現や `split(',')` では、住所や説明文にカンマが入った時点で崩れる。
 *
 * 改行は CRLF / LF / CR のいずれも1行の区切りとして扱う。
 */
export function parseCsv(text) {
  const source = String(text ?? '');
  const rows = [];

  let row = [];
  let field = '';
  let quoted = false;
  let index = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };

  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (index < source.length) {
    const char = source[index];

    if (quoted) {
      if (char === '"') {
        /* "" は引用符そのもの。それ以外の " は引用の終わり。 */
        if (source[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }

        quoted = false;
        index += 1;
        continue;
      }

      field += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      quoted = true;
      index += 1;
      continue;
    }

    if (char === ',') {
      endField();
      index += 1;
      continue;
    }

    if (char === '\r' || char === '\n') {
      endRow();
      /* CRLF は1つの区切りとして飲む。 */
      index += (char === '\r' && source[index + 1] === '\n') ? 2 : 1;
      continue;
    }

    field += char;
    index += 1;
  }

  /* 最後の行に改行が無いこともある。 */
  if (field !== '' || row.length > 0) {
    endRow();
  }

  /* 空行は落とす。末尾の改行で1行増えるのを防ぐ。 */
  return rows.filter((cells) => cells.some((cell) => String(cell).trim() !== ''));
}

/* http(s) の絶対URLだけを通す。javascript: や data: は弾く。 */
function safeUrl(value) {
  const text = String(value ?? '').trim();

  if (!/^https?:\/\//i.test(text)) {
    return '';
  }

  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? text : '';
  } catch {
    return '';
  }
}

/*
 * 1行目がヘッダーかどうか。
 *
 * 「アプリID」などの見出し語か、URL列がURLになっていないことで見分ける。
 * ヘッダーが無いシートでも、1行目を取りこぼさない。
 */
function looksLikeHeader(cells) {
  const first = String(cells[0] ?? '').trim();
  const url = String(cells[2] ?? '').trim();

  if (/^(アプリ\s*ID|ID|app\s*id)$/i.test(first)) {
    return true;
  }

  /* 見出し語でなくても、URL列がURLでなければデータ行ではない。 */
  return url !== '' && safeUrl(url) === '';
}

/**
 * 行の並びをアプリの定義へ直す。
 *
 * 列は A:アプリID / B:アプリ名 / C:アプリURL / D:アイコンURL。
 *
 * 落とす行:
 *   - ID が空
 *   - ID が重複（先に出たほうを採る）
 *   - 名前が空
 *   - URL が http(s):// でない
 *
 * 1行が壊れていても、その行だけを捨てて残りは活かす。
 * シートの1か所の打ち間違いで一覧全体が消えるほうが困る。
 *
 * アイコンURLが不正なときは、行を落とさず icon だけ空にする
 * （名前の1文字目へ落ちる。§14-2）。
 */
export function rowsToApps(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const seen = new Set();
  const apps = [];

  list.forEach((cells, index) => {
    if (index === 0 && looksLikeHeader(cells)) {
      return;
    }

    const id = String(cells[0] ?? '').trim();
    const name = String(cells[1] ?? '').trim();
    const href = safeUrl(cells[2]);

    if (id === '' || name === '' || href === '' || seen.has(id)) {
      return;
    }

    seen.add(id);
    apps.push({ id, name, href, icon: safeUrl(cells[3]) });
  });

  return apps;
}

/* キャッシュから読み戻した値も、取得直後と同じ検査を通す。 */
function normalizeApps(list) {
  const rows = (Array.isArray(list) ? list : [])
    .filter((app) => app && typeof app === 'object')
    .map((app) => [app.id, app.name, app.href, app.icon]);

  /* ヘッダー判定を働かせない（1行目もデータとして扱う）。 */
  return rowsToApps([[], ...rows]).slice(0);
}

function getStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * 最後に取得できた一覧を返す。無ければ空配列。
 *
 * 壊れた値・版違いは「無い」として扱う。例外は投げない。
 */
export function readCachedApps() {
  const storage = getStorage();

  if (!storage) {
    return [];
  }

  try {
    const raw = storage.getItem(CACHE_STORAGE_KEY);

    if (typeof raw !== 'string' || raw === '') {
      return [];
    }

    const parsed = JSON.parse(raw);

    if (parsed === null || typeof parsed !== 'object' || parsed.version !== CACHE_VERSION) {
      return [];
    }

    return normalizeApps(parsed.apps);
  } catch {
    return [];
  }
}

/** 取得できた一覧を控えておく。保存できたかどうかを返す。 */
export function writeCachedApps(apps) {
  const storage = getStorage();

  if (!storage) {
    return false;
  }

  try {
    storage.setItem(CACHE_STORAGE_KEY, JSON.stringify({
      version: CACHE_VERSION,
      fetchedAt: new Date().toISOString(),
      apps: normalizeApps(apps),
    }));
    return true;
  } catch {
    return false;
  }
}

/**
 * シートから一覧を取り直す。
 *
 * 戻り値は `{ ok, apps, reason }`。**例外は投げない。**
 * 呼び出し側は ok を見て、失敗ならキャッシュか組み込みの一覧で描く。
 *
 * 0件は失敗として扱う。共有設定が未了だと Google はログイン画面の
 * HTML を返すため、素直に解析すると「0件のシート」と区別がつかない。
 * 空の一覧を出すより、前回の内容を残すほうがよい。
 */
export async function fetchApps({ fetchImpl, url = sheetCsvUrl() } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;

  if (typeof doFetch !== 'function') {
    return { ok: false, apps: [], reason: 'NO_FETCH' };
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null;

  try {
    const response = await doFetch(url, {
      /* 公開シートを読むだけ。資格情報は送らない。 */
      credentials: 'omit',
      signal: controller?.signal,
    });

    if (!response?.ok) {
      return { ok: false, apps: [], reason: `HTTP_${response?.status ?? 0}` };
    }

    const apps = rowsToApps(parseCsv(await response.text()));

    if (apps.length === 0) {
      return { ok: false, apps: [], reason: 'EMPTY' };
    }

    return { ok: true, apps, reason: '' };
  } catch {
    return { ok: false, apps: [], reason: 'NETWORK' };
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

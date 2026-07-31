/*
 * 配信ベースパスの解決と、遷移先URLの検証。
 *
 * ------------------------------------------------------------------
 * なぜ必要か
 * ------------------------------------------------------------------
 * このサイトは次の両方で配信されうる。
 *
 *   https://tsam-ai.com/apps/…                  （独自ドメイン）
 *   https://<user>.github.io/<repo>/apps/…      （プロジェクトPages）
 *
 * サイト内絶対パス（/apps/…）を書くと後者で404になる。
 * かといって相対パスだけでは、メールへ渡す絶対URL（redirectTo）を作れない。
 *
 * そこで「現在地から /apps/ の位置を求める」処理をここへ集約する。
 * 各所で lastIndexOf('/apps/') を書き散らさない。
 * ------------------------------------------------------------------
 */

/* アプリ群の入口ディレクトリ名。ここを変えるとベースパスの求め方が変わる。 */
const APPS_SEGMENT = '/apps/';

/* 遷移先として受け付ける最大長。 */
const MAX_NEXT_LENGTH = 512;

/* 現在のページURL。取得できない環境（テスト等）では null。 */
function currentHref() {
  try {
    return globalThis.location?.href ?? null;
  } catch {
    return null;
  }
}

/*
 * アプリ群の基底URL（末尾スラッシュ付きの絶対URL）を返す。
 *
 *   https://tsam-ai.com/apps/login/          → https://tsam-ai.com/apps/
 *   https://x.github.io/repo/apps/home/      → https://x.github.io/repo/apps/
 *   https://x.github.io/repo/apps/index.html → https://x.github.io/repo/apps/
 *
 * /apps/ が見つからない場合は、現在のディレクトリを基底とみなす。
 * 取得できない場合は null。
 */
export function getAppBaseUrl(href = currentHref()) {
  if (typeof href !== 'string' || href === '') {
    return null;
  }

  let url;

  try {
    url = new URL(href);
  } catch {
    return null;
  }

  /*
   * lastIndexOf を使う。リポジトリ名が "apps" の場合
   * （/apps/apps/login/）でも、最後の出現＝アプリ群の入口になる。
   */
  const index = url.pathname.lastIndexOf(APPS_SEGMENT);

  if (index === -1) {
    /* /apps/ 配下でない。現在のディレクトリを基底にする。 */
    return new URL('./', url).href;
  }

  return new URL(url.pathname.slice(0, index + APPS_SEGMENT.length), url.origin).href;
}

/*
 * アプリ群の基底からの相対パスを、絶対URLへ解決する。
 *
 *   resolveAppUrl('auth-callback/') → https://tsam-ai.com/apps/auth-callback/
 */
export function resolveAppUrl(relativePath, href = currentHref()) {
  const base = getAppBaseUrl(href);

  if (!base) {
    return null;
  }

  try {
    return new URL(relativePath, base).href;
  } catch {
    return null;
  }
}

/*
 * 制御文字を取り除く。
 * 'java\nscript:' のような難読化を、判定の前に潰しておく。
 */
function stripControlChars(value) {
  let cleaned = '';

  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);

    if (code > 0x1f && code !== 0x7f) {
      cleaned += value[i];
    }
  }

  return cleaned;
}

/*
 * 遷移先として安全な相対パスだけを通す。
 *
 * ------------------------------------------------------------------
 * 文字列の見た目だけで判断してはいけない（重要）
 * ------------------------------------------------------------------
 * ブラウザのURL解析（WHATWG URL）は、http/https では
 * **バックスラッシュをスラッシュとして扱う**。
 *
 *   new URL('\\\\evil.example.com', 'https://tsam-ai.com/apps/login/')
 *     → https://evil.example.com/
 *
 * つまり startsWith('//') だけを見ていると、`\\evil.example.com` を
 * 「相対パス」と誤認して外部サイトへ飛ばしてしまう（オープンリダイレクト）。
 *
 * そのため、この関数は次の二段構えで判定する。
 *   1. 明らかに危険な形を文字列で弾く（スキーム・バックスラッシュ等）
 *   2. **実際に解決してみて**、同一オリジンかつ /apps/ 配下に
 *      収まっていることを確認する
 *
 * 2 が本命であり、1 は早期に弾くための補助にすぎない。
 * ------------------------------------------------------------------
 *
 * 戻り値: 受け付けた場合は元の相対文字列、拒否した場合は fallback。
 * 元の文字列を返すのは、サブパス配信でも壊れないようにするため。
 */
export function safeNextUrl(value, fallback = null, options = {}) {
  if (typeof value !== 'string') {
    return fallback;
  }

  /* JSの trim は全角空白・BOM・行区切りなどのUnicode空白も落とす。 */
  const raw = stripControlChars(value).trim();

  if (raw === '' || raw.length > MAX_NEXT_LENGTH) {
    return fallback;
  }

  /*
   * バックスラッシュは相対パスに使わない。
   * 上記のとおり解析時にスラッシュへ化けるため、含む時点で拒否する。
   */
  if (raw.includes('\\')) {
    return fallback;
  }

  /* プロトコル相対（//host）は別オリジンになりうる。 */
  if (raw.startsWith('//')) {
    return fallback;
  }

  /* スキーム付き（http: javascript: data: など）はすべて拒否する。 */
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    return fallback;
  }

  /*
   * サイト内絶対パス（/apps/home/）も拒否する。
   * プロジェクトPages（/リポジトリ名/…）配信で壊れるため、
   * このサイトでは相対パスに統一している。
   */
  if (raw.startsWith('/')) {
    return fallback;
  }

  /* ---- ここからが本命の検証 ---- */

  const appBase = options.appBase ?? getAppBaseUrl(options.href ?? currentHref());

  /*
   * 解決できない環境（location が無いテスト等）では、
   * 文字列判定までで許可する。ブラウザでは必ず下の検証を通る。
   */
  if (!appBase) {
    return raw;
  }

  const resolved = resolveNextUrl(raw, { appBase });

  if (!resolved) {
    return fallback;
  }

  return raw;
}

/*
 * next の値を、実際に遷移する絶対URLへ解決する。
 *
 * ------------------------------------------------------------------
 * なぜ現在のURLを基準にしないのか
 * ------------------------------------------------------------------
 * next は「/apps/ の直下にある画面から見た相対パス」と定義している
 * （例: '../home/'）。
 *
 * これを location.href 基準で解決すると、末尾スラッシュの有無で
 * 一段ずれる。
 *
 *   /apps/login/ を基準 → ../home/ は /apps/home/   （意図どおり）
 *   /apps/login  を基準 → ../home/ は /home/        （一段ずれる）
 *
 * 通常はサーバーが /apps/login → /apps/login/ へ寄せるため
 * 起きないが、検証と遷移が別々の基準を使うと
 * 「検証は通ったのに違う場所へ飛ぶ」ずれが生まれる。
 *
 * そこで **常に「/apps/ の1階層下」を基準に固定**し、
 * 検証と遷移で同じ基準を使う。
 * ------------------------------------------------------------------
 *
 * 戻り値: 安全な絶対URL、または null
 */
export function resolveNextUrl(value, options = {}) {
  if (typeof value !== 'string' || value === '') {
    return null;
  }

  const appBase = options.appBase ?? getAppBaseUrl(options.href ?? currentHref());

  if (!appBase) {
    return null;
  }

  let base;
  let resolved;

  try {
    /*
     * '_/' は「/apps/ の直下にある任意の画面」を表す仮の場所。
     * ここを基準にすると '../home/' が必ず '/apps/home/' になる。
     */
    base = new URL(appBase);
    resolved = new URL(value, new URL('_/', appBase));
  } catch {
    return null;
  }

  /* 別オリジンへ出るものは拒否（オープンリダイレクトの防止）。 */
  if (resolved.origin !== base.origin) {
    return null;
  }

  /*
   * /apps/ の外へ出るものも拒否する。
   * 「../../index.html」のように、同一オリジンでもアプリ群の外へ
   * 誘導できると、フィッシングの踏み台にされうる。
   */
  if (!resolved.pathname.startsWith(base.pathname)) {
    return null;
  }

  return resolved.href;
}

/*
 * 現在のページを、同じ階層の別ページから見た相対パスとして返す。
 * 「../<ディレクトリ名>/」の形になる。
 *
 * ログイン画面へ ?next= として渡すために使う。
 */
export function currentPageAsNext(href = currentHref()) {
  if (!href) {
    return null;
  }

  let url;

  try {
    url = new URL(href);
  } catch {
    return null;
  }

  const base = getAppBaseUrl(href);

  if (!base) {
    return null;
  }

  /* /apps/ からの相対パス（例: 'home/' や 'account/index.html'）。 */
  const relative = url.pathname.startsWith(new URL(base).pathname)
    ? url.pathname.slice(new URL(base).pathname.length)
    : '';

  /* ディレクトリ部分だけを取り出す（index.html は落とす）。 */
  const segments = relative.split('/').filter((s) => s !== '');
  const last = segments[segments.length - 1] ?? '';
  const dir = last.includes('.') ? segments.slice(0, -1) : segments;

  if (dir.length === 0) {
    return null;
  }

  /*
   * 呼び出し元（ログイン画面）は /apps/login/ にあるため、
   * そこから見た相対パスは '../<dir>/' になる。
   */
  return `../${dir.join('/')}/${url.search}`;
}

/*
 * Portal に並べる本番アプリの定義（レジストリ）。
 *
 * ------------------------------------------------------------------
 * 追加のしかた
 * ------------------------------------------------------------------
 * 本番アプリを公開したら、この配列へ1件足す。Portal 側のコードは触らない。
 *
 *   {
 *     id: 'voice-recorder',              // 一意。配置データ（order）の識別子になる
 *     name: '音声録音・MP3変換',           // カードに出す名前
 *     icon: '録',                        // 任意。文字か画像URL
 *     href: 'production-app/voice-recorder/',
 *   }
 *
 * ------------------------------------------------------------------
 * href の2通り
 * ------------------------------------------------------------------
 * サイト内 … **ルートからの相対パス。先頭に '/' を付けないこと。**
 *            portal.js はサイト内のリンクを `rootPath() + href` で組み立てる。
 *            先頭に '/' があると、その連結結果がスラッシュ2つになる。
 *
 *              'production-app/example/'
 *                → '../production-app/example/'
 *                → https://tsam-ai.com/production-app/example/
 *              '/production-app/example/'
 *                → '..//production-app/example/'
 *                → https://tsam-ai.com//production-app/example/   ← 別のURL
 *
 *            auth/ 配下は screenPath() / rootPath() で相対リンクに
 *            統一してある。1か所だけ絶対パスを混ぜると、深さの指定
 *            （setScreenDepth）が効かなくなる。
 * サイト外 … `https://` で始まる絶対URL。別タブで開き、
 *            rel="noopener noreferrer" が自動で付く。
 *
 * ------------------------------------------------------------------
 * icon の2通り
 * ------------------------------------------------------------------
 * 文字   … 1〜2文字（絵文字も可）。そのまま出す
 * 画像URL … `http(s)://` か `.svg` `.png` などで終わる文字列。
 *          `img` で読み込む。**読み込みに失敗したら名前の1文字目へ落とす**
 *
 * 省略すると名前の1文字目を使う。
 * 名前があればアイコンは必ず作れるため、枠だけのカードは並ばない。
 *
 * ------------------------------------------------------------------
 * `id` を後から変えない
 * ------------------------------------------------------------------
 * `id` は利用者の端末に保存される配置データ（`tsam-app-layout` の `order`）
 * が指す先である。変えると、その利用者が並べ替えた位置が失われ、
 * そのアプリは末尾へ戻る（docs/specs/apps-grid-spec-v1.md §4-c）。
 *
 * 名前や置き場所を変えるときも `id` は据え置くこと。
 *
 * ------------------------------------------------------------------
 * 追加する前に必ず行うこと
 * ------------------------------------------------------------------
 * そのアプリ自身にも認証確認を入れる。Portal に出さないだけでは
 * 「一覧に出ないだけで、URLを知っていれば開ける」状態になる。
 *
 *   import { guardPage } from '../../auth/session.js';
 *   import { setScreenDepth } from '../../auth/config.js';
 *
 *   setScreenDepth(2);                 // 階層に合わせる
 *   const user = await guardPage();
 *   if (!user) return;                 // ここで描画を止める
 *   render(user);
 *
 * 静的ホスティングでは HTML と JS の取得自体は防げない。
 * 秘密にすべき情報は、必ずサーバー側（Apps Script API）に置くこと。
 * 詳細は SECURITY_NOTES.md を参照。
 *
 * 既存の /apps/ 配下は **テスト環境** であり、ここには載せない。
 * 本番として提供すると決めたものだけを追加する。
 * ------------------------------------------------------------------
 */

/*
 * ==================================================================
 * ここに並んでいる3件は仮データである（2026-08-02）
 * ==================================================================
 * 遷移先もアイコンも暫定で、`localhost` を指すものが含まれる。
 * **本番の利用者の画面では、これらのアイコンは必ず読み込みに失敗する。**
 * 失敗したときは名前の1文字目を色付きの角丸で出す（app-card のフォールバック）。
 * つまり、当面はフォールバックのほうが実際の表示になる。
 *
 * この配列は、いずれデータベース（またはスプレッドシート）から
 * 取ってくる形へ移す。発動条件は docs/specs/apps-grid-spec-v1.md §7-4。
 *
 * それまでは、ここを直して push するのが唯一の追加手段である。
 * ==================================================================
 */
export const APP_REGISTRY = Object.freeze([
  Object.freeze({
    id: '202607No01',
    name: '音声録音・MP3変換アプリ',
    href: 'http://localhost:8000/apps/voice-recorder/',
    icon: 'http://localhost:8000/apps/assets/icons/voice-recorder.svg',
  }),
  Object.freeze({
    id: '202607No02',
    name: '領収書・収支管理システム',
    href: 'https://github.com/Haruka-muridae/ts-corporate-renewal/blob/main/apps/script.js',
    icon: 'http://localhost:8000/apps/assets/icons/receipt-manager.svg',
  }),
  Object.freeze({
    id: '202607No03',
    name: '電子契約書作成アプリ',
    href: 'https://haruka-muridae.github.io/ai-personal-lp/',
    icon: 'http://localhost:8000/apps/assets/icons/contract-creator.svg',
  }),

  /*
   * ここから下は実物。上の3件（仮データ）と違い、実際に動くアプリを指す。
   *
   * id は配置データ（tsam-app-layout の order）が指す先なので、
   * **あとから変えないこと**（apps-grid-spec-v1.md §4-c）。
   * アプリIDと同じ文字列にしてある（receipt-ocr-v2.md §2）。
   *
   * icon は文字1字。画像URLにすると読み込み失敗のフォールバックに
   * 頼ることになるため、実物には確実に出る文字を置く。
   */
  Object.freeze({
    id: 'receipt-ocr',
    name: '領収書スキャナ',
    href: 'production-app/receipt-ocr/',
    icon: '領',
  }),
  Object.freeze({
    id: 'card-ocr',
    name: '名刺OCR',
    href: 'production-app/card-ocr/',
    icon: '名',
  }),
]);

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
 * 仮データは残っていない（2026-08-19 に最後の2件を削除）
 * ==================================================================
 * 202607No02「領収書・収支管理システム」と 202607No03「電子契約書作成アプリ」は、
 * 遷移先が GitHub のソースファイルと個人の GitHub Pages、アイコンが
 * `http://localhost:8000/...` という仮のままだった。
 * 本番の利用者から見ると、押した先が当社のアプリではない場所であり、
 * アイコンは必ず読み込みに失敗して頭文字へ落ちる。
 * 「動くアプリだけを載せる」という約束のほうを採り、両方とも消した。
 *
 * **`id` は再利用しない。** 利用者の端末に残っている `tsam-app-layout` の
 * `order` にこの2つが載っていることがあるが、定義に無い ID は
 * 未知 ID として無視される（apps-grid-spec-v1.md §4-c）ので、
 * お気に入りから静かに外れるだけで済む。同じ番号を別のアプリへ振り直すと、
 * 外れたはずの位置に別のアプリが現れる。
 *
 * この配列は、スプレッドシート（app-source.js）が取れなかったときの
 * 最後の受け皿でもある（apps-grid-spec-v1.md §15-4）。
 * 取得できないあいだは、ここに書いたものがそのまま画面に出る。
 * ==================================================================
 */
export const APP_REGISTRY = Object.freeze([
  /*
   * 仮データから実物へ差し替えた（2026-08-05）。
   * `id` は据え置く。利用者が並べ替えた位置（tsam-app-layout の order）が
   * これを指しており、変えると位置が失われて末尾へ戻るため
   * （apps-grid-spec-v1.md §4-c）。名前と置き場所だけを更新している。
   */
  Object.freeze({
    id: '202607No01',
    name: 'ブラウザ録音',
    href: 'production-app/voice-recorder/',
    icon: '録',
  }),

  /*
   * ここから下も実物。すべて `production-app/` 配下の当社アプリを指す。
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
    id: 'short-script',
    name: 'ショート動画 台本メーカー',
    href: 'production-app/short-script/',
    icon: '台',
  }),
  Object.freeze({
    id: 'audio-transcriber',
    name: '音声文字起こし',
    href: 'production-app/audio-transcriber/',
    icon: '文',
  }),
  Object.freeze({
    id: 'threads-post',
    name: 'Threads 投稿',
    href: 'production-app/threads-post/',
    icon: '投',
  }),
  Object.freeze({
    id: 'x-post',
    name: 'X 投稿',
    href: 'production-app/x-post/',
    icon: 'X',
  }),
  Object.freeze({
    id: 'note-post',
    name: 'note 下書き',
    href: 'production-app/note-post/',
    icon: 'n',
  }),
  Object.freeze({
    id: 'meeting-minutes',
    name: 'AI議事録',
    href: 'production-app/meeting-minutes/',
    icon: '議',
  }),
  Object.freeze({
    id: 'interview-recorder',
    name: '面談録音',
    href: 'production-app/interview-recorder/',
    icon: '面',
  }),
  Object.freeze({
    id: 'card-manager',
    name: '名刺管理',
    href: 'production-app/card-manager/',
    icon: '管',
  }),

  /*
   * サイト外（別ドメイン）のアプリ。`href` が `https://` で始まるため、
   * portal.js が別タブで開き、rel="noopener noreferrer" を自動で付ける
   * （ファイル冒頭のコメント「href の2通り」参照）。
   */
  Object.freeze({
    id: 'pdf-narration',
    name: '教材ナレーション作成',
    href: 'https://pdf-narration-app.potenitas-lp.workers.dev/',
    icon: '教',
  }),
  Object.freeze({
    id: 'movecal',
    name: 'MoveCal（移動時間スケジューラ）',
    href: 'https://movecal.potenitas-lp.workers.dev/',
    icon: '移',
  }),
]);

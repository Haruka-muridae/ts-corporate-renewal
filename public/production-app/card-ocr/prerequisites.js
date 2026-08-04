/*
 * SC-00（前提確認画面）の状態判別。
 *
 * ==================================================================
 * ここに DOM を持ち込まない
 * ==================================================================
 * 判別は純粋関数にしてある。画面を組み立てずにテストできる状態を
 * 保つため、document・window・fetch を参照しない。
 * 画面への反映は app.js の仕事。
 * ==================================================================
 *
 * 要件定義書 §10.1:
 *   「SC-00は、未ログイン(→ /login/)、Google未連携(→ 連携ボタン)、
 *     キー未設定(→ Portal)の3状態を判別して**該当する誘導のみを表示する**」
 *
 * したがって evaluatePrerequisites は**状態を1つだけ返す。**
 * 複数の誘導を同時に出すと、利用者はどれから手を付ければよいか
 * 分からなくなる。
 */

/*
 * 判別の順序。**上から順に見て、最初に該当したものを返す。**
 *
 * ==================================================================
 * なぜ「キー」が「Google連携」より先なのか
 * ==================================================================
 * 要件定義書 §10.1 の列挙順は「ログイン → Google → キー」だが、
 * 案内する順序はそれとは別に決めてよい（列挙は状態の一覧であって
 * 手順ではない）。ここでは**キーを先にする。**
 *
 * キーが無い利用者は Portal へ行き、保存し、この画面へ戻ってくる。
 * 一方 Google のトークンは**メモリにしか持たない**（drive-auth.js）。
 * 先に連携させると、Portal へ移動した時点でトークンが消え、
 * 戻ってきてからもう一度ポップアップを踏むことになる。
 *
 * **ページを離れる用事を先に済ませる。** それだけの理由である。
 * ==================================================================
 */
export const Prerequisite = Object.freeze({
  /* TSAM AI に未ログイン。通常は guardPage() が /login/ へ飛ばす。 */
  SIGNED_OUT: 'SIGNED_OUT',
  /* localStorage が使えない。キーを保存する場所そのものが無い。 */
  KEYSTORE_UNAVAILABLE: 'KEYSTORE_UNAVAILABLE',
  /* Gemini キーが未設定。**本アプリでは必須。** */
  KEY_MISSING: 'KEY_MISSING',
  /* クライアントIDが未設定。利用者ではなく当社側の設定漏れ。 */
  CLIENT_ID_MISSING: 'CLIENT_ID_MISSING',
  /* Google 未連携。 */
  GOOGLE_NOT_LINKED: 'GOOGLE_NOT_LINKED',
  /* すべて揃っている。 */
  READY: 'READY',
});

/*
 * 誘導の種類。画面側はこれを見て、出すボタンやリンクを決める。
 * **1画面に1つだけ。**
 */
export const Guidance = Object.freeze({
  LOGIN: 'LOGIN',
  PORTAL: 'PORTAL',
  CONNECT: 'CONNECT',
  NONE: 'NONE',
});

/*
 * 前提を判別する。
 *
 * 入力はすべて真偽値で受け取る。KeyStore や GIS をこのモジュールから
 * 呼ばないのは、テストで実物を差し替える必要をなくすため。
 */
export function evaluatePrerequisites({
  signedIn = false,
  keyStoreAvailable = false,
  hasGeminiKey = false,
  clientIdConfigured = false,
  googleLinked = false,
} = {}) {
  if (!signedIn) {
    return Prerequisite.SIGNED_OUT;
  }

  if (!keyStoreAvailable) {
    return Prerequisite.KEYSTORE_UNAVAILABLE;
  }

  if (!hasGeminiKey) {
    return Prerequisite.KEY_MISSING;
  }

  if (!clientIdConfigured) {
    return Prerequisite.CLIENT_ID_MISSING;
  }

  if (!googleLinked) {
    return Prerequisite.GOOGLE_NOT_LINKED;
  }

  return Prerequisite.READY;
}

/*
 * 画面に出す言葉と誘導。エラーコードは要件定義書 §15 に対応する。
 *
 * **§15 に無いコードを作らない。**
 *
 * KEY_MISSING の文言について（FR-25 の3）:
 *   Portal 側に本アプリへ戻す仕組みは無い。next パラメータを付けると
 *   「戻ってくるはず」と読める導線になり、実際には戻らないため
 *   **付けない。** 代わりに「アプリ一覧から開き直す」ことを文言で示す。
 *   これで導線は循環しない。
 */
export function describePrerequisite(state) {
  switch (state) {
    case Prerequisite.SIGNED_OUT:
      return {
        title: 'ログインが必要です',
        text: 'TSAM AI にログインしてからご利用ください。',
        guidance: Guidance.LOGIN,
        errorCode: 'AUTH-001',
        blocking: true,
      };

    case Prerequisite.KEYSTORE_UNAVAILABLE:
      return {
        title: 'APIキーを保存できません',
        text: 'ブラウザの設定でデータの保存が制限されています。プライベートモードを解除するか、サイトのデータ保存を許可してください。',
        guidance: Guidance.NONE,
        errorCode: 'KEY-001',
        blocking: true,
      };

    case Prerequisite.KEY_MISSING:
      return {
        title: 'Gemini APIキーが未設定です',
        text: 'ポータルの「APIキー」からGeminiのキーを保存し、アプリ一覧からこの画面を開き直してください。キーはお使いの端末にのみ保存され、当社のサーバーへは送られません。',
        guidance: Guidance.PORTAL,
        errorCode: 'KEY-001',
        blocking: true,
      };

    case Prerequisite.CLIENT_ID_MISSING:
      return {
        title: 'Google連携の設定が未完了です',
        text: '現在ご利用いただけません。設定が整うまでお待ちください。',
        guidance: Guidance.NONE,
        errorCode: 'OAUTH-001',
        blocking: true,
      };

    case Prerequisite.GOOGLE_NOT_LINKED:
      return {
        title: 'Googleドライブとの連携が必要です',
        text: '読み取った名刺は、あなた自身のGoogleドライブに保存されます。「Googleと連携する」を押して許可してください。',
        guidance: Guidance.CONNECT,
        errorCode: 'OAUTH-001',
        blocking: true,
      };

    default:
      return {
        title: '準備ができました',
        text: '名刺の撮影・選択へ進めます。',
        guidance: Guidance.NONE,
        errorCode: null,
        blocking: false,
      };
  }
}

/*
 * 3つの前提それぞれの表示。**誘導とは別物。**
 *
 * 誘導は1つだけ出すが、状態の一覧は3つとも見せる。
 * 「何が足りないのか」と「次に何をするのか」は別の情報で、
 * 一覧が無いと利用者は自分がどこにいるのか分からなくなる。
 */
export function buildStatusList({
  signedIn = false,
  keyStoreAvailable = false,
  hasGeminiKey = false,
  googleLinked = false,
} = {}) {
  return [
    {
      id: 'signin',
      label: 'TSAM AI ログイン',
      ok: signedIn,
      text: signedIn ? 'ログイン済み' : '未ログイン',
    },
    {
      id: 'key',
      label: 'Gemini APIキー',
      ok: keyStoreAvailable && hasGeminiKey,
      text: keyStoreAvailable
        ? (hasGeminiKey ? '設定済み' : '未設定')
        : '保存できません',
    },
    {
      id: 'google',
      label: 'Googleドライブ連携',
      ok: googleLinked,
      text: googleLinked ? '連携済み' : '未連携',
    },
  ];
}

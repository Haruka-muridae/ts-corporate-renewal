/*
 * ヘルプ画面（§14.5 の対応事項1・2）。
 *
 * ==================================================================
 * ここでやることは1つだけ
 * ==================================================================
 * **ログインを確かめて、中身を出す。** それ以外は何もしない。
 * 外部通信もしない。状態も持たない。
 *
 * 本文は index.html に静的に書いてある。JavaScript が失敗しても
 * 内容そのものは HTML の中にあるので、**開発者ツールからでも読める。**
 * 告知の担い手として置く文書なので、動く仕掛けを増やさない。
 * ==================================================================
 *
 * guardPage() を通すのは本体と揃えるため（docs/specs/
 * card-ocr-terms-and-help-draft.md §3）。ログインできない利用者が
 * 連携解除の手順だけ読みたい、という場面は考えられるが、
 * **その手順は Google アカウント側の操作**なので、Google のヘルプでも
 * たどり着ける。ここだけ認証を外す理由にはしない。
 */

import { setScreenDepth } from '../../../auth/config.js';
import { guardPage } from '../../../auth/session.js';

/* /production-app/card-ocr/help/ はサイトのルートから3階層下。 */
setScreenDepth(3);

(async function start() {
  const user = await guardPage({ next: 'portal' });

  if (!user) {
    return;
  }

  document.getElementById('ch-loading').hidden = true;
  document.getElementById('ch-content').hidden = false;
}());

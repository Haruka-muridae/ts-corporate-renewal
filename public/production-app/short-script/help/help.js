/*
 * ヘルプ画面。
 *
 * ここでやることは1つだけ: **ログインを確かめて、中身を出す。**
 * 外部通信もしない。状態も持たない。本文は index.html に静的に書いてある。
 *
 * guardPage() を通すのは本体（../app.js）と揃えるため
 * （名刺OCR help/help.js と同じ方針）。
 */

import { setScreenDepth } from '../../../auth/config.js';
import { guardPage } from '../../../auth/session.js';

/* /production-app/short-script/help/ はサイトのルートから3階層下。 */
setScreenDepth(3);

(async function start() {
  const user = await guardPage({ next: 'portal' });

  if (!user) {
    return;
  }

  document.getElementById('sh-loading').hidden = true;
  document.getElementById('sh-content').hidden = false;
}());

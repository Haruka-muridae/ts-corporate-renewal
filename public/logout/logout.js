/*
 * ログアウト画面。
 *
 * 画面遷移だけでログアウト扱いにしない。
 * 必ずサーバー側のセッションを失効させてから、手元のトークンを消す。
 *
 * この画面は「メニューからログアウトしたい」「別の端末で開いたまま
 * 閉じてしまった」といった場合の入口として用意している。
 * Portal のログアウトボタンは、同じ処理をその場で呼ぶ。
 */

import { setScreenDepth } from '../auth/config.js';
import { signOut } from '../auth/session.js';
import { createMessageArea } from '../auth/ui.js';

setScreenDepth(1);

const leadElement = document.getElementById('logout-lead');
const linkElement = document.getElementById('logout-login-link');
const message = createMessageArea(document.getElementById('logout-message'));

async function run() {
  /*
   * signOut() はサーバーへの通知に失敗しても手元を消す。
   * 「消えていないかもしれない」状態で完了と表示しないよう、
   * 例外はここでも受け止める。
   */
  await signOut();

  leadElement.textContent = 'ログアウトしました。';
  message.show('ログアウトしました。続けてご利用になる場合は、もう一度ログインしてください。', 'success');
  linkElement.hidden = false;
}

run().catch(() => {
  leadElement.textContent = 'ログアウトの処理でエラーが発生しました。';
  message.show(
    'この端末のログイン情報は削除しました。念のため、共有端末の場合はブラウザを閉じてください。',
    'error',
  );
  linkElement.hidden = false;
});

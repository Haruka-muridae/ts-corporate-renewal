/*
 * 「不足フォルダを作成」の確認ダイアログ。
 *
 * 作成前に必ずこれを見せる。表示するのは要件どおり次の5点。
 *   1. 作成予定の階層（全体像）
 *   2. 既存フォルダ（再利用するもの）
 *   3. 新規作成するフォルダ
 *   4. 「ファイルの編集・削除は行わない」という説明
 *   5. キャンセル / 作成する
 *
 * フォルダ名は Drive 由来の外部文字列なので、すべて textContent 経由で出す。
 * 解決値: true = 作成する / false = キャンセル
 */

import { el, clear, replaceChildren } from '../core/dom.js';
import { NodeStatus, LABEL_BY_STATUS } from '../drive/folder-plan.js';
import { FOLDER_CREATE_SCOPE_LABEL, FOLDER_CREATE_SCOPE_MODE, getFolderCreateScope } from '../config.js';

export function openCreateFoldersDialog(plan) {
  return new Promise((resolve) => {
    const dialog = el('dialog', {
      class: 'dialog',
      'aria-label': '不足フォルダの作成を確認',
    });

    let settled = false;

    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      dialog.close();
      dialog.remove();
      resolve(value);
    };

    const missing = plan.missing ?? [];
    const existing = plan.existing ?? [];

    const confirmButton = el('button', {
      type: 'button',
      class: 'button',
      text: `${missing.length} 件を作成する`,
      onClick: () => finish(true),
    });

    const cancelButton = el('button', {
      type: 'button',
      class: 'button button--secondary',
      text: 'キャンセル',
      onClick: () => finish(false),
    });

    const body = el('div', { class: 'dialog__body' });

    replaceChildren(body, [
      /* 1. 作成予定の階層 */
      el('h3', { class: 'field__label', text: '作成後の階層' }),
      el('ul', { class: 'tree-list' }, (plan.entries ?? []).map((entry) => renderTreeRow(entry))),

      /* 2. 既存フォルダ */
      el('h3', { class: 'field__label', text: `既存フォルダ（再利用：${existing.length} 件）` }),
      existing.length > 0
        ? el('ul', { class: 'plain-list' }, existing.map((entry) => el('li', { text: entry.path ?? entry.node.name })))
        : el('p', { class: 'muted', text: '再利用できる既存フォルダはありません。' }),

      /* 3. 新規作成するフォルダ */
      el('h3', { class: 'field__label', text: `新規作成するフォルダ（${missing.length} 件）` }),
      missing.length > 0
        ? el('ul', { class: 'plain-list' }, missing.map((entry) => el('li', { text: entry.path ?? entry.node.name })))
        : el('p', { class: 'muted', text: '作成が必要なフォルダはありません。' }),

      /* 4. この操作が何をして、何をしないか（4点を必ず明示する） */
      el('div', { class: 'notice notice--info' }, [
        el('h3', { class: 'field__label', text: 'この操作について' }),
        el('ul', { class: 'plain-list' }, [
          el('li', {}, [
            el('strong', { text: 'フォルダのみ作成します。' }),
            'ファイルは作りません。',
          ]),
          el('li', {}, [
            el('strong', { text: '既存ファイルは編集・削除しません。' }),
            '移動もしません。編集・削除用のAPIは実装していません。',
          ]),
          el('li', {}, [
            el('strong', { text: '同期は開始しません。' }),
            'フォルダを作るだけで、ファイルの取得・解析は行いません。',
          ]),
          el('li', {}, [
            el('strong', { text: 'GoogleのDrive編集権限を一時的に使用します。' }),
            '作成が終わると、アプリ内部からこの権限を破棄します。',
          ]),
        ]),
      ]),

      el('p', { class: 'muted' }, [
        `必要な権限：${FOLDER_CREATE_SCOPE_LABEL[FOLDER_CREATE_SCOPE_MODE] ?? getFolderCreateScope()}`,
      ]),
      el('p', { class: 'muted', text: '「作成する」を押すとGoogleの確認画面が開きます。作成が終わると、この権限はアプリ内部から破棄されます。' }),
      el('p', { class: 'muted', text: 'キャンセルすれば、Driveには何も書き込みません。' }),
    ]);

    clear(dialog);
    dialog.append(
      el('div', { class: 'dialog__head' }, [
        el('h2', { class: 'card__title', text: '不足フォルダを作成します' }),
        el('p', {
          class: 'card__desc',
          text: '内容を確認してください。キャンセルすれば、Driveには何も書き込みません。',
        }),
      ]),
      body,
      el('div', { class: 'dialog__foot' }, [cancelButton, confirmButton]),
    );

    /* Esc で閉じた場合もキャンセル扱いにする。 */
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(false);
    });

    document.body.append(dialog);
    dialog.showModal();

    /*
     * 既定のフォーカスは「キャンセル」に置く。
     * Enter の連打で意図せず作成が始まらないようにするため。
     */
    cancelButton.focus();
  });
}

function renderTreeRow(entry) {
  const status = entry.status;
  const isNew = status === NodeStatus.MISSING;

  return el('li', {
    class: `tree-list__item tree-list__item--depth${entry.node.depth}`,
  }, [
    el('span', { class: 'tree-list__name', text: entry.node.name }),
    /* 色だけに頼らず、文字でも状態が分かるようにする。 */
    el('span', {
      class: isNew ? 'tag tag--new' : 'tag',
      text: LABEL_BY_STATUS[status] ?? '',
    }),
  ]);
}

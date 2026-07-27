/*
 * Google Picker が使えないときのフォルダ選択フォールバック。
 *
 * Drive API の files.list（フォルダのみ）でマイドライブを辿る。
 * Picker と同じ戻り値 { id, name } を返し、呼び出し側は違いを意識しない。
 *
 * 表示はすべて textContent 経由で行う（フォルダ名は外部由来のため）。
 */

import { el, clear, replaceChildren } from '../core/dom.js';
import { listFolders } from '../drive/drive-client.js';
import { toAppError } from '../core/errors.js';
import { logger } from '../core/logger.js';

const ROOT = { id: 'root', name: 'マイドライブ' };

export function openFolderBrowser() {
  return new Promise((resolve) => {
    const dialog = el('dialog', { class: 'dialog', 'aria-label': 'フォルダを選択' });

    const breadcrumb = el('ol', { class: 'breadcrumb' });
    const body = el('div', { class: 'dialog__body' });
    const message = el('p', { class: 'muted', text: '読み込み中です…' });

    let path = [ROOT];
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

    const selectButton = el('button', {
      type: 'button',
      class: 'button',
      text: 'このフォルダを選択',
      onClick: () => finish({ ...path[path.length - 1] }),
    });

    const cancelButton = el('button', {
      type: 'button',
      class: 'button button--secondary',
      text: 'キャンセル',
      onClick: () => finish(null),
    });

    const renderBreadcrumb = () => {
      replaceChildren(breadcrumb, path.map((entry, index) => el('li', {}, [
        index > 0 ? el('span', { class: 'muted', text: '／' }) : null,
        index === path.length - 1
          ? el('span', { text: entry.name })
          : el('button', {
            type: 'button',
            text: entry.name,
            onClick: () => {
              path = path.slice(0, index + 1);
              load();
            },
          }),
      ])));

      selectButton.textContent = `「${path[path.length - 1].name}」を選択`;
    };

    const load = async () => {
      const current = path[path.length - 1];

      renderBreadcrumb();
      replaceChildren(body, [breadcrumb, message]);
      message.textContent = '読み込み中です…';

      try {
        const { folders } = await listFolders({ parentId: current.id, pageSize: 200 });

        if (folders.length === 0) {
          message.textContent = 'このフォルダの中にサブフォルダはありません。';
          replaceChildren(body, [breadcrumb, message]);
          return;
        }

        const list = el('ul', { class: 'folder-list' }, folders.map((folder) => el('li', {}, [
          el('div', { class: 'folder-list__row' }, [
            el('button', {
              type: 'button',
              class: 'folder-list__open',
              text: folder.name,
              onClick: () => {
                path = [...path, { id: folder.id, name: folder.name }];
                load();
              },
            }),
            el('button', {
              type: 'button',
              class: 'button button--secondary button--small',
              text: '選択',
              onClick: () => finish({ id: folder.id, name: folder.name }),
            }),
          ]),
        ])));

        replaceChildren(body, [breadcrumb, list]);
      } catch (error) {
        const appError = toAppError(error);
        logger.error('folder-browser:list-failed', appError, { code: appError.code });
        message.textContent = appError.userMessage;
        replaceChildren(body, [breadcrumb, message]);
      }
    };

    clear(dialog);
    dialog.append(
      el('div', { class: 'dialog__head' }, [
        el('h2', { class: 'card__title', text: 'ナレッジ対象のフォルダを選択' }),
        el('p', {
          class: 'card__desc',
          text: 'フォルダ名を押すと中へ移動します。対象にするフォルダで「選択」を押してください。',
        }),
      ]),
      body,
      el('div', { class: 'dialog__foot' }, [cancelButton, selectButton]),
    );

    /* Esc で閉じた場合もキャンセル扱いにする。 */
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(null);
    });

    document.body.append(dialog);
    dialog.showModal();
    load();
  });
}

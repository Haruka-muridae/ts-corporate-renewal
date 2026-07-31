/*
 * エラーログ画面（開発者向け）。
 *
 * 利用者向けの日本語メッセージとは別に、技術的詳細をここへ出す。
 * アクセストークン等は logger 側で伏せてあるため、この画面にも出ない。
 */

import { el, replaceChildren, formatDateTime } from '../../core/dom.js';
import { listLogs, clearLogs } from '../../db/repo.js';
import { logger } from '../../core/logger.js';

const LEVELS = [
  { value: 'all', label: 'すべて' },
  { value: 'warn', label: '警告以上' },
  { value: 'error', label: 'エラーのみ' },
];

const ORDER = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogsView() {
  let level = 'all';
  let rows = [];

  const list = el('ul', { class: 'log-list' });
  const status = el('p', { class: 'muted', text: '' });

  const levelSelect = el('select', {
    'aria-label': 'ログの種類',
    onChange: (event) => {
      level = event.target.value;
      renderRows();
    },
  }, LEVELS.map((option) => el('option', { value: option.value, text: option.label })));

  const element = el('section', {}, [
    el('div', { class: 'card' }, [
      el('h2', { class: 'card__title', text: 'エラーログ' }),
      el('p', {
        class: 'card__desc',
        text: '同期や解析の技術的な記録です。不具合の連絡時は、該当行の時刻とイベント名をお知らせください。',
      }),
      el('div', { class: 'field-row' }, [
        el('label', { class: 'field' }, [
          el('span', { class: 'field__label', text: '絞り込み' }),
          levelSelect,
        ]),
      ]),
      el('div', { class: 'card__actions' }, [
        el('button', {
          type: 'button',
          class: 'button button--secondary',
          text: '再読み込み',
          onClick: () => refresh(),
        }),
        el('button', {
          type: 'button',
          class: 'button button--danger',
          text: 'ログを削除',
          onClick: async () => {
            if (!window.confirm('保存済みのログをすべて削除します。よろしいですか？')) {
              return;
            }
            await clearLogs();
            logger.clearBuffer();
            await refresh();
          },
        }),
      ]),
      status,
    ]),
    el('div', { class: 'card' }, [list]),
  ]);

  function renderRows() {
    const filtered = level === 'all'
      ? rows
      : rows.filter((row) => (ORDER[row.level] ?? 0) >= (level === 'error' ? ORDER.error : ORDER.warn));

    status.textContent = `${filtered.length}件を表示しています。`;

    if (filtered.length === 0) {
      replaceChildren(list, [el('li', { class: 'empty', text: 'ログはありません。' })]);
      return;
    }

    replaceChildren(list, filtered.map((row) => el('li', {
      class: `log-item log-item--${row.level}`,
    }, [
      el('span', { class: 'log-item__time', text: formatDateTime(row.at) }),
      el('span', { class: 'log-item__level', text: row.level }),
      el('span', { class: 'log-item__event', text: `${row.event}${row.code ? ` [${row.code}]` : ''}` }),
      row.detail ? el('span', { class: 'log-item__detail', text: row.detail }) : null,
    ])));
  }

  async function refresh() {
    try {
      rows = await listLogs(300);
    } catch {
      /* DBが開けない場合はメモリ上のバッファを表示する。 */
      rows = logger.snapshot().map((entry) => ({
        ...entry,
        detail: entry.detail === null ? null : JSON.stringify(entry.detail),
      }));
    }

    renderRows();
  }

  return {
    element,
    update: () => {},
    onEnter: refresh,
  };
}

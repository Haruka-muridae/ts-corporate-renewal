/*
 * ファイル管理・同期状況画面。
 *
 * 表示項目（要件）:
 *   ファイル名 / ファイル形式 / ファイルサイズ / 更新日時 /
 *   同期状態 / ナレッジ対象かどうか / エラー状態
 *
 * ファイル名・エラー文言はすべて textContent で挿入する。
 */

import {
  el, replaceChildren, formatBytes, formatDateTime, formatNumber, safeDriveUrl,
} from '../../core/dom.js';
import { AppState, FileSyncState, FILE_STATE_LABEL_JA } from '../../core/state.js';

const FILTERS = [
  { value: 'all', label: 'すべて' },
  { value: 'target', label: 'ナレッジ対象のみ' },
  { value: 'error', label: 'エラーのみ' },
  { value: 'skipped', label: '対象外のみ' },
];

const BADGE_CLASS = {
  [FileSyncState.INDEXED]: 'badge--indexed',
  [FileSyncState.PENDING]: 'badge--pending',
  [FileSyncState.FETCHING]: 'badge--busy',
  [FileSyncState.PARSING]: 'badge--busy',
  [FileSyncState.SKIPPED]: 'badge--skipped',
  [FileSyncState.UNCHANGED]: 'badge--pending',
  [FileSyncState.ERROR]: 'badge--error',
};

export function createFilesView(ctx) {
  let filter = 'all';
  let keyword = '';

  const summary = el('div', { class: 'stat-grid' });
  const tableBody = el('tbody');
  const emptyMessage = el('p', { class: 'empty', text: 'ファイルがありません。同期を実行してください。' });
  const tableWrap = el('div', { class: 'table-wrap' });

  const keywordInput = el('input', {
    type: 'search',
    placeholder: 'ファイル名で絞り込み',
    'aria-label': 'ファイル名で絞り込み',
    onInput: (event) => {
      keyword = event.target.value;
      renderRows(ctx.store.get());
    },
  });

  const filterSelect = el('select', {
    'aria-label': '表示の絞り込み',
    onChange: (event) => {
      filter = event.target.value;
      renderRows(ctx.store.get());
    },
  }, FILTERS.map((option) => el('option', { value: option.value, text: option.label })));

  const actionsBar = el('div', { class: 'card__actions' });

  const element = el('section', {}, [
    el('div', { class: 'card' }, [
      el('h2', { class: 'card__title', text: '同期状況' }),
      summary,
      actionsBar,
    ]),

    el('div', { class: 'card' }, [
      el('h2', { class: 'card__title', text: 'ファイル管理' }),
      el('div', { class: 'field-row' }, [
        el('label', { class: 'field' }, [
          el('span', { class: 'field__label', text: 'ファイル名で絞り込み' }),
          keywordInput,
        ]),
        el('label', { class: 'field' }, [
          el('span', { class: 'field__label', text: '表示' }),
          filterSelect,
        ]),
      ]),
      tableWrap,
    ]),
  ]);

  tableWrap.append(
    el('table', { class: 'data' }, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { scope: 'col', text: 'ファイル名' }),
          el('th', { scope: 'col', text: '形式' }),
          el('th', { scope: 'col', text: 'サイズ' }),
          el('th', { scope: 'col', text: '更新日時' }),
          el('th', { scope: 'col', text: '同期状態' }),
          el('th', { scope: 'col', text: 'ナレッジ対象' }),
          el('th', { scope: 'col', text: 'エラー' }),
          el('th', { scope: 'col', text: '操作' }),
        ]),
      ]),
      tableBody,
    ]),
    emptyMessage,
  );

  function renderSummary(state) {
    const files = state.files ?? [];
    const counts = files.reduce((acc, file) => {
      acc.total += 1;
      if (file.isKnowledge) acc.target += 1;
      if (file.syncState === FileSyncState.INDEXED) acc.indexed += 1;
      if (file.syncState === FileSyncState.ERROR) acc.error += 1;
      if (file.syncState === FileSyncState.SKIPPED) acc.skipped += 1;
      return acc;
    }, { total: 0, target: 0, indexed: 0, error: 0, skipped: 0 });

    replaceChildren(summary, [
      stat('対象フォルダ', state.folder?.name ?? '未選択'),
      stat('ファイル総数', formatNumber(counts.total)),
      stat('ナレッジ対象', formatNumber(counts.target)),
      stat('索引済み', formatNumber(counts.indexed)),
      stat('対象外', formatNumber(counts.skipped)),
      stat('エラー', formatNumber(counts.error)),
      stat('最終同期', formatDateTime(state.stats?.lastSyncAt)),
    ]);
  }

  function renderActions(state) {
    const busy = state.appState === AppState.SYNCING || state.appState === AppState.PARSING;
    const canSync = Boolean(state.folder);

    replaceChildren(actionsBar, [
      el('button', {
        type: 'button',
        class: 'button',
        text: busy ? '同期中…' : '差分同期',
        disabled: !canSync || busy,
        onClick: () => ctx.actions.startSync({ force: false }),
      }),
      el('button', {
        type: 'button',
        class: 'button button--secondary',
        text: 'すべて再同期',
        disabled: !canSync || busy,
        onClick: () => {
          if (window.confirm('登録済みのすべてのファイルを取得し直します。よろしいですか？')) {
            ctx.actions.startSync({ force: true });
          }
        },
      }),
      busy
        ? el('button', {
          type: 'button',
          class: 'button button--danger',
          text: '中止',
          onClick: () => ctx.actions.cancelSync(),
        })
        : null,
    ]);
  }

  function matches(file) {
    if (filter === 'target' && !file.isKnowledge) return false;
    if (filter === 'error' && file.syncState !== FileSyncState.ERROR) return false;
    if (filter === 'skipped' && file.syncState !== FileSyncState.SKIPPED) return false;

    const needle = keyword.trim().toLowerCase();
    return needle === '' || String(file.name ?? '').toLowerCase().includes(needle);
  }

  function renderRows(state) {
    const files = (state.files ?? []).filter(matches);

    emptyMessage.hidden = files.length > 0;

    replaceChildren(tableBody, files.map((file) => {
      const busy = state.appState === AppState.SYNCING || state.appState === AppState.PARSING;
      const url = safeDriveUrl(file.driveUrl);

      return el('tr', {}, [
        el('td', {}, [
          url
            ? el('a', {
              class: 'file-name',
              href: url,
              target: '_blank',
              rel: 'noopener noreferrer',
              text: file.name,
            })
            : el('span', { class: 'file-name', text: file.name }),
          file.folderName ? el('div', { class: 'file-folder', text: file.folderName }) : null,
        ]),
        el('td', { text: file.formatLabel ?? '' }),
        el('td', { class: 'numeric', text: file.size ? formatBytes(file.size) : '—' }),
        el('td', { class: 'numeric', text: formatDateTime(file.modifiedTime) }),
        el('td', {}, [
          el('span', {
            class: `badge ${BADGE_CLASS[file.syncState] ?? 'badge--pending'}`,
            text: FILE_STATE_LABEL_JA[file.syncState] ?? file.syncState,
          }),
          file.lastSyncedAt
            ? el('div', { class: 'file-folder', text: formatDateTime(file.lastSyncedAt) })
            : null,
        ]),
        el('td', {}, [
          file.isKnowledge
            ? el('span', { class: 'badge badge--target', text: '対象' })
            : el('span', { class: 'badge badge--skipped', text: '対象外' }),
          file.chunkCount
            ? el('div', { class: 'file-folder', text: `${formatNumber(file.chunkCount)}チャンク` })
            : null,
        ]),
        el('td', { class: 'error-cell', text: file.errorMessage ?? '' }),
        el('td', {}, [
          el('button', {
            type: 'button',
            class: 'button button--secondary button--small',
            text: '再同期',
            disabled: busy || !file.isKnowledge,
            onClick: () => ctx.actions.resyncFile(file.fileId),
          }),
          ' ',
          el('button', {
            type: 'button',
            class: 'button button--danger button--small',
            text: '削除',
            disabled: busy,
            onClick: () => {
              if (window.confirm(`「${file.name}」のブラウザ内データを削除します。Drive上のファイルは削除されません。`)) {
                ctx.actions.deleteFile(file.fileId);
              }
            },
          }),
        ]),
      ]);
    }));
  }

  const update = (state) => {
    renderSummary(state);
    renderActions(state);
    renderRows(state);
  };

  return { element, update };
}

function stat(label, value) {
  return el('div', { class: 'stat' }, [
    el('span', { class: 'stat__label', text: label }),
    el('span', { class: 'stat__value', text: value }),
  ]);
}

/*
 * ストレージ画面。
 *
 * 表示（要件）: IndexedDB使用量 / 登録ファイル数 / 登録文書数 / チャンク数 /
 *               最終同期日時 / 推定空き容量
 * 操作（要件）: 全キャッシュ削除 / ファイル単位削除 / 再同期 / 検索インデックス再構築
 *   （ファイル単位削除はファイル管理画面の各行に置いてある。）
 */

import {
  el, replaceChildren, formatBytes, formatDateTime, formatNumber,
} from '../../core/dom.js';
import { AppState } from '../../core/state.js';

export function createStorageView(ctx) {
  const grid = el('div', { class: 'stat-grid' });
  const actions = el('div', { class: 'card__actions' });
  const message = el('p', { class: 'muted', text: '', role: 'status', 'aria-live': 'polite' });

  /* 実行中の再入を防ぐ（ボタン連打で二重に走らせない）。 */
  let working = false;

  const withGuard = async (label, run) => {
    if (working) {
      return;
    }

    working = true;
    ctx.store.patch({});   // ボタンの無効化を反映する

    try {
      message.textContent = `${label}しています…`;
      await run();
    } finally {
      working = false;
      ctx.store.patch({});
    }
  };

  const element = el('section', {}, [
    el('div', { class: 'card' }, [
      el('h2', { class: 'card__title', text: 'ストレージ使用量' }),
      el('p', {
        class: 'card__desc',
        text: '使用量と空き容量はブラウザが返す「このサイト全体の概算値」です。'
          + 'IndexedDB以外（キャッシュ等）も含むため、目安としてご覧ください。',
      }),
      grid,
    ]),

    el('div', { class: 'card' }, [
      el('h2', { class: 'card__title', text: 'メンテナンス' }),
      el('p', {
        class: 'card__desc',
        text: 'ここでの削除はブラウザ内のデータだけが対象です。Google Drive上のファイルは変更されません。',
      }),
      actions,
      message,
    ]),
  ]);

  const update = (state) => {
    const stats = state.stats ?? {};
    const busy = state.appState === AppState.SYNCING || state.appState === AppState.PARSING;

    replaceChildren(grid, [
      stat('推定使用量', stats.usage === null || stats.usage === undefined ? '取得不可' : formatBytes(stats.usage),
        'navigator.storage.estimate() による概算'),
      stat('推定空き容量', stats.free === null || stats.free === undefined ? '取得不可' : formatBytes(stats.free),
        stats.quota ? `上限の目安 ${formatBytes(stats.quota)}` : ''),
      stat('登録ファイル数', formatNumber(stats.fileCount ?? 0)),
      stat('登録文書数', formatNumber(stats.documentCount ?? 0), '抽出テキストを保持している件数'),
      stat('チャンク数', formatNumber(stats.chunkCount ?? 0)),
      stat('抽出テキスト総文字数', formatNumber(stats.totalChars ?? 0)),
      stat('検索インデックス', formatNumber(stats.indexDocCount ?? 0), stats.indexBuiltAt ? `作成 ${formatDateTime(stats.indexBuiltAt)}` : '未作成'),
      stat('最終同期日時', formatDateTime(stats.lastSyncAt)),
    ]);

    replaceChildren(actions, [
      el('button', {
        type: 'button',
        class: 'button button--secondary',
        text: '再同期（差分）',
        disabled: busy || working || !state.folder,
        onClick: () => ctx.actions.startSync({ force: false }),
      }),
      el('button', {
        type: 'button',
        class: 'button button--secondary',
        text: '検索インデックス再構築',
        disabled: busy || working,
        onClick: () => withGuard('検索インデックスを再構築', async () => {
          const count = await ctx.actions.rebuildIndex();
          message.textContent = count === null
            ? '再構築に失敗しました。エラーログをご確認ください。'
            : `${formatNumber(count)}件のチャンクで再構築しました。`;
        }),
      }),
      el('button', {
        type: 'button',
        class: 'button button--secondary',
        text: '不要データの整理',
        disabled: busy || working,
        onClick: () => withGuard('不要データを整理', async () => {
          const removed = await ctx.actions.cleanupOrphans();
          message.textContent = removed === null
            ? '整理に失敗しました。エラーログをご確認ください。'
            : `取り残されたチャンク ${formatNumber(removed.chunks)}件・文書 ${formatNumber(removed.documents)}件を削除しました。`;
        }),
      }),
      el('button', {
        type: 'button',
        class: 'button button--danger',
        text: '全キャッシュ削除',
        disabled: busy || working,
        onClick: () => {
          const ok = window.confirm(
            'ブラウザ内に保存した抽出テキスト・チャンク・検索インデックス・ログをすべて削除します。\n'
            + 'Google Drive上のファイルは削除されません。よろしいですか？',
          );

          if (!ok) {
            return;
          }

          withGuard('削除', async () => {
            await ctx.actions.clearAllCache();
            message.textContent = 'ブラウザ内のデータを削除しました。再同期で作り直せます。';
          });
        },
      }),
    ]);
  };

  return { element, update };
}

function stat(label, value, sub = '') {
  return el('div', { class: 'stat' }, [
    el('span', { class: 'stat__label', text: label }),
    el('span', { class: 'stat__value', text: value }),
    sub ? el('span', { class: 'stat__sub', text: sub }) : null,
  ]);
}

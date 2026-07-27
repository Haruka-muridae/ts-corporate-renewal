/*
 * 接続診断パネル（設定画面へ埋め込む）。
 *
 * 各項目について、状態 / 実行日時 / HTTPステータス / 日本語エラー /
 * 開発者向け詳細 を表示する。
 *
 * 開発者向け詳細は既定で折りたたむ（利用者が見るのは日本語メッセージだけでよい）。
 * アクセストークンは connection-check.js 側で一切保持していないため、
 * ここに出る余地がない。
 */

import { el, replaceChildren, formatDateTime } from '../../core/dom.js';
import {
  runDiagnostics, diagnosticsPrecondition, CheckStatus, CHECK_STATUS_LABEL_JA,
} from '../../diagnostics/connection-check.js';
import { KNOWLEDGE_FOLDER_PATH, DRIVE_ROOT_LABEL, SCOPE_MODE, getDriveScope } from '../../config.js';

const BADGE_CLASS = {
  [CheckStatus.PENDING]: 'badge--pending',
  [CheckStatus.RUNNING]: 'badge--busy',
  [CheckStatus.SUCCESS]: 'badge--indexed',
  [CheckStatus.FAILURE]: 'badge--error',
  [CheckStatus.SKIPPED]: 'badge--skipped',
};

export function createDiagnosticsPanel(ctx) {
  let results = null;
  let running = false;
  let summary = null;

  const tableBody = el('tbody');
  const status = el('p', { class: 'muted', text: '「診断を実行」を押すと、Googleへ実際に通信して各項目を確認します。' });

  const runButton = el('button', {
    type: 'button',
    class: 'button',
    text: '診断を実行',
    onClick: () => run(),
  });

  const useFolderButton = el('button', {
    type: 'button',
    class: 'button button--secondary',
    text: '見つかったフォルダを対象にする',
    hidden: true,
    onClick: async () => {
      if (summary?.resolvedFolder) {
        await ctx.actions.useFolder({
          id: summary.resolvedFolder.id,
          name: summary.resolvedFolder.name,
          path: [DRIVE_ROOT_LABEL, ...KNOWLEDGE_FOLDER_PATH].join(' / '),
        });
        status.textContent = '対象フォルダに設定しました。ファイル管理画面で一覧を確認できます。';
      }
    },
  });

  const element = el('div', { class: 'card' }, [
    el('h2', { class: 'card__title', text: '接続診断' }),
    el('p', {
      class: 'card__desc',
      text: 'Google認証とDrive APIの実通信を、項目ごとに切り分けて確認します。'
        + 'アクセストークンや認証ヘッダーは記録・表示しません。',
    }),

    el('div', { class: 'stat-grid' }, [
      el('div', { class: 'stat' }, [
        el('span', { class: 'stat__label', text: '使用中のスコープ' }),
        el('span', { class: 'stat__value', text: SCOPE_MODE === 'file' ? 'drive.file' : 'drive.readonly' }),
        el('span', { class: 'stat__sub', text: getDriveScope() }),
      ]),
      el('div', { class: 'stat' }, [
        el('span', { class: 'stat__label', text: '探索するパス' }),
        el('span', { class: 'stat__value', text: KNOWLEDGE_FOLDER_PATH[KNOWLEDGE_FOLDER_PATH.length - 1] }),
        el('span', { class: 'stat__sub', text: [DRIVE_ROOT_LABEL, ...KNOWLEDGE_FOLDER_PATH].join(' / ') }),
      ]),
    ]),

    el('div', { class: 'card__actions' }, [runButton, useFolderButton]),
    status,

    el('div', { class: 'table-wrap' }, [
      el('table', { class: 'data' }, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { scope: 'col', text: '項目' }),
            el('th', { scope: 'col', text: '状態' }),
            el('th', { scope: 'col', text: '実行日時' }),
            el('th', { scope: 'col', text: 'HTTP' }),
            el('th', { scope: 'col', text: '内容 / エラー' }),
          ]),
        ]),
        tableBody,
      ]),
    ]),
  ]);

  function renderRows() {
    if (!results) {
      replaceChildren(tableBody, [
        el('tr', {}, [
          el('td', { colspan: '5', class: 'empty', text: 'まだ実行していません。' }),
        ]),
      ]);
      return;
    }

    replaceChildren(tableBody, Object.values(results).map((entry) => el('tr', {}, [
      el('td', {}, [
        el('div', { class: 'file-name', text: entry.label }),
        el('div', { class: 'file-folder', text: entry.description }),
      ]),
      el('td', {}, [
        el('span', {
          class: `badge ${BADGE_CLASS[entry.status] ?? 'badge--pending'}`,
          text: CHECK_STATUS_LABEL_JA[entry.status] ?? entry.status,
        }),
      ]),
      el('td', { class: 'numeric', text: entry.at ? formatDateTime(entry.at) : '—' }),
      el('td', { class: 'numeric', text: entry.httpStatus === null ? '—' : String(entry.httpStatus) }),
      el('td', {}, [
        el('div', {
          class: entry.status === CheckStatus.FAILURE ? 'error-cell' : '',
          text: entry.message,
        }),
        entry.detail
          ? el('details', {}, [
            el('summary', { text: '開発者向け詳細' }),
            el('pre', { class: 'log-item__detail', text: entry.detail }),
          ])
          : null,
      ]),
    ])));
  }

  async function run() {
    if (running) {
      return;
    }

    const pre = diagnosticsPrecondition();

    if (!pre.clientIdConfigured) {
      status.textContent = 'OAuthクライアントIDが未設定のため実行できません。apps/auth-config.js を設定してください。';
      return;
    }

    running = true;
    runButton.disabled = true;
    runButton.textContent = '診断中…';
    useFolderButton.hidden = true;
    status.textContent = '診断を実行しています。認証ポップアップが出た場合は許可してください。';

    try {
      const outcome = await runDiagnostics({
        onUpdate: (next) => {
          results = next;
          renderRows();
        },
      });

      results = outcome.results;
      summary = outcome.summary;
      renderRows();

      status.textContent = `完了：成功 ${summary.success} / 失敗 ${summary.failure} / 未実施 ${summary.skipped}`;
      useFolderButton.hidden = !summary.resolvedFolder;
    } catch (error) {
      status.textContent = error?.userMessage ?? '診断の実行中に問題が発生しました。';
    } finally {
      running = false;
      runButton.disabled = false;
      runButton.textContent = '診断を実行';
    }
  }

  renderRows();

  return { element, update: () => {} };
}

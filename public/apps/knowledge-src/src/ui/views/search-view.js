/*
 * ナレッジ検索画面。
 *
 * 表示（要件）: 関連度 / ファイル名 / 見出し / 関連部分 / Google Driveへのリンク
 *
 * 本文の強調は文字列連結ではなく DOM ノード（highlightFragment）で行う。
 * 抽出テキストは外部由来のため、HTMLとして解釈させない。
 */

import {
  el, replaceChildren, highlightFragment, formatDateTime, safeDriveUrl, formatNumber,
} from '../../core/dom.js';
import { search } from '../../search/search-service.js';
import { toAppError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';

export function createSearchView(ctx) {
  let lastQuery = '';
  let running = false;

  const input = el('input', {
    type: 'search',
    placeholder: '例: 就業規則 有給',
    'aria-label': '検索キーワード',
    autocomplete: 'off',
  });

  const limitSelect = el('select', { 'aria-label': '表示件数' }, [
    el('option', { value: '20', text: '20件' }),
    el('option', { value: '50', text: '50件' }),
    el('option', { value: '100', text: '100件' }),
  ]);

  const statusLine = el('p', { class: 'muted', text: '' });
  const results = el('div');

  const submitButton = el('button', { type: 'submit', class: 'button', text: '検索' });

  const form = el('form', {
    class: 'search-form',
    onSubmit: (event) => {
      event.preventDefault();
      run();
    },
  }, [
    el('label', { class: 'field' }, [
      el('span', { class: 'field__label', text: 'キーワード' }),
      input,
    ]),
    el('label', { class: 'field' }, [
      el('span', { class: 'field__label', text: '表示件数' }),
      limitSelect,
    ]),
    submitButton,
  ]);

  const element = el('section', {}, [
    el('div', { class: 'card' }, [
      el('h2', { class: 'card__title', text: 'ナレッジ検索' }),
      el('p', {
        class: 'card__desc',
        text: 'ファイル名・見出し・本文・フォルダ名を対象に、ブラウザ内の索引だけで検索します。',
      }),
      form,
      statusLine,
    ]),
    el('div', { class: 'card' }, [results]),
  ]);

  async function run() {
    const query = input.value.trim();

    if (query === '' || running) {
      return;
    }

    running = true;
    lastQuery = query;
    submitButton.disabled = true;
    statusLine.textContent = '検索中です…';
    replaceChildren(results, []);

    try {
      const limit = Number(limitSelect.value) || 20;
      const startedAt = performance.now();
      const result = await search(query, { limit });
      const elapsed = Math.round(performance.now() - startedAt);

      statusLine.textContent = result.total === 0
        ? '一致するナレッジは見つかりませんでした。'
        : `${formatNumber(result.total)}件中 ${formatNumber(result.hits.length)}件を表示（${elapsed}ms）`;

      if (result.hits.length === 0) {
        replaceChildren(results, [
          el('p', {
            class: 'empty',
            text: '別のキーワードをお試しください。索引が未作成の場合はストレージ画面から再構築できます。',
          }),
        ]);
        return;
      }

      replaceChildren(results, result.hits.map((hit) => renderHit(hit, result.terms)));
    } catch (error) {
      const appError = toAppError(error);
      logger.error('search:failed', appError, { code: appError.code });
      statusLine.textContent = appError.userMessage;
      replaceChildren(results, []);
    } finally {
      running = false;
      submitButton.disabled = false;
    }
  }

  function renderHit(hit, terms) {
    const url = safeDriveUrl(hit.driveUrl);

    return el('article', { class: 'result' }, [
      el('div', { class: 'result__head' }, [
        url
          ? el('a', {
            class: 'result__file',
            href: url,
            target: '_blank',
            rel: 'noopener noreferrer',
            text: hit.fileName || '（名称不明）',
          })
          : el('span', { class: 'result__file', text: hit.fileName || '（名称不明）' }),
        hit.heading ? el('span', { class: 'result__heading', text: `｜${hit.heading}` }) : null,
        el('span', { class: 'result__score', text: `関連度 ${hit.score.toFixed(2)}` }),
      ]),

      el('p', { class: 'result__snippet' }, [highlightFragment(hit.snippet, terms)]),

      el('div', { class: 'result__meta' }, [
        el('span', { text: `更新: ${formatDateTime(hit.updatedTime)}` }),
        el('span', { text: `チャンク #${hit.chunkIndex + 1}` }),
        url
          ? el('a', {
            href: url,
            target: '_blank',
            rel: 'noopener noreferrer',
            text: 'Google Driveで開く',
          })
          : el('span', { class: 'muted', text: 'Driveリンクなし' }),
      ]),
    ]);
  }

  const update = (state) => {
    const hasChunks = (state.stats?.chunkCount ?? 0) > 0;

    if (!hasChunks && lastQuery === '') {
      statusLine.textContent = '検索できるナレッジがまだありません。先に同期を実行してください。';
    }

    submitButton.disabled = running;
  };

  return { element, update, focus: () => input.focus() };
}

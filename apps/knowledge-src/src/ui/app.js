/*
 * 画面シェル。
 *   - ナビゲーション（ハッシュによる画面切り替え）
 *   - アカウント表示
 *   - 状態バッジと進捗
 *
 * 各画面は { element, update(state), onEnter? } を返すファクトリで作る。
 */

import { el, clear, replaceChildren, safeUrl } from '../core/dom.js';
import { AppState, STATE_LABEL_JA } from '../core/state.js';
import { SCOPE_MODE, getDriveScope } from '../config.js';
import { createSetupView } from './views/setup-view.js';
import { createFilesView } from './views/files-view.js';
import { createSearchView } from './views/search-view.js';
import { createStorageView } from './views/storage-view.js';
import { createLogsView } from './views/logs-view.js';
import { createSettingsView } from './views/settings-view.js';

const BADGE_CLASS = {
  [AppState.UNAUTHENTICATED]: 'state-badge--idle',
  [AppState.AUTHENTICATED]: 'state-badge--idle',
  [AppState.NO_FOLDER]: 'state-badge--idle',
  [AppState.SYNC_IDLE]: 'state-badge--idle',
  [AppState.SYNCING]: 'state-badge--busy',
  [AppState.PARSING]: 'state-badge--busy',
  [AppState.DONE]: 'state-badge--done',
  [AppState.CANCELLED]: 'state-badge--idle',
  [AppState.ERROR]: 'state-badge--error',
};

const PHASE_LABEL = {
  listing: 'Driveのファイル一覧を取得しています',
  parsing: 'ファイルを解析しています',
  indexing: '検索インデックスを更新しています',
  rebuilding: '検索インデックスを再構築しています',
};

export function mountApp(ctx) {
  const main = document.getElementById('main');
  const navList = document.getElementById('nav-list');
  const statusBar = document.getElementById('status-bar');
  const accountArea = document.getElementById('account-area');

  const views = [
    { id: 'setup', label: '初期設定', factory: createSetupView },
    { id: 'files', label: 'ファイル管理', factory: createFilesView },
    { id: 'search', label: 'ナレッジ検索', factory: createSearchView },
    { id: 'storage', label: 'ストレージ', factory: createStorageView },
    { id: 'logs', label: 'エラーログ', factory: createLogsView },
    { id: 'settings', label: '設定', factory: createSettingsView },
  ].map((view) => ({ ...view, instance: view.factory(ctx) }));

  const byId = new Map(views.map((view) => [view.id, view]));
  let currentId = null;

  const buttons = new Map();

  replaceChildren(navList, views.map((view) => {
    const button = el('button', {
      type: 'button',
      class: 'app-nav__button',
      text: view.label,
      onClick: () => navigate(view.id),
    });

    buttons.set(view.id, button);
    return el('li', {}, [button]);
  }));

  function navigate(id, { updateHash = true } = {}) {
    const view = byId.get(id) ?? views[0];

    if (currentId === view.id) {
      return;
    }

    currentId = view.id;

    buttons.forEach((button, buttonId) => {
      if (buttonId === view.id) {
        button.setAttribute('aria-current', 'page');
      } else {
        button.removeAttribute('aria-current');
      }
    });

    clear(main);
    main.append(view.instance.element);
    view.instance.update(ctx.store.get());
    view.instance.onEnter?.();

    if (updateHash) {
      const nextHash = `#${view.id}`;
      if (window.location.hash !== nextHash) {
        window.history.replaceState(null, '', nextHash);
      }
    }
  }

  window.addEventListener('hashchange', () => {
    navigate(window.location.hash.replace('#', '') || 'setup', { updateHash: false });
  });

  /* 状態が変わったら、表示中の画面だけ更新する（他は表示時に更新される）。 */
  ctx.store.subscribe((state) => {
    renderStatus(statusBar, state);
    renderAccount(accountArea, state, ctx);

    const view = byId.get(currentId);
    view?.instance.update(state);
  });

  navigate(window.location.hash.replace('#', '') || 'setup', { updateHash: false });

  return {
    navigate,
    focusSearch() {
      navigate('search');
      byId.get('search')?.instance.focus?.();
    },
  };
}

function renderStatus(container, state) {
  const children = [
    el('span', {
      class: `state-badge ${BADGE_CLASS[state.appState] ?? 'state-badge--idle'}`,
      text: STATE_LABEL_JA[state.appState] ?? state.appState,
    }),
    /*
     * 使用中のDriveスコープを常に見えるところへ出す。
     * 読み取り専用であることを、利用者が画面上で確認できるようにするため。
     */
    el('span', {
      class: 'state-badge state-badge--scope',
      title: getDriveScope(),
      text: SCOPE_MODE === 'file' ? 'drive.file（読み取り専用）' : 'drive.readonly（読み取り専用）',
    }),
  ];

  const progress = state.progress;

  if (progress) {
    const label = PHASE_LABEL[progress.phase] ?? '処理中';
    const total = Number(progress.total) || 0;
    const done = Number(progress.done) || 0;
    const ratio = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

    children.push(el('span', {
      class: 'status-text',
      text: total > 0 ? `${label}（${done}/${total}）` : `${label}…`,
    }));

    if (total > 0) {
      children.push(el('div', {
        class: 'progress',
        role: 'progressbar',
        'aria-valuenow': String(ratio),
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-label': label,
      }, [
        el('div', { class: 'progress__bar', style: { width: `${ratio}%` } }),
      ]));
    }

    if (progress.currentName) {
      children.push(el('span', { class: 'status-text', text: progress.currentName }));
    }
  } else if (state.lastError) {
    children.push(el('span', { class: 'status-text', text: state.lastError.message }));
  } else if (state.folder) {
    children.push(el('span', { class: 'status-text', text: `対象フォルダ：${state.folder.name}` }));
  }

  replaceChildren(container, children);
}

function renderAccount(container, state, ctx) {
  const profile = state.profile;

  if (!profile) {
    replaceChildren(container, [
      el('button', {
        type: 'button',
        class: 'button button--small',
        text: 'Googleでログイン',
        onClick: () => ctx.actions.signIn(),
      }),
    ]);
    return;
  }

  const photo = safeUrl(profile.photoLink);
  const initial = (profile.displayName || profile.email || '?').trim().charAt(0).toUpperCase();

  replaceChildren(container, [
    el('span', { class: 'account-avatar' }, [
      photo
        ? el('img', {
          src: photo,
          alt: '',
          referrerpolicy: 'no-referrer',
          onError: (event) => {
            /* 画像が出ない場合はイニシャル表示へ落とす。 */
            const parent = event.target.parentElement;
            if (parent) {
              replaceChildren(parent, [initial]);
            }
          },
        })
        : initial,
    ]),
    el('span', {}, [
      el('div', { class: 'account-name', text: profile.displayName || 'Googleアカウント' }),
      profile.email ? el('div', { class: 'account-mail', text: profile.email }) : null,
    ]),
    el('button', {
      type: 'button',
      class: 'button button--secondary button--small',
      text: 'ログアウト',
      onClick: () => ctx.actions.signOut(),
    }),
  ]);
}

/*
 * 初期設定画面。
 *   1. 設定状況の確認（クライアントID / Pickerキー / スコープ）
 *   2. Googleログイン（＝Drive読み取りの認可）
 *   3. Driveフォルダ選択
 *   4. 最初の同期への導線
 */

import { el, replaceChildren, formatDateTime } from '../../core/dom.js';
import { AppState } from '../../core/state.js';
import {
  isClientIdConfigured, isPickerConfigured, SCOPE_MODE, getDriveScope,
  KNOWLEDGE_FOLDER_PATH, DRIVE_ROOT_LABEL,
} from '../../config.js';
import { PathResolveStatus } from '../../drive/folder-path.js';

export function createSetupView(ctx) {
  const stepsContainer = el('div');
  const element = el('section', {}, [stepsContainer]);

  const update = (state) => {
    const configured = isClientIdConfigured();
    const signedIn = state.appState !== AppState.UNAUTHENTICATED;

    replaceChildren(stepsContainer, [
      renderConfigCard(configured),
      renderAuthCard(state, ctx, configured, signedIn),
      renderFolderCard(state, ctx, signedIn),
      renderFirstSyncCard(state, ctx),
    ]);
  };

  return { element, update };
}

function statusLine(ok, okText, ngText) {
  return el('p', {
    class: ok ? 'notice notice--success' : 'notice notice--warn',
    text: ok ? okText : ngText,
  });
}

function renderConfigCard(configured) {
  const scope = getDriveScope();

  return el('div', { class: 'card' }, [
    el('h2', { class: 'card__title', text: '1. 設定状況' }),
    el('p', {
      class: 'card__desc',
      text: '設定値は src/config.js の1か所にまとめています。認証情報はリポジトリへ保存しません。',
    }),

    statusLine(
      configured,
      'OAuthクライアントIDが設定されています。',
      'OAuthクライアントIDが未設定です。管理者に設定を依頼してください（この状態では外部通信を行いません）。',
    ),

    statusLine(
      isPickerConfigured(),
      'Google Picker APIキーが設定されています。フォルダ選択ダイアログを利用できます。',
      'Picker用APIキーが未設定です。Drive APIによるフォルダ一覧で選択します（機能上の問題はありません）。',
    ),

    el('div', { class: 'stat-grid' }, [
      el('div', { class: 'stat' }, [
        el('span', { class: 'stat__label', text: '要求スコープ' }),
        el('span', { class: 'stat__value', text: SCOPE_MODE === 'file' ? 'drive.file' : 'drive.readonly' }),
        el('span', { class: 'stat__sub', text: scope }),
      ]),
      el('div', { class: 'stat' }, [
        el('span', { class: 'stat__label', text: 'Driveへの書き込み' }),
        el('span', { class: 'stat__value', text: '行わない' }),
        el('span', { class: 'stat__sub', text: '読み取り専用のAPIのみ呼び出します' }),
      ]),
      el('div', { class: 'stat' }, [
        el('span', { class: 'stat__label', text: 'トークンの保存先' }),
        el('span', { class: 'stat__value', text: 'メモリのみ' }),
        el('span', { class: 'stat__sub', text: 'localStorage等へは保存しません' }),
      ]),
    ]),
  ]);
}

function renderAuthCard(state, ctx, configured, signedIn) {
  const profile = state.profile;

  return el('div', { class: 'card' }, [
    el('h2', { class: 'card__title', text: '2. Googleログイン' }),
    el('p', {
      class: 'card__desc',
      text: 'Google Driveの読み取り権限のみを要求します。ページを再読み込みすると再認可が必要です。',
    }),

    signedIn && profile
      ? el('p', { class: 'notice notice--success' }, [
        `${profile.displayName || 'アカウント'} としてDriveへ接続しています。`,
        profile.email ? el('span', { class: 'account-mail', text: ` （${profile.email}）` }) : null,
      ])
      : el('p', { class: 'notice notice--info', text: 'まだDriveへ接続していません。' }),

    el('div', { class: 'card__actions' }, [
      el('button', {
        type: 'button',
        class: 'button',
        text: signedIn ? '再認証する' : 'Googleでログイン',
        disabled: !configured,
        onClick: () => ctx.actions.signIn(),
      }),
      signedIn
        ? el('button', {
          type: 'button',
          class: 'button button--secondary',
          text: 'ログアウト',
          onClick: () => ctx.actions.signOut(),
        })
        : null,
    ]),
  ]);
}

function renderFolderCard(state, ctx, signedIn) {
  const folder = state.folder;
  const resolve = state.folderResolve;
  const expectedPath = [DRIVE_ROOT_LABEL, ...KNOWLEDGE_FOLDER_PATH].join(' / ');

  return el('div', { class: 'card' }, [
    el('h2', { class: 'card__title', text: '3. Driveフォルダ（固定パスの自動探索）' }),
    el('p', {
      class: 'card__desc',
      text: 'ログイン後、マイドライブから1階層ずつ親フォルダIDを指定して探索します。'
        + 'フォルダ名だけの全体検索は行いません。自動でフォルダを作成することもありません。',
    }),

    el('p', { class: 'muted', text: `探索するパス：${expectedPath}` }),

    renderResolveState(state, ctx, resolve, folder),

    el('div', { class: 'card__actions' }, [
      el('button', {
        type: 'button',
        class: 'button button--secondary',
        text: '固定パスを再探索',
        disabled: !signedIn || state.folderResolving === true,
        onClick: () => ctx.actions.resolveFixedFolder({ apply: true }),
      }),
      el('button', {
        type: 'button',
        class: 'button button--secondary',
        text: folder ? 'フォルダを手動で選び直す' : 'フォルダを手動で選択',
        disabled: !signedIn,
        onClick: () => ctx.actions.chooseFolder(),
      }),
    ]),
  ]);
}

/* 探索結果（成功／未検出／複数候補／スコープ非対応／エラー）の表示。 */
function renderResolveState(state, ctx, resolve, folder) {
  const children = [];

  if (state.folderResolving) {
    children.push(el('p', { class: 'notice notice--info', text: '固定パスを探索しています…' }));
  }

  if (folder) {
    children.push(el('p', { class: 'notice notice--success' }, [
      '対象フォルダ：',
      el('strong', { text: folder.path ? folder.path : (folder.name || '（名称不明）') }),
    ]));
  }

  if (!resolve) {
    if (!folder && !state.folderResolving) {
      children.push(el('p', { class: 'notice notice--info', text: 'フォルダが未選択です。ログインすると自動で探索します。' }));
    }
    return el('div', {}, children);
  }

  if (resolve.status === PathResolveStatus.RESOLVED) {
    /* 成功時は上の「対象フォルダ」表示で足りるため、階層の内訳だけ出す。 */
    children.push(el('p', { class: 'muted', text: `確認済みの階層：${resolve.trail.map((t) => t.name).join(' / ')}` }));
    return el('div', {}, children);
  }

  const level = resolve.status === PathResolveStatus.ERROR ? 'error' : 'warn';

  children.push(el('p', { class: `notice notice--${level}` }, [
    resolve.message ?? '固定パスを確認できませんでした。',
  ]));

  if (resolve.missingAt) {
    children.push(el('p', { class: 'muted', text: `見つからなかった階層：${resolve.missingAt}` }));
  }

  if (resolve.trail?.length > 0) {
    children.push(el('p', { class: 'muted', text: `ここまでは確認できました：${[DRIVE_ROOT_LABEL, ...resolve.trail.map((t) => t.name)].join(' / ')}` }));
  }

  /* 同名フォルダが複数あった場合などの候補。自動選択はしない。 */
  if (resolve.candidates?.length > 0) {
    children.push(el('p', { class: 'field__label', text: '候補（使用するフォルダを選んでください）' }));

    children.push(el('ul', { class: 'folder-list' }, resolve.candidates.map((candidate) => el('li', {}, [
      el('div', { class: 'folder-list__row' }, [
        el('span', { class: 'folder-list__open', text: `${candidate.parentName} / ${candidate.name}` }),
        el('button', {
          type: 'button',
          class: 'button button--secondary button--small',
          text: 'このフォルダを使う',
          onClick: () => ctx.actions.useFolder({ id: candidate.id, name: candidate.name }),
        }),
      ]),
    ]))));
  }

  return el('div', {}, children);
}

function renderFirstSyncCard(state, ctx) {
  const canSync = Boolean(state.folder) && state.appState !== AppState.UNAUTHENTICATED;
  const busy = state.appState === AppState.SYNCING || state.appState === AppState.PARSING;

  return el('div', { class: 'card' }, [
    el('h2', { class: 'card__title', text: '4. 同期の実行' }),
    el('p', {
      class: 'card__desc',
      text: 'Driveからファイルを取得し、ブラウザ内でテキスト抽出・分割・索引作成を行います。'
        + '2回目以降は更新されたファイルだけを処理します。',
    }),

    el('p', { class: 'muted', text: `最終同期：${formatDateTime(state.stats?.lastSyncAt)}` }),

    el('div', { class: 'card__actions' }, [
      el('button', {
        type: 'button',
        class: 'button',
        text: busy ? '同期中…' : '同期を開始',
        disabled: !canSync || busy,
        onClick: () => ctx.actions.startSync({ force: false }),
      }),
      busy
        ? el('button', {
          type: 'button',
          class: 'button button--secondary',
          text: '中止',
          onClick: () => ctx.actions.cancelSync(),
        })
        : null,
    ]),
  ]);
}

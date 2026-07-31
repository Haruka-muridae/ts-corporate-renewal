/*
 * 初期設定画面。
 *   1. 設定状況の確認（クライアントID / Pickerキー / スコープ）
 *   2. Googleログイン（＝Drive読み取りの認可）
 *   3. Driveフォルダ選択
 *   4. 最初の同期への導線
 */

import { el, replaceChildren, formatDateTime, safeDriveUrl } from '../../core/dom.js';
import { AppState } from '../../core/state.js';
import {
  isClientIdConfigured, isPickerConfigured, SCOPE_MODE, getDriveScope,
  KNOWLEDGE_FOLDER_PATH, DRIVE_ROOT_LABEL, FOLDER_STRUCTURE,
  FOLDER_CREATE_SCOPE_MODE, FOLDER_CREATE_SCOPE_LABEL, getFolderCreateScope,
} from '../../config.js';
import { PathResolveStatus } from '../../drive/folder-path.js';
import { NodeStatus, LABEL_BY_STATUS } from '../../drive/folder-plan.js';

export function createSetupView(ctx) {
  const stepsContainer = el('div');
  const element = el('section', {}, [stepsContainer]);

  /*
   * 連打・多重実行の防止。
   *
   * 画面は状態が変わるたびに作り直されるため、ボタン要素そのものに
   * フラグを持たせられない。ビューの寿命と同じこの変数で守る。
   * （作成処理そのものにも別の防止機構がある。二重にしてある。）
   */
  const running = { scan: false, create: false };

  const guard = (key, run) => async () => {
    if (running[key]) {
      return;
    }
    running[key] = true;

    try {
      await run();
    } finally {
      running[key] = false;
    }
  };

  const handlers = {
    scan: guard('scan', () => ctx.actions.checkFolderStructure()),
    create: guard('create', () => ctx.actions.createMissingFolders()),
    isRunning: () => running.scan || running.create,
  };

  const update = (state) => {
    const configured = isClientIdConfigured();
    const signedIn = state.appState !== AppState.UNAUTHENTICATED;

    replaceChildren(stepsContainer, [
      renderConfigCard(configured),
      renderAuthCard(state, ctx, configured, signedIn),
      renderFolderCard(state, ctx, signedIn),
      renderStructureCard(state, ctx, signedIn, handlers),
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

/* ================================================================
 * 不足フォルダの確認と作成
 * ================================================================
 *
 * 「不足フォルダを作成」ボタンは、**構成の一部が実際に無いときだけ** 出す。
 * 押すまではDriveへの書き込み権限を要求しない。
 */
function renderStructureCard(state, ctx, signedIn, handlers) {
  const structure = state.structure;          // scanFolderStructure() の結果
  const creating = state.folderCreating === true;
  const result = state.folderCreateResult;    // createMissingFolders() の結果

  const children = [
    el('h2', { class: 'card__title', text: '3.5 フォルダ構成の確認と作成' }),
    el('p', {
      class: 'card__desc',
      text: '目標の構成が揃っているかを読み取り専用で確認します。'
        + '欠けているフォルダがある場合だけ作成ボタンが出ます。既存のフォルダは作り直しません。',
    }),

    /* 作成予定の階層（常に出す。何を目指しているかが分かるように） */
    el('p', { class: 'muted', text: `目標の構成：${DRIVE_ROOT_LABEL} / ${FOLDER_STRUCTURE.base.join(' / ')} / { ${FOLDER_STRUCTURE.children.join(' , ')} }` }),
    el('p', { class: 'muted', text: `必要な権限（作成時のみ）：${FOLDER_CREATE_SCOPE_LABEL[FOLDER_CREATE_SCOPE_MODE] ?? getFolderCreateScope()}` }),
  ];

  if (!signedIn) {
    children.push(el('p', { class: 'notice notice--info', text: 'ログインすると構成を確認できます。' }));
    return el('div', { class: 'card' }, children);
  }

  if (state.structureScanning) {
    children.push(el('p', { class: 'notice notice--info', role: 'status', text: 'フォルダ構成を確認しています…' }));
  }

  if (structure) {
    children.push(renderStructureTree(structure));

    if (structure.ambiguous.length > 0) {
      children.push(el('p', { class: 'notice notice--warn' }, [
        `同じ名前のフォルダが複数あります（${structure.ambiguous.length} 件）。`
        + '自動では選べないため、作成に進めません。Drive上で重複を解消するか、使うフォルダを選んでください。',
      ]));

      structure.ambiguous.forEach((entry) => {
        children.push(el('p', { class: 'field__label', text: `候補：${entry.path}` }));
        children.push(el('ul', { class: 'folder-list' }, entry.candidates.map((candidate) => el('li', {}, [
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
      });
    } else if (structure.missing.length > 0) {
      children.push(el('p', { class: 'notice notice--warn' }, [
        `不足しているフォルダが ${structure.missing.length} 件あります：`
        + structure.missing.map((entry) => entry.node.name).join('、'),
      ]));
    } else {
      children.push(el('p', { class: 'notice notice--success', text: '目標の構成はすべて揃っています。作成は不要です。' }));
    }
  } else if (!state.structureScanning) {
    children.push(el('p', { class: 'notice notice--info', text: '「不足フォルダを確認」を押すと、構成を確認します。' }));
  }

  /* 作成中の進捗 */
  if (creating) {
    const progress = state.folderCreateProgress;
    const total = progress?.total ?? 0;
    const done = progress?.done ?? 0;

    children.push(el('div', { class: 'progress-block', role: 'status', 'aria-live': 'polite' }, [
      el('p', {
        text: progress?.phase === 'authorizing'
          ? 'Googleの確認画面で作成の許可を求めています…'
          : `フォルダを作成しています（${done} / ${total}）${progress?.currentName ? `：${progress.currentName}` : ''}`,
      }),
      el('progress', {
        class: 'progress',
        role: 'progressbar',
        'aria-label': 'フォルダ作成の進捗',
        'aria-valuenow': String(done),
        'aria-valuemin': '0',
        'aria-valuemax': String(Math.max(total, 1)),
        value: String(done),
        max: String(Math.max(total, 1)),
      }),
    ]));
  }

  /* 作成結果 */
  if (result) {
    children.push(renderCreateResult(result));
  }

  const canCreate = Boolean(structure?.canCreate) && !creating;

  children.push(el('div', { class: 'card__actions' }, [
    el('button', {
      type: 'button',
      class: 'button button--secondary',
      text: '不足フォルダを確認',
      disabled: creating || state.structureScanning === true,
      onClick: handlers.scan,
    }),

    /* 不足があるときだけ作成ボタンを出す（要件2）。 */
    structure?.needsCreation
      ? el('button', {
        type: 'button',
        class: 'button',
        'data-role': 'create-folders',
        text: creating ? '作成中…' : (result ? '作成を再実行' : `不足フォルダを作成（${structure.missing.length} 件）`),
        disabled: !canCreate,
        onClick: handlers.create,
      })
      : null,
  ]));

  if (structure?.needsCreation && !structure.canCreate) {
    children.push(el('p', { class: 'muted', text: '同名フォルダの重複が解消されるまで、作成は実行できません。' }));
  }

  return el('div', { class: 'card' }, children);
}

/* 現在の構成を、階層と状態が文字で分かる形で並べる。 */
function renderStructureTree(structure) {
  return el('ul', { class: 'tree-list' }, structure.entries.map((entry) => el('li', {
    class: `tree-list__item tree-list__item--depth${entry.node.depth}`,
  }, [
    el('span', { class: 'tree-list__name', text: entry.node.name }),
    el('span', {
      class: entry.status === NodeStatus.MISSING ? 'tag tag--new' : 'tag',
      text: LABEL_BY_STATUS[entry.status] ?? '',
    }),
  ])));
}

/* 作成結果（成功・失敗・作成済みリンク）。 */
function renderCreateResult(result) {
  const children = [];

  if (result.ok) {
    children.push(el('p', { class: 'notice notice--success', role: 'status', 'aria-live': 'polite' }, [
      `フォルダの作成が完了しました（新規 ${result.created.length} 件 / 既存を再利用 ${result.reused.length} 件）。`,
    ]));
  } else if (result.error) {
    children.push(el('p', { class: 'notice notice--error', role: 'status', 'aria-live': 'polite' }, [
      result.error.message ?? 'フォルダの作成に失敗しました。',
    ]));
  }

  if (result.created.length > 0) {
    children.push(el('h3', { class: 'field__label', text: '作成したフォルダ' }));
    children.push(el('ul', { class: 'plain-list' }, result.created.map((item) => {
      const href = safeDriveUrl(item.webViewLink);

      return el('li', {}, [
        el('span', { text: `${item.path}　` }),
        href
          ? el('a', { href, target: '_blank', rel: 'noopener noreferrer', text: 'Driveで開く' })
          : el('span', { class: 'muted', text: '（リンクなし）' }),
      ]);
    })));
  }

  if (result.failed.length > 0) {
    children.push(el('h3', { class: 'field__label', text: '作成できなかったフォルダ' }));
    children.push(el('ul', { class: 'plain-list' }, result.failed.map((item) => el('li', {
      text: `${item.path}：${item.message}`,
    }))));
  }

  if (result.skipped.length > 0) {
    children.push(el('h3', { class: 'field__label', text: '未実行のフォルダ' }));
    children.push(el('ul', { class: 'plain-list' }, result.skipped.map((item) => el('li', {
      text: `${item.path}：${item.message}`,
    }))));
    children.push(el('p', { class: 'muted', text: '「作成を再実行」で、続きから作り直せます。成功した分は作り直しません。' }));
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

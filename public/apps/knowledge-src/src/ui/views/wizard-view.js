/*
 * セットアップウィザード。
 *
 * 初回アクセス時に、ログインから診断までを1画面で順番に案内する。
 * 完了すると通常画面（タブ）へ切り替わり、以降は表示されない。
 *
 * ------------------------------------------------------------------
 * セキュリティ方針は通常画面と同じ
 * ------------------------------------------------------------------
 *   - 既定は読み取り専用（drive.readonly）。
 *   - 書き込み権限を要求するのは
 *       「不足フォルダを作成」と「サンプルファイルを作成」
 *     の2ステップで、利用者がボタンを押したときだけ。
 *   - どちらも終わったら書き込み用トークンを即破棄する。
 * ------------------------------------------------------------------
 */

import { el, replaceChildren, safeDriveUrl, formatNumber } from '../../core/dom.js';
import { AppState } from '../../core/state.js';
import {
  WizardStep, StepStatus, STEP_STATUS_LABEL_JA,
  buildWizardSteps, computeStepStates, progressRatio, canFinish,
} from '../../setup/wizard-state.js';
import { NodeStatus, LABEL_BY_STATUS } from '../../drive/folder-plan.js';
import { SampleStatus } from '../../drive/sample-files.js';
import {
  DRIVE_ROOT_LABEL, FOLDER_STRUCTURE, SAMPLE_SEARCH_TERM, SAMPLE_FILES,
  getDriveScope, FOLDER_CREATE_SCOPE_LABEL, FOLDER_CREATE_SCOPE_MODE, getFolderCreateScope,
} from '../../config.js';

export function createWizardView(ctx) {
  const body = el('div');
  const element = el('section', { class: 'wizard' }, [body]);

  /* 連打・多重実行の防止（各ステップのボタンごと）。 */
  const running = new Set();

  const guard = (key, run) => async () => {
    if (running.has(key)) {
      return;
    }
    running.add(key);

    try {
      await run();
    } finally {
      running.delete(key);
    }
  };

  const handlers = {
    signIn: guard('signIn', () => ctx.actions.signIn()),
    folder: guard('folder', () => ctx.actions.checkFolderStructure()),
    create: guard('create', () => ctx.actions.createMissingFolders()),
    samples: guard('samples', () => ctx.actions.createSampleFiles()),
    sync: guard('sync', () => ctx.actions.startSync({ force: false })),
    search: guard('search', () => ctx.actions.runSetupSearchTest()),
    diagnose: guard('diagnose', () => ctx.actions.runSetupDiagnosis()),
    finish: guard('finish', () => ctx.actions.finishSetup()),
    skip: (stepId) => guard(`skip:${stepId}`, () => ctx.actions.skipSetupStep(stepId)),
  };

  const update = (state) => {
    const progress = state.setup?.progress ?? {};
    const steps = computeStepStates(progress, buildWizardSteps(progress));
    const ratio = progressRatio(progress);

    replaceChildren(body, [
      renderHeader(ratio),
      renderStepList(steps),
      ...steps.map((step) => renderStepCard(step, state, ctx, handlers)),
    ]);
  };

  return { element, update };
}

function renderHeader({ done, total }) {
  return el('div', { class: 'card wizard__head' }, [
    el('h2', { class: 'card__title', text: 'セットアップ' }),
    el('p', {
      class: 'card__desc',
      text: 'Google Drive と接続し、検索できる状態になるまでを順番に案内します。'
        + '各手順で何が起きるかを表示し、Driveへ書き込む操作は必ず確認画面を挟みます。',
    }),
    el('p', { class: 'muted', text: `進み具合：${done} / ${total} 手順` }),
    el('progress', {
      class: 'progress',
      role: 'progressbar',
      'aria-label': 'セットアップの進み具合',
      'aria-valuenow': String(done),
      'aria-valuemin': '0',
      'aria-valuemax': String(Math.max(total, 1)),
      value: String(done),
      max: String(Math.max(total, 1)),
    }),
  ]);
}

/* 全体の見取り図。番号と状態を文字で出す（色だけに頼らない）。 */
function renderStepList(steps) {
  return el('ol', { class: 'wizard__list', 'aria-label': '手順の一覧' }, steps.map((step, index) => el('li', {
    class: `wizard__list-item wizard__list-item--${step.status}`,
    'aria-current': step.status === StepStatus.CURRENT ? 'step' : null,
  }, [
    el('span', { class: 'wizard__num', text: `${index + 1}.` }),
    el('span', { class: 'wizard__label', text: step.label }),
    el('span', { class: 'tag', text: STEP_STATUS_LABEL_JA[step.status] ?? '' }),
  ])));
}

function renderStepCard(step, state, ctx, handlers) {
  const active = step.status === StepStatus.CURRENT;
  const finished = step.status === StepStatus.DONE || step.status === StepStatus.SKIPPED;

  const children = [
    el('h3', { class: 'card__title', text: `${step.label}（${STEP_STATUS_LABEL_JA[step.status]}）` }),
    el('p', { class: 'card__desc', text: step.summary }),
  ];

  if (active) {
    children.push(el('p', { class: 'muted', text: step.detail }));
    children.push(...renderStepBody(step, state, ctx, handlers));
  } else if (finished) {
    children.push(...renderStepSummary(step, state));
  } else {
    children.push(el('p', { class: 'muted', text: '前の手順が終わると実行できます。' }));
  }

  return el('div', {
    class: `card wizard__step wizard__step--${step.status}`,
    'aria-live': active ? 'polite' : null,
  }, children);
}

/* ---------- 各ステップの本体 ---------- */

function renderStepBody(step, state, ctx, handlers) {
  switch (step.id) {
    case WizardStep.SIGN_IN: return signInBody(state, handlers);
    case WizardStep.FOLDER: return folderBody(state, handlers);
    case WizardStep.CREATE: return createBody(state, handlers);
    case WizardStep.SAMPLES: return samplesBody(state, handlers);
    case WizardStep.SYNC: return syncBody(state, handlers);
    case WizardStep.SEARCH: return searchBody(state, handlers);
    case WizardStep.DIAGNOSE: return diagnoseBody(state, handlers);
    case WizardStep.DONE: return doneBody(state, handlers);
    default: return [];
  }
}

function signInBody(state, handlers) {
  const signedIn = state.appState !== AppState.UNAUTHENTICATED;

  return [
    el('ul', { class: 'plain-list' }, [
      el('li', { text: `要求するスコープ：${getDriveScope()}` }),
      el('li', { text: 'アクセストークンはメモリにのみ保持し、保存しません。' }),
      el('li', { text: 'この時点ではDriveへ何も書き込みません。' }),
    ]),
    el('div', { class: 'card__actions' }, [
      el('button', {
        type: 'button',
        class: 'button',
        'data-role': 'wizard-signin',
        text: signedIn ? 'ログイン済み' : 'Googleでログイン',
        disabled: signedIn,
        onClick: handlers.signIn,
      }),
    ]),
  ];
}

function folderBody(state, handlers) {
  const structure = state.structure;
  const children = [
    el('p', { class: 'muted', text: `確認する構成：${DRIVE_ROOT_LABEL} / ${FOLDER_STRUCTURE.base.join(' / ')} / { ${FOLDER_STRUCTURE.children.join(' , ')} }` }),
  ];

  if (state.structureScanning) {
    children.push(el('p', { class: 'notice notice--info', role: 'status', text: '確認しています…' }));
  }

  if (structure) {
    children.push(renderTree(structure.entries));

    if (structure.ambiguous.length > 0) {
      children.push(el('p', { class: 'notice notice--warn', text: `同じ名前のフォルダが複数あります（${structure.ambiguous.length} 件）。Drive上で重複を解消してから、もう一度確認してください。` }));
    } else if (structure.missing.length > 0) {
      children.push(el('p', { class: 'notice notice--warn', text: `不足しているフォルダが ${structure.missing.length} 件あります。次の手順で作成できます。` }));
    } else {
      children.push(el('p', { class: 'notice notice--success', text: '必要なフォルダはすべて揃っています。' }));
    }
  }

  children.push(el('div', { class: 'card__actions' }, [
    el('button', {
      type: 'button',
      class: 'button',
      'data-role': 'wizard-folder',
      text: structure ? 'もう一度確認する' : 'フォルダ構成を確認',
      disabled: state.structureScanning === true,
      onClick: handlers.folder,
    }),
  ]));

  return children;
}

function createBody(state, handlers) {
  const structure = state.structure;
  const creating = state.folderCreating === true;
  const result = state.folderCreateResult;
  const children = [];

  if (!structure) {
    children.push(el('p', { class: 'notice notice--info', text: '先に「フォルダ構成を確認」を実行してください。' }));
    return children;
  }

  if (structure.missing.length === 0) {
    children.push(el('p', { class: 'notice notice--success', text: '作成が必要なフォルダはありません。「この手順を完了にする」を押して次へ進んでください。' }));
  } else {
    children.push(el('p', { class: 'field__label', text: '作成するフォルダ' }));
    children.push(el('ul', { class: 'plain-list' }, structure.missing.map((entry) => el('li', { text: entry.path ?? entry.node.name }))));
    children.push(el('p', { class: 'muted', text: `必要な権限（この手順のときだけ）：${FOLDER_CREATE_SCOPE_LABEL[FOLDER_CREATE_SCOPE_MODE] ?? getFolderCreateScope()}` }));
  }

  if (creating) {
    children.push(renderCreateProgress(state.folderCreateProgress));
  }

  if (result) {
    children.push(renderCreateResult(result));
  }

  children.push(el('div', { class: 'card__actions' }, [
    structure.missing.length > 0
      ? el('button', {
        type: 'button',
        class: 'button',
        'data-role': 'wizard-create',
        text: creating ? '作成中…' : (result ? '作成を再実行' : `不足フォルダを作成（${structure.missing.length} 件）`),
        disabled: creating || structure.canCreate !== true,
        onClick: handlers.create,
      })
      : null,
    el('button', {
      type: 'button',
      class: 'button button--secondary',
      'data-role': 'wizard-skip-create',
      text: structure.missing.length > 0 ? 'この手順をスキップ' : 'この手順を完了にする',
      disabled: creating,
      onClick: handlers.skip(WizardStep.CREATE),
    }),
  ]));

  if (structure.missing.length > 0 && structure.canCreate !== true) {
    children.push(el('p', { class: 'muted', text: '同名フォルダの重複が解消されるまで、作成は実行できません。' }));
  }

  return children;
}

function samplesBody(state, handlers) {
  const creating = state.samplesCreating === true;
  const result = state.samplesResult;

  const children = [
    el('p', { class: 'field__label', text: '作成するファイル' }),
    el('ul', { class: 'plain-list' }, SAMPLE_FILES.map((sample) => el('li', {
      text: `${sample.name}（${sample.description}）`,
    }))),
    el('div', { class: 'notice notice--info' }, [
      el('ul', { class: 'plain-list' }, [
        el('li', { text: '01_ナレッジ を新しく作った場合だけ、初回の1度だけ作成します。' }),
        el('li', { text: '同じ名前のファイルが既にある場合は作りません（上書きはしません）。' }),
        el('li', { text: '既存ファイルの編集・移動・削除は行いません。' }),
        el('li', { text: 'この手順でも、Driveの編集権限を一時的に使用し、終わったら破棄します。' }),
      ]),
    ]),
  ];

  if (creating) {
    children.push(renderCreateProgress(state.samplesProgress, 'サンプルファイルの作成'));
  }

  if (result) {
    children.push(renderSamplesResult(result));
  }

  children.push(el('div', { class: 'card__actions' }, [
    el('button', {
      type: 'button',
      class: 'button',
      'data-role': 'wizard-samples',
      text: creating ? '作成中…' : (result ? '作成を再実行' : 'サンプルファイルを作成'),
      disabled: creating,
      onClick: handlers.samples,
    }),
    el('button', {
      type: 'button',
      class: 'button button--secondary',
      'data-role': 'wizard-skip-samples',
      text: 'この手順をスキップ',
      disabled: creating,
      onClick: handlers.skip(WizardStep.SAMPLES),
    }),
  ]));

  return children;
}

function syncBody(state, handlers) {
  const busy = state.appState === AppState.SYNCING || state.appState === AppState.PARSING;
  const indexed = (state.files ?? []).filter((file) => file.syncState === 'indexed').length;

  return [
    el('ul', { class: 'plain-list' }, [
      el('li', { text: `対象フォルダ：${state.folder?.path ?? state.folder?.name ?? '（未確定）'}` }),
      el('li', { text: '取得・抽出・分割・索引作成はすべてブラウザ内で行います。' }),
      el('li', { text: 'Driveへは読み取りのリクエストしか送りません。' }),
    ]),
    indexed > 0
      ? el('p', { class: 'notice notice--success', role: 'status', text: `${formatNumber(indexed)} 件を索引済みにしました。` })
      : null,
    el('div', { class: 'card__actions' }, [
      el('button', {
        type: 'button',
        class: 'button',
        'data-role': 'wizard-sync',
        text: busy ? '同期中…' : '初回同期を実行',
        disabled: busy || !state.folder,
        onClick: handlers.sync,
      }),
      el('button', {
        type: 'button',
        class: 'button button--secondary',
        'data-role': 'wizard-skip-sync',
        text: 'この手順をスキップ',
        disabled: busy,
        onClick: handlers.skip(WizardStep.SYNC),
      }),
    ]),
  ];
}

function searchBody(state, handlers) {
  const result = state.setupSearch;
  const children = [
    el('p', { class: 'muted', text: `検索する語：${SAMPLE_SEARCH_TERM}` }),
    el('p', { class: 'muted', text: 'この語が含まれるファイルがヒットすれば、取得・抽出・分割・索引・検索がすべて動いています。' }),
  ];

  if (result) {
    if (result.hits > 0) {
      children.push(el('p', { class: 'notice notice--success', role: 'status', text: `${formatNumber(result.hits)} 件ヒットしました。` }));
      children.push(el('ul', { class: 'plain-list' }, result.names.map((name) => el('li', { text: name }))));
    } else {
      children.push(el('p', { class: 'notice notice--warn', role: 'status', text: 'ヒットしませんでした。01_ナレッジ にファイルが無いか、同期がまだの可能性があります。' }));
    }
  }

  children.push(el('div', { class: 'card__actions' }, [
    el('button', {
      type: 'button',
      class: 'button',
      'data-role': 'wizard-search',
      text: result ? 'もう一度検索する' : '検索テストを実行',
      onClick: handlers.search,
    }),
    el('button', {
      type: 'button',
      class: 'button button--secondary',
      'data-role': 'wizard-skip-search',
      text: 'この手順をスキップ',
      onClick: handlers.skip(WizardStep.SEARCH),
    }),
  ]));

  return children;
}

function diagnoseBody(state, handlers) {
  const running = state.setupDiagnosing === true;
  const areas = state.setupDiagnosis;
  const children = [
    el('p', { class: 'muted', text: 'OAuth・Drive・フォルダ・同期・検索・IndexedDB・権限の7項目を確認します。' }),
  ];

  if (running) {
    children.push(el('p', { class: 'notice notice--info', role: 'status', text: '診断を実行しています…' }));
  }

  if (areas) {
    children.push(renderDiagnosis(areas));
  }

  children.push(el('div', { class: 'card__actions' }, [
    el('button', {
      type: 'button',
      class: 'button',
      'data-role': 'wizard-diagnose',
      text: running ? '診断中…' : (areas ? '診断をやり直す' : '診断を実行'),
      disabled: running,
      onClick: handlers.diagnose,
    }),
    el('button', {
      type: 'button',
      class: 'button button--secondary',
      'data-role': 'wizard-skip-diagnose',
      text: 'この手順をスキップ',
      disabled: running,
      onClick: handlers.skip(WizardStep.DIAGNOSE),
    }),
  ]));

  return children;
}

function doneBody(state, handlers) {
  const ready = canFinish(state.setup?.progress ?? {});

  return [
    el('p', { class: 'notice notice--success', role: 'status', 'aria-live': 'polite', text: 'すべての手順が終わりました。' }),
    el('ul', { class: 'plain-list' }, [
      el('li', { text: '以降は通常画面が開きます（この案内は表示されません）。' }),
      el('li', { text: '設定タブの「セットアップを再実行」で、いつでもこの画面へ戻れます。' }),
      el('li', { text: `通常時の権限は ${getDriveScope()} のままです。` }),
    ]),
    el('div', { class: 'card__actions' }, [
      el('button', {
        type: 'button',
        class: 'button',
        'data-role': 'wizard-finish',
        text: 'ナレッジ管理を開始',
        disabled: !ready,
        onClick: handlers.finish,
      }),
    ]),
  ];
}

/* ---------- 完了済みステップの要約 ---------- */

function renderStepSummary(step, state) {
  if (step.status === StepStatus.SKIPPED) {
    return [el('p', { class: 'muted', text: 'この手順は省略しました。設定タブから後で実行できます。' })];
  }

  switch (step.id) {
    case WizardStep.SIGN_IN:
      return [el('p', { class: 'muted', text: state.profile?.displayName ? `${state.profile.displayName} として接続しています。` : '接続しました。' })];
    case WizardStep.FOLDER:
      return [el('p', { class: 'muted', text: state.structure ? `既存 ${state.structure.existing.length} 件 / 不足 ${state.structure.missing.length} 件` : '確認しました。' })];
    case WizardStep.CREATE:
      return state.folderCreateResult ? [renderCreateResult(state.folderCreateResult)] : [];
    case WizardStep.SAMPLES:
      return state.samplesResult ? [renderSamplesResult(state.samplesResult)] : [];
    case WizardStep.SYNC:
      return [el('p', { class: 'muted', text: `索引済み ${formatNumber((state.files ?? []).filter((f) => f.syncState === 'indexed').length)} 件` })];
    case WizardStep.SEARCH:
      return [el('p', { class: 'muted', text: state.setupSearch ? `${formatNumber(state.setupSearch.hits)} 件ヒット` : '実行しました。' })];
    case WizardStep.DIAGNOSE:
      return state.setupDiagnosis ? [renderDiagnosis(state.setupDiagnosis)] : [];
    default:
      return [];
  }
}

/* ---------- 部品 ---------- */

function renderTree(entries) {
  return el('ul', { class: 'tree-list' }, (entries ?? []).map((entry) => el('li', {
    class: `tree-list__item tree-list__item--depth${entry.node.depth}`,
  }, [
    el('span', { class: 'tree-list__name', text: entry.node.name }),
    el('span', {
      class: entry.status === NodeStatus.MISSING ? 'tag tag--new' : 'tag',
      text: LABEL_BY_STATUS[entry.status] ?? '',
    }),
  ])));
}

function renderCreateProgress(progress, label = 'フォルダの作成') {
  const total = progress?.total ?? 0;
  const done = progress?.done ?? 0;

  return el('div', { class: 'progress-block', role: 'status', 'aria-live': 'polite' }, [
    el('p', {
      text: progress?.phase === 'authorizing'
        ? 'Googleの確認画面で許可を求めています…'
        : `${label}（${done} / ${total}）${progress?.currentName ? `：${progress.currentName}` : ''}`,
    }),
    el('progress', {
      class: 'progress',
      role: 'progressbar',
      'aria-label': `${label}の進捗`,
      'aria-valuenow': String(done),
      'aria-valuemin': '0',
      'aria-valuemax': String(Math.max(total, 1)),
      value: String(done),
      max: String(Math.max(total, 1)),
    }),
  ]);
}

function renderCreateResult(result) {
  const children = [];

  if (result.ok) {
    children.push(el('p', { class: 'notice notice--success', role: 'status', 'aria-live': 'polite', text: `作成が完了しました（新規 ${result.created.length} 件 / 既存を再利用 ${result.reused.length} 件）。` }));
  } else if (result.error) {
    children.push(el('p', { class: 'notice notice--error', role: 'status', 'aria-live': 'polite', text: result.error.message }));
  }

  if (result.created.length > 0) {
    children.push(el('h4', { class: 'field__label', text: '作成したフォルダ' }));
    children.push(el('ul', { class: 'plain-list' }, result.created.map((item) => driveLine(item.path, item.webViewLink))));
  }

  if (result.failed.length > 0) {
    children.push(el('h4', { class: 'field__label', text: '作成できなかったフォルダ' }));
    children.push(el('ul', { class: 'plain-list' }, result.failed.map((item) => el('li', { text: `${item.path}：${item.message}` }))));
  }

  if (result.skipped.length > 0) {
    children.push(el('h4', { class: 'field__label', text: '未実行のフォルダ' }));
    children.push(el('ul', { class: 'plain-list' }, result.skipped.map((item) => el('li', { text: `${item.path}：${item.message}` }))));
  }

  return el('div', {}, children);
}

function renderSamplesResult(result) {
  const children = [];

  if (result.ok) {
    children.push(el('p', { class: 'notice notice--success', role: 'status', 'aria-live': 'polite', text: `サンプルファイルの作成が完了しました（新規 ${result.created.length} 件 / 既存のため作成せず ${result.skipped.length} 件）。` }));
  } else if (result.error) {
    children.push(el('p', { class: 'notice notice--error', role: 'status', 'aria-live': 'polite', text: result.error.message }));
  }

  if (result.created.length > 0) {
    children.push(el('h4', { class: 'field__label', text: '作成したファイル' }));
    children.push(el('ul', { class: 'plain-list' }, result.created.map((item) => driveLine(item.name, item.webViewLink))));
  }

  if (result.skipped.length > 0) {
    children.push(el('h4', { class: 'field__label', text: '既にあったため作成しなかったファイル' }));
    children.push(el('ul', { class: 'plain-list' }, result.skipped.map((item) => el('li', { text: item.name }))));
  }

  if (result.failed.length > 0) {
    children.push(el('h4', { class: 'field__label', text: '作成できなかったファイル' }));
    children.push(el('ul', { class: 'plain-list' }, result.failed.map((item) => el('li', { text: `${item.name}：${item.message}` }))));
  }

  return el('div', {}, children);
}

/* Driveのリンク付きの1行。Drive以外のURLはリンクにしない。 */
function driveLine(label, url) {
  const href = safeDriveUrl(url);

  return el('li', {}, [
    el('span', { text: `${label}　` }),
    href
      ? el('a', { href, target: '_blank', rel: 'noopener noreferrer', text: 'Driveで開く' })
      : el('span', { class: 'muted', text: '（リンクなし）' }),
  ]);
}

function renderDiagnosis(areas) {
  return el('table', { class: 'diag-table' }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { scope: 'col', text: '項目' }),
        el('th', { scope: 'col', text: '結果' }),
        el('th', { scope: 'col', text: '内容' }),
      ]),
    ]),
    el('tbody', {}, areas.map((entry) => el('tr', {}, [
      el('th', { scope: 'row', text: entry.label }),
      el('td', {}, [
        el('span', {
          class: entry.ok === true ? 'tag' : (entry.ok === false ? 'tag tag--new' : 'tag'),
          text: entry.ok === true ? '成功' : (entry.ok === false ? '失敗' : '未実行'),
        }),
      ]),
      el('td', { class: 'diag-table__detail', text: entry.detail || '—' }),
    ]))),
  ]);
}

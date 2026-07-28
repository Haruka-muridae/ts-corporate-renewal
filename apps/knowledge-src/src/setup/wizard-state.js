/*
 * セットアップウィザードの進行ロジック（純粋関数）。
 *
 * ------------------------------------------------------------------
 * ここでは通信もDOM操作もしない
 * ------------------------------------------------------------------
 * 「今どのステップか」「進めてよいか」「完了したか」だけを決める。
 * 実行は main.js の actions、表示は ui/views/wizard-view.js が行う。
 * こうしておくと、分岐の全パターンを単体テストで確認できる。
 * ------------------------------------------------------------------
 */

import { DRIVE_ROOT_LABEL, FOLDER_STRUCTURE, SAMPLE_SEARCH_TERM, getDriveScope } from '../config.js';

export const WizardStep = Object.freeze({
  SIGN_IN: 'signIn',       // Googleログイン
  FOLDER: 'folder',        // フォルダ構成の確認
  CREATE: 'create',        // 不足フォルダの作成
  SAMPLES: 'samples',      // サンプルファイルの作成（01_ナレッジ を新規作成したときだけ）
  SYNC: 'sync',            // 初回同期
  SEARCH: 'search',        // 検索テスト
  DIAGNOSE: 'diagnose',    // 診断
  DONE: 'done',            // 完了
});

export const StepStatus = Object.freeze({
  PENDING: 'pending',   // まだ
  CURRENT: 'current',   // 今ここ
  DONE: 'done',         // 完了
  SKIPPED: 'skipped',   // 省略した
  BLOCKED: 'blocked',   // 前の手順が終わっていない
});

export const STEP_STATUS_LABEL_JA = Object.freeze({
  [StepStatus.PENDING]: '未実施',
  [StepStatus.CURRENT]: '実施中',
  [StepStatus.DONE]: '完了',
  [StepStatus.SKIPPED]: '省略',
  [StepStatus.BLOCKED]: '前の手順待ち',
});

/*
 * ステップの定義。順序はここだけで決める。
 *
 *   optional … スキップできるか
 *   applies  … 表示するかどうか（progress を見て決める）
 */
const DEFINITIONS = Object.freeze([
  {
    id: WizardStep.SIGN_IN,
    label: 'Googleにログイン',
    summary: 'Google Drive の読み取り権限だけを求めます。',
    detail: `要求するスコープは ${getDriveScope()} の1つだけです。`
      + 'アクセストークンはブラウザのメモリにしか置かず、保存しません。',
    optional: false,
  },
  {
    id: WizardStep.FOLDER,
    label: 'フォルダ構成を確認',
    summary: `${DRIVE_ROOT_LABEL} / ${FOLDER_STRUCTURE.base.join(' / ')} の下を1階層ずつ確認します。`,
    detail: '読み取り専用で確認するだけです。この時点ではDriveへ何も書き込みません。',
    optional: false,
  },
  {
    id: WizardStep.CREATE,
    label: '不足フォルダを作成',
    summary: '欠けているフォルダだけを作ります。既存のフォルダは作り直しません。',
    detail: 'この手順のときだけ、Driveの編集権限を一時的に使います。作成が終わると破棄します。',
    optional: true,
  },
  {
    id: WizardStep.SAMPLES,
    label: 'サンプルファイルを作成',
    summary: '01_ナレッジ を新しく作った場合だけ、README.md とサンプル.txt を置きます。',
    detail: '同じ名前のファイルが既にある場合は作りません（上書きはしません）。',
    optional: true,
  },
  {
    id: WizardStep.SYNC,
    label: '初回同期',
    summary: 'Driveからファイルを取得し、ブラウザ内で抽出・分割・索引を作ります。',
    detail: '読み取り専用の通信だけで完了します。Driveへは何も書き込みません。',
    optional: true,
  },
  {
    id: WizardStep.SEARCH,
    label: '検索テスト',
    summary: `「${SAMPLE_SEARCH_TERM}」などで検索し、ヒットすることを確認します。`,
    detail: '検索はすべてブラウザ内で完結します。外部へ問い合わせません。',
    optional: true,
  },
  {
    id: WizardStep.DIAGNOSE,
    label: '診断',
    summary: 'OAuth・Drive・フォルダ・同期・検索・IndexedDB・権限をまとめて確認します。',
    detail: '失敗した項目があっても、原因が日本語で表示されます。',
    optional: true,
  },
  {
    id: WizardStep.DONE,
    label: '完了',
    summary: '「ナレッジ管理を開始」で通常画面へ移ります。',
    detail: 'この状態はブラウザ内に保存され、次回からは通常画面が開きます。',
    optional: false,
  },
]);

/*
 * 表示するステップ一覧。
 * サンプルファイルの手順は「01_ナレッジ を新規作成した」ときだけ出す。
 */
export function buildWizardSteps(progress = {}) {
  return DEFINITIONS.filter((step) => {
    if (step.id === WizardStep.SAMPLES) {
      return progress.knowledgeFolderCreated === true;
    }
    return true;
  });
}

/*
 * 進捗レコードの初期値。
 *
 * ここに入れてよいのは「どこまで進んだか」だけ。
 * トークン・ファイル本文・個人情報は入れない（IndexedDB へ保存されるため）。
 */
export function createProgress() {
  return {
    signIn: false,
    folder: false,
    create: false,
    createSkipped: false,
    samples: false,
    samplesSkipped: false,
    knowledgeFolderCreated: false,
    sync: false,
    syncSkipped: false,
    search: false,
    searchSkipped: false,
    diagnose: false,
    diagnoseSkipped: false,
  };
}

/* ステップIDから「完了フラグ」「省略フラグ」のキーを引く。 */
const FLAG_KEY = Object.freeze({
  [WizardStep.SIGN_IN]: { done: 'signIn', skipped: null },
  [WizardStep.FOLDER]: { done: 'folder', skipped: null },
  [WizardStep.CREATE]: { done: 'create', skipped: 'createSkipped' },
  [WizardStep.SAMPLES]: { done: 'samples', skipped: 'samplesSkipped' },
  [WizardStep.SYNC]: { done: 'sync', skipped: 'syncSkipped' },
  [WizardStep.SEARCH]: { done: 'search', skipped: 'searchSkipped' },
  [WizardStep.DIAGNOSE]: { done: 'diagnose', skipped: 'diagnoseSkipped' },
  [WizardStep.DONE]: { done: null, skipped: null },
});

export function isStepSettled(progress, stepId) {
  const key = FLAG_KEY[stepId];

  if (!key) {
    return false;
  }

  return Boolean(progress?.[key.done]) || Boolean(key.skipped && progress?.[key.skipped]);
}

/*
 * 各ステップの状態を決める。
 *
 * 先頭から見て、最初の「まだ片付いていないステップ」が CURRENT。
 * それより後ろは、直前が片付いていなければ BLOCKED。
 */
export function computeStepStates(progress = {}, steps = buildWizardSteps(progress)) {
  let currentAssigned = false;

  return steps.map((step) => {
    const key = FLAG_KEY[step.id];
    const done = Boolean(key?.done && progress[key.done]);
    const skipped = Boolean(key?.skipped && progress[key.skipped]);

    if (step.id === WizardStep.DONE) {
      const ready = !currentAssigned;
      return { ...step, status: ready ? StepStatus.CURRENT : StepStatus.BLOCKED };
    }

    if (done) {
      return { ...step, status: StepStatus.DONE };
    }

    if (skipped) {
      return { ...step, status: StepStatus.SKIPPED };
    }

    if (!currentAssigned) {
      currentAssigned = true;
      return { ...step, status: StepStatus.CURRENT };
    }

    return { ...step, status: StepStatus.BLOCKED };
  });
}

/* 今いるステップ。全部片付いていれば DONE。 */
export function currentStep(progress = {}, steps = buildWizardSteps(progress)) {
  const found = computeStepStates(progress, steps).find((step) => step.status === StepStatus.CURRENT);
  return found ?? { ...DEFINITIONS[DEFINITIONS.length - 1], status: StepStatus.CURRENT };
}

/* 「ナレッジ管理を開始」を押せるか。必須ステップがすべて片付いているか。 */
export function canFinish(progress = {}) {
  const steps = buildWizardSteps(progress).filter((step) => step.id !== WizardStep.DONE);
  return steps.every((step) => isStepSettled(progress, step.id));
}

/* 進み具合（表示用）。 */
export function progressRatio(progress = {}) {
  const steps = buildWizardSteps(progress).filter((step) => step.id !== WizardStep.DONE);
  const settled = steps.filter((step) => isStepSettled(progress, step.id)).length;

  return { done: settled, total: steps.length };
}

/* ================================================================
 * 保存形式
 * ================================================================ */

export const SETUP_RECORD_VERSION = 1;

/*
 * IndexedDB に置くレコード。
 * 中身は「進捗フラグ」と「完了時刻」だけ。個人情報もトークンも入れない。
 */
export function makeSetupRecord(progress, { completed = false, completedAt = null } = {}) {
  return {
    version: SETUP_RECORD_VERSION,
    completed: Boolean(completed),
    completedAt: completed ? (completedAt ?? new Date().toISOString()) : null,
    progress: { ...createProgress(), ...(progress ?? {}) },
  };
}

/*
 * 保存済みレコードを読み直す。
 * 形式が違う・壊れている場合は「未完了」として扱う（画面は壊さない）。
 */
export function parseSetupRecord(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== SETUP_RECORD_VERSION) {
    return makeSetupRecord(createProgress(), { completed: false });
  }

  return makeSetupRecord(raw.progress, {
    completed: raw.completed === true,
    completedAt: typeof raw.completedAt === 'string' ? raw.completedAt : null,
  });
}

/* ================================================================
 * 診断のまとめ（7分類）
 * ================================================================ */

export const DiagnosisArea = Object.freeze({
  OAUTH: 'oauth',
  DRIVE: 'drive',
  FOLDER: 'folder',
  SYNC: 'sync',
  SEARCH: 'search',
  INDEXED_DB: 'indexedDb',
  PERMISSION: 'permission',
});

export const DIAGNOSIS_AREA_LABEL_JA = Object.freeze({
  [DiagnosisArea.OAUTH]: 'OAuth（Googleログイン）',
  [DiagnosisArea.DRIVE]: 'Drive API への接続',
  [DiagnosisArea.FOLDER]: 'フォルダ構成',
  [DiagnosisArea.SYNC]: '同期',
  [DiagnosisArea.SEARCH]: '検索',
  [DiagnosisArea.INDEXED_DB]: 'ブラウザ内データベース',
  [DiagnosisArea.PERMISSION]: '権限',
});

/* 接続診断の項目IDを、上の7分類へ割り当てる。 */
const AREA_BY_CHECK = Object.freeze({
  gis: DiagnosisArea.OAUTH,
  token: DiagnosisArea.OAUTH,
  about: DiagnosisArea.DRIVE,
  folder1: DiagnosisArea.FOLDER,
  folder2: DiagnosisArea.FOLDER,
  folder3: DiagnosisArea.FOLDER,
  fileList: DiagnosisArea.SYNC,
  gdocExport: DiagnosisArea.SYNC,
  pdfDownload: DiagnosisArea.SYNC,
  indexedDb: DiagnosisArea.INDEXED_DB,
  searchIndex: DiagnosisArea.SEARCH,
});

/*
 * 診断結果を7分類へまとめる。
 *
 * results   … runDiagnostics() の results
 * extra     … { scope, writeTokenHeld, syncedFiles, searchHits, chunkCount }
 *
 * 各分類は、含まれる項目に1つでも失敗があれば失敗。
 * 1つも実行されていなければ「未実行」。
 */
export function summarizeDiagnosis(results = {}, extra = {}) {
  const areas = Object.values(DiagnosisArea).map((area) => ({
    area,
    label: DIAGNOSIS_AREA_LABEL_JA[area],
    ok: null,
    detail: '',
    items: [],
  }));

  const byArea = new Map(areas.map((entry) => [entry.area, entry]));

  Object.values(results).forEach((result) => {
    const area = AREA_BY_CHECK[result.id];
    const entry = area ? byArea.get(area) : null;

    if (!entry) {
      return;
    }

    entry.items.push({ id: result.id, label: result.label, status: result.status, message: result.message });
  });

  byArea.forEach((entry) => {
    if (entry.items.length === 0) {
      return;
    }

    const failed = entry.items.filter((item) => item.status === 'failure');
    const success = entry.items.filter((item) => item.status === 'success');

    if (failed.length > 0) {
      entry.ok = false;
      entry.detail = failed.map((item) => `${item.label}：${item.message}`).join(' / ');
      return;
    }

    if (success.length > 0) {
      entry.ok = true;
      entry.detail = `${success.length} 項目すべて成功しました。`;
    }
  });

  /*
   * 権限は通信では測れないため、アプリが持っている状態から判定する。
   *   - 通常のスコープが読み取り専用であること
   *   - 書き込み用トークンを保持していないこと
   */
  const permission = byArea.get(DiagnosisArea.PERMISSION);
  const scope = extra.scope ?? getDriveScope();
  const readOnly = scope.endsWith('drive.readonly') || scope.endsWith('drive.file');
  const noWriteToken = extra.writeTokenHeld !== true;

  permission.ok = readOnly && noWriteToken;
  permission.detail = readOnly
    ? (noWriteToken
      ? `通常の権限は ${scope} のみ。書き込み用の権限は保持していません。`
      : `通常の権限は ${scope} ですが、書き込み用トークンが残っています。`)
    : `通常の権限が読み取り専用ではありません（${scope}）。`;
  permission.items = [{ id: 'scope', label: '常用スコープ', status: readOnly ? 'success' : 'failure', message: scope }];

  /* 同期・検索は、ウィザードで実際に動かした結果も添える。 */
  const sync = byArea.get(DiagnosisArea.SYNC);
  if (typeof extra.syncedFiles === 'number') {
    sync.detail = `${sync.detail ? `${sync.detail} ` : ''}初回同期で ${extra.syncedFiles} 件を索引済みにしました。`;
  }

  const search = byArea.get(DiagnosisArea.SEARCH);
  if (typeof extra.searchHits === 'number') {
    search.detail = `${search.detail ? `${search.detail} ` : ''}検索テストで ${extra.searchHits} 件ヒットしました。`;
  }

  return areas;
}

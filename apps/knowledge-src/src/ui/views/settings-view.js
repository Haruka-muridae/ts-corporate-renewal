/*
 * 設定画面。
 *
 * チャンク分割と同期の挙動を変更する。
 * 認証情報（クライアントID・APIキー）はここでは編集しない。
 * ブラウザ側に置くと利用者ごとに食い違うため、src/config.js の1か所で管理する。
 */

import { el, replaceChildren, formatBytes } from '../../core/dom.js';
import {
  CHUNK_DEFAULTS, SYNC_DEFAULTS, FEATURE_FLAGS, SCOPE_MODE, getDriveScope,
  KNOWLEDGE_FOLDER_PATH, DRIVE_ROOT_LABEL, isPickerConfigured,
} from '../../config.js';
import { getChunkOptions, setChunkOptions, getSyncOptions, setSyncOptions } from '../../db/repo.js';
import { createDiagnosticsPanel } from './diagnostics-panel.js';
import { logger } from '../../core/logger.js';

export function createSettingsView(ctx) {
  const diagnostics = createDiagnosticsPanel(ctx);
  const message = el('p', { class: 'muted', text: '' });

  const fields = {
    targetChars: numberField('1チャンクの目安（文字）', 100, 4000, 'この長さを目安に、段落や文の切れ目で分割します。'),
    overlapChars: numberField('オーバーラップ（文字）', 0, 1000, '前のチャンク末尾を次のチャンク先頭へ重ねる長さ。'),
    maxChars: numberField('チャンクの上限（文字）', 200, 8000, 'この長さを超える場合のみ強制的に分割します。'),
    minChars: numberField('最小の長さ（文字）', 0, 1000, 'これ未満の断片は直前のチャンクへ吸収します。'),
    maxFileMb: numberField('取得するファイルの上限（MB）', 1, 200, 'これを超えるファイルは取得せずスキップします。'),
    concurrency: numberField('同時解析数', 1, 4, '大きくすると速くなりますが、端末の負荷も上がります。'),
    maxDepth: numberField('サブフォルダの深さ', 0, 10, '0にすると選択したフォルダの直下だけを対象にします。'),
  };

  const recursiveCheckbox = el('input', { type: 'checkbox' });

  const saveButton = el('button', {
    type: 'submit',
    class: 'button',
    text: '保存する',
  });

  const form = el('form', {
    onSubmit: async (event) => {
      event.preventDefault();
      await save();
    },
  }, [
    el('h3', { class: 'card__title', text: 'チャンク分割' }),
    el('div', { class: 'field-row' }, [
      fields.targetChars.wrapper,
      fields.overlapChars.wrapper,
      fields.maxChars.wrapper,
      fields.minChars.wrapper,
    ]),

    el('h3', { class: 'card__title', text: '同期' }),
    el('div', { class: 'field-row' }, [
      fields.maxFileMb.wrapper,
      fields.concurrency.wrapper,
      fields.maxDepth.wrapper,
    ]),
    el('label', { class: 'field' }, [
      el('span', { class: 'field__label' }, [recursiveCheckbox, ' サブフォルダも対象にする']),
    ]),

    el('div', { class: 'card__actions' }, [
      saveButton,
      el('button', {
        type: 'button',
        class: 'button button--secondary',
        text: '初期値に戻す',
        onClick: () => {
          applyValues(CHUNK_DEFAULTS, SYNC_DEFAULTS);
          message.textContent = '初期値を入力しました。「保存する」で確定します。';
        },
      }),
    ]),
    message,
  ]);

  const infoGrid = el('div', { class: 'stat-grid' });

  const element = el('section', {}, [
    el('div', { class: 'card' }, [
      el('h2', { class: 'card__title', text: '設定' }),
      el('p', {
        class: 'card__desc',
        text: '変更後は「すべて再同期」または「検索インデックス再構築」を実行すると、'
          + '既存のナレッジにも新しい設定が反映されます。',
      }),
      form,
    ]),

    diagnostics.element,

    el('div', { class: 'card' }, [
      el('h2', { class: 'card__title', text: '動作情報' }),
      infoGrid,
    ]),

    el('div', { class: 'card' }, [
      el('h2', { class: 'card__title', text: '設定値の正本' }),
      el('p', {
        class: 'card__desc',
        text: '値を変更するときに編集するファイルです。同じ値を2か所へ書かないでください。',
      }),
      el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data' }, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { scope: 'col', text: '設定値' }),
              el('th', { scope: 'col', text: '正本ファイル' }),
              el('th', { scope: 'col', text: '現在の状態' }),
            ]),
          ]),
          el('tbody', {}, [
            sourceRow(
              'OAuthクライアントID',
              'apps/auth-config.js',
              'ビルド時に src/generated/google-config.js が自動生成されます',
            ),
            sourceRow(
              'Picker用APIキー',
              'apps/knowledge-src/src/config.js（pickerApiKey）',
              isPickerConfigured() ? '設定済み' : '未設定（一覧方式で選択）',
            ),
            sourceRow(
              'プロジェクト番号（appId）',
              'apps/knowledge-src/src/config.js（pickerAppId）',
              'drive.file を使う場合のみ必要',
            ),
            sourceRow(
              '使用スコープ',
              'apps/knowledge-src/src/config.js（SCOPE_MODE）',
              getDriveScope(),
            ),
            sourceRow(
              '固定フォルダパス',
              'apps/knowledge-src/src/config.js（KNOWLEDGE_FOLDER_PATH）',
              [DRIVE_ROOT_LABEL, ...KNOWLEDGE_FOLDER_PATH].join(' / '),
            ),
          ]),
        ]),
      ]),
    ]),
  ]);

  function applyValues(chunk, sync) {
    fields.targetChars.input.value = String(chunk.targetChars);
    fields.overlapChars.input.value = String(chunk.overlapChars);
    fields.maxChars.input.value = String(chunk.maxChars);
    fields.minChars.input.value = String(chunk.minChars);
    fields.maxFileMb.input.value = String(Math.round(sync.maxFileBytes / (1024 * 1024)));
    fields.concurrency.input.value = String(sync.concurrency);
    fields.maxDepth.input.value = String(sync.maxDepth);
    recursiveCheckbox.checked = Boolean(sync.recursive);
  }

  async function load() {
    const [chunk, sync] = await Promise.all([getChunkOptions(), getSyncOptions()]);
    applyValues(chunk, sync);
  }

  async function save() {
    const chunk = {
      targetChars: fields.targetChars.value(),
      overlapChars: fields.overlapChars.value(),
      maxChars: fields.maxChars.value(),
      minChars: fields.minChars.value(),
    };

    if (chunk.maxChars < chunk.targetChars) {
      message.textContent = 'チャンクの上限は「目安」以上にしてください。';
      return;
    }

    if (chunk.overlapChars >= chunk.targetChars) {
      message.textContent = 'オーバーラップは「目安」より小さくしてください。';
      return;
    }

    const sync = {
      maxFileBytes: fields.maxFileMb.value() * 1024 * 1024,
      concurrency: fields.concurrency.value(),
      maxDepth: fields.maxDepth.value(),
      recursive: recursiveCheckbox.checked,
    };

    saveButton.disabled = true;

    try {
      await setChunkOptions(chunk);
      await setSyncOptions(sync);
      logger.info('settings:saved', { chunk, sync });
      message.textContent = '保存しました。次回の同期から反映されます。';
    } catch (error) {
      message.textContent = error?.userMessage ?? '保存に失敗しました。';
    } finally {
      saveButton.disabled = false;
    }
  }

  const update = (state) => {
    replaceChildren(infoGrid, [
      info('要求スコープ', SCOPE_MODE === 'file' ? 'drive.file' : 'drive.readonly', getDriveScope()),
      info('Driveへの書き込み', 'なし', '読み取り専用のAPIのみ'),
      info('保存先', 'IndexedDB', 'Driveへは抽出結果を保存しません'),
      info('対象フォルダ', state.folder?.name ?? '未選択', ''),
      info('取得上限', formatBytes(Number(fields.maxFileMb.input.value || 0) * 1024 * 1024), '1ファイルあたり'),
      info('将来拡張', Object.entries(FEATURE_FLAGS).filter(([, on]) => on).length === 0 ? 'すべて無効' : '一部有効',
        'Embedding / ベクトル検索 / WebGPU など'),
    ]);
  };

  load().catch((error) => {
    message.textContent = '設定の読み込みに失敗しました。';
    logger.error('settings:load-failed', error);
  });

  return { element, update, onEnter: load };
}

function numberField(label, min, max, hint) {
  const input = el('input', {
    type: 'number',
    min: String(min),
    max: String(max),
    step: '1',
    required: true,
  });

  const wrapper = el('label', { class: 'field' }, [
    el('span', { class: 'field__label', text: label }),
    input,
    hint ? el('span', { class: 'field__hint', text: hint }) : null,
  ]);

  return {
    wrapper,
    input,
    value() {
      const parsed = Number(input.value);
      if (!Number.isFinite(parsed)) {
        return min;
      }
      return Math.max(min, Math.min(max, Math.round(parsed)));
    },
  };
}

function sourceRow(label, file, state) {
  return el('tr', {}, [
    el('td', { text: label }),
    el('td', {}, [el('code', { text: file })]),
    el('td', { class: 'muted', text: state }),
  ]);
}

function info(label, value, sub) {
  return el('div', { class: 'stat' }, [
    el('span', { class: 'stat__label', text: label }),
    el('span', { class: 'stat__value', text: value }),
    sub ? el('span', { class: 'stat__sub', text: sub }) : null,
  ]);
}

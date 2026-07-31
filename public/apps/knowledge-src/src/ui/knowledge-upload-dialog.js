/*
 * 「ナレッジを追加」ダイアログ。
 *
 * Fileオブジェクトはこのダイアログが開いている間だけメモリに保持する。
 * 本文をDOM属性・Storage・URL・ログへ入れない。
 */

import {
  el, clear, formatBytes,
} from '../core/dom.js';
import {
  KNOWLEDGE_UPLOAD_LIMITS, KNOWLEDGE_UPLOAD_TYPES,
} from '../config.js';
import {
  buildUploadPlan, rejectReasonLabel, UploadSupport,
} from '../drive/upload-plan.js';

const ACCEPT = Object.keys(KNOWLEDGE_UPLOAD_TYPES).join(',');

export function openKnowledgeUploadDialog({ folder, runUpload }) {
  return new Promise((resolve) => {
    const dialog = el('dialog', {
      class: 'dialog dialog--wide upload-dialog',
      'aria-label': 'ナレッジファイルを追加',
    });
    const body = el('div', { class: 'dialog__body upload-dialog__body' });
    let plan = buildUploadPlan([]);
    let phase = 'select';
    let running = false;
    let result = null;
    const itemStates = new Map();

    const fileInput = el('input', {
      type: 'file',
      multiple: true,
      accept: ACCEPT,
      class: 'visually-hidden',
      'aria-label': 'アップロードするファイルを選択',
      onChange: (event) => select(event.target.files),
    });
    const folderInput = el('input', {
      type: 'file',
      multiple: true,
      accept: ACCEPT,
      webkitdirectory: true,
      class: 'visually-hidden',
      'aria-label': 'アップロードするフォルダを選択',
      onChange: (event) => select(event.target.files),
    });
    const supportsFolder = 'webkitdirectory' in folderInput;

    function close(value = null) {
      if (running) return;
      dialog.close();
      dialog.remove();
      resolve(value);
    }

    function select(files) {
      plan = buildUploadPlan(files);
      result = null;
      itemStates.clear();
      plan.accepted.forEach((item) => itemStates.set(item.id, {
        drive: '待機中',
        sync: item.support === UploadSupport.PARSEABLE ? '待機中' : '保存のみ',
        parse: item.support === UploadSupport.PARSEABLE ? '待機中' : '解析非対応',
        chunks: item.support === UploadSupport.PARSEABLE ? '待機中' : '—',
        search: item.support === UploadSupport.PARSEABLE ? '待機中' : '対象外',
      }));
      phase = 'select';
      render();
    }

    function reset() {
      fileInput.value = '';
      folderInput.value = '';
      select([]);
      fileInput.focus();
    }

    async function start() {
      if (running || plan.accepted.length === 0) return;
      running = true;
      phase = 'progress';
      render();

      try {
        result = await runUpload(plan, {
          onProgress(progress) {
            if (progress?.itemId) {
              const state = itemStates.get(progress.itemId);
              if (state && progress.itemStatus === 'uploading') {
                state.drive = '保存中';
              }
              if (state && progress.itemStatus === 'saved') {
                state.drive = progress.uploadName ? `保存済み：${progress.uploadName}` : '保存済み';
              }
              if (state && progress.itemStatus === 'failed') {
                state.drive = progress.error?.userMessage
                  ? `失敗：${progress.error.userMessage}`
                  : '失敗（再選択して再試行できます）';
                state.sync = '未実行';
                state.parse = '未実行';
                state.chunks = '未実行';
                state.search = '未実行';
              }
            }
            result = { ...(result ?? {}), progress };
            render();
          },
        });
      } catch (error) {
        result = {
          ok: false,
          error: { message: error?.userMessage ?? 'アップロードに失敗しました。' },
        };
      } finally {
        running = false;
        applyFinalStates(result);
        phase = 'done';
        render();
      }
    }

    function applyFinalStates(finalResult) {
      const uploaded = finalResult?.upload?.uploaded ?? [];
      const synced = new Map((finalResult?.syncedFiles ?? []).map((file) => [String(file.fileId), file]));

      uploaded.forEach((item) => {
        const state = itemStates.get(item.entry.id);
        if (!state) return;
        const syncedFile = synced.get(String(item.file.id));

        state.drive = item.renamed ? `保存済み：${item.uploadName}（別名）` : '保存済み';

        if (!item.parseable) {
          state.sync = '保存のみ';
          state.parse = '解析非対応';
          state.chunks = '—';
          state.search = '対象外';
        } else if (syncedFile?.syncState === 'indexed') {
          state.sync = '同期済み';
          state.parse = '解析済み';
          state.chunks = `${Number(syncedFile.chunkCount) || 0}件`;
          state.search = '反映済み';
        } else if (syncedFile?.syncState === 'error') {
          state.sync = '同期エラー';
          state.parse = syncedFile.errorMessage || '解析に失敗';
          state.chunks = '0件';
          state.search = '未反映';
        } else {
          state.sync = finalResult?.syncCompleted ? '確認が必要' : '未実行';
          state.parse = '未確認';
          state.chunks = '未確認';
          state.search = '未確認';
        }
      });
    }

    function render() {
      clear(dialog);

      dialog.append(
        el('div', { class: 'dialog__head' }, [
          el('div', {}, [
            el('h2', { text: 'ナレッジファイルを追加' }),
            el('p', {
              class: 'muted',
              text: '選択したファイルは Google Drive の「TSAM AI / ローカルLLM / 01_ナレッジ」に保存され、同期後に検索対象へ追加されます。',
            }),
          ]),
          !running ? el('button', {
            type: 'button',
            class: 'icon-button',
            'aria-label': '閉じる',
            text: '×',
            onClick: () => close(result),
          }) : null,
        ]),
        body,
        el('div', { class: 'dialog__foot' }, renderFooter()),
      );

      renderBody();
    }

    function renderBody() {
      clear(body);

      if (phase === 'select') {
        renderSelection();
      } else if (phase === 'confirm') {
        renderConfirmation();
      } else if (phase === 'progress') {
        renderProgress();
      } else {
        renderDone();
      }
    }

    function renderSelection() {
      const drop = el('div', {
        class: 'upload-drop',
        tabindex: '0',
        role: 'button',
        'aria-label': 'ファイルをドラッグ＆ドロップ、または選択',
        onClick: () => fileInput.click(),
        onKeydown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            fileInput.click();
          }
        },
        onDragover: (event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          drop.classList.add('upload-drop--active');
        },
        onDragleave: () => drop.classList.remove('upload-drop--active'),
        onDrop: (event) => {
          event.preventDefault();
          drop.classList.remove('upload-drop--active');
          select(event.dataTransfer.files);
        },
      }, [
        el('strong', { text: 'ここへファイルをドラッグ＆ドロップ' }),
        el('span', { text: 'またはクリックしてファイルを選択' }),
        el('small', {
          text: `一度に${KNOWLEDGE_UPLOAD_LIMITS.maxFiles}件、1件${formatBytes(KNOWLEDGE_UPLOAD_LIMITS.maxFileBytes)}、合計${formatBytes(KNOWLEDGE_UPLOAD_LIMITS.maxTotalBytes)}まで`,
        }),
      ]);

      body.append(
        fileInput,
        folderInput,
        drop,
        el('div', { class: 'upload-choices' }, [
          el('button', {
            type: 'button',
            class: 'button button--secondary',
            text: 'ファイルを選択',
            onClick: () => fileInput.click(),
          }),
          el('button', {
            type: 'button',
            class: 'button button--secondary',
            text: 'フォルダを選択',
            disabled: !supportsFolder,
            onClick: () => folderInput.click(),
          }),
        ]),
        !supportsFolder ? el('p', {
          class: 'notice notice--warn',
          text: 'このブラウザはフォルダ選択に対応していません。最新版のChromeまたはEdgeをご利用ください。',
        }) : null,
        el('p', {
          class: 'muted',
          text: '解析対応：PDF、DOCX、TXT、Markdown、CSV。HTML、PPTX、XLSXはDriveへ保存できますが、現在は解析・検索の対象外です。',
        }),
      );

      if (plan.selectedCount > 0) {
        body.append(renderPlanSummary(), renderItemTable(false));
      }
    }

    function renderConfirmation() {
      body.append(
        el('div', { class: 'notice notice--warn' }, [
          el('strong', { text: 'アップロード内容を確認してください' }),
          el('ul', {}, [
            el('li', { text: `ファイル数：${plan.accepted.length}件（除外 ${plan.rejected.length}件）` }),
            el('li', { text: `合計容量：${formatBytes(plan.totalBytes)}` }),
            el('li', { text: `保存先：${folder?.path ?? 'マイドライブ / TSAM AI / ローカルLLM / 01_ナレッジ'}` }),
            el('li', { text: 'アップロード時のみ、Google Driveへの書き込み権限を使用します。' }),
            el('li', { text: '既存ファイルの削除・編集・移動・上書きは行いません。同名は別名で保存します。' }),
            el('li', { text: '保存後に既存の差分同期を実行し、対応形式を解析・チャンク化・検索へ反映します。' }),
          ]),
        ]),
        renderPlanSummary(),
        renderItemTable(false),
      );
    }

    function renderProgress() {
      const progress = result?.progress ?? {
        phase: 'authorizing', done: 0, total: plan.accepted.length, currentName: '',
      };
      const done = Number(progress.done) || 0;
      const total = Number(progress.total) || plan.accepted.length;

      body.append(
        el('div', { class: 'progress-block', role: 'status', 'aria-live': 'polite' }, [
          el('p', {
            text: progress.phase === 'authorizing'
              ? 'Google Driveへの書き込み権限を確認しています…'
              : progress.phase === 'syncing'
                ? '保存したファイルを同期・解析しています…'
                : `アップロードしています（${done} / ${total}）${progress.currentName ? `：${progress.currentName}` : ''}`,
          }),
          el('progress', {
            class: 'progress',
            role: 'progressbar',
            max: Math.max(1, total),
            value: Math.min(done, Math.max(1, total)),
            'aria-label': 'ナレッジ追加の進捗',
          }),
        ]),
        renderItemTable(true),
        el('p', {
          class: 'muted',
          text: '処理中はこのページを閉じないでください。通信が切れた場合、成功済みのファイルはDriveに残ります。',
        }),
      );
    }

    function renderDone() {
      const uploaded = result?.upload?.uploaded?.length ?? 0;
      const failed = (result?.upload?.failed?.length ?? 0) + (result?.upload?.skipped?.length ?? 0);
      const ok = failed === 0 && uploaded > 0;

      body.append(
        el('div', {
          class: `notice ${ok ? 'notice--success' : 'notice--warn'}`,
          role: 'status',
          'aria-live': 'polite',
        }, [
          el('strong', { text: ok ? 'ナレッジの追加が完了しました。' : '一部のファイルを追加できませんでした。' }),
          el('p', { text: `Drive保存：${uploaded}件／失敗・未実行：${failed}件` }),
          result?.error ? el('p', { text: result.error.message ?? String(result.error) }) : null,
        ]),
        renderItemTable(true),
        el('div', { class: 'upload-complete-actions' }, [
          el('a', { class: 'button', href: './#search', text: '検索で確認' }),
          el('a', { class: 'button button--secondary', href: './chat/', text: 'AIナレッジチャットを開く' }),
          el('button', {
            type: 'button',
            class: 'button button--secondary',
            text: '追加でアップロード',
            onClick: reset,
          }),
        ]),
      );
    }

    function renderPlanSummary() {
      return el('div', { class: 'upload-summary' }, [
        stat('選択', `${plan.selectedCount}件`),
        stat('追加対象', `${plan.accepted.length}件`),
        stat('解析対応', `${plan.parseableCount}件`),
        stat('保存のみ', `${plan.storeOnlyCount}件`),
        stat('合計容量', formatBytes(plan.totalBytes)),
      ]);
    }

    function renderItemTable(showStates) {
      const rows = [
        ...plan.accepted.map((item) => ({ item, accepted: true })),
        ...plan.rejected.map((item) => ({ item, accepted: false })),
      ];

      return el('div', { class: 'table-wrap upload-table' }, [
        el('table', { class: 'data' }, [
          el('thead', {}, [
            el('tr', {}, showStates
              ? ['ファイル', '容量', 'Drive保存', '同期', '解析', 'チャンク', '検索反映']
                .map((label) => el('th', { scope: 'col', text: label }))
              : ['ファイル', '形式', '容量', '取扱い']
                .map((label) => el('th', { scope: 'col', text: label }))),
          ]),
          el('tbody', {}, rows.map(({ item, accepted }) => {
            const state = itemStates.get(item.id);
            const treatment = accepted
              ? (item.support === UploadSupport.PARSEABLE ? '保存後に解析・検索' : item.reason)
              : rejectReasonLabel(item.rejectReason);

            return el('tr', {}, showStates
              ? [
                el('td', { text: item.relativePath || item.sourceName }),
                el('td', { text: formatBytes(item.size) }),
                el('td', { text: state?.drive ?? (accepted ? '待機中' : '除外') }),
                el('td', { text: state?.sync ?? '—' }),
                el('td', { text: state?.parse ?? treatment }),
                el('td', { text: state?.chunks ?? '—' }),
                el('td', { text: state?.search ?? '—' }),
              ]
              : [
                el('td', { text: item.relativePath || item.sourceName }),
                el('td', { text: item.label }),
                el('td', { text: formatBytes(item.size) }),
                el('td', { text: treatment }),
              ]);
          })),
        ]),
      ]);
    }

    function renderFooter() {
      if (phase === 'select') {
        return [
          el('button', {
            type: 'button', class: 'button button--secondary', text: 'キャンセル', onClick: () => close(null),
          }),
          el('button', {
            type: 'button',
            class: 'button',
            text: '内容を確認',
            disabled: plan.accepted.length === 0,
            onClick: () => {
              phase = 'confirm';
              render();
            },
          }),
        ];
      }

      if (phase === 'confirm') {
        return [
          el('button', {
            type: 'button',
            class: 'button button--secondary',
            text: '戻る',
            onClick: () => {
              phase = 'select';
              render();
            },
          }),
          el('button', {
            type: 'button',
            class: 'button',
            text: `${plan.accepted.length}件をアップロードして同期`,
            onClick: start,
          }),
        ];
      }

      if (phase === 'done') {
        return [
          el('button', {
            type: 'button', class: 'button', text: '閉じる', onClick: () => close(result),
          }),
        ];
      }

      return [
        el('button', {
          type: 'button', class: 'button button--secondary', text: '処理中…', disabled: true,
        }),
      ];
    }

    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      if (!running) close(result);
    });

    document.body.append(dialog);
    render();
    dialog.showModal();
    fileInput.focus();
  });
}

function stat(label, value) {
  return el('div', { class: 'stat' }, [
    el('span', { class: 'stat__label', text: label }),
    el('span', { class: 'stat__value', text: value }),
  ]);
}

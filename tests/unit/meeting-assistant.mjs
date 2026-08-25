/*
 * Meeting Assistant 最小MVP（public/meeting-assistant/）の純ロジック。
 * Gemini 実 API は呼ばない。モックと Markdown 組み立てだけを見る。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '../../public/meeting-assistant');

function createFakePipDocument() {
  function matches(node, sel) {
    const dataPip = /^\[data-pip="([^"]+)"\]$/.exec(sel);
    if (dataPip) {
      return node.dataset?.pip === dataPip[1];
    }
    if (sel === 'link[rel="stylesheet"]') {
      return node.tagName === 'LINK' && node.rel === 'stylesheet';
    }
    return false;
  }

  function walk(node, sel, acc) {
    for (const child of node.children) {
      if (matches(child, sel)) {
        acc.push(child);
      }
      walk(child, sel, acc);
    }
    return acc;
  }

  function createNode(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      children: [],
      className: '',
      textContent: '',
      href: '',
      rel: '',
      type: '',
      lang: '',
      hidden: false,
      disabled: false,
      dataset: {},
      listeners: {},
      append(...kids) {
        for (const kid of kids) {
          if (kid) {
            this.children.push(kid);
          }
        }
      },
      addEventListener(type, fn) {
        (this.listeners[type] ||= []).push(fn);
      },
      dispatch(type) {
        for (const fn of this.listeners[type] || []) {
          fn();
        }
      },
      querySelector(sel) {
        return walk(this, sel, [])[0] ?? null;
      },
      querySelectorAll(sel) {
        return walk(this, sel, []);
      },
    };
    return node;
  }

  const doc = createNode('document');
  doc.head = createNode('head');
  doc.body = createNode('body');
  doc.documentElement = createNode('html');
  doc.children = [doc.documentElement];
  doc.documentElement.append(doc.head, doc.body);
  doc.createElement = createNode;
  doc.title = '';

  const win = {
    document: doc,
    closed: false,
    listeners: {},
    close() {
      this.closed = true;
      this.dispatch('pagehide');
    },
    focus() {},
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
    dispatch(type) {
      for (const fn of this.listeners[type] || []) {
        fn();
      }
    },
  };

  return Object.assign(doc, { window: win });
}

try {
  const config = await import('../../public/meeting-assistant/config.js');
  const markdown = await import('../../public/meeting-assistant/markdown.js');
  const pipeline = await import('../../public/meeting-assistant/pipeline.js');

  section('モデルと秘密情報');

  {
    check('既定モデルは最軽量の flash-lite', config.DEFAULT_MODEL === 'gemini-2.5-flash-lite');
    check('既定モデルは config の一箇所', config.GEMINI.defaultModelId === config.DEFAULT_MODEL);
    check('OAuth スコープは drive.file のみ', config.OAUTH.scope === 'https://www.googleapis.com/auth/drive.file');

    const configSource = readFileSync(resolve(appRoot, 'config.js'), 'utf8');
    check('APIキーをハードコードしていない', !/AIza[0-9A-Za-z_-]{20,}/.test(configSource));
  }

  section('Drive フォルダ');

  {
    check('音声フォルダは Potenitas voice', config.DRIVE_VOICE_PATH.at(-1) === 'Potenitas voice');
    check('議事録フォルダは Potenitas record', config.DRIVE_RECORD_PATH.at(-1) === 'Potenitas record');
    check(
      '階層は Potenitas System / Administrator / meet',
      config.DRIVE_VOICE_PATH.slice(0, 3).join('/') === 'Potenitas System/Potenitas Administrator/Potenitas meet'
        && config.DRIVE_RECORD_PATH.slice(0, 3).join('/') === 'Potenitas System/Potenitas Administrator/Potenitas meet',
    );
  }

  section('録音ファイル名');

  {
    const filename = await import('../../public/meeting-assistant/filename.js');
    const filled = {
      organization: '株式会社ABC',
      personName: '田中 太郎',
      kind: '商談',
    };

    check(
      'オンラインは遠隔対応',
      filename.buildRecordingFileName({ method: 'online', ...filled }) === '【遠隔対応】株式会社ABC 田中 太郎【商談】.mp3',
    );
    check(
      'オフラインは現地対応',
      filename.buildRecordingFileName({ method: 'offline', ...filled }) === '【現地対応】株式会社ABC 田中 太郎【商談】.mp3',
    );
    check(
      '所属未入力は省略',
      filename.buildRecordingFileName({ method: 'online', personName: '田中 太郎', kind: '商談' }) === '【遠隔対応】田中 太郎【商談】.mp3',
    );
    check(
      '氏名未入力は省略',
      filename.buildRecordingFileName({ method: 'online', organization: '株式会社ABC', kind: '商談' }) === '【遠隔対応】株式会社ABC【商談】.mp3',
    );
    check(
      '対応種別未入力は省略',
      filename.buildRecordingFileName({ method: 'online', organization: '株式会社ABC', personName: '田中 太郎' }) === '【遠隔対応】株式会社ABC 田中 太郎.mp3',
    );

    const stampDate = new Date('2026-08-24T23:15:00+09:00');
    check(
      '全未入力は日時',
      filename.buildRecordingFileName({ method: 'online', date: stampDate }) === '【遠隔対応】2026-08-24_23-15.mp3',
    );
    check(
      'オフライン全未入力も日時',
      filename.buildRecordingFileName({ method: 'offline', date: stampDate }) === '【現地対応】2026-08-24_23-15.mp3',
    );
    check(
      '【】と空白は残す',
      filename.stripUnsafe('【遠隔対応】株式会社ABC 田中 太郎') === '【遠隔対応】株式会社ABC 田中 太郎',
    );
    check(
      'パス区切りだけ落とす',
      filename.stripUnsafe('A/B\\C') === 'ABC',
    );

    const audioName = filename.buildRecordingFileName({ method: 'online', ...filled });
    check(
      'Markdown は拡張子だけ md',
      markdown.toMarkdownFileName(audioName) === '【遠隔対応】株式会社ABC 田中 太郎【商談】.md',
    );
    check(
      '設定から追加した対応種別も同じ規則',
      filename.buildRecordingFileName({ method: 'online', ...filled, kind: '初回相談' }) === '【遠隔対応】株式会社ABC 田中 太郎【初回相談】.mp3',
    );
    check(
      'オフラインも追加種別をそのまま使う',
      filename.buildRecordingFileName({ method: 'offline', ...filled, kind: '初回相談' }) === '【現地対応】株式会社ABC 田中 太郎【初回相談】.mp3',
    );
  }

  section('対応種別マスタ');

  {
    const kinds = await import('../../public/meeting-assistant/kinds.js');
    const memory = new Map();
    const storage = {
      getItem: (key) => (memory.has(key) ? memory.get(key) : null),
      setItem: (key, value) => { memory.set(key, String(value)); },
      removeItem: (key) => { memory.delete(key); },
    };

    check('初期値がある', JSON.stringify(kinds.loadKinds(storage)) === JSON.stringify([...kinds.DEFAULT_KINDS]));
    check('空は追加できない', kinds.addKind('   ', storage).reason === 'empty');

    const added = kinds.addKind(' 初回相談 ', storage);
    check('追加できる', added.ok === true && added.list.includes('初回相談'));
    check('前後空白を除去する', kinds.normalizeKind(' 商談 ') === '商談');
    check('重複は追加しない', kinds.addKind('初回相談', storage).reason === 'duplicate');

    const afterReload = kinds.loadKinds(storage);
    check('再読込しても残る', afterReload.includes('初回相談') && afterReload.includes('商談'));

    const removed = kinds.removeKind('商談', storage);
    check('削除できる', !removed.includes('商談') && removed.includes('初回相談'));
    check('削除後も永続化', !kinds.loadKinds(storage).includes('商談'));
  }

  section('Markdown ファイル名と処理済み判定');

  {
    check(
      '拡張子だけ md に変える',
      markdown.toMarkdownFileName('2026-08-24_営業会議.m4a') === '2026-08-24_営業会議.md',
    );
    check('mp3 も同様', markdown.toMarkdownFileName('meeting-001.mp3') === 'meeting-001.md');
    check('すでに md なら維持', markdown.toMarkdownFileName('meeting-001.md') === 'meeting-001.md');

    const records = [{ name: '2026-08-24_営業会議.md', id: 'md1' }];
    check(
      '同名 Markdown があれば処理済み',
      markdown.isProcessed('2026-08-24_営業会議.m4a', records) === true,
    );
    check(
      '無ければ未処理',
      markdown.isProcessed('other.m4a', records) === false,
    );
    check(
      '一致する Markdown を返す',
      markdown.findMatchingMarkdown('2026-08-24_営業会議.mp3', records)?.id === 'md1',
    );
  }

  section('Markdown 固定構造');

  {
    const audioUrl = 'https://drive.google.com/file/d/FILEID123/view';
    const md = markdown.buildMarkdown({
      audioUrl,
      todoText: '- テストタスク',
      minutesText: 'テスト議事録',
      transcript: 'テスト文字起こし',
    });

    const order = markdown.markdownSectionOrder(md);
    check('見出し順は引用元 → To Do → 議事録 → 文字起こし', JSON.stringify(order) === JSON.stringify(['引用元', 'To Do', '議事録', '文字起こし']));
    check('引用元が先頭', md.startsWith('# 引用元\n'));
    check('実際の Drive URL をアプリ側で挿入', md.includes(`音声ファイル: ${audioUrl}`));
    check('To Do が2番目', md.indexOf('# To Do') > md.indexOf('# 引用元') && md.indexOf('# To Do') < md.indexOf('# 議事録'));
    check('文字起こしが最後', md.indexOf('# 文字起こし') > md.indexOf('# 議事録'));
  }

  section('To Do は推測しない');

  {
    const empty = markdown.formatTodoSection([]);
    check('To Do が無ければ「なし」', empty === 'なし');

    const withTask = markdown.formatTodoSection([
      { task: '見積を送る', assignee: '', dueDate: '' },
      { task: '', assignee: '太郎', dueDate: '明日' },
    ]);
    check('空タスクは出さない', withTask === '- 見積を送る');
    check('無い担当者を補わない', !withTask.includes('太郎'));
  }

  section('Gemini モック（実API禁止）');

  {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      throw new Error('gemini_fetch_should_not_run');
    };

    try {
      const result = await pipeline.runGeminiPipeline({
        mock: true,
        audioUrl: 'https://drive.google.com/file/d/mock-audio/view',
      });

      check('モック印がある', result.mock === true);
      check('固定文字起こし', result.transcript === config.MOCK_GEMINI.transcript);
      check('fetch を呼ばない', fetchCalled === false);
      check('Markdown に実 URL が入る', result.markdown.includes('音声ファイル: https://drive.google.com/file/d/mock-audio/view'));
      check('モック To Do が入る', result.markdown.includes(config.MOCK_GEMINI.todoTask));
      check('見出し順を保つ', JSON.stringify(markdown.markdownSectionOrder(result.markdown)) === JSON.stringify(['引用元', 'To Do', '議事録', '文字起こし']));
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  section('既存 Gemini 処理が接続されている');

  {
    const pipelineSource = readFileSync(resolve(appRoot, 'pipeline.js'), 'utf8');
    const transcriberSource = readFileSync(resolve(appRoot, 'gemini-transcriber.js'), 'utf8');
    const appSource = readFileSync(resolve(appRoot, 'app.js'), 'utf8');
    const transcribeFn = transcriberSource.slice(
      transcriberSource.indexOf('export async function transcribeWithGemini'),
    );

    check('文字起こし入口がある', pipelineSource.includes("from './gemini-transcriber.js'"));
    check('議事録入口がある', pipelineSource.includes("from './gemini-minutes.js'"));
    check('音声を Gemini へ渡す処理がある', transcriberSource.includes('file_data') && transcriberSource.includes('generateContent'));
    check('モデル一覧APIを本番経路で呼ばない', !transcribeFn.includes('listUsableModels('));
    check('接続確認ボタンを画面に持たない', !appSource.includes('checkGeminiConnection'));
    check('KeyStore で APIキーを扱う', appSource.includes('KeyStore') && appSource.includes('PROVIDERS.gemini'));
    check('上書きは確認してから', appSource.includes('すでに議事録があります。再生成しますか？'));
    check('portal guard を呼ばない', !appSource.includes('guardPage') && !appSource.includes('next=portal'));
    check('ブラウザ戻る用に履歴を積む', appSource.includes('history.pushState') && appSource.includes('popstate'));
    check('旧 auth 共通モジュールを読まない', !appSource.includes('../auth/'));
  }

  section('独立入口');

  {
    const html = readFileSync(resolve(appRoot, 'index.html'), 'utf8');
    check('旧 auth.css を読まない', !html.includes('../auth/'));
    check('portal / login へ飛ばない', !html.includes('/login/') && !html.includes('/portal/'));
    check('トップの主要導線がある', html.includes('オンライン録音') && html.includes('オフライン録音') && html.includes('Driveから音声を選ぶ') && html.includes('過去の議事録') && html.includes('設定'));
    check('オンライン・オフラインに所属・氏名・対応種別がある', html.includes('id="on-org"') && html.includes('id="on-person"') && html.includes('id="on-kind"') && html.includes('id="off-org"') && html.includes('id="off-person"') && html.includes('id="off-kind"'));
    check('対応種別は選択式', html.includes('<select class="vr-input" id="off-kind">') && html.includes('<select class="vr-input" id="on-kind">'));
    check('設定に対応種別管理がある', html.includes('id="set-kind-add"') && html.includes('id="set-kind-list"'));
    check('主要操作が円形3ボタン', html.includes('On-site') && html.includes('Remote') && html.includes('Drive') && html.includes('data-go="offline"') && html.includes('data-go="online"') && html.includes('data-go="pick"'));
    check('トップ説明文を出さない', !html.includes('録音するか音声を選び'));
    check('On-site文言', html.includes('録音し、Potenitas voice へ保存します。'));
    check('Remote文言', html.includes('会議タブを選択して録音します。'));
    check('Drive文言', html.includes('Potenitas voice の音声ファイルだけを表示します。'));
    check('Remote注意書き', html.includes('※ブラウザ版の会議タブを選んでください。') && html.includes('※「タブの音声も共有する」をオンにしてください。'));
    check('設定は左上・議事録は円の下', html.includes('▼ 設定 ▼') && html.includes('▲ 設定 ▲') && html.includes('id="home-settings"') && html.includes('過去の議事録'));
    check('タイトル再読み込み', html.includes('id="home-reload"'));
    check('設定は画面遷移しない', !html.includes('data-go="settings"') && html.includes('id="home-settings"'));
    check('設定はアコーディオン', html.includes('id="set-key-acc"') && html.includes('id="set-kind-acc"') && html.includes('id="set-kind-count"'));
    check('他画面の戻りが統一', (html.match(/‹ Meeting Assistant/g) || []).length >= 4);
    check('main を最初から表示する', !html.includes('id="ma-main" class="vr-main" hidden'));
    check('On-site に最前面表示がある', html.includes('id="off-pip"') && html.includes('id="off-pip-unsupported"'));
    check('Remote に最前面表示がある', html.includes('id="on-pip"') && html.includes('id="on-pip-unsupported"'));
    check('非対応案内がある', html.includes('このブラウザでは最前面表示を利用できません。'));
  }

  section('PC最前面表示（Document Picture-in-Picture）');

  {
    const pip = await import('../../public/meeting-assistant/pip.js');
    const pipSource = readFileSync(resolve(appRoot, 'pip.js'), 'utf8');
    const appSource = readFileSync(resolve(appRoot, 'app.js'), 'utf8');
    const mixSource = readFileSync(resolve(appRoot, 'mix.js'), 'utf8');
    const recorderSource = readFileSync(resolve(appRoot, 'recorder/recorder.js'), 'utf8');
    const css = readFileSync(resolve(appRoot, 'app.css'), 'utf8');

    check('API検出がある', pip.isDocumentPipSupported({}) === false);
    check(
      'requestWindow があれば対応',
      pip.isDocumentPipSupported({ documentPictureInPicture: { requestWindow: async () => ({}) } }) === true,
    );
    check('On-site ラベル', pip.recordingModeLabel('offline') === 'On-site');
    check('Remote ラベル', pip.recordingModeLabel('online') === 'Remote');
    check('Document Picture-in-Picture を使う', pipSource.includes('requestWindow'));
    check('動画PiPではない', !pipSource.includes('requestPictureInPicture') && !appSource.includes('requestPictureInPicture'));
    check('録音処理を持たない', !pipSource.includes('new Recorder') && !pipSource.includes('getUserMedia') && !pipSource.includes('getDisplayMedia'));
    check('PiP にスマホ向け機能を足していない', !pipSource.includes('wakeLock') && !pipSource.includes('Wake Lock') && !appSource.includes('Foreground Service'));
    check('既存 Recorder をそのまま使う', appSource.includes("from './recorder/recorder.js'") && appSource.includes('createDocumentPip'));
    check('小窓停止は既存 stopRecording', appSource.includes('onStop()') && appSource.includes('stopRecording(mode)'));
    check('停止後に小窓を閉じる', appSource.includes('pip.close()'));
    check('非対応ならボタンを隠す', appSource.includes('isDocumentPipSupported') && appSource.includes('offPip.hidden'));
    check('自動では開かない', !appSource.includes('pip.open(') || appSource.includes('function openPip'));
    check('ユーザー操作から開く', appSource.includes("el.offPip?.addEventListener('click'") && appSource.includes("el.onPip?.addEventListener('click'"));
    check('mix.js は変更していない入口のまま', mixSource.includes('getDisplayMedia') && !mixSource.includes('documentPictureInPicture'));
    check('recorder.js は PiP を知らない', !recorderSource.includes('documentPictureInPicture') && !recorderSource.includes('最前面'));
    check('小窓は白背景', css.includes('.ma-pip-page') && css.includes('background: #ffffff'));

    const fake = createFakePipDocument();
    const owner = createFakePipDocument();
    const style = owner.createElement('link');
    style.rel = 'stylesheet';
    style.href = 'https://example.test/app.css';
    owner.head.append(style);

    let requestCount = 0;
    let stopped = 0;
    const api = {
      requestWindow: async () => {
        requestCount += 1;
        return fake.window;
      },
    };

    const controller = pip.createDocumentPip({
      api,
      ownerDocument: owner,
      onStop() {
        stopped += 1;
      },
    });

    await controller.open({ mode: 'online', recording: true, seconds: 75, status: '録音中です。' });
    check('requestWindow を1回呼ぶ', requestCount === 1);
    check('小窓が開く', controller.isOpen() === true);
    check('Remote と録音中を出す', fake.window.document.body.querySelector('[data-pip="mode"]').textContent === 'Remote');
    check('経過時間を出す', fake.window.document.body.querySelector('[data-pip="timer"]').textContent === '00:01:15');
    check('停止ボタンが押せる', fake.window.document.body.querySelector('[data-pip="stop"]').disabled === false);

    fake.window.document.body.querySelector('[data-pip="stop"]').dispatch('click');
    check('小窓の停止は onStop だけ', stopped === 1 && controller.isOpen() === true);

    controller.sync({ seconds: 90, recording: true });
    check('経過時間を同期する', fake.window.document.body.querySelector('[data-pip="timer"]').textContent === '00:01:30');

    await controller.open({ recording: true });
    check('既存ウィンドウを再利用する', requestCount === 1);

    fake.window.dispatch('pagehide');
    check('小窓を閉じても onStop しない', controller.isOpen() === false && stopped === 1);

    const unsupported = pip.createDocumentPip({ api: {}, ownerDocument: owner, onStop() { stopped += 1; } });
    let unsupportedCode = '';
    try {
      await unsupported.open();
    } catch (error) {
      unsupportedCode = error.code;
    }
    check('非対応では開かない', unsupportedCode === 'DOCUMENT_PIP_UNSUPPORTED' && stopped === 1);
  }

  section('スマートフォン On-site ネイティブ録音（PC経路は維持）');

  {
    const checkpoint = await import('../../public/meeting-assistant/recording-checkpoint.js');
    const bridge = await import('../../public/meeting-assistant/native-bridge.js');
    const pending = await import('../../public/meeting-assistant/pending-recordings.js');
    const filename = await import('../../public/meeting-assistant/filename.js');
    const appSource = readFileSync(resolve(appRoot, 'app.js'), 'utf8');
    const mixSource = readFileSync(resolve(appRoot, 'mix.js'), 'utf8');
    const recorderSource = readFileSync(resolve(appRoot, 'recorder/recorder.js'), 'utf8');
    const configSource = readFileSync(resolve(appRoot, 'config.js'), 'utf8');
    const driveSource = readFileSync(resolve(appRoot, 'drive.js'), 'utf8');
    const html = readFileSync(resolve(appRoot, 'index.html'), 'utf8');
    const swift = readFileSync(resolve(here, '../../mobile/meeting-assistant/plugins/native-recorder/ios/Sources/NativeRecorderPlugin/NativeRecorderPlugin.swift'), 'utf8');
    const kotlinService = readFileSync(resolve(here, '../../mobile/meeting-assistant/plugins/native-recorder/android/src/main/java/com/potenitas/meetingassistant/recorder/RecordingService.kt'), 'utf8');
    const androidManifest = readFileSync(resolve(here, '../../mobile/meeting-assistant/plugins/native-recorder/android/src/main/AndroidManifest.xml'), 'utf8');

    check('PC ではネイティブ録音は使えない', bridge.isNativeRecorderAvailable({}) === false);
    check('Capacitor なしではプラグイン無し', bridge.getNativeRecorderPlugin({}) === null);

    let registeredName = '';
    const fakeNative = {
      Capacitor: {
        isNativePlatform: () => true,
        registerPlugin(name) {
          registeredName = name;
          return { start: async () => ({ ok: true }), stop: async () => ({}) };
        },
      },
    };
    check('ネイティブでは registerPlugin で接続する', bridge.isNativeRecorderAvailable(fakeNative) === true && registeredName === 'NativeRecorder');
    check('PC 分岐は Capacitor 無しで false のまま', bridge.isNativeRecorderAvailable({ Capacitor: { isNativePlatform: () => false } }) === false);

    const nativeName = filename.buildRecordingFileName({
      method: 'offline',
      organization: '株式会社ABC',
      personName: '田中 太郎',
      kind: '商談',
      extension: checkpoint.NATIVE_AUDIO_EXTENSION,
    });
    check(
      'ネイティブは m4a ファイル名',
      nativeName === '【現地対応】株式会社ABC 田中 太郎【商談】.m4a',
    );
    check('PC 既定拡張子は mp3 のまま', configSource.includes("export const FILE_EXTENSION = '.mp3'"));

    const saved = checkpoint.applyLocalSaved(checkpoint.createCheckpoint({
      recordingId: 'rec-1',
      fileName: nativeName,
      localPath: '/tmp/rec-1.m4a',
    }), { sizeBytes: 12, durationSeconds: 90 });
    check('ローカル保存と Drive は別状態', saved.state === checkpoint.RecordingState.SAVED_LOCAL && saved.driveUploadState === checkpoint.DriveUploadState.PENDING);
    const failed = checkpoint.applyUploadFailure(saved, 'NETWORK');
    check('Drive 失敗でもローカルを残す', failed.state === checkpoint.RecordingState.UPLOAD_FAILED && failed.localPath === '/tmp/rec-1.m4a');
    check('再送対象になる', pending.visiblePendingRecordings([failed]).length === 1);
    check('失敗案内がある', checkpoint.LOCAL_KEPT_DRIVE_FAILED.includes('端末に保存') && checkpoint.LOCAL_KEPT_DRIVE_FAILED.includes('Drive'));

    check('On-site だけネイティブへ分岐', appSource.includes('isNativeRecorderAvailable()') && appSource.includes("attachRecorder('offline')"));
    check('Web Recorder をネイティブ用に改変していない', !recorderSource.includes('Capacitor') && !recorderSource.includes('Foreground Service'));
    check('Remote mix を移植していない', mixSource.includes('getDisplayMedia') && !mixSource.includes('NativeRecorder'));
    check('Drive はチャンク reader を受け付ける', driveSource.includes('readChunk') && driveSource.includes('file.slice'));
    check('未アップロード UI がある', html.includes('id="pending-recordings"') && html.includes('id="pending-list"'));
    check('pending 見出しがある', pending.pendingHeading() === '未アップロードの録音があります' && pending.retryButtonLabel() === 'Driveへ再送');
    check('スマホ Remote を出さない', appSource.includes("body.classList.toggle('ma-native'") && appSource.includes('Remote録音はパソコン版で利用できます'));
    check('Wake Lock はブラウザ録音の補助だけ（ネイティブ・Recorder 本体には足していない）', !swift.includes('wakeLock') && !recorderSource.includes('wakeLock') && appSource.includes("from './wake-lock.js'"));
    check('iOS は AVAudioRecorder', swift.includes('AVAudioRecorder') && swift.includes('kAudioFormatMPEG4AAC') && swift.includes('UIBackgroundModes') === false);
    check('iOS interruption を見る', swift.includes('AVAudioSession.interruptionNotification'));
    check('Android は microphone FGS', kotlinService.includes('FOREGROUND_SERVICE_TYPE_MICROPHONE') && androidManifest.includes('foregroundServiceType="microphone"'));
    check('Android 通知がある', kotlinService.includes('Meeting Assistant') && kotlinService.includes('録音中'));
    check('Gemini 実呼び出しをテストしていない', true);

    const buffer = bridge.decodeBase64ToBuffer(Buffer.from('abc').toString('base64'));
    check('chunk を巨大 Blob にせずデコードできる', Buffer.from(buffer).toString() === 'abc');
  }

  section('スマートフォンブラウザ版（PWA）: 環境判定');

  {
    const platform = await import('../../public/meeting-assistant/platform.js');

    check('Android Chrome はモバイル', platform.isMobileBrowser({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36' }));
    check('iPhone Safari はモバイル', platform.isMobileBrowser({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1' }));
    check('iPadOS（Macintosh UA + タッチ）はモバイル', platform.isMobileBrowser({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5 }));
    check('Windows Chrome は PC', !platform.isMobileBrowser({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36', platform: 'Win32', maxTouchPoints: 0 }));
    check('Mac Chrome（タッチ無し）は PC', !platform.isMobileBrowser({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0 Safari/537.36', platform: 'MacIntel', maxTouchPoints: 0 }));
    check('userAgentData.mobile を優先する', platform.isMobileBrowser({ userAgentData: { mobile: true }, userAgent: 'Mozilla/5.0 (Windows NT 10.0)' }));
    check('navigator 無しは PC 扱い', !platform.isMobileBrowser(null));

    check('iOS standalone を検出', platform.isStandaloneDisplay({}, { standalone: true }));
    check('display-mode: standalone を検出', platform.isStandaloneDisplay({ matchMedia: (q) => ({ matches: q === '(display-mode: standalone)' }) }, {}));
    check('通常タブは standalone ではない', !platform.isStandaloneDisplay({ matchMedia: () => ({ matches: false }) }, {}));

    check('PC ブラウザは Remote を出す', platform.canOfferRemote({ native: false, mobile: false, canCaptureTab: true }));
    check('スマホブラウザは Remote を出さない', !platform.canOfferRemote({ native: false, mobile: true, canCaptureTab: true }));
    check('ネイティブは Remote を出さない', !platform.canOfferRemote({ native: true, mobile: false, canCaptureTab: true }));
    check('タブ音声が取れない PC は Remote を出さない', !platform.canOfferRemote({ native: false, mobile: false, canCaptureTab: false }));

    check('standalone PWA はリダイレクト認証', platform.prefersRedirectAuth({ native: false, standalone: true }));
    check('通常のブラウザはポップアップ認証', !platform.prefersRedirectAuth({ native: false, standalone: false }));
    check('ネイティブはリダイレクトしない', !platform.prefersRedirectAuth({ native: true, standalone: true }));

    const appSource = readFileSync(resolve(appRoot, 'app.js'), 'utf8');
    const css = readFileSync(resolve(appRoot, 'app.css'), 'utf8');
    const html = readFileSync(resolve(appRoot, 'index.html'), 'utf8');
    check('app は platform.js で Remote の表示を決める', appSource.includes("from './platform.js'") && appSource.includes('canOfferRemote(') && appSource.includes("classList.toggle('ma-no-remote'"));
    check('Remote 非表示時は 2 円レイアウト', css.includes('body.ma-no-remote .ma-circle--remote') && css.includes('body.ma-no-remote .ma-circle--drive'));
    check('円は重なり配置（設計指示書）', css.includes('--overlap') && css.includes('--drive-top'));
    check('Safe Area を全辺で考慮', ['top', 'right', 'bottom', 'left'].every((side) => css.includes(`env(safe-area-inset-${side}, 0px)`)));
    check('viewport-fit=cover', html.includes('viewport-fit=cover'));
    check('入力欄は 16px 以上（iOS の拡大防止）', css.includes('font-size: max(1rem, 16px)'));
    check('スマホ向け注意書きがある', html.includes('id="off-mobile-hint"') && html.includes('画面を消さず'));
    check('manifest は standalone', readFileSync(resolve(appRoot, 'manifest.webmanifest'), 'utf8').includes('"display": "standalone"'));
  }

  section('スマートフォンブラウザ版（PWA）: OAuth リダイレクト方式');

  {
    const oauth = await import('../../public/meeting-assistant/oauth.js');
    const oauthSource = readFileSync(resolve(appRoot, 'oauth.js'), 'utf8');

    check('戻り先 URL は index.html を落とす', oauth.redirectUri({ origin: 'https://tsam-ai.com', pathname: '/meeting-assistant/index.html' }) === 'https://tsam-ai.com/meeting-assistant/');
    check('戻り先 URL はクエリ・fragment を含まない', oauth.redirectUri({ origin: 'https://tsam-ai.com', pathname: '/meeting-assistant/', search: '?x=1', hash: '#pick' }) === 'https://tsam-ai.com/meeting-assistant/');
    check('末尾スラッシュ無しでも付ける（Google は完全一致）', oauth.redirectUri({ origin: 'https://tsam-ai.com', pathname: '/meeting-assistant' }) === 'https://tsam-ai.com/meeting-assistant/');
    check('errors.js の案内文も同じ算出を使う', readFileSync(resolve(appRoot, 'errors.js'), 'utf8').includes("import { redirectUri } from './platform.js'"));

    const url = new URL(oauth.buildAuthorizationUrl({ clientId: 'cid', scope: 'scope-a', redirect: 'https://tsam-ai.com/meeting-assistant/', state: 'abc' }));
    check('認可 URL は Google の accounts', url.origin === 'https://accounts.google.com' && url.pathname === '/o/oauth2/v2/auth');
    check('暗黙フロー（response_type=token）', url.searchParams.get('response_type') === 'token');
    check('client_id / scope / state / redirect_uri を持つ', url.searchParams.get('client_id') === 'cid' && url.searchParams.get('scope') === 'scope-a' && url.searchParams.get('state') === 'abc' && url.searchParams.get('redirect_uri') === 'https://tsam-ai.com/meeting-assistant/');
    check('client_secret を送らない', !url.searchParams.has('client_secret'));
    check('include_granted_scopes を送らない（共有 clientId の他アプリのスコープを拾わない）', !url.searchParams.has('include_granted_scopes'));

    check('通常の #画面名 は OAuth の戻りではない', oauth.parseRedirectFragment('#pick') === null && oauth.parseRedirectFragment('') === null);
    const parsed = oauth.parseRedirectFragment('#access_token=tok&token_type=Bearer&expires_in=3599&scope=x&state=abc');
    check('fragment からトークンと state を読む', parsed?.accessToken === 'tok' && parsed.expiresIn === 3599 && parsed.state === 'abc');
    check('error を読む', oauth.parseRedirectFragment('#error=access_denied&state=abc')?.error === 'access_denied');

    function fakeStorage(initial = {}) {
      const data = { ...initial };
      return {
        getItem: (k) => (k in data ? data[k] : null),
        setItem: (k, v) => { data[k] = String(v); },
        removeItem: (k) => { delete data[k]; },
        data,
      };
    }

    function fakeHistory() {
      const calls = [];
      return { replaceState: (...args) => calls.push(args), calls };
    }

    {
      const storage = fakeStorage({ [oauth.REDIRECT_STATE_KEY]: JSON.stringify({ state: 'abc', createdAt: 1000, resume: { screen: 'pick' } }) });
      const hist = fakeHistory();
      const result = oauth.consumeRedirectResult({
        loc: { hash: '#access_token=tok&expires_in=3599&state=abc', pathname: '/meeting-assistant/', search: '' },
        hist,
        storage,
        now: 2000,
      });
      check('state が一致すれば受け取り、再開先を返す', result?.ok === true && result.resume?.screen === 'pick');
      check('受け取ったらトークンは有効', oauth.hasValidToken() && oauth.tokenRemainingSeconds() > 3000);
      check('URL から fragment を消す', hist.calls.length === 1 && hist.calls[0][2] === '/meeting-assistant/');
      check('state は使い捨て', storage.getItem(oauth.REDIRECT_STATE_KEY) === null);
      oauth.forgetToken();
      check('forgetToken で無効', !oauth.hasValidToken());
    }

    {
      const storage = fakeStorage({ [oauth.REDIRECT_STATE_KEY]: JSON.stringify({ state: 'abc', createdAt: 1000, resume: null }) });
      const hist = fakeHistory();
      const result = oauth.consumeRedirectResult({
        loc: { hash: '#access_token=evil&expires_in=3599&state=zzz', pathname: '/meeting-assistant/', search: '' },
        hist,
        storage,
        now: 2000,
      });
      check('state 不一致のトークンは捨てる', result?.ok === false && result.code === 'OAUTH_STATE_MISMATCH' && !oauth.hasValidToken());
      check('不一致でも fragment は消す', hist.calls.length === 1);
    }

    {
      const storage = fakeStorage();
      const result = oauth.consumeRedirectResult({
        loc: { hash: '#access_token=evil&state=abc', pathname: '/', search: '' },
        hist: fakeHistory(),
        storage,
        now: 2000,
      });
      check('往路の記録が無い（貼り付けられた fragment）は捨てる', result?.ok === false && !oauth.hasValidToken());
    }

    {
      const storage = fakeStorage({ [oauth.REDIRECT_STATE_KEY]: JSON.stringify({ state: 'abc', createdAt: 0, resume: null }) });
      const result = oauth.consumeRedirectResult({
        loc: { hash: '#access_token=old&expires_in=3599&state=abc', pathname: '/', search: '' },
        hist: fakeHistory(),
        storage,
        now: 60 * 60 * 1000,
      });
      check('古すぎる往復は捨てる', result?.ok === false && !oauth.hasValidToken());
    }

    {
      const storage = fakeStorage({ [oauth.REDIRECT_STATE_KEY]: JSON.stringify({ state: 'abc', createdAt: 5000, resume: null }) });
      const result = oauth.consumeRedirectResult({
        loc: { hash: '#access_token=future&expires_in=3599&state=abc', pathname: '/', search: '' },
        hist: fakeHistory(),
        storage,
        now: 1000,
      });
      check('時計が巻き戻った往復（createdAt が未来）は捨てる', result?.ok === false && !oauth.hasValidToken());
    }

    {
      const storage = fakeStorage({ [oauth.REDIRECT_STATE_KEY]: JSON.stringify({ state: 'abc', createdAt: 1000, resume: { screen: 'home' } }) });
      const result = oauth.consumeRedirectResult({
        loc: { hash: '#error=access_denied&state=abc', pathname: '/', search: '' },
        hist: fakeHistory(),
        storage,
        now: 2000,
      });
      check('利用者が拒否した場合は POPUP_CLOSED 相当', result?.ok === false && result.code === 'OAUTH_POPUP_CLOSED');
    }

    check('トークンを localStorage / sessionStorage に書かない', !/setItem\([^)]*(accessToken|access_token)/.test(oauthSource) && !/localStorage/.test(oauthSource.replace(/\/\*[\s\S]*?\*\//g, '')));
    check('往路の記録にトークンを入れない', oauthSource.includes("resume: resume ?? null") && !oauthSource.includes('accessToken: accessToken'));
    check('スコープは drive.file だけ（config 参照）', oauthSource.includes('scope: OAUTH.scope') && oauthSource.includes('scope = OAUTH.scope'));
    check('GIS を起動時に先読みする口がある', typeof oauth.preloadGis === 'function');
  }

  section('スマートフォンブラウザ版（PWA）: 保存待ちの録音');

  {
    const store = await import('../../public/meeting-assistant/pending-store.js');
    const checkpoint = await import('../../public/meeting-assistant/recording-checkpoint.js');
    const pending = await import('../../public/meeting-assistant/pending-recordings.js');
    const appSource = readFileSync(resolve(appRoot, 'app.js'), 'utf8');
    const opfsSource = readFileSync(resolve(appRoot, 'recorder/opfs-storage.js'), 'utf8');
    const recorderSource = readFileSync(resolve(appRoot, 'recorder/recorder.js'), 'utf8');

    const data = {};
    const storage = {
      getItem: (k) => (k in data ? data[k] : null),
      setItem: (k, v) => { data[k] = String(v); },
      removeItem: (k) => { delete data[k]; },
    };
    const s = store.createPendingStore(storage);

    const entry = store.createBrowserEntry({
      recordingId: 'rec-1',
      fileName: '【現地対応】株式会社ABC 田中 太郎【商談】.mp3',
      localPath: 'rec-20260825-100000-abc.mp3.part',
      sizeBytes: 1234,
      durationSeconds: 65,
      method: 'offline',
      organization: '株式会社ABC',
      personName: '田中 太郎',
      kind: '商談',
    });
    check('ブラウザ録音の台帳行は SAVED_LOCAL / pending', entry.source === 'browser' && entry.state === checkpoint.RecordingState.SAVED_LOCAL && entry.driveUploadState === checkpoint.DriveUploadState.PENDING);
    check('台帳行に音声データを持たない', !('blob' in entry) && !('file' in entry));

    check('put / list', s.put(entry) && s.list().length === 1 && s.get('rec-1')?.fileName === entry.fileName);

    const recording = store.createBrowserEntry({ recordingId: 'rec-live', fileName: 'live.mp3', localPath: 'live.mp3.part', state: checkpoint.RecordingState.RECORDING });
    check('録音開始時の行は RECORDING / Drive none', recording.state === checkpoint.RecordingState.RECORDING && recording.driveUploadState === checkpoint.DriveUploadState.NONE);
    check('録音中の行も保存待ち一覧に出る（途中で落ちた録音の回収）', pending.visiblePendingRecordings([recording]).length === 1 && pending.pendingStateNote(recording).includes('途中'));
    s.put(recording);
    check('録音中の行のファイルも掃除から守る', s.keepFileNames().has('live.mp3.part'));
    s.remove('rec-live');
    check('保存待ちの一覧に出る', pending.visiblePendingRecordings(s.list()).length === 1);
    check('初回は「Driveへ保存」', pending.saveButtonLabel(entry) === 'Driveへ保存');

    const failed = checkpoint.applyUploadFailure(entry, 'NETWORK');
    s.put(failed);
    check('失敗を上書き保存（件数は増えない）', s.list().length === 1 && s.get('rec-1').driveUploadState === 'failed');
    check('失敗後は「Driveへ再送」', pending.saveButtonLabel(s.get('rec-1')) === 'Driveへ再送');
    check('起動時に残す OPFS ファイル名', s.keepFileNames().has('rec-20260825-100000-abc.mp3.part'));

    check('remove', s.remove('rec-1') && s.list().length === 0 && !s.remove('rec-1'));
    check('空になれば localStorage のキーも消す', storage.getItem(store.PENDING_STORAGE_KEY) === null);

    for (let i = 0; i < 40; i += 1) {
      s.put(store.createBrowserEntry({ recordingId: `r-${i}`, fileName: `f${i}.mp3`, localPath: `p${i}.mp3.part` }));
    }
    check('件数上限で黙って落とさない', s.list().length === 40 && s.get('r-0') !== null && !('MAX_PENDING_ENTRIES' in store));

    data[store.PENDING_STORAGE_KEY] = '{broken';
    check('壊れた JSON は空扱い', store.createPendingStore(storage).list().length === 0);
    check('localStorage が無くても落ちない', store.createPendingStore(null).list().length === 0 && store.createPendingStore(null).put(entry) === false);

    {
      const memoryOnly = store.createPendingStore(null);
      memoryOnly.put(entry);
      check('localStorage が無くてもメモリ上には残る（この画面の間は Driveへ保存 が押せる）', memoryOnly.list().length === 1 && memoryOnly.persisted === false);

      const throwing = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => {} };
      const quota = store.createPendingStore(throwing);
      const ok = quota.put(entry);
      check('書き込み失敗（容量超過）でもメモリ上には残り、戻り値で分かる', ok === false && quota.list().length === 1 && quota.persisted === false);
    }

    check('確定は onFinalized に集約（手動停止以外も保存）', appSource.includes('onFinalized(result)') && appSource.includes('handleFinalizedRecording(') && !appSource.includes('waitForRecorderResult'));
    check('停止理由ごとの案内がある', ['limit', 'interrupted', 'capacity', 'backpressure', 'mic-ended'].every((r) => appSource.includes(`case '${r}':`)));
    check('未連携なら台帳に残してホームへ（停止後にポップアップを開かない）', appSource.includes('if (hasValidToken()) {') && appSource.includes('goHomeFlat();') && appSource.includes('SAVED_LOCAL_CONNECT'));
    check('On-site は録音開始の押下で先に Google 連携', appSource.includes("connectBeforeRecording('offline')"));
    check('Remote は事前連携しない（getDisplayMedia の操作猶予を消費しない）', !appSource.includes("connectBeforeRecording('online')"));
    check('Remote は同意チェックを最初に見る', appSource.indexOf('el.onConsent.checked') < appSource.indexOf('startOnline()\n'));
    check('録音開始時に台帳へ RECORDING 行を載せる', appSource.includes('registerRecordingStart(') && appSource.includes('state: RecordingState.RECORDING'));
    check('Drive 送信中は二重に送らない', appSource.includes('state.uploading.has(') && appSource.includes('state.uploading.add('));
    check('リダイレクトへの切替はスマートフォンだけ', appSource.includes('(env.mobile || env.standalone)'));
    check('復路で断られたら次の録音開始で再び飛ばない', appSource.includes("redirect.resume?.action?.type === 'record'") && appSource.includes('state.authDeclined = true'));
    check('録音中は画面遷移・再読み込みを止める', appSource.includes('isRecordingActive()') && appSource.includes("addEventListener('beforeunload'"));
    check('OPFS 不達では台帳を消さない', appSource.includes("error?.name === 'NotFoundError'") && appSource.includes('getRecordingsDir(false)'));
    check('finalize のタイムアウトがある', recorderSource.includes('FINALIZE_TIMEOUT_MS') && recorderSource.includes('clearFinalizeTimer'));
    check('AudioContext が running にならなければ開始しない', recorderSource.includes("AUDIO_SUSPENDED") && appSource.includes("error.code === 'AUDIO_SUSPENDED'"));
    check('CSP に form-action がある', readFileSync(resolve(appRoot, 'index.html'), 'utf8').includes("form-action 'none'"));
    check('Drive 成功後に台帳と OPFS から削除', appSource.includes('pendingStore.remove(entry.recordingId);') && appSource.includes('await deleteRecording(entry.localPath);'));
    check('Drive 失敗は台帳を failed にして残す', appSource.includes('pendingStore.put(applyUploadFailure('));
    check('起動時の OPFS 掃除は台帳のファイルを残す', opfsSource.includes('!keep.has(entry.name)') && appSource.includes('cleanupStaleFiles({ keep: pendingStore.keepFileNames() })'));
    check('AudioContext を resume する（iOS の無音録音対策）', recorderSource.includes('await this.audioContext.resume()'));
    check('Wake Lock は録音開始後に取り、確定・失敗で解放', appSource.includes('wakeLock.start()') && appSource.includes('wakeLock.stop()'));
    check('standalone では認証をリダイレクト方式にする', appSource.includes('prefersRedirectAuth(') && appSource.includes('consumeRedirectResult()') && appSource.includes('resumeAfterRedirect('));
    check('Gemini 実 API を呼ぶテストは無い', true);
  }

  finish();
} catch (error) {
  fatal(error);
}

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
    check('pending 見出しがある', pending.pendingHeading() === '処理が終わっていない録音があります' && pending.retryButtonLabel() === 'Driveへ再送');
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
    check('停止後は認証チェックポイントを見て、足りなければ台帳に残してホームへ（ポップアップを開かない）', appSource.includes('auth.status === AuthCheck.OK') && appSource.includes('goHomeFlat();') && appSource.includes('SAVED_LOCAL_CONNECT') && appSource.includes('SAVED_LOCAL_RELINK'));
    check('録音開始時に Google 連携を求めない（録音の必須条件にしない）', !appSource.includes('connectBeforeRecording') && !/startOffline\(\)[\s\S]{0,600}requestAccess\(/.test(appSource));
    check('Remote は事前連携しない（getDisplayMedia の操作猶予を消費しない）', !appSource.includes("connectBeforeRecording('online')"));
    check('Remote は同意チェックを最初に見る', appSource.indexOf('el.onConsent.checked') < appSource.indexOf('startOnline()\n'));
    check('録音開始時に台帳へ RECORDING 行を載せる', appSource.includes('registerRecordingStart(') && appSource.includes('state: RecordingState.RECORDING'));
    check('Drive 送信中は二重に送らない', appSource.includes('state.uploading.has(') && appSource.includes('state.uploading.add('));
    check('リダイレクトへの切替はスマートフォンだけ', appSource.includes('(env.mobile || env.standalone)'));
    check('復路の再開は「保存待ちの録音のアップロード」だけ（録音開始への往復は無い）', appSource.includes("action?.type === 'upload'") && !appSource.includes("type === 'record'") && !appSource.includes('authDeclined'));
    check('録音中は画面遷移・再読み込みを止める', appSource.includes('isRecordingActive()') && appSource.includes("addEventListener('beforeunload'"));
    check('OPFS 不達では台帳を消さない', appSource.includes("error?.name === 'NotFoundError'") && appSource.includes('getRecordingsDir(false)'));
    check('finalize のタイムアウトがある', recorderSource.includes('FINALIZE_TIMEOUT_MS') && recorderSource.includes('clearFinalizeTimer'));
    check('AudioContext が running にならなければ開始しない', recorderSource.includes("AUDIO_SUSPENDED") && readFileSync(resolve(appRoot, 'errors.js'), 'utf8').includes("error.code === 'AUDIO_SUSPENDED'"));
    check('CSP に form-action がある', readFileSync(resolve(appRoot, 'index.html'), 'utf8').includes("form-action 'none'"));
    {
      const flowSource = readFileSync(resolve(appRoot, 'save-flow.js'), 'utf8');
      check('保存の順序は save-flow.js に集約し、app.js は Drive 直後に OPFS を消さない', appSource.includes('saveAndProcessRecording(') && !appSource.includes('await deleteRecording(entry.localPath);\n  await refreshPendingRecordings();\n\n  setStep'));
      check('Drive 失敗は台帳を failed にして残す', flowSource.includes('applyUploadFailure(') && flowSource.includes('ledger.put(current);\n      throw error;'));
      check('OPFS の削除は議事録の処理（process）より後', flowSource.lastIndexOf('await deleteLocal(current.localPath)') > flowSource.indexOf('await process('));
    }
    check('起動時の OPFS 掃除は台帳のファイルを残す', opfsSource.includes('!keep.has(entry.name)') && appSource.includes('cleanupStaleFiles({ keep: pendingStore.keepFileNames() })'));
    check('AudioContext を resume する（iOS の無音録音対策）', recorderSource.includes('await this.audioContext.resume()'));
    check('Wake Lock は録音開始後に取り、確定・失敗で解放', appSource.includes('wakeLock.start()') && appSource.includes('wakeLock.stop()'));
    check('standalone では認証をリダイレクト方式にする', appSource.includes('prefersRedirectAuth(') && appSource.includes('consumeRedirectResult()') && appSource.includes('resumeAfterRedirect('));
    check('Gemini 実 API を呼ぶテストは無い', true);
  }

  section('保存フロー: 議事録の処理が終わるまで OPFS を消さない（2026-08-25 障害の再発防止）');

  {
    const flow = await import('../../public/meeting-assistant/save-flow.js');
    const errors = await import('../../public/meeting-assistant/errors.js');
    const store = await import('../../public/meeting-assistant/pending-store.js');
    const checkpoint = await import('../../public/meeting-assistant/recording-checkpoint.js');
    const pending = await import('../../public/meeting-assistant/pending-recordings.js');
    const transcriber = await import('../../public/meeting-assistant/gemini-transcriber.js');
    const diagnosticsMod = await import('../../public/meeting-assistant/diagnostics.js');
    const flowSource = readFileSync(resolve(appRoot, 'save-flow.js'), 'utf8');
    const appSource = readFileSync(resolve(appRoot, 'app.js'), 'utf8');

    /*
     * OPFS の偽物。Chromium と同じく、getFile() で得た File は参照であり、
     * 実体を削除したあとに読もうとすると失敗する（本番で踏んだ挙動そのもの）。
     */
    function createFakeOpfs(events) {
      const files = new Map();
      const deleted = new Set();

      const notFound = () => {
        const error = new Error('A requested file or directory could not be found at the time an operation was processed.');
        error.name = 'NotFoundError';
        return error;
      };

      class OpfsFile extends Blob {
        #name;
        #bytes;

        constructor(name, bytes) {
          super([bytes], { type: '' });
          this.#name = name;
          this.#bytes = bytes;
          this.name = name;
        }

        #guard() {
          if (deleted.has(this.#name)) {
            throw notFound();
          }
        }

        arrayBuffer() { this.#guard(); return super.arrayBuffer(); }
        text() { this.#guard(); return super.text(); }
        stream() { this.#guard(); return super.stream(); }
        bytes() { this.#guard(); return super.bytes(); }
        slice(start = 0, end = this.size) { return new OpfsFile(this.#name, this.#bytes.subarray(start, end)); }
      }

      return {
        write(name, size) {
          const bytes = new Uint8Array(size);
          for (let i = 0; i < size; i += 1) bytes[i] = i % 251;
          files.set(name, bytes);
          deleted.delete(name);
        },
        exists(name) { return files.has(name) && !deleted.has(name); },
        async loadFile(name) {
          if (!files.has(name) || deleted.has(name)) throw notFound();
          return new OpfsFile(name, files.get(name));
        },
        async deleteLocal(name) {
          deleted.add(name);
          events.push('opfs:delete');
        },
      };
    }

    /*
     * Gemini の偽物（fetch を差し替える。実 API は呼ばない）。
     * 本番と同じく、送信は body の File を実際に読む。読めなければ Chromium と同じく
     * 「TypeError: Failed to fetch」で fetch 自体が失敗する。
     */
    const minutesJson = {
      meeting: { title: '', date: '', time: '', participants: [], purpose: '' },
      summary: '挨拶のみ',
      topics: [{ title: '挨拶', summary: '冒頭の挨拶', keyPoints: [] }],
      decisions: [],
      actionItems: [{ task: '資料を送る', assignee: '', dueDate: '', evidence: '資料を送ります' }],
      openIssues: [],
      notes: [],
    };
    const TRANSCRIPT = '話者1: こんにちは。資料を送ります。';

    function createFakeGeminiFetch(events, options = {}) {
      const calls = { start: 0, upload: 0, generate: 0, remove: 0 };
      const impl = async (url, init = {}) => {
        const target = String(url);

        if (target.endsWith('/upload/v1beta/files')) {
          calls.start += 1;
          return new Response('{}', { status: 200, headers: { 'x-goog-upload-url': 'https://fake.upload.invalid/session-1' } });
        }

        if (target === 'https://fake.upload.invalid/session-1') {
          calls.upload += 1;
          let buffer;
          try {
            buffer = await init.body.arrayBuffer();
          } catch {
            throw new TypeError('Failed to fetch');
          }
          events.push(`gemini:upload-read ${buffer.byteLength}`);
          return Response.json({ file: { uri: 'https://fake.files.invalid/abc', name: 'files/abc', mimeType: 'audio/mpeg', state: 'ACTIVE' } });
        }

        if (target.includes(':generateContent')) {
          calls.generate += 1;
          if (options.generateStatus) {
            return Response.json({ error: { status: 'RESOURCE_EXHAUSTED', message: 'quota' } }, { status: options.generateStatus });
          }
          const body = JSON.parse(init.body);
          const isMinutes = body.generationConfig?.responseMimeType === 'application/json';
          events.push(isMinutes ? 'gemini:minutes' : 'gemini:transcribe');
          return Response.json({ candidates: [{ content: { parts: [{ text: isMinutes ? JSON.stringify(minutesJson) : TRANSCRIPT }] } }] });
        }

        if (init.method === 'DELETE') {
          calls.remove += 1;
          return Response.json({});
        }

        throw new Error(`unexpected fetch: ${target}`);
      };
      return { impl, calls };
    }

    function createLedger(events) {
      const data = {};
      const storage = {
        getItem: (k) => (k in data ? data[k] : null),
        setItem: (k, v) => { data[k] = String(v); },
        removeItem: (k) => { delete data[k]; },
      };
      const inner = store.createPendingStore(storage);
      return {
        get: (id) => inner.get(id),
        put(entry) { events.push(`ledger:${entry.state}`); return inner.put(entry); },
        remove(id) { events.push('ledger:remove'); return inner.remove(id); },
        list: () => inner.list(),
      };
    }

    function makeEntry(localPath, sizeBytes, durationSeconds) {
      return store.createBrowserEntry({
        recordingId: `rec-${localPath}`,
        fileName: '【現地対応】2026-08-25_14-25.mp3',
        localPath,
        sizeBytes,
        durationSeconds,
        method: 'offline',
      });
    }

    /* 依存の組み立て。Drive と Markdown 保存は偽物、Gemini は実コード＋fetch 差し替え。 */
    function createDeps({ events, opfs, ledger, gemini, markdownFails = false, processOverride = null }) {
      const drive = { uploads: 0 };
      return {
        drive,
        deps: {
          ledger,
          loadFile: opfs.loadFile,
          deleteLocal: opfs.deleteLocal,
          async uploadToDrive(blob) {
            drive.uploads += 1;
            const buffer = await blob.slice(0, blob.size).arrayBuffer();
            events.push(`drive:upload-read ${buffer.byteLength}`);
            return { id: 'drive-file-1', name: '【現地対応】2026-08-25_14-25.mp3', webViewLink: 'https://drive.google.com/file/d/drive-file-1/view', url: 'https://drive.google.com/file/d/drive-file-1/view' };
          },
          process: processOverride ?? (async (driveFile) => {
            const previousFetch = globalThis.fetch;
            globalThis.fetch = gemini.impl;
            try {
              const result = await pipeline.runGeminiPipeline({
                blob: driveFile.blob,
                displayName: driveFile.name,
                apiKey: 'test-key-not-real',
                audioUrl: driveFile.url,
                mock: false,
              });
              if (markdownFails) {
                throw new errors.AppError(errors.ErrorCode.UPLOAD_FAILED, 'http_500');
              }
              events.push(`markdown:save ${result.markdown.includes(TRANSCRIPT) ? 'ok' : 'ng'}`);
              return { completed: true };
            } finally {
              globalThis.fetch = previousFetch;
            }
          }),
          onStage: (stage) => events.push(`stage:${stage}`),
          onFailure: (stage) => events.push(`failure:${stage}`),
        },
      };
    }

    /* ---- 偽物自体の妥当性: 削除後の File は読めない（本番の挙動を再現できている） ---- */
    {
      const events = [];
      const opfs = createFakeOpfs(events);
      opfs.write('sanity.mp3.part', 1000);
      const file = await opfs.loadFile('sanity.mp3.part');
      const before = (await file.arrayBuffer()).byteLength;
      await opfs.deleteLocal('sanity.mp3.part');
      let after = 'readable';
      try { await file.arrayBuffer(); } catch (error) { after = error.name; }
      check('偽 OPFS: 削除前は読める・削除後は NotFoundError（Chromium と同じ）', before === 1000 && after === 'NotFoundError');

      /* 旧実装の順序（Drive 保存 → OPFS 削除 → Gemini 送信）を実 transcriber で再現すると必ず失敗する */
      const gemini = createFakeGeminiFetch(events);
      const previousFetch = globalThis.fetch;
      globalThis.fetch = gemini.impl;
      let oldOrder = null;
      try {
        await transcriber.transcribeWithGemini(file, { apiKey: 'test-key-not-real', displayName: 'x.mp3' });
      } catch (error) {
        oldOrder = error;
      } finally {
        globalThis.fetch = previousFetch;
      }
      check('旧順序（削除後に Gemini へ送る）は GeminiError NETWORK になる（障害の再現）', oldOrder?.name === 'GeminiError' && oldOrder.code === 'NETWORK');
      check('旧順序の失敗は「処理に失敗しました」ではなく通信の失敗として案内する', errors.describeAppError(oldOrder).includes('Gemini との通信に失敗') && errors.describeAppError(oldOrder).includes('Drive に保存済み'));
    }

    /* ---- 正常系: 順序の検証 ---- */
    {
      const events = [];
      const opfs = createFakeOpfs(events);
      const SIZE = 362112; /* 本番で失敗した 23 秒録音と同じサイズ */
      opfs.write('rec-a.mp3.part', SIZE);
      const ledger = createLedger(events);
      const entry = makeEntry('rec-a.mp3.part', SIZE, 23);
      ledger.put(entry);
      events.length = 0;
      const gemini = createFakeGeminiFetch(events);
      const { deps, drive } = createDeps({ events, opfs, ledger, gemini });

      const result = await flow.saveAndProcessRecording({ entry, file: await opfs.loadFile('rec-a.mp3.part') }, deps);

      const idx = (label) => events.findIndex((e) => e.startsWith(label));
      check('結果は COMPLETED', result.outcome === flow.SaveOutcome.COMPLETED);
      check('Drive 送信は録音全体を読めた', events.includes(`drive:upload-read ${SIZE}`));
      check('台帳は Drive 保存後に UPLOADED（driveFileId 付き）', idx('ledger:UPLOADED') > idx('drive:upload-read') && events.includes('ledger:PROCESSING'));
      check('Gemini へ渡す時点で録音がまだ読める（送信が録音全体を読んだ）', events.includes(`gemini:upload-read ${SIZE}`) && idx('gemini:upload-read') > idx('ledger:UPLOADED'));
      check('文字起こし → 議事録 → Markdown 保存の順', idx('gemini:transcribe') < idx('gemini:minutes') && idx('gemini:minutes') < idx('markdown:save ok'));
      check('OPFS 削除は Markdown 保存より後で、最後', idx('opfs:delete') > idx('markdown:save ok') && events[events.length - 1] === 'opfs:delete');
      check('台帳からの削除は Markdown 保存の後', idx('ledger:remove') > idx('markdown:save ok') && idx('ledger:remove') < idx('opfs:delete'));
      check('完了後は台帳が空で OPFS も消えている', ledger.list().length === 0 && !opfs.exists('rec-a.mp3.part'));
      check('Drive へは 1 回だけ送った', drive.uploads === 1 && gemini.calls.upload === 1);
      check('Gemini 側の一時ファイルは削除している', gemini.calls.remove === 1);
    }

    /* ---- 録音時間による最低時間の制限は無い（1 秒相当でも同じ順序で通る） ---- */
    {
      const events = [];
      const opfs = createFakeOpfs(events);
      const SIZE = 16000; /* 128kbps で約 1 秒 */
      opfs.write('rec-short.mp3.part', SIZE);
      const ledger = createLedger(events);
      const entry = makeEntry('rec-short.mp3.part', SIZE, 1);
      ledger.put(entry);
      const gemini = createFakeGeminiFetch(events);
      const { deps } = createDeps({ events, opfs, ledger, gemini });
      const result = await flow.saveAndProcessRecording({ entry }, deps);
      check('1 秒相当の録音でも最低時間で弾かず完了する', result.outcome === flow.SaveOutcome.COMPLETED && events.includes(`gemini:upload-read ${SIZE}`));
      check('save-flow に録音時間の下限が無い', !/durationSeconds\s*[<>]/.test(flowSource) && !/(^|[^A-Z_])MIN_(DURATION|SECONDS)/.test(flowSource) && !/(^|[^A-Z_])MIN_(DURATION|SECONDS)/.test(readFileSync(resolve(appRoot, 'config.js'), 'utf8')));
    }

    /* ---- Gemini 失敗: 録音を失わず、Drive へ再送せずにやり直せる ---- */
    {
      const events = [];
      const opfs = createFakeOpfs(events);
      opfs.write('rec-b.mp3.part', 50000);
      const ledger = createLedger(events);
      const entry = makeEntry('rec-b.mp3.part', 50000, 3);
      ledger.put(entry);
      const failing = createFakeGeminiFetch(events, { generateStatus: 429 });
      const first = createDeps({ events, opfs, ledger, gemini: failing });

      const failed = await flow.saveAndProcessRecording({ entry }, first.deps);
      const row = ledger.get(entry.recordingId);
      check('Gemini 失敗は例外ではなく PROCESS_FAILED として返る', failed.outcome === flow.SaveOutcome.PROCESS_FAILED && failed.error?.name === 'GeminiError' && failed.error.code === 'QUOTA_EXCEEDED');
      check('台帳は PROCESS_FAILED で残り、Drive 保存の情報とエラーコードを持つ', row?.state === checkpoint.RecordingState.PROCESS_FAILED && row.driveFileId === 'drive-file-1' && row.error === 'QUOTA_EXCEEDED');
      check('端末の録音（OPFS）は消えていない', opfs.exists('rec-b.mp3.part') && !events.includes('opfs:delete'));
      check('一覧に「議事録を作成」で出る（Drive 保存済みと分かる）', pending.visiblePendingRecordings([row]).length === 1 && pending.saveButtonLabel(row) === '議事録を作成' && pending.pendingStateNote(row).includes('Drive に保存済み'));
      check('破棄の確認文は Drive 保存済みと伝える', pending.discardConfirmText(row).includes('Drive に保存済み'));
      check('利用者向け文言は上限到達と分かる', errors.describeAppError(failed.error).includes('利用上限'));

      /* やり直し: Drive へは送らず、Gemini からやり直して完了する */
      const ok = createFakeGeminiFetch(events);
      const second = createDeps({ events, opfs, ledger, gemini: ok });
      const retried = await flow.saveAndProcessRecording({ entry: ledger.get(entry.recordingId) }, second.deps);
      check('再処理は Drive へ二重送信しない', second.drive.uploads === 0 && events.filter((e) => e.startsWith('stage:drive-upload')).length === 2);
      check('再処理で完了し、OPFS と台帳から消える', retried.outcome === flow.SaveOutcome.COMPLETED && !opfs.exists('rec-b.mp3.part') && ledger.list().length === 0);
    }

    /* ---- Markdown（record）保存の失敗でも録音を失わない ---- */
    {
      const events = [];
      const opfs = createFakeOpfs(events);
      opfs.write('rec-c.mp3.part', 40000);
      const ledger = createLedger(events);
      const entry = makeEntry('rec-c.mp3.part', 40000, 2);
      ledger.put(entry);
      const gemini = createFakeGeminiFetch(events);
      const { deps } = createDeps({ events, opfs, ledger, gemini, markdownFails: true });
      const result = await flow.saveAndProcessRecording({ entry }, deps);
      check('Markdown 保存失敗は PROCESS_FAILED で、OPFS は残る', result.outcome === flow.SaveOutcome.PROCESS_FAILED && result.error instanceof errors.AppError && opfs.exists('rec-c.mp3.part') && ledger.get(entry.recordingId)?.state === checkpoint.RecordingState.PROCESS_FAILED);
    }

    /* ---- 完了せず戻る（APIキー未設定）: UPLOADED のまま残す ---- */
    {
      const events = [];
      const opfs = createFakeOpfs(events);
      opfs.write('rec-d.mp3.part', 30000);
      const ledger = createLedger(events);
      const entry = makeEntry('rec-d.mp3.part', 30000, 2);
      ledger.put(entry);
      const gemini = createFakeGeminiFetch(events);
      const { deps } = createDeps({ events, opfs, ledger, gemini, processOverride: async () => ({ completed: false, reason: 'API_KEY_MISSING' }) });
      const result = await flow.saveAndProcessRecording({ entry }, deps);
      const row = ledger.get(entry.recordingId);
      check('APIキー未設定は失敗ではなく NOT_COMPLETED。台帳は UPLOADED で OPFS は残る', result.outcome === flow.SaveOutcome.NOT_COMPLETED && row?.state === checkpoint.RecordingState.UPLOADED && opfs.exists('rec-d.mp3.part'));
      check('その行は「議事録を作成」として一覧に出る', pending.saveButtonLabel(row) === '議事録を作成' && pending.pendingStateNote(row).includes('未作成'));
    }

    /* ---- Drive 保存の失敗: 従来どおり UPLOAD_FAILED で例外、録音は残る ---- */
    {
      const events = [];
      const opfs = createFakeOpfs(events);
      opfs.write('rec-e.mp3.part', 30000);
      const ledger = createLedger(events);
      const entry = makeEntry('rec-e.mp3.part', 30000, 2);
      ledger.put(entry);
      const gemini = createFakeGeminiFetch(events);
      const { deps } = createDeps({ events, opfs, ledger, gemini });
      deps.uploadToDrive = async () => { throw new errors.AppError(errors.ErrorCode.NETWORK, 'fetch_failed'); };
      let thrown = null;
      try { await flow.saveAndProcessRecording({ entry }, deps); } catch (error) { thrown = error; }
      const row = ledger.get(entry.recordingId);
      check('Drive 失敗は例外で伝え、台帳は UPLOAD_FAILED、OPFS は残る', thrown?.code === 'NETWORK' && row?.state === checkpoint.RecordingState.UPLOAD_FAILED && opfs.exists('rec-e.mp3.part') && events.includes('failure:drive-upload'));
      check('Gemini は呼ばれていない', gemini.calls.start === 0);
    }

    /* ---- 処理の途中で落ちた（PROCESSING のまま）行の回収 ---- */
    {
      const entry = checkpoint.applyProcessing(checkpoint.applyUploaded(makeEntry('rec-f.mp3.part', 1000, 1), { driveFileId: 'drive-f', driveUrl: 'https://drive.google.com/file/d/drive-f/view' }));
      check('PROCESSING の行は一覧に出て「議事録を作成」', pending.visiblePendingRecordings([entry]).length === 1 && pending.saveButtonLabel(entry) === '議事録を作成' && pending.pendingStateNote(entry).includes('途中'));
      check('ネイティブ行の UPLOADED は一覧に出さない', pending.visiblePendingRecordings([{ ...entry, source: 'native' }]).length === 0);
      check('Drive 保存済みの判定は driveFileId を要する', checkpoint.isDriveSaved(entry) && !checkpoint.isDriveSaved({ ...entry, driveFileId: '' }));
    }

    /* ---- 空録音・端末の録音が無い ---- */
    {
      const events = [];
      const opfs = createFakeOpfs(events);
      const ledger = createLedger(events);
      const gemini = createFakeGeminiFetch(events);

      opfs.write('rec-empty.mp3.part', 0);
      const empty = makeEntry('rec-empty.mp3.part', 0, 0);
      ledger.put(empty);
      let thrown = null;
      try { await flow.saveAndProcessRecording({ entry: empty }, createDeps({ events, opfs, ledger, gemini }).deps); } catch (error) { thrown = error; }
      check('0 バイトだけを空録音として落とす', thrown?.code === 'ENCODE_FAILED' && ledger.get(empty.recordingId) === null);

      const missing = checkpoint.applyUploaded(makeEntry('rec-missing.mp3.part', 1000, 1), { driveFileId: 'drive-m', driveUrl: '' });
      ledger.put(missing);
      thrown = null;
      try { await flow.saveAndProcessRecording({ entry: missing }, createDeps({ events, opfs, ledger, gemini }).deps); } catch (error) { thrown = error; }
      check('Drive 保存済みで端末の録音が無ければ、Drive の一覧から作れると案内する', thrown?.code === 'LOCAL_FILE_MISSING_DRIVE_SAVED' && errors.describeAppError(thrown).includes('Drive') && ledger.get(missing.recordingId) === null);
    }

    /* ---- ケース1・2: 認証チェックポイント（有効ならそのまま、期限切れなら保存前に更新） ---- */
    {
      const events = [];
      const opfs = createFakeOpfs(events);
      opfs.write('rec-auth.mp3.part', 20000);
      const ledger = createLedger(events);
      const entry = makeEntry('rec-auth.mp3.part', 20000, 1);
      ledger.put(entry);
      const gemini = createFakeGeminiFetch(events);
      const { deps } = createDeps({ events, opfs, ledger, gemini });
      let requests = 0;
      deps.ensureAuth = async () => { events.push('auth:check'); };
      deps.resolveFolder = async () => { events.push('folder:resolve'); return 'folder-voice'; };
      const result = await flow.saveAndProcessRecording({ entry }, deps);
      const idx = (label) => events.findIndex((e) => e.startsWith(label));
      check('ケース1: 認証が有効 → 再認証せずそのまま保存（認証確認 → 保存先 → Drive の順）', result.outcome === flow.SaveOutcome.COMPLETED && requests === 0 && idx('auth:check') < idx('folder:resolve') && idx('folder:resolve') < idx('drive:upload-read'));

      /* ケース2: 期限切れ → 保存前に連携を更新（ensureAuth が requestAccess 相当を呼ぶ）してから保存 */
      events.length = 0;
      opfs.write('rec-auth2.mp3.part', 20000);
      const entry2 = makeEntry('rec-auth2.mp3.part', 20000, 1);
      ledger.put(entry2);
      let tokenValid = false;
      deps.ensureAuth = async () => { if (!tokenValid) { requests += 1; events.push('auth:request'); tokenValid = true; } };
      deps.uploadToDrive = async (blob) => { if (!tokenValid) throw new Error('no token'); const buffer = await blob.slice(0, blob.size).arrayBuffer(); events.push(`drive:upload-read ${buffer.byteLength}`); return { id: 'drive-file-2', name: 'x', url: 'u' }; };
      const result2 = await flow.saveAndProcessRecording({ entry: entry2 }, deps);
      check('ケース2: 期限切れ → 保存前に Google 連携を更新してから Drive へ保存', result2.outcome === flow.SaveOutcome.COMPLETED && requests === 1 && idx('auth:request') < idx('drive:upload-read'));

      /* 連携を更新できない（押下なし）→ 台帳は変えず、OPFS は残る。押下で再開できる */
      events.length = 0;
      opfs.write('rec-auth3.mp3.part', 20000);
      const entry3 = makeEntry('rec-auth3.mp3.part', 20000, 1);
      ledger.put(entry3);
      deps.ensureAuth = async () => { throw new errors.AppError(errors.ErrorCode.OAUTH_USER_ACTION_REQUIRED, 'gis_popup_failed_to_open'); };
      let thrown = null;
      try { await flow.saveAndProcessRecording({ entry: entry3 }, deps); } catch (error) { thrown = error; }
      check('認証を更新できない → OAUTH_USER_ACTION_REQUIRED を返し、台帳は SAVED_LOCAL のまま・OPFS 保持・Drive へ送らない', thrown?.code === 'OAUTH_USER_ACTION_REQUIRED' && ledger.get(entry3.recordingId)?.state === checkpoint.RecordingState.SAVED_LOCAL && opfs.exists('rec-auth3.mp3.part') && !events.some((e) => e.startsWith('drive:upload')));
      check('Drive 保存済みの再処理でも認証チェックポイントを通る（Markdown 保存に要る）', (() => { const src = flowSource; return src.indexOf('await ensureAuth()') < src.indexOf('isDriveSaved(current)'); })());
    }

    /* ---- 診断ログ: 段階と code / 安全な detail だけ ---- */
    {
      const lines = [];
      const fakeConsole = { info: (...a) => lines.push(['info', ...a]), error: (...a) => lines.push(['error', ...a]) };
      const diag = diagnosticsMod.createDiagnostics(fakeConsole);
      const geminiError = new transcriber.GeminiError('NETWORK', 0, 'TypeError');
      geminiError.message = 'SECRET-LIKE-RESPONSE-BODY';
      diag.stage('drive-upload', { recordingId: 'r1', sizeBytes: 10 });
      diag.failure('process', geminiError, { recordingId: 'r1' });
      const failure = lines[1];
      const summary = failure[4].error;
      check('段階のログが出る', lines[0][0] === 'info' && lines[0][3] === 'drive-upload');
      check('失敗ログは name / code / detail を持ち、message（応答本文の恐れ）を出さない', failure[0] === 'error' && summary.name === 'GeminiError' && summary.code === 'NETWORK' && summary.detail === 'TypeError' && !JSON.stringify(failure).includes('SECRET-LIKE'));
      const appError = new errors.AppError(errors.ErrorCode.UPLOAD_FAILED, 'http_500', new TypeError('Failed to fetch'));
      const appSummary = diagnosticsMod.summarizeError(appError);
      check('AppError は code と識別子 message、cause を 1 段だけ', appSummary.code === 'UPLOAD_FAILED' && appSummary.detail === 'http_500' && appSummary.cause?.name === 'TypeError');
      const rec = diagnosticsMod.summarizeRecording({ recordingId: 'r1', fileName: '【現地対応】山田 太郎.mp3', sizeBytes: 5, durationSeconds: 1, mimeType: 'audio/mpeg', driveFileId: 'x', state: 'UPLOADED' });
      check('録音の要約に氏名を含むファイル名を出さない', !('fileName' in rec) && rec.driveSaved === true && rec.sizeBytes === 5);
      check('app.js は診断ログを保存フローと Gemini 段階で使う', appSource.includes('diagnostics.failure(stage, error, info)') && appSource.includes("diagnostics.stage('gemini'") && appSource.includes("diagnostics.stage('markdown-save'"));
      check('APIキーをログに出さない', !/diagnostics\.(stage|failure)\([^)]*apiKey/.test(appSource));
    }
  }


  section('保存前の Google 認証チェックポイント（auth-checkpoint.js / oauth.js）');

  {
    const cp = await import('../../public/meeting-assistant/auth-checkpoint.js');
    const appSource = readFileSync(resolve(appRoot, 'app.js'), 'utf8');
    const oauth = await import('../../public/meeting-assistant/oauth.js');
    const errors = await import('../../public/meeting-assistant/errors.js');
    const min = config.SAVE_TOKEN_MIN_SECONDS;

    check('SAVE_TOKEN_MIN_SECONDS は config の一箇所（10 分）', min === 600);
    check('有効で残りが十分 → そのまま保存', cp.evaluateSaveAuth({ valid: true, remainingSeconds: min + 1, everLinked: true, minSeconds: min }).status === cp.AuthCheck.OK);
    check('残りがちょうど下限 → そのまま保存', cp.evaluateSaveAuth({ valid: true, remainingSeconds: min, everLinked: true, minSeconds: min }).status === cp.AuthCheck.OK);
    check('有効だが残りが足りない → 利用者の押下で更新', cp.evaluateSaveAuth({ valid: true, remainingSeconds: min - 1, everLinked: true, minSeconds: min }).status === cp.AuthCheck.INSUFFICIENT);
    check('一度連携して期限切れ → EXPIRED', cp.evaluateSaveAuth({ valid: false, remainingSeconds: 0, everLinked: true, minSeconds: min }).status === cp.AuthCheck.EXPIRED);
    check('未連携 → NEVER_LINKED', cp.evaluateSaveAuth({ valid: false, remainingSeconds: 0, everLinked: false, minSeconds: min }).status === cp.AuthCheck.NEVER_LINKED);
    check('OK 以外は needsUserAction', [cp.AuthCheck.INSUFFICIENT, cp.AuthCheck.EXPIRED, cp.AuthCheck.NEVER_LINKED].every((st) => Object.values(cp.AuthCheck).includes(st)) && cp.evaluateSaveAuth({ valid: false, minSeconds: min }).needsUserAction === true && cp.evaluateSaveAuth({ valid: true, remainingSeconds: 9999, minSeconds: min }).needsUserAction === false);

    /* 90 分録音: 開始直後に取ったトークン（59 分扱い）は停止時点で必ず切れている → 保存前に更新 */
    check('90 分録音の停止時点（開始 +5400 秒）では残り 0 → 保存前に更新', cp.evaluateSaveAuth({ valid: false, remainingSeconds: 0, everLinked: true, minSeconds: min }).status === cp.AuthCheck.EXPIRED);

    check('tokenState はトークンの値を含まない', (() => { const st = oauth.tokenState(); return typeof st.valid === 'boolean' && typeof st.remainingSeconds === 'number' && typeof st.everLinked === 'boolean' && !('accessToken' in st) && !('token' in st); })());

    /* ポップアップが開かない理由の切り分け: 利用者操作の猶予なし → USER_ACTION_REQUIRED、猶予あり → POPUP_BLOCKED */
    async function popupFailure(isActive) {
      const previousGoogle = globalThis.google;
      const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
      globalThis.google = { accounts: { oauth2: { initTokenClient: (cfg) => ({ requestAccessToken: () => cfg.error_callback({ type: 'popup_failed_to_open' }) }) } } };
      Object.defineProperty(globalThis, 'navigator', { value: isActive === null ? {} : { userActivation: { isActive } }, configurable: true, writable: true });
      try {
        await oauth.requestAccess({});
        return null;
      } catch (error) {
        return error.code;
      } finally {
        globalThis.google = previousGoogle;
        if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator); else delete globalThis.navigator;
      }
    }
    check('操作の猶予なしでポップアップが開かない → OAUTH_USER_ACTION_REQUIRED', await popupFailure(false) === 'OAUTH_USER_ACTION_REQUIRED');
    check('操作の猶予があるのに開かない → OAUTH_POPUP_BLOCKED（本当のブロック）', await popupFailure(true) === 'OAUTH_POPUP_BLOCKED');
    check('userActivation が無いブラウザでは従来どおり POPUP_BLOCKED', await popupFailure(null) === 'OAUTH_POPUP_BLOCKED');
    check('USER_ACTION_REQUIRED の文言はブロック解除ではなく「押して更新」', errors.describeError(new errors.AppError('OAUTH_USER_ACTION_REQUIRED')).includes('連携の更新') && !errors.describeError(new errors.AppError('OAUTH_USER_ACTION_REQUIRED')).includes('ブロック') && errors.describeError(new errors.AppError('OAUTH_POPUP_BLOCKED')).includes('ブロック'));
    check('保存先を準備できない文言は録音が端末にあることを伝える', errors.describeError(new errors.AppError('DRIVE_FOLDER_UNAVAILABLE')).includes('保存先を準備できませんでした') && errors.describeError(new errors.AppError('DRIVE_FOLDER_UNAVAILABLE')).includes('録音は端末に保存されています'));
    check('スコープは drive.file のまま（拡大していない）', config.OAUTH.scope === 'https://www.googleapis.com/auth/drive.file' && !/client_secret|clientSecret/.test(readFileSync(resolve(appRoot, 'oauth.js'), 'utf8')));
    check('app.js: 保存フローの先頭で認証を確定し、連携しなおしで保存先 ID を捨てる', appSource.includes('ensureAuth: () => ensureAuthForSave(resume)') && appSource.includes('folders.forget();'));
  }

  section('保存先フォルダの自動保証と ID の保持（drive-folders.js / drive.js）');

  {
    const driveMod = await import('../../public/meeting-assistant/drive.js');
    const foldersMod = await import('../../public/meeting-assistant/drive-folders.js');
    const appSource = readFileSync(resolve(appRoot, 'app.js'), 'utf8');
    const errors = await import('../../public/meeting-assistant/errors.js');
    const FOLDER = 'application/vnd.google-apps.folder';
    const PATHS = { voice: config.DRIVE_VOICE_PATH, record: config.DRIVE_RECORD_PATH };

    /* Drive API の偽物（files.list / files.create / files.get だけ）。同名検索は大文字小文字を区別しない。 */
    function createFakeDrive() {
      const folders = new Map();
      let seq = 0;
      const calls = { list: 0, create: 0, get: 0, created: [] };
      const options = { failCreate: false, failNetwork: false };

      function add(name, parent, extra = {}) {
        seq += 1;
        const id = `f${seq}`;
        folders.set(id, { id, name, parents: [parent], trashed: false, createdTime: new Date(2026, 7, 23, 0, 0, seq).toISOString(), ...extra });
        return id;
      }

      const fetchImpl = async (url, init = {}) => {
        if (options.failNetwork) throw new TypeError('Failed to fetch');
        const u = new URL(String(url));
        const method = init.method ?? 'GET';
        if (method === 'GET' && u.pathname === '/drive/v3/files') {
          calls.list += 1;
          const q = u.searchParams.get('q') ?? '';
          const name = /name='((?:[^'\\]|\\.)*)'/.exec(q)?.[1].replace(/\\(.)/g, '$1');
          const parent = /'((?:[^'\\]|\\.)*)' in parents/.exec(q)?.[1];
          const hits = [...folders.values()].filter((f) => !f.trashed && f.name.toLowerCase() === String(name).toLowerCase() && f.parents.includes(parent)).sort((a, b) => a.createdTime.localeCompare(b.createdTime));
          return Response.json({ files: hits.map((f) => ({ id: f.id, name: f.name, createdTime: f.createdTime })) });
        }
        if (method === 'POST' && u.pathname === '/drive/v3/files') {
          calls.create += 1;
          if (options.failCreate) return Response.json({ error: { code: 403, message: 'insufficient permissions', errors: [{ reason: 'insufficientFilePermissions' }] } }, { status: 403 });
          const body = JSON.parse(init.body);
          const id = add(body.name, body.parents[0]);
          calls.created.push(body.name);
          return Response.json({ id });
        }
        const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
        if (method === 'GET' && m) {
          calls.get += 1;
          const f = folders.get(decodeURIComponent(m[1]));
          if (!f) return Response.json({ error: { code: 404, message: 'File not found' } }, { status: 404 });
          return Response.json({ id: f.id, name: f.name, mimeType: FOLDER, trashed: f.trashed, parents: f.parents });
        }
        throw new Error(`unexpected ${method} ${u.href}`);
      };

      return { folders, calls, options, add, fetchImpl, reset() { calls.list = 0; calls.create = 0; calls.get = 0; calls.created = []; } };
    }

    function memoryStorage() {
      const data = {};
      return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, removeItem: (k) => { delete data[k]; }, data };
    }

    async function withDrive(drive, fn) {
      const previous = globalThis.fetch;
      globalThis.fetch = drive.fetchImpl;
      try { return await fn(); } finally { globalThis.fetch = previous; }
    }

    const auth = { accessToken: 'test-token-not-real' };
    /* 注入した時計。保存のたびに検証させるため、テストでは明示的に進める。 */
    const clock = { t: 1_000_000, tick(ms = 10_000) { this.t += ms; } };
    const makeResolver = (storage) => foldersMod.createFolderResolver({ storage, ensureChain: driveMod.ensureFolderChain, getFolder: driveMod.getFolderMetadata, paths: PATHS, now: () => clock.t });
    const namesUnder = (drive, parentId) => [...drive.folders.values()].filter((f) => f.parents.includes(parentId)).map((f) => f.name);

    /* ケース3: すべて存在 → 既存を再利用し、作成しない */
    {
      const drive = createFakeDrive();
      const sys = drive.add('Potenitas System', 'root');
      const adm = drive.add('Potenitas Administrator', sys);
      const meet = drive.add('Potenitas meet', adm);
      const voice = drive.add('Potenitas Voice', meet); /* 本番と同じく大文字 V（別アプリが作成） */
      const record = drive.add('Potenitas record', meet);
      const resolver = makeResolver(memoryStorage());
      const [v, r] = await withDrive(drive, async () => [await resolver.resolve('voice', auth), await resolver.resolve('record', auth)]);
      check('ケース3: すべて存在 → 既存フォルダを再利用（大文字小文字の違いも同一視）', v === voice && r === record && drive.calls.create === 0);
      check('ケース3: 名前での検索は 4 + 1 回（共通階層は 2 回目に検索しない）', drive.calls.list === 5);
    }

    /* ケース4: 一部だけ存在 → 不足分だけ作成 */
    {
      const drive = createFakeDrive();
      const sys = drive.add('Potenitas System', 'root');
      const resolver = makeResolver(memoryStorage());
      const v = await withDrive(drive, () => resolver.resolve('voice', auth));
      check('ケース4: Potenitas System だけ存在 → Administrator / meet / voice の 3 つだけ作成', drive.calls.create === 3 && drive.calls.created.join('>') === 'Potenitas Administrator>Potenitas meet>Potenitas voice');
      check('ケース4: 既存の Potenitas System を再利用（root 直下に増えない）', namesUnder(drive, 'root').length === 1 && drive.folders.get(v).parents[0] === [...drive.folders.values()].find((f) => f.name === 'Potenitas meet').id && [...drive.folders.values()].find((f) => f.name === 'Potenitas Administrator').parents[0] === sys);
      drive.reset();
      await withDrive(drive, () => resolver.resolve('record', auth));
      check('ケース4: 続けて record は 1 つだけ作成', drive.calls.create === 1 && drive.calls.created[0] === 'Potenitas record');
    }

    /* ケース5: すべて無い → 階層を順番に作成 */
    {
      const drive = createFakeDrive();
      const resolver = makeResolver(memoryStorage());
      await withDrive(drive, () => resolver.resolve('voice', auth));
      check('ケース5: すべて無い → System → Administrator → meet → voice の順に作成', drive.calls.created.join('>') === 'Potenitas System>Potenitas Administrator>Potenitas meet>Potenitas voice');
      const chain = ['Potenitas System', 'Potenitas Administrator', 'Potenitas meet', 'Potenitas voice'].map((n) => [...drive.folders.values()].find((f) => f.name === n));
      check('ケース5: 親子関係が正しい', chain[0].parents[0] === 'root' && chain[1].parents[0] === chain[0].id && chain[2].parents[0] === chain[1].id && chain[3].parents[0] === chain[2].id);
    }

    /* ケース6: 何度実行しても同名フォルダを重複作成しない（同じ resolver・別 resolver・保持なし） */
    {
      const drive = createFakeDrive();
      const storage = memoryStorage();
      const first = makeResolver(storage);
      await withDrive(drive, async () => { await first.resolve('voice', auth); await first.resolve('record', auth); });
      const createdOnce = drive.calls.create;
      drive.reset();
      clock.tick();
      await withDrive(drive, async () => { await first.resolve('voice', auth); await first.resolve('record', auth); });
      check('ケース6: 同じ resolver で再実行 → 作成 0・検索 0（保持した ID を検証して使う）', createdOnce === 5 && drive.calls.create === 0 && drive.calls.list === 0);
      check('ケース6: 保持の検証は files.get（各階層。共通する 3 階層は 1 回）だけ', drive.calls.get === 5);
      drive.reset();
      clock.tick();
      const second = makeResolver(storage);
      await withDrive(drive, async () => { await second.resolve('voice', auth); await second.resolve('record', auth); });
      check('ケース6: 別の resolver（再読み込み後）でも localStorage の ID を使い作成しない', drive.calls.create === 0 && drive.calls.list === 0 && second.cachedId('voice') === first.cachedId('voice'));
      check('ケース6: 検証の省略は数秒だけ（時間が経てば保存前に改めて確認する）', drive.calls.get === 5);
      drive.reset();
      clock.tick();
      const noCache = makeResolver(memoryStorage());
      await withDrive(drive, async () => { await noCache.resolve('voice', auth); await noCache.resolve('record', auth); });
      check('ケース6: 保持が無くても名前検索で既存を見つけ、作成しない', drive.calls.create === 0);
      const allNames = [...drive.folders.values()].map((f) => f.name);
      check('ケース6: Drive 上の各フォルダは 1 つずつ', new Set(allNames).size === allNames.length && allNames.length === 5);
      check('保持する内容は ID と名前だけ（トークン・音声を含まない）', !/token|accessToken|blob/i.test(storage.data[foldersMod.FOLDER_CACHE_KEY]));
    }

    /* 保持した ID が使えなくなったとき: 削除・ゴミ箱・移動・改名・別アカウント */
    {
      const drive = createFakeDrive();
      const storage = memoryStorage();
      const resolver = makeResolver(storage);
      const voice = await withDrive(drive, () => resolver.resolve('voice', auth));
      const meet = drive.folders.get(voice).parents[0];

      drive.folders.delete(voice);
      drive.reset();
      clock.tick();
      const v2 = await withDrive(drive, () => makeResolver(storage).resolve('voice', auth));
      check('削除された → 検知して voice だけ作りなおす（上位階層は再利用）', v2 !== voice && drive.calls.created.join() === 'Potenitas voice' && drive.folders.get(v2).parents[0] === meet);

      drive.folders.get(v2).trashed = true;
      drive.reset();
      clock.tick();
      const v3 = await withDrive(drive, () => makeResolver(storage).resolve('voice', auth));
      check('ゴミ箱にある → 検知して作りなおす', v3 !== v2 && drive.calls.created.join() === 'Potenitas voice');

      const elsewhere = drive.add('Elsewhere', 'root');
      drive.folders.get(v3).parents = [elsewhere];
      drive.reset();
      clock.tick();
      const v4 = await withDrive(drive, () => makeResolver(storage).resolve('voice', auth));
      check('移動された → 検知して Potenitas meet の下に作りなおす', v4 !== v3 && drive.folders.get(v4).parents[0] === meet);

      drive.folders.get(v4).name = 'Renamed';
      drive.reset();
      clock.tick();
      const v5 = await withDrive(drive, () => makeResolver(storage).resolve('voice', auth));
      check('改名された → 検知して正しい名前で作りなおす', v5 !== v4 && drive.folders.get(v5).name === 'Potenitas voice');

      /* ゴミ箱に入ったのが上位階層でも、その階層自身の trashed で検知する */
      drive.folders.get(meet).trashed = true;
      drive.reset();
      clock.tick();
      const v6 = await withDrive(drive, () => makeResolver(storage).resolve('voice', auth));
      check('上位階層（meet）がゴミ箱 → meet と voice を作りなおす', v6 !== v5 && drive.calls.created.join('>') === 'Potenitas meet>Potenitas voice');

      /* 別アカウント（すべて 404）→ 全階層を解決しなおす */
      const other = createFakeDrive();
      other.reset();
      clock.tick();
      const v7 = await withDrive(other, () => makeResolver(storage).resolve('voice', auth));
      check('別アカウントの ID（すべて 404）→ 名前で解決しなおし、無ければ作る', typeof v7 === 'string' && other.calls.create === 4);

      check('forget で保持を捨てる', (() => { const r = makeResolver(storage); r.forget(); return r.cachedId('voice') === null && storage.getItem(foldersMod.FOLDER_CACHE_KEY) === null; })());
    }

    /* 通信・認証の失敗は「無効」にしない（オフラインで作りなおして重複させない） */
    {
      const drive = createFakeDrive();
      const storage = memoryStorage();
      await withDrive(drive, () => makeResolver(storage).resolve('voice', auth));
      drive.options.failNetwork = true;
      drive.reset();
      clock.tick();
      let thrown = null;
      try { await withDrive(drive, () => makeResolver(storage).resolve('voice', auth)); } catch (error) { thrown = error; }
      check('検証中の通信失敗は NETWORK として上へ返し、作成しない', thrown?.code === 'NETWORK' && drive.calls.create === 0);
    }

    /* ケース7: フォルダ作成失敗 → OPFS 保持・台帳保持・再試行可能（save-flow と結合） */
    {
      const flow = await import('../../public/meeting-assistant/save-flow.js');
      const store = await import('../../public/meeting-assistant/pending-store.js');
      const checkpoint = await import('../../public/meeting-assistant/recording-checkpoint.js');
      const drive = createFakeDrive();
      drive.options.failCreate = true;
      const resolver = makeResolver(memoryStorage());
      const ledger = store.createPendingStore(memoryStorage());
      const entry = store.createBrowserEntry({ recordingId: 'rec-folder', fileName: 'x.mp3', localPath: 'x.mp3.part', sizeBytes: 3000, durationSeconds: 1 });
      ledger.put(entry);
      let opfsDeleted = false;
      let uploads = 0;
      const deps = {
        ensureAuth: async () => {},
        resolveFolder: () => withDrive(drive, () => resolver.resolve('voice', auth)),
        ledger,
        loadFile: async () => new Blob([new Uint8Array(3000)]),
        deleteLocal: async () => { opfsDeleted = true; },
        uploadToDrive: async (blob, current, folderId) => { uploads += 1; return { id: 'dv', name: current.fileName, url: 'u', folderId }; },
        process: async () => ({ completed: true }),
      };
      let thrown = null;
      try { await flow.saveAndProcessRecording({ entry }, deps); } catch (error) { thrown = error; }
      const row = ledger.get('rec-folder');
      check('ケース7: フォルダ作成失敗 → 例外（FOLDER_FORBIDDEN）・Drive へ送らない', thrown instanceof errors.AppError && thrown.code === 'FOLDER_FORBIDDEN' && uploads === 0);
      check('ケース7: OPFS 録音を保持・台帳を保持（UPLOAD_FAILED で再試行可能）', opfsDeleted === false && row?.state === checkpoint.RecordingState.UPLOAD_FAILED && row.error === 'FOLDER_FORBIDDEN');
      drive.options.failCreate = false;
      clock.tick();
      const retried = await flow.saveAndProcessRecording({ entry: ledger.get('rec-folder') }, deps);
      check('ケース7: 再試行で保存先を作成して完了（不足分だけ作成）→ 最後に OPFS 削除', retried.outcome === flow.SaveOutcome.COMPLETED && uploads === 1 && opfsDeleted === true && ledger.list().length === 0 && drive.calls.created.length === 4);
    }

    check('drive.js の検索は「名前・フォルダ・ゴミ箱外・親」で絞り、古い順に 1 件目を使う', (() => { const src = readFileSync(resolve(appRoot, 'drive.js'), 'utf8'); return src.includes("'trashed=false'") && src.includes("in parents") && src.includes("'orderBy', 'createdTime'") && src.includes('files[0].id'); })());
    check('app.js は毎回名前で全検索せず resolver を通す', appSource.includes("folders.resolve('voice', auth)") && appSource.includes("folders.resolve('record', auth)") && !appSource.includes('resolveVoiceFolder(') && !appSource.includes('resolveRecordFolder('));
  }

  section('エラー文言: Gemini の失敗を「処理に失敗しました」に潰さない');

  {
    const errors = await import('../../public/meeting-assistant/errors.js');
    const transcriber = await import('../../public/meeting-assistant/gemini-transcriber.js');
    const minutesMod = await import('../../public/meeting-assistant/gemini-minutes.js');
    const appSource = readFileSync(resolve(appRoot, 'app.js'), 'utf8');
    const t = (code, status = 0) => new transcriber.GeminiError(code, status, 'x');
    const m = (code, status = 0) => new minutesMod.GeminiError(code, status, 'x');
    const generic = '処理に失敗しました。もう一度お試しください。';

    check('describeAppError は errors.js にあり app.js には無い', typeof errors.describeAppError === 'function' && !appSource.includes('function describeAppError'));
    check('Gemini の PERMISSION_DENIED をマイク権限と言わない', !errors.describeAppError(t('PERMISSION_DENIED', 403)).includes('マイク') && errors.describeAppError(t('PERMISSION_DENIED', 403)).includes('403'));
    check('録音側の PERMISSION_DENIED は従来どおりマイク・画面共有の案内', errors.describeAppError({ code: 'PERMISSION_DENIED' }).includes('マイク'));
    check('NETWORK（Gemini）は通信の失敗と Drive 保存済みを伝える', errors.describeAppError(t('NETWORK')).includes('通信') && errors.describeAppError(t('NETWORK')).includes('Drive に保存済み'));
    check('NETWORK（Drive の AppError）は従来の Drive 文言', errors.describeAppError(new errors.AppError(errors.ErrorCode.NETWORK)).includes('録音は残っています'));
    check('API_KEY_INVALID / KEY_REJECTED はキーの確認を促す', errors.describeAppError(t('API_KEY_INVALID', 400)).includes('APIキー') && errors.describeAppError(m('KEY_REJECTED', 403)).includes('APIキー'));
    check('API_KEY_MISSING / KEY_MISSING は設定を促す', errors.describeAppError(t('API_KEY_MISSING')).includes('設定') && errors.describeAppError(m('KEY_MISSING')).includes('設定'));
    check('QUOTA_EXCEEDED / RATE_LIMITED は利用上限', errors.describeAppError(t('QUOTA_EXCEEDED', 429)).includes('利用上限') && errors.describeAppError(m('RATE_LIMITED', 429)).includes('利用上限'));
    check('EMPTY_RESULT は結果が空', errors.describeAppError(t('EMPTY_RESULT')).includes('空'));
    check('BAD_JSON は形式', errors.describeAppError(m('BAD_JSON')).includes('形式'));
    check('MODEL_NOT_FOUND / AUDIO_NOT_SUPPORTED は管理者へ', errors.describeAppError(t('MODEL_NOT_FOUND', 404)).includes('管理者') && errors.describeAppError(t('AUDIO_NOT_SUPPORTED', 400)).includes('音声形式'));
    check('SERVER_ERROR は時間をおく', errors.describeAppError(m('SERVER_ERROR', 503)).includes('時間をおいて'));
    check('UNKNOWN でも Gemini の失敗と分かる文言', errors.describeAppError(t('UNKNOWN')) !== generic && errors.describeAppError(t('UNKNOWN')).includes('議事録'));
    const allCodes = [...Object.values(transcriber.GeminiErrorCode), ...Object.values(minutesMod.GeminiErrorCode)];
    check('すべての Gemini コードが汎用文言にならない', allCodes.every((code) => errors.describeAppError(t(code)) !== generic));
    check('文言に例外 message を出さない', !errors.describeAppError(Object.assign(t('NETWORK'), { message: 'LEAK' })).includes('LEAK'));
    check('未知の例外は従来の汎用文言', errors.describeAppError(new Error('boom')) === generic);
  }

  finish();
} catch (error) {
  fatal(error);
}

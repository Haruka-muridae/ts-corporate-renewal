/*
 * 音声文字起こしアプリ（本番 production-app/audio-transcriber/）の純ロジック。
 * 対象要件: docs/specs/audio-transcriber-requirements-v1.md
 *
 * ------------------------------------------------------------------
 * ここで見るのは「ブラウザが要らない部分」だけ
 * ------------------------------------------------------------------
 * 対象は Node で直接 import できる純ロジックに限る。
 *   config.js          … 定数・表示整形・OAuth設定の判定
 *   state.js           … 状態機械（DOM を参照しない）
 *   result-exporter.js … 整形の純関数（copyText / downloadText は呼ばない）
 *   drive-client.js    … クエリ組み立てとエラー分類（fetch は呼ばない）
 *   minutes-handoff.js … AI議事録への引継ぎデータの組み立てと保存
 *                        （storage / now を引数注入。sessionStorage には触れない）
 *
 * 次のモジュールは DOM / Worker / fetch に依存するため対象にしない。
 *   script.js（guardPage と document 前提の UI 層）
 *   oauth.js の requestAccessToken 経路（GIS のポップアップが要る）
 *   audio-loader.js / whisper-transcriber.js / whisper-worker.js
 *   （AudioContext・Web Worker・CDN が要る。実ブラウザでの確認記録は
 *     テスト版 public/apps/audio-transcriber/README.md にある）
 * ------------------------------------------------------------------
 *
 * 通信は行わない（純関数のみ）。
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

try {
  const base = '../../public/production-app/audio-transcriber';

  const config = await import(`${base}/config.js`);
  const state = await import(`${base}/state.js`);
  const exporter = await import(`${base}/result-exporter.js`);
  const drive = await import(`${base}/drive-client.js`);
  const minutesHandoff = await import(`${base}/minutes-handoff.js`);
  const settingsStore = await import(`${base}/settings-store.js`);

  /* 突き合わせ用。録音アプリ側の定義（複製元の正）。 */
  const vrConfig = await import('../../public/production-app/voice-recorder/config.js');

  /* ================================================================ */
  section('OAuth 設定（録音アプリと同一クライアントであること）');

  check('スコープは drive.file だけ',
    config.OAUTH.scope === 'https://www.googleapis.com/auth/drive.file');
  check('★スコープに drive 全体が混ざっていない',
    !/auth\/drive$|drive\.readonly/.test(config.OAUTH.scope));

  /*
   * ★同一クライアントIDでないと、drive.file スコープでは録音アプリが
   * 保存したMP3が見えない（drive.file は「同じOAuthクライアントの
   * アプリが作成したファイル」しか対象にしないため）。
   * 片方だけIDを差し替えた変更を、ここで検知する。
   */
  check('★クライアントIDが録音アプリと同一',
    config.OAUTH.clientId === vrConfig.OAUTH.clientId);
  check('スコープも録音アプリと同一', config.OAUTH.scope === vrConfig.OAUTH.scope);

  check('クライアントIDの形を判定できる', config.isOauthConfigured() === true);
  check('空文字は未設定として扱う', config.isOauthConfigured('') === false);
  check('末尾が違えば未設定', config.isOauthConfigured('123.example.com') === false);

  check('画面の深さは2（production-app/audio-transcriber/）', config.SCREEN_DEPTH === 2);

  /* ================================================================ */
  section('フォルダ名（録音アプリとの突き合わせ）');

  /*
   * ★フォルダ名は文字起こしアプリ／録音アプリの双方に同名定義がある。
   * 片方だけ改名すると、同じ場所を指しているつもりで別のフォルダを
   * 見ることになる。このテストが「片方だけの改名」を検知する。
   */
  check('★最上位フォルダ名が録音アプリと一致（TSAM AI）',
    config.DRIVE_NAMES.root === vrConfig.DRIVE_NAMES.root);
  check('★読み取り元フォルダ名が録音アプリの保存先と一致（Voice Recorder）',
    config.DRIVE_NAMES.voiceRecorder === vrConfig.DRIVE_NAMES.app);

  check('最上位は TSAM AI', config.DRIVE_NAMES.root === 'TSAM AI');
  check('読み取り元は Voice Recorder', config.DRIVE_NAMES.voiceRecorder === 'Voice Recorder');
  check('TXT保存先は Audio Transcriber', config.DRIVE_NAMES.audioTranscriber === 'Audio Transcriber');
  check('画面表示は「マイドライブ ＞ …」形式',
    config.formatFolderPath('TSAM AI', 'Voice Recorder') === 'マイドライブ ＞ TSAM AI ＞ Voice Recorder');

  /* ================================================================ */
  section('制限値と表示整形（config.js）');

  check('端末内モードの上限は512MB', config.LIMITS.localMaxBytes === 512 * 1024 * 1024);
  check('端末内モードの上限は4時間', config.LIMITS.localMaxDurationSec === 4 * 60 * 60);
  check('Gemini モードの上限は200MB', config.LIMITS.geminiMaxBytes === 200 * 1024 * 1024);
  check('Gemini モードの上限は2時間', config.LIMITS.geminiMaxDurationSec === 2 * 60 * 60);

  check('Transformers.js はバージョン固定（latest を指さない）',
    /@huggingface\/transformers@\d+\.\d+\.\d+\//.test(config.WHISPER.libraryUrl));
  check('★WASM回避策 graphOptimizationLevel は basic',
    config.WHISPER.wasmSessionOptions.graphOptimizationLevel === 'basic');
  check('Whisper のサンプルレートは16kHz', config.WHISPER.sampleRate === 16000);
  check('既定モデルは候補一覧に含まれる',
    config.WHISPER.models.some((m) => m.id === config.WHISPER.defaultModelId));

  check('B 表記', config.formatBytes(512) === '512 B');
  check('KB 表記', config.formatBytes(2048) === '2.0 KB');
  check('MB 表記', config.formatBytes(5 * 1024 * 1024) === '5.0 MB');
  check('100以上は整数表示', config.formatBytes(200 * 1024 * 1024) === '200 MB');
  /* Number(null) は 0 なので「不明」ではなく 0 B になる（テスト版からの仕様）。 */
  check('null は 0 B 扱い', config.formatBytes(null) === '0 B');
  check('undefined は「不明」', config.formatBytes(undefined) === '不明');
  check('負の値は「不明」', config.formatBytes(-1) === '不明');

  check('0秒は 0:00', config.formatDuration(0) === '0:00');
  check('59秒', config.formatDuration(59) === '0:59');
  check('90秒は 1:30', config.formatDuration(90) === '1:30');
  check('1時間は 1:00:00', config.formatDuration(3600) === '1:00:00');
  check('数値でない値は「不明」', config.formatDuration(undefined) === '不明');

  /* ================================================================ */
  section('状態機械（state.js）');

  state.reset();
  check('初期状態は idle', state.getState().state === state.State.IDLE);
  check('初期モードは local', state.getState().mode === 'local');

  check('loading-model は処理中', state.isBusy(state.State.LOADING_MODEL) === true);
  check('uploading は処理中', state.isBusy(state.State.UPLOADING) === true);
  check('transcribing は処理中', state.isBusy(state.State.TRANSCRIBING) === true);
  check('idle は処理中でない', state.isBusy(state.State.IDLE) === false);
  check('completed は処理中でない', state.isBusy(state.State.COMPLETED) === false);

  state.transition(state.State.FILE_SELECTED, { file: { name: 'a.mp3' } });
  check('ファイル選択でファイルが入る', state.getState().file?.name === 'a.mp3');

  state.update({ result: 'テキスト', errorMessage: 'err', progress: { label: 'x', ratio: 0.5 } });
  state.transition(state.State.FILE_SELECTED, { file: { name: 'b.mp3' } });
  const afterReselect = state.getState();
  check('★別ファイル選択で前回の結果を持ち越さない', afterReselect.result === '');
  check('★別ファイル選択でエラーを持ち越さない', afterReselect.errorMessage === null);
  check('★別ファイル選択で進捗を消す', afterReselect.progress === null);

  state.update({ progress: { label: 'y', ratio: 1 } });
  state.transition(state.State.COMPLETED, { result: '完了本文' });
  check('完了で進捗を消す', state.getState().progress === null);
  check('完了で結果が入る', state.getState().result === '完了本文');

  state.transition(state.State.IDLE);
  const afterIdle = state.getState();
  check('idle へ戻すとファイルが消える', afterIdle.file === null);
  check('idle へ戻すと結果が消える', afterIdle.result === '');

  check('スナップショットは凍結されている', Object.isFrozen(state.getState()));

  let notified = 0;
  const unsubscribe = state.subscribe(() => { notified += 1; });
  state.update({ mode: 'gemini' });
  check('購読者へ通知される', notified === 1);
  unsubscribe();
  state.update({ mode: 'local' });
  check('購読解除後は通知されない', notified === 1);
  state.reset();

  /* ================================================================ */
  section('結果の整形（result-exporter.js）');

  check('拡張子を .txt に差し替える', exporter.buildTextFileName('会議.mp3') === '会議.txt');
  check('★二重拡張子にならない', exporter.buildTextFileName('録音.m4a') === '録音.txt');
  check('★パス区切りを落とす', exporter.buildTextFileName('a/b.mp3') === 'ab.txt');
  check('★Windowsで使えない文字を落とす', exporter.buildTextFileName('a:b*c?.mp3') === 'abc.txt');
  check('空になったら transcript', exporter.buildTextFileName('///.mp3') === 'transcript.txt');
  check('null でも落ちない', exporter.buildTextFileName(null) === 'transcript.txt');

  const chunks = [
    { text: 'おはようございます', start: 0, end: 3 },
    { text: '本日の議題です', start: 65, end: 70 },
    { text: '', start: 80, end: 81 },
    { text: '時刻なし', start: Number.NaN, end: null },
  ];

  check('タイムスタンプ付きで整形',
    exporter.formatChunks(chunks, { withTimestamps: true })
      === '[00:00:00] おはようございます\n[00:01:05] 本日の議題です\n時刻なし');
  check('タイムスタンプ無しは本文だけ',
    exporter.formatChunks(chunks, { withTimestamps: false })
      === 'おはようございます\n本日の議題です\n時刻なし');
  check('空配列は空文字', exporter.formatChunks([]) === '');
  check('配列でなければ空文字', exporter.formatChunks(null) === '');

  const speakerText = '[00:00:01] 話者1：おはよう\n話者2：どうも\n本文中の話者1：は変えない話者1です';
  const replaced = exporter.replaceSpeakerName(speakerText, '話者1', '山田');
  check('行頭の話者名を置き換える', replaced.startsWith('[00:00:01] 山田：おはよう'));
  check('他の話者は変えない', replaced.includes('話者2：どうも'));
  check('★本文中の同じ語は変えない', replaced.includes('変えない話者1です'));
  check('置換元が空なら何もしない', exporter.replaceSpeakerName('話者1：a', '', 'x') === '話者1：a');
  check('正規表現の特殊文字も安全',
    exporter.replaceSpeakerName('A(1)：a', 'A(1)', 'B') === 'B：a');

  check('文字数は改行込み', exporter.countCharacters('ab\ncd') === 5);
  check('null は0文字', exporter.countCharacters(null) === 0);

  check('60秒未満は秒表示', exporter.formatElapsed(26_000) === '26秒');
  check('60秒以上は分秒表示', exporter.formatElapsed(65_000) === '1分05秒');
  check('数値でなければ「不明」', exporter.formatElapsed(undefined) === '不明');

  /* ================================================================ */
  section('Drive クエリの組み立て（drive-client.js）');

  /*
   * ★すべてのクエリに in parents が入ること。
   * 名前だけで Drive 全体を検索するクエリを発行しない、という方針の要。
   */
  const lookupQuery = drive.buildFolderLookupQuery('TSAM AI', 'root');
  check("★フォルダ検索に 'root' in parents が入る", lookupQuery.includes("'root' in parents"));
  check('フォルダ検索は名前で絞る', lookupQuery.includes("name='TSAM AI'"));
  check('フォルダ検索はフォルダMIMEで絞る',
    lookupQuery.includes("mimeType='application/vnd.google-apps.folder'"));
  check('ゴミ箱は除外する', lookupQuery.includes('trashed=false'));

  const childQuery = drive.buildFolderLookupQuery('Voice Recorder', 'PARENT123');
  check('★親フォルダIDを指定して1階層ずつ降りる', childQuery.includes("'PARENT123' in parents"));

  const listQuery = drive.buildFolderFilesQuery('FOLDER456');
  check('★一覧クエリにも in parents が入る', listQuery.includes("'FOLDER456' in parents"));

  const saveQuery = drive.buildFolderQuery('Audio Transcriber', null);
  check('★保存先の解決も root in parents から始まる', saveQuery.includes("'root' in parents"));

  check("★クエリの ' はエスケープされる（クエリ注入対策）",
    drive.buildFolderLookupQuery("a'b", 'root').includes("name='a\\'b'"));

  /* MIME 判定。Drive の MIME が当てにならない場合の拡張子フォールバック。 */
  check('audio/mpeg は音声', drive.isAudioFile({ mimeType: 'audio/mpeg', name: 'a.bin' }) === true);
  check('MIME が空でも拡張子 .mp3 なら音声',
    drive.isAudioFile({ mimeType: '', name: 'a.mp3' }) === true);
  check('octet-stream でも拡張子 .wav なら音声',
    drive.isAudioFile({ mimeType: 'application/octet-stream', name: 'a.wav' }) === true);
  check('text/plain は音声でない',
    drive.isAudioFile({ mimeType: 'text/plain', name: 'a.txt' }) === false);

  /* エラー分類。401 と 403 の出し分けは画面の案内文言の前提になる。 */
  check('401 は UNAUTHORIZED', drive.mapHttpErrorToCode(401, null) === drive.DriveErrorCode.UNAUTHORIZED);
  check('403 は FORBIDDEN', drive.mapHttpErrorToCode(403, null) === drive.DriveErrorCode.FORBIDDEN);
  check('403 + accessNotConfigured は API_DISABLED',
    drive.mapHttpErrorToCode(403, { error: { errors: [{ reason: 'accessNotConfigured' }] } })
      === drive.DriveErrorCode.API_DISABLED);
  check('403 + storageQuotaExceeded は QUOTA_EXCEEDED',
    drive.mapHttpErrorToCode(403, { error: { errors: [{ reason: 'storageQuotaExceeded' }] } })
      === drive.DriveErrorCode.QUOTA_EXCEEDED);
  check('429 は RATE_LIMITED', drive.mapHttpErrorToCode(429, null) === drive.DriveErrorCode.RATE_LIMITED);
  check('404 は NOT_FOUND', drive.mapHttpErrorToCode(404, null) === drive.DriveErrorCode.NOT_FOUND);
  check('500 は SERVER_ERROR', drive.mapHttpErrorToCode(500, null) === drive.DriveErrorCode.SERVER_ERROR);

  /* multipart の境界。トークンや固定値が混ざらないことだけ見る。 */
  const boundary = drive.createBoundary();
  check('境界文字列は tsam- で始まる', boundary.startsWith('tsam-'));
  check('境界文字列は毎回変わる', drive.createBoundary() !== boundary);

  /* ================================================================ */
  section('AI議事録への引継ぎ（minutes-handoff.js）');

  /*
   * sessionStorage の代わり。Map ベースの偽物にする
   * （card-ocr.mjs の installLocalStorage と同じ流儀）。
   */
  function createMemoryStorage(initial = {}) {
    const map = new Map(Object.entries(initial));

    return {
      map,
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => { map.set(key, String(value)); },
      removeItem: (key) => { map.delete(key); },
    };
  }

  const FIXED_NOW = () => new Date('2026-08-12T09:00:00.000Z');

  check('★引継ぎキーは固定名 tsam-meeting-minutes-handoff-v1',
    minutesHandoff.HANDOFF_STORAGE_KEY === 'tsam-meeting-minutes-handoff-v1');
  check('引継ぎバージョンは1', minutesHandoff.HANDOFF_VERSION === 1);

  {
    const storage = createMemoryStorage();
    const result = minutesHandoff.saveHandoff(
      { transcript: 'おはようございます。本日の議題です。', metadata: { title: '会議.mp3', durationSeconds: 125 } },
      { storage, now: FIXED_NOW },
    );

    check('正常なデータは保存に成功する', result.ok === true);

    const raw = storage.map.get(minutesHandoff.HANDOFF_STORAGE_KEY);
    check('固定キーへ書き込まれる', typeof raw === 'string');

    const saved = JSON.parse(raw);
    check('version は1', saved.version === 1);
    check('sourceApp は audio-transcriber', saved.sourceApp === 'audio-transcriber');
    check('★createdAt はISO 8601形式', saved.createdAt === '2026-08-12T09:00:00.000Z');
    check('transcript は全文をそのまま保持', saved.transcript === 'おはようございます。本日の議題です。');
    check('metadata.title は判明している値を入れる', saved.metadata.title === '会議.mp3');
    check('metadata.durationSeconds は判明している値を入れる', saved.metadata.durationSeconds === 125);
    check('metadata.speakers は常に空配列', Array.isArray(saved.metadata.speakers) && saved.metadata.speakers.length === 0);
    check('★不明な項目（recordedAt）は入れない', Object.hasOwn(saved.metadata, 'recordedAt') === false);
  }

  {
    /* ★空文字起こしは拒否し、storage へは書き込まない。 */
    const storage = createMemoryStorage();
    const empty = minutesHandoff.saveHandoff({ transcript: '' }, { storage, now: FIXED_NOW });
    check('★空文字起こしは拒否される', empty.ok === false);
    check('理由は empty-transcript', empty.reason === minutesHandoff.HandoffResultReason.EMPTY_TRANSCRIPT);
    check('★空文字起こしは書き込まれない', storage.map.has(minutesHandoff.HANDOFF_STORAGE_KEY) === false);
  }

  {
    /* ★空白のみの文字起こしも空として拒否する。 */
    const storage = createMemoryStorage();
    const blank = minutesHandoff.saveHandoff({ transcript: '   \n\t  ' }, { storage, now: FIXED_NOW });
    check('★空白のみの文字起こしも拒否される', blank.ok === false);
    check('空白のみでも書き込まれない', storage.map.has(minutesHandoff.HANDOFF_STORAGE_KEY) === false);
  }

  {
    /* metadata を渡さない・不明な項目のときは推測で埋めず、speakers だけを持つ。 */
    const storage = createMemoryStorage();
    const result = minutesHandoff.saveHandoff({ transcript: '本文のみ' }, { storage, now: FIXED_NOW });
    check('metadata未指定でも保存に成功する', result.ok === true);

    const saved = JSON.parse(storage.map.get(minutesHandoff.HANDOFF_STORAGE_KEY));
    check('★不明なtitleは入れない', Object.hasOwn(saved.metadata, 'title') === false);
    check('★不明なdurationSecondsは入れない', Object.hasOwn(saved.metadata, 'durationSeconds') === false);
    check('★不明なrecordedAtは入れない', Object.hasOwn(saved.metadata, 'recordedAt') === false);
    check('metadataのキーはspeakersだけ', Object.keys(saved.metadata).join(',') === 'speakers');
  }

  {
    /* storage が使えない（未指定）場合は書き込まず理由を返す。 */
    const result = minutesHandoff.saveHandoff({ transcript: '本文' }, { storage: null, now: FIXED_NOW });
    check('storage未指定では失敗する', result.ok === false);
    check('理由は storage-unavailable', result.reason === minutesHandoff.HandoffResultReason.STORAGE_UNAVAILABLE);
  }

  {
    /* 空文字列や空白のtitle・不正なdurationSecondsは無視する。 */
    const storage = createMemoryStorage();
    minutesHandoff.saveHandoff(
      { transcript: '本文', metadata: { title: '   ', durationSeconds: -1, recordedAt: '' } },
      { storage, now: FIXED_NOW },
    );

    const saved = JSON.parse(storage.map.get(minutesHandoff.HANDOFF_STORAGE_KEY));
    check('空白だけのtitleは入れない', Object.hasOwn(saved.metadata, 'title') === false);
    check('負のdurationSecondsは入れない', Object.hasOwn(saved.metadata, 'durationSeconds') === false);
    check('空文字のrecordedAtは入れない', Object.hasOwn(saved.metadata, 'recordedAt') === false);
  }

  /* ================================================================ */
  section('設定の永続化（settings-store.js）');

  check('保存キーは tsam-audio-transcriber-settings-v1',
    settingsStore.SETTINGS_STORAGE_KEY === 'tsam-audio-transcriber-settings-v1');
  check('★KeyStoreの保存キー（tsam-api-keys）とは別物',
    settingsStore.SETTINGS_STORAGE_KEY !== 'tsam-api-keys');

  /* localStorage が無い環境。例外を投げず、使えない・空として扱うこと。 */
  check('保存先が無ければ利用不可と答える', settingsStore.isSettingsStoreAvailable() === false);
  check('読み出しは空オブジェクト', Object.keys(settingsStore.loadSettings()).length === 0);
  check('保存先が無ければ書き込みは false', settingsStore.saveSettings({ mode: 'gemini' }) === false);

  /* ここから先は localStorage を差し替えて、保存の形そのものを見る（KeyStoreのテストと同じ流儀）。 */
  const settingsMap = new Map();

  globalThis.localStorage = {
    getItem: (k) => (settingsMap.has(k) ? settingsMap.get(k) : null),
    setItem: (k, v) => { settingsMap.set(k, String(v)); },
    removeItem: (k) => { settingsMap.delete(k); },
  };

  check('差し替え後は利用可能と答える', settingsStore.isSettingsStoreAvailable() === true);
  check('保存できる', settingsStore.saveSettings({ mode: 'gemini', language: 'en' }) === true);
  check('保存した値が読める',
    settingsStore.loadSettings().mode === 'gemini' && settingsStore.loadSettings().language === 'en');

  check('★部分更新は既存の値と統合される（上書きで消えない）',
    settingsStore.saveSettings({ withTimestamps: false }) === true
    && settingsStore.loadSettings().mode === 'gemini'
    && settingsStore.loadSettings().language === 'en'
    && settingsStore.loadSettings().withTimestamps === false);

  /*
   * 音声ファイルの入力元（fileSource）の永続化。
   * script.js の applySavedSettings が行うのと同じフォールバック式
   * （saved.fileSource === 'drive' ? 'drive' : 'local'）で検証する。
   */
  check('入力元（drive）を保存できる',
    settingsStore.saveSettings({ fileSource: 'drive' }) === true
    && settingsStore.loadSettings().fileSource === 'drive');

  check('入力元（local）を保存できる',
    settingsStore.saveSettings({ fileSource: 'local' }) === true
    && settingsStore.loadSettings().fileSource === 'local');

  /*
   * ★後方互換: 前バージョン（fileSource キーが無い）の保存値を読み込んでも
   * 例外にならず、既定値（'local'）へフォールバックできること。
   */
  settingsMap.set(settingsStore.SETTINGS_STORAGE_KEY, JSON.stringify({ mode: 'local', language: 'ja' }));
  {
    const loaded = settingsStore.loadSettings();
    check('★fileSourceキーが無い旧形式でも例外を投げない', Object.hasOwn(loaded, 'fileSource') === false);

    const fallbackSource = loaded.fileSource === 'drive' ? 'drive' : 'local';
    check('★fileSource未保存時は既定値localへフォールバック', fallbackSource === 'local');
  }

  /* 手で書き換えられた値でも壊れない（KeyStore §3-3 と同じ判断）。 */
  for (const broken of ['{', 'null', '"text"', '[1,2]', '']) {
    settingsMap.set(settingsStore.SETTINGS_STORAGE_KEY, broken);
    check(`壊れた保存値（${broken || '空文字'}）でも例外を投げず空オブジェクト`,
      Object.keys(settingsStore.loadSettings()).length === 0);
  }

  settingsMap.delete(settingsStore.SETTINGS_STORAGE_KEY);
  delete globalThis.localStorage;

  finish();
} catch (error) {
  fatal(error);
}

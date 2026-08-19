/*
 * 面談録音アプリ（本番 production-app/interview-recorder/）の config.js と
 * filename.js。対象要件: docs/specs/interview-recorder-requirements-v1.md（§4 / §5 / §10）
 *
 * ------------------------------------------------------------------
 * ここで見るのは「ブラウザが要らない部分」だけ
 * ------------------------------------------------------------------
 * 対象は config.js の公開値と filename.js の純粋な文字列処理のみ。
 * app.js は document / navigator.mediaDevices / AudioWorklet 等の実ブラウザ
 * 機能に強く依存し、Node からは直接 import できない（音声文字起こしアプリの
 * script.js と同じ理由。audio-transcriber.mjs の冒頭コメントを参照）。
 * oauth.js / drive.js も実際の通信と GIS が要るため、ここでは扱わない。
 *
 * 録音ロジック・同意ゲート・状態機械そのものの検証、および Drive への
 * 実アップロードは、実ブラウザでの動作確認に委ねる（要件定義書 §10-3）。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * ブラウザ録音アプリとの一致をここで固定する（v1.1 で追加）
 * ------------------------------------------------------------------
 * 面談録音アプリは、ブラウザ録音アプリ（voice-recorder）と **同じ Drive
 * フォルダへ、同じクライアントIDで** MP3 を書き込む。oauth.js / drive.js /
 * filename.js は複製であり import ではないため、片方だけ値が動いても
 * 誰も気づかない。気づかないまま公開すると次のどちらかが起きる。
 *   - フォルダ名がずれる  … 別フォルダが増え、文字起こしアプリから見えない
 *   - クライアントIDがずれる … drive.file の可視範囲が分かれ、同名フォルダを
 *                              見つけられず新規作成してしまう
 * そこで **両方の config.js を読み比べる**テストをここに置く。
 * ------------------------------------------------------------------
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

try {
  const base = '../../public/production-app/interview-recorder';

  const config = await import(`${base}/config.js`);
  const filename = await import(`${base}/filename.js`);

  /* 比較対象。こちらは値を読むだけで、変更の起点にはしない。 */
  const voiceRecorder = await import('../../public/production-app/voice-recorder/config.js');

  /* ================================================================ */
  section('画面の深さ');

  check('画面の深さは2（production-app/interview-recorder/）', config.SCREEN_DEPTH === 2);

  /* ================================================================ */
  section('§4 MP3 エンコード設定');

  check('MP3ビットレートは128kbps（voice-recorder と同一）', config.MP3_BITRATE_KBPS === 128);
  check(
    '★ビットレートが voice-recorder（§FR-06）と一致している',
    config.MP3_BITRATE_KBPS === voiceRecorder.BITRATE_KBPS,
    `interview=${config.MP3_BITRATE_KBPS} / voice=${voiceRecorder.BITRATE_KBPS}`,
  );

  check(
    'PCMフラッシュ単位はMP3の1フレーム（1152サンプル）の倍数',
    Number.isInteger(config.PCM_FLUSH_SAMPLES / 1152),
  );
  check('PCMフラッシュ単位は移植元と同じ1152*8', config.PCM_FLUSH_SAMPLES === 1152 * 8);

  check(
    'AudioWorkletのURLは同一オリジンの相対パス（外部URLではない）',
    typeof config.MP3_WORKLET_URL === 'string'
    && config.MP3_WORKLET_URL !== ''
    && !/^https?:\/\//.test(config.MP3_WORKLET_URL),
  );

  check(
    'ミックス時のソースゲインは0より大きく1以下（クリッピング対策で1未満）',
    typeof config.MIX_SOURCE_GAIN === 'number'
    && config.MIX_SOURCE_GAIN > 0
    && config.MIX_SOURCE_GAIN <= 1,
  );

  /* ================================================================ */
  section('§4 OAuth（スコープは drive.file だけ）');

  check(
    'クライアントIDの形が正しい',
    config.isOauthConfigured() === true
    && config.OAUTH.clientId.endsWith('.apps.googleusercontent.com'),
  );
  check('空文字は未設定として扱う', config.isOauthConfigured('') === false);
  check('末尾が違えば未設定', config.isOauthConfigured('123.example.com') === false);

  check(
    '★クライアントIDが voice-recorder と同一（drive.file の可視範囲を共有するため）',
    config.OAUTH.clientId === voiceRecorder.OAUTH.clientId,
  );

  check(
    'スコープは drive.file だけ',
    config.OAUTH.scope === 'https://www.googleapis.com/auth/drive.file',
  );
  check(
    '★スコープに drive 全体が混ざっていない',
    !/auth\/drive$|drive\.readonly/.test(config.OAUTH.scope),
  );
  check('スコープが voice-recorder と一致している', config.OAUTH.scope === voiceRecorder.OAUTH.scope);

  check(
    'Drive の宛先は googleapis.com のみ（当社ドメインを含まない）',
    config.GOOGLE_API.driveFiles.startsWith('https://www.googleapis.com/')
    && config.GOOGLE_API.driveUpload.startsWith('https://www.googleapis.com/'),
  );

  /* ================================================================ */
  section('§4 保存先フォルダ（voice-recorder と同一でなければならない）');

  check('保存先の最上位は TSAM AI', config.DRIVE_NAMES.root === 'TSAM AI');
  check('保存先は Voice Recorder', config.DRIVE_NAMES.app === 'Voice Recorder');

  check(
    '★最上位フォルダ名が voice-recorder と一致している',
    config.DRIVE_NAMES.root === voiceRecorder.DRIVE_NAMES.root,
    `interview=${config.DRIVE_NAMES.root} / voice=${voiceRecorder.DRIVE_NAMES.root}`,
  );
  check(
    '★保存先フォルダ名が voice-recorder と一致している',
    config.DRIVE_NAMES.app === voiceRecorder.DRIVE_NAMES.app,
    `interview=${config.DRIVE_NAMES.app} / voice=${voiceRecorder.DRIVE_NAMES.app}`,
  );

  check(
    '画面表示は「マイドライブ ＞ …」形式',
    config.formatFolderPath('TSAM AI', 'Voice Recorder') === 'マイドライブ ＞ TSAM AI ＞ Voice Recorder',
  );

  /* ================================================================ */
  section('§4 ファイル名');

  /* 2026-08-19 14:30:00（ローカル日時）。voice-recorder と同じ書式であること。 */
  const sample = new Date(2026, 7, 19, 14, 30, 0);

  check(
    '初期値は YYYYMMDD_HHmmss_面談録音.mp3',
    filename.buildDefaultFileName(sample) === '20260819_143000_面談録音.mp3',
    filename.buildDefaultFileName(sample),
  );
  check(
    '書式（8桁_6桁_接尾辞.mp3）が崩れていない',
    /^\d{8}_\d{6}_面談録音\.mp3$/.test(filename.buildDefaultFileName(sample)),
  );

  check('1桁の月日・時分秒は0詰め',
    filename.buildDefaultFileName(new Date(2026, 0, 3, 9, 5, 3)) === '20260103_090503_面談録音.mp3');

  /* ================================================================ */
  section('§4-2 面談相手名（v1.2）');

  /*
   * 相手名は「日時の直後」へ入る（voice-recorder の label と同じ位置）。
   * ただし接尾辞 `_面談録音` は残す。ここが複製元と唯一違うところで、
   * 残さないと相手名を入れた瞬間に voice-recorder の出力と見分けが
   * つかなくなる（同じフォルダに並ぶため）。
   */
  check(
    '相手名は日時の直後に入り、接尾辞は残る',
    filename.buildDefaultFileName(sample, '田中様') === '20260819_143000_田中様_面談録音.mp3',
    filename.buildDefaultFileName(sample, '田中様'),
  );
  check(
    '★相手名を入れても voice-recorder の出力と衝突しない（接尾辞が残る）',
    filename.buildDefaultFileName(sample, '田中様')
    !== `20260819_143000_田中様${config.FILE_EXTENSION}`,
  );
  check('相手名が空なら初期値のまま',
    filename.buildDefaultFileName(sample, '') === '20260819_143000_面談録音.mp3');
  check('相手名が空白だけなら初期値のまま',
    filename.buildDefaultFileName(sample, '   ') === '20260819_143000_面談録音.mp3');
  check('相手名が未指定でも落ちない',
    filename.buildDefaultFileName(sample, undefined) === '20260819_143000_面談録音.mp3');
  check('相手名のパス区切りは落とす（記号や空白は落とさない）',
    filename.buildDefaultFileName(sample, 'A/B\\C 株式会社') === '20260819_143000_ABC 株式会社_面談録音.mp3',
    filename.buildDefaultFileName(sample, 'A/B\\C 株式会社'));
  /* 改行・タブ等を貼り付けられた場合。エスケープで明示的に混ぜる。 */
  check('相手名の制御文字・改行・タブは落とす',
    filename.buildDefaultFileName(sample, '田\u0001中\t様\n') === '20260819_143000_田中様_面談録音.mp3',
    filename.buildDefaultFileName(sample, '田\u0001中\t様\n'));

  /* ================================================================ */
  section('§4-2 ファイル名の編集（v1.2）');

  const fallback = filename.buildDefaultFileName(sample);

  check('編集した名前をそのまま使う',
    filename.resolveFileName('面談メモ.mp3', fallback) === '面談メモ.mp3');
  check('拡張子が無ければ .mp3 を付ける',
    filename.resolveFileName('面談メモ', fallback) === '面談メモ.mp3');
  check('大文字の .MP3 は拡張子ありとみなす',
    filename.resolveFileName('面談メモ.MP3', fallback) === '面談メモ.MP3');
  check('空欄なら初期値へ戻す',
    filename.resolveFileName('', fallback) === fallback);
  check('空白だけなら初期値へ戻す',
    filename.resolveFileName('   ', fallback) === fallback);
  check('null / undefined でも初期値へ戻す',
    filename.resolveFileName(null, fallback) === fallback
    && filename.resolveFileName(undefined, fallback) === fallback);
  check('使えない文字だけなら初期値へ戻す',
    filename.resolveFileName('///', fallback) === fallback);
  check('パス区切りは落とし、ドットと空白は残す',
    filename.resolveFileName('2026/08/19 面談.mp3', fallback) === '20260819 面談.mp3');
  check('前後の空白は落とす',
    filename.resolveFileName('  面談メモ.mp3  ', fallback) === '面談メモ.mp3');

  check('ensureExtension は単体でも使える',
    filename.ensureExtension('a') === 'a.mp3' && filename.ensureExtension('a.mp3') === 'a.mp3');

  /* ================================================================ */
  section('§4-2 WebM・JSON は編集後の名前に追随する（v1.2）');

  const edited = filename.resolveFileName('田中様 一次面談', fallback);

  check('編集した MP3 名', edited === '田中様 一次面談.mp3');
  check('JSON は同じベース名 + .json',
    filename.withExtension(edited, config.JSON_EXTENSION) === '田中様 一次面談.json');
  check('WebM は同じベース名 + .webm',
    filename.withExtension(edited, config.WEBM_EXTENSION) === '田中様 一次面談.webm');
  check('初期値からでも同じ関係が成り立つ',
    filename.withExtension(fallback, config.JSON_EXTENSION) === '20260819_143000_面談録音.json'
    && filename.withExtension(fallback, config.WEBM_EXTENSION) === '20260819_143000_面談録音.webm');
  check('名前の途中のドットは残す（最後の拡張子だけ差し替える）',
    filename.withExtension('面談 v1.2.mp3', config.JSON_EXTENSION) === '面談 v1.2.json');
  check('拡張子が無い名前はそのまま stem として扱う',
    filename.withExtension('面談メモ', config.WEBM_EXTENSION) === '面談メモ.webm');

  /*
   * 同じフォルダへ2つのアプリが書き込むため、接尾辞まで同じにすると
   * 一覧でどちらの録音か分からなくなる（§4 の判断）。
   */
  check(
    '★接尾辞は voice-recorder の「_録音」と区別できる',
    config.FILE_NAME_SUFFIX === '_面談録音'
    && config.FILE_NAME_SUFFIX !== voiceRecorder.FILE_NAME_SUFFIX,
  );
  check('拡張子は .mp3（Drive へ置くのは MP3 のみ）', config.FILE_EXTENSION === '.mp3');
  check('拡張子が voice-recorder と一致している', config.FILE_EXTENSION === voiceRecorder.FILE_EXTENSION);
  check('MP3 の MIME は audio/mpeg', config.MP3_MIME === 'audio/mpeg');

  /* ================================================================ */
  section('§4-2 同名時の連番');

  check('連番は拡張子の前へ入る', filename.withSequence('20260819_143000_面談録音.mp3', 2)
    === '20260819_143000_面談録音_2.mp3');
  check('1以下では連番を付けない', filename.withSequence('a.mp3', 1) === 'a.mp3');
  check('拡張子が無ければ末尾へ付ける', filename.withSequence('name', 3) === 'name_3');

  /* 編集した名前でも連番が効くこと（v1.2。drive.js の pickAvailableName が使う）。 */
  check('★編集した名前にも連番が付く',
    filename.withSequence(edited, 2) === '田中様 一次面談_2.mp3');
  check('★相手名入りの初期値にも連番が付く',
    filename.withSequence(filename.buildDefaultFileName(sample, '田中様'), 3)
    === '20260819_143000_田中様_面談録音_3.mp3');
} catch (error) {
  fatal(error);
}

finish();

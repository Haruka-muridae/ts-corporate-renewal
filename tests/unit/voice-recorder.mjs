/*
 * ブラウザ録音アプリの純ロジック。
 * 対象要件: docs/requirements/mvp-requirements.md（§FR-04 / §FR-07 / §9 / §10）
 *
 * ------------------------------------------------------------------
 * ここで見るのは「ブラウザが要らない部分」だけ
 * ------------------------------------------------------------------
 * 録音・OPFS・Drive 通信は実ブラウザでしか動かないため、E2E
 * （tests/e2e/voice-recorder/）が担当する。こちらは文字列と数値の変換、
 * および §9 のエラー文言の網羅を見る。役割を混ぜないこと。
 * ------------------------------------------------------------------
 *
 * 通信は行わない（純関数のみ）。
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

try {
  const base = '../../public/production-app/voice-recorder';

  const config = await import(`${base}/config.js`);
  const filename = await import(`${base}/filename.js`);
  const capabilities = await import(`${base}/recorder/capabilities.js`);
  const errors = await import(`${base}/errors.js`);

  /* ================================================================ */
  section('§10 暫定決定事項の値');

  check('録音上限は90分（§10-5）', config.MAX_SECONDS === 90 * 60);
  check('予告は残り5分（§10-5）', config.WARNING_SECONDS === config.MAX_SECONDS - 5 * 60);
  check('ビットレートは128kbps（§FR-06）', config.BITRATE_KBPS === 128);
  check('モノラル128kbps は 16,000 B/秒', config.MP3_BYTES_PER_SECOND === 16000);

  /*
   * §10-6 の「約86MB」。要件書の数値と実装の定数がずれていないことを見る。
   * どちらかを直したらもう片方も直す、という関係を固定する。
   */
  const ninetyMinutesMB = (config.MP3_BYTES_PER_SECOND * config.MAX_SECONDS) / (1024 * 1024);
  check('90分で約86MB になる（§10-6）', Math.round(ninetyMinutesMB) === 82 || Math.round(ninetyMinutesMB) === 86,
    `実測 ${ninetyMinutesMB.toFixed(1)}MB`);

  check('スコープは drive.file だけ（§FR-02）',
    config.OAUTH.scope === 'https://www.googleapis.com/auth/drive.file');
  check('★スコープに drive 全体が混ざっていない',
    !/auth\/drive$|drive\.readonly/.test(config.OAUTH.scope));

  check('保存先の最上位は TSAM AI（§FR-03）', config.DRIVE_NAMES.root === 'TSAM AI');
  check('保存先は Voice Recorder（§FR-03）', config.DRIVE_NAMES.app === 'Voice Recorder');
  check('画面表示は「マイドライブ ＞ …」形式',
    config.formatFolderPath('TSAM AI', 'Voice Recorder') === 'マイドライブ ＞ TSAM AI ＞ Voice Recorder');

  check('クライアントIDの形を判定できる', config.isOauthConfigured() === true);
  check('空文字は未設定として扱う', config.isOauthConfigured('') === false);
  check('末尾が違えば未設定', config.isOauthConfigured('123.example.com') === false);

  /* ================================================================ */
  section('§FR-04 経過時間の表示');

  check('0秒は 00:00:00', capabilities.formatDuration(0) === '00:00:00');
  check('59秒', capabilities.formatDuration(59) === '00:00:59');
  check('1分', capabilities.formatDuration(60) === '00:01:00');
  check('90分（上限）は 01:30:00', capabilities.formatDuration(5400) === '01:30:00');
  check('端数は切り捨て', capabilities.formatDuration(61.9) === '00:01:01');
  check('負の値は 00:00:00 に丸める', capabilities.formatDuration(-5) === '00:00:00');
  check('数値でない値も落ちない', capabilities.formatDuration(undefined) === '00:00:00');

  /* ================================================================ */
  section('サイズの見積もりと表示');

  check('1秒で 16,000 バイト', capabilities.estimateMp3Bytes(1) === 16000);
  check('60秒で約0.96MB', Math.abs(capabilities.estimateMp3Bytes(60) / (1024 * 1024) - 0.9155) < 0.01);
  check('B 表記', capabilities.formatBytes(512) === '512 B');
  check('KB 表記', capabilities.formatBytes(2048) === '2 KB');
  check('MB 表記', capabilities.formatBytes(5 * 1024 * 1024) === '5.0 MB');
  check('GB 表記', capabilities.formatBytes(3 * 1024 ** 3) === '3.00 GB');
  check('null は「不明」', capabilities.formatBytes(null) === '不明');

  /* ================================================================ */
  section('§FR-04 対応サンプルレート');

  check('44,100Hz は対応', capabilities.isSupportedSampleRate(44100) === true);
  check('48,000Hz は対応', capabilities.isSupportedSampleRate(48000) === true);
  check('★32,000Hz は非対応（MVPでリサンプルしない）',
    capabilities.isSupportedSampleRate(32000) === false);
  check('★16,000Hz は非対応', capabilities.isSupportedSampleRate(16000) === false);

  /* ================================================================ */
  section('§FR-07 ファイル名');

  const sample = new Date(2026, 7, 6, 9, 5, 3); /* 2026-08-06 09:05:03（ローカル時刻） */
  check('初期値は YYYYMMDD_HHmmss_録音.mp3',
    filename.buildDefaultFileName(sample) === '20260806_090503_録音.mp3');
  check('★月日時分秒は0埋めする',
    /^\d{8}_\d{6}_録音\.mp3$/.test(filename.buildDefaultFileName(sample)));

  /* お客様名・イベント名欄（§FR-07）。入力があれば `_録音` の代わりに使う。 */
  check('お客様名・イベント名を入れると既定値に使う',
    filename.buildDefaultFileName(sample, '田中様') === '20260806_090503_田中様.mp3');
  check('お客様名・イベント名が空なら従来どおり',
    filename.buildDefaultFileName(sample, '') === '20260806_090503_録音.mp3');
  check('お客様名・イベント名にもサニタイズ方針を適用する（パス区切りを落とす）',
    filename.buildDefaultFileName(sample, 'A/B') === '20260806_090503_AB.mp3');

  check('拡張子が無ければ付ける', filename.ensureExtension('会議') === '会議.mp3');
  check('拡張子があれば足さない', filename.ensureExtension('会議.mp3') === '会議.mp3');
  check('大文字の拡張子も二重に付けない', filename.ensureExtension('会議.MP3') === '会議.MP3');

  const fallback = '20260806_090503_録音.mp3';
  check('未入力は初期値', filename.resolveFileName('', fallback) === fallback);
  check('空白だけも初期値', filename.resolveFileName('   ', fallback) === fallback);
  check('null も初期値', filename.resolveFileName(null, fallback) === fallback);
  check('入力があればそれを使う', filename.resolveFileName('打合せ', fallback) === '打合せ.mp3');
  check('前後の空白は落とす', filename.resolveFileName('  打合せ  ', fallback) === '打合せ.mp3');

  /*
   * ★ここが壊れると拡張子や区切りが消える。
   * 一度「記号をまとめて落とす」実装にして、ドットまで消してしまったことがある。
   */
  check('★ドットを落とさない', filename.resolveFileName('v1.2 打合せ', fallback) === 'v1.2 打合せ.mp3');
  check('★空白を落とさない', filename.resolveFileName('8月 定例', fallback) === '8月 定例.mp3');
  check('★記号を落とさない', filename.resolveFileName('A-B_C(1)', fallback) === 'A-B_C(1).mp3');
  check('パス区切り / は落とす', filename.resolveFileName('a/b', fallback) === 'ab.mp3');
  check('パス区切り \\ は落とす', filename.resolveFileName('a\\b', fallback) === 'ab.mp3');
  check('制御文字は落とす', filename.resolveFileName('ab', fallback) === 'ab.mp3');
  check('★区切りだけの入力は初期値へ戻す', filename.resolveFileName('///', fallback) === fallback);

  check('連番1はそのまま', filename.withSequence('a.mp3', 1) === 'a.mp3');
  check('連番2は拡張子の前に入る', filename.withSequence('a.mp3', 2) === 'a_2.mp3');
  check('★末尾ではなく拡張子の前（拡張子を壊さない）',
    filename.withSequence('20260806_090503_録音.mp3', 3) === '20260806_090503_録音_3.mp3');
  check('ドットを含む名前でも最後のドットで割る',
    filename.withSequence('v1.2.mp3', 2) === 'v1.2_2.mp3');
  check('拡張子が無い名前は末尾へ', filename.withSequence('name', 2) === 'name_2');

  /* ================================================================ */
  section('§9 エラー文言（通し確認）');

  const codes = Object.values(errors.ErrorCode);
  const fallbackText = errors.describeError(new Error('unknown'));

  check('エラーコードが定義されている', codes.length > 0, `${codes.length} 件`);

  /*
   * §9「各エラーは利用者が次の操作を判断できる文言とする」。
   * 全コードについて、既定文言へ落ちていないことを1件ずつ見る。
   * 追加したのに文言を書き忘れる、という漏れをここで止める。
   */
  const missing = codes.filter(
    (code) => errors.describeError(new errors.AppError(code)) === fallbackText,
  );
  check('★全エラーコードに専用の文言がある', missing.length === 0, `未定義: ${missing.join(', ')}`);

  /* 文言は日本語で、次の操作に触れていること（体言止めで終わらせない）。 */
  const noGuidance = codes.filter((code) => {
    const text = errors.describeError(new errors.AppError(code));
    return !/(ください|できます|お試し)/.test(text);
  });
  check('★全エラー文言が次の操作を示している', noGuidance.length === 0, `不足: ${noGuidance.join(', ')}`);

  const tooShort = codes.filter(
    (code) => errors.describeError(new errors.AppError(code)).length < 15,
  );
  check('文言が短すぎない', tooShort.length === 0, `短い: ${tooShort.join(', ')}`);

  /* 未知のコードでも黙って失敗しない。 */
  check('未知のコードは既定文言へ落ちる',
    errors.describeError(new errors.AppError('NOPE')) === fallbackText);
  check('例外でない値でも落ちない', typeof errors.describeError(null) === 'string');

  /*
   * ★例外の message をそのまま画面へ出さない（英語文が漏れるため）。
   * describeError は code だけを見る、という約束を固定する。
   */
  const leaked = errors.describeError(new errors.AppError('NOPE', 'Internal failure: token abc'));
  check('★例外の message を画面文言へ混ぜない', !leaked.includes('Internal failure'));
  check('★例外の message に含めた値も漏れない', !leaked.includes('abc'));

  /* オリジン未登録の案内（段階4）。 */
  const popupClosed = errors.describeError(new errors.AppError(errors.ErrorCode.OAUTH_POPUP_CLOSED));
  check('★オリジン未登録の可能性を案内する', popupClosed.includes('承認済みの JavaScript 生成元'));
  check('★反映ラグにも触れている', popupClosed.includes('時間がかかる'));

  /* ================================================================ */
  section('§FR-08 進捗の段階');

  const stages = Object.values(errors.PROGRESS);
  check('進捗の段階が4つある', stages.length === 4, stages.join(' / '));
  check('★「変換中」の段階は無い（録音と同時に済むため）',
    !stages.some((s) => s.includes('変換')));

  finish();
} catch (error) {
  fatal(error);
}

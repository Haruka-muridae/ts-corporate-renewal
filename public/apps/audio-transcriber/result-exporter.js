/*
 * 文字起こし結果の書き出し（コピー / TXTダウンロード / 整形）。
 *
 * 純粋な関数と、クリップボード・ダウンロードの薄い包みだけを置く。
 * 画面文言と状態管理はここに置かない。
 */

/* ---------- ファイル名 ---------- */

/*
 * 元の音声ファイル名から TXT のファイル名を作る。
 *
 * 拡張子を .txt に差し替えるだけだが、
 * ファイル名は外部入力（Drive の表示名など）なので、
 * 保存先で問題になる文字とパス区切りを必ず落とす。
 */
export function buildTextFileName(sourceName) {
  /*
   * パス区切りで切り詰めないのは、Drive の表示名に「/」を含められるため。
   * 「A/B.mp3」を「B.txt」にしてしまうと、元の名前が分からなくなる。
   * 区切り文字は下の除去でまとめて落とすので、ディレクトリ移動には使えない。
   */
  const base = String(sourceName ?? '')
    .replace(/\.[^.]+$/, '')
    /* Windows / macOS のどちらでも使えない文字と制御文字を除く。 */
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

  return `${base === '' ? 'transcript' : base}.txt`;
}

/* ---------- 整形 ---------- */

function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value) => String(value).padStart(2, '0');

  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
}

/*
 * タイムスタンプ付きの本文を組み立てる。
 *
 * chunks は whisper-transcriber.js が返す [{ text, start, end }]。
 * start が取れなかった要素は時刻を付けずにそのまま並べる。
 */
export function formatChunks(chunks, { withTimestamps = true } = {}) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return '';
  }

  return chunks
    .map((chunk) => {
      const text = String(chunk?.text ?? '').trim();

      if (text === '') {
        return '';
      }

      if (!withTimestamps || !Number.isFinite(chunk?.start)) {
        return text;
      }

      return `[${formatTimestamp(chunk.start)}] ${text}`;
    })
    .filter((line) => line !== '')
    .join('\n');
}

/*
 * 「話者1」などの表記をまとめて置き換える。
 *
 * 置換対象は行頭または「：」直前に現れる話者名に限る。
 * 本文中の同じ文字列まで巻き込むと、内容が変わってしまう。
 */
export function replaceSpeakerName(text, from, to) {
  const source = String(from ?? '').trim();
  const target = String(to ?? '').trim();

  if (source === '' || target === '') {
    return text;
  }

  /* 正規表現の特殊文字を無効化してから使う。 */
  const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|\\n)(\\[[^\\]]*\\]\\s*)?${escaped}(?=\\s*[:：])`, 'g');

  return String(text ?? '').replace(pattern, (match, lineStart, timestamp) => (
    `${lineStart}${timestamp ?? ''}${target}`
  ));
}

/* 文字数。改行も1文字として数える（textarea の見え方に合わせる）。 */
export function countCharacters(text) {
  return String(text ?? '').length;
}

export function formatElapsed(milliseconds) {
  const seconds = Math.round(Number(milliseconds) / 1000);

  if (!Number.isFinite(seconds) || seconds < 0) {
    return '不明';
  }

  if (seconds < 60) {
    return `${seconds}秒`;
  }

  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;

  return `${minutes}分${String(rest).padStart(2, '0')}秒`;
}

/* ---------- コピー ---------- */

/*
 * クリップボードへ書き込む。
 *
 * navigator.clipboard は安全なコンテキスト（HTTPS / localhost）でしか使えない。
 * 使えない環境では false を返し、呼び出し側が「手動で選択してコピー」を案内する。
 */
export async function copyText(text) {
  if (!navigator.clipboard?.writeText) {
    return false;
  }

  try {
    await navigator.clipboard.writeText(String(text ?? ''));
    return true;
  } catch {
    /* 権限が拒否された場合など。原因は利用者側では直せないので詳細は問わない。 */
    return false;
  }
}

/* ---------- ダウンロード ---------- */

/*
 * TXT として保存する。
 *
 * Blob へ文字列を渡した時点で UTF-8 になる。BOM は付けない
 * （付けると一部の環境で先頭に不可視文字が入るため）。
 *
 * オブジェクトURLはクリック直後に解放する。
 * 同期的に revoke するとダウンロードが始まらない環境があるため、
 * 次のタスクへ回してから解放する。
 */
export function downloadText(text, fileName) {
  const blob = new Blob([String(text ?? '')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();

  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

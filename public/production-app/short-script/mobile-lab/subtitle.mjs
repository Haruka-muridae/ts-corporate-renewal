/*
 * ASS字幕生成。/workspace/ai-video-app/lib/subtitle.ts の複製。
 *
 * ------------------------------------------------------------------
 * なぜ import せず複製するか
 * ------------------------------------------------------------------
 * ai-video-app は別リポジトリで、本番配信物からは参照できない
 * （docs/repository-structure.md §4-1 の「プロジェクト間 import はしない」）。
 * chunkText / wrapChunk / buildAss は DOM 非依存の純関数であり、
 * TypeScript の型注釈を落とすだけで本アプリでもそのまま動く。
 *
 * PC版（ai-video-app）と挙動を一致させるため、ロジックは書き換えない。
 * 変更したいことがあっても、まず ai-video-app 側を直し、その後に
 * ここへ同じ変更を複製すること（乖離すると字幕の見た目が版によって
 * 変わってしまう。docs/specs/short-script-mobile-video-plan-v1.md §6）。
 * ------------------------------------------------------------------
 */

const MAX_CHARS_PER_LINE = 13; // 1080px幅・フォント72px想定での安全値
const MAX_LINES = 2;
const MAX_CHARS_PER_CHUNK = MAX_CHARS_PER_LINE * MAX_LINES;

/** 句読点を優先しつつ、最大文字数でテキストを分割する */
export function chunkText(text, maxLen = MAX_CHARS_PER_CHUNK) {
  const normalized = text.replace(/\s+/g, '');
  if (normalized.length <= maxLen) return [normalized];

  // まず句読点で文節に割る
  const parts = normalized.split(/(?<=[。、！？!?])/).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const part of parts) {
    if ((current + part).length <= maxLen) {
      current += part;
    } else {
      if (current) chunks.push(current);
      // 1文節が上限を超える場合は強制分割
      let rest = part;
      while (rest.length > maxLen) {
        chunks.push(rest.slice(0, maxLen));
        rest = rest.slice(maxLen);
      }
      current = rest;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** チャンクを最大2行に折り返す（ASSの改行 \N を使用） */
export function wrapChunk(chunk) {
  if (chunk.length <= MAX_CHARS_PER_LINE) return chunk;
  const mid = Math.ceil(chunk.length / 2);
  // なるべく読点・中点付近で折る
  let breakAt = mid;
  for (let offset = 0; offset <= 3; offset++) {
    const before = chunk[mid - offset - 1];
    if (before && '、。・！？!?'.includes(before)) {
      breakAt = mid - offset;
      break;
    }
  }
  return chunk.slice(0, breakAt) + '\\N' + chunk.slice(breakAt);
}

function toAssTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/**
 * シーン列からASS字幕ファイルの中身を生成する。
 * scenes: Array<{ text: string, startSec: number, durationSec: number }>
 *
 * スタイルのフォント名は複製元のまま "Noto Sans CJK JP" にしてある
 * （PC版と出力バイト列を一致させ、§6のテスト値固定を壊さないため）。
 * 実際に同梱しているのは Noto Sans JP（vendor/fonts/）で、両者は別書体名
 * だが、JASSUB 初期化時の availableFonts でこのスタイル名を同梱フォント
 * ファイルへ明示的に対応付ける（mobile-lab/app.js）。ASS生成ロジック側で
 * 書体名を変えると複製の一致検証ができなくなるため、対応付けは統合層で行う。
 */
export function buildAss(scenes) {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans CJK JP,72,&H00FFFFFF,&H00FFFFFF,&H00000000,&H7F000000,-1,0,0,0,100,100,0,0,1,6,2,2,60,60,220,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events = [];
  for (const scene of scenes) {
    const chunks = chunkText(scene.text);
    const totalChars = chunks.reduce((a, c) => a + c.length, 0) || 1;
    let cursor = scene.startSec;
    for (const chunk of chunks) {
      const dur = scene.durationSec * (chunk.length / totalChars);
      const start = toAssTime(cursor);
      const end = toAssTime(Math.min(cursor + dur, scene.startSec + scene.durationSec));
      events.push(
        `Dialogue: 0,${start},${end},Default,,0,0,0,,${wrapChunk(chunk)}`
      );
      cursor += dur;
    }
  }
  return header + events.join('\n') + '\n';
}

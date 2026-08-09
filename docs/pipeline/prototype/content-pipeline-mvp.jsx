import { useState, useRef, useEffect } from "react";

/* ============================================================
   一想 — 思考を育てるコンテンツワークスペース
   要件定義書 v0.1 / Phase 1（文章パイプラインMVP）のプロトタイプ
   Threads → X → note → YouTube台本 を段階生成・編集・採用する
   ============================================================ */

const C = {
  ink: "#1F2B45", // 藍 — 本文・骨格
  inkSoft: "#61708F",
  inkFaint: "#9AA5BC",
  paper: "#F4F5F2", // 冷たい和紙
  card: "#FFFFFF",
  line: "#DEE2DC",
  shu: "#C7392B", // 朱 — 「採用」の印
  shuSoft: "#FAECE9",
  moss: "#3F7157", // 採用済み
  mossSoft: "#EAF2ED",
};

const serif = '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif';
const sans = '"Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif';

const STAGES = [
  { id: "threads", label: "Threads", role: "気づきの核だけを残す", target: "50〜150字" },
  { id: "x", label: "X", role: "理由と補足を加える", target: "150〜300字" },
  { id: "note", label: "note", role: "背景と考察へ長文化", target: "1,000〜1,500字" },
  { id: "script", label: "YouTube台本", role: "話し言葉へ再構成", target: "シーン分割" },
];

/* ---------- Claude API ---------- */

const RULES = `あなたは「1つの着想をThreads→X→note→YouTubeへ段階的に育てる」制作支援AIです。厳守事項:
- 前段の採用文を主要入力とし、中心の主張を全媒体で一致させる。文章量・構成・語り口だけを媒体に最適化する。
- 入力に無い数字・固有名詞・具体エピソードを決して創作しない。
- ユーザーが編集した表現をAI原案より優先して次段に反映する。
- 指示された場合、JSONのみを出力する。前置き・後書き・コードフェンスは一切付けない。`;

async function callClaude(userPrompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system: RULES,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "API error");
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function parseJson(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const start = Math.min(
    ...[clean.indexOf("{"), clean.indexOf("[")].filter((i) => i >= 0)
  );
  return JSON.parse(clean.slice(start));
}

/* ---------- 小物 ---------- */

function StatusChip({ status }) {
  const map = {
    empty: { t: "未生成", bg: "transparent", fg: C.inkFaint, bd: C.line },
    loading: { t: "生成中…", bg: "transparent", fg: C.inkSoft, bd: C.line },
    draft: { t: "下書き", bg: "#FFF", fg: C.inkSoft, bd: C.line },
    adopted: { t: "採用済み", bg: C.mossSoft, fg: C.moss, bd: C.mossSoft },
  };
  const s = map[status] || map.empty;
  return (
    <span
      className="text-xs px-2 py-0.5 rounded-full border"
      style={{ background: s.bg, color: s.fg, borderColor: s.bd, fontFamily: sans }}
    >
      {s.t}
    </span>
  );
}

function Seal({ small }) {
  return (
    <span
      className="inline-flex items-center justify-center select-none"
      style={{
        width: small ? 18 : 26,
        height: small ? 18 : 26,
        background: C.shu,
        color: "#fff",
        borderRadius: 4,
        fontFamily: serif,
        fontSize: small ? 10 : 13,
        transform: "rotate(-4deg)",
        boxShadow: "0 1px 2px rgba(0,0,0,0.15)",
      }}
    >
      採
    </span>
  );
}

function Btn({ children, onClick, kind = "ghost", disabled }) {
  const styles = {
    primary: { background: C.ink, color: "#fff", border: `1px solid ${C.ink}` },
    stamp: { background: C.shu, color: "#fff", border: `1px solid ${C.shu}` },
    ghost: { background: "#fff", color: C.ink, border: `1px solid ${C.line}` },
  }[kind];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="px-4 py-2 rounded-lg text-sm transition-opacity disabled:opacity-40"
      style={{ ...styles, fontFamily: sans }}
    >
      {children}
    </button>
  );
}

function CharCount({ text, target }) {
  return (
    <span className="text-xs" style={{ color: C.inkFaint, fontFamily: sans }}>
      {text.length}字<span className="mx-1">/</span>目安 {target}
    </span>
  );
}

function ErrorNote({ msg, onRetry }) {
  if (!msg) return null;
  return (
    <div
      className="mt-3 text-sm rounded-lg px-3 py-2 flex items-center justify-between gap-3"
      style={{ background: C.shuSoft, color: C.shu, fontFamily: sans }}
    >
      <span>生成に失敗しました：{msg}</span>
      {onRetry && (
        <button onClick={onRetry} className="underline shrink-0">
          再試行
        </button>
      )}
    </div>
  );
}

function Loading() {
  return (
    <div className="flex items-center gap-2 mt-4" style={{ color: C.inkSoft, fontFamily: sans }}>
      <span
        className="inline-block w-2 h-2 rounded-full animate-pulse"
        style={{ background: C.shu }}
      />
      <span className="text-sm">文章を育てています…</span>
    </div>
  );
}

/* ---------- 本体 ---------- */

export default function App() {
  const [theme, setTheme] = useState("");
  const [audience, setAudience] = useState("");
  const [started, setStarted] = useState(false);
  const [active, setActive] = useState("threads");

  const empty = { status: "empty", error: "" };
  const [threads, setThreads] = useState({ ...empty, candidates: [], text: "" });
  const [x, setX] = useState({ ...empty, text: "" });
  const [note, setNote] = useState({ ...empty, title: "", body: "" });
  const [script, setScript] = useState({ ...empty, titles: [], scenes: [] });
  const [copied, setCopied] = useState(false);

  const stageState = { threads, x, note, script };
  const order = ["threads", "x", "note", "script"];
  const unlockedIndex = (() => {
    if (!started) return -1;
    let i = 0;
    while (i < order.length && stageState[order[i]].status === "adopted") i++;
    return Math.min(i, order.length - 1);
  })();

  const mainRef = useRef(null);
  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, [active]);

  const themeBlock = `【着想】\n${theme}${audience ? `\n【想定読者】${audience}` : ""}`;

  /* --- 各段階の生成 --- */

  const genThreads = async () => {
    setThreads((s) => ({ ...s, status: "loading", error: "" }));
    try {
      const out = await callClaude(
        `${themeBlock}\n\nこの着想の最小単位の気づき・主張を抽出し、Threads投稿の候補を3案作成してください。各案50〜150字。冗長な背景説明は削り、冒頭の一文で内容が伝わる構成にすること。\nJSON配列のみで出力: ["案1","案2","案3"]`
      );
      const cands = parseJson(out);
      setThreads({ status: "draft", error: "", candidates: cands, text: "" });
    } catch (e) {
      setThreads((s) => ({ ...s, status: s.candidates.length ? "draft" : "empty", error: e.message }));
    }
  };

  const genX = async () => {
    setX((s) => ({ ...s, status: "loading", error: "" }));
    try {
      const out = await callClaude(
        `${themeBlock}\n\n【採用済みThreads投稿】\n${threads.text}\n\nこのThreads投稿と同じ主張を維持したまま、理由・補足・具体性を加えたX投稿を1本作成してください。150〜300字。媒体間で論旨が矛盾しないこと。本文のみを出力。`
      );
      setX({ status: "draft", error: "", text: out.trim() });
    } catch (e) {
      setX((s) => ({ ...s, status: s.text ? "draft" : "empty", error: e.message }));
    }
  };

  const genNote = async () => {
    setNote((s) => ({ ...s, status: "loading", error: "" }));
    try {
      const out = await callClaude(
        `${themeBlock}\n\n【採用済みThreads】\n${threads.text}\n\n【採用済みX】\n${x.text}\n\nここまでの内容を核として、背景・考察・読者への示唆を含むnote記事へ展開してください。1,000〜1,500字。見出し（## ）を2〜3個使うこと。事実として与えられていない数字・固有名詞・エピソードは書かない。\nJSONのみで出力: {"title":"記事タイトル","body":"本文（見出し込み）"}`
      );
      const j = parseJson(out);
      setNote({ status: "draft", error: "", title: j.title || "", body: j.body || "" });
    } catch (e) {
      setNote((s) => ({ ...s, status: s.body ? "draft" : "empty", error: e.message }));
    }
  };

  const genScript = async () => {
    setScript((s) => ({ ...s, status: "loading", error: "" }));
    try {
      const out = await callClaude(
        `【note記事タイトル】${note.title}\n\n【note本文】\n${note.body}\n\nこの記事を朗読ではなく、視聴者に話しかけるYouTube台本へ再構成してください。冒頭フック→本編→まとめの視聴構成。5〜6シーンに分割し、各シーンに話し言葉のナレーション（80〜130字）と映像指示を付けること。\nJSONのみで出力: {"titles":["タイトル候補1","候補2"],"scenes":[{"narration":"…","visual":"…"}]}`
      );
      const j = parseJson(out);
      setScript({ status: "draft", error: "", titles: j.titles || [], scenes: j.scenes || [] });
    } catch (e) {
      setScript((s) => ({ ...s, status: s.scenes.length ? "draft" : "empty", error: e.message }));
    }
  };

  const adopt = (id) => {
    const set = { threads: setThreads, x: setX, note: setNote, script: setScript }[id];
    set((s) => ({ ...s, status: "adopted" }));
    const next = order[order.indexOf(id) + 1];
    if (next) setActive(next);
  };
  const reopen = (id) => {
    const set = { threads: setThreads, x: setX, note: setNote, script: setScript }[id];
    set((s) => ({ ...s, status: "draft" }));
  };

  const copyAll = async () => {
    const scenes = script.scenes
      .map((sc, i) => `#${i + 1} ${sc.narration}\n（映像）${sc.visual}`)
      .join("\n\n");
    const all = `■ Threads\n${threads.text}\n\n■ X\n${x.text}\n\n■ note：${note.title}\n${note.body}\n\n■ YouTube台本（タイトル候補：${script.titles.join(" / ")}）\n${scenes}`;
    try {
      await navigator.clipboard.writeText(all);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      /* clipboard unavailable */
    }
  };

  const allDone = order.every((id) => stageState[id].status === "adopted");

  /* --- 画面 --- */

  return (
    <div className="min-h-screen w-full" style={{ background: C.paper, color: C.ink, fontFamily: sans }}>
      {/* ヘッダー */}
      <header className="px-5 md:px-10 pt-8 pb-6" style={{ borderBottom: `1px solid ${C.line}` }}>
        <div className="flex items-end justify-between max-w-5xl mx-auto">
          <div>
            <div className="flex items-baseline gap-3">
              <h1 style={{ fontFamily: serif, fontSize: 30, letterSpacing: "0.12em" }}>一想</h1>
              <span className="text-xs tracking-widest" style={{ color: C.inkFaint }}>
                ISSŌ — PROTOTYPE
              </span>
            </div>
            <p className="mt-1 text-sm" style={{ color: C.inkSoft }}>
              1つの着想を、Threads → X → note → YouTubeへ育てる。
            </p>
          </div>
          {allDone && (
            <Btn kind="primary" onClick={copyAll}>
              {copied ? "コピーしました" : "全文をコピー"}
            </Btn>
          )}
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-5 md:px-10 py-8 md:flex md:gap-10">
        {/* 段階レール */}
        <nav className="md:w-52 shrink-0 mb-8 md:mb-0">
          <div className="flex md:flex-col gap-2 md:gap-0 overflow-x-auto">
            {STAGES.map((st, i) => {
              const s = stageState[st.id];
              const locked = i > unlockedIndex;
              const isActive = active === st.id;
              return (
                <button
                  key={st.id}
                  onClick={() => !locked && setActive(st.id)}
                  disabled={locked}
                  className="text-left shrink-0 md:w-full px-3 py-3 md:py-4 rounded-lg md:rounded-none md:border-0 transition-colors disabled:opacity-40"
                  style={{
                    borderLeft: isActive ? `3px solid ${C.shu}` : "3px solid transparent",
                    background: isActive ? "#fff" : "transparent",
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span style={{ fontFamily: serif, fontSize: 16 }}>{st.label}</span>
                    {s.status === "adopted" && <Seal small />}
                  </div>
                  <div className="text-xs mt-0.5" style={{ color: C.inkFaint }}>
                    {st.role}
                  </div>
                  <div className="text-xs" style={{ color: C.inkFaint }}>
                    {st.target}
                  </div>
                </button>
              );
            })}
          </div>
        </nav>

        {/* メイン */}
        <main ref={mainRef} className="flex-1 min-w-0">
          {/* 着想入力 */}
          {!started && (
            <section className="rounded-xl p-6 md:p-8" style={{ background: C.card, border: `1px solid ${C.line}` }}>
              <h2 style={{ fontFamily: serif, fontSize: 20 }}>今日の着想</h2>
              <p className="mt-1 text-sm" style={{ color: C.inkSoft }}>
                考えたこと・伝えたいテーマを1〜3行で。長文やメモの貼り付けでも構いません。
              </p>
              <textarea
                value={theme}
                onChange={(e) => setTheme(e.target.value)}
                rows={4}
                placeholder="例）新しいことを学ぶとき、最初の1週間は「量より頻度」を優先したほうがいいと感じている…"
                className="mt-4 w-full rounded-lg p-3 text-sm outline-none"
                style={{ border: `1px solid ${C.line}`, background: C.paper, lineHeight: 1.9 }}
              />
              <input
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
                placeholder="想定読者（任意）例：個人で発信を始めたばかりの人"
                className="mt-3 w-full rounded-lg p-3 text-sm outline-none"
                style={{ border: `1px solid ${C.line}`, background: C.paper }}
              />
              <div className="mt-5">
                <Btn
                  kind="primary"
                  disabled={!theme.trim()}
                  onClick={() => {
                    setStarted(true);
                    genThreads();
                  }}
                >
                  この着想を育てはじめる
                </Btn>
              </div>
            </section>
          )}

          {started && (
            <>
              {/* 着想（常時表示） */}
              <div className="mb-6 rounded-xl px-4 py-3 text-sm" style={{ background: "#fff", border: `1px dashed ${C.line}`, color: C.inkSoft }}>
                <span className="mr-2" style={{ fontFamily: serif, color: C.ink }}>着想</span>
                {theme}
              </div>

              {/* Threads */}
              {active === "threads" && (
                <StagePanel title="Threads" note="最小単位の気づきだけを残す" status={threads.status}>
                  {threads.status === "loading" && <Loading />}
                  <ErrorNote msg={threads.error} onRetry={genThreads} />
                  {threads.candidates.length > 0 && threads.status !== "loading" && (
                    <>
                      <p className="text-sm mt-4 mb-2" style={{ color: C.inkSoft }}>
                        3案から1つを選んで、自分の言葉に整えてください。
                      </p>
                      <div className="grid gap-3">
                        {threads.candidates.map((c, i) => (
                          <button
                            key={i}
                            onClick={() => setThreads((s) => ({ ...s, text: c }))}
                            className="text-left rounded-lg p-4 text-sm transition-colors"
                            style={{
                              border: `1px solid ${threads.text === c ? C.shu : C.line}`,
                              background: threads.text === c ? C.shuSoft : "#fff",
                              lineHeight: 1.9,
                            }}
                          >
                            {c}
                          </button>
                        ))}
                      </div>
                      {threads.text !== "" && (
                        <Editor
                          value={threads.text}
                          onChange={(v) => setThreads((s) => ({ ...s, text: v }))}
                          target="50〜150字"
                          locked={threads.status === "adopted"}
                        />
                      )}
                      <StageActions
                        stage={threads}
                        canAdopt={threads.text.trim().length > 0}
                        onAdopt={() => adopt("threads")}
                        onReopen={() => reopen("threads")}
                        onRegen={genThreads}
                        downstream={x.status !== "empty"}
                      />
                    </>
                  )}
                </StagePanel>
              )}

              {/* X */}
              {active === "x" && (
                <StagePanel title="X" note="同じ主張に、理由と補足を足す" status={x.status}>
                  {x.status === "empty" && <Btn kind="primary" onClick={genX}>Threads採用版から生成</Btn>}
                  {x.status === "loading" && <Loading />}
                  <ErrorNote msg={x.error} onRetry={genX} />
                  {x.text && x.status !== "loading" && (
                    <>
                      <Editor
                        value={x.text}
                        onChange={(v) => setX((s) => ({ ...s, text: v }))}
                        target="150〜300字"
                        locked={x.status === "adopted"}
                      />
                      <StageActions
                        stage={x}
                        canAdopt={x.text.trim().length > 0}
                        onAdopt={() => adopt("x")}
                        onReopen={() => reopen("x")}
                        onRegen={genX}
                        downstream={note.status !== "empty"}
                      />
                    </>
                  )}
                </StagePanel>
              )}

              {/* note */}
              {active === "note" && (
                <StagePanel title="note" note="背景・考察・示唆まで長文化する" status={note.status}>
                  {note.status === "empty" && <Btn kind="primary" onClick={genNote}>X採用版から記事に展開</Btn>}
                  {note.status === "loading" && <Loading />}
                  <ErrorNote msg={note.error} onRetry={genNote} />
                  {note.body && note.status !== "loading" && (
                    <>
                      <input
                        value={note.title}
                        onChange={(e) => setNote((s) => ({ ...s, title: e.target.value }))}
                        disabled={note.status === "adopted"}
                        className="mt-4 w-full rounded-lg p-3 outline-none"
                        style={{ border: `1px solid ${C.line}`, fontFamily: serif, fontSize: 18 }}
                      />
                      <Editor
                        value={note.body}
                        onChange={(v) => setNote((s) => ({ ...s, body: v }))}
                        target="1,000〜1,500字"
                        rows={16}
                        locked={note.status === "adopted"}
                      />
                      <p className="mt-2 text-xs" style={{ color: C.inkFaint }}>
                        ※ 製品版では1,500〜3,000字を既定にします（プロトタイプは生成上限の都合で短め）。
                      </p>
                      <StageActions
                        stage={note}
                        canAdopt={note.body.trim().length > 0}
                        onAdopt={() => adopt("note")}
                        onReopen={() => reopen("note")}
                        onRegen={genNote}
                        downstream={script.status !== "empty"}
                      />
                    </>
                  )}
                </StagePanel>
              )}

              {/* 台本 */}
              {active === "script" && (
                <StagePanel title="YouTube台本" note="読む文章を、話す文章へ" status={script.status}>
                  {script.status === "empty" && <Btn kind="primary" onClick={genScript}>note記事から台本化</Btn>}
                  {script.status === "loading" && <Loading />}
                  <ErrorNote msg={script.error} onRetry={genScript} />
                  {script.scenes.length > 0 && script.status !== "loading" && (
                    <>
                      {script.titles.length > 0 && (
                        <p className="mt-4 text-sm" style={{ color: C.inkSoft }}>
                          タイトル候補：{script.titles.join(" ／ ")}
                        </p>
                      )}
                      <div className="mt-4 grid gap-4">
                        {script.scenes.map((sc, i) => (
                          <div key={i} className="rounded-lg p-4" style={{ border: `1px solid ${C.line}`, background: "#fff" }}>
                            <div className="text-xs mb-2 tracking-widest" style={{ color: C.inkFaint }}>
                              SCENE {i + 1}
                            </div>
                            <textarea
                              value={sc.narration}
                              disabled={script.status === "adopted"}
                              onChange={(e) =>
                                setScript((s) => {
                                  const scenes = s.scenes.map((o, j) =>
                                    j === i ? { ...o, narration: e.target.value } : o
                                  );
                                  return { ...s, scenes };
                                })
                              }
                              rows={3}
                              className="w-full rounded-md p-2 text-sm outline-none"
                              style={{ border: `1px solid ${C.line}`, background: C.paper, lineHeight: 1.9 }}
                            />
                            <div className="mt-2 text-xs" style={{ color: C.inkSoft }}>
                              映像：{sc.visual}
                            </div>
                          </div>
                        ))}
                      </div>
                      <StageActions
                        stage={script}
                        canAdopt
                        onAdopt={() => adopt("script")}
                        onReopen={() => reopen("script")}
                        onRegen={genScript}
                        adoptLabel="台本を確定"
                      />
                    </>
                  )}
                </StagePanel>
              )}

              {allDone && (
                <div className="mt-6 rounded-xl p-5 text-sm" style={{ background: C.mossSoft, color: C.moss }}>
                  4段階すべて採用されました。ここから先（下書き保存・予約投稿・動画レンダリング）は Phase 2〜3 のバックエンド実装で担います。
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

/* ---------- 段階パネル共通 ---------- */

function StagePanel({ title, note, status, children }) {
  return (
    <section className="rounded-xl p-6 md:p-8" style={{ background: C.card, border: `1px solid ${C.line}` }}>
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-3">
          <h2 style={{ fontFamily: serif, fontSize: 22 }}>{title}</h2>
          <span className="text-sm" style={{ color: C.inkSoft }}>{note}</span>
        </div>
        <StatusChip status={status} />
      </div>
      {children}
    </section>
  );
}

function Editor({ value, onChange, target, rows = 5, locked }) {
  return (
    <div className="mt-4">
      <textarea
        value={value}
        disabled={locked}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className="w-full rounded-lg p-3 text-sm outline-none disabled:opacity-70"
        style={{ border: `1px solid ${C.line}`, background: C.paper, lineHeight: 2 }}
      />
      <div className="mt-1 text-right">
        <CharCount text={value} target={target} />
      </div>
    </div>
  );
}

function StageActions({ stage, canAdopt, onAdopt, onReopen, onRegen, downstream, adoptLabel = "採用して次へ" }) {
  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-center gap-3">
        {stage.status !== "adopted" ? (
          <>
            <Btn kind="stamp" disabled={!canAdopt} onClick={onAdopt}>
              <span className="inline-flex items-center gap-2">
                <Seal small /> {adoptLabel}
              </span>
            </Btn>
            <Btn onClick={onRegen}>再生成</Btn>
          </>
        ) : (
          <Btn onClick={onReopen}>編集に戻す</Btn>
        )}
      </div>
      {downstream && stage.status !== "adopted" && (
        <p className="mt-3 text-xs" style={{ color: C.inkFaint }}>
          この段階を変更した場合、以降の段階は「再生成」で反映されます。
        </p>
      )}
    </div>
  );
}

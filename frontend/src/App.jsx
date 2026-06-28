import { useState, useRef, useEffect } from "react";

const API = "http://localhost:3000/api/chat";
const MAX_TURNS = 4;

const TASK_META = {
  code:           { label: "Code",           color: "#6366f1" },
  analysis:       { label: "Analysis",       color: "#0891b2" },
  creative:       { label: "Creative",       color: "#d97706" },
  transformation: { label: "Transform",      color: "#059669" },
  summarization:  { label: "Summary",        color: "#db2777" },
  factual:        { label: "Factual",        color: "#475569" },
};

export default function App() {
  const [phase, setPhase]         = useState("idle");
  const [messages, setMessages]   = useState([]);
  const [input, setInput]         = useState("");
  const [sessionId, setSessionId] = useState(null);
  const [turnCount, setTurnCount] = useState(0);
  const [result, setResult]       = useState(null);
  const [loading, setLoading]     = useState(false);
  const bottomRef                 = useRef(null);
  const textareaRef               = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, result, loading]);

  useEffect(() => {
    if (!loading && phase !== "executing") textareaRef.current?.focus();
  }, [loading, phase]);

  const addMsg = (role, text) =>
    setMessages(prev => [...prev, { role, text, id: crypto.randomUUID() }]);

  const handleStart = async () => {
    if (!input.trim() || loading) return;
    const raw = input.trim();
    setInput(""); setLoading(true);
    addMsg("user", raw);
    try {
      const res  = await fetch(`${API}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: raw }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setSessionId(data.sessionId);
      if (data.status === "complete") {
        await executeCall(data.sessionId);
      } else {
        addMsg("bot", data.question);
        setTurnCount(data.turnCount ?? 1);
        setPhase("interviewing");
      }
    } catch (e) {
      addMsg("sys", e.message);
      setPhase("error");
    } finally { setLoading(false); }
  };

  const handleReply = async () => {
    if (!input.trim() || loading) return;
    const answer = input.trim();
    setInput(""); setLoading(true);
    addMsg("user", answer);
    try {
      const res  = await fetch(`${API}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, message: answer }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (data.status === "complete") {
        setTurnCount(MAX_TURNS);
        await executeCall(sessionId);
      } else {
        addMsg("bot", data.question);
        setTurnCount(data.turnCount ?? turnCount + 1);
      }
    } catch (e) {
      addMsg("sys", e.message);
      setPhase("error");
    } finally { setLoading(false); }
  };

  const executeCall = async (sid) => {
    setPhase("executing");
    try {
      const res  = await fetch(`${API}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sid }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setResult(data);
      setPhase("done");
    } catch (e) {
      addMsg("sys", `Failed to generate: ${e.message}`);
      setPhase("error");
    }
  };

  const handleKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      phase === "idle" ? handleStart() : handleReply();
    }
  };

  const reset = () => {
    setPhase("idle"); setMessages([]); setInput("");
    setSessionId(null); setTurnCount(0); setResult(null);
  };

  const progressPct = phase === "idle" ? 0
    : phase === "done" || phase === "executing" ? 100
    : Math.round((turnCount / MAX_TURNS) * 85);

  const inputDisabled = loading || phase === "executing" || phase === "done";

  return (
    <div style={S.shell}>

      {/* ── Header ── */}
      <header style={S.header}>
        <div style={S.headerInner}>
          <div style={S.brand}>
            <span style={S.brandMark}>PP</span>
            <span style={S.brandName}>PromptProxy</span>
          </div>
          <div style={S.headerRight}>
            {phase === "interviewing" && (
              <span style={S.turnLabel}>
                {turnCount} / {MAX_TURNS} questions
              </span>
            )}
            {phase === "done" && (
              <button style={S.newBtn} onClick={reset}>New prompt</button>
            )}
          </div>
        </div>
        {/* Progress bar — signature element */}
        <div style={S.progressTrack}>
          <div style={{ ...S.progressFill, width: `${progressPct}%`,
            background: phase === "done" ? "#10b981" : "#111827" }} />
        </div>
      </header>

      {/* ── Chat column ── */}
      <main style={S.main}>
        <div style={S.chatCol}>

          {/* Empty state */}
          {messages.length === 0 && phase === "idle" && (
            <div style={S.emptyState}>
              <p style={S.emptyHeadline}>What do you need help with?</p>
              <p style={S.emptyBody}>
                I'll ask a few focused questions to understand exactly what you need —
                then generate a precise answer using the minimum tokens required.
              </p>
              <div style={S.pills}>
                {["No hallucination","Token-optimal","Cached results","Task-aware"].map(p => (
                  <span key={p} style={S.pill}>{p}</span>
                ))}
              </div>
            </div>
          )}

          {/* Messages */}
          {messages.map((m, i) => (
            <Message key={m.id} msg={m} isLast={i === messages.length - 1} />
          ))}

          {/* Thinking indicator */}
          {loading && (
            <div style={S.thinkingRow}>
              <div style={S.thinkingDots}>
                <span style={{ ...S.dot, animationDelay: "0ms" }} />
                <span style={{ ...S.dot, animationDelay: "150ms" }} />
                <span style={{ ...S.dot, animationDelay: "300ms" }} />
              </div>
              <span style={S.thinkingLabel}>
                {phase === "executing" ? "Generating answer" : "Thinking"}
              </span>
            </div>
          )}

          {/* Result */}
          {result && <ResultCard result={result} />}

          <div ref={bottomRef} style={{ height: 1 }} />
        </div>
      </main>

      {/* ── Input bar ── */}
      {phase !== "done" && (
        <footer style={S.footer}>
          <div style={S.inputWrap}>
            <textarea
              ref={textareaRef}
              style={{ ...S.textarea, cursor: inputDisabled ? "not-allowed" : "text" }}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder={
                phase === "idle"      ? "Describe your task..." :
                phase === "executing" ? "Generating your answer..." :
                                        "Your answer..."
              }
              disabled={inputDisabled}
              rows={1}
            />
            <button
              style={{ ...S.sendBtn, opacity: inputDisabled ? 0.35 : 1 }}
              onClick={phase === "idle" ? handleStart : handleReply}
              disabled={inputDisabled}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M2 8h12M9 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
          <p style={S.footerHint}>Enter to send · Shift+Enter for new line</p>
        </footer>
      )}

      <style>{KEYFRAMES}</style>
    </div>
  );
}

// ── Message ────────────────────────────────────────────────────────────────────
function Message({ msg, isLast }) {
  if (msg.role === "user") {
    return (
      <div style={M.userRow}>
        <div style={M.userBubble}>{msg.text}</div>
      </div>
    );
  }
  if (msg.role === "sys") {
    return (
      <div style={M.sysRow}>
        <span style={M.sysText}>{msg.text}</span>
      </div>
    );
  }
  // bot
  return (
    <div style={{ ...M.botRow, ...(isLast ? { animation: "fadeUp 0.2s ease" } : {}) }}>
      <div style={M.botAvatar}>AI</div>
      <div style={M.botBubble}>
        <p style={M.botText}>{msg.text}</p>
      </div>
    </div>
  );
}

// ── Result card ────────────────────────────────────────────────────────────────
function ResultCard({ result }) {
  const { response, savings, actualTokens, taskType, classification,
          budgetCheck, optimizedPrompt, systemPrompt, cacheHit,
          interviewerTokensUsed } = result;

  const meta = TASK_META[taskType] ?? { label: taskType, color: "#475569" };
  const [showPrompt, setShowPrompt] = useState(false);

  return (
    <div style={R.card}>
      {/* Card header */}
      <div style={R.cardHeader}>
        <div style={R.cardHeaderLeft}>
          <span style={{ ...R.taskChip, background: meta.color + "15", color: meta.color }}>
            {meta.label}
          </span>
          <span style={R.confText}>{classification?.confidence} confidence</span>
          {cacheHit && <span style={R.cacheChip}>⚡ cached</span>}
        </div>
        <button style={R.promptToggle} onClick={() => setShowPrompt(v => !v)}>
          {showPrompt ? "Hide" : "View"} prompt
        </button>
      </div>

      {/* Response */}
      <div style={R.responseArea}>
        <p style={R.responseText}>{response}</p>
      </div>

      {/* Prompt preview */}
      {showPrompt && (
        <div style={R.promptArea}>
          <div style={R.promptLabel}>SYSTEM</div>
          <pre style={R.pre}>{systemPrompt}</pre>
          <div style={{ ...R.promptLabel, marginTop: 12 }}>USER</div>
          <pre style={R.pre}>{optimizedPrompt}</pre>
        </div>
      )}

      {/* Token metrics */}
      <TokenMetrics
        savings={savings}
        actual={actualTokens}
        budgetCheck={budgetCheck}
        interviewerTokens={interviewerTokensUsed}
      />

      {budgetCheck?.warnings?.length > 0 && (
        <div style={R.warningRow}>
          {budgetCheck.warnings.map((w, i) => (
            <span key={i} style={R.warning}>⚠ {w}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Token metrics ──────────────────────────────────────────────────────────────
function TokenMetrics({ savings, actual, budgetCheck, interviewerTokens }) {
  if (!savings) return null;
  const { naiveTokens, optimizedTokens, tokensSaved,
          savingsPercent, estimatedCostSavedUSD, actualTotalCostUSD } = savings;

  return (
    <div style={T.root}>
      <div style={T.sectionLabel}>Token efficiency</div>

      {/* Comparison bars */}
      <div style={T.bars}>
        <TokenBar label="Without middleware" value={naiveTokens}     max={naiveTokens} color="#e5e7eb" />
        <TokenBar label="Optimized prompt"   value={optimizedTokens} max={naiveTokens} color="#111827" />
        {actual?.total && (
          <TokenBar label="Actual used"      value={actual.total}    max={naiveTokens} color="#10b981" />
        )}
      </div>

      {/* Stats row */}
      <div style={T.statsRow}>
        <Metric label="Tokens saved"  value={tokensSaved}          highlight />
        <Metric label="Reduction"     value={`${savingsPercent}%`} highlight />
        <Metric label="Output cap"    value={budgetCheck?.maxOutputTokens ? `${budgetCheck.maxOutputTokens}` : "—"} />
        <Metric label="Interviewer"   value={`${interviewerTokens ?? 0}`} />
        <Metric label="Total tokens"  value={actual?.total ?? "—"} />
        <Metric label="Cost"          value={actualTotalCostUSD != null ? `$${actualTotalCostUSD}` : "—"} />
      </div>
    </div>
  );
}

function TokenBar({ label, value, max, color }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 2;
  return (
    <div style={T.barRow}>
      <span style={T.barLabel}>{label}</span>
      <div style={T.track}>
        <div style={{ ...T.fill, width: `${pct}%`, background: color }} />
      </div>
      <span style={T.barVal}>{value}</span>
    </div>
  );
}

function Metric({ label, value, highlight }) {
  return (
    <div style={T.metric}>
      <span style={{ ...T.metricVal, color: highlight ? "#111827" : "#6b7280" }}>{value}</span>
      <span style={T.metricLabel}>{label}</span>
    </div>
  );
}

// ── Keyframes ──────────────────────────────────────────────────────────────────
const KEYFRAMES = `
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #f9fafb; }

  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes blink {
    0%, 80%, 100% { opacity: 0.15; transform: scale(0.8); }
    40%           { opacity: 1;    transform: scale(1); }
  }
`;

// ── Style objects ──────────────────────────────────────────────────────────────
const FONT = "'IBM Plex Sans', system-ui, sans-serif";
const MONO = "'IBM Plex Mono', monospace";

const S = {
  shell:        { display:"flex", flexDirection:"column", height:"100vh", background:"#f9fafb", fontFamily:FONT, color:"#111827" },
  header:       { background:"#fff", borderBottom:"1px solid #e5e7eb", flexShrink:0 },
  headerInner:  { display:"flex", alignItems:"center", justifyContent:"space-between", padding:"0 32px", height:56 },
  brand:        { display:"flex", alignItems:"center", gap:10 },
  brandMark:    { width:28, height:28, background:"#111827", color:"#fff", borderRadius:6, display:"flex", alignItems:"center", justifyContent:"center", fontSize:10, fontWeight:600, letterSpacing:0.5 },
  brandName:    { fontSize:14, fontWeight:600, letterSpacing:-0.2 },
  headerRight:  { display:"flex", alignItems:"center", gap:16 },
  turnLabel:    { fontSize:12, color:"#6b7280", fontFamily:MONO },
  newBtn:       { fontSize:12, fontWeight:500, color:"#111827", background:"transparent", border:"1px solid #d1d5db", borderRadius:6, padding:"6px 14px", cursor:"pointer" },
  progressTrack:{ height:2, background:"#f3f4f6" },
  progressFill: { height:"100%", transition:"width 0.4s ease, background 0.3s ease" },

  main:         { flex:1, overflowY:"auto", padding:"0 32px" },
  chatCol:      { maxWidth:680, margin:"0 auto", paddingTop:48, paddingBottom:32 },

  emptyState:   { textAlign:"center", paddingTop:80 },
  emptyHeadline:{ fontSize:22, fontWeight:600, letterSpacing:-0.5, marginBottom:12 },
  emptyBody:    { fontSize:14, color:"#6b7280", lineHeight:1.7, maxWidth:440, margin:"0 auto 28px" },
  pills:        { display:"flex", gap:8, justifyContent:"center", flexWrap:"wrap" },
  pill:         { fontSize:11, color:"#6b7280", border:"1px solid #e5e7eb", borderRadius:20, padding:"4px 12px" },

  thinkingRow:  { display:"flex", alignItems:"center", gap:10, padding:"12px 0" },
  thinkingDots: { display:"flex", gap:4 },
  dot:          { width:5, height:5, borderRadius:"50%", background:"#9ca3af", display:"inline-block", animation:"blink 1.2s infinite" },
  thinkingLabel:{ fontSize:12, color:"#9ca3af" },

  footer:       { background:"#fff", borderTop:"1px solid #e5e7eb", padding:"16px 32px 12px", flexShrink:0 },
  inputWrap:    { maxWidth:680, margin:"0 auto", display:"flex", gap:10, alignItems:"flex-end" },
  textarea:     { flex:1, resize:"none", border:"1px solid #e5e7eb", borderRadius:8, padding:"10px 14px", fontSize:14, fontFamily:FONT, color:"#111827", background:"#fff", outline:"none", lineHeight:1.5, transition:"border-color 0.15s" },
  sendBtn:      { width:38, height:38, flexShrink:0, background:"#111827", color:"#fff", border:"none", borderRadius:8, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", transition:"opacity 0.15s" },
  footerHint:   { maxWidth:680, margin:"8px auto 0", fontSize:11, color:"#d1d5db" },
};

const M = {
  userRow:    { display:"flex", justifyContent:"flex-end", marginBottom:20 },
  userBubble: { background:"#111827", color:"#f9fafb", borderRadius:"12px 12px 2px 12px", padding:"10px 16px", fontSize:14, lineHeight:1.6, maxWidth:480 },
  botRow:     { display:"flex", gap:12, marginBottom:20, alignItems:"flex-start" },
  botAvatar:  { width:28, height:28, background:"#f3f4f6", border:"1px solid #e5e7eb", borderRadius:6, flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", fontSize:9, fontWeight:600, color:"#6b7280", letterSpacing:0.5, marginTop:2 },
  botBubble:  { background:"#fff", border:"1px solid #e5e7eb", borderRadius:"2px 12px 12px 12px", padding:"12px 16px", maxWidth:520 },
  botText:    { fontSize:14, lineHeight:1.7, color:"#111827" },
  sysRow:     { display:"flex", justifyContent:"center", marginBottom:16 },
  sysText:    { fontSize:11, color:"#9ca3af", background:"#f9fafb", border:"1px solid #f3f4f6", borderRadius:20, padding:"3px 12px" },
};

const R = {
  card:         { background:"#fff", border:"1px solid #e5e7eb", borderRadius:12, overflow:"hidden", marginBottom:20, animation:"fadeUp 0.25s ease" },
  cardHeader:   { display:"flex", alignItems:"center", justifyContent:"space-between", padding:"14px 20px", borderBottom:"1px solid #f3f4f6" },
  cardHeaderLeft:{ display:"flex", alignItems:"center", gap:8 },
  taskChip:     { fontSize:11, fontWeight:500, padding:"3px 10px", borderRadius:20 },
  confText:     { fontSize:11, color:"#9ca3af" },
  cacheChip:    { fontSize:11, color:"#059669", background:"#d1fae5", padding:"2px 8px", borderRadius:20 },
  promptToggle: { fontSize:11, color:"#6b7280", background:"transparent", border:"1px solid #e5e7eb", borderRadius:6, padding:"4px 10px", cursor:"pointer" },
  responseArea: { padding:"20px 20px 16px" },
  responseText: { fontSize:14, lineHeight:1.8, color:"#111827", whiteSpace:"pre-wrap" },
  promptArea:   { padding:"0 20px 16px", borderTop:"1px solid #f3f4f6", paddingTop:16 },
  promptLabel:  { fontSize:10, fontWeight:600, color:"#9ca3af", letterSpacing:1, marginBottom:6 },
  pre:          { fontSize:12, fontFamily:MONO, color:"#374151", background:"#f9fafb", border:"1px solid #f3f4f6", borderRadius:6, padding:"10px 12px", overflowX:"auto", lineHeight:1.6, whiteSpace:"pre-wrap" },
  warningRow:   { padding:"10px 20px 14px", display:"flex", flexDirection:"column", gap:4 },
  warning:      { fontSize:12, color:"#d97706" },
};

const T = {
  root:        { padding:"16px 20px 20px", borderTop:"1px solid #f3f4f6" },
  sectionLabel:{ fontSize:10, fontWeight:600, color:"#9ca3af", letterSpacing:1, marginBottom:14 },
  bars:        { display:"flex", flexDirection:"column", gap:8, marginBottom:16 },
  barRow:      { display:"flex", alignItems:"center", gap:12 },
  barLabel:    { fontSize:11, color:"#9ca3af", width:140, flexShrink:0 },
  track:       { flex:1, height:4, background:"#f3f4f6", borderRadius:2, overflow:"hidden" },
  fill:        { height:"100%", borderRadius:2, transition:"width 0.5s ease" },
  barVal:      { fontSize:11, color:"#6b7280", fontFamily:MONO, width:36, textAlign:"right" },
  statsRow:    { display:"flex", gap:24, flexWrap:"wrap" },
  metric:      { display:"flex", flexDirection:"column", gap:2 },
  metricVal:   { fontSize:13, fontWeight:500, fontFamily:MONO },
  metricLabel: { fontSize:10, color:"#9ca3af" },
};
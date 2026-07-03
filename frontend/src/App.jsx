import { useState, useRef, useEffect } from "react";

const API = "https://prompt-proxy.onrender.com/api/chat";

const TASK_META = {
  code:           { label: "Code",        color: "#6366f1" },
  analysis:       { label: "Analysis",    color: "#0891b2" },
  creative:       { label: "Creative",    color: "#d97706" },
  transformation: { label: "Transform",   color: "#059669" },
  summarization:  { label: "Summary",     color: "#db2777" },
  factual:        { label: "Factual",     color: "#475569" },
};

export default function App() {
  const [phase, setPhase]         = useState("idle");
  const [messages, setMessages]   = useState([]);
  const [input, setInput]         = useState("");
  const [sessionId, setSessionId] = useState(null);
  const [result, setResult]       = useState(null);
  const [loading, setLoading]     = useState(false);
  const [criticalWarning, setCriticalWarning] = useState(null);
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, result, loading]);
  useEffect(() => { if (!loading) inputRef.current?.focus(); }, [loading]);

  const addMsg = (role, text) =>
    setMessages(prev => [...prev, { role, text, id: crypto.randomUUID() }]);

  // ── Start ──────────────────────────────────────────────────────────────────
  const handleStart = async () => {
    if (!input.trim() || loading) return;
    const raw = input.trim();
    setInput(""); setLoading(true);
    addMsg("user", raw);
    try {
      const res  = await fetch(`${API}/start`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: raw }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setSessionId(data.sessionId);
      if (data.status === "complete") {
        setPhase("ready");
      } else {
        addMsg("bot", data.question);
        setPhase("interviewing");
      }
    } catch (e) {
      addMsg("sys", e.message); setPhase("error");
    } finally { setLoading(false); }
  };

  // ── Reply ──────────────────────────────────────────────────────────────────
  const handleReply = async (userDone = false) => {
    if (!input.trim() || loading) return;
    const answer = input.trim();
    setInput(""); setLoading(true);

    // Recovering from critical warning — supplement missing fact then build
    if (criticalWarning) {
      setCriticalWarning(null);
      addMsg("user", answer);
      try {
        await fetch(`${API}/supplement`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, message: answer }),
        });
        await buildPrompt(true);
      } catch (e) {
        addMsg("sys", e.message); setPhase("error");
      } finally { setLoading(false); }
      return;
    }

    addMsg("user", answer);
    try {
      const res  = await fetch(`${API}/reply`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, message: answer, done: userDone }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (data.status === "complete") {
        setPhase("ready");
      } else {
        addMsg("bot", data.question);
      }
    } catch (e) {
      addMsg("sys", e.message); setPhase("error");
    } finally { setLoading(false); }
  };

  // ── Build prompt ───────────────────────────────────────────────────────────
  // This is the product. We build the prompt, user pastes it into their LLM.
  const buildPrompt = async (force = false) => {
    setPhase("building");
    try {
      const res  = await fetch(`${API}/build`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, forceExecute: force }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      if (data.status === "needs_critical_info") {
        setCriticalWarning(data);
        setPhase("interviewing");
        addMsg("bot", data.warningMessage);
        return;
      }

      setResult(data);
      setPhase("done");
    } catch (e) {
      addMsg("sys", `Failed: ${e.message}`); setPhase("error");
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
    setSessionId(null); setResult(null); setCriticalWarning(null);
  };

  const inputDisabled = loading || phase === "building" || phase === "done" || phase === "ready";

  return (
    <div style={S.shell}>
      {/* Header */}
      <header style={S.header}>
        <div style={S.brand}>
          <span style={S.brandMark}>PP</span>
          <span style={S.brandName}>PromptProxy</span>
        </div>
        <span style={S.tagline}>We build the prompt. You run it on your LLM.</span>
        {phase === "done" && (
          <button style={S.newBtn} onClick={reset}>New prompt</button>
        )}
      </header>

      {/* Chat */}
      <main style={S.main}>
        <div style={S.col}>
          {messages.length === 0 && phase === "idle" && (
            <div style={S.empty}>
              <p style={S.emptyH}>What are you trying to do?</p>
              <p style={S.emptyB}>
                Tell us your task. We'll ask the right questions to extract all the
                context needed — then build a tight, grounded prompt you can paste
                into Claude, ChatGPT, Cursor, or any LLM. One shot. No hallucination.
              </p>
              <div style={S.pills}>
                {["No hallucination","Token-efficient","Works with any LLM","Saves debugging hours"].map(p => (
                  <span key={p} style={S.pill}>{p}</span>
                ))}
              </div>
            </div>
          )}

          {messages.map((m) => <Bubble key={m.id} msg={m} />)}

          {loading && (
            <div style={S.thinkRow}>
              <Dots />
              <span style={S.thinkLabel}>
                {phase === "building" ? "Building your prompt..." : "Thinking..."}
              </span>
            </div>
          )}

          {result && <PromptCard result={result} />}
          <div ref={bottomRef} style={{ height: 1 }} />
        </div>
      </main>

      {/* Ready — show build button */}
      {phase === "ready" && !loading && (
        <footer style={S.footer}>
          <div style={S.readyBox}>
            <p style={S.readyLabel}>Context extracted. Ready to build your prompt.</p>
            <div style={S.readyRow}>
              <button style={S.buildBtn} onClick={() => buildPrompt()}>
                Build prompt →
              </button>
              <button style={S.moreBtn} onClick={() => setPhase("interviewing")}>
                Add more context
              </button>
            </div>
          </div>
        </footer>
      )}

      {/* Input */}
      {phase !== "done" && phase !== "ready" && (
        <footer style={S.footer}>
          <div style={S.inputRow}>
            <textarea
              ref={inputRef}
              style={{ ...S.textarea, opacity: inputDisabled ? 0.4 : 1 }}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder={
                phase === "idle"     ? "Describe your task, paste code, or drop an error..." :
                phase === "building" ? "Building..." :
                criticalWarning      ? "Paste the missing info here..." :
                                       "Your answer..."
              }
              disabled={inputDisabled}
              rows={2}
            />
            <button
              style={{ ...S.sendBtn, opacity: inputDisabled ? 0.3 : 1 }}
              onClick={phase === "idle" ? handleStart : handleReply}
              disabled={inputDisabled}
            >
              <Arrow />
            </button>
          </div>
          <div style={S.hintRow}>
            {phase === "interviewing" && !criticalWarning && (
              <>
                <span style={S.hint}>Enter to send · Shift+Enter for new line</span>
                <button style={S.skipBtn} onClick={() => handleReply(true)}>
                  That's all I have →
                </button>
              </>
            )}
            {criticalWarning && (
              <button style={S.forceBtn} onClick={() => buildPrompt(true)}>
                Skip and build anyway (higher hallucination risk)
              </button>
            )}
          </div>
        </footer>
      )}

      <style>{CSS}</style>
    </div>
  );
}

// ── Prompt result card ─────────────────────────────────────────────────────────
function PromptCard({ result }) {
  const {
    optimizedPrompt, systemPrompt, taskType, classification,
    savings, hallucinationRisk, promptTokenCount,
    maxOutputTokensSuggested, cacheHit, interviewerTokensUsed,
  } = result;

  const meta  = TASK_META[taskType] ?? { label: taskType, color: "#475569" };
  const [tab, setTab]     = useState("prompt");
  const [copied, setCopied] = useState(false);

  const copy = () => {
    const full = systemPrompt
      ? `SYSTEM:\n${systemPrompt}\n\nUSER:\n${optimizedPrompt}`
      : optimizedPrompt;
    navigator.clipboard.writeText(full);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const riskColor =
    hallucinationRisk?.level === "low"    ? "#059669" :
    hallucinationRisk?.level === "medium" ? "#d97706" : "#dc2626";

  return (
    <div style={P.card}>
      {/* Top */}
      <div style={P.top}>
        <div style={P.chips}>
          <span style={{ ...P.chip, background: meta.color + "18", color: meta.color }}>
            {meta.label}
          </span>
          {hallucinationRisk && (
            <span style={{ ...P.chip, background: riskColor + "12", color: riskColor }}>
              {hallucinationRisk.level} hallucination risk
            </span>
          )}
          {cacheHit && (
            <span style={{ ...P.chip, background: "#d1fae5", color: "#065f46" }}>
              ⚡ cached
            </span>
          )}
        </div>
        <button
          style={{ ...P.copyBtn, background: copied ? "#059669" : "#111827" }}
          onClick={copy}
        >
          {copied ? "Copied!" : "Copy prompt"}
        </button>
      </div>

      {/* Tabs */}
      <div style={P.tabs}>
        {[
          { id: "prompt",  label: "Optimized prompt" },
          { id: "system",  label: "System prompt" },
          { id: "savings", label: "Token savings" },
        ].map(t => (
          <button
            key={t.id}
            style={{ ...P.tab, ...(tab === t.id ? P.tabActive : {}) }}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "prompt" && <pre style={P.pre}>{optimizedPrompt}</pre>}
      {tab === "system" && <pre style={P.pre}>{systemPrompt ?? "No system prompt for this task type."}</pre>}
      {tab === "savings" && (
        <div style={P.savings}>
          <SavingsRow label="Naive tokens (estimated)"  value={savings?.naiveTokens} />
          <SavingsRow label="Optimized prompt tokens"   value={savings?.optimizedTokens} accent />
          <SavingsRow label="Tokens saved"              value={savings?.tokensSaved} accent />
          <SavingsRow label="Reduction"                 value={`${savings?.savingsPercent ?? 0}%`} accent />
          <SavingsRow label="Suggested max_tokens"      value={maxOutputTokensSuggested} />
          <SavingsRow label="Interviewer tokens used"   value={interviewerTokensUsed} />
          <SavingsRow label="Total prompt tokens"       value={promptTokenCount} />
          <SavingsRow label="Confidence"                value={classification?.confidence} />
        </div>
      )}

      {/* Paste hint */}
      <div style={P.hint}>
        Paste into Claude.ai, ChatGPT, Cursor, or any LLM.
        {maxOutputTokensSuggested && (
          <> Set <code style={P.code}>max_tokens = {maxOutputTokensSuggested}</code> for best results.</>
        )}
      </div>
    </div>
  );
}

function SavingsRow({ label, value, accent }) {
  return (
    <div style={P.row}>
      <span style={P.rowLabel}>{label}</span>
      <span style={{ ...P.rowVal, color: accent ? "#111827" : "#9ca3af", fontWeight: accent ? 600 : 400 }}>
        {value ?? "—"}
      </span>
    </div>
  );
}

// ── Bubble ─────────────────────────────────────────────────────────────────────
function Bubble({ msg }) {
  if (msg.role === "user") return (
    <div style={B.userRow}><div style={B.user}>{msg.text}</div></div>
  );
  if (msg.role === "sys") return (
    <div style={B.sysRow}><span style={B.sys}>{msg.text}</span></div>
  );
  return (
    <div style={B.botRow}>
      <div style={B.avatar}>AI</div>
      <div style={B.bot}><p style={B.botText}>{msg.text}</p></div>
    </div>
  );
}

const Arrow = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M2 8h12M9 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const Dots = () => (
  <div style={{ display: "flex", gap: 4 }}>
    {[0, 150, 300].map(d => (
      <span key={d} style={{
        width: 5, height: 5, borderRadius: "50%", background: "#9ca3af",
        display: "inline-block", animation: `blink 1.2s ${d}ms infinite`,
      }} />
    ))}
  </div>
);

// ── Styles ─────────────────────────────────────────────────────────────────────
const FONT = "'Inter', system-ui, sans-serif";
const MONO = "'IBM Plex Mono', 'Fira Code', monospace";

const S = {
  shell:     { display:"flex", flexDirection:"column", height:"100vh", background:"#f9fafb", fontFamily:FONT, color:"#111827" },
  header:    { display:"flex", alignItems:"center", gap:12, padding:"0 28px", height:52, borderBottom:"1px solid #e5e7eb", background:"#fff", flexShrink:0 },
  brand:     { display:"flex", alignItems:"center", gap:8 },
  brandMark: { width:26, height:26, background:"#111827", color:"#fff", borderRadius:6, display:"flex", alignItems:"center", justifyContent:"center", fontSize:9, fontWeight:700, letterSpacing:0.5, flexShrink:0 },
  brandName: { fontSize:14, fontWeight:600 },
  tagline:   { fontSize:11, color:"#9ca3af", flex:1 },
  newBtn:    { fontSize:12, color:"#111827", background:"transparent", border:"1px solid #e5e7eb", borderRadius:6, padding:"5px 12px", cursor:"pointer" },
  main:      { flex:1, overflowY:"auto", padding:"0 28px" },
  col:       { maxWidth:660, margin:"0 auto", paddingTop:40, paddingBottom:24 },
  empty:     { textAlign:"center", paddingTop:60 },
  emptyH:    { fontSize:20, fontWeight:600, letterSpacing:-0.5, marginBottom:10 },
  emptyB:    { fontSize:14, color:"#6b7280", lineHeight:1.7, maxWidth:420, margin:"0 auto 24px" },
  pills:     { display:"flex", gap:8, flexWrap:"wrap", justifyContent:"center" },
  pill:      { fontSize:11, color:"#6b7280", border:"1px solid #e5e7eb", borderRadius:20, padding:"3px 12px" },
  thinkRow:  { display:"flex", alignItems:"center", gap:8, padding:"8px 0" },
  thinkLabel:{ fontSize:12, color:"#9ca3af" },
  footer:    { borderTop:"1px solid #e5e7eb", background:"#fff", padding:"12px 28px", flexShrink:0 },
  readyBox:  { maxWidth:660, margin:"0 auto" },
  readyLabel:{ fontSize:13, color:"#6b7280", marginBottom:10 },
  readyRow:  { display:"flex", gap:10 },
  buildBtn:  { flex:1, background:"#111827", color:"#fff", border:"none", borderRadius:8, padding:"12px", fontSize:13, fontWeight:500, cursor:"pointer" },
  moreBtn:   { background:"transparent", color:"#6b7280", border:"1px solid #e5e7eb", borderRadius:8, padding:"12px 16px", fontSize:13, cursor:"pointer" },
  inputRow:  { maxWidth:660, margin:"0 auto", display:"flex", gap:8, alignItems:"flex-end" },
  textarea:  { flex:1, resize:"none", border:"1px solid #e5e7eb", borderRadius:8, padding:"10px 14px", fontSize:14, fontFamily:FONT, color:"#111827", background:"#fff", outline:"none", lineHeight:1.5 },
  sendBtn:   { width:38, height:38, background:"#111827", color:"#fff", border:"none", borderRadius:8, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 },
  hintRow:   { maxWidth:660, margin:"6px auto 0", display:"flex", justifyContent:"space-between", alignItems:"center" },
  hint:      { fontSize:11, color:"#d1d5db" },
  skipBtn:   { fontSize:11, color:"#6b7280", background:"none", border:"none", cursor:"pointer", textDecoration:"underline" },
  forceBtn:  { fontSize:11, color:"#d97706", background:"none", border:"none", cursor:"pointer", textDecoration:"underline" },
};

const B = {
  userRow: { display:"flex", justifyContent:"flex-end", marginBottom:16 },
  user:    { background:"#111827", color:"#f9fafb", borderRadius:"12px 12px 2px 12px", padding:"10px 16px", fontSize:14, lineHeight:1.6, maxWidth:480 },
  botRow:  { display:"flex", gap:10, marginBottom:16, alignItems:"flex-start" },
  avatar:  { width:26, height:26, background:"#f3f4f6", border:"1px solid #e5e7eb", borderRadius:6, flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", fontSize:9, fontWeight:600, color:"#6b7280", marginTop:2 },
  bot:     { background:"#fff", border:"1px solid #e5e7eb", borderRadius:"2px 12px 12px 12px", padding:"10px 14px", maxWidth:500 },
  botText: { margin:0, fontSize:14, lineHeight:1.7, color:"#111827" },
  sysRow:  { display:"flex", justifyContent:"center", marginBottom:12 },
  sys:     { fontSize:11, color:"#9ca3af", background:"#f9fafb", border:"1px solid #f3f4f6", borderRadius:20, padding:"3px 12px" },
};

const P = {
  card:    { background:"#fff", border:"1px solid #e5e7eb", borderRadius:12, overflow:"hidden", marginBottom:16 },
  top:     { display:"flex", alignItems:"center", justifyContent:"space-between", padding:"14px 16px", borderBottom:"1px solid #f3f4f6" },
  chips:   { display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" },
  chip:    { fontSize:11, fontWeight:500, padding:"3px 10px", borderRadius:20 },
  copyBtn: { fontSize:12, fontWeight:500, color:"#fff", border:"none", borderRadius:7, padding:"6px 14px", cursor:"pointer", transition:"background 0.2s", whiteSpace:"nowrap" },
  tabs:    { display:"flex", borderBottom:"1px solid #f3f4f6" },
  tab:     { fontSize:12, color:"#9ca3af", background:"none", border:"none", borderBottom:"2px solid transparent", padding:"10px 16px", cursor:"pointer" },
  tabActive:{ color:"#111827", borderBottom:"2px solid #111827" },
  pre:     { margin:0, padding:"16px", fontSize:12, fontFamily:MONO, color:"#374151", lineHeight:1.7, whiteSpace:"pre-wrap", overflowX:"auto", background:"#f9fafb" },
  savings: { padding:"12px 16px", display:"flex", flexDirection:"column", gap:6 },
  row:     { display:"flex", justifyContent:"space-between", alignItems:"center", padding:"4px 0", borderBottom:"1px solid #f9fafb" },
  rowLabel:{ fontSize:12, color:"#9ca3af" },
  rowVal:  { fontSize:12, fontFamily:MONO },
  hint:    { padding:"12px 16px", fontSize:11, color:"#9ca3af", borderTop:"1px solid #f3f4f6", lineHeight:1.6 },
  code:    { fontFamily:MONO, fontSize:10, background:"#f3f4f6", padding:"1px 4px", borderRadius:3 },
};

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=IBM+Plex+Mono&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #f9fafb; }
  textarea:focus { border-color: #111827 !important; outline: none; }
  @keyframes blink {
    0%, 80%, 100% { opacity: 0.15; transform: scale(0.8); }
    40%           { opacity: 1;    transform: scale(1); }
  }
`;
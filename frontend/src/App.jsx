import { useState, useRef, useEffect } from "react";

const API = "http://localhost:3000/api/pipeline";

// Temp: for testing, user pastes their key once per session
// Will be replaced with stored encrypted key after auth is built

export default function App() {
  const [phase, setPhase]       = useState("idle");       // idle|key|interviewing|running|done|error
  const [messages, setMessages] = useState([]);
  const [steps, setSteps]       = useState([]);           // live pipeline steps
  const [result, setResult]     = useState(null);
  const [input, setInput]       = useState("");
  const [sessionId, setSessionId] = useState(null);
  const [loading, setLoading]   = useState(false);
  const [apiKey, setApiKey]     = useState("");
  const [provider, setProvider] = useState("groq");
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, steps, result]);
  useEffect(() => { if (!loading) inputRef.current?.focus(); }, [loading, phase]);

  const addMsg = (role, text) =>
    setMessages(prev => [...prev, { role, text, id: crypto.randomUUID() }]);

  // ── Start interview ──────────────────────────────────────────────────────
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
        setPhase("key");
      } else {
        addMsg("bot", data.question);
        setPhase("interviewing");
      }
    } catch (e) {
      addMsg("sys", e.message); setPhase("error");
    } finally { setLoading(false); }
  };

  // ── Reply to interview question ──────────────────────────────────────────
  const handleReply = async (userDone = false) => {
    if (!input.trim() || loading) return;
    const answer = input.trim();
    setInput(""); setLoading(true);
    addMsg("user", answer);
    try {
      const res  = await fetch(`${API}/reply`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, message: answer, done: userDone }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (data.status === "complete") {
        // If we already have a key (this was a tie-break answer resuming
        // a pipeline that already asked for the key once), just resume
        // the run automatically instead of asking again.
        if (data.resumedFromTieBreak && apiKey.trim()) {
          runPipeline();
        } else {
          setPhase("key");
        }
      } else {
        addMsg("bot", data.question);
      }
    } catch (e) {
      addMsg("sys", e.message); setPhase("error");
    } finally { setLoading(false); }
  };

  // ── Run the pipeline via SSE ─────────────────────────────────────────────
  const runPipeline = () => {
    if (!apiKey.trim()) return;
    setPhase("running");
    setSteps([]);

    const url = `${API}/run/${sessionId}?provider=${provider}&apiKey=${encodeURIComponent(apiKey)}`;
    const es  = new EventSource(url);

    es.onmessage = (e) => {
      const data = JSON.parse(e.data);

      if (data.type === "done") {
        setResult(data.data);
        setPhase("done");
        es.close();
        return;
      }

      if (data.type === "error") {
        addMsg("sys", data.message);
        setPhase("error");
        es.close();
        return;
      }

      if (data.type === "needs_info") {
        addMsg("bot", data.message);
        setPhase("interviewing");
        setSteps([]);
        es.close();
        return;
      }

      // All other step types — show live in steps feed
      setSteps(prev => [...prev, data]);
    };

    es.onerror = () => {
      addMsg("sys", "Connection lost. Try again.");
      setPhase("error");
      es.close();
    };
  };

  const handleKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (phase === "idle") handleStart();
      else if (phase === "interviewing") handleReply();
    }
  };

  const reset = () => {
    setPhase("idle"); setMessages([]); setSteps([]);
    setInput(""); setSessionId(null); setResult(null);
  };

  const inputDisabled = loading || phase === "running" || phase === "done" || phase === "key";

  return (
    <div style={S.shell}>
      {/* Header */}
      <header style={S.header}>
        <div style={S.brand}>
          <span style={S.mark}>PP</span>
          <span style={S.name}>PromptProxy</span>
        </div>
        <span style={S.tagline}>We extract. We brief. Your LLM solves it right.</span>
        {phase === "done" && <button style={S.newBtn} onClick={reset}>New session</button>}
      </header>

      {/* Main */}
      <main style={S.main}>
        <div style={S.col}>

          {/* Empty state */}
          {messages.length === 0 && phase === "idle" && (
            <div style={S.empty}>
              <p style={S.emptyH}>What are you stuck on?</p>
              <p style={S.emptyB}>
                Paste your problem, error, or task. We extract the full context,
                identify the root cause, then send one perfect prompt to your LLM.
                You get a clear action plan — not a wall of text to decode.
              </p>
              <div style={S.pills}>
                {["Root cause identified","One LLM call","Clear next action","Any domain"].map(p => (
                  <span key={p} style={S.pill}>{p}</span>
                ))}
              </div>
            </div>
          )}

          {/* Chat messages */}
          {messages.map(m => <Bubble key={m.id} msg={m} />)}

          {/* Loading dots */}
          {loading && <ThinkingDots />}

          {/* Live pipeline steps */}
          {steps.length > 0 && (
            <div style={ST.feed}>
              {steps.map((step, i) => <StepCard key={i} step={step} />)}
            </div>
          )}

          {/* Running indicator */}
          {phase === "running" && steps.length === 0 && (
            <div style={ST.feed}><ThinkingDots label="Starting pipeline..." /></div>
          )}

          {/* Final result */}
          {result && <ResultCard result={result} />}

          <div ref={bottomRef} style={{ height: 1 }} />
        </div>
      </main>

      {/* Key connection screen */}
      {phase === "key" && (
        <footer style={S.footer}>
          <div style={S.keyBox}>
            <p style={S.keyTitle}>Connect your LLM to run the pipeline</p>
            <p style={S.keySub}>Your key is used for this session only. Never logged or stored on our servers.</p>
            <div style={S.keyRow}>
              <div style={S.providerToggle}>
               {["claude","openai","groq"].map(p => (
  <button key={p}
    style={{ ...S.providerBtn, ...(provider === p ? S.providerBtnActive : {}) }}
    onClick={() => setProvider(p)}>
    {p === "claude" ? "Claude" : p === "openai" ? "OpenAI" : "Groq"}
  </button>
))}
              </div>
              <input
                type="password"
                style={S.keyInput}
                placeholder={provider === "claude" ? "sk-ant-..." : provider === "groq" ? "gsk_..." : "sk-..."}
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                onKeyDown={e => e.key === "Enter" && runPipeline()}
              />
              <button style={S.runBtn} onClick={runPipeline} disabled={!apiKey.trim()}>
                Run →
              </button>
            </div>
          </div>
        </footer>
      )}

      {/* Input bar */}
      {phase !== "done" && phase !== "key" && phase !== "running" && (
        <footer style={S.footer}>
          <div style={S.inputRow}>
            <textarea
              ref={inputRef}
              style={{ ...S.textarea, opacity: inputDisabled ? 0.4 : 1 }}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder={
                phase === "idle" ? "Paste your problem, error, code, or task..." :
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
          {phase === "interviewing" && (
            <div style={S.hintRow}>
              <span style={S.hint}>Enter to send</span>
              <button style={S.skipBtn} onClick={() => handleReply(true)}>
                That's all I have →
              </button>
            </div>
          )}
        </footer>
      )}

      <style>{CSS}</style>
    </div>
  );
}

// ── Step card — shown live as pipeline runs ────────────────────────────────────
function StepCard({ step }) {
  const icons = {
    step:               "⚙",
    status:             "⟳",
    extraction_done:    "🔍",
    diagnosis:          "🎯",
    gate_blocked:       "❓",
    llm_done:           "⚡",
    verification_done:  "🛡",
    interpretation_done:"✅",
  };

  const icon = icons[step.type] ?? "·";

  return (
    <div style={ST.card}>
      <span style={ST.icon}>{icon}</span>
      <div style={ST.content}>
        <p style={ST.msg}>{step.message}</p>
        {step.data && step.type === "extraction_done" && (
          <div style={ST.tags}>
            {step.data.hypotheses?.[0] && (
              <Tag label="Top hypothesis" value={`${step.data.hypotheses[0].theory} (${step.data.hypotheses[0].confidence}%)`} />
            )}
            <Tag label="Area"       value={step.data.problemArea} />
            <Tag label="Severity"   value={step.data.severity} color={step.data.severity === "high" ? "#dc2626" : step.data.severity === "medium" ? "#d97706" : "#059669"} />
          </div>
        )}
        {step.data && step.type === "llm_done" && (
          <div style={ST.tags}>
            <Tag label="Model"          value={step.data.model} />
            <Tag label="Input tokens"   value={step.data.inputTokens} />
            <Tag label="Output tokens"  value={step.data.outputTokens} />
          </div>
        )}
      </div>
    </div>
  );
}

function Tag({ label, value, color }) {
  return (
    <span style={{ ...ST.tag, color: color ?? "#6b7280" }}>
      <span style={ST.tagLabel}>{label}:</span> {value}
    </span>
  );
}

// ── Final result card ──────────────────────────────────────────────────────────
function ResultCard({ result }) {
  const {
    interpretation, diagnoses, keyInsight, severity,
    tokensSaved, surgicalPrompt, rawLLMResponse,
    whatToVerify, potentialRisks, verification,
  } = result;
  const diagnosisList = diagnoses ?? (result.diagnosis ? [result.diagnosis] : []); // fallback for older result shape

  const [tab, setTab]       = useState("action");
  const [copied, setCopied] = useState(false);

  const copy = (text) => {
    const str = typeof text === "object" ? JSON.stringify(text, null, 2) : text;
    navigator.clipboard.writeText(str);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const severityColor =
    severity === "high"   ? "#dc2626" :
    severity === "medium" ? "#d97706" : "#059669";

  return (
    <div style={R.card}>
      <div style={R.header}>
        <div style={R.headerLeft}>
          <span style={{ ...R.chip, background: severityColor + "15", color: severityColor }}>
            {severity} severity
          </span>
          {tokensSaved > 0 && (
            <span style={{ ...R.chip, background: "#d1fae5", color: "#065f46" }}>
              ~{tokensSaved} tokens saved
            </span>
          )}
          {verification?.status && (
            <span style={{
              ...R.chip,
              background: verification.status === "verified" ? "#d1fae5"
                : verification.status === "rejected" ? "#fee2e2" : "#fef3c7",
              color: verification.status === "verified" ? "#065f46"
                : verification.status === "rejected" ? "#991b1b" : "#92400e",
            }}>
              fix {verification.status}
            </span>
          )}
        </div>
      </div>

      {diagnosisList.map((d, i) => (
        <div key={i} style={R.rootCause}>
          <span style={R.rootLabel}>
            {diagnosisList.length > 1 ? `ROOT CAUSE — ISSUE ${i + 1}` : "ROOT CAUSE"}
          </span>
          <p style={R.rootText}>{d.theory}</p>
        </div>
      ))}
      {keyInsight && (
        <div style={{ padding: "0 16px 10px" }}>
          <p style={R.insight}>💡 {keyInsight}</p>
        </div>
      )}

      {interpretation?.primary_action && (
        <div style={R.primaryAction}>
          <span style={R.primaryLabel}>➡ DO THIS NOW</span>
          <p style={R.primaryText}>{interpretation.primary_action}</p>
        </div>
      )}

      {interpretation?.summary && (
        <div style={R.summary}>
          <p style={R.summaryText}>{interpretation.summary}</p>
        </div>
      )}

      <div style={R.tabs}>
        {[
          { id: "action",   label: "Full action plan" },
          { id: "prompt",   label: "Surgical prompt" },
          { id: "response", label: "LLM response" },
        ].map(t => (
          <button key={t.id}
            style={{ ...R.tab, ...(tab === t.id ? R.tabActive : {}) }}
            onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {tab === "action" && interpretation && (
        <div style={R.actionPlan}>
          {interpretation.output_sections?.map((section, i) => (
            <DynamicSection key={i} section={section} />
          ))}
          {(whatToVerify ?? interpretation.what_to_verify) && (
            <div style={R.actionBlock}>
              <span style={R.actionLabel}>🧪 Verify it worked</span>
              <p style={R.actionValue}>{whatToVerify ?? interpretation.what_to_verify}</p>
            </div>
          )}
          {(potentialRisks ?? interpretation.what_could_go_wrong) && (
            <div style={{ ...R.actionBlock, background:"#fff7ed", borderRadius:8, padding:"10px 12px" }}>
              <span style={{ ...R.actionLabel, color:"#d97706" }}>⚠ Watch out for</span>
              <p style={R.actionValue}>{potentialRisks ?? interpretation.what_could_go_wrong}</p>
            </div>
          )}
          {interpretation.follow_up && (
            <div style={R.actionBlock}>
              <span style={R.actionLabel}>📌 After this</span>
              <p style={R.actionValue}>{interpretation.follow_up}</p>
            </div>
          )}
          {interpretation.llm_missed && (
            <div style={{ ...R.actionBlock, background:"#fef2f2", borderRadius:8, padding:"10px 12px" }}>
              <span style={{ ...R.actionLabel, color:"#dc2626" }}>⚡ LLM didn't cover</span>
              <p style={R.actionValue}>{interpretation.llm_missed}</p>
            </div>
          )}
        </div>
      )}

      {tab === "prompt" && (
        <div style={R.preWrap}>
          <button style={R.copyBtn} onClick={() => copy(surgicalPrompt)}>
            {copied ? "Copied!" : "Copy"}
          </button>
          <pre style={R.pre}>
            {typeof surgicalPrompt === "object"
              ? JSON.stringify(surgicalPrompt, null, 2)
              : surgicalPrompt}
          </pre>
        </div>
      )}

      {tab === "response" && (
        <pre style={R.pre}>{rawLLMResponse}</pre>
      )}
    </div>
  );
}

function DynamicSection({ section }) {
  if (!section?.content) return null;
  const typeIcons = { code:"💻", list:"📋", steps:"📝", warning:"⚠", tip:"💡", text:"•" };
  const icon = typeIcons[section.type] ?? "•";

  const badgeStyle = {
    verified:   { background: "#d1fae5", color: "#065f46" },
    unverified: { background: "#fef3c7", color: "#92400e" },
    rejected:   { background: "#fee2e2", color: "#991b1b" },
  }[section.verification_status];

  return (
    <div style={R.actionBlock}>
      <span style={R.actionLabel}>
        {icon} {section.title}
        {section.issue_id && (
          <span style={{ marginLeft: 8, fontSize: 10, color: "#9ca3af", fontWeight: 400 }}>
            ({section.issue_id.replace("_", " ")})
          </span>
        )}
        {section.verification_status && badgeStyle && (
          <span style={{
            marginLeft: 8, fontSize: 10, fontWeight: 600, padding: "2px 6px",
            borderRadius: 4, ...badgeStyle,
          }}>
            {section.verification_status === "verified" ? "✅ verified"
              : section.verification_status === "rejected" ? "❌ rejected"
              : "⚠ unverified"}
          </span>
        )}
      </span>
      {section.verification_status === "rejected" && section.verification_note && (
        <div style={{
          fontSize: 12, color: "#991b1b", background: "#fef2f2",
          border: "1px solid #fecaca", borderRadius: 6, padding: "6px 10px", marginTop: 4,
        }}>
          ⚠ Verifier flagged this: {section.verification_note}
        </div>
      )}
      {section.type === "code" ? (
        <pre style={{ ...R.pre, marginTop:6, borderRadius:6 }}>{section.content}</pre>
      ) : section.type === "list" || section.type === "steps" ? (
        <ol style={R.stepList}>
          {(Array.isArray(section.content)
            ? section.content
            : section.content.split("\n").filter(Boolean)
          ).map((item, i) => <li key={i} style={R.stepItem}>{item}</li>)}
        </ol>
      ) : (
        <p style={R.actionValue}>{section.content}</p>
      )}
    </div>
  );
}

// ── Chat bubble ────────────────────────────────────────────────────────────────
function Bubble({ msg }) {
  if (msg.role === "user") return (
    <div style={B.userRow}><div style={B.user}>{msg.text}</div></div>
  );
  if (msg.role === "sys") return (
    <div style={B.sysRow}><span style={B.sys}>{msg.text}</span></div>
  );
  return (
    <div style={B.botRow}>
      <div style={B.avatar}>PP</div>
      <div style={B.bot}><p style={B.text}>{msg.text}</p></div>
    </div>
  );
}

function ThinkingDots({ label = "Thinking..." }) {
  return (
    <div style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 0" }}>
      <div style={{ display:"flex", gap:4 }}>
        {[0,150,300].map(d => (
          <span key={d} style={{ width:5, height:5, borderRadius:"50%", background:"#9ca3af",
            display:"inline-block", animation:`blink 1.2s ${d}ms infinite` }} />
        ))}
      </div>
      <span style={{ fontSize:12, color:"#9ca3af" }}>{label}</span>
    </div>
  );
}

const Arrow = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M2 8h12M9 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

// ── Styles ─────────────────────────────────────────────────────────────────────
const FONT = "'Inter', system-ui, sans-serif";
const MONO = "'IBM Plex Mono', monospace";

const S = {
  shell:           { display:"flex", flexDirection:"column", height:"100vh", background:"#f9fafb", fontFamily:FONT, color:"#111827" },
  header:          { display:"flex", alignItems:"center", gap:12, padding:"0 28px", height:52, borderBottom:"1px solid #e5e7eb", background:"#fff", flexShrink:0 },
  brand:           { display:"flex", alignItems:"center", gap:8 },
  mark:            { width:26, height:26, background:"#111827", color:"#fff", borderRadius:6, display:"flex", alignItems:"center", justifyContent:"center", fontSize:8, fontWeight:700, letterSpacing:0.5, flexShrink:0 },
  name:            { fontSize:14, fontWeight:600 },
  tagline:         { fontSize:11, color:"#9ca3af", flex:1 },
  newBtn:          { fontSize:12, color:"#111827", background:"transparent", border:"1px solid #e5e7eb", borderRadius:6, padding:"5px 12px", cursor:"pointer" },
  main:            { flex:1, overflowY:"auto", padding:"0 28px" },
  col:             { maxWidth:660, margin:"0 auto", paddingTop:40, paddingBottom:24 },
  empty:           { textAlign:"center", paddingTop:60 },
  emptyH:          { fontSize:20, fontWeight:600, letterSpacing:-0.5, marginBottom:10 },
  emptyB:          { fontSize:14, color:"#6b7280", lineHeight:1.7, maxWidth:420, margin:"0 auto 24px" },
  pills:           { display:"flex", gap:8, flexWrap:"wrap", justifyContent:"center" },
  pill:            { fontSize:11, color:"#6b7280", border:"1px solid #e5e7eb", borderRadius:20, padding:"3px 12px" },
  footer:          { borderTop:"1px solid #e5e7eb", background:"#fff", padding:"14px 28px", flexShrink:0 },
  keyBox:          { maxWidth:660, margin:"0 auto" },
  keyTitle:        { fontSize:13, fontWeight:500, color:"#111827", marginBottom:4 },
  keySub:          { fontSize:11, color:"#9ca3af", marginBottom:12 },
  keyRow:          { display:"flex", gap:8, alignItems:"center" },
  providerToggle:  { display:"flex", border:"1px solid #e5e7eb", borderRadius:6, overflow:"hidden" },
  providerBtn:     { padding:"8px 12px", fontSize:12, background:"transparent", border:"none", cursor:"pointer", color:"#6b7280" },
  providerBtnActive:{ background:"#111827", color:"#fff" },
  keyInput:        { flex:1, padding:"8px 12px", fontSize:12, border:"1px solid #e5e7eb", borderRadius:6, outline:"none", fontFamily:MONO },
  runBtn:          { background:"#111827", color:"#fff", border:"none", borderRadius:6, padding:"8px 20px", fontSize:13, fontWeight:500, cursor:"pointer" },
  inputRow:        { maxWidth:660, margin:"0 auto", display:"flex", gap:8, alignItems:"flex-end" },
  textarea:        { flex:1, resize:"none", border:"1px solid #e5e7eb", borderRadius:8, padding:"10px 14px", fontSize:14, fontFamily:FONT, color:"#111827", background:"#fff", outline:"none", lineHeight:1.5 },
  sendBtn:         { width:38, height:38, background:"#111827", color:"#fff", border:"none", borderRadius:8, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 },
  hintRow:         { maxWidth:660, margin:"6px auto 0", display:"flex", justifyContent:"space-between" },
  hint:            { fontSize:11, color:"#d1d5db" },
  skipBtn:         { fontSize:11, color:"#6b7280", background:"none", border:"none", cursor:"pointer", textDecoration:"underline" },
};

const B = {
  userRow: { display:"flex", justifyContent:"flex-end", marginBottom:14 },
  user:    { background:"#111827", color:"#f9fafb", borderRadius:"12px 12px 2px 12px", padding:"10px 16px", fontSize:14, lineHeight:1.6, maxWidth:480 },
  botRow:  { display:"flex", gap:10, marginBottom:14, alignItems:"flex-start" },
  avatar:  { width:26, height:26, background:"#f3f4f6", border:"1px solid #e5e7eb", borderRadius:6, flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", fontSize:8, fontWeight:700, color:"#6b7280", marginTop:2 },
  bot:     { background:"#fff", border:"1px solid #e5e7eb", borderRadius:"2px 12px 12px 12px", padding:"10px 14px", maxWidth:500 },
  text:    { margin:0, fontSize:14, lineHeight:1.7, color:"#111827" },
  sysRow:  { display:"flex", justifyContent:"center", marginBottom:10 },
  sys:     { fontSize:11, color:"#9ca3af", background:"#f9fafb", border:"1px solid #f3f4f6", borderRadius:20, padding:"3px 12px" },
};

const ST = {
  feed:     { display:"flex", flexDirection:"column", gap:8, marginBottom:16 },
  card:     { display:"flex", gap:10, padding:"10px 14px", background:"#fff", border:"1px solid #e5e7eb", borderRadius:8, animation:"fadeUp 0.2s ease" },
  icon:     { fontSize:14, flexShrink:0, marginTop:1 },
  content:  { flex:1 },
  msg:      { fontSize:13, color:"#374151", marginBottom:4 },
  tags:     { display:"flex", gap:12, flexWrap:"wrap" },
  tag:      { fontSize:11 },
  tagLabel: { color:"#9ca3af" },
};

const R = {
  card:          { background:"#fff", border:"1px solid #e5e7eb", borderRadius:12, overflow:"hidden", marginBottom:16, animation:"fadeUp 0.3s ease" },
  header:        { display:"flex", alignItems:"center", justifyContent:"space-between", padding:"14px 16px", borderBottom:"1px solid #f3f4f6" },
  headerLeft:    { display:"flex", gap:8 },
  chip:          { fontSize:11, fontWeight:500, padding:"3px 10px", borderRadius:20 },
  rootCause:     { padding:"14px 16px", borderBottom:"1px solid #f3f4f6", background:"#fafafa" },
  rootLabel:     { fontSize:9, fontWeight:700, color:"#9ca3af", letterSpacing:1, display:"block", marginBottom:4 },
  rootText:      { fontSize:14, color:"#111827", lineHeight:1.6 },
  insight:       { fontSize:13, color:"#6366f1", lineHeight:1.6, marginTop:6, fontStyle:"italic" },
  primaryAction: { padding:"12px 16px", background:"#111827", borderBottom:"1px solid #1f2937" },
  primaryLabel:  { fontSize:9, fontWeight:700, color:"#6b7280", letterSpacing:1, display:"block", marginBottom:4 },
  primaryText:   { fontSize:14, color:"#fff", lineHeight:1.6, fontWeight:500 },
  summary:       { padding:"10px 16px", borderBottom:"1px solid #f3f4f6" },
  summaryText:   { fontSize:13, color:"#6b7280", lineHeight:1.6, fontStyle:"italic" },
  tabs:          { display:"flex", borderBottom:"1px solid #f3f4f6" },
  tab:           { fontSize:12, color:"#9ca3af", background:"none", border:"none", borderBottom:"2px solid transparent", padding:"10px 16px", cursor:"pointer" },
  tabActive:     { color:"#111827", borderBottom:"2px solid #111827" },
  actionPlan:    { padding:"14px 16px", display:"flex", flexDirection:"column", gap:12 },
  actionBlock:   { display:"flex", flexDirection:"column", gap:4 },
  actionLabel:   { fontSize:11, fontWeight:600, color:"#6b7280" },
  actionValue:   { fontSize:13, color:"#111827", lineHeight:1.6, whiteSpace:"pre-wrap" },
  stepList:      { paddingLeft:18, display:"flex", flexDirection:"column", gap:4 },
  stepItem:      { fontSize:13, color:"#111827", lineHeight:1.6 },
  preWrap:       { position:"relative" },
  copyBtn:       { position:"absolute", top:10, right:10, fontSize:11, fontWeight:500, color:"#fff", background:"#111827", border:"none", borderRadius:6, padding:"4px 10px", cursor:"pointer" },
  pre:           { margin:0, padding:"16px", fontSize:12, fontFamily:MONO, color:"#374151", lineHeight:1.7, whiteSpace:"pre-wrap", overflowX:"auto", background:"#f9fafb" },
};

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=IBM+Plex+Mono&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #f9fafb; }
  textarea:focus { border-color: #111827 !important; outline: none; }
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(5px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes blink {
    0%, 80%, 100% { opacity: 0.15; transform: scale(0.8); }
    40%           { opacity: 1;    transform: scale(1); }
  }
`;
import { useState, useRef, useEffect } from "react";

const API = import.meta.env.VITE_API_URL || "http://localhost:3000/api/pipeline";
// Temp: for testing, user pastes their key once per session
// Will be replaced with stored encrypted key after auth is built

export default function App() {
  const [phase, setPhase]       = useState("idle");
  const [messages, setMessages] = useState([]);
  const [steps, setSteps]       = useState([]);
  const [result, setResult]     = useState(null);
  const [input, setInput]       = useState("");
  const [sessionId, setSessionId] = useState(null);
  const [loading, setLoading]   = useState(false);
  const [apiKey, setApiKey]     = useState("");
  const [provider, setProvider] = useState("gemini");
  const [mode, setMode] = useState(null);
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);
  const [showHelp, setShowHelp] = useState(false);
  const [uploadedFileCount, setUploadedFileCount] = useState(0);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, steps, result]);
  useEffect(() => { if (!loading) inputRef.current?.focus(); }, [loading, phase]);

  const addMsg = (role, text) =>
    setMessages(prev => [...prev, { role, text, id: crypto.randomUUID() }]);

  const handleStart = async () => {
    if (!input.trim() || loading) return;
    const raw = input.trim();
    setInput(""); setLoading(true);
    addMsg("user", raw);
    try {
      const res  = await fetch(`${API}/start`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: raw, mode }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setSessionId(data.sessionId);

      if (data.status === "complete_syntax_only") {
        const issueText = data.syntaxIssues.map(issue => `⚠ ${issue.description}`).join("\n");
        addMsg("bot", `${data.message}\n\n${issueText}`);
        setPhase("idle");
      } else if (data.status === "complete") {
        setPhase("key");
      } else {
        addMsg("bot", data.question);
        setPhase("interviewing");
      }
    } catch (e) {
      addMsg("sys", e.message); setPhase("error");
    } finally { setLoading(false); }
  };

  const handleZipUpload = async (file) => {
    if (!file || !sessionId) return;
    const formData = new FormData();
    formData.append("zip", file);
    formData.append("sessionId", sessionId);
    try {
      const res = await fetch(`${API}/upload-context`, { method: "POST", body: formData });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setUploadedFileCount(data.fileCount);
      addMsg("sys", `Attached ${data.fileCount} files from your project.`);
    } catch (e) {
      addMsg("sys", `Upload failed: ${e.message}`);
    }
  };

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
        if (data.resumedFromTieBreak && apiKey.trim()) { runPipeline(); }
        else { setPhase("key"); }
      } else {
        addMsg("bot", data.question);
      }
    } catch (e) {
      addMsg("sys", e.message); setPhase("error");
    } finally { setLoading(false); }
  };

  const runPipeline = () => {
    if (!apiKey.trim()) return;
    setPhase("running");
    setSteps([]);
    const url = `${API}/run/${sessionId}?provider=${provider}&apiKey=${encodeURIComponent(apiKey)}`;
    const es  = new EventSource(url);

    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === "done") { setResult(data.data); setPhase("done"); es.close(); return; }
      if (data.type === "error") { addMsg("sys", data.message); setPhase("error"); es.close(); return; }
      if (data.type === "needs_info") {
        addMsg("bot", data.message); setPhase("interviewing"); setSteps([]); es.close(); return;
      }
      setSteps(prev => [...prev, data]);
    };
    es.onerror = () => { addMsg("sys", "Connection lost. Try again."); setPhase("error"); es.close(); };
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
    setInput(""); setSessionId(null); setResult(null); setUploadedFileCount(0);
  };

  const inputDisabled = loading || phase === "running" || phase === "done" || phase === "key";

  return (
    <div style={S.shell}>
      <nav style={S.nav}>
        <div style={S.brand}>
          <span style={S.mark}>PP</span>
          <span style={S.name}>PromptProxy</span>
        </div>
        <span style={S.tagline}><span style={S.liveDot}></span>session active</span>
        {(phase === "done" || phase === "error") && <button style={S.newBtn} onClick={reset}>new session →</button>}
      </nav>

      <main style={S.main}>
        <div style={S.col}>
          <div style={S.terminal}>
            <div style={S.terminalBar}>
              <span style={S.dot}></span><span style={S.dot}></span><span style={S.dot}></span>
              <span style={S.terminalLabel}>{sessionId ? sessionId.slice(0, 8) : "session"}</span>
            </div>

            <div style={S.terminalBody}>
              {messages.length === 0 && phase === "idle" && steps.length === 0 && !result && (
                <div style={S.empty}>
                  <p style={S.emptyPrompt}>$ what do you need?</p>
                  <p style={S.emptyB}>
                    Debug a bug, review code, prep for an interview, or ask anything.
                    We extract the right context, build a sharp prompt, and send one
                    optimized call to your LLM — no hallucination, no guesswork.
                  </p>
                  <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
                    <button
                      onClick={() => setMode(mode === "debug" ? null : "debug")}
                      style={{ ...S.modeTag, ...(mode === "debug" ? S.modeTagActive : {}) }}
                    >
                      debug mode
                    </button>
                    <button
                      onClick={() => setMode(mode === "general" ? null : "general")}
                      style={{ ...S.modeTag, ...(mode === "general" ? S.modeTagActive : {}) }}
                    >
                      ask anything
                    </button>
                  </div>
                  <div style={S.pills}>
                    {["context extraction","one optimized LLM call","clear next action","debug · review · learn · anything"].map(p => (
                      <span key={p} style={S.pill}>{p}</span>
                    ))}
                  </div>
                </div>
              )}

              {messages.map(m => <Line key={m.id} msg={m} />)}

              {loading && <ThinkingLine />}

              {steps.map((step, i) => <StepLine key={i} step={step} />)}

              {phase === "running" && steps.length === 0 && <ThinkingLine label="starting pipeline..." />}

              {result && <ResultBlock result={result} />}

              <div ref={bottomRef} style={{ height: 1 }} />
            </div>
          </div>
        </div>
      </main>

      {/* Attach project files — visible once a session exists, before the run kicks off */}
      {sessionId && (phase === "interviewing" || phase === "key") && (
        <div style={S.attachRow}>
          <label style={S.attachLabel}>
            📎 {uploadedFileCount > 0 ? `${uploadedFileCount} files attached — reasoning can read them` : "attach project (.zip) for multi-file context"}
            <input
              type="file"
              accept=".zip"
              style={{ display: "none" }}
              onChange={e => handleZipUpload(e.target.files[0])}
            />
          </label>
        </div>
      )}

      {phase === "key" && (
        <footer style={S.footer}>
          <div style={S.keyBox}>
            <p style={S.keyTitle}>$ connect your LLM to run this</p>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <p style={S.keySub}>your key is used for this session only — never logged or stored</p>
              <button onClick={() => setShowHelp(!showHelp)} style={S.helpToggle}>
                {showHelp ? "hide" : "don't have a key? →"}
              </button>
            </div>
            {showHelp && (
              <div style={S.helpBox}>
                <p style={S.helpTitle}>getting a {provider} key:</p>
                <ol style={S.helpList}>
                  {KEY_HELP[provider].steps.map((s, i) => <li key={i} style={S.helpItem}>{s}</li>)}
                </ol>
                <a href={KEY_HELP[provider].url} target="_blank" rel="noopener noreferrer" style={S.helpLink}>
                  open {provider === "claude" ? "console.anthropic.com" : provider === "openai" ? "platform.openai.com" : provider === "gemini" ? "aistudio.google.com" : "console.groq.com"} →
                </a>
              </div>
            )}
            <div style={S.keyRow}>
              <div style={S.providerToggle}>
                {["claude","openai","groq","gemini"].map(p => (
                  <button key={p}
                    style={{ ...S.providerBtn, ...(provider === p ? S.providerBtnActive : {}) }}
                    onClick={() => setProvider(p)}>
                    {p === "claude" ? "Claude" : p === "openai" ? "OpenAI" : p === "groq" ? "Groq" : "Gemini"}
                  </button>
                ))}
              </div>
              <input
                type="password"
                style={S.keyInput}
                placeholder={
                  provider === "claude" ? "sk-ant-..." :
                  provider === "groq"   ? "gsk_..." :
                  provider === "openai" ? "sk-..." :
                  "your Gemini key"
                }
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                onKeyDown={e => e.key === "Enter" && runPipeline()}
              />
              <button style={S.runBtn} onClick={runPipeline} disabled={!apiKey.trim()}>run →</button>
            </div>
          </div>
        </footer>
      )}

      {phase !== "done" && phase !== "key" && phase !== "running" && (
        <footer style={S.footer}>
          <div style={S.inputRow}>
            <span style={S.prompt}>{"›"}</span>
            <textarea
              ref={inputRef}
              style={{ ...S.textarea, opacity: inputDisabled ? 0.4 : 1 }}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder={phase === "idle" ? "paste your problem, code, question, or task..." : "your answer..."}
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
              <span style={S.hint}>enter to send</span>
              <button style={S.skipBtn} onClick={() => handleReply(true)}>that's all I have →</button>
            </div>
          )}
        </footer>
      )}

      <style>{CSS}</style>
    </div>
  );
}

// ── Terminal line renderers ─────────────────────────────────────────────────
function Line({ msg }) {
  if (msg.role === "user") return <p style={L.user}><span style={L.promptChar}>$</span> {msg.text}</p>;
  if (msg.role === "sys")  return <p style={L.sys}>! {msg.text}</p>;
  return <p style={L.bot}>{msg.text}</p>;
}

function ThinkingLine({ label = "thinking..." }) {
  return (
    <div style={{ display:"flex", alignItems:"center", gap:8, padding:"4px 0 10px" }}>
      <div style={{ display:"flex", gap:4 }}>
        {[0,150,300].map(d => (
          <span key={d} style={{ width:4, height:4, borderRadius:"50%", background: T.muted,
            display:"inline-block", animation:`blink 1.2s ${d}ms infinite` }} />
        ))}
      </div>
      <span style={{ fontSize:12, color: T.muted, fontFamily: MONO }}>{label}</span>
    </div>
  );
}

function StepLine({ step }) {
  const icons = {
    step: "○", status: "○", extraction_done: "◆", diagnosis: "◆",
    gate_blocked: "?", llm_done: "◆", repair_attempt: "↻", tool_call: "📎",
    verification_done: "◆", interpretation_done: "✓",
  };
  const icon = icons[step.type] ?? "·";
  return (
    <div style={L.stepRow}>
      <span style={L.stepIcon}>{icon}</span>
      <div style={{ flex: 1 }}>
        <p style={L.stepMsg}>{step.message}</p>
        {step.data && step.type === "llm_done" && (
          <p style={L.stepTags}>
            model: {step.data.model} · in: {step.data.inputTokens} · out: {step.data.outputTokens}
            {step.data.toolTurns > 0 && ` · tool turns: ${step.data.toolTurns}`}
          </p>
        )}
        {step.data && step.type === "extraction_done" && (
          <p style={L.stepTags}>
            area: {step.data.problemArea} · severity: {step.data.severity}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Result block — rendered inline inside the terminal, not a separate card ──
function ResultBlock({ result }) {
  const {
    interpretation, diagnoses, keyInsight, severity,
    tokensSaved, surgicalPrompt, rawLLMResponse,
    whatToVerify, potentialRisks, verification,
  } = result;
  const diagnosisList = diagnoses ?? (result.diagnosis ? [result.diagnosis] : []);

  const [tab, setTab]       = useState("action");
  const [copied, setCopied] = useState(false);

  const copy = (text) => {
    const str = typeof text === "object" ? JSON.stringify(text, null, 2) : text;
    navigator.clipboard.writeText(str);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const severityColor = severity === "high" ? T.red : severity === "medium" ? T.amber : T.green;

  return (
    <div style={R.wrap}>
      <div style={R.metaRow}>
        <span style={{ ...R.chip, color: severityColor, borderColor: severityColor + "44" }}>{severity} severity</span>
        {tokensSaved > 0 && <span style={{ ...R.chip, color: T.green, borderColor: T.green + "44" }}>~{tokensSaved} tokens saved</span>}
        {verification?.status && (
          <span style={{
            ...R.chip,
            color: verification.status === "verified" ? T.green : verification.status === "rejected" ? T.red : T.amber,
            borderColor: (verification.status === "verified" ? T.green : verification.status === "rejected" ? T.red : T.amber) + "44",
          }}>
            {verification.status === "verified" ? "syntax & imports OK" : verification.status === "rejected" ? "fix rejected" : "fix unverified"}
          </span>
        )}
      </div>

      {diagnosisList.map((d, i) => (
        <div key={i} style={R.rootCause}>
          <span style={R.label}>{diagnosisList.length > 1 ? `root cause — issue ${i + 1}` : "root cause"}</span>
          <p style={R.rootText}>{d.theory}</p>
        </div>
      ))}

      {interpretation?.confidence != null && (
        <div style={R.confBlock}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span style={R.label}>confidence</span>
            <span style={{
              fontSize: 13, fontWeight: 600, fontFamily: MONO,
              color: interpretation.confidence >= 75 ? T.green : interpretation.confidence >= 50 ? T.amber : T.red,
            }}>
              {interpretation.confidence}%
            </span>
          </div>
          {interpretation.evidence?.map((e, i) => <p key={i} style={R.evidence}>✓ {e}</p>)}
          {interpretation.assumptions?.map((a, i) => <p key={i} style={R.assumption}>? {a}</p>)}
          {interpretation.alternative_hypotheses?.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <span style={{ ...R.label, fontSize: 9 }}>alternatives considered</span>
              {interpretation.alternative_hypotheses.map((h, i) => (
                <p key={i} style={R.alt}>{h.theory} ({h.confidence}%)</p>
              ))}
            </div>
          )}
          {interpretation.evidence_audit_warning && (
            <p style={{ fontSize: 11, color: T.red, marginTop: 6, fontStyle: "italic" }}>⚠ {interpretation.evidence_audit_warning}</p>
          )}
        </div>
      )}

      {keyInsight && <p style={R.insight}>💡 {keyInsight}</p>}

      {interpretation?.primary_action && (
        <div style={R.primaryAction}>
          <span style={R.primaryLabel}>do this now</span>
          <p style={R.primaryText}>{interpretation.primary_action}</p>
        </div>
      )}

      {interpretation?.summary && <p style={R.summaryText}>{interpretation.summary}</p>}

      <div style={R.tabs}>
        {[
          { id: "action",   label: "action plan" },
          { id: "prompt",   label: "surgical prompt" },
          { id: "response", label: "LLM response" },
        ].map(t => (
          <button key={t.id} style={{ ...R.tab, ...(tab === t.id ? R.tabActive : {}) }} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {tab === "action" && interpretation && (
        <div style={R.actionPlan}>
          {interpretation.output_sections?.map((section, i) => <Section key={i} section={section} />)}
          {(whatToVerify ?? interpretation.what_to_verify) && (
            <div style={R.actionBlock}>
              <span style={R.actionLabel}>verify it worked</span>
              <p style={R.actionValue}>{whatToVerify ?? interpretation.what_to_verify}</p>
            </div>
          )}
          {(potentialRisks ?? interpretation.what_could_go_wrong) && (
            <div style={{ ...R.actionBlock, borderLeft: `2px solid ${T.amber}`, paddingLeft: 10 }}>
              <span style={{ ...R.actionLabel, color: T.amber }}>watch out for</span>
              <p style={R.actionValue}>{potentialRisks ?? interpretation.what_could_go_wrong}</p>
            </div>
          )}
          {interpretation.follow_up && (
            <div style={R.actionBlock}>
              <span style={R.actionLabel}>after this</span>
              <p style={R.actionValue}>{interpretation.follow_up}</p>
            </div>
          )}
          {interpretation.llm_missed && (
            <div style={{ ...R.actionBlock, borderLeft: `2px solid ${T.red}`, paddingLeft: 10 }}>
              <span style={{ ...R.actionLabel, color: T.red }}>LLM didn't cover</span>
              <p style={R.actionValue}>{interpretation.llm_missed}</p>
            </div>
          )}
        </div>
      )}

      {tab === "prompt" && (
        <div style={R.preWrap}>
          <button style={R.copyBtn} onClick={() => copy(surgicalPrompt)}>{copied ? "copied" : "copy"}</button>
          <pre style={R.pre}>{typeof surgicalPrompt === "object" ? JSON.stringify(surgicalPrompt, null, 2) : surgicalPrompt}</pre>
        </div>
      )}

      {tab === "response" && <pre style={R.pre}>{rawLLMResponse}</pre>}
    </div>
  );
}

function Section({ section }) {
  if (!section?.content) return null;
  const badgeColor = {
    verified: T.green, unverified: T.amber, rejected: T.red,
  }[section.verification_status];

  return (
    <div style={R.actionBlock}>
      <span style={R.actionLabel}>
        {section.title}
        {section.issue_id && <span style={{ marginLeft: 8, fontSize: 10, color: T.muted }}>({section.issue_id.replace("_", " ")})</span>}
        {section.verification_status && badgeColor && (
          <span style={{ marginLeft: 8, fontSize: 10, color: badgeColor }}>
            {section.verification_status === "verified" ? "· syntax & imports OK" : section.verification_status === "rejected" ? "· rejected" : "· unverified"}
          </span>
        )}
      </span>
      {section.verification_status === "rejected" && section.verification_note && (
        <div style={{ fontSize: 12, color: T.red, borderLeft: `2px solid ${T.red}`, paddingLeft: 10, marginTop: 4 }}>
          verifier flagged: {section.verification_note}
        </div>
      )}
      {section.type === "code" ? (
        <pre style={{ ...R.pre, marginTop: 6 }}>{section.content}</pre>
      ) : section.type === "list" || section.type === "steps" ? (
        <ol style={R.stepList}>
          {(Array.isArray(section.content) ? section.content : section.content.split("\n").filter(Boolean)).map((item, i) => (
            <li key={i} style={R.stepItem}>{item}</li>
          ))}
        </ol>
      ) : (
        <p style={R.actionValue}>{section.content}</p>
      )}
    </div>
  );
}

const Arrow = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M2 8h12M9 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

// ── Tokens ───────────────────────────────────────────────────────────────────
const T = {
  ink: "#0B0E14", panel: "#12161F", panel2: "#171C27",
  text: "#E7E9EE", muted: "#7C8194",
  amber: "#E8A33D", amberDim: "#6B5326",
  violet: "#6E7DFF", violetDim: "#333A6B",
  red: "#E85B4D", green: "#4FBE8C",
  hair: "rgba(231,233,238,0.09)",
};

const KEY_HELP = {
  claude: { steps: ["Go to console.anthropic.com", "Sign up or log in", "Click 'API Keys' → 'Create Key'", "Copy it and paste below"], url: "https://console.anthropic.com/settings/keys" },
  openai: { steps: ["Go to platform.openai.com", "Sign up or log in", "Click 'API keys' → 'Create new secret key'", "Copy it and paste below"], url: "https://platform.openai.com/api-keys" },
  gemini: { steps: ["Go to aistudio.google.com", "Sign in with your Google account", "Click 'Get API key' → 'Create API key'", "Copy it and paste below"], url: "https://aistudio.google.com/apikey" },
  groq: { steps: ["Go to console.groq.com", "Sign up or log in", "Click 'API Keys' → 'Create API Key'", "Copy it and paste below"], url: "https://console.groq.com/keys" },
};

const FONT = "'Inter', system-ui, sans-serif";
const DISPLAY = "'Space Grotesk', 'Inter', sans-serif";
const MONO = "'IBM Plex Mono', monospace";

const S = {
  shell:        { display:"flex", flexDirection:"column", height:"100vh", background:T.ink, fontFamily:FONT, color:T.text },
  nav:          { display:"flex", alignItems:"center", gap:12, padding:"14px 28px", borderBottom:`1px solid ${T.hair}`, flexShrink:0 },
  brand:        { display:"flex", alignItems:"center", gap:8 },
  mark:         { width:24, height:24, background:T.amber, color:T.ink, borderRadius:5, display:"flex", alignItems:"center", justifyContent:"center", fontSize:9, fontWeight:700, flexShrink:0 },
  name:         { fontSize:15, fontWeight:600, fontFamily:DISPLAY },
  tagline:      { fontSize:12, color:T.muted, flex:1, fontFamily:MONO, display:"flex", alignItems:"center", gap:8 },
  liveDot:      { width:6, height:6, borderRadius:"50%", background:T.amber, display:"inline-block" },
  newBtn:       { fontSize:12, color:T.text, background:"transparent", border:`1px solid ${T.hair}`, borderRadius:6, padding:"6px 12px", cursor:"pointer", fontFamily:MONO },
  main:         { flex:1, overflowY:"auto", padding:"24px 28px" },
  col:          { maxWidth:720, margin:"0 auto" },
  terminal:     { background:T.panel, border:`1px solid ${T.hair}`, borderRadius:10, minHeight:"calc(100vh - 210px)", display:"flex", flexDirection:"column" },
  terminalBar:  { display:"flex", alignItems:"center", gap:8, padding:"12px 16px", background:T.panel2, borderBottom:`1px solid ${T.hair}`, borderRadius:"10px 10px 0 0" },
  dot:          { width:9, height:9, borderRadius:"50%", background:T.hair },
  terminalLabel:{ marginLeft:8, fontFamily:MONO, fontSize:11, color:T.muted },
  terminalBody: { padding:20, flex:1, fontFamily:FONT },
  empty:        { padding:"12px 0" },
  emptyPrompt:  { fontFamily:MONO, fontSize:16, color:T.text, marginBottom:10 },
  emptyB:       { fontSize:13, color:T.muted, lineHeight:1.7, maxWidth:460, marginBottom:18 },
  modeTag:      { fontFamily:MONO, fontSize:11, color:T.muted, background:"transparent", border:`1px solid ${T.hair}`, borderRadius:5, padding:"5px 10px", cursor:"pointer" },
  modeTagActive:{ background:T.amber, color:T.ink, borderColor:T.amber },
  pills:        { display:"flex", gap:6, flexWrap:"wrap" },
  pill:         { fontFamily:MONO, fontSize:10, color:T.muted, border:`1px solid ${T.hair}`, borderRadius:5, padding:"3px 8px" },
  footer:       { borderTop:`1px solid ${T.hair}`, padding:"14px 28px", flexShrink:0 },
  attachRow:    { padding:"0 28px 10px", maxWidth:720, margin:"0 auto", width:"100%" },
  attachLabel:  { fontSize:11, color:T.amber, cursor:"pointer", fontFamily:MONO, display:"inline-block" },
  keyBox:       { maxWidth:720, margin:"0 auto" },
  keyTitle:     { fontSize:14, fontFamily:MONO, color:T.text, marginBottom:4 },
  keySub:       { fontSize:11, color:T.muted, marginBottom:12, fontFamily:MONO },
  keyRow:       { display:"flex", gap:8, alignItems:"center" },
  providerToggle:{ display:"flex", border:`1px solid ${T.hair}`, borderRadius:6, overflow:"hidden" },
  providerBtn:  { padding:"8px 12px", fontSize:11, background:"transparent", border:"none", cursor:"pointer", color:T.muted, fontFamily:MONO },
  providerBtnActive:{ background:T.amber, color:T.ink, fontWeight:500 },
  keyInput:     { flex:1, padding:"9px 12px", fontSize:12, border:`1px solid ${T.hair}`, borderRadius:6, outline:"none", fontFamily:MONO, background:T.panel2, color:T.text },
  runBtn:       { background:T.amber, color:T.ink, border:"none", borderRadius:6, padding:"9px 20px", fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:MONO },
  inputRow:     { maxWidth:720, margin:"0 auto", display:"flex", gap:10, alignItems:"flex-start" },
  prompt:       { fontFamily:MONO, color:T.amber, fontSize:16, paddingTop:10 },
  textarea:     { flex:1, resize:"none", border:`1px solid ${T.hair}`, borderRadius:8, padding:"10px 14px", fontSize:14, fontFamily:FONT, color:T.text, background:T.panel, outline:"none", lineHeight:1.5 },
  sendBtn:      { width:38, height:38, background:T.amber, color:T.ink, border:"none", borderRadius:8, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 },
  hintRow:      { maxWidth:720, margin:"6px auto 0", display:"flex", justifyContent:"space-between" },
  hint:         { fontSize:11, color:T.muted, fontFamily:MONO },
  skipBtn:      { fontSize:11, color:T.muted, background:"none", border:"none", cursor:"pointer", fontFamily:MONO },
  helpToggle:   { fontSize:11, color:T.amber, background:"none", border:"none", cursor:"pointer", fontFamily:MONO },
  helpBox:      { marginTop:10, padding:"12px 14px", background:T.panel2, border:`1px solid ${T.hair}`, borderRadius:8 },
  helpTitle:    { fontSize:12, color:T.text, fontFamily:MONO, marginBottom:8 },
  helpList:     { paddingLeft:18, marginBottom:10 },
  helpItem:     { fontSize:12, color:T.muted, lineHeight:1.8 },
  helpLink:     { fontSize:11, color:T.amber, fontFamily:MONO, textDecoration:"underline" },
};

const L = {
  user:      { fontSize:14, color:T.text, marginBottom:12, lineHeight:1.6 },
  promptChar:{ color:T.amber, fontFamily:MONO },
  bot:       { fontSize:14, color:T.text, marginBottom:12, lineHeight:1.7, paddingLeft:14, borderLeft:`2px solid ${T.hair}` },
  sys:       { fontSize:12, color:T.muted, marginBottom:10, fontFamily:MONO, fontStyle:"italic" },
  stepRow:   { display:"flex", gap:10, marginBottom:8, fontSize:13 },
  stepIcon:  { color:T.amber, fontFamily:MONO, fontSize:12, marginTop:2 },
  stepMsg:   { color:T.text, marginBottom:2 },
  stepTags:  { fontSize:11, color:T.muted, fontFamily:MONO },
};

const R = {
  wrap:        { marginTop:8, marginBottom:16, borderTop:`1px solid ${T.hair}`, paddingTop:16 },
  metaRow:      { display:"flex", gap:8, flexWrap:"wrap", marginBottom:16 },
  chip:         { fontSize:11, fontFamily:MONO, padding:"3px 10px", borderRadius:20, border:"1px solid" },
  rootCause:    { marginBottom:16 },
  label:        { fontSize:10, fontFamily:MONO, color:T.muted, letterSpacing:0.5, textTransform:"uppercase" },
  rootText:     { fontSize:15, color:T.text, lineHeight:1.6, marginTop:6 },
  confBlock:    { background:T.panel2, border:`1px solid ${T.hair}`, borderRadius:8, padding:"12px 14px", marginBottom:16 },
  evidence:     { fontSize:12, color:T.amber, margin:"3px 0", fontFamily:MONO },
  assumption:   { fontSize:12, color:T.violet, margin:"3px 0", fontFamily:MONO },
  alt:          { fontSize:12, color:T.muted, margin:"2px 0" },
  insight:      { fontSize:13, color:T.violet, lineHeight:1.6, marginBottom:12, fontStyle:"italic" },
  primaryAction:{ background:T.amberDim, borderRadius:8, padding:"12px 14px", marginBottom:16 },
  primaryLabel: { fontSize:10, fontFamily:MONO, color:T.amber, letterSpacing:0.5, textTransform:"uppercase", display:"block", marginBottom:4 },
  primaryText:  { fontSize:14, color:T.text, lineHeight:1.6, fontWeight:500 },
  summaryText:  { fontSize:13, color:T.muted, lineHeight:1.6, marginBottom:16, fontStyle:"italic" },
  tabs:         { display:"flex", gap:4, borderBottom:`1px solid ${T.hair}`, marginBottom:16 },
  tab:          { fontSize:11, fontFamily:MONO, color:T.muted, background:"none", border:"none", borderBottom:"2px solid transparent", padding:"8px 12px", cursor:"pointer" },
  tabActive:    { color:T.text, borderBottom:`2px solid ${T.amber}` },
  actionPlan:   { display:"flex", flexDirection:"column", gap:14 },
  actionBlock:  { display:"flex", flexDirection:"column", gap:4 },
  actionLabel:  { fontSize:11, fontFamily:MONO, color:T.muted, textTransform:"uppercase", letterSpacing:0.3 },
  actionValue:  { fontSize:13, color:T.text, lineHeight:1.6, whiteSpace:"pre-wrap" },
  stepList:     { paddingLeft:18, display:"flex", flexDirection:"column", gap:4 },
  stepItem:     { fontSize:13, color:T.text, lineHeight:1.6 },
  preWrap:      { position:"relative" },
  copyBtn:      { position:"absolute", top:10, right:10, fontSize:11, color:T.ink, background:T.amber, border:"none", borderRadius:5, padding:"4px 10px", cursor:"pointer", fontFamily:MONO },
  pre:          { margin:0, padding:14, fontSize:12, fontFamily:MONO, color:T.text, lineHeight:1.7, whiteSpace:"pre-wrap", overflowX:"auto", background:T.panel2, borderRadius:6, border:`1px solid ${T.hair}` },
};

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: ${T.ink}; }
  textarea:focus { border-color: ${T.amber} !important; outline: none; }
  ::selection { background: ${T.amberDim}; color: ${T.amber}; }
  @keyframes blink { 0%, 80%, 100% { opacity: 0.15; } 40% { opacity: 1; } }
`;
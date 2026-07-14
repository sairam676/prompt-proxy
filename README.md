# ⚡ PromptProxy

> A debugging-focused LLM middleware. It lays out your context, hands the actual reasoning to your own connected LLM, forces it to separate evidence from assumption, deterministically checks what it produces, and auto-corrects real failures before you ever see them — instead of just relaying a prompt and hoping.

**Live demo → [prompt-proxy-mocha.vercel.app](https://prompt-proxy-mocha.vercel.app)**

---

## The problem

Raw chat with an LLM about a bug has three recurring failure modes:
1. **Confident wrong answers.** The model states a hypothesis as if it were fact, with no way to tell what it actually observed in your code versus what it's assuming.
2. **No verification.** It claims a fix works. Nobody checks.
3. **Wasted round-trips.** Ambiguous or under-specified reports get guessed at instead of clarified — or trivial bugs get the same heavyweight treatment as genuinely hard ones.

Chaining several *cheap* models to pre-diagnose before the real LLM sees the problem sounds like a fix for this — it isn't. Testing that approach directly (see [Architecture history](#architecture-history) below) showed it backfires: a small model produces a confident, specific, **wrong** diagnosis, and the expensive model inherits that error instead of reasoning through the problem itself.

## The solution

PromptProxy sits between you and your own connected LLM (Claude, OpenAI, Gemini, or Groq). It doesn't pre-diagnose — it lays out context cleanly, lets the one real LLM you chose do all the actual reasoning, and wraps that reasoning in deterministic checks the LLM itself can't fake:

```
Your raw problem report
      ↓
Interviewer (Groq) — extracts structured context over 1–4 turns
      ↓
Syntax pre-check — catches parse errors directly in pasted code,
                    skips the entire pipeline below if that IS the bug
      ↓
Brief builder (Groq) — compresses context, classifies mechanical complexity
      ↓
ONE call to YOUR connected LLM (Claude / OpenAI / Gemini / Groq)
  → simple bugs: direct diagnose + fix, no scaffolding
  → medium/complex bugs: separates EVIDENCE (✓) from ASSUMPTIONS (?),
    self-reports a confidence score, lists alternative hypotheses
  → OR asks a specific clarifying question if it isn't confident
      ↓
Deterministic verification — npm registry check + syntax parse check
      ↓
Auto-repair loop — if verification rejects the fix, the SAME LLM gets
                    one automatic re-call with the exact failure detail
      ↓
Interpreter (Groq) — structures the final response into a clear action plan
```

---

## What makes this different from just using ChatGPT/Claude directly

This is the honest pitch, stated plainly: **the underlying model isn't smarter than what you'd get from the same model directly.** The value is in the discipline wrapped around it — things a raw chat window doesn't give you:

| Raw LLM chat | PromptProxy |
|---|---|
| States a hypothesis as fact | Separates evidence (✓) from assumption (?), self-reports confidence grounded in that split |
| No check that a "fix" actually parses or uses real packages | Deterministic syntax check (acorn/acorn-jsx) + live npm registry check |
| A rejected/broken fix is just shown to you | Auto-repair loop re-calls the same LLM once with the exact failure before you see it |
| Every bug gets the same treatment | Mechanical complexity gate — trivial syntax bugs skip the heavyweight evidence/confidence scaffolding entirely |
| A confirmed answer can get silently re-hedged as an assumption later | Confirmed answers are tagged `[CONFIRMED BY USER]` and never re-litigated |
| You bring your own key regardless | Same here — no LLM markup, you control cost/provider |

None of this makes the model smarter. It makes the output **more trustworthy and more verifiable** — which is the actual gap between a well-engineered debugging tool and a chat window pointed at the same model.

---

## Architecture history — why it's built this way

An earlier version ran a "hypothesis engine": several cheap-model passes competing to pre-diagnose a root cause before the real LLM ever saw the problem, gated by a confidence threshold (`sufficiencyGate.js`, kept in the repo, unused, for reference).

Testing surfaced two consistent failures:
- **Confident wrong answers** — a cheap model produced a specific, plausible-sounding diagnosis that didn't match the actual code, and the expensive model inherited and built on that error rather than re-deriving it from scratch.
- **False "second opinions"** — a small model reviewing a fix afterward missed a genuinely fabricated npm package in one test, then separately invented a fake objection to *correct* code in another.

The fix wasn't "remove all structure" — it was moving every judgment call (is this the cause, is this fix correct) to the one model actually capable of reasoning through it, in a single call, while keeping structure that doesn't require judgment:

| Kept as deterministic middleware logic | Why |
|---|---|
| Context compression (Groq) | Formatting, not judgment |
| Mechanical complexity classification (Groq) | A fact-adjacent classification ("does this look like a typo"), not a diagnosis |
| npm registry check | A fact, not an opinion |
| Syntax parse check (acorn/acorn-jsx) | A fact — either it parses or it doesn't |
| Evidence-citation grounding check | Deterministic string check against the pasted code, not a model's opinion on correctness |
| Confidence *scoring* | Left to the real LLM — middleware surfaces facts (assumption count, citation grounding), the model reasons about what those facts mean for its own certainty. A fixed penalty-per-assumption formula doesn't generalize across bug types (a syntax bug and a distributed-systems race condition can't share the same confidence math), so the number itself is never middleware-asserted |

---

## Features

- **Single-call diagnosis** — your connected LLM diagnoses (with cited evidence), fixes, and self-critiques itself in one response
- **Evidence vs. assumption separation** — for non-trivial bugs, the model must label what it directly observed versus what it's inferring, and can't state an unverified assumption as fact
- **Self-reported, grounded confidence** — a 0–100% score the model reasons about itself, based on how much of its diagnosis rests on evidence vs. assumption
- **Alternative hypotheses** — at least one competing explanation surfaced, not just the top guess presented as the only possibility
- **Evidence-grounding audit** — deterministic check on whether the model's own cited evidence actually references something present in your pasted code
- **Confirmed-fact tracking** — once you answer a clarifying question, that answer is tagged and never re-hedged as an assumption in a later pass
- **Mechanical complexity gate** — simple, obvious bugs (typos, missing imports) skip the evidence/confidence scaffolding entirely; it only applies where it earns its keep
- **Syntax pre-check** — parse errors in your pasted code are caught immediately, before spending an interview turn or a paid LLM call
- **Deterministic fix verification** — npm registry existence check + syntax parse check on whatever code the LLM produces
- **Auto-repair loop** — a rejected fix gets one automatic re-call to the same LLM with the exact failure detail, before you ever see a broken result
- **Multi-provider** — bring your own Claude, OpenAI, Gemini, or Groq key
- **Live step streaming (SSE)** — see each pipeline stage as it happens, including repair attempts
- **Honest clarification detection** — catches both the model's exact requested prefix AND genuine unlabeled questions models sometimes ask instead

---

## Known limitations

Stated plainly, not buried:

- **Verification checks form, not intent.** The npm/syntax checks confirm a fix parses and its imports exist — they cannot confirm the fix does what you actually asked for. A real example hit during testing: asked for the rate limiter to **fail open** on a Redis outage, the diagnosis correctly explained the relevant config property, but the generated fix set it to the opposite (**fail closed**) value. Syntax was valid, the package was real, the fix was still wrong. Closing this gap needs actual execution against a stated expectation, not static checks — tracked as a future direction (see Roadmap).
- **`buildBrief`'s compression model can occasionally return a technically-valid-JSON shape that doesn't match the expected schema** (e.g. `brief` as a nested object instead of a string) — guarded against with a shape-validation fallback, but worth knowing the compression step isn't infallible.
- **Clarification detection uses a heuristic fallback** for models that skip the exact requested `NEEDS_CLARIFICATION:` prefix — not foolproof, but validated against repeated real cases across multiple providers.
- **`sufficiencyGate.js` is retained but unused** — no code currently imports it; kept for reference on the prior hypothesis-competition design.
- **No persistent user accounts** — sessions are ephemeral, keyed by `sessionId`, backed by Redis.
- **Session storage depends on Redis (Upstash) being reachable** — if the Redis instance is paused/unreachable, session-based flows (interview, resuming after a clarification) will fail; this is an infra dependency, not a pipeline design issue.

---

## Tech stack

| Layer | Tech |
|---|---|
| Backend | Node.js, Express |
| Interviewer / context compression / response structuring | Groq (Llama 3.3 70B / 3.1 8B) |
| Diagnostic reasoning | User's connected LLM — Claude, OpenAI, Gemini, or Groq |
| Deterministic verification | Live npm registry lookup, acorn/acorn-jsx parse check |
| Session state | Redis (Upstash) |
| Frontend | React, Vite |
| Deploy | Render (backend), Vercel (frontend) |

---

## How it works

### 1. Interview phase
`middleware/interviewer.js` — raw message turned into structured context over up to `MAX_TURNS` (default 4) focused questions. Malformed model JSON falls back to a deterministic context rebuild from conversation history rather than blocking.

### 2. Syntax pre-check
`pipeline/syntaxVerifier.js`, invoked at `/start` — if the pasted message contains code with a genuine parse error (checked via `acorn`/`acorn-jsx`, with a fallback that isolates code-like lines from surrounding prose when there are no fenced code blocks), that's surfaced immediately and the rest of the pipeline is skipped. No interview, no paid LLM call, for something a deterministic parser already caught.

### 3. Context layout
`pipeline/extractor.js`'s `buildBrief` — Groq compresses structured context into one clean brief and classifies mechanical complexity (`simple` / `medium` / `complex`). This is a classification, not a diagnosis. Guarded with a shape-validation fallback in case the compression model's JSON technically parses but doesn't match the expected schema.

### 4. Diagnostic call
`pipeline/runner.js`'s `callUserLLM` — one call to whichever provider is connected.
- **`simple`** complexity → `buildSimpleDiagnosticPrompt`: direct diagnose + fix, no scaffolding.
- **`medium`/`complex`** → `buildDiagnosticPrompt`: the model must separate evidence (✓) from assumption (?), self-report confidence grounded in that split, list at least one alternative hypothesis, and self-critique the fix against its own diagnosis.

Text in `existing_context` marked `[CONFIRMED BY USER]` (from a previously-answered clarifying question) is treated as settled evidence, not something to re-hedge on.

Clarification detection catches both the literal `NEEDS_CLARIFICATION:` prefix and genuine unlabeled questions (short, ends in `?`, no code block) — models don't always comply with the exact requested format.

### 5. Verification
`pipeline/fixVerifier.js` — combines a live npm registry check (do imported packages actually exist) with a deterministic syntax parse check (`pipeline/syntaxVerifier.js`) on the code the LLM produced.

### 6. Auto-repair
If verification rejects the fix, `runner.js` automatically re-calls the *same* LLM once (`buildRepairPrompt` in `extractor.js`) with the exact failure detail, then re-verifies — before the user ever sees a rejected result. Capped at `MAX_REPAIR_ATTEMPTS` (default 1) for cost predictability.

### 7. Evidence audit
`pipeline/evidenceAudit.js` — deterministic check on whether the LLM's own cited evidence lines reference identifiers that actually appear in the user's pasted code. Surfaces ungrounded claims as a warning; never silently rejects.

### 8. Action plan
`pipeline/interpreter.js` — Groq restructures the final (possibly repaired) response into UI-ready sections: diagnosis, evidence, assumptions, confidence, alternatives, fix (tagged with verification status), self-critique, what to verify, what could go wrong.

---

## Supported LLM providers

| Provider | Models used |
|---|---|
| Claude | `claude-sonnet-4-6` / `claude-opus-4-6` (complex tasks) |
| OpenAI | `gpt-4o-mini` / `gpt-4o` (complex tasks) |
| Gemini | `gemini-flash-latest` / `gemini-pro-latest` (complex tasks) |
| Groq | `llama-3.1-8b-instant` / `llama-3.3-70b-versatile` — useful for testing, not recommended as your primary diagnostic model |

Your key is used only for the session — never logged or stored server-side.

---

## Run locally

```bash
git clone https://github.com/sairam676/prompt-proxy.git
cd prompt-proxy

npm install

cp .env.example .env
# Fill in GROQ_API_KEY, REDIS_URL, and (optional, for local testing
# without pasting a key into the UI each time) TEST_LLM_PROVIDER + TEST_LLM_KEY

npm run dev

# In a second terminal
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`

### Environment variables

**Backend (`.env`):**
```
GROQ_API_KEY=gsk_...            # console.groq.com — powers context layout + response structuring
REDIS_URL=rediss://...          # upstash.com — session state (note: rediss:// with double-s for TLS)
PORT=3000
NODE_ENV=development

# Optional — local dev convenience only. Lets you hit the SSE endpoint
# directly without passing ?provider=&apiKey= on every request.
TEST_LLM_PROVIDER=claude        # claude | openai | gemini | groq
TEST_LLM_KEY=...

MAX_TURNS=4
```

**Frontend (`frontend/.env`):**
```
VITE_API_URL=http://localhost:3000/api/pipeline
```
In production (Vercel), set `VITE_API_URL` to your deployed backend's URL via Vercel's dashboard → Settings → Environment Variables, and redeploy after adding it (Vite bakes env vars in at build time).

---

## API

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/pipeline/start` | Send raw message; may short-circuit on a caught syntax error, otherwise begins the interview |
| POST | `/api/pipeline/reply` | Answer an interview question, or resume after a clarification answer |
| GET  | `/api/pipeline/run/:sessionId` | SSE stream — runs the full diagnostic pipeline, streaming each step (including repair attempts) live |
| GET  | `/health` | Basic liveness check |

---

## Project structure

```
prompt-proxy/
├── src/
│   ├── server.js                       ← Express entry point
│   ├── routes/pipeline.js              ← SSE orchestration, session lifecycle, syntax pre-check
│   ├── middleware/
│   │   └── interviewer.js              ← Context extraction (Q&A loop)
│   ├── pipeline/
│   │   ├── runner.js                   ← Orchestrates diagnostic flow, provider dispatch, auto-repair loop
│   │   ├── extractor.js                ← Context compression, complexity classification, all diagnostic prompts
│   │   ├── fixVerifier.js              ← npm registry + syntax check, combined verdict
│   │   ├── syntaxVerifier.js           ← Deterministic acorn/acorn-jsx parse check
│   │   ├── evidenceAudit.js            ← Grounds the LLM's cited evidence against the user's pasted code
│   │   └── interpreter.js              ← Structures final response into UI action plan
│   └── services/
│       └── sessionStore.js             ← Redis-backed session state
└── frontend/src/
    └── App.jsx                         ← React UI — chat, live step feed, provider connection, results
```

---

## Roadmap

- [ ] Close the verification-checks-form-not-intent gap — execute a fix's actual behavior against the user's stated expectation, not just static parse/import checks
- [ ] Sandboxed logic execution (`vm`-based or Docker, depending on what the infra can support) for generated test cases
- [ ] Debug-artifact ingestion — screenshots of error dialogs, log file uploads (scoped narrowly, not generic file upload)
- [ ] User accounts + cross-session history
- [ ] Semantic caching for repeated/similar reports

---

## Author

**Sairam Devarasetty** — [linkedin.com/in/sairamdevarasetty676](https://linkedin.com/in/sairamdevarasetty676) · [github.com/sairam676](https://github.com/sairam676)

NIT Patna · CS 2027

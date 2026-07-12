# ⚡ PromptProxy

> LLM middleware that lays out your context, hands it to your own LLM to actually diagnose and fix, and fact-checks the result — instead of guessing on your behalf.

**Live demo → [prompt-proxy-mocha.vercel.app](https://prompt-proxy-mocha.vercel.app)**

---

## The problem

Most people bring a bug or a task to an LLM with a wall of half-relevant context, no clear structure, and no way to know if the model actually reasoned through their specific code — or just pattern-matched to something generic and confidently wrong.

Chaining several *cheap* models to "pre-diagnose" before the real LLM sees the problem sounds efficient, but it backfires: a small model produces a confident, specific, **wrong** diagnosis, and the expensive model inherits that error instead of reasoning through the problem itself. Weak-model false certainty is worse than no pre-processing at all.

## The solution

PromptProxy sits between you and your own connected LLM (Claude, OpenAI, Gemini, or Groq). It doesn't pre-diagnose — it lays out the context cleanly, then lets the model actually capable of reasoning do all the real thinking: diagnosis, fix, and self-critique, in one call. If that model isn't confident, **it** says so and asks a targeted question — instead of a cheap model guessing on its behalf.

```
Your raw problem report
      ↓
Interviewer (Groq) — extracts structured context over 1–4 turns
      ↓
Brief builder (Groq) — compresses context into one clean brief (compression, not judgment)
      ↓
ONE call to YOUR connected LLM (Claude / OpenAI / Gemini / Groq)
  → diagnoses with cited evidence, fixes, self-critiques itself
  → OR asks a specific clarifying question if it isn't confident
      ↓
Deterministic npm registry check — the one fact-check worth keeping
      ↓
Interpreter (Groq) — structures the raw response into a clear action plan
```

---

## Why the architecture looks the way it does

Earlier versions of this pipeline ran a "hypothesis engine" — several cheap-model passes competing to pre-diagnose a root cause before the real LLM ever saw the problem, gated by a confidence-threshold sufficiency check (`sufficiencyGate.js`, kept in the repo but unused, for reference).

Testing surfaced two consistent failure patterns:

- **Confident wrong answers.** A cheap model would produce a specific, plausible-sounding diagnosis that didn't match the actual code — and the expensive model would inherit and build on that error rather than re-deriving it.
- **False "second opinions."** A small model reviewing the fix afterward missed a genuinely fabricated npm package in one test, then separately invented a fake objection to *correct* code in another. A weak model's verdict added false confidence, not correctness, in either direction.

The current design removes both weak-model judgment calls:

| Kept | Why |
|---|---|
| Groq for context compression (`extractor.js`) | Pure formatting/layout, not judgment — small model is fine |
| Groq for response structuring (`interpreter.js`) | Same — reshaping text into UI sections isn't a reasoning task |
| npm registry HTTP check (`fixVerifier.js`) | A fact, not an opinion — can't be second-guessed the way a model's stylistic judgment can |
| One real call to your connected LLM | The model actually capable of reasoning does the reasoning — diagnosis, fix, and self-critique together, with an honest "I need more information" path built in |

**Honest tradeoff:** if your LLM needs to ask a clarifying question, that's a second paid call to your own account instead of a free Groq round-trip. Given what the alternative produced, that's the right trade.

---

## Features

- **Single-call diagnosis** — your connected LLM diagnoses (with cited evidence), fixes, and self-critiques itself in one response, instead of inheriting a pre-digested guess
- **Honest uncertainty** — if the evidence doesn't support a confident diagnosis, your LLM says so and asks one specific question, rather than guessing
- **Multi-issue aware** — genuinely distinct, unrelated problems in one report get separated and solved independently, not merged
- **Deterministic fact-checking** — imported npm packages are checked against the real registry, not "reviewed" by another model's opinion
- **Multi-provider** — bring your own Claude, OpenAI, Gemini, or Groq key; the pipeline calls your account, not ours
- **Live step streaming (SSE)** — see each pipeline stage (context layout → diagnostic call → verification → action plan) as it happens
- **Token savings estimate** — naive multi-turn token cost vs. the single optimized call

---

## Tech stack

| Layer | Tech |
|---|---|
| Backend | Node.js, Express |
| Interviewer / context compression / response structuring | Groq (Llama 3.3 70B / 3.1 8B) |
| Diagnostic reasoning | User's connected LLM — Claude, OpenAI, Gemini, or Groq |
| Fact-check | Live npm registry lookup |
| Session state | Redis (Upstash) |
| Frontend | React, Vite |
| Deploy | Render (backend), Vercel (frontend) |

---

## How it works

### 1. Interview phase
`middleware/interviewer.js` — the user's raw message is turned into structured context over up to `MAX_TURNS` (default 4) focused questions. If the model's JSON response fails to parse (e.g. escaping issues from pasted code), a deterministic fallback rebuilds context directly from conversation history — never blocks on a malformed model response.

### 2. Context layout
`pipeline/extractor.js`'s `buildBrief` — Groq compresses the structured context into one clean, complete brief. This step does **not** diagnose anything; it preserves technical content (errors, code, exact numbers) verbatim and flags if the report actually describes multiple distinct issues.

### 3. Diagnostic call
`pipeline/runner.js`'s `callUserLLM` — one call to whichever provider the user connected. The prompt (`buildDiagnosticPrompt`) explicitly asks the model to:
1. Diagnose with cited evidence (specific line/property/behavior, not a generic guess)
2. Ask a targeted clarifying question if it isn't confident, rather than proceed on a guess
3. If confident: provide one complete fix per diagnosed issue
4. Self-critique the fix before presenting it

Clarification detection isn't limited to an exact string match — since models don't always comply with a literal prefix, the pipeline also recognizes genuine unlabeled questions (short, ends in `?`, no code block) as a clarification request rather than letting them silently fall through as a confident answer.

### 4. Verification
`pipeline/fixVerifier.js` — any npm packages imported in the fix are checked against the live registry. This is the one check kept as deterministic fact-lookup rather than model opinion.

### 5. Action plan
`pipeline/interpreter.js` — Groq restructures the raw diagnostic response into UI-ready sections (diagnosis, fix, self-critique, what to verify, what could go wrong), tagging each fix section with its verification status.

---

## Supported LLM providers

Connect your own key for any of:

| Provider | Models used |
|---|---|
| Claude | `claude-sonnet-4-6` / `claude-opus-4-6` (complex tasks) |
| OpenAI | `gpt-4o-mini` / `gpt-4o` (complex tasks) |
| Gemini | `gemini-flash-latest` / `gemini-pro-latest` (complex tasks) |
| Groq | `llama-3.1-8b-instant` / `llama-3.3-70b-versatile` (complex tasks) — useful for testing, not recommended as your primary diagnostic model |

Your key is used only for the session — never logged or stored server-side.

---

## Run locally

```bash
# Clone
git clone https://github.com/sairam676/prompt-proxy.git
cd prompt-proxy

# Install backend dependencies
npm install

# Setup env
cp .env.example .env
# Fill in GROQ_API_KEY, REDIS_URL, and (optional, for local testing
# without pasting a key into the UI each time) TEST_LLM_PROVIDER + TEST_LLM_KEY

# Start backend
npm run dev

# In a second terminal — start frontend
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`

### Environment variables

```
GROQ_API_KEY=gsk_...            # from console.groq.com (free) — powers context layout + response structuring
REDIS_URL=rediss://...          # from upstash.com (free) — session state
PORT=3000
NODE_ENV=development

# Optional — local dev convenience only. Lets you hit the SSE endpoint
# directly without passing ?provider=&apiKey= on every request. The
# frontend passes these explicitly per-session for real use; this is a
# stand-in so you don't need a running frontend session to test the
# diagnostic call. Should not be relied on in production.
TEST_LLM_PROVIDER=claude        # claude | openai | gemini | groq
TEST_LLM_KEY=...

MAX_TURNS=4
```

---

## API

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/pipeline/start` | Send raw message, begin interview |
| POST | `/api/pipeline/reply` | Answer an interview question, or resume after a clarification answer |
| GET  | `/api/pipeline/run/:sessionId` | SSE stream — runs the full diagnostic pipeline, streaming each step live |

---

## Project structure

```
prompt-proxy/
├── src/
│   ├── server.js                       ← Express entry point
│   ├── routes/pipeline.js              ← SSE orchestration + session lifecycle
│   ├── middleware/
│   │   └── interviewer.js              ← Context extraction (Q&A loop)
│   ├── pipeline/
│   │   ├── runner.js                   ← Orchestrates the full diagnostic flow, calls user's LLM
│   │   ├── extractor.js                ← Context compression + diagnostic prompt construction
│   │   ├── fixVerifier.js              ← npm registry fact-check
│   │   └── interpreter.js              ← Structures raw LLM response into UI action plan
│   └── services/
│       └── sessionStore.js             ← Interview/session state (Redis-backed)
└── frontend/src/
    └── App.jsx                         ← React UI — chat, live step feed, provider connection, results
```

---

## Known limitations / open items

- Clarification detection uses a heuristic fallback for models that skip the exact requested prefix — not foolproof, but validated against repeated real-world cases across multiple providers
- `sufficiencyGate.js` is retained but unused — no code currently imports it; kept for reference on the prior hypothesis-competition design
- No persistent user accounts yet — sessions are ephemeral, keyed by `sessionId`

---

## Roadmap

- [ ] Tighten clarification-question detection further (currently heuristic-based fallback)
- [ ] Streaming token-by-token diagnostic output (currently streams pipeline *steps*, not token-level output)
- [ ] User accounts + cross-session history
- [ ] Semantic caching for repeated/similar reports

---

## Author

**Sairam Devarasetty** — [linkedin.com/in/sairamdevarasetty676](https://linkedin.com/in/sairamdevarasetty676) · [github.com/sairam676](https://github.com/sairam676)

NIT Patna · CS 2027

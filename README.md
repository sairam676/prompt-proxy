# PromptProxy

We extract. We brief. Your LLM solves it right.

PromptProxy is a middleware layer that sits between you and your LLM. Instead of
you going back and forth with your LLM guessing at what's wrong, PromptProxy
interviews you, forms and tests competing hypotheses about the actual cause,
verifies the fix your LLM proposes, and hands you a clean action plan — one
LLM call, not five.

## Why

Talking directly to a big LLM about a real bug usually means: you under-describe
the problem, the LLM guesses, guesses wrong, you clarify, it guesses again,
and three round-trips later you have a fix that may or may not actually be
correct — with no one checking it before you paste it into your codebase.

PromptProxy's job is to be the layer that:
- Extracts full context before ever calling the expensive LLM
- Refuses to guess when it's genuinely ambiguous — asks ONE targeted question instead
- Sends exactly one surgical, complete prompt to your LLM
- Verifies the fix (syntax/type/API checks, plus a real npm registry lookup for
  fabricated packages) before showing it to you
- Strips padding — one fix per diagnosed issue, not a menu of five options

## Architecture

```
User message
    │
    ▼
Interviewer (Groq, llama-3.3-70b)         middleware/interviewer.js
    │  extracts structured_context from the conversation
    ▼
┌─────────────────────────────────────────────────────────┐
│  Debugging task?                                          │
│  ── no  → simple path: one prompt, one LLM call, done      │
│  ── yes → full pipeline below                              │
└─────────────────────────────────────────────────────────┘
    │
    ▼
Hypothesis Engine (Groq)                   pipeline/extractor.js
    │  generates 2-4 competing hypotheses PER distinct issue
    │  (a report can describe multiple independent bugs)
    ▼
Sufficiency Gate                           pipeline/sufficiencyGate.js
    │  top hypothesis > 80% confidence AND runner-up < 40% → proceed
    │  otherwise → ask a targeted tie-break question, scoped to
    │  only the ambiguous issue (resolved issues aren't re-asked)
    │
    │  user can force through at any point ("that's all I have") —
    │  takes the current top hypothesis per issue as-is
    ▼
Surgical Prompt Builder (Groq)             pipeline/extractor.js
    │  one complete prompt per diagnosis, explicit "no menu of
    │  options" instruction, one fix per issue if multiple
    ▼
Your LLM (Claude / OpenAI / Groq — your key, your credits)
    │  exactly ONE call
    ▼
Fix Verifier                               pipeline/fixVerifier.js
    │  LLM check: syntax, types, standard-library API correctness
    │  DETERMINISTIC check: imported npm packages verified against
    │  the real registry — not another LLM's guess
    ▼
Interpreter (Groq)                         pipeline/interpreter.js
    │  builds the final action plan, tags each section with its
    │  issue + verification status, enforces one-fix-per-issue
    ▼
Result shown to user
```

## Setup

```bash
cd frontend && npm install
cd .. && npm install
```

Environment variables (`.env`):
```
GROQ_API_KEY=          # required — powers the interviewer/hypothesis/verifier/interpreter
REDIS_URL=              # session storage
TEST_LLM_PROVIDER=      # optional, for local testing without going through the /key screen
TEST_LLM_KEY=
VERIFIER_V2=false        # flip to true to enable semantic/concurrency checks (heavier)
```

Run:
```bash
node src/server.js       # backend
cd frontend && npm run dev   # frontend
```

## Project structure

```
src/
├── middleware/
│   ├── interviewer.js       interview loop — extracts structured_context
│   ├── correctnessLayer.js  pre-pipeline check for missing critical facts
│   ├── promptBuilder.js
│   ├── taskClassifier.js
│   └── tokenEstimator.js
├── pipeline/
│   ├── extractor.js         hypothesis engine + surgical prompt builder
│   ├── sufficiencyGate.js   confidence gate, multi-issue grouping, force-proceed
│   ├── fixVerifier.js       LLM checks + deterministic npm registry check
│   ├── interpreter.js       final action plan, relevance constraint, verification tagging
│   └── runner.js            orchestrates the full pipeline
├── routes/
│   ├── chat.js               older single-shot prompt-building flow
│   └── pipeline.js           SSE pipeline flow (interview → run → tie-break loop)
├── services/
│   └── sessionStore.js       Redis-backed session state
└── cache/redis.js

frontend/src/App.jsx           chat UI + live pipeline step feed + result card
```

## Known issues / in progress

- **Interviewer JSON leak**: when the interviewer's raw JSON response contains
  unescaped characters (common with pasted code blocks with backticks/quotes),
  `JSON.parse` fails silently and the raw JSON can leak into the chat as a
  message instead of being parsed. Fix in progress in `interviewer.js`.
- **Task-type gating** (`isDebuggingTask` in `runner.js`) is a regex heuristic,
  not a real classifier — `taskClassifier.js` exists in the repo but isn't
  wired into the pipeline route yet. Works for obvious cases, may misclassify
  edge cases.
- **`chat.js` and `pipeline.js` are largely duplicate interview flows.**
  `chat.js` is the older single-shot flow; `pipeline.js` is the current
  SSE-based one with the full hypothesis/gate/verify pipeline. Worth
  consolidating once the pipeline flow is stable.
- **Verifier LLM checks (syntax/types/API) are opinion-based**, not
  deterministic — only the npm package existence check is a real lookup.
  Worth extending the same pattern (real checks over LLM guesses) to syntax
  validation (e.g. actually running a parser) where feasible.

## Design principle

Prompts are not the last line of defense. Anything that can be checked
deterministically (does this package exist, is this JSON valid, is this
confidence score above a threshold) should be — LLM judgment is reserved for
things that genuinely require reasoning (does this fix address the diagnosed
cause, is this the standard approach). This is an ongoing effort, not fully
applied everywhere yet — see Known issues above.

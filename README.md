# PromptProxy

> AI middleware that extracts context, isolates root cause via competing hypotheses, sends ONE surgical prompt to your LLM, and verifies the fix before you see it.

**Live → [prompt-proxy-mocha.vercel.app](https://prompt-proxy-mocha.vercel.app)**
**GitHub → [github.com/sairam676/prompt-proxy](https://github.com/sairam676/prompt-proxy)**

---

## The problem it solves

When you paste a vague problem into Claude or GPT, the LLM guesses at intent, hallucinates context it doesn't have, and gives you a fix that looks right but isn't. You spend hours debugging the LLM's answer instead of your actual bug.

PromptProxy sits between you and your LLM:
- We extract everything the LLM needs before it sees your problem
- We generate competing hypotheses and only proceed when one clearly wins
- Your LLM gets called exactly once with a complete, grounded prompt
- We verify the fix before you see it

---

## Pipeline

```
Your problem (paste anything — code, error, question, task)
        ↓
Interview (Groq/Llama — free)
  Asks targeted questions to extract full context verbatim
  Stops when it has enough — no fixed question limit
        ↓
Route decision:
  Debugging/code task? → Full hypothesis engine
  Simple task?         → Straight to your LLM
        ↓
[DEBUGGING PATH]
Hypothesis Engine (Groq — free)
  Generates 2-4 competing theories with confidence scores 0-100
  Evidence for/against each, per distinct issue
        ↓
Sufficiency Gate (deterministic — no LLM)
  Top hypothesis > 75% AND runner-up < 45%? → Proceed
  Too close?                                → Ask one targeted tie-break question
  User answers → re-score only the two competing hypotheses (8B model, cheap)
  Loop until gate passes
        ↓
Surgical Prompt Builder (Groq — free)
  Built from confirmed diagnosis only — not a guess
  Includes all user context verbatim
        ↓
[BOTH PATHS JOIN HERE]
Your LLM — called ONCE (your key, your credits)
  Claude / OpenAI / Groq
        ↓
Fix Verifier (Groq — free)
  Syntax, types, API correctness
  Deterministic npm registry check — actual HTTP lookup, not LLM guessing
  v2 (flag): semantics, concurrency, race conditions
        ↓
Action Plan
  Root cause + mechanism
  Fix with full code (verbatim from LLM)
  Verification status per section (verified/unverified/rejected)
  What to test + what to watch for
  What the LLM missed
```

---

## What we use vs what you pay for

| Step | Who runs it | Cost |
|------|------------|------|
| Interview | Our Groq (Llama 3.3 70B) | Free |
| Hypothesis engine | Our Groq (Llama 3.3 70B) | Free |
| Tie-break rescore | Our Groq (Llama 3.1 8B) | Free |
| Surgical prompt builder | Our Groq (Llama 3.3 70B) | Free |
| **Final LLM call** | **Your key (Claude/GPT/Groq)** | **Your credits** |
| Fix verifier | Our Groq (Llama 3.1 8B) | Free |
| Interpreter | Our Groq (Llama 3.3 70B) | Free |

You pay for exactly one LLM call — the one that actually solves your problem.

---

## Token savings

Without PromptProxy, a typical debugging session:
- 5 back-and-forth turns
- Each turn: vague user message + repeated context + LLM response
- ~3x token waste per turn from repeated/vague context

With PromptProxy:
- 1 surgical call with complete, grounded context
- No repeated context, no vague prompts, no hallucination-fixing turns

---

## Stack

| Layer | Tech |
|---|---|
| Interview + pipeline | Groq (Llama 3.3 70B / 3.1 8B instant) |
| User LLM | Claude (Anthropic) / OpenAI / Groq |
| Session cache | Upstash Redis |
| Backend | Node.js, Express, SSE streaming |
| Frontend | React, Vite |
| Deploy | Render (backend) + Vercel (frontend) |

---

## Run locally

```bash
# Clone
git clone https://github.com/sairam676/prompt-proxy.git
cd prompt-proxy

# Install
npm install

# Environment
cp .env.example .env
# Fill in: GROQ_API_KEY, REDIS_URL

# Start backend
npm run dev

# Frontend (separate terminal)
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`

---

## Environment variables

```env
GROQ_API_KEY=gsk_...          # from console.groq.com (free)
REDIS_URL=rediss://...         # from upstash.com (free)
PORT=3000
NODE_ENV=development
VERIFIER_V2=false              # set true to enable concurrency/semantics checks
```

---

## File structure

```
src/
├── pipeline/
│   ├── extractor.js          # Hypothesis engine + surgical prompt builder + rescore
│   ├── sufficiencyGate.js    # Deterministic gate (75/45 threshold) + tie-break
│   ├── fixVerifier.js        # v1 checks + npm registry lookup
│   ├── interpreter.js        # Relevance-constrained action plan
│   └── runner.js             # Orchestrator — simple vs complex path
├── middleware/
│   └── interviewer.js        # LLM-driven context extraction
├── routes/
│   └── pipeline.js           # SSE endpoint + tie-break session state
├── cache/redis.js
├── services/sessionStore.js
└── server.js

frontend/src/
└── App.jsx                   # Live step feed, hypothesis display, result card
```

---

## Current state

**Working well:**
- Debugging, security vulnerabilities, performance bugs, system design
- Multi-issue detection (reports describing 2 unrelated bugs handled separately)
- Fix verifier catches bad fixes (wrong API usage, fake npm packages)
- Tie-break loop with hypothesis memory (re-scores only competing pair, not full reset)
- Simple task bypass — writing/learning/analysis skips hypothesis engine

**Not built yet:**
- Auth + encrypted API key storage (user pastes key each session currently)
- File upload (resume, JD, code files — user pastes manually now)
- Regression test suite
- Semantic/concurrency verifier (v2, behind flag)

---

## Built by

**Sairam Devarasetty** — NIT Patna CS 2027
[linkedin.com/in/sairamdevarasetty676](https://linkedin.com/in/sairamdevarasetty676) · [github.com/sairam676](https://github.com/sairam676)

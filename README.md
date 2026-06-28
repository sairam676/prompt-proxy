# ⚡ PromptProxy

> LLM middleware that interviews you before calling AI — stops hallucinations and cuts token usage by 40–70%.

**Live demo → [prompt-proxy-mocha.vercel.app](https://prompt-proxy-mocha.vercel.app)**

---

## The problem

Most people prompt AI blindly with vague requests like *"explain RAG"* or *"write me an email"*. The LLM guesses intent, hallucinates context, and you spend 3–5 back-and-forth turns getting what you actually wanted — burning tokens the whole time.

## The solution

PromptProxy sits between you and the LLM. It acts as a smart interviewer — asks you targeted questions to extract exactly what you need, builds a tight structured prompt, then calls the LLM once with the minimum tokens required.

```
Your vague request
      ↓
Interviewer LLM (asks 1–4 focused questions)
      ↓
Structured context extracted
      ↓
Redis cache check → HIT: instant response
      ↓ MISS
Task classifier → picks token budget template
      ↓
Optimized prompt built (role + context + task + format)
      ↓
LLM called with dynamic max_tokens
      ↓
Clean response + token savings report
```

---

## Features

- **Smart interviewer** — Llama 3.3 70B asks targeted clarifying questions, max 4 turns
- **Task classification** — detects code / analysis / creative / factual / summarization / transformation and applies the right token budget
- **Anti-hallucination** — strict output format constraints prevent the LLM from drifting or over-generating
- **Redis caching** — identical intents return instantly with zero API cost
- **Token savings dashboard** — shows naive vs optimized token count, actual cost, and budget fit
- **Dynamic max_tokens** — output cap set per task type, not hardcoded

---

## Tech stack

| Layer | Tech |
|-------|------|
| Backend | Node.js, Express |
| Interviewer LLM | Groq (Llama 3.3 70B) |
| Cache | Upstash Redis |
| Frontend | React, Vite |
| Deploy | Render (backend), Vercel (frontend) |

---

## How it works

### 1. Interview phase
User sends a raw prompt. The interviewer LLM asks one focused question at a time — goal, format, constraints, audience — until it has enough context. Max 4 questions.

### 2. Task classification
The structured context is classified into one of 6 task types using keyword signals. Each type has a token budget template with preset ranges per bucket and a `maxOutputTokens` cap.

### 3. Prompt building
Two hard rules on every prompt:
- **Role + context + task + format** — no filler words
- **"If unsure, say so"** — prevents hallucination without blocking general knowledge

### 4. Redis cache
Context is SHA-256 hashed. On a cache hit, the LLM is skipped entirely. TTL: 24 hours.

### 5. Token tracking
- Before call: character-based estimate (1 token ≈ 4 chars)
- After call: Anthropic/Groq actual `usage.prompt_tokens` and `usage.completion_tokens`

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
# Fill in GROQ_API_KEY and REDIS_URL

# Start backend
npm run dev

# In a second terminal — start frontend
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`

### Environment variables

```env
GROQ_API_KEY=gsk_...          # from console.groq.com (free)
REDIS_URL=rediss://...         # from upstash.com (free)
PORT=3000
NODE_ENV=development
CACHE_TTL=86400
MAX_TURNS=4
```

---

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/chat/start` | Send raw prompt, begin interview |
| POST | `/api/chat/reply` | Answer an interviewer question |
| POST | `/api/chat/execute` | Build prompt + call LLM |
| GET | `/api/chat/analytics/:id` | Token savings for session |
| GET | `/health` | Health check |

---

## Project structure

```
prompt-proxy/
├── src/
│   ├── server.js                   ← Express entry point
│   ├── routes/chat.js              ← Orchestrator
│   ├── middleware/
│   │   ├── interviewer.js          ← Q&A loop (core IP)
│   │   ├── promptBuilder.js        ← Context → tight prompt
│   │   ├── taskClassifier.js       ← Task type + budget template
│   │   └── tokenEstimator.js       ← Token counting + savings
│   ├── cache/redis.js              ← Response cache + analytics
│   └── services/
│       ├── claude.js               ← LLM API call
│       └── sessionStore.js         ← Interview state
└── frontend/src/
    └── App.jsx                     ← React UI
```

---

## Roadmap

- [ ] Semantic cache (embedding similarity at 0.92 threshold)
- [ ] Streaming responses via SSE
- [ ] User accounts + cross-session savings dashboard
- [ ] Prompt template library
- [ ] Support for OpenAI, Gemini, Claude model switching

---

## Author

**Sairam Devarasetty** — [linkedin.com/in/sairamdevarasetty676](https://linkedin.com/in/sairamdevarasetty676) · [github.com/sairam676](https://github.com/sairam676)

NIT Patna · CS 2027

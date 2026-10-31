# Local model feasibility for OpenClaw / Hermes agents (CPU-only)

> Notes from 2026-10-31. Every number below was measured on our own boxes
> with Ollama 0.40.13. Anything not measured is labelled as such. The
> procedure lives in `docs/runbooks/live-inference-switch-ollama.md`; this
> page answers a separate question: **is a small local model good enough to
> run our agents on?**

## Verdict

**Not on CPU-only boxes.** A small model such as `lfm3:latest` works
end to end: both agents answered correctly through NemoClaw's
`ollama-local` route. But turns take **3–15 minutes**, because every turn
re-reads the agent's large system prompt. That is too slow for chat and
breaks OpenClaw's 600 s run timeout. Local inference becomes realistic
only with a GPU (not measured here), or with agents whose prompts are much
smaller than ours.

## Why it's slow: the prompt, not the model

Agent turns are dominated by **reading the prompt (prefill)**, not by
writing the answer. Each request carries the agent's system prompt, tool
catalogue, skills, memory and conversation:

| Agent | Prompt per turn |
|---|---|
| Fresh OpenClaw sandbox | ~10–11k tokens |
| Fresh Hermes sandbox | larger than OpenClaw (not counted exactly) |
| Live `ivos-openclaw` (Oracle, months of use) | **26,926 tokens** |
| Live `ivos-hermes` (Oracle, months of use) | **37,544 tokens** |

Rule of thumb for a cold turn:

```
turn time ≈ prompt_tokens / prefill_rate  +  answer_tokens / decode_rate
```

The answer term is small for short replies (tens of tokens at 3–5 tok/s),
so the prompt term decides. Prefill also slows down as the prompt gets
longer: on Oracle it fell from 78 to 41 tok/s over a 33k-token prompt.

## Measurements

### lfm3:latest (Liquid LFM3, 1.7B, Q4_K_M, hybrid conv/attention, tools + thinking, 256k context)

| Box | Prefill | Decode | Real turn |
|---|---|---|---|
| Hetzner cx33: 4 shared vCPU AMD EPYC-Rome, 7.6 GiB | 58–70 tok/s | 2.6–4 tok/s | OpenClaw (10–11k prompt) **3 min 10 s – 3 min 31 s**; Hermes **~5 min** |
| Oracle A1: 4 ARM Neoverse-N1, 24 GB | 78 → 41 tok/s (falls with length) | 4.5 tok/s | OpenClaw (26.9k) **9 min 50 s**; Hermes (37.5k) **~15 min** |

**No prompt caching across turns.** llama.cpp cannot reuse a cached
prompt prefix for hybrid/recurrent models, and logs every turn with
`forcing full prompt re-processing due to lack of cache data (likely due
to SWA or hybrid/recurrent memory)`. Follow-up turns cost as much as the
first, so the "Ollama caches the prompt" assumption does **not** hold
for lfm3.

Memory (llama-server RSS on the cx33; `ollama ps` under-reports it):

| `OLLAMA_CONTEXT_LENGTH` | `ollama ps` size | RSS |
|---|---|---|
| 4,096 (default) | 1.1 GiB | — |
| 65,536 | 1.6 GiB | — |
| 131,072 | 1.8 GiB | 2.7 GiB |
| 262,144 | 2.3 GiB | 4.3 GiB |

### llama3.2:1b (Meta, 1.2B, Q8_0, standard attention, tools, 128k context)

Tried on Oracle because standard-attention models *can* reuse a cached
prompt prefix.

- Synthetic 7.6k-token prompt: turn 1 took **294 s at 29 tok/s**, slower
  per token than lfm3. Follow-up turn: **9 s**, so the cache was reused.
- With the real OpenClaw agent (23k-token prompt), turn 1 hit OpenClaw's
  **600 s run timeout** and failed. Turn 2 landed on the *other*
  `OLLAMA_NUM_PARALLEL=2` slot and started reading from scratch, so the
  cache never helped.
- 128k context × 2 slots used **10.5 GiB** (`ollama ps`).

### Not measured

| Model | Why not |
|---|---|
| `qwen3:1.7b` | Its 40k native context is below NemoClaw's **64k Hermes minimum**, and Hermes's prompt is already 37.5k. It could only serve OpenClaw. Dropped when we wrapped up. |
| `qwen3:4b`, `llama3.2:3b`, `granite3.3:2b` | Prefill time grows with parameter count, so these would be slower than lfm3 on the same CPUs. `granite3.3:2b` was pulled but OOM-killed while loading next to other models; never benchmarked. |
| Any GPU box | No GPU available (Hetzner Cloud only, per our hosting rule). Expected to be much faster at prefill, but we have no numbers. |

## Hard constraints any local model must meet

| Constraint | Source | Effect |
|---|---|---|
| Tool calling | Both agents call tools every turn | `ollama show <m>` must list `tools` |
| Context ≥ 64,000 tokens (Hermes), ≥ 16,384 (OpenClaw) | NemoClaw `MIN_HERMES_OLLAMA_CONTEXT_WINDOW` / `MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW` | Rules out 32k/40k-context models for Hermes. Ollama's default 4,096 must be raised via `OLLAMA_CONTEXT_LENGTH` |
| A cold turn must finish in under 600 s for OpenClaw | OpenClaw `agents.defaults.timeoutSeconds` default | At ~50 tok/s that caps the prompt near 25–30k tokens; Oracle's OpenClaw is already at the edge |
| Route timeout | OpenShell route default 60 s | Must be raised: `openshell inference set … --timeout 1800` |
| RAM for model + KV cache, plus everything else on the box | All KV memory is allocated at load | Size against RSS, not `ollama ps`. Set `OLLAMA_MAX_LOADED_MODELS=1`; several large-context models at once OOM-killed llama-server on a 24 GB box |

## What would make it feasible

In rough order of impact. None of these were tried, unless noted.

1. **A GPU.** Prefill is the bottleneck, and it is what GPUs are fastest
   at. This is the only option that fixes every turn. Requires hosting
   outside our Hetzner Cloud default.
2. **Smaller agent prompts.** Turn time scales roughly linearly with prompt
   size. Trimming tools, skills and memory on the agent side helps any
   backend. Our long-lived agents grew from ~11k to 27–37k tokens.
3. **A standard-attention model with prefix caching, plus a longer
   OpenClaw timeout.** Follow-ups would then be fast (9 s in the synthetic
   test), but the first turn of every session stays slow. This also needs
   `OLLAMA_KEEP_ALIVE` set long, since the default 5 min unload discards the
   cache, and one slot per agent. Background requests (heartbeats, cron,
   probes) can still wipe a slot.
4. **A bigger CPU box** (dedicated-core CCX). Roughly linear in core count,
   so 8 dedicated cores should about halve the times above. Still minutes
   per cold turn for our agents.

## When a local model *is* reasonable today

- Short-prompt, offline or batch work, where minutes per turn is acceptable.
- The PII router's local leg (`scripts/pii-router/`), which only sends turns
  containing personal data to Ollama. The rest go to NVIDIA, so the slow
  path is the exception.
- Privacy-first setups where the operator accepts the latency.

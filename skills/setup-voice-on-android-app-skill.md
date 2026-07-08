---
name: openclaw-talk-setup
description: Diagnose and configure OpenClaw Talk voice on Android - providers, keys, models, transport
tags: voice, android
agents: openclaw
---

# OpenClaw Talk Setup

Configure OpenClaw Gateway for two-way voice conversations with Android app.

## Prerequisites

- OpenClaw Gateway running (default port 18789)
- Android OpenClaw app installed and connected
- API keys provisioned:
  - **Google Gemini** (`AQ.ab8RN...`) — **recommended** realtime STT/TTS provider (generous free tier)
  - **OpenAI** (`sk-proj-...`) — backup realtime provider
  - **ElevenLabs** (`sk_xxx...`) — HTTP TTS for text responses

## 🚨 OpenShell Sandbox: Network & Permissions

If `openclaw` is running inside an OpenShell sandbox, **all outbound network is blocked by default** (DNS proxy at `10.200.0.1:3128`). This means API calls to voice providers will fail until the operator grants permission.

**Do NOT assume requests are blocked without trying.** Always attempt the request first — when OpenClaw makes a request to a blocked endpoint, it raises an approval request visible to the operator. Then tell them: *"Please approve the pending request in your OpenShell dashboard, then retry."*

A failed request isn't the end state — it triggers the operator approval workflow. Only declare "blocked" after you've actually tried and received a policy denial (not DNS/timeout/TLS errors).

### Sandbox Constraints
- **No `.bashrc` access** — API keys go directly in `openclaw.json` env.vars
- **Outbound network blocked by default** — requires operator approval via proxy
- **journalctl limited** — only 10-min window accessible via exec
- **Single port (18789)** handles all traffic — chat + WebRTC + WebSocket relay
- **Reverse proxy on single port** — no path-based WebRTC rules needed

## Recommended Configuration (Gemini)

Place in `/sandbox/.openclaw/openclaw.json`:

```json
{
  "env": {
    "vars": {
      "ELEVENLABS_API_KEY": "<key>",
      "OPENAI_API_KEY": "<key>",
      "GEMINI_API_KEY": "<key>"
    }
  },
  "talk": {
    "provider": "elevenlabs",
    "providers": {
      "elevenlabs": {
        "apiKey": "${ELEVENLABS_API_KEY}",
        "voiceId": "elevenlabs_voice_id",
        "modelId": "eleven_v3",
        "outputFormat": "mp3_44100_128"
      },
      "openai": {
        "apiKey": "${OPENAI_API_KEY}"
      },
      "google": {
        "apiKey": "${GEMINI_API_KEY}",
        "model": "gemini-live-2.5-flash"
      }
    },
    "speechLocale": "en-US",
    "silenceTimeoutMs": 1500,
    "interruptOnSpeech": true,
    "realtime": {
      "provider": "google",
      "providers": {
        "openai": {
          "apiKey": "${OPENAI_API_KEY}",
          "model": "gpt-realtime-2",
          "speakerVoice": "cedar"
        },
        "google": {
          "apiKey": "${GEMINI_API_KEY}",
          "model": "gemini-live-2.5-flash"
        }
      },
      "instructions": "Speak warmly and keep answers brief.",
      "mode": "realtime",
      "transport": "webrtc",
      "brain": "agent-consult"
    }
  },
  "messages": {
    "tts": {
      "auto": "always"
    }
  }
}
```

## Key Components

| Field | Purpose | Notes |
|-------|---------|-------|
| `env.vars.OPENAI_API_KEY` | Primary source of truth for OpenAI key | Must match talk.providers.openai AND talk.realtime.providers.openai |
| `env.vars.GEMINI_API_KEY` | Primary source of truth for Gemini key | Must match talk.realtime.providers.google.apiKey |
| `talk.provider` | Default TTS provider for text responses | Set to `elevenlabs` |
| `talk.realtime.provider` | Provider for voice calls | Set to `google` (preferred) |
| `talk.realtime.model` | Voice model | Must exist in provider's model list |
| `talk.realtime.transport` | Audio transport | See troubleshooting below |
| `talk.realtime.mode` | Operation mode | `realtime` for full voice conversation |
| `talk.interruptOnSpeech` | VAD interrupt | User speech interrupts agent mid-response |
| `talk.silenceTimeoutMs` | Session auto-close | 1500ms recommended |
| `messages.tts.auto` | Auto-TTS for chat responses | `always`, `on`, or `off` |

## Provider Comparison

| Provider | Free Tier | Quality | Cost After Free | Setup |
|----------|-----------|---------|-----------------|-------|
| **Google Gemini** | Generous (no expiry mentioned) | Good | Usage-based | API key from Google AI Studio |
| **OpenAI** | ~$5 credit then pay-as-you-go | Excellent | Pay-per-minute | Platform API key |

**Recommendation:** Start with Google Gemini (free). If you need OpenAI's superior voice quality later, switch `talk.realtime.provider` to `openai`.

## Troubleshooting — Decision Tree

### 1. "Unknown Talk session" / session dies immediately after pressing Start Talk

This is **ALWAYS** an API key problem. The session initializes locally, then fails when connecting to the provider. Silent failure = no gateway logs.

**Fix for Gemini:**
```
curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}" | head -5
```
If returns empty/error → replace key.

**Fix for OpenAI:**
```
curl -s https://api.openai.com/v1/models \
  -H "Authorization: Bearer ***" | head -5
```
If returns `invalid_api_key` → replace key in env.vars AND all provider sections.

**Critical:** You may have TWO different keys (one per provider):
- HTTP/TTS provider (`talk.providers.openai.apiKey` / `talk.providers.google.apiKey`)
- Realtime provider (`talk.realtime.providers.openai.apiKey` / `talk.realtime.providers.google.apiKey`)
Test BOTH against their respective REST endpoints independently.

### 2. Session starts but no audio / silent agent

Check `messages.tts.auto` is set to `always`. If off, agent responds as text only even when voice works.

### 3. No gateway logs at all after pressing Start Talk

Provider auth failure (see #1). The session aborts before logging.

### 4. Realtime model not found / 404

Model names differ by provider:
```jsonc
// Google Gemini models:
gemini-live-2.5-flash
// NOT gemini-2.5-flash (without "live-")

// OpenAI realtime models:
gpt-realtime-mini
gpt-realtime-2
gpt-realtime-1.5
// NOT gpt-4o-mini-realtime-preview (does not exist)
```

### 5. WebRTC transport failing (ICE/connection drops)

Two solutions:
- **gateway-relay**: multiplexes over existing WS connection (port 18789). No port forwarding needed. Good for reverse proxy setups.
- **webrtc**: direct browser→provider WS. Better latency but requires:
  - Direct IP or subdomain with TLS
  - Port forwarding if behind NAT
  - No proxy/DNS issues with provider endpoints

Choose based on your network setup. For reverse proxy on single port → use `gateway-relay`.

### 6. Switching between Gemini and OpenAI

To switch to OpenAI realtime instead of Gemini:
1. Change `talk.realtime.provider` to `openai`
2. Ensure `talk.realtime.providers.openai.apiKey` has a valid key
3. Restart gateway

To switch back to Gemini:
1. Change `talk.realtime.provider` to `google`
2. Ensure `talk.realtime.providers.google.apiKey` has a valid key
3. Restart gateway

Both providers stay registered simultaneously — just change the `provider` field.

### Forcing a Clean OpenClaw Restart (When API `restart` Fails)

The gateway's built-in `restart` action only sends `SIGUSR1` (graceful reload), which **does not clear the talk module's runtime cache**. Changing `talk.realtime.provider`, `talk.realtime.transport`, or any other talk config via the API will **not take effect** until the process fully exits and restarts.

**Check for overlapping processes first:**
```bash
pgrep -fa openclaw
```
If you see more than one `openclaw` process, kill extras:
```bash
pgrep -f openclaw | tail -n +2 | xargs -r kill -9 2>/dev/null
```

**Force restart:**
```bash
kill -9 $(pgrep -f openclaw) 2>/dev/null
sleep 3
openclaw gateway start &disown
sleep 10
pgrep -fa openclaw # verify single process running
```

**Why this matters:**
- Both `gateway-relay` and `webrtc` transport values can be cached indefinitely by the running process
- Switching from `google` to `openai` (or vice versa) requires a full process restart to change active provider
- The config file may be correct while the live process serves stale values — always verify with a fresh session after restart
- Use this same pattern whenever you modify any `talk.*` config, especially after migration (OpenAI → Google Gemini etc.)

**Verify after restart:** check logs for `talkTransport: webrtc` or `provider: <new_provider>` in the first voice session events.

## Common Mistakes

1. **Truncated/placeholder API keys** — using `sk-proj...` or `***` instead of full key string causes silent failures
2. **Wrong model name** — `gpt-4o-mini-realtime-preview` doesn't exist; `gemini-2.5-flash` without `live-` prefix doesn't work
3. **TTS auto disabled** — voice works but response comes as text-only
4. **Mismatched keys between sections** — ensure `talk.providers` and `talk.realtime.providers` have matching keys
5. **Forgetting to restart gateway** after config changes
6. **Confusing ElevenLabs TTS with OpenAI/Gemini realtime STT** — they serve different purposes (TTS = speech synthesis, realtime = STT+TTs for live calls)
7. **Hardcoding keys instead of using ${VAR} references** — maintainability nightmare

## Post-Setup Checklist

- [ ] Provider API key validated via curl against provider endpoint
- [ ] Realtime model name confirmed exists for your provider
- [ ] `messages.tts.auto` set to `always`
- [ ] Gateway restarted after each config change
- [ ] Android app shows listening state when pressing Start Talk
- [ ] Speaking produces audible agent response
- [ ] Agent responds within ~3 seconds of completing speech
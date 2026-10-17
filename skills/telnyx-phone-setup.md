---
name: Telnyx phone setup
description: Give this agent a real phone number for inbound and outbound calls and SMS, using Telnyx. Covers buying the number, Voice API / Call Control, the media bridge to your voice brain, Messaging Profiles, 10DLC, and the sandbox network approval. Prerequisite for the receptionist, SDR, and recall roles.
tags: telnyx, voice, sms, telephony, phone
agents: any
---

You are setting up a real phone number so you can answer and place calls and
send and receive text messages. The carrier is **Telnyx**. Some steps are
yours (API calls, verifying the link); some belong to your operator (buying
numbers, DNS, approving network access, 10DLC registration) because they need
a human with billing and portal access. Where a step is the operator's, say so
and stop — do not try to work around it.

Use placeholders for every value. Never write a real key into a file that is
committed or shared:

- Telnyx API key: `<TELNYX_API_KEY>`
- Phone number (E.164): `<TELNYX_NUMBER>` e.g. `+15551234567`
- Messaging Profile ID: `<MESSAGING_PROFILE_ID>`
- Call Control / Voice App ID: `<VOICE_APP_ID>`
- Public webhook base (where Telnyx reaches your gateway): `<YOUR_WEBHOOK_URL>`

## How the pieces fit

```
Caller / phone  ──PSTN──▶  Telnyx  ──webhook/media──▶  your gateway (bridge)  ──▶  you (the agent)
SMS in/out      ──SMS───▶  Telnyx Messaging Profile  ──webhook──▶  your gateway  ──▶  you
```

Telnyx owns the number and the carrier link. Your gateway must be **publicly
reachable** so Telnyx can deliver webhooks to it — that is operator infra
(Traefik / a subdomain with TLS), the same reverse proxy that already fronts
this box. You supply the conversation and the tools; the carrier supplies the
line.

## 🚨 Sandbox network (do this first)

If you run inside an OpenShell sandbox, **all outbound network is blocked by
default**. Calls to `api.telnyx.com` will fail until the operator approves
them. Do not assume you are blocked — **make the request first**. A blocked
request raises an approval the operator can grant from the OpenShell
dashboard. Only call it "blocked" after a real policy denial (not a DNS /
timeout / TLS error).

Endpoints to get approved: `api.telnyx.com` (REST), and for Option B media
streaming your bridge's WebSocket host.

## Operator steps (portal — a human does these once)

1. **API key.** Mission Control Portal → **Auth → API Keys → Create**. This is
   `<TELNYX_API_KEY>`. Give it to the agent via the runtime's env vars, never
   in a skill or chat.
2. **Buy a number.** **Numbers → Buy Numbers**. Pick a local number for the
   client's area. Note it as `<TELNYX_NUMBER>` in E.164.
3. **Voice connection / Call Control App.** **Voice → Call Control / Voice API
   Applications → Create**. Set its webhook URL to `<YOUR_WEBHOOK_URL>/telnyx/voice`.
   Note the app id as `<VOICE_APP_ID>`. Assign the number to this app
   (**Numbers → the number → Voice → Connection**).
4. **Messaging Profile.** **Messaging → Create Messaging Profile**. Set its
   inbound webhook to `<YOUR_WEBHOOK_URL>/telnyx/sms`. Note `<MESSAGING_PROFILE_ID>`
   and assign the number to it.
5. **10DLC (US A2P SMS — required).** To send SMS to US numbers you must
   register a **Brand** and a **Campaign** (10DLC) under **Messaging → 10DLC**.
   Unregistered A2P traffic is filtered or blocked by carriers. This takes
   hours to days and is the operator's job. Voice and inbound SMS work before
   this; outbound SMS to US numbers does not.
6. **Emergency address** if the number requires it, and keep the account
   funded.

Tell your operator which of these are still missing before you promise the
client a working line.

## Verify your access (agent)

```bash
# Who am I / is the key good? Lists your numbers.
curl -s https://api.telnyx.com/v2/phone_numbers \
  -H "Authorization: Bearer <TELNYX_API_KEY>" | head -40
```

A JSON list with `<TELNYX_NUMBER>` in it = you can reach Telnyx and the number
is on the account. `401` = bad/missing key (ask operator). A DNS/timeout error
= the sandbox has not approved `api.telnyx.com` yet (see above).

## Outbound SMS

```bash
curl -s -X POST https://api.telnyx.com/v2/messages \
  -H "Authorization: Bearer <TELNYX_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
        "from": "<TELNYX_NUMBER>",
        "to": "+15557654321",
        "text": "Hi — this is {{business_name}}. Reply STOP to opt out.",
        "messaging_profile_id": "<MESSAGING_PROFILE_ID>"
      }'
```

Always include an opt-out line on the first message of a thread. Honor `STOP`:
when an inbound message is a stop word, record the number as opted out and
never text it again.

## Inbound SMS

Telnyx POSTs each inbound message to `<YOUR_WEBHOOK_URL>/telnyx/sms`. Your
gateway hands you the payload; the fields you care about are
`data.payload.from.phone_number`, `data.payload.to`, and `data.payload.text`.
Reply with the outbound-SMS call above, `from` = the number they texted.

## Voice — two ways to connect the line to your brain

Pick one with your operator. **A** is the fastest to stand up; **B** gives you
the most control.

### Option A — Telnyx AI Assistant hosts the voice loop (recommended to start)

Telnyx runs the speech-to-text, turn-taking, and text-to-speech on its side and
calls out to you only for logic:

1. Operator: **Voice → AI Assistants → Create**, attach `<TELNYX_NUMBER>`.
2. Give the assistant its instructions (the role's persona and rules — copy
   them from the role skill, e.g. the receptionist's).
3. Add **tools / webhooks** that point at your gateway for the actions you must
   perform: check calendar availability, create a booking, take a message, warm
   transfer to a human. Each tool call reaches you with structured arguments;
   you do the work and return a result the assistant speaks back.

You never touch raw audio. Your job is the tool handlers and the instructions.

### Option B — Call Control + media streaming to your realtime brain

You run the voice loop yourself through the `talk` realtime pipeline (see the
**openclaw-talk-setup** skill for the STT/TTS/model config). Telnyx streams
audio to a bridge the operator runs:

1. Inbound `call.initiated` arrives at `<YOUR_WEBHOOK_URL>/telnyx/voice`.
   Answer and start a bidirectional media stream:

   ```bash
   # answer
   curl -s -X POST https://api.telnyx.com/v2/calls/<CALL_CONTROL_ID>/actions/answer \
     -H "Authorization: Bearer <TELNYX_API_KEY>"
   # stream audio both ways to your bridge
   curl -s -X POST https://api.telnyx.com/v2/calls/<CALL_CONTROL_ID>/actions/streaming_start \
     -H "Authorization: Bearer <TELNYX_API_KEY>" \
     -H "Content-Type: application/json" \
     -d '{"stream_url":"wss://<YOUR_WEBHOOK_URL-host>/telnyx/media","stream_track":"both_tracks"}'
   ```

2. The bridge feeds that audio into the realtime provider and plays the
   provider's audio back over the same socket. Use `openclaw-talk-setup` for
   the `talk.realtime` provider/model/voice; the transport here is the Telnyx
   media stream, not WebRTC-to-app.

### Outbound call (SDR / recall)

```bash
curl -s -X POST https://api.telnyx.com/v2/calls \
  -H "Authorization: Bearer <TELNYX_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
        "connection_id": "<VOICE_APP_ID>",
        "to": "+15557654321",
        "from": "<TELNYX_NUMBER>"
      }'
```

The `call.initiated` webhook then fires exactly as for an inbound call, and you
answer / stream the same way.

## Verify end to end

- **SMS:** text the number from a phone; confirm the inbound webhook woke you;
  reply; confirm the phone receives it.
- **Voice:** call the number; confirm it answers and you (or the Telnyx
  assistant) speak and hear within ~3 seconds; hang up and confirm the call
  log recorded it.
- **Outbound:** place a test call and a test SMS to your own phone.

Report to the operator: number, which voice option is live, whether 10DLC is
approved (US SMS), and anything still blocked.

## Common mistakes

1. Promising calls before the gateway is publicly reachable — Telnyx cannot
   deliver webhooks to a private box.
2. Sending US A2P SMS before 10DLC is registered — silently filtered.
3. Numbers not in **E.164** (`+1…`) — the API rejects them.
4. Forgetting the sandbox network approval for `api.telnyx.com`.
5. No `STOP`/opt-out handling — a compliance problem, not just etiquette.
6. Using the same number for a dozen clients — give each client their own
   number and messaging profile so logs, opt-outs, and 10DLC stay separate.

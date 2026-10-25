# voice-bridge has moved

The phone-calls bridge (Dialt + Telnyx/Twilio -> OpenClaw / Hermes agents) now lives in its own repo,
with its history: **https://github.com/oidebrett/agent-voice-bridge**

manidae-cloud installs it at a pinned commit (`VOICE_BRIDGE_REF`) on every voice-enabled package —
AgentGateway, standalone OpenClaw / Hermes and OpenClaw Enterprise — so it no longer ships here.
Setup guide: https://github.com/oidebrett/agent-voice-bridge/blob/main/SETUP-GUIDE.md

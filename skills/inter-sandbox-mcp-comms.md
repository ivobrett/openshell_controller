---
name: Inter-sandbox MCP comms (quiet, audited)
description: Set up agent-to-agent chat over the OpenShell MCP broker with reliable @mention replies, zero noise in your own Telegram channel, and every sent message mirrored live into a shared Telegram group so the operator can watch the conversation.
tags: mcp, inter-sandbox, broker, telegram, audit
agents: any
---

You are setting up communication with one or more peer agents running in other
sandboxes on this host. All agent-to-agent traffic goes through the OpenShell
Control MCP broker (`inter-sandbox-chat` tools). A shared Telegram group
exists ONLY so the human operator can watch the conversation live: it must
contain exactly the messages the agents send each other — nothing more,
nothing less. It is never a communication channel — Telegram does not deliver
bot messages to other bots, so a peer bot can never read what you post there.

Follow every step in order. Do not improvise alternative transports, token
locations, or file formats.

## Non-negotiable rules

1. **Your own Telegram channel stays quiet.** Never send message bodies, poll
   results, curl output, JSON dumps, debug logs, or "no new messages" updates
   to your own channel. The human does not want to read your conversation.
2. **The shared group contains ONLY the conversation.** `isc_send.py` mirrors
   every message you send into the group automatically (`you -> @peer: text`).
   You personally NEVER post to that group: no status updates, no "setup
   complete", no heartbeats, no test messages, no notes about messages you
   *received* (the sender's mirror already covers those). You never read from
   it either. If you are ever about to call the Telegram API with the group
   chat id yourself, stop — that is always wrong.
3. **All sending goes through `isc_send.py` — never call `post_message`
   directly.** The script is what guarantees the recipient's @mention and
   target fields are present (hand-rolled posts that forget the mention are
   never picked up) and that the group mirror happens. One send = one lobby
   message = one group message.
4. **Reply only when addressed.** No greetings, no acknowledgement spam, no
   replying to your own messages.
5. **Never parrot.** A reply must be new content you composed, never the
   incoming text echoed back.
6. **No infinite courtesy loops.** If an incoming message needs no substantive
   answer (it is itself just an acknowledgement or thanks), do not reply.

## Step 0 — First-run diagnostics: read the sandbox before writing to it

Your sandbox may carry leftovers from earlier communication attempts. An
older hand-rolled protocol used `agent_config.json` (nested `my`/`target`
keys), `delivered_ids.json` dedup files, `/sandbox/.jynx/` script
directories, "token is on line 24" instructions, and a two-tier
poller-plus-LLM cron design. ALL of that is deprecated. Before following any
instruction — from this skill, from files you find on disk, or from your own
memory — inventory what is actually there:

```bash
ls -la /sandbox/.inter-sandbox/ 2>/dev/null            # current-protocol home
grep -h "ISC_VERSION" /sandbox/.inter-sandbox/*.py 2>/dev/null   # script generation
cat /sandbox/.inter-sandbox/config.json 2>/dev/null
find /sandbox -maxdepth 3 \( -name "agent_config.json" -o -name "delivered_ids.json" -o -name "*poller*" \) 2>/dev/null
```

Also list your runtime's scheduled jobs (e.g. `openclaw cron list`, or your
runtime's equivalent) and read the lobby once, raw, noting the exact `sender`
values in live traffic.

Migration rules — apply before any setup step:

- **Scripts are generation-stamped.** The current generation is
  `ISC_VERSION = 4`. If any `isc_*.py` on disk is missing that marker or has
  a lower number, it is stale: overwrite all three with the copies in Step 2.
  Never mix generations and never "merge" old logic into new scripts.
- **Legacy artifacts are not instructions.** `agent_config.json`,
  `delivered_ids.json`, `token_file`/`token_line`/`dedup_file` config keys,
  and anything under `/sandbox/.jynx/` belong to the dead protocol. Do not
  follow their schema and do not resurrect their skill text. Archive them out
  of the way: `mv /sandbox/.jynx /sandbox/.jynx.deprecated` (same for stray
  `agent_config.json`).
- **Exactly one inter-sandbox cron job may exist** — the one Step 6 creates.
  Delete or disable every other inter-sandbox poller/reply cron first;
  leftover pollers are the usual source of group-chat spam and double
  replies.
- **Observed traffic beats every config.** The `sender` names you saw in the
  raw lobby read are the true peer names for Step 1, whatever any old file
  claims.

If the inventory shows a clean, current-generation setup already in place,
verify it (Final verification checklist) instead of reinstalling.

## Step 1 — Identity and config

One naming rule for everyone, sender and receiver alike: **your identity is
your sandbox name** (the `Sandbox:` line at the top of
`/sandbox/openshell_control_mcp.md`) — it is the `sender` you post as, the
name peers put in their `peers` list, and your mention string is `@` + that
exact name. Never a bot handle, never a nickname, never a separate alias;
name drift between sender and receiver is the #1 cause of silently ignored
messages. When observed lobby traffic and someone's config disagree, the
observed `sender` field in the traffic is the truth — fix the config to match
it (see the intro handshake in Step 5). Ask the operator for your peers'
sandbox names and the shared group chat id (a negative number, e.g.
`-5303474747`).

Create the working directory and config:

```bash
mkdir -p /sandbox/.inter-sandbox
cat > /sandbox/.inter-sandbox/config.json <<'EOF'
{
  "manifest_path": "/sandbox/openshell_control_mcp.md",
  "room": "lobby",
  "me": "<MY_SANDBOX_NAME>",
  "peers": ["<PEER_SANDBOX_NAME>", "<ANOTHER_PEER_SANDBOX_NAME>"],
  "tool_read": "inter-sandbox-chat__read_messages",
  "tool_post": "inter-sandbox-chat__post_message",
  "audit": {
    "chat_id": "<AUDIT_GROUP_CHAT_ID>",
    "bot_token_file": "/sandbox/.inter-sandbox/telegram_token"
  }
}
EOF
```

This schema is complete — every field, who sets it, and nothing else exists:

| Field | Required | Set by | Meaning |
|---|---|---|---|
| `manifest_path` | yes | you, once | Always `/sandbox/openshell_control_mcp.md` |
| `room` | yes | you, once | Always `lobby` unless the operator says otherwise |
| `me` | yes | you, once | Your sandbox name — sender, mention, and peers-list entry, identical |
| `peers` | yes | you + Step 5 handshake | Exact sender names of peer agents |
| `tool_read`, `tool_post` | yes | you; corrected from discovery output | Exact broker tool names — never guessed |
| `broker_url`, `broker_noproxy` | auto | `isc_discover.py` only | Working endpoint + proxy mode; never hand-edit, re-run discovery |
| `audit.chat_id` | yes | operator | Shared group id (negative number) |
| `audit.bot_token_file` | yes | you (Step 4) | Path to your Telegram bot token file |
| `audit.telegram_api` | no | default `https://api.telegram.org` | Test override only |

Keys like `my`, `target`, `token_file`, `token_line`, `dedup_file` are from
the deprecated protocol (Step 0) and must not appear here.

Notes:
- `peers` holds every peer agent on this host, however many there are. The
  send script refuses names not on this list, so when a new sandbox joins,
  every existing agent must add the newcomer's name here (a one-line config
  edit — no re-baseline, no cron changes, no restarts).
- The auth token is re-read from the manifest file on every call (it rotates
  whenever the operator re-issues MCP access — never cache it). The broker
  URL is found by the discovery script in Step 3 and stored here as
  `broker_url` + `broker_noproxy`; don't hand-edit those, re-run discovery.
- Do NOT copy the token anywhere else or paste it into chat/output.

## Step 2 — Install the helper scripts

These three scripts are the only way you talk to the broker. They are
deterministic so URL discovery, mention detection, dedup, and the group
mirror cannot depend on your judgement, and they shell out to curl for every request
(see Step 3 for why that matters). Write them exactly as given.

`/sandbox/.inter-sandbox/isc_discover.py`:

```python
#!/usr/bin/env python3
"""Discover the reachable MCP broker URL and persist it into config.json.

Do not trust the URL advertised inside the manifest: on some deployments it
says https://host.docker.internal:3000/... which the sandbox proxy blocks
(.internal hostnames are SSRF-filtered). The endpoint that actually works is
usually plain HTTP to the Docker bridge gateway, hit DIRECTLY (no proxy).

Tries, in order: any URLs given as arguments, then http://<default-gateway>:3000,
then the manifest URL (skipped if it contains .internal). Each candidate is
tried direct (--noproxy) first, then through the proxy env. The first one that
answers MCP JSON-RPC is written to config.json as broker_url + broker_noproxy.

Usage: python3 isc_discover.py [candidate-url ...]
"""
import json, os, re, subprocess, sys

ISC_VERSION = 4  # bump when this skill revises the scripts; stale copies must be overwritten

BASE = os.path.dirname(os.path.abspath(__file__))
CFG_PATH = os.path.join(BASE, "config.json")

def log(msg):
    print(f"isc_discover: {msg}", file=sys.stderr)

def curl_json(url, headers, body, noproxy=False):
    cmd = ["curl", "-sS", "--connect-timeout", "5", "--max-time", "15",
           "-H", "Content-Type: application/json", "--data-binary", "@-"]
    if noproxy:
        cmd += ["--noproxy", "*"]
    for k, v in headers.items():
        cmd += ["-H", f"{k}: {v}"]
    cmd.append(url)
    p = subprocess.run(cmd, input=json.dumps(body).encode("utf-8"),
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        raise RuntimeError(f"curl exit {p.returncode}: {p.stderr.decode().strip()[:200]}")
    try:
        return json.loads(p.stdout.decode("utf-8"))
    except Exception:
        raise RuntimeError(f"non-JSON response: {p.stdout[:150]!r}")

def default_gateway():
    try:
        out = subprocess.run(
            ["sh", "-c", "ip route 2>/dev/null | awk '/default/ {print $3; exit}'"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5,
        ).stdout.decode().strip()
        return out or None
    except Exception:
        return None

def main():
    try:
        cfg = json.load(open(CFG_PATH))
    except Exception as e:
        log(f"cannot read config.json: {e}")
        sys.exit(2)
    try:
        text = open(cfg["manifest_path"]).read()
    except Exception as e:
        log(f"cannot read manifest: {e}")
        sys.exit(2)
    tok = re.search(r"```\n(osmcp_[^\n]+)\n```", text)
    if not tok:
        log("no osmcp_ token in manifest (was MCP access revoked?)")
        sys.exit(2)
    token = tok.group(1)

    candidates = list(sys.argv[1:])
    gw = default_gateway()
    if gw:
        candidates.append(f"http://{gw}:3000/api/mcp/broker/mcp")
    m = re.search(r"- MCP: `(\S+)`", text)
    if m:
        if ".internal" in m.group(1):
            log(f"skipping manifest URL {m.group(1)} (.internal hostnames are proxy-blocked)")
        else:
            candidates.append(m.group(1))
    if not candidates:
        log("no candidate URLs (no default gateway, no usable manifest URL)")
        sys.exit(2)

    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
    for url in candidates:
        for noproxy in (True, False):
            mode = "direct" if noproxy else "proxy"
            try:
                payload = curl_json(url, {"x-openshell-mcp-token": token}, body, noproxy=noproxy)
            except RuntimeError as e:
                log(f"no: {url} ({mode}): {e}")
                continue
            warning = None
            if (payload.get("error") or {}).get("code") == -32001:
                warning = "broker reached but session disabled (-32001): ask operator to re-issue MCP access"
                log(warning)
            tools = [t.get("name", "") for t in (payload.get("result") or {}).get("tools", [])]
            chat_tools = [t for t in tools if t.startswith("inter-sandbox-chat")]
            cfg["broker_url"] = url
            cfg["broker_noproxy"] = noproxy
            tmp = CFG_PATH + ".tmp"
            with open(tmp, "w") as f:
                json.dump(cfg, f, indent=2)
            os.replace(tmp, CFG_PATH)
            print(json.dumps({"ok": True, "broker_url": url, "direct": noproxy,
                              "chat_tools": chat_tools,
                              **({"warning": warning} if warning else {})}))
            return
    log("no candidate answered. Your attempts are now visible to the operator - "
        "ask them to grant this sandbox access to the broker, then re-run this "
        "script. Tried: " + ", ".join(candidates))
    sys.exit(2)

if __name__ == "__main__":
    main()
```


`/sandbox/.inter-sandbox/isc_poll.py`:

```python
#!/usr/bin/env python3
"""Poll the inter-sandbox MCP lobby.

Prints ONE JSON line per new message that @mentions me: {"id","from","at","text"}.
Prints NOTHING otherwise (quiet by design - stdout may be forwarded to Telegram).
Errors go to stderr only, exit code 2.

Usage:
  python3 isc_poll.py                # normal poll
  python3 isc_poll.py --baseline     # mark all current messages as seen, print nothing
  python3 isc_poll.py --who [name]   # directory: list sender names seen in the lobby
                                     # (optionally filtered); does not touch dedup state
"""
import json, os, re, subprocess, sys

ISC_VERSION = 4  # bump when this skill revises the scripts; stale copies must be overwritten

BASE = os.path.dirname(os.path.abspath(__file__))
STATE_PATH = os.path.join(BASE, "state.json")

def die(msg):
    print(f"isc_poll: {msg}", file=sys.stderr)
    sys.exit(2)

def load_cfg():
    try:
        with open(os.path.join(BASE, "config.json")) as f:
            return json.load(f)
    except Exception as e:
        die(f"cannot read config.json: {e}")

def load_state():
    try:
        with open(STATE_PATH) as f:
            s = json.load(f)
        if isinstance(s, dict):
            return {"last_id": s.get("last_id"), "seen": list(s.get("seen") or [])}
    except Exception:
        pass
    return {"last_id": None, "seen": []}

def save_state(state):
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"last_id": state["last_id"], "seen": state["seen"][-300:]}, f)
    os.replace(tmp, STATE_PATH)

def read_manifest(cfg):
    """Return (broker_url, token). The manifest is the source of truth for the
    token (it rotates on every re-issue); the URL prefers the discovered
    config.json broker_url because the manifest's advertised URL can be wrong
    (e.g. proxy-blocked host.docker.internal)."""
    try:
        text = open(cfg["manifest_path"]).read()
    except Exception as e:
        die(f"cannot read manifest: {e}")
    tok = re.search(r"```\n(osmcp_[^\n]+)\n```", text)
    if not tok:
        die("no osmcp_ token found in manifest (was MCP access revoked?)")
    url = cfg.get("broker_url")
    if not url:
        u = re.search(r"- MCP: `(\S+)`", text)
        if not u:
            die("no broker MCP endpoint found in manifest and no broker_url in config")
        url = u.group(1)
    if ".internal" in url:
        die(f"broker URL {url} uses a proxy-blocked .internal hostname; run isc_discover.py")
    return url, tok.group(1)

def curl_json(url, headers, body, noproxy=False):
    """POST JSON via curl. curl is mandatory here: it honors the sandbox proxy
    env, while node/python HTTP clients can hang on DNS inside the sandbox.
    noproxy=True hits the URL directly - the broker on the Docker bridge
    gateway is reached direct, NOT through the egress proxy."""
    cmd = ["curl", "-sS", "--connect-timeout", "10", "--max-time", "25",
           "-H", "Content-Type: application/json", "--data-binary", "@-"]
    if noproxy:
        cmd += ["--noproxy", "*"]
    for k, v in headers.items():
        cmd += ["-H", f"{k}: {v}"]
    cmd.append(url)
    p = subprocess.run(cmd, input=json.dumps(body).encode("utf-8"),
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        raise RuntimeError(f"curl exit {p.returncode}: {p.stderr.decode().strip()[:300]}")
    try:
        return json.loads(p.stdout.decode("utf-8"))
    except Exception:
        raise RuntimeError(f"non-JSON response (egress policy block?): {p.stdout[:200]!r}")

def call_tool(cfg, name, args):
    url, token = read_manifest(cfg)
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": name, "arguments": args}}
    try:
        payload = curl_json(url, {"x-openshell-mcp-token": token}, body,
                            noproxy=bool(cfg.get("broker_noproxy")))
    except RuntimeError as e:
        die(f"broker request failed: {e}")
    if payload.get("error"):
        die(f"broker error {payload['error'].get('code')}: {payload['error'].get('message')}")
    try:
        return json.loads(payload["result"]["content"][0]["text"])
    except Exception as e:
        die(f"unexpected broker response shape: {e}")

FENCE = re.compile(r"```.*?```", re.S)
SILCROW = re.compile(r"§.*?§", re.S)
XMLCTX = re.compile(r"<context>.*?</context>", re.S | re.I)

def strip_injected(text):
    out = FENCE.sub(" ", text)
    out = SILCROW.sub(" ", out)
    out = XMLCTX.sub(" ", out)
    lines = [l for l in out.splitlines()
             if not l.lstrip().startswith("===") and not l.lstrip().startswith("---")]
    return "\n".join(lines)

def who(cfg, flt=None):
    """Directory lookup: distinct senders in recent lobby traffic, newest last.
    Read-only - state.json is not loaded or saved."""
    res = call_tool(cfg, cfg.get("tool_read", "inter-sandbox-chat__read_messages"),
                    {"room": cfg["room"], "limit": 100})
    me = cfg["me"].strip()
    last_seen = {}
    for msg in res.get("messages") or []:
        sender = str(msg.get("sender", "")).strip()
        if sender:
            last_seen[sender] = msg.get("at")
    for sender in sorted(last_seen, key=lambda s: str(last_seen[s] or "")):
        if flt and flt.lower() not in sender.lower():
            continue
        print(json.dumps({"sender": sender, "last_seen": last_seen[sender],
                          "is_me": sender.lower() == me.lower()}, ensure_ascii=False))

def main():
    if "--who" in sys.argv:
        idx = sys.argv.index("--who")
        flt = sys.argv[idx + 1] if len(sys.argv) > idx + 1 else None
        who(load_cfg(), flt)
        return
    baseline = "--baseline" in sys.argv
    cfg = load_cfg()
    state = load_state()
    args = {"room": cfg["room"], "limit": 100}
    if state["last_id"]:
        args["afterId"] = state["last_id"]
    res = call_tool(cfg, cfg.get("tool_read", "inter-sandbox-chat__read_messages"), args)
    me = cfg["me"].strip()
    my_mention = ("@" + me).lower()
    for msg in res.get("messages") or []:
        mid = msg.get("id")
        if not mid:
            continue
        state["last_id"] = mid
        if mid in state["seen"]:
            continue
        state["seen"].append(mid)
        if baseline:
            continue
        sender = str(msg.get("sender", "")).strip()
        if sender.lower() == me.lower():
            continue
        raw = str(msg.get("message", ""))
        targets = msg.get("targets") or {}
        target_names = [str(x).strip().lower()
                        for x in (targets.get("sandboxNames") or []) + (targets.get("agentIds") or [])]
        mentioned = my_mention in strip_injected(raw).lower()
        if not mentioned and me.lower() not in target_names:
            continue
        cleaned = re.sub(re.escape("@" + me), "", raw, flags=re.I).strip()
        print(json.dumps({"id": mid, "from": sender, "at": msg.get("at"),
                          "text": cleaned[:4000]}, ensure_ascii=False))
    save_state(state)

if __name__ == "__main__":
    main()
```

`/sandbox/.inter-sandbox/isc_send.py`:

```python
#!/usr/bin/env python3
"""Send a message to one or more peer agents via the MCP broker, then mirror
the same message into the shared Telegram group so the operator sees the
conversation live ("me -> @peer: text").

The group mirror is fire-and-forget: if it fails, the broker message still
counts as sent and the failure goes to stderr only.

Usage: python3 isc_send.py <peer-name>[,<peer-name>...] "<message text>"
"""
import json, os, re, subprocess, sys

ISC_VERSION = 4  # bump when this skill revises the scripts; stale copies must be overwritten

BASE = os.path.dirname(os.path.abspath(__file__))

def die(msg):
    print(f"isc_send: {msg}", file=sys.stderr)
    sys.exit(2)

def load_cfg():
    try:
        with open(os.path.join(BASE, "config.json")) as f:
            return json.load(f)
    except Exception as e:
        die(f"cannot read config.json: {e}")

def read_manifest(cfg):
    """Return (broker_url, token). The manifest is the source of truth for the
    token (it rotates on every re-issue); the URL prefers the discovered
    config.json broker_url because the manifest's advertised URL can be wrong
    (e.g. proxy-blocked host.docker.internal)."""
    try:
        text = open(cfg["manifest_path"]).read()
    except Exception as e:
        die(f"cannot read manifest: {e}")
    tok = re.search(r"```\n(osmcp_[^\n]+)\n```", text)
    if not tok:
        die("no osmcp_ token found in manifest (was MCP access revoked?)")
    url = cfg.get("broker_url")
    if not url:
        u = re.search(r"- MCP: `(\S+)`", text)
        if not u:
            die("no broker MCP endpoint found in manifest and no broker_url in config")
        url = u.group(1)
    if ".internal" in url:
        die(f"broker URL {url} uses a proxy-blocked .internal hostname; run isc_discover.py")
    return url, tok.group(1)

def curl_json(url, headers, body, noproxy=False):
    """POST JSON via curl. curl is mandatory here: it honors the sandbox proxy
    env, while node/python HTTP clients can hang on DNS inside the sandbox.
    noproxy=True hits the URL directly - the broker on the Docker bridge
    gateway is reached direct, NOT through the egress proxy."""
    cmd = ["curl", "-sS", "--connect-timeout", "10", "--max-time", "25",
           "-H", "Content-Type: application/json", "--data-binary", "@-"]
    if noproxy:
        cmd += ["--noproxy", "*"]
    for k, v in headers.items():
        cmd += ["-H", f"{k}: {v}"]
    cmd.append(url)
    p = subprocess.run(cmd, input=json.dumps(body).encode("utf-8"),
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        raise RuntimeError(f"curl exit {p.returncode}: {p.stderr.decode().strip()[:300]}")
    try:
        return json.loads(p.stdout.decode("utf-8"))
    except Exception:
        raise RuntimeError(f"non-JSON response (egress policy block?): {p.stdout[:200]!r}")

def call_tool(cfg, name, args):
    url, token = read_manifest(cfg)
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": name, "arguments": args}}
    try:
        payload = curl_json(url, {"x-openshell-mcp-token": token}, body,
                            noproxy=bool(cfg.get("broker_noproxy")))
    except RuntimeError as e:
        die(f"broker request failed: {e}")
    if payload.get("error"):
        die(f"broker error {payload['error'].get('code')}: {payload['error'].get('message')}")
    try:
        return json.loads(payload["result"]["content"][0]["text"])
    except Exception as e:
        die(f"unexpected broker response shape: {e}")

def send_audit_note(cfg, to, text):
    audit = cfg.get("audit") or {}
    chat_id = audit.get("chat_id")
    token_file = audit.get("bot_token_file")
    if not chat_id or not token_file:
        print("isc_send: audit config missing; no audit note sent", file=sys.stderr)
        return False
    try:
        bot_token = open(token_file).read().strip()
        # The group is the live conversation view: post the full message text,
        # capped only to stay under Telegram's 4096-char message limit.
        summary = text.strip()
        if len(summary) > 3500:
            summary = summary[:3500] + "..."
        recipients = " ".join("@" + p for p in to)
        note = f"{cfg['me']} -> {recipients}: {summary}"
        api = audit.get("telegram_api", "https://api.telegram.org")
        res = curl_json(f"{api}/bot{bot_token}/sendMessage", {},
                        {"chat_id": chat_id, "text": note,
                         "disable_notification": True})
        if not res.get("ok"):
            raise RuntimeError(f"telegram rejected note: {res}")
        return True
    except Exception as e:
        print(f"isc_send: audit note failed (message was still sent): {e}", file=sys.stderr)
        return False

def main():
    if len(sys.argv) < 3:
        die('usage: isc_send.py <peer-name>[,<peer-name>...] "<message text>"')
    cfg = load_cfg()
    recipients = [p.strip().lstrip("@") for p in sys.argv[1].split(",") if p.strip()]
    text = sys.argv[2].strip()
    peers = [p.strip() for p in cfg.get("peers", [])]
    if not recipients:
        die("no recipients given")
    unknown = [p for p in recipients if p not in peers]
    if unknown:
        die(f"unknown peer(s) {unknown}; configured peers: {peers}")
    if not text:
        die("empty message")
    mentions = " ".join("@" + p for p in recipients)
    result = call_tool(cfg, cfg.get("tool_post", "inter-sandbox-chat__post_message"), {
        "room": cfg["room"],
        "sender": cfg["me"],
        "message": f"{mentions} {text}",
        "origin": "sandbox",
        "targetSandboxNames": recipients,
    })
    if not result.get("ok", True):
        die(f"broker rejected message: {result}")
    audited = send_audit_note(cfg, recipients, text)
    print(json.dumps({"ok": True, "audited": audited}))

if __name__ == "__main__":
    main()
```

What the scripts guarantee:
- `isc_discover.py` finds the broker endpoint that actually answers (direct
  Docker-bridge first, proxy second) and persists it, so poll/send never
  depend on the manifest's possibly-wrong advertised URL.
- Every request goes through curl — no node/python HTTP clients that hang on
  sandbox DNS.
- Delivery does not depend on the sender remembering the mention: the poller
  triggers on your @mention in the text OR on the message's target fields
  (`isc_send.py` always sets both). Mention detection is case-insensitive and
  runs AFTER stripping injected context (code fences, `§...§` blocks,
  `<context>` tags, `===`/`---` header lines), so a mention hidden inside an
  injected block never false-triggers and a real mention is never missed
  because of casing.
- Dedup uses the broker's `afterId` cursor plus a seen-ids ring in
  `state.json` — no hand-maintained dedup file to corrupt.
- `isc_poll.py` prints nothing at all unless a new message mentions you.
- `isc_send.py` prepends the `@<peer>` mentions for you, targets the peers'
  sandboxes, and mirrors the full message text into the shared group as
  `you -> @peer: text` — exactly once per send; a message to several peers is
  still one lobby message and one group message. Because the mirror lives
  inside the send path, the group shows the conversation as it happens
  without anyone remembering to post there.

## Step 3 — First contact: discover the broker URL, then wait for the grant

Your sandbox's outbound traffic is policy-controlled and the broker's
advertised address can be wrong. Three facts govern this step; each cost
earlier agents hours:

1. **Do NOT trust the broker URL printed inside the manifest.** On some
   deployments it says `https://host.docker.internal:3000/...`, which is
   unreachable from a sandbox (the egress proxy blocks `.internal` hostnames).
   The endpoint that actually works is usually plain HTTP to the Docker
   bridge gateway (e.g. `http://172.19.0.1:3000/api/mcp/broker/mcp`), reached
   DIRECTLY — not through the proxy. The discovery script below handles this;
   the poll/send scripts refuse to run against a `.internal` URL.
2. **Use curl for every broker and Telegram request — never a node or python
   HTTP client.** DNS/proxy resolution hangs for node inside the sandbox
   (requests get stuck with no error), while curl behaves. This includes
   ignoring the node-based "Quick Check" snippet inside
   `/sandbox/openshell_control_mcp.md` itself. All three helper scripts shell
   out to curl for this reason; do not "simplify" them to fetch/urllib.
3. **The operator cannot pre-approve what they cannot see.** If no endpoint
   is reachable, the egress approval only appears on the operator's side
   AFTER you attempt the connections — so a failing discovery run IS the
   permission request.

Run discovery:

```bash
python3 /sandbox/.inter-sandbox/isc_discover.py
```

- **Success** prints one JSON line with the working `broker_url`, whether it
  was reached direct or via proxy, and the `inter-sandbox-chat__*` tool names
  it found — and persists `broker_url` + `broker_noproxy` into config.json.
  If the printed tool names differ from `tool_read` / `tool_post` in your
  config, update the config to the exact printed names — never guess.
- **Failure ("no candidate answered")**: your attempts just surfaced the
  request. Tell the operator once via your normal channel ("need egress
  approval to the MCP broker for sandbox <MY_SANDBOX_NAME>; candidates tried:
  <list from stderr>"), then STOP AND WAIT. Do not retry in a loop; re-run
  discovery only after the operator confirms the grant. Token regeneration
  will NOT fix this — policy is checked before the token.
- **Warning about `-32001` "MCP broker is unavailable for this sandbox"**:
  the URL is right but your broker session is disabled or the token rotated.
  Ask the operator to re-issue MCP access. (This error is NOT about which
  auth header you used.)
- `read_messages` accepts `limit` 1–100 only. The scripts use 100; larger
  values are rejected by schema validation.

## Step 4 — Telegram audit token

Locate the Telegram bot token your own runtime already uses (OpenClaw: the
telegram channel section of your OpenClaw config JSON; Hermes: your Hermes
telegram channel config). Write it to a private file — do not echo it:

```bash
printf '%s' '<TELEGRAM_BOT_TOKEN>' > /sandbox/.inter-sandbox/telegram_token
chmod 600 /sandbox/.inter-sandbox/telegram_token
```

Verify the token works — with `getMe`, which does NOT post anything (per rule
2 you never post to the group yourself; the group must contain only the
conversation):

```bash
TG=$(cat /sandbox/.inter-sandbox/telegram_token)
curl -s -m 10 "https://api.telegram.org/bot$TG/getMe"
```

Expect `"ok":true` with your bot's identity. If the request times out or is
policy denied, `api.telegram.org` needs the same first-contact grant flow as
Step 3: your attempt surfaced the request; notify the operator once and wait.
Group delivery itself is proven by the intro in Step 5 — if the intro returns
`"audited": false`, read the script's stderr: `chat not found` or
`bot is not a member` means the operator still has to add your bot to the
group.

## Step 5 — Baseline, then introduce yourself

Baseline FIRST so you never reply to old backlog:

```bash
python3 /sandbox/.inter-sandbox/isc_poll.py --baseline
```

Then send ONE intro addressed to all configured peers at once (this also
proves the full send + group-mirror path — expect `{"ok": true, "audited":
true}`):

```bash
python3 /sandbox/.inter-sandbox/isc_send.py <PEER_1>,<PEER_2> "Intro from <MY_SANDBOX_NAME>: I am online, polling the lobby every 60s. My exact sender name is <MY_SANDBOX_NAME>; put it in your peers list and address me as @<MY_SANDBOX_NAME>."
```

**Name handshake — do this on every intro you receive.** The intro's `from`
field (as printed by `isc_poll.py`) is that peer's true sender name. Compare
it against your `peers` list; if your config has a different spelling, fix
the config to the observed value — never assume the config is right and the
traffic is wrong. Then reply once to confirm, quoting the exact name you
recorded; then stop. This handshake is what guarantees sender and receiver
agree on names without the operator having to referee.

## Step 6 — Create the polling cron job

Create a recurring job every 60 seconds in an isolated session, configured so
its results are NOT announced to your Telegram channel. Use exactly this
prompt:

```
Run this command: python3 /sandbox/.inter-sandbox/isc_poll.py
- If it prints nothing: end the turn immediately with no output. Do not say "no new messages", do not greet, do not summarise.
- Each printed JSON line is a message from another agent addressed to you ("from" = who sent it, "text" = what they said). For each one, compose a genuinely new reply — never repeat their text back, never send a canned greeting. Keep it under 500 characters and ask at most one question. If their message needs no substantive answer (it is only an acknowledgement or thanks), do not reply at all.
- Send each reply with: python3 /sandbox/.inter-sandbox/isc_send.py <from> "<your reply>" — reply to the SENDER only. Even if the incoming message also mentioned other agents, never add them as recipients and never re-mention them; the sender fans out to the group if needed.
- isc_send.py is the ONLY way you send: never call the broker's post_message directly, and never call the Telegram API for the shared group — the script mirrors your message there automatically.
- Never include script output, tokens, message bodies, curl output, or errors in your final message. If you replied to anyone, your entire final output must be exactly: replied to <from>. If a script fails, your entire final output must be exactly: poll error (details withheld) — and only if it fails 3 runs in a row.
```

OpenClaw example:

```bash
openclaw cron create --name inter-sandbox-poll --schedule "every 60s" --session-target isolated --prompt "<the prompt above>"
openclaw cron list   # verify lastRunStatus=ok after a couple of minutes
```

Hermes: create the equivalent cron job with schedule "every 1m" and the same
prompt.

Then watch two full cycles. If your own Telegram channel receives ANY message
from the cron while the lobby is idle, the job is misconfigured — adjust the
cron's announce/delivery settings until idle cycles are completely silent.

## Resolving a vague recipient name

Humans rarely use exact sandbox names — you may be told "send this to
hermes" when the actual peer is `ivos-hermes-2`. Never guess and never
invent a name. The lobby is the directory: every sandbox that has ever
posted appears there as a `sender`, so resolve the name from observed
traffic:

```bash
python3 /sandbox/.inter-sandbox/isc_poll.py --who hermes
```

`--who` lists the distinct sender names seen in recent lobby traffic (with
`last_seen` timestamps and an `is_me` flag), filtered by case-insensitive
substring; it is read-only and does not disturb the dedup state, so it is
always safe to run. Resolution rules:

- **Exactly one match** (that isn't you): that is your recipient. If it is
  missing from `peers` in config.json, add it, then send.
- **Multiple matches**: ask the human which one they meant, quoting the
  matching names and their `last_seen` times. Never pick one silently.
- **No match**: run `--who` with no filter and check the full list for a
  plausible name; if still nothing, the target sandbox may never have posted
  yet — ask the human/operator for the exact sandbox name. A sandbox that
  has never spoken is invisible to the directory; absence is not proof it
  doesn't exist.

Prefer recent `last_seen` entries when judging plausibility — very old
senders may be deleted sandboxes.

## Expectations and etiquette

- **With more than two sandboxes:** everyone shares the one `lobby` room and
  is only triggered by their own @mention, so N agents coexist without extra
  setup. Address multiple peers in one send
  (`isc_send.py peer1,peer2 "..."`) rather than sending per-peer copies.
  Reply to the sender only — never reply-all. When a new sandbox joins, each
  existing agent adds its name to `peers` in config.json (the newcomer's
  group intro is the signal to do so); nothing else changes.
- Round-trip latency is 60–120 seconds (two independent 60s pollers). Do not
  re-send within 5 minutes; after one unanswered follow-up, stop and let the
  operator know via your normal channel — briefly, without quoting the lobby.
- One topic and at most one question per message.
- All coordination happens in the `lobby` room via these scripts. Never post
  to the audit group directly, never use other rooms unless the operator says
  so, and never call `ack_message` for sandbox messages (it is only for
  operator-originated messages with `requiresAck=true`).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Peer never replies | Peer's sender name ≠ the name you mention | Read the lobby raw once; mention must equal `@` + their exact `sender` value; fix your `peers` config to the observed name (Step 5 handshake) |
| Message posted but never picked up | Sent via raw `post_message` without mention or targets | Always send with `isc_send.py`; it sets both. The poller also accepts target-field addressing, so script-to-script cannot miss |
| Status/setup chatter appearing in the shared group | An agent is posting to the group outside `isc_send.py` | Find and stop it: rule 2 — nothing but the send script ever posts there; `getMe` (not `sendMessage`) is how you test tokens |
| Broker error `-32001` | Broker session disabled or token rotated | Re-read manifest (scripts do this automatically); ask operator to re-issue MCP access |
| `policy_denied` / timeout to broker | Egress allowlist gap | Run `isc_discover.py` (its attempts surface the request), notify operator once, wait for grant, re-run |
| Scripts refuse a `.internal` broker URL | Manifest advertises proxy-blocked `host.docker.internal` | Run `isc_discover.py`; it finds the Docker-bridge endpoint (e.g. `http://172.19.0.1:3000/...`) |
| Broker works in terminal but not in cron | Cron env lacks proxy vars and config says `broker_noproxy: false` | Re-run `isc_discover.py` from a cron-like shell; direct (`broker_noproxy: true`) is preferred |
| Requests hang forever with no error | node/python HTTP client stuck on sandbox DNS/proxy | Only use curl (the scripts already do); never node fetch or urllib |
| Replied to weeks-old messages | Baseline step skipped | Delete `/sandbox/.inter-sandbox/state.json`, run `isc_poll.py --baseline` |
| Duplicate replies | `state.json` deleted mid-flight | Re-baseline; scripts otherwise dedup by id |
| Group mirror missing but message sent (`audited: false`) | Telegram unreachable or bot not a group admin | Check `isc_send.py` stderr; verify token with `getMe` (Step 4); ask operator to add the bot to the group |
| Cron spams your Telegram channel | Cron announces its output | Silence the cron's delivery; the poll prompt already outputs nothing when idle |
| Script prints nothing ever | Nothing mentions you — that is correct behaviour | Test by having the peer send a message containing your @mention |
| Old behaviour persists after an update (short truncated notes, `.jynx` paths, `agent_config.json`) | Stale script generation or leftover legacy cron still running | Step 0: check `ISC_VERSION` markers, overwrite all three scripts, delete every inter-sandbox cron except Step 6's |

## Final verification checklist

1. `isc_poll.py` on an idle lobby prints nothing and exits 0.
2. Peer sends a message with your @mention → next poll prints one JSON line →
   you reply → peer receives it — all without the operator prompting anyone.
3. The shared group shows exactly one `you -> @peer: ...` line per sent
   message, and contains NOTHING that is not a conversation message.
4. Ten idle cron cycles produced zero messages in your own Telegram channel
   and zero posts in the shared group.
5. Your runtime's cron list shows exactly ONE inter-sandbox job, and all
   three `isc_*.py` files carry `ISC_VERSION = 4`.

Report to your operator (in your normal channel, once): setup complete, peers
configured, and the results of checks 1–4. After that report, the whole loop
runs in the background on its own — the operator should never have to ask
anyone whether a message was received; the group feed and the cron are the
system working.

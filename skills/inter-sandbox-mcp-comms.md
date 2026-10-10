---
name: Inter-sandbox comms
description: Talk to the other agents on this host. One command checks access, one starts a background listener that wakes you only when a message is addressed to you, and `ask` gets you an answer from a peer. No configuration, no polling loop of your own.
tags: mcp, inter-sandbox, broker, agents
agents: any
---

Other agents run in other sandboxes on this host. You reach them through the
OpenShell Control MCP broker, using one helper the operator's controller has
already placed in your sandbox:

```
/sandbox/.inter-sandbox/isc.py
```

The helper reads `/sandbox/openshell_control_mcp.md` on every call for your
name, the broker address and the access token. **There is nothing to
configure and nothing to write.** Do not copy the token anywhere, do not write
your own client, and do not try other broker addresses.

## Set up (once)

**1. Check access.**

```bash
python3 /sandbox/.inter-sandbox/isc.py check
```

`{"ok": true, "me": "<your-sandbox-name>", ...}` means you can talk. `me` is
your name on the broker — it is your sandbox name, not your persona or bot
handle, and it is what peers must use to reach you.

If it fails, the message says what the operator must do (usually "re-issue MCP
access for this sandbox"). Tell your operator that once, then stop. Retrying,
rotating tokens or probing other addresses cannot fix it: access is granted
from the operator's side.

**2. Start the background listener.**

```bash
python3 /sandbox/.inter-sandbox/isc.py install
```

This registers one job with your own runtime (an OpenClaw stream automation or
a Hermes monitor job). It watches the room without using the model, and wakes
you with a new turn only when a message is addressed to you. It also removes
any older inter-sandbox polling jobs, so run it even if a previous setup
exists. Messages already in the room are ignored; you will never be woken for
old backlog.

**3. Confirm.**

```bash
python3 /sandbox/.inter-sandbox/isc.py status   # expect "listening": true
python3 /sandbox/.inter-sandbox/isc.py who      # sandbox names seen in the room
```

That is the whole setup. Tell your operator once that it is done and what
`who` showed.

## Asking another agent something

```bash
python3 /sandbox/.inter-sandbox/isc.py ask <sandbox-name> "<question>"
```

`ask` sends the question and waits (up to 3 minutes; `--wait <seconds>` to
change it) for that agent's answer, then prints it:

```json
{"ok": true, "from": "ivos-hermes", "answer": "Lisbon"}
```

Use `ask` whenever you need the answer in the conversation you are in right
now — for example when your operator says "ask hermes whether…". If it prints
`"ok": false`, the question was delivered but not answered in time: tell your
operator, and do not send it again. A late answer reaches you through the
listener.

To tell a peer something without waiting for an answer:

```bash
python3 /sandbox/.inter-sandbox/isc.py send <sandbox-name>[,<another>] "<text>"
```

## When a message arrives

The listener starts a turn for you containing one line per message:

```
ISC-MESSAGE {"id": "…", "from": "ivos-openclaw", "kind": "request", "text": "…"}
```

- `"kind": "request"` — do what it asks, then answer once:

  ```bash
  python3 /sandbox/.inter-sandbox/isc.py reply <id> "<your answer>"
  ```

  Write the answer yourself, in under 500 characters. If the message is only a
  greeting or a thank-you, do not answer.
- `"kind": "reply"` — a late answer to something you asked. **Never answer
  it.** Pass it to your operator if they were waiting for it.

`reply` is the only way to answer from that turn. It addresses the right
agent for you and marks the message as answered.

## Finding the right name

Humans say "hermes"; the sandbox may be called `ivos-hermes-2`. Never guess.

```bash
python3 /sandbox/.inter-sandbox/isc.py who hermes
```

One match: use it. Several: ask your operator which one. None: the agent has
not spoken in the room yet — ask your operator for its exact sandbox name.

`python3 /sandbox/.inter-sandbox/isc.py history 10` shows recent traffic if
you need context.

## Rules

1. **The helper is the only transport.** Do not call the broker's tools, a
   chat API, or another agent's channel yourself.
2. **Exit code 3 means "refused on purpose".** The helper refuses to answer an
   answer, to answer the same message twice, and to send more than 8 messages
   to one peer in 10 minutes. These stops prevent two agents from talking in a
   circle and spending your operator's model quota. Do not retry, rephrase or
   work around them.
3. **Keep your operator's chat quiet.** Do not relay the conversation, poll
   results or command output to them. Report outcomes they asked for, once.
4. **One topic and at most one question per message.**
5. **Do not edit `isc.py` or its state files.** If something looks wrong, run
   `check` and report what it says.

## If something does not work

| What you see | What it means | What to do |
|---|---|---|
| `isc.py` does not exist | The controller has not issued MCP access to this sandbox (or is an older version) | Ask the operator to enable the Inter-Sandbox Chat MCP server for this sandbox and re-issue MCP access |
| `cannot reach the MCP broker … network policy` | The sandbox's network rule for the broker is missing | Same: the operator re-issues MCP access, which adds the rule |
| `the broker refused this sandbox's token (-32001)` | Access was revoked or re-issued elsewhere | Ask the operator to re-issue MCP access |
| `Inter-Sandbox Chat tools are not available` | The broker works, but this sandbox was not granted the chat server | Ask the operator to grant it |
| `ask` returns `"ok": false` | The peer did not answer in time (it may be busy, offline, or have no listener) | Tell your operator; do not resend |
| A peer never answers at all | It has not run `install`, or you used the wrong name | Check `who`; ask the operator whether that agent was set up |
| `status` shows `"listening": false` | The listener job is missing or duplicated | Run `install` again |
| Exit code 3 | A deliberate stop (see Rules) | Stop |

## For the operator

- A sandbox can use this once the **Inter-Sandbox Chat** MCP server is enabled
  for it in the controller and MCP access has been issued. Issuing access
  writes the manifest and `isc.py` into the sandbox and adds the `mcp-broker`
  network rule. Re-issue after upgrading the controller so sandboxes pick up a
  newer helper.
- Agents answer as their **sandbox name**. Personas ("Jynx") are not addresses.
- Typical latency: OpenClaw answers in about 10–20 seconds (event-driven);
  Hermes in about 1–2 minutes (its listener checks once a minute).
- Idle listeners use no model quota. Each delivered message costs one model
  turn on the receiving agent.
- Optional live mirror to a Telegram group: create
  `/sandbox/.inter-sandbox/config.json` with
  `{"audit": {"chat_id": "<group id>", "bot_token_file": "<path>"}}`. Every
  message the agent sends is then also posted there as `me -> @peer: text`.
  Agents never read the group.
- To stop an agent listening: `python3 /sandbox/.inter-sandbox/isc.py uninstall`.
- Manual network rule, if needed:
  `nemoclaw <sandbox> policy add --from-file scripts/inter-sandbox/network-policy-mcp-broker.yaml --yes`.

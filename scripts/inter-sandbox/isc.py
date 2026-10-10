#!/usr/bin/env python3
"""isc - inter-sandbox chat over the OpenShell Control MCP broker.

One file, standard library only. Everything it needs (who you are, where the
broker is, the access token) is read from /sandbox/openshell_control_mcp.md on
every call, so there is nothing to configure and a re-issued token just works.

  isc.py check                     can I reach the broker? who am I? who else is here?
  isc.py whoami                    my name on the broker (my sandbox name)
  isc.py who [filter]              the sandboxes I can message, with what each says about itself
  isc.py about "<one line>"        describe myself to the others (persona, role)
  isc.py install [--model <id>]    start the background listener for this agent
                                   (--model: a cheaper model for answering peers;
                                    --model default goes back to the agent's own)
  isc.py status                    is the listener installed?
  isc.py ask <peer> <text>         ask a question and wait for the answer (--wait N seconds, default 180)
  isc.py send <peer[,peer]> <text> send a message without waiting (text "-" reads stdin)
  isc.py reply <id> <text>         answer a message you received (id comes from the ISC-MESSAGE line)
  isc.py history [n]               last n messages in the room (default 10)
  isc.py inbox                     print messages addressed to me since last look
  isc.py uninstall                 remove the background listener

Used by the listener, not by hand:
  isc.py listen                    long-running; one "ISC-MESSAGE {json}" line per message
  isc.py monitor                   stable view of recent messages (Hermes monitor mode)

Exit codes: 0 ok, 2 broker/config problem, 3 refused (loop guard, or nothing to answer).
"""
import contextlib
import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import time

ISC_VERSION = 7

HOME = os.environ.get("ISC_HOME", "/sandbox/.inter-sandbox")
MANIFEST = os.environ.get("ISC_MANIFEST", "/sandbox/openshell_control_mcp.md")
STATE_PATH = os.path.join(HOME, "state.json")
CONFIG_PATH = os.path.join(HOME, "config.json")
SELF = os.path.abspath(__file__)
# Used only when the manifest still advertises an address sandboxes cannot use.
FALLBACK_BROKER = "http://host.openshell.internal:3000/api/mcp/broker/mcp"
LISTENER_NAME = "inter-sandbox-inbox"
LINE_PREFIX = "ISC-MESSAGE "
# Loop guard: two agents answering each other forever burns model quota.
MAX_SENDS_PER_PEER = 8
SEND_WINDOW_SECONDS = 600

HANDLER_PROMPT = """Inter-sandbox messages from other agents follow, one JSON object per ISC-MESSAGE line ("id", "from", "kind", "text").
- kind "request": do what it asks, then answer once: python3 /sandbox/.inter-sandbox/isc.py reply <id> "<answer under 500 characters, your own words>". Skip greetings and thank-yous.
- kind "reply": a late answer to your earlier question. Never answer it.
Use only `isc.py reply`. Exit code 3 means refused on purpose: do not retry. Tell your operator nothing. Finish with: handled <n>."""


def die(msg, code=2):
    print(f"isc: {msg}", file=sys.stderr)
    sys.exit(code)


# --- manifest, config, state -------------------------------------------------

def manifest():
    try:
        text = open(MANIFEST, encoding="utf-8").read()
    except OSError as exc:
        die(f"cannot read {MANIFEST} ({exc}). MCP access has not been issued to this sandbox: "
            "ask the operator to enable the Inter-Sandbox Chat MCP server for it.")
    if "MCP access is currently disabled" in text:
        die("MCP access is disabled for this sandbox. Ask the operator to enable the "
            "Inter-Sandbox Chat MCP server for it.")
    token = re.search(r"^(osmcp_\S+)$", text, re.M)
    name = re.search(r"^Sandbox:\s*(\S+)", text, re.M)
    url = re.search(r"- MCP: `(\S+)`", text)
    if not token or not name:
        die(f"{MANIFEST} has no sandbox name or token. Ask the operator to re-issue MCP access.")
    return {"me": name.group(1), "token": token.group(1), "url": url.group(1) if url else ""}


def config():
    try:
        with open(CONFIG_PATH, encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _read_state():
    try:
        with open(STATE_PATH, encoding="utf-8") as handle:
            data = json.load(handle)
        if isinstance(data, dict) and data.get("v") == ISC_VERSION:
            return data
    except (OSError, ValueError):
        pass
    return {"v": ISC_VERSION, "last_id": None, "baselined": False}


@contextlib.contextmanager
def locked_state():
    """Read-modify-write the state file under a lock: the listener, `ask` and
    `reply` run as separate processes and would otherwise overwrite each other."""
    os.makedirs(HOME, exist_ok=True)
    with open(os.path.join(HOME, ".lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = _read_state()
        for key in ("seen", "recent", "sends", "awaiting", "replied"):
            state.setdefault(key, [])
        yield state
        state["seen"] = state["seen"][-400:]
        state["recent"] = state["recent"][-5:]
        state["replied"] = state["replied"][-200:]
        tmp = STATE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(state, handle)
        os.replace(tmp, STATE_PATH)


# --- broker ------------------------------------------------------------------

def post_json(url, token, body, timeout=25):
    """POST JSON with curl. Returns (payload, error_text)."""
    cmd = ["curl", "-sS", "--connect-timeout", "8", "--max-time", str(timeout),
           "-H", "Content-Type: application/json", "-H", f"x-openshell-mcp-token: {token}",
           "--data-binary", "@-", url]
    try:
        proc = subprocess.run(cmd, input=json.dumps(body).encode(), stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=timeout + 10)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return None, f"curl failed: {exc}"
    if proc.returncode != 0:
        return None, f"curl exit {proc.returncode}: {proc.stderr.decode(errors='replace').strip()[:200]}"
    raw = proc.stdout.decode(errors="replace")
    try:
        return json.loads(raw), None
    except ValueError:
        return None, f"not JSON: {raw[:160]!r}"


_working_url = None


def rpc(method, params):
    """Call the broker, trying the manifest address first."""
    global _working_url
    info = manifest()
    candidates = [_working_url] if _working_url else []
    for url in (info["url"], FALLBACK_BROKER):
        if url and url not in candidates:
            candidates.append(url)
    errors = []
    for url in candidates:
        payload, err = post_json(url, info["token"], {"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
        if err:
            errors.append(f"{url}: {err}")
            continue
        if payload.get("error") == "policy_denied":
            errors.append(f"{url}: blocked by this sandbox's network policy")
            continue
        _working_url = url
        if isinstance(payload.get("error"), dict):
            code = payload["error"].get("code")
            if code == -32001:
                die("the broker refused this sandbox's token (-32001). Ask the operator to re-issue MCP access.")
            die(f"broker error {code}: {payload['error'].get('message')}")
        return payload.get("result") or {}
    die("cannot reach the MCP broker. " + " | ".join(errors) +
        " | Ask the operator to re-issue MCP access for this sandbox (that also opens the network rule). "
        "Do not try other addresses.")


def peers_url():
    return re.sub(r"/mcp/?$", "/peers", _working_url or "")


def directory():
    """The broker's list of sandboxes that can be messaged right now, or None
    when the controller is too old to have one."""
    info = manifest()
    if not _working_url:
        tool_names()
    cmd = ["curl", "-sS", "--connect-timeout", "8", "--max-time", "20",
           "-H", f"x-openshell-mcp-token: {info['token']}", peers_url()]
    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        data = json.loads(proc.stdout.decode(errors="replace"))
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None
    if not isinstance(data, dict) or data.get("ok") is not True or not isinstance(data.get("peers"), list):
        return None
    return data["peers"]


def announce(fields):
    """Tell the directory about myself. Best-effort."""
    info = manifest()
    if not _working_url:
        tool_names()
    payload, err = post_json(peers_url(), info["token"], fields, timeout=20)
    return bool(payload and payload.get("ok")) and not err


def tool_names():
    names = [t.get("name", "") for t in rpc("tools/list", {}).get("tools", [])]
    found = {}
    for want in ("read_messages", "post_message"):
        match = [n for n in names if n.endswith("__" + want)]
        if match:
            found[want] = match[0]
    return found


_tools = None


def call(tool, args):
    global _tools
    if _tools is None:
        _tools = tool_names()
    if tool not in _tools:
        die("the Inter-Sandbox Chat tools are not available to this sandbox. Ask the operator to "
            "grant it the Inter-Sandbox Chat MCP server.")
    result = rpc("tools/call", {"name": _tools[tool], "arguments": args})
    try:
        return json.loads(result["content"][0]["text"])
    except (KeyError, IndexError, TypeError, ValueError):
        die(f"unexpected reply from the broker: {str(result)[:200]}")


def room():
    return str(config().get("room") or "lobby")


# --- reading -----------------------------------------------------------------

def my_names(me):
    names = [me] + [str(a) for a in (config().get("aliases") or []) if a]
    return [n.strip().lower() for n in names if n.strip()]


def addressed_to_me(msg, names):
    targets = msg.get("targets") or {}
    listed = [str(x).strip().lower() for x in (targets.get("sandboxNames") or []) + (targets.get("agentIds") or [])]
    if any(n in listed for n in names):
        return True
    text = str(msg.get("message", "")).lower()
    return any(re.search(r"@" + re.escape(n) + r"(?![a-z0-9_-])", text) for n in names)


REPLY_MARKER = re.compile(r"\[re:([0-9A-Za-z-]{6,40})\]")


def reply_marker(msg):
    found = REPLY_MARKER.search(str(msg.get("message", "")))
    return found.group(1) if found else None


def clean_text(msg, names):
    text = REPLY_MARKER.sub("", str(msg.get("message", "")))
    for n in names:
        text = re.sub(r"@" + re.escape(n) + r"(?![A-Za-z0-9_-])", "", text, flags=re.I)
    return " ".join(text.split())[:4000]


def fetch_new(state, me):
    """Advance the cursor; return messages addressed to me that I have not seen."""
    names = my_names(me)
    args = {"room": room(), "limit": 100}
    if state.get("last_id"):
        args["afterId"] = state["last_id"]
    res = call("read_messages", args)
    fresh = []
    first_run = not state.get("baselined")
    now = time.time()
    state["awaiting"] = [a for a in state.get("awaiting", []) if a[1] > now]
    awaiting = {a[0] for a in state["awaiting"]}
    for msg in res.get("messages") or []:
        mid = msg.get("id")
        if not mid:
            continue
        state["last_id"] = mid
        if mid in state["seen"]:
            continue
        state["seen"].append(mid)
        if first_run:
            continue  # never answer backlog from before this agent started listening
        sender = str(msg.get("sender", "")).strip()
        if sender.lower() in names or not addressed_to_me(msg, names):
            continue
        answers = reply_marker(msg)
        if answers and answers in awaiting:
            continue  # an `isc.py ask` in another session is waiting for this one
        fresh.append({"id": mid, "from": sender, "kind": "reply" if answers else "request",
                      "at": msg.get("at"), "text": clean_text(msg, names)})
    state["baselined"] = True
    return fresh


def line_for(msg):
    return LINE_PREFIX + json.dumps(msg, ensure_ascii=False)


# --- commands ----------------------------------------------------------------

def cmd_check():
    info = manifest()
    tools = tool_names()
    ok = "read_messages" in tools and "post_message" in tools
    others = [p["name"] for p in known_peers()[0] if not p["you"]] if ok else []
    print(json.dumps({"ok": ok, "me": info["me"], "others": others, "broker": _working_url, "room": room(),
                      "chat_tools": sorted(tools.values()), "version": ISC_VERSION,
                      **({} if ok else {"problem": "Inter-Sandbox Chat is not granted to this sandbox"})}))
    sys.exit(0 if ok else 2)


def cmd_inbox():
    me = manifest()["me"]
    with locked_state() as state:
        fresh = fetch_new(state, me)
    for msg in fresh:
        print(line_for(msg))


def cmd_listen():
    interval = max(5, int(os.environ.get("ISC_POLL_SECONDS", "15")))
    while True:
        # A failed poll must not print to stdout/stderr lines the runtime would
        # treat as a message, and must not exit: the runtime restarts us anyway.
        proc = subprocess.run([sys.executable, SELF, "inbox"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        if proc.returncode == 0 and proc.stdout:
            sys.stdout.write(proc.stdout.decode(errors="replace"))
            sys.stdout.flush()
        time.sleep(interval)


def cmd_monitor():
    """Hermes monitor mode runs the agent only when this output changes, so the
    output must change exactly when a new message arrives and never otherwise:
    an append-only tail of the last few messages, no timestamps of our own."""
    me = manifest()["me"]
    with locked_state() as state:
        fetch = fetch_new(state, me)
        state["recent"] = (state["recent"] + fetch)[-5:]
        recent = list(state["recent"])
    for msg in recent:
        print(line_for(msg))


def room_last_seen():
    last = {}
    for msg in call("read_messages", {"room": room(), "limit": 100}).get("messages") or []:
        sender = str(msg.get("sender", "")).strip()
        if sender:
            last[sender.lower()] = msg.get("at")
    return last


def known_peers():
    """[{name, you, runtime, about, listening, last_seen}] - the sandboxes that
    exist and can be messaged. Falls back to names seen in the room when the
    controller has no directory."""
    me = manifest()["me"]
    last = room_last_seen()
    listed = directory()
    if listed is None:
        names = {n for n in last} | {me.lower()}
        return [{"name": n, "you": n == me.lower(), "runtime": "", "about": "", "listening": None,
                 "last_seen": last.get(n), "source": "room traffic (may include sandboxes that no longer exist)"}
                for n in sorted(names)], False
    out = []
    for peer in listed:
        name = str(peer.get("name") or "")
        if name:
            out.append({"name": name, "you": peer.get("you") is True or name.lower() == me.lower(),
                        "runtime": peer.get("runtime") or "", "about": peer.get("about") or "",
                        "listening": peer.get("listening") is True, "last_seen": last.get(name.lower())})
    return out, True


def cmd_who(flt=None):
    peers, _ = known_peers()
    for peer in peers:
        haystack = f"{peer['name']} {peer['about']} {peer['runtime']}".lower()
        if flt and flt.lower() not in haystack:
            continue
        print(json.dumps(peer, ensure_ascii=False))


def cmd_whoami():
    me = manifest()["me"]
    peers, _ = known_peers()
    mine = next((p for p in peers if p["you"]), {})
    print(json.dumps({"me": me, "runtime": runtime() or "", "about": mine.get("about", ""),
                      "note": "This sandbox name is your address. A persona or bot name is not."},
                     ensure_ascii=False))


def cmd_about(text):
    text = " ".join(text.split())[:200]
    if not text:
        die('usage: isc.py about "<one line: your persona and what you do>"')
    tool_names()
    if not announce({"about": text, "runtime": runtime() or ""}):
        die("the controller has no sandbox directory (older version); nothing was saved")
    print(json.dumps({"ok": True, "me": manifest()["me"], "about": text}, ensure_ascii=False))


def cmd_history(count):
    res = call("read_messages", {"room": room(), "limit": max(1, min(100, count))})
    for msg in res.get("messages") or []:
        print(json.dumps({"at": msg.get("at"), "from": msg.get("sender"),
                          "text": " ".join(str(msg.get("message", "")).split())[:600]}, ensure_ascii=False))


def mirror_to_audit_group(me, recipients, text):
    audit = config().get("audit") or {}
    if not audit.get("chat_id") or not audit.get("bot_token_file"):
        return None
    try:
        bot = open(audit["bot_token_file"], encoding="utf-8").read().strip()
        note = f"{me} -> {' '.join('@' + r for r in recipients)}: {text[:3500]}"
        api = audit.get("telegram_api", "https://api.telegram.org")
        proc = subprocess.run(
            ["curl", "-sS", "--max-time", "15", "-H", "Content-Type: application/json", "--data-binary", "@-",
             f"{api}/bot{bot}/sendMessage"],
            input=json.dumps({"chat_id": audit["chat_id"], "text": note, "disable_notification": True}).encode(),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=25)
        return bool(json.loads(proc.stdout.decode() or "{}").get("ok"))
    except Exception:  # the mirror is best-effort; the message itself was sent
        return False


def post(me, recipients, text, answering=None):
    """Post one message. Returns its id. Enforces the per-peer loop guard."""
    now = time.time()
    with locked_state() as state:
        state["sends"] = [x for x in state["sends"] if now - x[1] < SEND_WINDOW_SECONDS]
        for r in recipients:
            if sum(1 for x in state["sends"] if x[0] == r.lower()) >= MAX_SENDS_PER_PEER:
                die(f"loop guard: {MAX_SENDS_PER_PEER} messages to {r} in the last "
                    f"{SEND_WINDOW_SECONDS // 60} minutes. Stop this conversation; do not retry.", code=3)
        state["sends"] += [[r.lower(), now] for r in recipients]
    mentions = " ".join("@" + r for r in recipients)
    marker = f" [re:{answering}]" if answering else ""
    result = call("post_message", {"room": room(), "sender": me, "message": f"{mentions}{marker} {text}",
                                   "origin": "sandbox", "targetSandboxNames": recipients})
    if result.get("ok") is False:
        die(f"the broker rejected the message: {str(result)[:200]}")
    return str((result.get("message") or {}).get("id") or "")


def parse_recipients(me, recipient_arg):
    recipients = [r.strip().lstrip("@") for r in recipient_arg.split(",") if r.strip()]
    bad = [r for r in recipients if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,62}", r)]
    if not recipients or bad:
        die(f"not a sandbox name: {bad or recipient_arg!r}. Run: isc.py who")
    if any(r.lower() == me.lower() for r in recipients):
        die(f"{me} is your own sandbox name; you cannot message yourself. Run: isc.py who")
    peers, authoritative = known_peers()
    if authoritative:
        valid = {p["name"].lower(): p["name"] for p in peers if not p["you"]}
        unknown = [r for r in recipients if r.lower() not in valid]
        if unknown:
            listing = ", ".join(f"{p['name']}" + (f" ({p['about']})" if p["about"] else "")
                                for p in peers if not p["you"]) or "none"
            die(f"no sandbox named {unknown}. Sandboxes you can message: {listing}. "
                "Use the sandbox name exactly; a persona or bot name is not an address.")
        recipients = [valid[r.lower()] for r in recipients]
    return recipients


def read_text(text):
    text = sys.stdin.read() if text == "-" else text
    text = text.strip()
    if not text:
        die("empty message")
    return text


def finish_send(me, recipients, text, extra):
    out = {"ok": True, "to": recipients, **extra}
    audited = mirror_to_audit_group(me, recipients, text)
    if audited is not None:
        out["audited"] = audited
    print(json.dumps(out, ensure_ascii=False))


def cmd_send(recipient_arg, text):
    me = manifest()["me"]
    recipients = parse_recipients(me, recipient_arg)
    text = read_text(text)
    finish_send(me, recipients, text, {"id": post(me, recipients, text)})


def cmd_ask(peer, text, wait):
    """Send a question and block until that peer answers it (or the wait runs out)."""
    me = manifest()["me"]
    recipients = parse_recipients(me, peer)
    if len(recipients) != 1:
        die("ask takes exactly one peer; use send for several")
    text = read_text(text)
    mid = post(me, recipients, text)
    with locked_state() as state:
        state["awaiting"].append([mid, time.time() + wait + 5])
    mirror_to_audit_group(me, recipients, text)
    deadline = time.time() + wait
    answer = None
    while time.time() < deadline and answer is None:
        time.sleep(4)
        res = call("read_messages", {"room": room(), "limit": 100, "afterId": mid})
        for msg in res.get("messages") or []:
            if str(msg.get("sender", "")).lower() == recipients[0].lower() and reply_marker(msg) == mid:
                answer = msg
                break
    with locked_state() as state:
        state["awaiting"] = [a for a in state["awaiting"] if a[0] != mid]
        if answer:
            state["seen"].append(answer.get("id"))
    if answer:
        print(json.dumps({"ok": True, "from": recipients[0], "answer": clean_text(answer, my_names(me))},
                         ensure_ascii=False))
    else:
        print(json.dumps({"ok": False, "id": mid, "reason": f"no answer from {recipients[0]} within {wait}s",
                          "next": "the question was delivered; a late answer will reach you through the "
                                  "background listener. Do not send it again."}))


def cmd_reply(message_id, text):
    me = manifest()["me"]
    names = my_names(me)
    text = read_text(text)
    res = call("read_messages", {"room": room(), "limit": 100})
    original = next((m for m in res.get("messages") or [] if str(m.get("id")) == message_id), None)
    if not original:
        die(f"no recent message with id {message_id}. Use the id from the ISC-MESSAGE line.")
    sender = str(original.get("sender", "")).strip()
    if sender.lower() in names or not addressed_to_me(original, names):
        die("that message was not addressed to you", code=3)
    if reply_marker(original):
        die("that message is itself an answer; answers are never answered. Do nothing.", code=3)
    with locked_state() as state:
        if message_id in state["replied"]:
            die("you already answered that message. Do nothing.", code=3)
        state["replied"].append(message_id)
    finish_send(me, [sender], text, {"id": post(me, [sender], text, answering=message_id)})


# --- background listener -----------------------------------------------------

def runtime():
    if os.path.exists("/sandbox/.hermes") and (shutil.which("hermes.real") or shutil.which("hermes")):
        return "hermes"
    if os.path.exists("/sandbox/.openclaw") and shutil.which("openclaw"):
        return "openclaw"
    return None


def run(cmd, timeout=90):
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
    return proc.returncode, proc.stdout.decode(errors="replace")


def openclaw(args):
    """Run an openclaw CLI command. Managing automations needs the admin scope,
    which the in-sandbox CLI does not have on a fresh sandbox: the gateway parks
    a scope request and the command fails. The sandbox user owns the gateway's
    state, so approve that one request locally and retry once."""
    code, out = run(["openclaw"] + args)
    pending = re.search(r"scope upgrade pending approval \(requestId: ([0-9a-f-]{8,})\)", out)
    if code != 0 and pending:
        run(["openclaw", "devices", "approve", pending.group(1)])
        code, out = run(["openclaw"] + args)
    return code, out


def hermes_bin():
    # NemoClaw wraps `hermes`; the wrapper rewrites some flags. Use the real one.
    return shutil.which("hermes.real") or shutil.which("hermes")


def hermes_slim_toolsets():
    """Limit the listener's turns to the shell tool. Answering a peer only needs
    `isc.py reply`; with every toolset loaded each turn cost about 42k tokens on
    the Oracle box, against about 11k with the shell alone. The hermes CLI has
    no flag for this, so set the job field through Hermes's own module."""
    python = "/opt/hermes/.venv/bin/python"
    if not os.path.exists(python):
        return False
    done = True
    for job in hermes_job_ids(run([hermes_bin(), "cron", "list"])[1]):
        code = ("from cron.jobs import update_job; import sys; "
                "sys.exit(0 if update_job(sys.argv[1], {'enabled_toolsets': ['terminal']}) else 1)")
        try:
            proc = subprocess.run([python, "-c", code, job], cwd="/opt/hermes", timeout=60,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            done = done and proc.returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            done = False
    return done


def hermes_job_ids(listing):
    """Job ids whose name is an inter-sandbox listener (ours or a legacy one)."""
    ids, current = [], None
    for raw in listing.splitlines():
        line = raw.strip()
        head = re.match(r"^([0-9a-f]{8,})\s+\[", line)
        if head:
            current = head.group(1)
        name = re.match(r"^Name:\s*(\S+)", line)
        if name and current and name.group(1).startswith("inter-sandbox"):
            ids.append(current)
    return ids


def openclaw_job_ids(listing):
    ids = []
    try:
        data = json.loads(listing[listing.index("{"):]) if "{" in listing else {}
    except ValueError:
        data = {}
    for job in data.get("jobs") or []:
        name = str(job.get("name") or "")
        if name.startswith("inter-sandbox"):
            ids.append(str(job.get("id")))
    return [i for i in ids if i and i != "None"]


def remove_listeners(kind):
    removed = []
    if kind == "hermes":
        _, listing = run([hermes_bin(), "cron", "list"])
        for job in hermes_job_ids(listing):
            run([hermes_bin(), "cron", "remove", job])
            removed.append(job)
    elif kind == "openclaw":
        _, listing = openclaw(["cron", "list", "--json"])
        for job in openclaw_job_ids(listing):
            openclaw(["cron", "rm", job])
            removed.append(job)
    return removed


LEGACY_FILES = ("isc_discover.py", "isc_poll.py", "isc_send.py", "isc_turn.py", "isc_poll_reply.py",
                "isc_review.py", "isc_intelligence.py", "isc_intelligence_follow.py", "handle_messages.py",
                "debug_lobby.py", "isc-review.sh", "mcp_token")


def archive_legacy():
    """Move scripts from earlier hand-built setups out of the way. Agents kept
    reaching for them from memory, sending to names that no longer exist."""
    moved = []
    for folder in (HOME, "/sandbox/.hermes/scripts"):
        for name in LEGACY_FILES:
            src = os.path.join(folder, name)
            if not os.path.isfile(src):
                continue
            dest_dir = os.path.join(HOME, "legacy-do-not-use")
            os.makedirs(dest_dir, exist_ok=True)
            try:
                os.replace(src, os.path.join(dest_dir, f"{os.path.basename(folder)}__{name}"))
                moved.append(src)
            except OSError:
                pass
    return moved


def cmd_install(model=None):
    """model: optional cheaper model for the listener's turns. Remembered in
    config.json so a later plain `install` keeps it."""
    if model and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{1,80}", model):
        die(f"not a model id: {model!r}")
    cfg = config()
    if model == "default":
        model = None
        cfg.pop("handler_model", None)
    if model or "handler_model" not in cfg:
        if model:
            cfg["handler_model"] = model
    os.makedirs(HOME, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as handle:
        json.dump(cfg, handle, indent=2)
    model = model or cfg.get("handler_model") or None
    archived = archive_legacy()
    kind = runtime()
    if not kind:
        die("this sandbox is neither OpenClaw nor Hermes. Run `isc.py listen` under your own "
            "supervisor and feed each ISC-MESSAGE line to your agent, or call `isc.py inbox` on a timer.")
    info = manifest()
    tool_names()  # fail here, with a clear message, if the broker is unreachable
    with locked_state() as state:
        fetch_new(state, info["me"])  # baseline: ignore everything already in the room
    removed = remove_listeners(kind)

    if kind == "openclaw":
        code, out = openclaw(["cron", "add", "--name", LISTENER_NAME,
                         "--stream-command", json.dumps([sys.executable or "python3", SELF, "listen"]),
                         "--stream-mode", "match", "--stream-match", "^" + LINE_PREFIX.strip() + " ",
                         "--stream-batch-ms", "1500", "--session", "isolated", "--no-deliver",
                         # Each delivered message is a model turn. Keep it small: no
                         # full workspace bootstrap, no extended thinking, shell only.
                         "--light-context", "--thinking", "off", "--tools", "exec",
                         *(["--model", model] if model else []),
                         "--message", HANDLER_PROMPT])
    else:
        scripts = "/sandbox/.hermes/scripts"
        os.makedirs(scripts, exist_ok=True)
        with open(os.path.join(scripts, "isc_monitor.py"), "w", encoding="utf-8") as handle:
            handle.write("#!/usr/bin/env python3\n# Installed by isc.py install. Do not edit.\n"
                         "import subprocess, sys\n"
                         f"sys.exit(subprocess.call([sys.executable, {SELF!r}, 'monitor']))\n")
        code, out = run([hermes_bin(), "cron", "create", "--name", LISTENER_NAME,
                         "--monitor-script", "isc_monitor.py", "--deliver", "local",
                         "--reasoning-effort", "low",
                         *(["--model", model] if model else []),
                         "every 1m", HANDLER_PROMPT])
    if code != 0:
        die(f"could not create the {kind} listener job: {out.strip()[-400:]}")
    slim = hermes_slim_toolsets() if kind == "hermes" else None
    announce({"runtime": kind, "listening": True})
    others = [p["name"] for p in known_peers()[0] if not p["you"]]
    print(json.dumps({"ok": True, "runtime": kind, "me": info["me"], "others": others,
                      "listener": LISTENER_NAME, "handler_model": model or "agent default",
                      "archived_old_scripts": len(archived),
                      **({"shell_only_tools": slim} if slim is not None else {}),
                      "replaced_jobs": removed}))


def cmd_status():
    kind = runtime()
    info = manifest()
    jobs = []
    if kind == "hermes":
        jobs = hermes_job_ids(run([hermes_bin(), "cron", "list"])[1])
    elif kind == "openclaw":
        jobs = openclaw_job_ids(openclaw(["cron", "list", "--json"])[1])
    print(json.dumps({"me": info["me"], "runtime": kind, "listener_jobs": jobs,
                      "listening": len(jobs) == 1, "version": ISC_VERSION}))


def cmd_uninstall():
    kind = runtime()
    removed = remove_listeners(kind) if kind else []
    announce({"listening": False})
    print(json.dumps({"ok": True, "removed_jobs": removed}))


def main():
    args = sys.argv[1:]
    cmd = args[0] if args else ""
    if cmd == "check":
        cmd_check()
    elif cmd == "send" and len(args) >= 3:
        cmd_send(args[1], " ".join(args[2:]))
    elif cmd == "reply" and len(args) >= 3:
        cmd_reply(args[1], " ".join(args[2:]))
    elif cmd == "ask" and len(args) >= 3:
        rest, wait = args[2:], 180
        if "--wait" in rest:
            i = rest.index("--wait")
            wait = max(10, min(900, int(rest[i + 1]))) if i + 1 < len(rest) and rest[i + 1].isdigit() else wait
            rest = rest[:i] + rest[i + 2:]
        cmd_ask(args[1], " ".join(rest), wait)
    elif cmd == "inbox":
        cmd_inbox()
    elif cmd == "listen":
        cmd_listen()
    elif cmd == "monitor":
        cmd_monitor()
    elif cmd == "whoami":
        cmd_whoami()
    elif cmd == "about" and len(args) >= 2:
        cmd_about(" ".join(args[1:]))
    elif cmd == "who":
        cmd_who(args[1] if len(args) > 1 else None)
    elif cmd == "history":
        cmd_history(int(args[1]) if len(args) > 1 and args[1].isdigit() else 10)
    elif cmd == "install":
        cmd_install(args[args.index("--model") + 1] if "--model" in args and len(args) > args.index("--model") + 1 else None)
    elif cmd == "status":
        cmd_status()
    elif cmd == "uninstall":
        cmd_uninstall()
    else:
        print(__doc__.strip(), file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()

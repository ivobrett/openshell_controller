# 12 — Terminal & lifecycle hardening (v3 amendments)

The operator's highest-stakes workflow is dropping into a sandbox shell to
run `openclaw` / Hermes commands directly. This doc audits that path plus
restart/recover, backup/restore, and file transfer, and specifies the
hardening work. New phase **4b** in §09 carries the terminal items; the
lifecycle items land in Phases 3/4/6 as noted.

## 12.1 Terminal architecture (verified, do-not-touch boundary)

```
browser xterm ── WS ──> server.mjs (/api/openshell/terminal/live/ws, auth)
                           │ proxied to
                        terminal-server.mjs (127.0.0.1:3011, node-pty)
                           │ spawns
                        ssh openshell-<sandbox> (pty)
```

Facts that shape the design (from `terminal-server.mjs` + the page):

- **Sessions are server-side and survive socket drops.** `sessions` map
  keyed by sessionId; each keeps a 200 kB replay buffer; reconnecting with
  the same `sessionId` (the page already re-sends `liveSessionIdRef`)
  replays the buffer. Max 24 sessions, oldest evicted.
- **Unknown WS message types are silently ignored**
  (`terminal-server.mjs:456-472` — only `input`/`resize`/`kill` are
  handled, unknown types fall through, malformed frames caught). A
  client keepalive `{type:"ping"}` is therefore safe with **zero server
  change**.
- Session allocation: `POST /api/openshell/terminal/live` — the one
  OAuth-allowlisted write, per-sandbox gated. Readiness probe:
  `GET /api/openshell/terminal/readiness` (pod/ssh/shell checks + attach
  command fallbacks).
- **Boundary:** no changes to `server.mjs`, `terminal-server.mjs`, or the
  live/readiness routes. Everything below is client-side in
  `app/operator-terminal/page.tsx` (+ extracted hooks).

## 12.2 Why the current terminal is not "rock solid" (verified gaps)

1. **No auto-reconnect.** `socket close` → status text "Terminal
   disconnected. Refresh session to reconnect." and a manual button
   (`page.tsx:298-302`). A network blip, laptop sleep, controller restart,
   or proxy idle-timeout kills the shell until the human notices.
2. **No keepalive.** An idle shell (agent running a long command, operator
   watching) sends nothing; Pangolin/Traefik idle timeouts can close the
   WS. Combined with (1), "I left the tab for 5 minutes and my terminal
   died" — exactly the reported pain.
3. **Unusable on phones.** No Esc/Tab/Ctrl/arrow keys on soft keyboards, no
   `visualViewport` handling (keyboard covers the prompt), 13 px fixed font.
4. Exit state is styled as an error with no obvious "start new session".

## 12.3 Terminal hardening spec (Phase 4b — client only)

Refactor `app/operator-terminal/page.tsx`: extract the xterm + socket
machinery into `app/hooks/useTerminalConnection.ts` (testable, reusable by
the future mobile app) and keep the page as layout. Behavior spec:

### a) Auto-reconnect with backoff

State machine: `connecting → connected → reconnecting(n) → ended | failed`.

- On socket `close` that was NOT user-initiated (`kill`, page nav) and NOT
  after an `exit` message: enter `reconnecting`, re-run the existing
  `ensureLiveSession()` **keeping the same sessionId** (server replays the
  buffer — scrollback is preserved). Backoff 1 s, 2 s, 4 s, 8 s, 15 s
  (5 attempts), then `failed` with a `Reconnect` button.
- Overlay on the terminal while reconnecting: dim scrim +
  `Reconnecting… attempt {n}/5` (mono, amber LED), scrollback stays
  visible underneath. On success: toast `Terminal reconnected`, no reset if
  the server replay already restored state (the existing
  `ready`/`replay` handling covers this — keep it).
- `visibilitychange → visible` and `window online` events: if socket not
  OPEN and state isn't `ended`, reconnect immediately (attempt counter
  reset). This is the wake-from-sleep fix.
- If the live-session POST returns 401 → `apiFetch` login redirect (§6.1).
  If it returns a NEW sessionId (server evicted the old one), show toast
  `Previous session expired — started a new shell.`

### b) Keepalive

While the socket is OPEN, send `{type:"ping"}` every **25 s**
(`setInterval`, cleared on close). Server ignores it (verified above); its
only job is producing traffic so intermediary proxies don't idle-close.
Do not send pings while `document.hidden` — a backgrounded tab may drop and
auto-reconnect on focus instead (deliberate: don't hold proxy slots for
hidden tabs).

### c) Session end UX

`exit` message → state `ended`: green-bordered (not red) banner
`Session ended (exit code {n})` + primary button `Start new session`
(resets sessionId, fresh allocation). Errors keep the red treatment.

### d) Mobile / touch usability (also serves the future Capacitor app)

- **Key toolbar** `app/components/terminal/TerminalKeyBar.tsx`: rendered
  when `matchMedia('(pointer: coarse)')` — a horizontal scrollable row of
  mono buttons above the terminal:
  `Esc | Tab | Ctrl (latching toggle) | ↑ ↓ ← → | ^C | Paste`.
  Implementation: `term.input(seq)` equivalents — Esc `\x1b`, Tab `\t`,
  arrows `\x1b[A/B/D/C`, `^C` `\x03`; Ctrl toggle: while latched, next
  printable key k sends `chr(k & 0x1f)` then unlatches (hook into
  `term.onData`). Paste: `navigator.clipboard.readText()` → send as input
  (Capacitor webview grants clipboard; browser may prompt).
- **Soft keyboard:** listen to `window.visualViewport` `resize` and set the
  terminal container height to `visualViewport.height - headerHeight`, then
  `fit()`. Without this the prompt hides behind the keyboard.
- Font size control: `A− / A+` buttons (12–18 px, persist to
  `localStorage['openshell-control.terminal-font']`, call
  `term.options.fontSize = n` + `fit()`).
- Page restyle to §02 tokens happens here too (moves out of Phase 7):
  PageHeader, StatusLed for the readiness + connection states, Cards for
  the recovery-commands section. Readiness/recovery logic unchanged.

## 12.4 Restart / recover — surface what the backend already does

Verified: `POST /api/sandbox/[id]/restart` is **recovery-first**: refuses if
the sandbox isn't Ready (`restarted:false` + note), else tries
`nemoclaw <sandbox> recover` (90 s timeout — the CLAUDE.md §3 inner-gateway
recovery), else falls back to restarting the in-sandbox OpenClaw gateway
runtime (45 s script). It returns `restartMode`
(`"nemoclaw-recover" | "openclaw-runtime"`) and a human `note`. It never
deletes the pod. The current UI hides all of this behind a generic
"Restart Sandbox" button.

Amendments (§5.2 row menu + §5.3 detail header, Phase 4):

- Label the action **`Restart runtime`**; menu/tooltip description
  `Recover the sandbox gateway and agent runtime (keeps all data)`.
- The call uses `apiFetch` with `AbortSignal.timeout(180_000)` (recover 90 s
  + fallback 45 s + ready-wait can exceed 2 min). Progress: sonner
  `toast.loading("Restarting runtime for <name>… (can take up to 2 minutes)")`
  updated via `toast.success/error(id)` on completion.
- Success toast surfaces the truth: `restartMode === "nemoclaw-recover"` →
  `Recovered <name> via NemoClaw`; `"openclaw-runtime"` →
  `Restarted OpenClaw runtime in <name>`; and show the response `note` as
  the toast description. `restarted:false` (not Ready) → warning toast with
  the note — do NOT display it as success.
- After success: invalidate `["inventory"]` and, if a terminal to that
  sandbox is open in another tab, nothing (its auto-reconnect from §12.3
  will pick the session back up — this pairing is the point).
- Detail-page Overview gains a small "Runtime" card: last restart result
  (from the response, session-local state only) + the `Restart runtime`
  button + link to `?tab=` nothing else. Keep it minimal.

## 12.5 Backup / restore — completeness audit + amendments

Verified surface (all real, all reachable from `SandboxArchivePanel`):
create+download archive (`GET …/backup?path=`), save archive to server
catalog (`POST /api/backups`), list catalog (`GET /api/backups` —
entries carry `fileName,sandboxName,sourcePath,size,createdAt`), restore
from catalog (`POST /api/backups/[id]/restore`), download catalog entry,
delete catalog entry, restore an *uploaded* archive
(`POST …/restore`, `replace` flag), 128 MiB default transfer cap
(`SANDBOX_FILE_TRANSFER_MAX_BYTES`). Conclusion: **control is good; it's
discoverability and guardrails that are weak.** Amendments:

1. **Backup-before-delete** (Phase 3, in `DeleteSandboxDialog`): between
   body text and the name input, a bordered row: `Download a backup of
   /sandbox first` + `Download backup` outline button → triggers the
   existing `GET /api/sandbox/<id>/backup?path=/sandbox` download (same
   code path as the Backup tab). Non-blocking — deletion never requires it.
   Row hidden when the sandbox isn't running (backup exec would fail).
2. **Replace-mode confirmation** (Phase 6, ArchivePanel restyle): when
   restoring with `replace` enabled, an `AlertDialog`: `Replace mode deletes
   files in <targetPath> that aren't in the archive. Continue?` Plain
   (merge) restores stay one-click.
3. **Catalog table** (Phase 6): render catalog entries as a table —
   fileName (mono), sandbox, `size` humanized, `createdAt` relative — with
   Restore / Download / Delete actions; empty state "No backups in the
   catalog yet. Create one from a sandbox's Backup tab."
4. Restore/backup buttons get busy states with honest duration hints
   (archives of large sandboxes take tens of seconds — keep the panel's
   existing `busy` state machine, add elapsed-seconds counter next to the
   spinner after 5 s).

## 12.6 File transfer — audit + amendments

Verified: upload (`POST …/files/upload`, multipart, 128 MiB cap, whole-file
buffered server-side), list (`GET …/files/list`, 200 entries cap),
download. Amendments (Phase 6, `SandboxFilesPanel` restyle):

1. **Upload progress:** `fetch` can't report upload progress — switch the
   panel's upload call to `XMLHttpRequest` with `upload.onprogress` driving
   a progress bar (percent + MB/s). On completion re-fetch the file list.
   Keep single-request semantics; no chunking (the 128 MiB cap makes it
   unnecessary).
2. **Client-side size pre-check:** reject files > 128 MiB before uploading
   with the server's own message text (read the cap from a new field?
   No — hardcode 128 and note the env var in a `title`; do not add an API).
3. Drag-and-drop onto the panel (`onDrop` on the card; same handler as the
   file input). Mobile keeps the file picker.

## 12.7 Tests (added to §10)

| Test | Asserts |
|---|---|
| `tests/terminal-reconnect-check.mjs` | source of `useTerminalConnection.ts`: reconnect backoff array `[1000,2000,4000,8000,15000]` present; `visibilitychange` and `online` listeners registered; same-`sessionId` reuse on reconnect (no sessionId reset in the reconnect path); `{type:"ping"}` interval 25000 with `document.hidden` guard |
| `tests/terminal-server-ping-tolerance-check.mjs` | source of `terminal-server.mjs`: the message handler's if/else chain has no `throw` and no `socket.close` for unhandled types (locks in the server behaviour the ping relies on — if upstream changes this, the test flags it) |
| `tests/restart-ux-check.mjs` | source: restart action uses `AbortSignal.timeout(180_000)`, branches on `restartMode`, treats `restarted:false` as warning not success |
| `tests/delete-dialog-backup-check.mjs` | source: `DeleteSandboxDialog.tsx` contains the backup download link gated on running status |

Manual matrix additions (§10.2): M25 kill the WS mid-session
(`systemctl restart openshell-controller` on the VPS with a shell open) →
overlay appears, terminal auto-reconnects with scrollback intact ≤60 s;
M26 leave a terminal idle 10 min behind Pangolin → still live (keepalive);
M27 iPhone-width devtools + touch emulation → key bar sends Esc/^C/arrows,
prompt visible with keyboard open; M28 `Restart runtime` on a healthy
sandbox → success toast names the mode, terminal in other tab recovers
by itself; M29 delete dialog offers backup download and it produces a
valid archive.

## 12.8 Explicitly rejected

- **Server-side terminal changes** (protocol pings, session pinning,
  multi-tab shared sessions): the client-only design achieves the
  reliability goal; the terminal server is upstream-shared surface.
- **tmux-style persistent named sessions in the UI:** the 200 kB replay +
  session reuse already covers reconnects; anything longer-lived belongs in
  tmux inside the sandbox (document in Help page copy: "For long-running
  work, run tmux inside the sandbox — the web terminal reattaches to your
  session on reconnect, but a controller restart starts a fresh shell.").
- **Web-terminal chunked/resumable uploads:** 128 MiB cap makes complexity
  unjustified.

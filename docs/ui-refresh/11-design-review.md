# 11 — Critical design review (v2 amendments)

A self-review of docs 01–10 against best-in-class sandbox/container control
planes — Docker Desktop, Portainer, Lens, Coolify — and against
agent-operations UX (human-in-the-loop approval queues), plus a code-level
read of `crowdsec_manager/mobile` (Capacitor). Verdict per finding, and the
**amendments are already folded into docs 04, 05, 08, 09, 10** — this doc
records the reasoning so the implementer understands why, and what was
deliberately rejected.

## 11.1 What the benchmarks do that v1 missed

### A. Approvals are the killer feature of an AI-agent fleet — v1 buried them (FIXED)

Docker Desktop manages passive containers; our sandboxes contain **agents
that ask for things** (network permission requests). That makes the operator
paradigm closer to a pager/inbox than a container list. v1 was actually a
regression here: the current UI lets you Allow/Deny from each sandbox card's
`PermissionMenu`; v1 moved approvals behind detail page → Policy tab.

**Amendment (now in §4.3, §5.8):** a global **Approvals bell** in the TopBar
— badge with total pending count across all sandboxes, popover listing each
pending request (sandbox, endpoint, confidence) with inline **Allow / Deny**
buttons, and a "Review in policy tab" link per sandbox. The dashboard "Needs
action" stat card opens the same popover. The Policy tab remains the full
review surface (rationale text, binaries, dismissed alerts). Operator-only
(`can('approvePermissions')`).

### B. No search/filter on the fleet list (FIXED)

Docker Desktop, Portainer, and Lens all put search-as-you-type above the
list. v1's compact table fixes density but not findability.

**Amendment (§5.2):** a search input (filters by name/agent, client-side)
plus status filter chips `All / Running / Stopped / Attention` above the
table. Chip counts included. Persist nothing — resets on navigation.

### C. Start/stop — the Docker Desktop primary action (REJECTED, documented)

`app/api/actions/sandbox-start|sandbox-stop/route.ts` are **upstream mocks**
(setTimeout + canned JSON, marked "Mock action handler", used by no
component). The real backend supports create / delete / restart only. Wiring
buttons to mocks would fake state changes — worse than absence.

**Decision:** no start/stop in this refresh. Recorded in §11.4 as a backend
gap. Do not delete the mock routes (upstream-owned files; needless
divergence).

### D. Day-2 gateway failure has a runbook but no UI (FIXED)

The known catastrophic mode — Docker-driver gateway dies, every sandbox
shows Exited, `transport error / connection refused` (CLAUDE.md §3) — would
surface in v1 as a permanent error panel. Meanwhile
`POST /api/openshell/gateway/repair` exists, is real (config backup + CLI
repair), and is consumed by **zero** components today.

**Amendment (§5.1):** the full-page inventory error state (no cached data)
gains, for operators only, an **"Attempt gateway repair"** button → POST
`/api/openshell/gateway/repair` (empty body), busy state while it runs (can
take ~90 s; the route's own timeout), then invalidate `["inventory"]`. On
failure, render the route's stdout/stderr in a mono `<pre>` and the hint
"See docs runbook: gateway recovery." Middleware already makes this
operator-only (POST + not on the OAuth allowlist). The "Reconnecting…"
badge behaviour for transient errors is unchanged.

### E. Logs and real per-sandbox metrics (REJECTED — backend gaps, documented)

Docker Desktop's most-used detail tab is Logs; Lens shows per-row CPU/mem.
Our backend has neither: no log-streaming API, and `/api/telemetry/sandbox`
is synthesized data (`buildSandboxTelemetry` fabricates values — verify by
reading `app/api/telemetry/sandbox/telemetry.ts` before ever using it).
`/api/telemetry/combined` is host-level.

**Decisions:** (1) no Logs tab, no per-row metrics in this refresh — the
terminal is the escape hatch; (2) the detail Overview's metric cards MUST be
labelled **"Host resources"** (v1 implied they were per-sandbox — the
current UI has the same dishonesty; fix the label, `CPU/MEM/DISK` cards
titled `Host CPU` etc.); (3) §11.4 records the backend work that would
unlock both. Do not build UI against the synthesized route.

### F. Timestamps ("created", "last activity") — REJECTED

Best-in-class lists show age/uptime. `SandboxInventoryItem` carries no
timestamps and the inventory sources don't expose them. Backend gap,
documented in §11.4. Do not fake it from the activity log.

### G. Embedded terminal tab — REJECTED with reason

Docker Desktop embeds Exec in the detail view. Our terminal is a separate
page whose WS auth flows through `server.mjs`, and middleware sets
`X-Frame-Options: DENY` globally — an iframe-embedded terminal would require
weakening a deliberate security header. New-tab terminal stays. (Do NOT add
frame-ancestors exceptions.)

### H. Command palette / global search (REJECTED)

crowdsec_manager's web app ships `cmdk`. With ~10 sandboxes and 8 routes,
a palette is ornament; the search input (B) covers the real need. Rejected
for scope — revisit only if fleets grow to hundreds.

### I. Typed-name delete confirmation (KEPT, deliberately)

Docker Desktop deletes with a plain confirm. Our delete is irreversible
destruction of a stateful agent environment with no undo and no backup
unless the operator made one — GitHub-style typed confirmation is the right
friction for a < once-a-day action. Kept as specced (§5.4).

## 11.2 Design-system corrections (folded into §02)

1. **`--accent` alpha bug:** v1 defined `--accent: 82 100% 36% / 0.10`.
   Tailwind emits `hsl(var(--accent))` — embedding alpha in the var breaks
   any future `/opacity` modifier and is nonstandard for shadcn themes.
   **Corrected** to solid surfaces: dark `--accent: 82 40% 12%` (deep green
   tint) with `--accent-foreground: 82 100% 60%`; light `--accent: 82 40%
   90%`, `--accent-foreground: 82 100% 22%`.
2. **Vendoring note:** when copying crowdsec's `ui/*` components, also strip
   their custom token names (`bg-canvas`, `text-ink`, `border-hairline` —
   their mobile app uses a different token dialect). Copy from
   `crowdsec_manager/web/src/components/ui/` (standard shadcn tokens), not
   from `mobile/src/components/ui/`.

## 11.3 Mobile: what the crowdsec Capacitor app actually does (rewrites §08)

Read from source (`mobile/src`): it is a **separate Vite + React SPA**, not
shared code with their web app — pages and even ui/ components are
duplicated with a mobile-tuned token dialect. Key mechanics worth copying
verbatim (§08 now specifies this as the Horizon-2 blueprint):

- **Connection profiles** (`lib/connection.ts`): `direct | proxy-basic |
  pangolin` modes. Pangolin mode stores a resource access token and sends it
  as `P-Access-Token-Id` / `P-Access-Token` headers on every request, plus a
  `p_token` query param on WebSocket URLs (WS can't carry custom headers).
  **This is exactly our front door** — the controller sits behind Pangolin —
  so the app can authenticate to Pangolin the same proven way.
- **Secure storage** (`lib/secureStorage.ts`): `capacitor-secure-storage-plugin`
  → iOS Keychain / Android EncryptedSharedPreferences, localStorage fallback
  on web builds. Stores the whole connection profile.
- **One ApiClient class** (`lib/api/client.ts`): base-URL injection, error
  envelope normalization, `getWebSocketUrl()` that flips http(s)→ws(s) and
  decorates auth. Our §6.1 `apiFetch` is the seam that maps onto this.
- **App shell:** onboarding screen → login → lazy-loaded routes with
  skeleton fallbacks, `OfflineConnectionBanner`, 5-tab `BottomNav`,
  `safe-top`/`safe-bottom` utilities, error boundary. Capacitor 8 with
  `CapacitorHttp: enabled` (native HTTP = native cookie jar), splash/status
  bar/keyboard/haptics plugins.
- **Terminal:** xterm over the WS URL from the client seam.

**Implication for our app (decided, recorded in §08):** the OpenShell mobile
app will be `mobile/` in this repo, same stack (Vite + React + TS +
Capacitor 8 + TanStack Query + shadcn-style tokens from §02), connection
profile = controller base URL + optional Pangolin resource token, controller
auth = the existing cookie session obtained by POSTing `/api/auth/login`
(CapacitorHttp's native cookie jar carries `openshell_control_session`
automatically; verified pattern — crowdsec relies on the same native-HTTP
cookie behaviour for its proxy-basic mode). The WS terminal needs the
session cookie on the upgrade request — native webview WS sends the cookie
jar automatically for same-origin URLs; this must be validated in the first
mobile spike (§08 lists it as spike task #1, with a PAT fallback design
sketched if it fails). Still Horizon 2 — NOT part of phases 0–8 — but the
blueprint is now concrete enough to be its own plan when you're ready.

## 11.4 Recorded backend gaps (future work, NOT this refresh)

| Gap | What it unlocks | Sketch |
|---|---|---|
| Real per-sandbox metrics | CPU/mem per table row, detail-page graphs | `docker stats`-equivalent via nemoclaw/openshell CLI, cached server-side, one batch endpoint |
| Sandbox log streaming | Logs tab (Docker Desktop's most-used view) | SSE or WS tail of container logs / `/tmp/gateway.log`, operator-only, needs §10-style token tests |
| Real start/stop | Row start/stop actions | Replace the mock `actions/sandbox-*` routes with real CLI calls upstream |
| Inventory timestamps | Age/uptime column, "changed while away" diffing | Extend inventory source to include createdAt/startedAt |
| Approvals push | Mobile push notifications for permission requests | Requires the Capacitor app + a notification relay; design with the mobile plan |

## 11.5 Net deltas applied to the other docs

- §02: accent token fix; vendoring source note (11.2).
- §04: TopBar gains the Approvals bell (spec in §5.9).
- §05: adds §5.2 search+filter row; §5.8 ApprovalsBell spec; gateway-repair
  error state in §5.1; "Host resources" labelling in §5.3 Overview.
- §08: Horizon-2 section rewritten as the concrete crowdsec-derived
  blueprint incl. auth decision and spike list.
- §09: Phase 3 scope grows (search/filter, bell, repair button); Phase 4
  Overview labelling; test files added.
- §10: new tests + matrix rows M21–M24.

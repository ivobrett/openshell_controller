# OpenShell Controller — Web UI Refresh Plan

**Status:** approved design, ready for implementation
**Author:** design pass 2026-07-07 (Fable), for execution by a coding agent
**Scope:** complete visual + structural refresh of the controller web UI, with
mobile-app readiness, WITHOUT changing any server-side sandbox/gateway/token
behaviour that currently works.

---

## How to use this plan

Read the documents in order once, then execute **phase by phase** from
`09-implementation-phases.md`. Every decision has already been made — do not
substitute libraries, colors, routes, or component names. If something in this
plan contradicts observed reality in the repo (upstream merge landed, file
moved), STOP and flag it to the operator rather than improvising.

**Sessions and models:** one phase per agent session, fresh context, model
per the assignment table at the top of `09-implementation-phases.md`
(Sonnet for the mechanical phases; Opus for phases 1, 4, 4b, 8, and the
final merge; operator-run `/code-review ultra` gates on 1, 4, and 8).
Kickoff prompt for every session:

> Read `docs/ui-refresh/README.md`, then execute Phase <n> from
> `docs/ui-refresh/09-implementation-phases.md` exactly as specified,
> including its referenced sections. Do not start any other phase.

| Doc | Contents |
|---|---|
| `01-current-state-and-problems.md` | What exists today, root-cause analysis of each reported problem, file inventory |
| `02-design-system.md` | shadcn/ui setup, theme tokens, typography, component primitives — exact code |
| `03-auth-and-capabilities.md` | Role-aware UI: new `/api/auth/me` contract, inventory filtering, middleware changes |
| `04-app-shell-and-routing.md` | Route map, sidebar/top bar/bottom tabs, navigation — exact code |
| `05-pages-dashboard-and-sandbox.md` | Dashboard page, sandbox table, sandbox detail page with tabs, delete flow, launch flow (30 s fix) |
| `06-data-layer.md` | TanStack Query adoption, resilient polling (idle-error fix), `apiFetch`, session-expiry handling |
| `07-login-and-security.md` | Login page redesign (IdP-primary), security page, optional TOTP 2FA |
| `08-mobile-readiness.md` | Responsive rules, PWA manifest, future Capacitor app architecture |
| `09-implementation-phases.md` | Ordered phases, per-phase file lists, acceptance criteria, commit/deploy procedure |
| `10-test-plan.md` | Automated test additions, manual BYOVPS test matrix, visual QA |
| `11-design-review.md` | v2 critical review vs Docker Desktop / agent-ops paradigms; rationale for the Approvals bell, search/filter, gateway-repair button, rejected features, and the concrete Capacitor mobile blueprint. Read it — it explains several "why"s behind docs 04/05/08 |
| `12-terminal-and-lifecycle-hardening.md` | v3: terminal rock-solidity (auto-reconnect with server-side replay, keepalive, mobile key bar — Phase 4b), honest restart/recover semantics, backup-before-delete, restore guardrails, upload progress. Read before Phases 3, 4, 4b, 6 |
| `13-agent-capabilities-and-skills.md` | v4: MEM/CHAT capability chips surfacing the baseline `memory` + `inter-sandbox-chat` MCP servers everywhere, one-click enable from the detail Overview, and the repo-backed read-only skills library (`skills/` dir, `/skills` page, terminal quick-copy sheet — Phase 4c) |

## The seven problems this refresh fixes

1. **"Start OpenClaw Gateway Dashboard" feels dead for up to 30 s** — the
   button awaits a server probe (SSH tunnel spin-up + gateway probe) before
   opening a tab. Fix: open `/launch/dashboard` in a new tab *synchronously*
   on click; that page shows live progress and redirects itself (§05).
2. **Idle UI shows scary "communication issues" errors that a refresh clears**
   — `useSandboxInventory` wipes the whole sandbox list and shows an error
   panel on ANY single failed poll (`app/hooks/useSandboxInventory.ts:116`).
   Fix: TanStack Query with kept-previous-data, retries with backoff, and a
   subtle "reconnecting" indicator instead of destroying state (§06).
3. **IdP (OAuth) users see every operator control, but the buttons 403** —
   `/api/auth/me` only returns an `operator` boolean; the UI has no
   capability model. Fix: capability-based `/api/auth/me` v2 + `useAuth()`
   provider + server-side inventory filtering (§03).
4. **Sandbox actions scattered across modes/pages (delete is a sidebar
   "mode")** — fix: actions live on the sandbox row (menu) and on a proper
   sandbox detail page; the create/destroy sidebar "modes" are removed (§05).
5. **Sandbox cards too big; >5 sandboxes overflow the page** — fix: compact
   table on desktop, dense cards on mobile (§05).
6. **Activity log squats at the top of the main page** — fix: dashboard
   becomes a fleet overview; recent activity is a compact side panel with a
   full `/activity` page (§05).
7. **Login page is password-first even though most users are IdP users** —
   fix: IdP button primary, operator password secondary/collapsible, optional
   TOTP for the operator (§07).

Plus: the whole UI moves to a shadcn/ui design system modelled on
`hhftechnology/crowdsec_manager` (the look the operator likes), retaining the
NVIDIA-green industrial identity, structured so an iPhone/Android app
(Capacitor, like crowdsec_manager's `mobile/`) can follow.

## Ground rules (non-negotiable)

These come from `CLAUDE.md` and hard-won regressions. Violating any of these
is a plan failure even if the UI looks perfect.

1. **Never touch the dashboard token chain.** Do not modify `server.mjs`,
   `app/api/openshell/dashboard/proxy/shared.ts`, or
   `app/api/openshell/dashboard/open/route.ts` logic. The launch-flow fix is
   purely client-side (it calls the same `/api/openshell/dashboard/open`
   endpoint the current button calls). CLAUDE.md §10 explains why.
2. **`npm test` before every commit.** Baseline: all PASS except
   `control-auth-cookie-check.mjs` and `sandbox-lifecycle-*` (2 known
   pre-existing failures as of 2026-07-04 — verify the exact baseline with
   `npm test` on a clean checkout BEFORE starting Phase 0 and record it).
   Any *new* failure is a regression you introduced.
3. **UI hiding is UX, not security.** Every capability the UI gates must
   already be (and remain) enforced server-side by `middleware.ts` and route
   handlers. This plan adds server-side enforcement FIRST (Phase 1), UI
   second.
4. **`npm run build` must pass before every commit.** Deploy is git-only
   (commit → push → pull on VPS). Never rsync.
5. **Work on a branch** (`ui-refresh` off `gatewaydashboard`), deploy the
   branch to the BYOVPS test bed for smoke testing per phase, and only merge
   to `gatewaydashboard` when the phase's acceptance criteria pass.
6. **Don't drop information.** Every piece of data the current UI shows has a
   named new home in §05. If you find a datum without a home, put it in the
   sandbox detail "Overview" tab and note it in the commit message.
7. **Middleware stays on the Node runtime** and the auth dispatch in
   `middleware.ts` keeps its current structure — you only ADD page-route
   gating (§03), never restructure the switch.
8. **Legacy CSS classes** (`panel`, `action-button`, `status-chip`,
   `field-control`, `metric`) must keep working until Phase 6 removes their
   last consumer — heavy panels are migrated progressively, not big-bang.
9. After the refresh lands on `gatewaydashboard`, update `CLAUDE.md` §5's
   conflict-pattern table (it references `SandboxList.tsx` internals that
   this refresh replaces) and refresh `docs/upstream-divergence-audit.md`.

## Test bed

BYOVPS: `ssh -i ~/.ssh/tf_internalvps2 root@192.168.3.201` (confirm IP with
the operator if unreachable — test-agency VPSes are reprovisioned often).
Controller install dir `/opt/openshell-controller`, systemd unit
`openshell-controller`, Node at `/root/.nvm/versions/node/v22.22.3/bin`.
Pangolin front door: `admin@mcpgateway.online` / `Password123q!`; controller
operator password: `Password123q!`. Deploy procedure: CLAUDE.md §2.

# 08 — Mobile readiness and the future iPhone/Android app

Two horizons. **Horizon 1 (this refresh, Phase 7):** the web UI is fully
usable on a phone. **Horizon 2 (separate future project):** a Capacitor app
in `mobile/`, modelled on `hhftechnology/crowdsec_manager/mobile`. This
refresh must not build Horizon 2, but every Horizon-1 decision below was
chosen so Horizon 2 needs no rework.

## 8.1 Horizon 1 — responsive rules (enforced across all §04/§05 work)

- Breakpoints: the shell switches at `lg` (sidebar ↔ bottom tabs); tables
  switch at `md` (table ↔ cards). No other breakpoints.
- Touch targets ≥ 44 px (`h-11` buttons on mobile contexts; icon buttons
  `h-10 w-10` minimum on `<md`).
- Safe areas: bottom tab bar `pb-[env(safe-area-inset-bottom)]`; the
  `viewport-fit=cover` meta is added in §4.2. Sticky TopBar gets
  `pt-[env(safe-area-inset-top)]` padding on `<lg`.
- No hover-only affordances: everything reachable by hover must also be
  reachable by tap (row menus are buttons, tooltips carry `aria-label`
  duplicates, table row actions exist in the detail page too).
- Dialogs on `<md` render full-width bottom-sheet style (shadcn dialog with
  `sm:max-w-lg` + `max-sm:items-end` positioning — use the `Sheet` component
  for the delete dialog on mobile? **No — keep one `AlertDialog`
  implementation**; center it on all sizes. One code path beats two.)
- The xterm pages (`/operator-terminal`) remain desktop-first; on `<md` show
  them as-is (xterm-fit handles sizing) — no special work this refresh.

## 8.2 PWA baseline (Phase 7, ~1 hour)

- `app/manifest.ts` (Next metadata route):

```ts
import type { MetadataRoute } from "next"

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "OpenShell Control",
    short_name: "OpenShell",
    description: "Sandbox fleet control for OpenShell",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  }
}
```

- Generate `public/icon-192.png` / `public/icon-512.png` from the green cube
  mark (render the existing sidebar SVG on `#0a0a0a`, green `#76B900`; any
  rasterization method is fine, e.g. a one-off node script with `sharp` NOT
  added to deps — generate locally, commit the PNGs).
- No service worker. Offline caching of a control plane is a foot-gun
  (stale sandbox state, cached auth responses). `display: standalone` +
  icons give "Add to Home Screen" a native feel; that is the whole goal.
- Verify `manifest` route is publicly fetchable: add `/manifest.webmanifest`
  to `PUBLIC_PATHS` in `middleware.ts` (it 302s to login otherwise —
  test with curl).

## 8.3 Architectural constraints Horizon 2 imposes on this refresh

These are the "make sure the UI has the structure to allow it" items:

1. **All data through JSON APIs.** Never embed data in server-rendered HTML
   that a component then scrapes. Every §05 page is a client component
   consuming `/api/*` — already satisfied by the plan; keep it that way.
2. **One fetch seam.** All new client I/O goes through `apiFetch`
   (§6.1). The Capacitor app will reuse the hooks by injecting a base URL +
   `Authorization` header into that single function. Do not scatter raw
   `fetch` in new code.
3. **Feature components take data via props/hooks, not routing context**,
   so `SandboxTable`, `StatusLed`, `DeleteSandboxDialog`,
   `SandboxPolicyRequests`, the query hooks, and `inventoryModel.ts` can be
   lifted into a shared package later. Keep them free of `next/navigation`
   imports where practical (pass `onNavigate` callbacks from pages… —
   **Decision:** don't over-abstract now; `next/navigation` inside pages is
   fine, keep it OUT of `app/components/sandbox/*` and `app/components/ui/*`
   except `Link` usage in table rows, which is acceptable to rewrite later).
4. **Cookie-auth tolerance:** the app will authenticate with the same
   cookie flow inside a Capacitor webview-backed HTTP layer (crowdsec's
   `CapacitorHttp: enabled` handles cookies natively) — no API changes
   needed now. TOTP (§7.3) also works unchanged.

## 8.4 Horizon 2 blueprint — the Capacitor app (future project, NOT phases 0–8)

Derived from a source-level read of `hhftechnology/crowdsec_manager/mobile`
(Capacitor 8). The operator is comfortable with Capacitor and likes that
app; copy its architecture deliberately. **Do not scaffold any of this during
the web refresh** — but every web-refresh decision above keeps this buildable
without rework.

### Stack (mirrors crowdsec exactly)

Separate `mobile/` directory in this repo: Vite + React 18 + TypeScript +
Tailwind (§02 tokens copied in), TanStack Query, react-router-dom (bare SPA,
no Next), Capacitor 8 with `@capacitor/{core,app,haptics,keyboard,
splash-screen,status-bar}`, `capacitor-secure-storage-plugin`,
`@xterm/xterm` + `@xterm/addon-fit`, lucide-react, vendored `ui/`
components. `CapacitorHttp: enabled` in `capacitor.config.ts` (native HTTP
layer → native cookie jar). Note: crowdsec's mobile app **duplicates**
components from their web app rather than sharing a package — accept the
same trade-off; the §05 components are small enough to port by hand, and
`inventoryModel.ts` / `apiFetch` / hook logic port nearly verbatim.

### Connection model (crowdsec's strongest idea — copy it)

A **connection profile** captured by an onboarding screen and stored via a
`secureStorage` wrapper (iOS Keychain / Android EncryptedSharedPreferences
native, localStorage on web builds — copy
`mobile/src/lib/secureStorage.ts` wholesale):

```ts
type ConnectionProfile = {
  mode: "direct" | "pangolin"
  baseUrl: string            // e.g. https://controller.mcpgateway.online
  pangolinToken: string      // Pangolin resource access token ("id.token")
  operatorPassword?: never   // NEVER stored; session cookie only
}
```

- `pangolin` mode sends `P-Access-Token-Id` / `P-Access-Token` headers on
  every request and appends the combined token as a `p_token` query param on
  WebSocket URLs (WS can't carry custom headers) — copy
  `parsePangolinAccessToken` and the header/param decoration from
  `mobile/src/lib/connection.ts` + `lib/api/client.ts`. This matches our
  production front door exactly (the controller sits behind Pangolin).
- `direct` mode = LAN/tailnet access, plain base URL.

### Auth to the controller

Reuse the existing cookie session — no new server auth mechanism:
1. App POSTs `/api/auth/login` `{ password }` (operator) or drives the IdP
   flow in a browser view; CapacitorHttp's native cookie jar stores
   `openshell_control_session` / `oauth_session` and replays them on every
   request and on webview navigations.
2. `/api/auth/me` (v2, §03) tells the app its role/capabilities — the app
   reuses the same `useAuth()` gating rules as the web UI.
3. TOTP (§7.3 if built) works unchanged — it's just another login field.

### ApiClient seam

Port crowdsec's `ApiClient` class shape (`mobile/src/lib/api/client.ts`):
base-URL injection, error normalization to `ApiError` (same class name/shape
as §6.1 — deliberate), `getWebSocketUrl(path)` flipping http(s)→ws(s) and
decorating Pangolin params. The web `apiFetch` and the mobile client expose
the same call signatures so the §6.3 query hooks copy across with only the
import changed.

### App shell & pages (match crowdsec patterns)

Onboarding (connection profile) → Login → lazy-loaded routes with skeleton
fallbacks + error boundary + `OfflineConnectionBanner` (their component;
ours keys off the §6.4 reconnecting state). Bottom nav, 4 tabs:
`Overview` (fleet stats + sandbox list), `Approvals` (the §5.8 queue as a
full page — on mobile the bell popover becomes a tab; approving agent
requests from a phone is the app's killer feature), `Activity`, `Settings`
(connection profile, theme, about). Sandbox tap → detail with the §5.3
Overview + capability-gated actions (terminal, open dashboard via in-app
browser tab, restart, delete). Terminal page: xterm over
`getWebSocketUrl("/api/openshell/terminal/…")`, porting
`useTerminalConnection` + `TerminalKeyBar` from Phase 4b (§12.3) — the
auto-reconnect/keepalive/key-bar/visualViewport work is done once on the
web and carries over; add `@capacitor/keyboard` `keyboardWillShow` height
handling on native. Haptics on approve/deny and
delete confirm (`@capacitor/haptics`, `ImpactStyle.Medium`).

### Spike list (do these FIRST, in order, before committing to the app)

1. **WS + cookies through Pangolin:** validate that the terminal WebSocket
   upgrade carries the session cookie from the native cookie jar through
   Pangolin to `server.mjs`, in both connection modes, on iOS and Android.
   If cookies don't reach the upgrade request, fall back to a scoped PAT:
   a `data/`-file-backed bearer token minted from the Security page,
   accepted ONLY by the terminal/live allocation route — design that as its
   own reviewed change; do not weaken `copyHeaders()` identity stripping.
2. **OpenClaw dashboard in-app:** `/launch/dashboard` inside an in-app
   browser tab (`@capacitor/browser`) — verify the CLAUDE.md §10 token
   cookie behaves in that webview; if not, the app deep-links to the system
   browser instead (acceptable).
3. **CSP/`X-Frame-Options`:** the app never iframes the controller, so DENY
   stays untouched.
4. Store packaging (icons/splash from the §8.2 assets,
   `capacitor-assets generate` like crowdsec's `build:native` script).

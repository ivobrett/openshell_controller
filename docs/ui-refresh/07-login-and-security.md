# 07 — Login page, security page, optional operator 2FA

## 7.1 Login page redesign (P7)

`/login` is the first thing anyone sees. New hierarchy: **IdP sign-in is
primary** (most users), operator password is a secondary, collapsed path.

Layout (replaces the body of `app/login/page.tsx`; keep ALL existing logic —
`next` param handling, hash-carry comment and behaviour at lines 39-44, the
`GET /api/auth/login` oauthLoginUrl discovery):

```
┌──────────────────────────────────────────────┐
│            [green cube product mark]         │
│              OpenShell Control               │
│      Sandbox fleet control for OpenShell     │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │  ▶ Sign in with company account        │  │   ← Button size lg, primary
│  └────────────────────────────────────────┘  │     (only when oauthLoginUrl)
│  ────────────── or ──────────────            │
│  ▸ Operator sign-in                          │   ← Collapsible trigger
│    ┌ Password [__________________]           │
│    │ (TOTP code [______] — only if enabled)  │
│    └ [Sign in as operator]  (secondary)      │
│                                              │
│  Forgot password?                            │
└──────────────────────────────────────────────┘
```

Decisions:
- While `oauthLoginUrl` is still loading (the discovery fetch), render a
  skeleton button, NOT the password form first — prevents the layout jumping
  and keeps IdP primary. If discovery returns no `oauthLoginUrl` (IdP not
  configured), the operator form renders expanded and primary instead, and
  the divider/collapsible disappear.
- The `Collapsible` default state: collapsed when IdP is configured,
  expanded otherwise. Password input keeps `type="password"`,
  `autoComplete="current-password"`, autofocus ONLY when expanded.
- Errors: `Alert variant="destructive"` under the form, message from the
  API as today.
- The stray "Security" link on the login page is removed (that page is
  useless pre-auth; middleware treats it as public today — ALSO remove
  `/setup-account` from `PUBLIC_PATHS`? **No** — leave `PUBLIC_PATHS`
  untouched; `/setup-account`'s own content already handles the
  unauthenticated case and first-run setup depends on it. Only the link is
  removed).
- New shared `AuthShell`: centered column `max-w-sm`, product mark 40 px,
  card `p-6`, footer `text-xs text-muted-foreground` with the controller
  host name. Reuse for `/forgot-password` (restyle only, logic untouched).

## 7.2 `/security` page (from `/setup-account`)

Move `app/setup-account/page.tsx` content to `app/(shell)/security/page.tsx`
(inside the shell — it's an authenticated admin surface now; today it
renders standalone). `app/setup-account/page.tsx` becomes:

```tsx
import { redirect } from "next/navigation"
export default function SetupAccountRedirect() { redirect("/security") }
```

**Exception — first-run setup:** the current page handles initial operator
password setup when `configured === false`, reachable pre-auth. Keep that
working: `/security` must render its password-setup card without the shell
chrome when `me.configured === false` (the shell nav would be noise and
inventory queries would 401). Implementation: the security page checks
`configured` from `useAuth()`; when false, render inside `AuthShell` instead
of the normal page body. Middleware note: `/security` is NOT in
`PUBLIC_PATHS`, so pre-auth users can't reach it — therefore ALSO keep the
original first-run form available at `/setup-account`... **Decision to avoid
ambiguity:** do NOT redirect when unconfigured. `/setup-account` page logic:

```tsx
// server component
import { redirect } from "next/navigation"
import { isAuthConfigured } from "@/app/lib/auth/context"
import FirstRunSetup from "./FirstRunSetup" // the existing page content, renamed client component

export default function SetupAccountPage() {
  if (isAuthConfigured()) redirect("/security")
  return <FirstRunSetup />
}
```

So: unconfigured → old first-run experience at `/setup-account` (public,
unchanged); configured → permanent home at `/security`.

Restyled `/security` sections (reuse existing fetch logic verbatim; swap
markup to Card/Input/Button):
1. **Operator password** card — current change-password form
   (`/api/auth/setup`, requires `currentPassword`). Operator-only; IdP users
   see a muted card: "Operator sign-in is managed by the operator."
2. **Sandbox access** card — the existing per-sandbox email grant editor
   backed by `/api/security/sandbox-access` (file store). Operator-only.
   Add a per-row sandbox `Select` populated from `useInventory()` names
   instead of free-text where the current UI uses free text (verify current
   editor behaviour before changing; if it already selects, keep it).
3. **Two-factor authentication** card — Phase 8, §7.3. Until then, omit.

## 7.3 Optional Phase 8 — TOTP for the operator account

Scoped to be genuinely small; skip the whole phase if time-boxed out — the
plan is complete without it.

- Dependency: `npm install otplib` (pure JS TOTP, no native deps).
- Storage: `data/operator-totp.json` → `{ "secret": "<base32>", "enabledAt":
  "<iso>" }`, file mode 0600, written atomically like
  `sandboxAccessStore.ts` (copy its tmp+rename pattern). No env var (env
  edits require restarts; files follow the store precedent). Absent file =
  2FA disabled.
- New module `app/lib/auth/totpStore.ts`: `getTotpSecret()`,
  `setTotpSecret(secret)`, `clearTotpSecret()`.
- `POST /api/auth/totp/setup` (operator session required): generates
  `authenticator.generateSecret()`, stores it with `"pending": true`, returns
  `otpauth://` URI + QR PNG data-URL (reuse the existing `qrcode` dependency
  exactly as `app/api/sandbox/[sandboxId]/openclaw-remote/qr/route.ts` does).
- `POST /api/auth/totp/confirm` body `{ code }`: verifies against pending
  secret, flips `pending` off → enabled. `POST /api/auth/totp/disable` body
  `{ code }` removes the file (requires a valid current code).
- `POST /api/auth/login` change (`app/api/auth/login/route.ts` — read it
  first): after password verification succeeds AND an enabled (non-pending)
  TOTP secret exists, require `totp` in the body:
  missing → `401 { error: "TOTP code required", totpRequired: true }`;
  invalid (use `authenticator.verify({ token, secret })` with default
  ±1 window) → `401 { error: "Invalid TOTP code" }`. Apply the SAME rate
  limiter the route already uses for passwords to TOTP attempts.
- Login page: on `totpRequired` response, reveal the 6-digit `Input`
  (`inputMode="numeric"`, `autoComplete="one-time-code"`, `maxLength={6}`)
  and resubmit with `totp`.
- `/security` 2FA card: status line (Enabled since… / Disabled), `Enable`
  button → dialog showing the QR + confirm-code input; `Disable` button →
  dialog requiring a current code.
- **Recovery path (must exist before enabling in prod):** document in the
  card and in `docs/runbooks/fresh-vps-setup.md` that deleting
  `data/operator-totp.json` on the VPS disables 2FA (operator has root —
  that IS the recovery mechanism; do not build backup codes).
- Tests: `tests/totp-login-check.mjs` — source assertions: login route
  references `totpRequired`, rate limiter applied, `authenticator.verify`
  called; totpStore uses tmp+rename atomic write and 0o600.

## 7.4 What does NOT change

- OAuth callback flow, cookie names (`oauth_session`, legacy
  `CF_Authorization` reader), JWT minting, logout clearing both cookies.
- `/api/auth/recover` and forgot-password logic.
- `getOAuthSecret` fail-closed behaviour (CLAUDE.md §6 don'ts).
- Session TTLs.

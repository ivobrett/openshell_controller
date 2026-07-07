# 13 — Agent capabilities (memory, inter-sandbox chat) & the skills library (v4)

Two operator-driven additions. First: the controller ships two **baseline
MCP servers** that define what an agent fleet can do — `memory` (persistent
knowledge graph) and `inter-sandbox-chat` (roomed message board between
sandboxes, with operator-ack semantics) — see
`app/lib/mcpServerStore.ts:58-77` and `BASELINE_MCP_SERVER_IDS`. The v1–v3
design under-served them; worse, the SandboxTable spec dropped the old UI's
per-sandbox MCP badge (a ground-rule-6 violation caught here). Second: a
read-only **skills library** for the operator's setup prompts (voice,
Telegram, Slack, inter-sandbox MCP bring-up, …) served straight from the
repo.

## 13.1 Capability chips — make memory + chat visible everywhere

Data already exists client-side: `useMcpServers()` (§6.3) +
`sandboxCanAccessMcpServer(sandbox, server)` (ported from
`SandboxList.tsx:472-476`). No new APIs.

New component `app/components/sandbox/CapabilityChips.tsx`:

```
[ MEM ] [ CHAT ] [ +2 ]        ← mono 9px chips, h-5
```

- `MEM` lit (green border/text, like a LED) when the `memory` server is
  allowed for this sandbox, dim (`opacity-50 text-muted-foreground`) when
  not. Same for `CHAT` ↔ `inter-sandbox-chat`. Baseline ids are hardcoded
  (`"memory"`, `"inter-sandbox-chat"`) — they're stable repo constants.
- `+n` chip when the sandbox has access to n other MCP servers; tooltip
  lists their names. Whole group `title`/tooltip: "MCP capabilities —
  manage in the MCP tab"; clicking navigates to
  `/sandboxes/<name>?tab=mcp` (wrap in a Link where the context is
  operator; render non-interactive for `role === "user"`).

Placements (amends §5.2 / §5.3):

1. **SandboxTable**: new `Capabilities` column between Agent and Alerts
   (140 px, `hidden lg:table-cell` — on smaller widths the detail page
   carries it). Mobile cards: chips join row 2.
2. **Detail Overview tab**: an "Agent capabilities" card listing every
   allowed MCP server (name + summary line), with — for operators — inline
   `Enable` buttons for `memory` and `inter-sandbox-chat` when they're NOT
   yet allowed (reuses `enableMcpForSandbox` + `syncMcpManifest` from
   `app/components/sandbox/SandboxMcpAccess.tsx`; toast on completion
   reminds "Config issued — the agent sees new servers on its next MCP
   session"). Footer link `Manage MCP access →` (`?tab=mcp`). For
   `role === "user"`: read-only list, no buttons. This puts "give this
   agent memory / let it talk to other sandboxes" one click from the
   primary surface instead of three.
3. **MCP tab** (`SandboxMcpAccess`) and the **`/mcp` page** (Phase 6
   restyle of `McpConfigurationPanel`): render baseline servers first under
   a `Core capabilities` group header, other servers under `Installed
   servers`. Use each server's existing `summary` string verbatim — do not
   write new capability descriptions.

## 13.2 Skills library — repo-backed setup prompts

### Problem being solved

Setting up an OpenClaw/Hermes instance (voice, Telegram, Slack,
inter-sandbox MCP, …) requires long prompt recipes the operator currently
keeps outside the product and pastes into the agent by hand. Requirement:
store them in this repo, browse/copy them in the UI. **Read-only** — no
editing UI; skills are added/changed via git like any other code.

### Storage format

New top-level directory `skills/` (repo root, committed). One markdown file
per skill:

```markdown
---
name: Telegram bridge setup
description: Connect an OpenClaw agent to a Telegram bot for chat control.
tags: telegram, messaging
agents: openclaw
---

(the prompt body — everything below the second `---` is what gets copied)
```

- Filename = id, must match `/^[a-z0-9][a-z0-9._-]{0,80}\.md$/`
  (e.g. `telegram-setup.md`).
- Frontmatter keys: `name` (required), `description` (required), `tags`
  (optional CSV), `agents` (optional: `openclaw` | `hermes` | `any`,
  default `any`). Parse with a ~20-line hand parser in the route (split on
  `---` fences, `key: value` lines) — do NOT add a YAML dependency.
- **No secrets, ever.** Files are served to every authenticated user and
  live in a GitHub repo. Recipes must use placeholders
  (`<TELEGRAM_BOT_TOKEN>`). Enforced by a test (below) and stated in
  `skills/README.md`.
- Seed the directory in Phase 4c with: `skills/README.md` (format rules +
  the no-secrets rule) and `skills/skill-template.md` (the frontmatter
  skeleton above with a placeholder body). The operator commits their real
  skills (voice, Telegram, Slack, inter-sandbox bring-up) themselves —
  do not invent recipe content for them.

### API (Phase 4c)

`app/api/skills/route.ts` — `GET` only:

```ts
// Lists skills fresh from disk on every call (same pattern as
// sandboxAccessStore): readdir SKILLS_DIR, parse frontmatter, return
// { ok: true, skills: [{ id, name, description, tags, agents, updatedAt }] }
// sorted by name. SKILLS_DIR = path.join(process.cwd(), "skills").
// Skip README.md and files failing the id regex or missing name/description.
```

`app/api/skills/[skillId]/route.ts` — `GET` only:

```ts
// Sanitize: skillId must match the id regex above (reject otherwise, 400).
// Resolve p = path.join(SKILLS_DIR, skillId) and additionally assert
// path.resolve(p).startsWith(path.resolve(SKILLS_DIR) + path.sep)  // traversal guard
// 404 if missing. Return { ok: true, skill: { ...meta, content } } where
// content is the body BELOW the frontmatter (what the user pastes).
```

No POST/PUT/DELETE handlers exist — the absence is load-bearing (read-only
by construction; middleware would block OAuth writes anyway, but don't
create operator-writable handlers either).

Auth: nothing special — middleware already requires a session for `/api/*`;
GETs are allowed for both roles. Add capability `viewSkills: true` to BOTH
`OPERATOR_CAPS` and `OAUTH_CAPS` in §3.1 (IdP users setting up an agent
inside their own sandbox is a supported use).

### UI (Phase 4c)

1. **`/skills` page** (`app/(shell)/skills/page.tsx`), nav item
   `{ href: "/skills", label: "Skills", icon: BookOpen }` — no `cap`
   (visible to all authed), placed between Activity and Inference in
   `NAV_ITEMS`. Page: PageHeader title `Skills`, description `Reusable
   setup prompts for configuring agents. Copy one and paste it into the
   agent's prompt.` Search input (name/description/tags). Card grid
   (`md:grid-cols-2 xl:grid-cols-3`): name, description
   (2-line clamp), tag `Badge`s + agent badge (hidden when `any`), footer
   buttons `Copy` and `View`.
   - `Copy`: fetch the detail route, `navigator.clipboard.writeText(content)`,
     toast `Copied "<name>"`. Button flips to a check for 1.8 s (same
     pattern as today's CopyLinkButton).
   - `View`: `Dialog` (max-w-2xl) with the content in a mono, scrollable,
     `whitespace-pre-wrap` block + a Copy button in the footer.
   - Empty state: `BookOpen` icon, "No skills yet", sub-line "Add markdown
     files to the repo's skills/ directory — see skills/README.md."
2. **Terminal quick access** — where skills actually get pasted. The
   `/operator-terminal` header (Phase 4b layout) gains a `Skills` button
   (`BookOpen` icon) opening a `Sheet` (right side desktop, bottom on
   mobile) with a compact searchable list: name + description + Copy
   button per row. Component `app/components/skills/SkillsQuickList.tsx`
   shared between the page dialog-list and this sheet. After copy, the
   sheet stays open (operators often paste several skills in one session).
3. **Sandbox detail** — the Overview "Agent capabilities" card (§13.1.2)
   gets a footer link `Setup skills →` → `/skills`. No heavier integration;
   the terminal is the paste target, and it has the sheet.

### Tests (§10 additions)

| Test | Asserts |
|---|---|
| `tests/skills-route-check.mjs` | behavioural where possible: the detail route source contains the traversal guard (`startsWith` on resolved SKILLS_DIR) and the id regex; neither skills route file exports POST/PUT/DELETE; list route skips files without name/description (feed a fixture dir via a temp SKILLS_DIR env override if the implementation reads `process.env.SKILLS_DIR ?? cwd/skills` — implement that override for testability) |
| `tests/skills-no-secrets-check.mjs` | greps every `skills/*.md` for secret-shaped strings: `/sk-[A-Za-z0-9]{20}/`, `/ghp_[A-Za-z0-9]{20}/`, `/xox[bap]-/`, `/AKIA[0-9A-Z]{16}/`, `/BEGIN (RSA |OPENSSH )?PRIVATE KEY/`, `/[0-9]{8,10}:[A-Za-z0-9_-]{35}/` (Telegram bot token shape). Fails listing file + pattern. This is a tripwire, not a guarantee — the README rule is the real control |

Manual matrix (§10.2): M30 `/skills` lists the seeded template, Copy puts
the body (not the frontmatter) on the clipboard, View renders it; M31
terminal Skills sheet: open, search, copy, paste into the shell — content
intact incl. newlines; M32 as IdP user: `/skills` accessible, capability
chips visible read-only on their sandbox, no Enable buttons.

## 13.3 Phase placement

New **Phase 4c — Skills library + capability prominence** (after 4b, before
5): creates `skills/` seed files, both API routes, `/skills` page +
nav item, `SkillsQuickList` + terminal sheet, `CapabilityChips` + table
column + Overview "Agent capabilities" card, plus the two tests. The §13.1.3
MCP-page grouping lands with Phase 6 (it's part of the
`McpConfigurationPanel`/`SandboxMcpAccess` restyle). §09 has the phase
block; §03/§04/§05 carry the point amendments.

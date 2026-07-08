# Skills

Skills are read-only setup prompts stored as Markdown files in this directory.
They are served to all authenticated users through the UI's Skills page and the
terminal's Skills sheet.

## File format

Each skill is a Markdown file with a YAML frontmatter block:

```markdown
---
name: Skill name (required)
description: One-line description shown in the skills library. (required)
tags: comma, separated, tags (optional)
agents: openclaw | hermes | any (optional, default: any)
---

(Prompt body — everything below the second `---` is what gets copied.)
```

Filename must match `/^[a-z0-9][a-z0-9._-]{0,80}\.md$/`
(e.g. `telegram-setup.md`). Files not matching this pattern, or missing a
`name`/`description`, are silently skipped by the API.

## ⚠️ No secrets

Skills files are served to **every authenticated user** and live in a public
GitHub repository. Never include API keys, tokens, passwords, or credentials of
any kind. Use placeholders instead:

- API key: `<YOUR_API_KEY>`
- Telegram token: `<TELEGRAM_BOT_TOKEN>`
- Webhook URL: `<YOUR_WEBHOOK_URL>`
- OAuth client: `<OAUTH_CLIENT_ID>` / `<OAUTH_CLIENT_SECRET>`

A CI test (`tests/skills-no-secrets-check.mjs`) rejects files containing
known secret shapes (OpenAI keys, GitHub tokens, AWS access key IDs,
Telegram bot tokens, PEM private keys, Slack tokens).

## Adding a skill

1. Create a `.md` file in this directory following the format above.
2. Commit and push. The skills page reloads from disk on every request.
3. No restart or rebuild needed.

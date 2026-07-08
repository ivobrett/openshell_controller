import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const skillsDir = path.join(root, 'skills')

// Known secret shapes — tripwire patterns
const SECRET_PATTERNS = [
  { pattern: /sk-[A-Za-z0-9]{20}/, label: 'OpenAI API key (sk-...)' },
  { pattern: /ghp_[A-Za-z0-9]{20}/, label: 'GitHub personal access token (ghp_...)' },
  { pattern: /xox[bap]-[A-Za-z0-9-]+/, label: 'Slack token (xox...)' },
  { pattern: /AKIA[0-9A-Z]{16}/, label: 'AWS access key ID (AKIA...)' },
  { pattern: /-----BEGIN (RSA |OPENSSH )?PRIVATE KEY-----/, label: 'PEM private key' },
  { pattern: /[0-9]{8,10}:[A-Za-z0-9_-]{35}/, label: 'Telegram bot token' },
]

let files
try {
  files = await readdir(skillsDir)
} catch {
  // No skills directory — pass vacuously
  console.log('skills-no-secrets-check: PASS (no skills/ directory)')
  process.exit(0)
}

const mdFiles = files.filter((f) => f.endsWith('.md'))
const failures = []

for (const filename of mdFiles) {
  const filepath = path.join(skillsDir, filename)
  const content = await readFile(filepath, 'utf8')
  for (const { pattern, label } of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      failures.push(`  ${filename}: matches "${label}"`)
    }
  }
}

assert.equal(
  failures.length,
  0,
  `skills/ files contain secret-shaped strings — review and replace with placeholders:\n${failures.join('\n')}`,
)

console.log(`skills-no-secrets-check: PASS (scanned ${mdFiles.length} file(s), 0 secret patterns found)`)

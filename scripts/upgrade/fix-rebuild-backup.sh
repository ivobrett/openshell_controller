#!/usr/bin/env bash
# Make a NemoClaw rebuild backup acceptable to a NEWER NemoClaw. The backup
# carries the old sandbox's live policy and MCP list verbatim, and the new CLI
# rejects parts of them only AFTER it has deleted the old sandbox:
#
#   "live network policy 'telegram' does not match the enabled channel requirement"
#       -> --drop-policy telegram      (stock preset from the old version; the
#                                       recreate re-adds the current one)
#   "does not satisfy the shipped sandbox policy schema (pattern: must match ^/)"
#       -> --drop-invalid-binaries     (approved rules with a binary path of "-")
#   "MCP server 'openshell-control' has no complete authenticated credential binding"
#       -> --drop-mcp openshell-control  (the controller's own broker entry; its
#                                         MCP sync re-issues it after the recreate)
#   "Cannot rebuild an absent sandbox without its authoritative OpenShell policy"
#   "retained rebuild MCP recovery observation is unavailable"
#   "Rebuild recovery backup already belongs to another transaction"
#       -> --restore-handoff           (a failed attempt strips the handoffs and
#                                       leaves a journal; put the saved ones back)
#
# The first run saves pristine copies to <backup-dir>/.handoff-orig/, which is
# what --restore-handoff restores from. Custom allow_* rules are always kept.
#
#   fix-rebuild-backup.sh <backup-dir> [--drop-policy KEY]... [--drop-invalid-binaries]
#                         [--drop-mcp NAME]... [--restore-handoff]
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/env.sh"
[ $# -ge 1 ] || { sed -n '2,26p' "$0"; exit 1; }
DIR="$(readlink -f "$1")"; shift
[ -f "$DIR/rebuild-manifest.json" ] || { echo "$DIR is not a NemoClaw rebuild backup" >&2; exit 1; }
ORIG="$DIR/.handoff-orig"
if [ ! -d "$ORIG" ]; then
  mkdir -m 700 "$ORIG"
  cp -a "$DIR/rebuild-manifest.json" "$ORIG/"
  cp -a "$DIR"/rebuild-policy-handoff.*.yaml "$ORIG/" 2>/dev/null || true
  [ -f "$DIR/openclaw.json" ] && cp -a "$DIR/openclaw.json" "$ORIG/"
fi
# `yaml` resolves from the installed NemoClaw checkout.
cd /opt/nemoclaw-src
node - "$DIR" "$ORIG" "$@" <<'JS'
const YAML = require("yaml"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const [dir, orig, ...args] = process.argv.slice(2);
const dropPolicy = [], dropMcp = []; let dropBinaries = false, restore = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--drop-policy") dropPolicy.push(args[++i]);
  else if (args[i] === "--drop-mcp") dropMcp.push(args[++i]);
  else if (args[i] === "--drop-invalid-binaries") dropBinaries = true;
  else if (args[i] === "--restore-handoff") restore = true;
  else { console.error("unknown option " + args[i]); process.exit(1); }
}
const manifestPath = path.join(dir, "rebuild-manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const originalManifest = JSON.parse(fs.readFileSync(path.join(orig, "rebuild-manifest.json"), "utf8"));
if (restore) {
  const journal = path.join(dir, ".nemoclaw-rebuild-recovery.json");
  if (fs.existsSync(journal)) { fs.renameSync(journal, path.join(orig, `journal-${Date.now()}.json`)); console.log("moved stale recovery journal aside"); }
  if (!manifest.rebuildPolicyHandoff && originalManifest.rebuildPolicyHandoff) {
    const file = originalManifest.rebuildPolicyHandoff.file;
    fs.copyFileSync(path.join(orig, file), path.join(dir, file));
    manifest.rebuildPolicyHandoff = originalManifest.rebuildPolicyHandoff;
    console.log("restored policy handoff");
  }
  if (!manifest.rebuildMcpHandoff) {
    manifest.rebuildMcpHandoff = originalManifest.rebuildMcpHandoff ?? { entries: [], runtimeSelection: { gatewayName: process.env.OPENSHELL_GATEWAY || "nemoclaw", workspace: "default" } };
    console.log("restored MCP handoff");
  }
}
if (manifest.rebuildPolicyHandoff && (dropPolicy.length || dropBinaries)) {
  const old = path.join(dir, manifest.rebuildPolicyHandoff.file);
  const policy = YAML.parse(fs.readFileSync(old, "utf8"));
  const net = policy.network_policies || {};
  for (const key of dropPolicy) if (key in net) { delete net[key]; console.log(`dropped policy '${key}'`); }
  if (dropBinaries) for (const [key, rule] of Object.entries(net)) {
    if (!Array.isArray(rule.binaries)) continue;
    const keep = rule.binaries.filter((b) => typeof b?.path === "string" && b.path.startsWith("/"));
    if (keep.length !== rule.binaries.length) { console.log(`dropped ${rule.binaries.length - keep.length} invalid binary entr(ies) from '${key}'`); rule.binaries = keep; }
  }
  const out = YAML.stringify(policy);
  const sha = crypto.createHash("sha256").update(out).digest("hex");
  const file = `rebuild-policy-handoff.${sha}.yaml`;
  fs.writeFileSync(path.join(dir, file), out, { mode: 0o600 });
  if (path.join(dir, file) !== old) fs.unlinkSync(old);
  manifest.rebuildPolicyHandoff = { ...manifest.rebuildPolicyHandoff, file, sha256: sha };
}
if (dropMcp.length) {
  if (manifest.rebuildMcpHandoff?.entries) manifest.rebuildMcpHandoff.entries = manifest.rebuildMcpHandoff.entries.filter((e) => !dropMcp.includes(e.server));
  const cfgPath = path.join(dir, "openclaw.json");
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    for (const name of dropMcp) if (cfg.mcp?.servers?.[name]) { delete cfg.mcp.servers[name]; console.log(`dropped MCP server '${name}' from the backed-up openclaw.json`); }
    if (cfg.mcp?.servers && Object.keys(cfg.mcp.servers).length === 0) delete cfg.mcp.servers;
    if (cfg.mcp && Object.keys(cfg.mcp).length === 0) delete cfg.mcp;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  }
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
console.log("handoffs now:", Object.keys(manifest).filter((k) => /andoff/.test(k)).join(", ") || "none");
JS

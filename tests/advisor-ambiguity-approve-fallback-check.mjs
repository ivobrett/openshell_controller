// Guards for the ADVISOR-vs-PRESET AMBIGUITY FALLBACK in
// app/lib/sandboxPermissions.ts.
//
// THE REGRESSION THIS FIXES
//
// Granting an outstanding policy request from the dashboard runs
// `openshell rule approve --chunk-id <id> <sandbox>`. From OpenShell 0.0.101
// onward that call is validated by find_endpoint_ambiguities()
// (crates/openshell-policy/src/ambiguity.rs — a file that does NOT exist in
// 0.0.85). It rejects any two endpoints overlapping on host:port whose `tls`,
// `allowed_ips` or `advisor_proposed` differ, and it never consults
// `binaries`, which is the field that actually distinguishes them.
//
// Approving an advisor chunk stamps advisor_proposed=true. Curated presets
// carry advisor_proposed=false. `brew` alone covers github.com, ghcr.io,
// raw.githubusercontent.com, objects.githubusercontent.com and
// pkg-containers.githubusercontent.com — so any advisor proposal for one of
// those from a non-brew binary is UNAPPROVABLE, and the UI button fails with
// "network endpoint ambiguity validation failed".
//
// This regressed when OpenShell moved 0.0.85 -> 0.0.101, which arrived with
// the NemoClaw v0.0.96 -> v0.0.108 bump on 2026-08-14. It is NOT a controller
// bug: app/api/sandbox/[sandboxId]/permissions/route.ts has one commit in its
// entire history. Reported live on my-hermes 2026-08-23 (chunk c4da69a5,
// /usr/bin/python3.13 -> github.com:443).
//
// THE FIX: the conflict only fires when the two values DIFFER, so re-authoring
// the identical grant via `openshell policy update` (which defaults
// advisor_proposed to false, matching the preset) passes validation and yields
// the same authorization. Verified live: python3.13 got github.com:443 (200)
// while formulae.brew.sh stayed blocked, so the fallback does not inherit the
// preset's other endpoints.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SRC = readFileSync(path.join(ROOT, "app/lib/sandboxPermissions.ts"), "utf8")

// --- the fallback exists and is reached from the approve path ---------------
assert.match(
  SRC,
  /isAdvisorAmbiguityFailure/,
  "sandboxPermissions must detect the advisor-vs-preset ambiguity failure; without it the " +
    "dashboard grant button is dead for any host already covered by a preset",
)
assert.match(
  SRC,
  /"policy",\s*"update"/,
  "the fallback must re-author the grant via `openshell policy update` — that is what defaults " +
    "advisor_proposed to false and therefore passes find_endpoint_ambiguities()",
)

// --- THE NARROWING GUARD ----------------------------------------------------
// Only the advisor_proposed collision may be worked around. A genuine tls or
// allowed_ips disagreement must still fail loudly: silently re-authoring it
// would resolve a real policy conflict in an arbitrary direction.
const detector = SRC.slice(SRC.indexOf("function isAdvisorAmbiguityFailure"))
assert.match(
  detector,
  /advisor_proposed/,
  "the fallback MUST be gated on advisor_proposed specifically. Widening it to every ambiguity " +
    "would silently paper over real tls/allowed_ips policy conflicts.",
)
assert.match(
  detector,
  /endpoint ambiguity validation failed/i,
  "the detector must also match the ambiguity error itself, not advisor_proposed alone",
)

// Non-approve actions must never take this path.
assert.match(
  SRC,
  /command !== "approve"[\s\S]{0,80}throw error/,
  "reject must never be routed through the fallback — only approve",
)

// --- injection safety -------------------------------------------------------
// endpoints and binaries come from parsed CLI output and are spliced into an
// argv for a privileged host command. execFile avoids a shell, but these must
// still be shape-checked so a malformed rule cannot inject extra flags.
assert.match(
  SRC,
  /\^\[A-Za-z0-9\.\*_-\]\+:/,
  "endpoint selectors must be validated against a host:port shape before being passed to " +
    "`policy update`",
)
assert.match(
  SRC,
  /test\(entry\)/,
  "binary paths must be shape-checked before being passed to `policy update`",
)

// --- it must not fabricate a grant -----------------------------------------
// If the chunk cannot be found, or has no usable endpoints/binaries, we must
// rethrow rather than invent a policy change.
assert.match(
  SRC,
  /if \(!chunk \|\| endpoints\.length === 0 \|\| binaries\.length === 0\) throw error/,
  "the fallback must rethrow when the chunk's endpoints/binaries cannot be recovered — it must " +
    "never guess at what to grant",
)

// --- the chunk is cleared so the queue reflects reality ---------------------
assert.match(
  SRC,
  /"rule",\s*"reject",\s*"--chunk-id"/,
  "after applying the grant the chunk must be cleared, or it stays pending forever and the user " +
    "cannot tell the request was satisfied",
)

console.log("PASS: advisor-vs-preset ambiguity approve fallback guards")

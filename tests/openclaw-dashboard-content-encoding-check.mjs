import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'

// Guards the fix for the 2026-09-19 blank-dashboard regression that appeared
// with OpenClaw 2026.7.1 -> 2026.9.1 (NemoClaw main@e38726c8d7).
//
// SYMPTOM: "Open Dashboard" renders a completely blank page. There is NO
// console error, NO failed asset request, and the document itself returns
// HTTP 200. DevTools shows the real cause only on the document request:
//
//   Status: 200
//   content-encoding: gzip
//   Request failed with net::ERR_CONTENT_DECODING_FAILED
//
// and the network log contains exactly ONE request — the document — because
// the browser never finishes decoding it, so it never parses the <script>
// tags and never fetches a single /assets/* chunk.
//
// CAUSE: undici (Node's fetch, backing the upstream call in this module)
// transparently decompresses the upstream response body. The bytes we re-emit
// are therefore plain. copyResponseHeaders used to forward every upstream
// header except the hop-by-hop set — which strips `content-length` but NOT
// `content-encoding`. So we re-emitted plain bytes still labelled
// `content-encoding: gzip`, and the browser tried to gunzip plaintext.
//
// The OpenClaw 2026.9.1 gateway compresses responses even though this proxy
// strips accept-encoding from the upstream request, which is why this only
// appeared after the bump.
//
// WHY THIS WAS EASY TO MISDIAGNOSE (do not repeat it): plain `curl` does NOT
// auto-decode, so curling the proxy returns perfectly readable HTML with all
// the asset paths present, and every asset 200s when fetched individually.
// The whole chain looks healthy from the shell. Reproducing it requires a real
// browser or `curl --compressed`. Time was lost chasing the §10 token chain
// and a 403 attribution red herring before DevTools showed the decode failure.

const root = process.cwd()
const sharedPath = path.join(root, 'app/api/openshell/dashboard/proxy/shared.ts')
const sharedSource = await readFile(sharedPath, 'utf8')

assert.match(
  sharedSource,
  /const RESPONSE_ONLY_STRIPPED_HEADERS = new Set\(\['content-encoding'\]\)/,
  "the dashboard proxy must declare content-encoding as a response-only stripped header — forwarding it after undici decoded the body yields a 200 that the browser cannot decode, and a blank dashboard",
)

assert.match(
  sharedSource,
  /function copyResponseHeaders\(upstream: Response\)[\s\S]*?!RESPONSE_ONLY_STRIPPED_HEADERS\.has\(lowerKey\)/,
  'copyResponseHeaders must actually apply RESPONSE_ONLY_STRIPPED_HEADERS when copying upstream response headers',
)

// content-encoding must NOT be added to the shared hop-by-hop set: that set is
// also applied to REQUEST headers by copyRequestHeaders, where content-encoding
// legitimately describes an encoded request body.
const hopByHopBlock = sharedSource.slice(
  sharedSource.indexOf('const HOP_BY_HOP_HEADERS'),
  sharedSource.indexOf('])', sharedSource.indexOf('const HOP_BY_HOP_HEADERS')),
)
assert.doesNotMatch(
  hopByHopBlock,
  /content-encoding/,
  'content-encoding must be stripped response-side only, never added to HOP_BY_HOP_HEADERS, because that set also filters request headers',
)

// content-length must stay stripped: the decoded body length differs from the
// upstream's compressed length, so forwarding it truncates or stalls the body.
assert.match(
  hopByHopBlock,
  /'content-length'/,
  'content-length must remain stripped — the re-emitted body length differs from the upstream compressed length',
)

console.log('openclaw-dashboard-content-encoding-check: OK')

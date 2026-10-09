#!/bin/sh
# Saves a Claude setup token where Hermes reads it (/sandbox/.claude/.credentials.json).
# Runs INSIDE the Hermes sandbox; the token is never echoed. Install + usage:
# docs/runbooks/claude-subscription-inference.md (Hermes section).
umask 077
mkdir -p /sandbox/.claude
printf 'Paste token, then Enter: '
stty -echo 2>/dev/null; IFS= read -r T; stty echo 2>/dev/null; echo
T=$(printf %s "$T" | tr -d '[:space:]')
case "$T" in
  sk-ant-oat*) ;;
  *) echo "Not saved: that does not look like a setup token (expected sk-ant-oat...)."; exit 1 ;;
esac
printf '{"claudeAiOauth":{"accessToken":"%s"}}' "$T" > /sandbox/.claude/.credentials.json.tmp \
  && mv /sandbox/.claude/.credentials.json.tmp /sandbox/.claude/.credentials.json
unset T
echo "Saved ($(wc -c < /sandbox/.claude/.credentials.json) bytes)."

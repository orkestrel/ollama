#!/bin/bash
# ============================================================================
# scripts/start-ollama.sh — SessionStart hook
# ----------------------------------------------------------------------------
# WHERE THIS GOES: commit it to your repo at scripts/start-ollama.sh and make it
# executable: chmod +x scripts/start-ollama.sh
# It is wired up by .claude/settings.json (SessionStart hook).
#
# WHY IT EXISTS: the cloud environment cache snapshots FILES, not running
# processes. The Ollama binary and your pulled model are already on disk from
# the setup script, but the `ollama serve` daemon must be (re)started at the
# start of every session. This script does exactly that.
# ============================================================================

# Run only in cloud sessions. Locally you manage your own Ollama, so skip.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Match the locations used by the setup script / environment variables.
export OLLAMA_MODELS="${OLLAMA_MODELS:-/opt/ollama/models}"
export OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1:11434}"

# Your Copilot workflow set OLLAMA_ORIGINS="*" so browser page contexts could
# call the API cross-origin. That was mainly a Playwright concern, so it is off
# here. Uncomment if anything still hits Ollama from a browser:
# export OLLAMA_ORIGINS="*"

# Already running (e.g. on a resumed session)? Nothing to do.
if curl -sf "http://${OLLAMA_HOST}/api/tags" >/dev/null 2>&1; then
  exit 0
fi

# Start the server in the background. The model is already cached on disk,
# so no re-download happens here.
nohup ollama serve >/tmp/ollama.log 2>&1 &

# Wait until the API answers (up to 30s).
for i in $(seq 1 30); do
  if curl -sf "http://${OLLAMA_HOST}/api/tags" >/dev/null 2>&1; then
    echo "Ollama ready on ${OLLAMA_HOST}"
    exit 0
  fi
  sleep 1
done

# Don't fail the session if the daemon is slow; Claude can retry mid-session.
echo "Warning: Ollama did not report ready within 30s (see /tmp/ollama.log)" >&2
exit 0

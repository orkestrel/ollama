#!/bin/bash
# ============================================================================
# scripts/start-ollama.sh  —  SessionStart hook
# ----------------------------------------------------------------------------
# WHERE THIS GOES: commit to your repo at scripts/start-ollama.sh, then
#   chmod +x scripts/start-ollama.sh
# Wired up by .claude/settings.json (SessionStart hook).
#
# WHAT IT DOES, and why each half is here rather than in the setup script:
#   1. Starts `ollama serve`  -- the environment cache snapshots FILES, not
#      running processes, so the daemon must be restarted every session.
#   2. Installs project deps  -- the setup script does not run inside your repo
#      checkout, so `npm ci` there has no package.json/package-lock.json to
#      read. $CLAUDE_PROJECT_DIR here always points at the real checkout.
#
# No `set -e`: a dependency hiccup should not stop Ollama from coming up.
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

# --- 1. Kick Ollama off first, so it boots while npm is installing ----------
if ! curl -sf "http://${OLLAMA_HOST}/api/tags" >/dev/null 2>&1; then
  nohup ollama serve >/tmp/ollama.log 2>&1 &
fi

# --- 2. Project dependencies -----------------------------------------------
cd "$CLAUDE_PROJECT_DIR" || exit 0
# Skip when deps are already present (e.g. a resumed session) to cut latency.
if [ -f package.json ] && [ ! -d node_modules ]; then
  if [ -f package-lock.json ]; then
    npm ci
  else
    echo "ollama.sh: no package-lock.json found — falling back to npm install." >&2
    echo "Commit your lockfile to get reproducible installs (and real 'npm ci')." >&2
    npm install
  fi
fi

# --- 3. Confirm Ollama actually came up ------------------------------------
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

#!/bin/bash
# ============================================================================
# scripts/cursor.sh — SessionStart hook: Cursor bench ONLY
# ----------------------------------------------------------------------------
# The Cursor CLI has no daemon to launch: `agent` is invoked on demand by the
# composer/grok dispatchers. This hook SENSES the bench at session start —
# binary present? auth good? model pins set and real? — and announces the
# result. SessionStart stdout is injected into Claude's context, so these few
# lines are exactly how the orchestrator knows whether the external bench is
# lit or dark in this environment (CLAUDE.md: bench first, triad as fallback).
# NEVER prints CURSOR_API_KEY. Always exits 0 — problems are announcements,
# not session blockers.
# ============================================================================

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

if ! command -v agent >/dev/null 2>&1; then
  echo "cursor.sh: bench dark — Cursor CLI not installed in this environment; route external-bench units to their Claude counterparts."
  exit 0
fi

auth="auth ok"
if ! agent status >/tmp/cursor-status.log 2>&1; then
  auth="AUTH FAILED (check CURSOR_API_KEY in the environment settings — do not print it; see /tmp/cursor-status.log)"
fi

pins="pins ok (composer=${CURSOR_COMPOSER_MODEL:-}, grok=${CURSOR_GROK_MODEL:-})"
if [ -z "${CURSOR_COMPOSER_MODEL:-}" ] || [ -z "${CURSOR_GROK_MODEL:-}" ]; then
  pins="PINS MISSING — run \`agent models\` and record CURSOR_COMPOSER_MODEL / CURSOR_GROK_MODEL in the environment variables"
elif agent models >/tmp/cursor-models.log 2>&1; then
  for id in "$CURSOR_COMPOSER_MODEL" "$CURSOR_GROK_MODEL"; do
    if ! grep -qF "$id" /tmp/cursor-models.log; then
      pins="PIN NOT FOUND on this account: ${id} — re-run \`agent models\` and update the environment variable"
      break
    fi
  done
fi

echo "cursor.sh: bench lit — $(agent --version 2>/dev/null | head -n 1); ${auth}; ${pins}."
exit 0

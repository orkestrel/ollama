#!/usr/bin/env bash
set -euo pipefail

host="${OLLAMA_HOST:-http://127.0.0.1:11434}"
model="${OLLAMA_MODEL:-qwen3.5:2b-q4_K_M}"
log="tmp/ollama-service.log"

if [[ "$host" != http://* && "$host" != https://* ]]; then
	host="http://$host"
fi

if ! command -v ollama >/dev/null 2>&1; then
	echo 'service.sh: ollama binary is required but was not found in PATH' >&2
	exit 127
fi

if ! command -v curl >/dev/null 2>&1; then
	echo 'service.sh: curl is required to verify Ollama readiness' >&2
	exit 127
fi

mkdir -p tmp

if ! curl --fail --silent --show-error --max-time 2 "$host/api/version" >/dev/null 2>&1; then
	OLLAMA_HOST="$host" nohup ollama serve >"$log" 2>&1 &
	ready=false
	for _attempt in {1..60}; do
		if curl --fail --silent --show-error --max-time 2 "$host/api/version" >/dev/null 2>&1; then
			ready=true
			break
		fi
		sleep 1
	done
	if [[ "$ready" != true ]]; then
		echo "service.sh: Ollama did not become ready at $host; see $log" >&2
		exit 1
	fi
fi

if ! ollama list | awk 'NR > 1 { print $1 }' | grep --fixed-strings --line-regexp "$model" >/dev/null; then
	echo "service.sh: pulling missing model $model"
	ollama pull "$model"
fi

# A cold first load can spend minutes in llama-server tensor transforms on CPU
# hosts, and a disconnected warm client aborts the load itself, so the warm call
# carries the load budget rather than a request budget.
payload="$(printf '{"model":"%s","prompt":"hi","stream":false,"think":false,"keep_alive":"30m","options":{"num_predict":1}}' "$model")"
if ! curl --fail --silent --show-error --max-time 600 \
	--header 'Content-Type: application/json' \
	--data-binary "$payload" \
	"$host/api/generate" >/dev/null; then
	echo "service.sh: failed to warm model $model at $host" >&2
	exit 1
fi

echo "service.sh: Ollama is ready with $model"

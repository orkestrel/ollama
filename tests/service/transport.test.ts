import { describe, expect, it } from 'vitest'
import { createAgent } from '@orkestrel/agent'
import { createOllama } from '@src/server'
import { createRecordingProxy } from '../setupServer.js'
import { FAST_OPTIONS, OLLAMA_CONFIG, STREAM_OPTIONS } from '../setupService.js'

// The BROWSER → OWN-SERVER → LLM deployment, end-to-end. The unit-level header-injection
// + custom-fetch tests live in OllamaProvider.test.ts; this hardens the full SCENARIO: the
// centralized recording proxy (a real @orkestrel/server + @orkestrel/router HTTP server) that
// (i) RECORDS the inbound request — asserting it carried ONLY an obfuscated bearer token, never
// a real API key, of which there is none browser-side — then (ii) FORWARDS verbatim to the REAL
// live Ollama daemon (OLLAMA_CONFIG.host) and streams the genuine response back, unaltered. A
// full createAgent(createOllama({ url: proxy.url, headers })) runs a real generate() through it.
// This proves the runtime drives a provider pointed at the dev's server, the real daemon reached
// only SERVER-SIDE — the browser never holds a key and never talks to the daemon directly.
// `transport` is a cross-cutting suffix (structure-exempt).

const TIMEOUT = 60_000

const OBFUSCATED = 'Bearer obfuscated-7f3a-token'

describe('browser → own server (obfuscated token) → live LLM, end-to-end', () => {
	it(
		'a real generate() flows through the dev-server proxy carrying ONLY the obfuscated token, and a real answer comes back',
		async () => {
			// Recipe: FAST_OPTIONS (num_predict:8, temperature:0) — minimal warm chat, structural assert only.
			const proxy = await createRecordingProxy(OLLAMA_CONFIG.host)
			try {
				// The browser-side runtime: a provider pointed at the DEV SERVER (the proxy), with a
				// headers hook attaching the obfuscated bearer the server expects. No real API key is
				// anywhere browser-side — the headers hook is the entire auth the browser supplies.
				const agent = createAgent(
					createOllama({
						model: OLLAMA_CONFIG.model,
						url: proxy.url,
						options: FAST_OPTIONS,
						headers: () => ({ authorization: OBFUSCATED }),
					}),
					{ timeout: TIMEOUT },
				)
				agent.context.messages.add({ role: 'user', content: 'Reply with exactly: ok' })

				const result = await agent.generate()

				// A REAL answer came back THROUGH the proxy from the live daemon (structural — never
				// asserts the model OBEYED the prompt's wording, only that content arrived).
				expect(result.content.length).toBeGreaterThan(0)
				expect(result.partial).toBe(false)

				// The proxy recorded exactly the obfuscated token on the inbound /api/chat — and NO
				// real API key (there is none browser-side). This is the load-bearing assertion: the
				// browser authenticated to the dev server with the obfuscated token alone.
				const inbound = proxy.requests.find((seen) => seen.path === '/api/chat')
				if (inbound === undefined) throw new Error('proxy never recorded an /api/chat request')
				expect(inbound.headers.authorization).toBe(OBFUSCATED)
				// No real-key header leaked from the browser side.
				expect(inbound.headers['x-api-key']).toBeUndefined()
				expect(inbound.headers.authorization).not.toContain('sk-')
				// The base content type still rode alongside the injected auth (the seam ADDS, never
				// replaces) — so the forwarded request is a valid JSON /api/chat call.
				expect(inbound.headers['content-type']).toBe('application/json')
			} finally {
				await proxy.stop()
			}
		},
		TIMEOUT,
	)

	it(
		'the STREAMING path flows through the proxy too — deltas join to the settled content, carrying the obfuscated token',
		async () => {
			// Recipe: STREAM_OPTIONS (num_predict:16, temperature:0) — multi-delta streaming.
			const proxy = await createRecordingProxy(OLLAMA_CONFIG.host)
			try {
				const agent = createAgent(
					createOllama({
						model: OLLAMA_CONFIG.model,
						url: proxy.url,
						options: STREAM_OPTIONS,
						headers: () => ({ authorization: OBFUSCATED }),
					}),
					{ timeout: TIMEOUT },
				)
				agent.context.messages.add({ role: 'user', content: 'Count: one two three.' })

				const stream = agent.stream()
				const deltas: string[] = []
				for await (const chunk of stream.events)
					if (chunk.category === 'token') deltas.push(chunk.content)
				const result = await stream.result

				// The streamed NDJSON relayed through the proxy reassembled into the real answer.
				expect(deltas.length).toBeGreaterThan(0)
				expect(deltas.join('')).toBe(result.content)
				expect(result.content.length).toBeGreaterThan(0)
				expect(result.partial).toBe(false)
				// The obfuscated token rode the streaming request too.
				const inbound = proxy.requests.find((seen) => seen.path === '/api/chat')
				if (inbound === undefined) throw new Error('proxy never recorded an /api/chat request')
				expect(inbound.headers.authorization).toBe(OBFUSCATED)
			} finally {
				await proxy.stop()
			}
		},
		TIMEOUT,
	)
})

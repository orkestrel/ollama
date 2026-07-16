import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer, request as httpRequest } from 'node:http'
import { describe, expect, it } from 'vitest'
import { isNumber, isRecord, isString } from '@orkestrel/contract'
import { createAgent } from '@orkestrel/agent'
import { createOllama } from '@src/server'
import { flattenHeaders } from '../../setupOllama.js'
import { OLLAMA_CONFIG } from '../../setupOllama.js'

// S2 — the BROWSER → OWN-SERVER → LLM deployment, end-to-end. The unit-level header-injection
// + custom-fetch tests live in OllamaProvider.test.ts (against startOllamaStub); this hardens
// the full SCENARIO: a real `node:http` PROXY (the developer's server) that (i) ASSERTS the
// inbound request carried ONLY an obfuscated bearer token — never a real API key, of which
// there is none browser-side — then (ii) FORWARDS to the REAL live Ollama daemon
// (OLLAMA_CONFIG.host) and streams the genuine response back. A full
// createAgent(createOllama({ url: proxy, headers })) runs a real generate() through it. This
// proves the runtime drives a provider pointed at the dev's server, the real daemon reached
// only SERVER-SIDE — the browser never holds a key and never talks to the daemon directly.
//
// Live-forwarding proxy chosen (Ollama is required + warmed for src:ollama, so the daemon is
// guaranteed reachable) — the strongest proof: a real answer comes back THROUGH the proxy AND
// the proxy verifiably saw the obfuscated token. Per AGENTS §16 every hop is genuine (a real
// HTTP server forwarding to a real daemon), never a mock. `transport` is a cross-cutting
// suffix (structure-exempt).

const TIMEOUT = 60_000

const OBFUSCATED = 'Bearer obfuscated-7f3a-token'

/** One inbound request the proxy saw — the path it hit and its (lowercased) headers. */
interface ProxiedRequest {
	readonly path: string
	readonly headers: Readonly<Record<string, string>>
}

/** A running developer-server proxy: its base `url`, what it `saw`, and `close`. */
interface ProxyServer {
	readonly url: string
	readonly saw: readonly ProxiedRequest[]
	close(): Promise<void>
}

// Read a request's whole body as a Buffer (the bytes to forward verbatim upstream).
async function readBody(request: IncomingMessage): Promise<Buffer> {
	const parts: Buffer[] = []
	for await (const part of request) parts.push(Buffer.from(part))
	return Buffer.concat(parts)
}

// Forward the captured request to the REAL Ollama daemon and pipe its response (status +
// body bytes) straight back to the browser-side caller — the developer-server relay. The
// upstream call carries ONLY the JSON content type (the real key, if any, would be attached
// HERE server-side; this scenario has none — the point is the browser never holds one).
function relay(upstreamHost: string, path: string, body: Buffer, response: ServerResponse): void {
	const upstream = new URL(upstreamHost)
	const proxied = httpRequest(
		{
			hostname: upstream.hostname,
			port: upstream.port,
			path,
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Content-Length': body.byteLength },
		},
		(upstreamResponse) => {
			response.statusCode = upstreamResponse.statusCode ?? 502
			const contentType = upstreamResponse.headers['content-type']
			if (isString(contentType)) response.setHeader('Content-Type', contentType)
			upstreamResponse.pipe(response)
		},
	)
	proxied.on('error', (error: Error) => {
		response.statusCode = 502
		response.end(`proxy upstream error: ${error.message}`)
	})
	proxied.end(body)
}

/**
 * Start the developer-server proxy on an ephemeral port: it captures each inbound
 * `POST /api/chat`'s headers, then FORWARDS the request to the real Ollama daemon and streams
 * the genuine response back. The captured headers let the test assert the obfuscated token
 * arrived (and no real key did).
 *
 * @param upstreamHost - The real Ollama base URL to forward to (OLLAMA_CONFIG.host)
 * @returns The running {@link ProxyServer} — its `url`, the requests it `saw`, and `close`
 */
async function startForwardingProxy(upstreamHost: string): Promise<ProxyServer> {
	const saw: ProxiedRequest[] = []
	const server: Server = createServer((request, response) => {
		void handle(request, response)
	})
	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const body = await readBody(request)
		saw.push({ path: request.url ?? '', headers: flattenHeaders(request.headers) })
		relay(upstreamHost, request.url ?? '/api/chat', body, response)
	}
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const address: unknown = server.address()
	const port = isRecord(address) && isNumber(address.port) ? address.port : 0
	return {
		url: `http://127.0.0.1:${port}`,
		get saw() {
			return saw
		},
		close() {
			return new Promise<void>((resolve, reject) => {
				server.close((error) => (error === undefined ? resolve() : reject(error)))
			})
		},
	}
}

describe('S2 — browser → own server (obfuscated token) → live LLM, end-to-end', () => {
	it(
		'a real generate() flows through the dev-server proxy carrying ONLY the obfuscated token, and a real answer comes back',
		async () => {
			const proxy = await startForwardingProxy(OLLAMA_CONFIG.host)
			try {
				// The browser-side runtime: a provider pointed at the DEV SERVER (the proxy), with a
				// headers hook attaching the obfuscated bearer the server expects. No real API key is
				// anywhere browser-side — the headers hook is the entire auth the browser supplies.
				const agent = createAgent(
					createOllama({
						model: OLLAMA_CONFIG.model,
						url: proxy.url,
						options: { num_predict: 8, temperature: 0 },
						headers: () => ({ authorization: OBFUSCATED }),
					}),
					{ timeout: TIMEOUT },
				)
				agent.context.messages.add({ role: 'user', content: 'Reply with exactly: ok' })

				const result = await agent.generate()

				// A REAL answer came back THROUGH the proxy from the live daemon (structural — a small
				// model pads/cases freely, but a non-empty 'ok'-bearing reply proves the full hop).
				expect(result.content.length).toBeGreaterThan(0)
				expect(result.content.toLowerCase()).toContain('ok')
				expect(result.partial).toBe(false)

				// The proxy saw exactly the obfuscated token on the inbound /api/chat — and NO real
				// API key (there is none browser-side). This is the load-bearing S2 assertion: the
				// browser authenticated to the dev server with the obfuscated token alone.
				const inbound = proxy.saw.find((seen) => seen.path === '/api/chat')
				if (inbound === undefined) throw new Error('proxy never saw an /api/chat request')
				expect(inbound.headers.authorization).toBe(OBFUSCATED)
				// No real-key header leaked from the browser side.
				expect(inbound.headers['x-api-key']).toBeUndefined()
				expect(inbound.headers.authorization).not.toContain('sk-')
				// The base content type still rode alongside the injected auth (the seam ADDS, never
				// replaces) — so the forwarded request is a valid JSON /api/chat call.
				expect(inbound.headers['content-type']).toBe('application/json')
			} finally {
				await proxy.close()
			}
		},
		TIMEOUT,
	)

	it(
		'the STREAMING path flows through the proxy too — deltas join to the settled content, carrying the obfuscated token',
		async () => {
			const proxy = await startForwardingProxy(OLLAMA_CONFIG.host)
			try {
				const agent = createAgent(
					createOllama({
						model: OLLAMA_CONFIG.model,
						url: proxy.url,
						options: { num_predict: 16, temperature: 0 },
						headers: () => ({ authorization: OBFUSCATED }),
					}),
					{ timeout: TIMEOUT },
				)
				agent.context.messages.add({ role: 'user', content: 'Count: one two three.' })

				const stream = agent.stream()
				const deltas: string[] = []
				for await (const chunk of stream.events)
					if (chunk.type === 'token') deltas.push(chunk.content)
				const result = await stream.result

				// The streamed NDJSON relayed through the proxy reassembled into the real answer.
				expect(deltas.length).toBeGreaterThan(0)
				expect(deltas.join('')).toBe(result.content)
				expect(result.content.length).toBeGreaterThan(0)
				expect(result.partial).toBe(false)
				// The obfuscated token rode the streaming request too.
				const inbound = proxy.saw.find((seen) => seen.path === '/api/chat')
				if (inbound === undefined) throw new Error('proxy never saw an /api/chat request')
				expect(inbound.headers.authorization).toBe(OBFUSCATED)
			} finally {
				await proxy.close()
			}
		},
		TIMEOUT,
	)
})

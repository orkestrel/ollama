import { createAgent } from '@orkestrel/agent'
import { createBinaryContent, createFile } from '@orkestrel/workspace'
import { createOllama } from '@src/server'
import { describe, expect, it } from 'vitest'
import { createUserMessage, fillWorkspace } from '../../setup.js'
import { createRecordingProxy, systemText, wireMessages, wireText } from '../../setupServer.js'

// Hermetic workspace request-shape tests use a deliberately unreachable upstream.
// The recording proxy captures the request before forwarding, so the assertions cover
// only workspace rendering and attachment behavior on the provider wire; the suite
// passes with the daemon down.

const TIMEOUT = 60_000

// A tiny 1x1 transparent PNG, base64-encoded — a hardcoded binary fixture (AGENTS §16.1: fine to
// hardcode a small deterministic binary payload inline rather than generating one).
const TINY_PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

describe('AgentContext workspaces (hermetic provider behavior) — large-context injection', () => {
	it(
		'a many-file workspace fences every text file into the system block in insertion order',
		async () => {
			// Recipe: FAST_OPTIONS — the response outcome is irrelevant; the proxy records the
			// request before forwarding. fillWorkspace's defaults (count:12, bytesEach:700) keep the
			// total payload small (~8.4KB of filler + the sentinel).
			const proxy = await createRecordingProxy()
			try {
				const provider = createOllama({
					model: 'test-model',
					url: proxy.url,
					options: { num_predict: 8, temperature: 0 },
				})
				const agent = createAgent(provider, { timeout: TIMEOUT })
				const workspace = agent.context.workspaces.add()
				fillWorkspace(workspace, {
					count: 12,
					sentinelPath: 'notes/sentinel.md',
					sentinelText: 'THE-SENTINEL-VALUE-4471',
				})
				agent.context.messages.add({ role: 'user', content: 'Say hello.' })
				await agent.generate().catch(() => {})

				const request = proxy.requests[0]
				expect(request).toBeDefined()
				const text = request === undefined ? '' : systemText(request)
				expect(text).toContain('## Workspace')
				expect(text).toContain('File: doc-01.md')
				expect(text).toContain('THE-SENTINEL-VALUE-4471')
				expect(text.indexOf('doc-01.md')).toBeGreaterThanOrEqual(0)
				expect(text.indexOf('doc-02.md')).toBeGreaterThanOrEqual(0)
				expect(text.indexOf('doc-01.md')).toBeLessThan(text.indexOf('doc-02.md'))
			} finally {
				await proxy.stop()
			}
		},
		TIMEOUT,
	)

	it(
		'only the active workspace reaches the wire',
		async () => {
			// Recipe: FAST_OPTIONS. Two workspaces are registered — the FIRST auto-activates
			// (WorkspaceManagerInterface.add's documented behavior), the SECOND is added but left
			// inactive. The inactive workspace's sentinel must never reach the wire.
			const proxy = await createRecordingProxy()
			try {
				const provider = createOllama({
					model: 'test-model',
					url: proxy.url,
					options: { num_predict: 8, temperature: 0 },
				})
				const agent = createAgent(provider, { timeout: TIMEOUT })
				const active = agent.context.workspaces.add() // auto-activates
				active.write('active.md', 'ACTIVE-CONTENT-9931')
				const inactive = agent.context.workspaces.add({ id: 'inactive' }) // leaves active unchanged
				inactive.write('inactive.md', 'INACTIVE-SENTINEL-3312')
				agent.context.messages.add({ role: 'user', content: 'Say hello.' })
				await agent.generate().catch(() => {})

				const request = proxy.requests[0]
				expect(request).toBeDefined()
				const text = request === undefined ? '' : wireText(request)
				expect(text).toContain('ACTIVE-CONTENT-9931')
				expect(text).not.toContain('INACTIVE-SENTINEL-3312')
			} finally {
				await proxy.stop()
			}
		},
		TIMEOUT,
	)

	it(
		'image files are not fenced as text',
		async () => {
			// Recipe: FAST_OPTIONS. One text file + one image file (seated via the workspace
			// constructor `seed` — the only way to seat a non-text/binary file per WorkspaceInput's
			// documented contract) are placed in the active workspace. The text file's content must
			// fence into the system block; the image's base64 payload must never appear as fenced
			// text in any wire message content.
			const proxy = await createRecordingProxy()
			try {
				const provider = createOllama({
					model: 'test-model',
					url: proxy.url,
					options: { num_predict: 8, temperature: 0 },
				})
				const agent = createAgent(provider, { timeout: TIMEOUT })
				const workspace = agent.context.workspaces.add({
					seed: [
						createFile({
							path: 'picture.png',
							content: createBinaryContent(TINY_PNG_BASE64, 'image/png'),
						}),
					],
				})
				workspace.write('report.md', 'REPORT-TEXT-2287')
				agent.context.messages.add({ role: 'user', content: 'Say hello.' })
				await agent.generate().catch(() => {})

				const request = proxy.requests[0]
				expect(request).toBeDefined()
				const text = request === undefined ? '' : wireText(request)
				expect(text).toContain('REPORT-TEXT-2287')
				expect(text).not.toContain(TINY_PNG_BASE64)
			} finally {
				await proxy.stop()
			}
		},
		TIMEOUT,
	)

	it(
		'an active-workspace image attaches to the last user message',
		async () => {
			// Recipe: FAST_OPTIONS. A user message is seeded first, then an active workspace holding
			// only the seeded image file. The recorded body's LAST user-role message must carry the
			// image's base64 payload in a non-empty `images` array.
			const proxy = await createRecordingProxy()
			try {
				const provider = createOllama({
					model: 'test-model',
					url: proxy.url,
					options: { num_predict: 8, temperature: 0 },
				})
				const agent = createAgent(provider, { timeout: TIMEOUT })
				agent.context.messages.add(createUserMessage('What is in this image?'))
				agent.context.workspaces.add({
					seed: [
						createFile({
							path: 'attached.png',
							content: createBinaryContent(TINY_PNG_BASE64, 'image/png'),
						}),
					],
				})
				await agent.generate().catch(() => {})

				const request = proxy.requests[0]
				expect(request).toBeDefined()
				const messages = request === undefined ? [] : wireMessages(request)
				const userMessages = messages.filter((message) => message.role === 'user')
				const last = userMessages[userMessages.length - 1]
				expect(last).toBeDefined()
				expect(last?.images).toBeDefined()
				expect(last?.images?.length ?? 0).toBeGreaterThan(0)
				expect(last?.images).toContain(TINY_PNG_BASE64)
			} finally {
				await proxy.stop()
			}
		},
		TIMEOUT,
	)
})

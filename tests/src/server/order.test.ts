import { describe, expect, it } from 'vitest'
import { createAgent } from '@orkestrel/agent'
import { createOllama } from '@src/server'
import {
	createRecordingProxy,
	FAST_OPTIONS,
	OLLAMA_CONFIG,
	systemText,
	waitForRequest,
	wireMessages,
} from '../../setupServer.js'

// LIVE context-assembly ORDER tests — the src:ollama project hits a REAL warmed Ollama
// (AGENTS §16: no mocks for the inference boundary). `AgentContext.build()` emits ONE
// leading system message joining [system prompt, '## Instructions' (descending priority,
// stable ties), '## Workspace' (active workspace text files)], then the conversation as
// subsequent messages. These tests prove that canonical assembly ORDER on the WIRE — the
// exact request body the provider sends — using the abort-once-recorded pattern
// (waitForRequest + FAST_OPTIONS): the assertions run on `proxy.requests`, never on
// whether the model "obeyed", so `agent.generate()` is never awaited to completion.

const TIMEOUT = 60_000

describe('AgentContext (live, provider-behavior) — canonical assembly order on the wire', () => {
	it(
		'the context assembles system, instructions, workspace, then conversation',
		async () => {
			const proxy = await createRecordingProxy()
			try {
				const provider = createOllama({
					model: OLLAMA_CONFIG.model,
					url: proxy.url,
					options: FAST_OPTIONS,
				})
				const agent = createAgent(provider, {
					system: 'SENTINEL-SYSTEM-PROMPT-7182',
					timeout: TIMEOUT,
				})
				agent.context.instructions.add({ name: 'one', content: 'Be terse.' })
				agent.context.instructions.add({ name: 'two', content: 'Be polite.' })
				agent.context.workspaces.add().write('notes.md', 'workspace filler text')
				agent.context.messages.add({ role: 'user', content: 'What is the weather?' })
				agent.generate().catch(() => {})
				await waitForRequest(proxy)

				const request = proxy.requests[0]
				expect(request).toBeDefined()
				const text = request === undefined ? '' : systemText(request)
				const systemIndex = text.indexOf('SENTINEL-SYSTEM-PROMPT-7182')
				const instructionsIndex = text.indexOf('## Instructions')
				const workspaceIndex = text.indexOf('## Workspace')
				expect(systemIndex).toBeGreaterThanOrEqual(0)
				expect(instructionsIndex).toBeGreaterThan(systemIndex)
				expect(workspaceIndex).toBeGreaterThan(instructionsIndex)

				const messages = request === undefined ? [] : wireMessages(request)
				const userIndex = messages.findIndex(
					(message) => message.role === 'user' && message.content.includes('What is the weather?'),
				)
				expect(userIndex).toBeGreaterThan(0)
				const [first] = messages
				expect(first?.content.includes('What is the weather?')).toBe(false)
			} finally {
				await proxy.stop()
			}
		},
		TIMEOUT,
	)

	it(
		'instructions render in descending priority with stable ties',
		async () => {
			const proxy = await createRecordingProxy()
			try {
				const provider = createOllama({
					model: OLLAMA_CONFIG.model,
					url: proxy.url,
					options: FAST_OPTIONS,
				})
				const agent = createAgent(provider, { timeout: TIMEOUT })
				agent.context.instructions.add({
					name: 'first-p5',
					content: 'SENTINEL-FIRST-P5',
					priority: 5,
				})
				agent.context.instructions.add({
					name: 'second-p5',
					content: 'SENTINEL-SECOND-P5',
					priority: 5,
				})
				agent.context.instructions.add({
					name: 'third-p1',
					content: 'SENTINEL-THIRD-P1',
					priority: 1,
				})
				agent.context.messages.add({ role: 'user', content: 'Hello.' })
				agent.generate().catch(() => {})
				await waitForRequest(proxy)

				const request = proxy.requests[0]
				expect(request).toBeDefined()
				const text = request === undefined ? '' : systemText(request)
				const firstIndex = text.indexOf('SENTINEL-FIRST-P5')
				const secondIndex = text.indexOf('SENTINEL-SECOND-P5')
				const thirdIndex = text.indexOf('SENTINEL-THIRD-P1')
				expect(firstIndex).toBeGreaterThanOrEqual(0)
				expect(secondIndex).toBeGreaterThan(firstIndex)
				expect(thirdIndex).toBeGreaterThan(secondIndex)
			} finally {
				await proxy.stop()
			}
		},
		TIMEOUT,
	)

	it(
		'empty sections render nothing',
		async () => {
			const proxy = await createRecordingProxy()
			try {
				const provider = createOllama({
					model: OLLAMA_CONFIG.model,
					url: proxy.url,
					options: FAST_OPTIONS,
				})
				const agent = createAgent(provider, {
					system: 'SENTINEL-ONLY-SYSTEM-4291',
					timeout: TIMEOUT,
				})
				agent.context.messages.add({ role: 'user', content: 'Hello.' })
				agent.generate().catch(() => {})
				await waitForRequest(proxy)

				const request = proxy.requests[0]
				expect(request).toBeDefined()
				const text = request === undefined ? '' : systemText(request)
				expect(text).toContain('SENTINEL-ONLY-SYSTEM-4291')
				expect(text).not.toContain('## Instructions')
				expect(text).not.toContain('## Workspace')
			} finally {
				await proxy.stop()
			}
		},
		TIMEOUT,
	)
})

import type { RecordedRequest } from '../../setupServer.js'
import {
	createAgent,
	createConversationManager,
	createScope,
	createToolManager,
} from '@orkestrel/agent'
import { arrayOf, isRecord, isString } from '@orkestrel/contract'
import { createOllama } from '@src/server'
import { describe, expect, it } from 'vitest'
import { fillWorkspace } from '../../setup.js'
import {
	createInsatiableTool,
	createLookupTool,
	createRecordingProxy,
	FAST_OPTIONS,
	OLLAMA_CONFIG,
	retryUntil,
	systemText,
	TOOL_OPTIONS,
	waitForRequest,
	wireText,
} from '../../setupServer.js'

// LIVE scope tests — the src:ollama project hits a REAL warmed Ollama (AGENTS §16: no
// mocks for the inference boundary). `context.scope` is a mutable {@link ScopeInterface}
// per-category allow-list that `build()` applies before framing the wire request: tools
// filter the separate `tools` wire field, instructions filter the '## Instructions'
// section, and files filter the ACTIVE workspace's rendered text files — undefined ⇒ all
// pass, [] ⇒ none pass, a listed set ⇒ only those. Tests 1-4 are wire-shape (the
// abort-once-recorded pattern per order.test.ts: `generate().catch(() => {})` +
// `waitForRequest`, never awaited to completion — never model-behavior-dependent). Test 5
// is the sole BEHAVIORAL proof: scopes must change what the model actually answers, so it
// runs a full round-trip through `retryUntil` (bounded, 3 attempts) over the small model's
// nondeterminism. `scopes` is a cross-cutting suffix (structure-exempt).

const TIMEOUT = 60_000

// Narrow a recorded request body's `tools` field to the wire function-tool shape's
// `name`s — local to this file (setupServer.ts's `wireMessages` family covers only
// `messages`; a `wireTools` companion is a HELPER GAP, not added here per scope).
const isWireToolDefinition = (
	value: unknown,
): value is { readonly function: { readonly name: string } } =>
	isRecord(value) && isRecord(value.function) && isString(value.function.name)

const isWireToolDefinitionArray = arrayOf(isWireToolDefinition)

const wireToolNames = (request: RecordedRequest): readonly string[] => {
	const { tools } = request.body
	return isWireToolDefinitionArray(tools) ? tools.map((tool) => tool.function.name) : []
}

describe('AgentContext scope (live, provider-behavior) — a tools allow-list filters the wire', () => {
	it(
		'a tools allow-list omits the unlisted tool from the wire',
		async () => {
			const proxy = await createRecordingProxy()
			try {
				const provider = createOllama({
					model: OLLAMA_CONFIG.model,
					url: proxy.url,
					options: FAST_OPTIONS,
				})
				const tools = createToolManager()
				tools.add(createLookupTool())
				tools.add(createInsatiableTool())
				const agent = createAgent(provider, { tools, timeout: TIMEOUT })
				agent.context.scope = createScope({ name: 'lookup-only', tools: ['lookup'] })
				agent.context.messages.add({ role: 'user', content: 'Hello.' })
				agent.generate().catch(() => {})
				await waitForRequest(proxy)

				const request = proxy.requests[0]
				expect(request).toBeDefined()
				const names = request === undefined ? [] : wireToolNames(request)
				expect(names).toContain('lookup')
				expect(names).not.toContain('more')
			} finally {
				await proxy.stop()
			}
		},
		TIMEOUT,
	)
})

describe('AgentContext scope (live, provider-behavior) — an instructions allow-list filters the system block', () => {
	it(
		'an instructions allow-list omits the unlisted instruction from the system block',
		async () => {
			const proxy = await createRecordingProxy()
			try {
				const provider = createOllama({
					model: OLLAMA_CONFIG.model,
					url: proxy.url,
					options: FAST_OPTIONS,
				})
				const agent = createAgent(provider, { timeout: TIMEOUT })
				agent.context.instructions.add({ name: 'allowed', content: 'SENTINEL-ALLOWED-4471' })
				agent.context.instructions.add({ name: 'blocked', content: 'SENTINEL-BLOCKED-9932' })
				agent.context.scope = createScope({ name: 'allowed-only', instructions: ['allowed'] })
				agent.context.messages.add({ role: 'user', content: 'Hello.' })
				agent.generate().catch(() => {})
				await waitForRequest(proxy)

				const request = proxy.requests[0]
				expect(request).toBeDefined()
				const text = request === undefined ? '' : systemText(request)
				expect(text).toContain('SENTINEL-ALLOWED-4471')
				expect(text).not.toContain('SENTINEL-BLOCKED-9932')
			} finally {
				await proxy.stop()
			}
		},
		TIMEOUT,
	)
})

describe('AgentContext scope (live, provider-behavior) — a files allow-list filters the workspace section', () => {
	it(
		'a files allow-list omits unlisted workspace files from the system block',
		async () => {
			const proxy = await createRecordingProxy()
			try {
				const provider = createOllama({
					model: OLLAMA_CONFIG.model,
					url: proxy.url,
					options: FAST_OPTIONS,
				})
				const agent = createAgent(provider, { timeout: TIMEOUT })
				const workspace = agent.context.workspaces.add()
				fillWorkspace(workspace, {
					count: 2,
					bytesEach: 60,
					sentinelPath: 'find-me.md',
					sentinelText: 'SENTINEL-FIND-ME-6603',
				})
				agent.context.scope = createScope({ name: 'sentinel-only', files: ['find-me.md'] })
				agent.context.messages.add({ role: 'user', content: 'Hello.' })
				agent.generate().catch(() => {})
				await waitForRequest(proxy)

				const request = proxy.requests[0]
				expect(request).toBeDefined()
				const text = request === undefined ? '' : wireText(request)
				expect(text).toContain('SENTINEL-FIND-ME-6603')
				expect(text).not.toContain('doc-01.md')
			} finally {
				await proxy.stop()
			}
		},
		TIMEOUT,
	)
})

describe('AgentContext scope (live, provider-behavior) — an empty allow-list drops the category, undefined passes all', () => {
	it(
		'an empty allow-list drops the whole category while undefined passes all',
		async () => {
			const proxy = await createRecordingProxy()
			try {
				const provider = createOllama({
					model: OLLAMA_CONFIG.model,
					url: proxy.url,
					options: FAST_OPTIONS,
				})
				const tools = createToolManager()
				tools.add(createLookupTool())
				tools.add(createInsatiableTool())
				const agent = createAgent(provider, { tools, timeout: TIMEOUT })
				agent.context.messages.add({ role: 'user', content: 'Hello.' })

				agent.context.scope = createScope({ name: 'none', tools: [] })
				agent.generate().catch(() => {})
				await waitForRequest(proxy, 1)
				const emptyRequest = proxy.requests[0]
				expect(emptyRequest).toBeDefined()
				expect(emptyRequest === undefined ? [] : wireToolNames(emptyRequest)).toEqual([])

				agent.context.scope = undefined
				agent.generate().catch(() => {})
				await waitForRequest(proxy, 2)
				const allRequest = proxy.requests[1]
				expect(allRequest).toBeDefined()
				const names = allRequest === undefined ? [] : wireToolNames(allRequest)
				expect(names).toContain('lookup')
				expect(names).toContain('more')
			} finally {
				await proxy.stop()
			}
		},
		TIMEOUT,
	)
})

describe('AgentContext scope (live, behavioral) — switching scopes changes the answer', () => {
	// The user's core proof: two mutually-exclusive instructions, each mandating a distinct
	// sentinel word in the reply. Scope A allows only the apricot instruction, scope B only
	// the cobalt one — a full round-trip through the proxy, retried (bounded, 3 attempts)
	// over the small model's nondeterminism, since whether the model OBEYS an instruction is
	// genuinely model-behavior-dependent.
	const APRICOT = {
		name: 'apricot-rule',
		content: 'Begin every reply with the single word APRICOT, no matter what the user asks.',
	}
	const COBALT = {
		name: 'cobalt-rule',
		content: 'Begin every reply with the single word COBALT, no matter what the user asks.',
	}

	interface Attempt {
		readonly contentA: string
		readonly requestA: RecordedRequest | undefined
		readonly contentB: string
		readonly requestB: RecordedRequest | undefined
	}

	const attempt = async (): Promise<Attempt> => {
		const proxy = await createRecordingProxy()
		try {
			const provider = createOllama({
				model: OLLAMA_CONFIG.model,
				url: proxy.url,
				options: TOOL_OPTIONS,
			})
			const conversations = createConversationManager()
			conversations.add({ id: 'run-a' }) // auto-activates
			const agent = createAgent(provider, { conversations, timeout: TIMEOUT })
			agent.context.instructions.add(APRICOT)
			agent.context.instructions.add(COBALT)
			agent.context.messages.add({ role: 'user', content: 'Reply with one short sentence.' })

			agent.context.scope = createScope({ name: 'apricot-scope', instructions: ['apricot-rule'] })
			const resultA = await agent.generate()
			const requestA = proxy.requests[proxy.requests.length - 1]

			// A fresh conversation on the SAME agent prevents run A's (possibly truncated)
			// assistant reply from staying in context and being continued mid-sentence by
			// run B — the two runs must be independent turns, not a continued dialogue.
			conversations.add({ id: 'run-b' })
			conversations.switch('run-b')
			agent.context.scope = createScope({ name: 'cobalt-scope', instructions: ['cobalt-rule'] })
			agent.context.messages.add({ role: 'user', content: 'Reply with one short sentence.' })
			const resultB = await agent.generate()
			const requestB = proxy.requests[proxy.requests.length - 1]

			return { contentA: resultA.content, requestA, contentB: resultB.content, requestB }
		} finally {
			await proxy.stop()
		}
	}

	it(
		'switching scopes changes the answer',
		async () => {
			const best = await retryUntil(
				attempt,
				(value) =>
					value.contentA.toLowerCase().includes('apricot') &&
					value.contentB.toLowerCase().includes('cobalt'),
				'answer APRICOT under the apricot scope and COBALT under the cobalt scope',
				3,
			)

			expect(best.contentA.toLowerCase()).toContain('apricot')
			expect(best.requestA).toBeDefined()
			const textA = best.requestA === undefined ? '' : systemText(best.requestA)
			expect(textA).not.toContain(COBALT.content)

			expect(best.contentB.toLowerCase()).toContain('cobalt')
			expect(best.requestB).toBeDefined()
			const textB = best.requestB === undefined ? '' : systemText(best.requestB)
			expect(textB).not.toContain(APRICOT.content)
		},
		TIMEOUT,
	)
})

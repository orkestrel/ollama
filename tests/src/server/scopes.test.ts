import {
	createAgent,
	createInstructionManager,
	createScope,
	createToolManager,
} from '@orkestrel/agent'
import { createOllama } from '@src/server'
import { describe, expect, it } from 'vitest'
import { fillWorkspace } from '../../setup.js'
import {
	createInsatiableTool,
	createLookupTool,
	createRecordingProxy,
	systemText,
	waitForRequest,
	wireText,
	wireTools,
} from '../../setupServer.js'

const TIMEOUT = 60_000

describe('AgentContext scope (provider-behavior) — a tools allow-list filters the wire', () => {
	it(
		'a tools allow-list omits the unlisted tool from the wire',
		async () => {
			const proxy = await createRecordingProxy()
			try {
				const provider = createOllama({
					model: 'test-model',
					url: proxy.url,
					options: { num_predict: 8, temperature: 0 },
				})
				const tools = createToolManager()
				tools.add(createLookupTool())
				tools.add(createInsatiableTool())
				const scope = createScope({ name: 'lookup-only', tools: ['lookup'] })
				const agent = createAgent(provider, { tools, scope, timeout: TIMEOUT })
				agent.context.messages.add({ role: 'user', content: 'Hello.' })
				agent.generate().catch(() => {})
				await waitForRequest(proxy)

				const request = proxy.requests[0]
				expect(request).toBeDefined()
				const names = request === undefined ? [] : wireTools(request)
				expect(names).toContain('lookup')
				expect(names).not.toContain('more')
			} finally {
				await proxy.stop()
			}
		},
		TIMEOUT,
	)
})

describe('AgentContext scope (provider-behavior) — an instructions allow-list filters the system block', () => {
	it(
		'an instructions allow-list omits the unlisted instruction from the system block',
		async () => {
			const proxy = await createRecordingProxy()
			try {
				const provider = createOllama({
					model: 'test-model',
					url: proxy.url,
					options: { num_predict: 8, temperature: 0 },
				})
				const instructions = createInstructionManager()
				instructions.add({ name: 'allowed', content: 'SENTINEL-ALLOWED-4471' })
				instructions.add({ name: 'blocked', content: 'SENTINEL-BLOCKED-9932' })
				const scope = createScope({ name: 'allowed-only', instructions: ['allowed'] })
				const agent = createAgent(provider, { instructions, scope, timeout: TIMEOUT })
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

describe('AgentContext scope (provider-behavior) — a files allow-list filters the workspace section', () => {
	it(
		'a files allow-list omits unlisted workspace files from the system block',
		async () => {
			const proxy = await createRecordingProxy()
			try {
				const provider = createOllama({
					model: 'test-model',
					url: proxy.url,
					options: { num_predict: 8, temperature: 0 },
				})
				const scope = createScope({ name: 'sentinel-only', files: ['find-me.md'] })
				const agent = createAgent(provider, { scope, timeout: TIMEOUT })
				const workspace = agent.context.workspaces.add()
				fillWorkspace(workspace, {
					count: 2,
					bytesEach: 60,
					sentinelPath: 'find-me.md',
					sentinelText: 'SENTINEL-FIND-ME-6603',
				})
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

describe('AgentContext scope (provider-behavior) — an empty allow-list drops the category, undefined passes all', () => {
	it(
		'an empty allow-list drops the whole category while undefined passes all',
		async () => {
			const proxy = await createRecordingProxy()
			try {
				const provider = createOllama({
					model: 'test-model',
					url: proxy.url,
					options: { num_predict: 8, temperature: 0 },
				})
				const tools = createToolManager()
				tools.add(createLookupTool())
				tools.add(createInsatiableTool())
				const scope = createScope({ name: 'none', tools: [] })
				const agent = createAgent(provider, { tools, scope, timeout: TIMEOUT })
				agent.context.messages.add({ role: 'user', content: 'Hello.' })

				agent.generate().catch(() => {})
				await waitForRequest(proxy, 1)
				const emptyRequest = proxy.requests[0]
				expect(emptyRequest).toBeDefined()
				expect(emptyRequest === undefined ? [] : wireTools(emptyRequest)).toEqual([])

				agent.context.apply(undefined)
				agent.generate().catch(() => {})
				await waitForRequest(proxy, 2)
				const allRequest = proxy.requests[1]
				expect(allRequest).toBeDefined()
				const names = allRequest === undefined ? [] : wireTools(allRequest)
				expect(names).toContain('lookup')
				expect(names).toContain('more')
			} finally {
				await proxy.stop()
			}
		},
		TIMEOUT,
	)
})

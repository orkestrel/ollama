import { createAgent, createAuthority } from '@orkestrel/agent'
import { createRecorder, retryUntil } from '@orkestrel/test'
import { createToolManager } from '@orkestrel/tool'
import { describe, expect, it } from 'vitest'
import { createLookupTool, driveAgent, LOOKUP_DATUM } from '../setupServer.js'
import { createLiveOllama, RETRY_BUDGET } from '../setupService.js'

// LIVE authority-surface tests — the allow / fail-closed / fallback paths of
// `createAuthority` beyond the deny-path already covered in tools.test.ts (AGENTS
// §16: no mocks for the inference boundary). Every model-choice-dependent step is
// wrapped in `retryUntil` (bounded at 3 attempts). Warmed, no skipIf.

const TIMEOUT = 60_000

describe('Agent tool loop (live) — an allow rule lets the tool execute', () => {
	it(
		'an explicit allow rule for the lookup tool lets it execute, with no deny event',
		async () => {
			const recorder = createRecorder<[Readonly<Record<string, unknown>>]>()
			const denyRecorder = createRecorder<[unknown, string | undefined]>()
			const authority = createAuthority({
				rules: [
					{
						match: (context) => context.call.name === 'lookup',
						zone: 'default',
						allowed: true,
					},
				],
			})

			const driven = await retryUntil(
				'let an explicitly allowed lookup call execute',
				async () => {
					recorder.clear()
					denyRecorder.clear()
					const tools = createToolManager()
					tools.add(createLookupTool(recorder))
					const agent = createAgent(createLiveOllama(), {
						system:
							'You MUST call the lookup tool with query "datum" to answer, then state exactly what it returned.',
						tools,
						authority,
						timeout: TIMEOUT,
						limit: 4,
						on: { deny: (call, reason) => denyRecorder.handler(call, reason) },
					})
					agent.context.messages.add({
						role: 'user',
						content:
							'Call the lookup tool with query "datum", then tell me exactly what it returned.',
					})
					const stream = agent.stream()
					return driveAgent(stream)
				},
				() => recorder.count >= 1,
				{ attempts: 3, budget: RETRY_BUDGET },
			)

			const dispatched = driven.tools.find((tool) => tool.call.name === 'lookup')
			expect(dispatched).toBeDefined()
			expect(dispatched?.result).toMatchObject({ success: true, value: LOOKUP_DATUM })
			expect(recorder.count).toBeGreaterThanOrEqual(1)
			expect(denyRecorder.count).toBe(0)
			expect(driven.result.partial).toBe(false)
		},
		TIMEOUT,
	)
})

describe('Agent tool loop (live) — a rule that throws during evaluation fails closed', () => {
	it(
		'a match function throwing during evaluation denies the call, never executes it, and the run still resolves',
		async () => {
			const recorder = createRecorder<[Readonly<Record<string, unknown>>]>()
			const denyRecorder = createRecorder<[unknown, string | undefined]>()
			const authority = createAuthority({
				rules: [
					{
						match: () => {
							throw new Error('evaluation exploded')
						},
						zone: 'restricted',
						allowed: false,
					},
				],
			})

			const driven = await retryUntil(
				'fail closed and deny the lookup call when a rule throws during evaluation',
				async () => {
					recorder.clear()
					denyRecorder.clear()
					const tools = createToolManager()
					tools.add(createLookupTool(recorder))
					const agent = createAgent(createLiveOllama(), {
						system: 'You MUST call the lookup tool with query "datum" to answer.',
						tools,
						authority,
						timeout: TIMEOUT,
						limit: 4,
						on: { deny: (call, reason) => denyRecorder.handler(call, reason) },
					})
					agent.context.messages.add({
						role: 'user',
						content: 'Call the lookup tool with query "datum", then tell me what it returned.',
					})
					const stream = agent.stream()
					return driveAgent(stream)
				},
				() => denyRecorder.count > 0 && recorder.count === 0,
				{ attempts: 3, budget: RETRY_BUDGET },
			)

			expect(denyRecorder.count).toBeGreaterThan(0)
			expect(recorder.count).toBe(0)
			const denied = driven.tools.find((tool) => tool.call.name === 'lookup')
			expect(denied).toBeDefined()
			expect(denied?.result).toMatchObject({ success: false })
			expect(denied?.result).toHaveProperty('error')
			expect(driven.result.partial).toBe(false)
		},
		TIMEOUT,
	)
})

describe('Agent tool loop (live) — no matching rule falls back to default allow', () => {
	it(
		'a rule matching a different tool name never applies, and the unmatched lookup call falls back to allow',
		async () => {
			const recorder = createRecorder<[Readonly<Record<string, unknown>>]>()
			const denyRecorder = createRecorder<[unknown, string | undefined]>()
			const authority = createAuthority({
				rules: [
					{
						match: (context) => context.call.name === 'unrelated',
						zone: 'restricted',
						allowed: false,
					},
				],
			})

			const driven = await retryUntil(
				'fall back to allow the unmatched lookup call',
				async () => {
					recorder.clear()
					denyRecorder.clear()
					const tools = createToolManager()
					tools.add(createLookupTool(recorder))
					const agent = createAgent(createLiveOllama(), {
						system:
							'You MUST call the lookup tool with query "datum" to answer, then state exactly what it returned.',
						tools,
						authority,
						timeout: TIMEOUT,
						limit: 4,
						on: { deny: (call, reason) => denyRecorder.handler(call, reason) },
					})
					agent.context.messages.add({
						role: 'user',
						content:
							'Call the lookup tool with query "datum", then tell me exactly what it returned.',
					})
					const stream = agent.stream()
					return driveAgent(stream)
				},
				() => recorder.count >= 1,
				{ attempts: 3, budget: RETRY_BUDGET },
			)

			const dispatched = driven.tools.find((tool) => tool.call.name === 'lookup')
			expect(dispatched).toBeDefined()
			expect(dispatched?.result).toMatchObject({ success: true, value: LOOKUP_DATUM })
			expect(recorder.count).toBeGreaterThanOrEqual(1)
			expect(denyRecorder.count).toBe(0)
			expect(driven.result.partial).toBe(false)
		},
		TIMEOUT,
	)
})

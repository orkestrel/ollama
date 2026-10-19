import { createAgent, createAuthority } from '@orkestrel/agent'
import { createRecorder, retryUntil } from '@orkestrel/test'
import { createToolManager } from '@orkestrel/tool'
import type { ToolCall } from '@orkestrel/tool'
import { describe, expect, it } from 'vitest'
import { CASE_TIMEOUT } from '../setup.js'
import { createLookupTool, driveAgent, LOOKUP_DATUM } from '../setupServer.js'
import { createLiveOllama, RETRY_BUDGET } from '../setupService.js'

// LIVE authority-surface tests — the allow / fail-closed / fallback paths of
// `createAuthority` beyond the deny-path already covered in tools.test.ts, with no
// mocks for the inference boundary. Every model-choice-dependent step is
// wrapped in `retryUntil` (bounded at 3 attempts). Warmed, no skipIf.

describe('Agent tool loop (live) — an allow rule lets the tool execute', () => {
	it(
		'an explicit allow rule for the lookup tool lets it execute, with no deny event',
		async () => {
			const authority = createAuthority({
				rules: [
					{
						match: (context) => context.call.name === 'lookup',
						zone: 'default',
						allowed: true,
					},
				],
			})

			const { driven, executed, denied } = await retryUntil(
				'let an explicitly allowed lookup call execute',
				async () => {
					const lookups = createRecorder<[Readonly<Record<string, unknown>>]>()
					const denials = createRecorder<[ToolCall, string | undefined]>()
					const tools = createToolManager()
					tools.add(createLookupTool(lookups))
					const agent = createAgent(createLiveOllama(), {
						system:
							'You MUST call the lookup tool with query "datum" to answer, then state exactly what it returned.',
						tools,
						authority,
						timeout: CASE_TIMEOUT,
						limit: 4,
						on: { deny: (call, reason) => denials.handler(call, reason) },
					})
					agent.context.messages.add({
						role: 'user',
						content:
							'Call the lookup tool with query "datum", then tell me exactly what it returned.',
					})
					const stream = agent.stream()
					return {
						driven: await driveAgent(stream),
						executed: lookups.calls,
						denied: denials.calls,
					}
				},
				(value) => value.executed.length >= 1,
				{ attempts: 3, budget: RETRY_BUDGET },
			)

			const dispatched = driven.tools.find((tool) => tool.call.name === 'lookup')
			expect(dispatched).toBeDefined()
			expect(dispatched?.result).toMatchObject({ success: true, value: LOOKUP_DATUM })
			// The tool ran once for each lookup call the loop dispatched, with the arguments the call carried.
			expect(executed).toEqual(
				driven.tools
					.filter((tool) => tool.call.name === 'lookup')
					.map((tool) => [tool.call.arguments]),
			)
			expect(denied).toEqual([])
			expect(driven.result.partial).toBe(false)
		},
		CASE_TIMEOUT,
	)
})

describe('Agent tool loop (live) — a rule that throws during evaluation fails closed', () => {
	it(
		'a match function throwing during evaluation denies the call, never executes it, and the run still resolves',
		async () => {
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

			const { driven, executed, denied } = await retryUntil(
				'fail closed and deny the lookup call when a rule throws during evaluation',
				async () => {
					const lookups = createRecorder<[Readonly<Record<string, unknown>>]>()
					const denials = createRecorder<[ToolCall, string | undefined]>()
					const tools = createToolManager()
					tools.add(createLookupTool(lookups))
					const agent = createAgent(createLiveOllama(), {
						system: 'You MUST call the lookup tool with query "datum" to answer.',
						tools,
						authority,
						timeout: CASE_TIMEOUT,
						limit: 4,
						on: { deny: (call, reason) => denials.handler(call, reason) },
					})
					agent.context.messages.add({
						role: 'user',
						content: 'Call the lookup tool with query "datum", then tell me what it returned.',
					})
					const stream = agent.stream()
					return {
						driven: await driveAgent(stream),
						executed: lookups.calls,
						denied: denials.calls,
					}
				},
				(value) => value.denied.length > 0 && value.executed.length === 0,
				{ attempts: 3, budget: RETRY_BUDGET },
			)

			// The rule's own failure is the recorded reason, once for each lookup call the loop dispatched.
			expect(denied.filter(([call]) => call.name === 'lookup')).toEqual(
				driven.tools
					.filter((tool) => tool.call.name === 'lookup')
					.map((tool) => [tool.call, 'evaluation exploded']),
			)
			expect(executed).toEqual([])
			const refused = driven.tools.find((tool) => tool.call.name === 'lookup')
			expect(refused).toBeDefined()
			expect(refused?.result).toMatchObject({ success: false })
			expect(refused?.result).toHaveProperty('error')
			expect(driven.result.partial).toBe(false)
		},
		CASE_TIMEOUT,
	)
})

describe('Agent tool loop (live) — no matching rule falls back to default allow', () => {
	it(
		'a rule matching a different tool name never applies, and the unmatched lookup call falls back to allow',
		async () => {
			const authority = createAuthority({
				rules: [
					{
						match: (context) => context.call.name === 'unrelated',
						zone: 'restricted',
						allowed: false,
					},
				],
			})

			const { driven, executed, denied } = await retryUntil(
				'fall back to allow the unmatched lookup call',
				async () => {
					const lookups = createRecorder<[Readonly<Record<string, unknown>>]>()
					const denials = createRecorder<[ToolCall, string | undefined]>()
					const tools = createToolManager()
					tools.add(createLookupTool(lookups))
					const agent = createAgent(createLiveOllama(), {
						system:
							'You MUST call the lookup tool with query "datum" to answer, then state exactly what it returned.',
						tools,
						authority,
						timeout: CASE_TIMEOUT,
						limit: 4,
						on: { deny: (call, reason) => denials.handler(call, reason) },
					})
					agent.context.messages.add({
						role: 'user',
						content:
							'Call the lookup tool with query "datum", then tell me exactly what it returned.',
					})
					const stream = agent.stream()
					return {
						driven: await driveAgent(stream),
						executed: lookups.calls,
						denied: denials.calls,
					}
				},
				(value) => value.executed.length >= 1,
				{ attempts: 3, budget: RETRY_BUDGET },
			)

			const dispatched = driven.tools.find((tool) => tool.call.name === 'lookup')
			expect(dispatched).toBeDefined()
			expect(dispatched?.result).toMatchObject({ success: true, value: LOOKUP_DATUM })
			expect(executed).toEqual(
				driven.tools
					.filter((tool) => tool.call.name === 'lookup')
					.map((tool) => [tool.call.arguments]),
			)
			expect(denied).toEqual([])
			expect(driven.result.partial).toBe(false)
		},
		CASE_TIMEOUT,
	)
})

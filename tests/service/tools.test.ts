import { createAgent, createAuthority } from '@orkestrel/agent'
import { createRecorder, retryUntil } from '@orkestrel/test'
import { createToolManager } from '@orkestrel/tool'
import type { ToolCall } from '@orkestrel/tool'
import { createOllama } from '@src/core'
import { describe, expect, it } from 'vitest'
import { CASE_TIMEOUT } from '../setup.js'
import {
	createInsatiableTool,
	createLookupTool,
	createRecordingProxy,
	createThrowingTool,
	driveAgent,
	LOOKUP_DATUM,
	THROWING_TOOL_MESSAGE,
	wireMessages,
} from '../setupServer.js'
import {
	createLiveOllama,
	OLLAMA_CONFIG,
	RETRY_BUDGET,
	TOOL_LOOP_OPTIONS,
} from '../setupService.js'

// LIVE tool-calling machinery tests — the real OllamaProvider driving the agent's tool
// loop against the warmed local model, with no mocks for the inference boundary.
// Every assertion here rides on LOOP WIRING (chunk / event / recorder / proxy / partial
// mechanics) — never on "the model was smart", per directive: a failure here indicates
// OUR packages (agent / ollama) mishandled a tool call. Every model-choice-dependent step
// is wrapped in `retryUntil` (bounded at 3 attempts) since the small 2B model does not
// reliably choose to call a tool on every single attempt. `tools` is a cross-cutting
// suffix (structure-exempt). Warmed, no skipIf.

describe('Agent tool loop (live) — dispatch by name', () => {
	it(
		'a steered call to the registered `lookup` tool dispatches by name, feeds its result back, and never touches the sibling `fail` tool',
		async () => {
			const { driven, lookups, failures } = await retryUntil(
				'call the lookup tool by name',
				async () => {
					const lookupRecorder = createRecorder<[Readonly<Record<string, unknown>>]>()
					const failRecorder = createRecorder<[Readonly<Record<string, unknown>>]>()
					const tools = createToolManager()
					tools.add(createLookupTool(lookupRecorder))
					tools.add(createThrowingTool(failRecorder))
					const agent = createAgent(createLiveOllama(), {
						system:
							'You MUST call the lookup tool with query "datum" to answer. Never call the fail tool.',
						tools,
						timeout: CASE_TIMEOUT,
						limit: 4,
					})
					agent.context.messages.add({
						role: 'user',
						content:
							'Call the lookup tool with query "datum", then tell me exactly what it returned.',
					})
					const stream = agent.stream()
					return {
						driven: await driveAgent(stream),
						lookups: lookupRecorder.calls,
						failures: failRecorder.calls,
					}
				},
				(value) => value.driven.tools.some((tool) => tool.call.name === 'lookup'),
				{ attempts: 3, budget: RETRY_BUDGET },
			)

			const dispatched = driven.tools.find((tool) => tool.call.name === 'lookup')
			expect(dispatched).toBeDefined()
			expect(dispatched?.result).toMatchObject({ success: true, value: LOOKUP_DATUM })
			// The tool ran once for each lookup call the loop dispatched, with the arguments the call carried.
			expect(lookups).toEqual(
				driven.tools
					.filter((tool) => tool.call.name === 'lookup')
					.map((tool) => [tool.call.arguments]),
			)
			expect(failures).toEqual([])
		},
		CASE_TIMEOUT,
	)
})

describe('Agent tool loop (live) — tool-result feedback reaches the wire', () => {
	it(
		'a tool result is fed back into the loop as a second /api/chat request carrying the tool datum',
		async () => {
			const proxy = await createRecordingProxy(OLLAMA_CONFIG.host)
			try {
				const attempt = await retryUntil(
					're-send the tool result to the model on a subsequent request',
					async () => {
						const tools = createToolManager()
						tools.add(createLookupTool())
						const provider = createOllama({
							model: OLLAMA_CONFIG.model,
							url: proxy.url,
							options: TOOL_LOOP_OPTIONS,
						})
						const agent = createAgent(provider, {
							system:
								'You MUST call the lookup tool with query "datum" to answer, then state the exact returned value in your final reply.',
							tools,
							timeout: CASE_TIMEOUT,
							limit: 4,
						})
						agent.context.messages.add({
							role: 'user',
							content:
								'Call the lookup tool with query "datum", then tell me exactly what it returned.',
						})
						return agent.generate()
					},
					() => {
						if (proxy.requests.length < 2) return false
						return proxy.requests.some((request) => {
							const messages = wireMessages(request)
							return messages.some((message) => String(message.content).includes(LOOKUP_DATUM))
						})
					},
					{ attempts: 3, budget: RETRY_BUDGET },
				)

				expect(proxy.requests.length).toBeGreaterThanOrEqual(2)
				const carriesResult = proxy.requests.some((request) => {
					const messages = wireMessages(request)
					return messages.some((message) => String(message.content).includes(LOOKUP_DATUM))
				})
				expect(carriesResult).toBe(true)
				expect(attempt.partial).toBe(false)
			} finally {
				await proxy.stop()
			}
		},
		CASE_TIMEOUT,
	)
})

describe('Agent tool loop (live) — a thrown tool error is isolated', () => {
	it(
		'the fail tool throwing surfaces as a ToolResult.error, and the loop still settles to a resolved, non-partial finish',
		async () => {
			// Calibration note: the 2B model is reluctant to call a tool literally named
			// `fail`, and a FAST_OPTIONS-scale completion can stop before the call is
			// emitted on some hosts — so this case carries its own predict headroom,
			// heavier steering, and a deeper retry than the sibling lookup cases.
			const { driven, executed } = await retryUntil(
				'call the fail tool',
				async () => {
					const recorder = createRecorder<[Readonly<Record<string, unknown>>]>()
					const tools = createToolManager()
					tools.add(createThrowingTool(recorder))
					const agent = createAgent(createLiveOllama({ predict: 128 }), {
						system:
							'You are a tool-calling harness. Your ONLY permitted first action is calling the fail tool with any arguments. Do not answer in text before calling it.',
						tools,
						timeout: CASE_TIMEOUT,
						limit: 4,
					})
					agent.context.messages.add({
						role: 'user',
						content: 'Invoke the fail tool immediately, then tell me what happened.',
					})
					const stream = agent.stream()
					return { driven: await driveAgent(stream), executed: recorder.calls }
				},
				(value) => value.driven.tools.some((tool) => tool.call.name === 'fail'),
				{ attempts: 5, budget: RETRY_BUDGET },
			)

			const failed = driven.tools.find((tool) => tool.call.name === 'fail')
			expect(failed).toBeDefined()
			expect(failed?.result).toMatchObject({
				success: false,
				error: expect.stringContaining(THROWING_TOOL_MESSAGE),
			})
			expect(failed?.result).not.toHaveProperty('value')
			// The tool ran once for each fail call the loop dispatched, with the arguments the call carried.
			expect(executed).toEqual(
				driven.tools
					.filter((tool) => tool.call.name === 'fail')
					.map((tool) => [tool.call.arguments]),
			)
			// The loop CONTINUED past the thrown error to a resolved, non-rejected finish.
			expect(driven.result.partial).toBe(false)
		},
		CASE_TIMEOUT,
	)
})

describe('Agent tool loop (live) — authority denial blocks execution', () => {
	it(
		'a denylisted lookup call never executes, fires a `deny` event, and the run still resolves',
		async () => {
			const authority = createAuthority({
				rules: [
					{
						match: (context) => context.call.name === 'lookup',
						zone: 'restricted',
						allowed: false,
						reason: 'denied for test',
					},
				],
			})

			const { driven, executed, denied } = await retryUntil(
				'fire a deny event for the lookup call',
				async () => {
					const recorder = createRecorder<[Readonly<Record<string, unknown>>]>()
					const denyRecorder = createRecorder<[ToolCall, string | undefined]>()
					const tools = createToolManager()
					tools.add(createLookupTool(recorder))
					const agent = createAgent(createLiveOllama(), {
						system: 'You MUST call the lookup tool with query "datum" to answer.',
						tools,
						authority,
						timeout: CASE_TIMEOUT,
						limit: 4,
						on: { deny: (call, reason) => denyRecorder.handler(call, reason) },
					})
					agent.context.messages.add({
						role: 'user',
						content: 'Call the lookup tool with query "datum", then tell me what it returned.',
					})
					const stream = agent.stream()
					return {
						driven: await driveAgent(stream),
						executed: recorder.calls,
						denied: denyRecorder.calls,
					}
				},
				(value) => value.denied.length > 0,
				{ attempts: 3, budget: RETRY_BUDGET },
			)

			// The rule's reason is what each denied lookup call carried.
			expect(denied.filter(([call]) => call.name === 'lookup')).toEqual(
				driven.tools
					.filter((tool) => tool.call.name === 'lookup')
					.map((tool) => [tool.call, 'denied for test']),
			)
			// The tool NEVER executed — the authority denial short-circuited it.
			expect(executed).toEqual([])
			expect(driven.result.partial).toBe(false)
		},
		CASE_TIMEOUT,
	)
})

describe('Agent tool loop (live) — turn-limit exhaustion', () => {
	it(
		'limit exhaustion with unresolved tool intent on the last allowed turn resolves partial, fires exhaust (not abort), then finish',
		async () => {
			// Source-verified semantics (0.0.6, dist/src/core/index.d.ts AgentEventMap.exhaust +
			// AgentRunResult.exhausted): when the loop exhausts `limit` while the LAST allowed turn
			// still requested tools, the run resolves `partial: true`, a dedicated `exhaust` event
			// fires with the effective turn count `[limit]`, and `abort` does NOT fire — exhaustion
			// is explicitly distinct from a cancel. `finish` still fires last, carrying the partial
			// result. `limit: 1` + a forced tool call therefore consumes the sole provider turn,
			// which requests the tool, so the loop stops with unresolved intent.
			const { driven, executed, turns, exhausts, aborts } = await retryUntil(
				'call the tool, consuming the single allowed turn',
				async () => {
					const recorder = createRecorder<[Readonly<Record<string, unknown>>]>()
					const turnRecorder = createRecorder<[number]>()
					const exhaustRecorder = createRecorder<[number]>()
					const abortRecorder = createRecorder<[unknown]>()
					const tools = createToolManager()
					tools.add(createLookupTool(recorder))
					const agent = createAgent(createLiveOllama(), {
						system: 'You MUST call the lookup tool with query "datum" immediately.',
						tools,
						limit: 1,
						timeout: CASE_TIMEOUT,
						on: {
							turn: (index) => turnRecorder.handler(index),
							exhaust: (count) => exhaustRecorder.handler(count),
							abort: (reason) => abortRecorder.handler(reason),
						},
					})
					agent.context.messages.add({
						role: 'user',
						content: 'Call the lookup tool with query "datum" right now.',
					})
					const stream = agent.stream()
					return {
						driven: await driveAgent(stream),
						executed: recorder.calls,
						turns: turnRecorder.calls,
						exhausts: exhaustRecorder.calls,
						aborts: abortRecorder.calls,
					}
				},
				(value) => value.driven.tools.length > 0,
				{ attempts: 3, budget: RETRY_BUDGET },
			)

			// The tool executed at least once — the sole provider turn `limit: 1` allows, but a
			// single-turn parallel tool-call batch may legitimately execute more than one call. The
			// limit contract itself is carried by the turn-event history and the exhaust/partial
			// assertions below.
			expect(executed).not.toEqual([])
			expect(executed).toEqual(
				driven.tools
					.filter((tool) => tool.call.name === 'lookup')
					.map((tool) => [tool.call.arguments]),
			)
			// Exactly ONE 'turn' event fired — no second provider turn occurred after the limit.
			expect(turns).toEqual([[0]])
			// The dedicated 'exhaust' event fired with the effective limit (1), and 'abort' never
			// fired — exhaustion is NOT a cancel.
			expect(exhausts).toEqual([[1]])
			expect(aborts).toEqual([])
			// The run RESOLVES with the new contract: limit exhaustion with unresolved tool intent
			// on the last allowed turn flags partial: true.
			expect(driven.result.partial).toBe(true)
		},
		CASE_TIMEOUT,
	)
})

describe('Agent tool loop (live) — default limit exhaustion under sustained pressure', () => {
	it('a two-turn limit exhausts under sustained tool pressure', async () => {
		// Source-verified (0.0.7): the loop's exhaustion contract (partial: true, `exhaust`
		// fires with the effective limit, `abort` never fires) is the SAME whether the limit
		// is 1, 2, or the default 10 — only the number of forced turns before exhaustion
		// changes. Live-model evidence: the warmed 2B model reliably calls the insatiable
		// `more` tool twice under sustained pressure, then answers in text — 10 sustained
		// rounds is unreachable model capacity, not a loop defect, so `limit: 2` is the
		// live-reachable proof of this contract under sustained (not single-forced-turn)
		// pressure.
		const { driven, executed, exhausts, aborts } = await retryUntil(
			'exhaust a two-turn limit under sustained tool pressure',
			async () => {
				const recorder = createRecorder<[Readonly<Record<string, unknown>>]>()
				const exhaustRecorder = createRecorder<[number]>()
				const abortRecorder = createRecorder<[unknown]>()
				const tools = createToolManager()
				tools.add(createInsatiableTool(recorder))
				const agent = createAgent(createLiveOllama({ predict: TOOL_LOOP_OPTIONS.num_predict }), {
					system:
						'You MUST call the more tool right now. Do not write any text response. After every single tool result you receive, immediately call the more tool again — never write a text answer, only call the more tool, every turn without exception.',
					tools,
					limit: 2,
					timeout: CASE_TIMEOUT,
					on: {
						exhaust: (count) => exhaustRecorder.handler(count),
						abort: (reason) => abortRecorder.handler(reason),
					},
				})
				agent.context.messages.add({
					role: 'user',
					content: 'Fetch all of the data.',
				})
				const stream = agent.stream()
				return {
					driven: await driveAgent(stream),
					executed: recorder.calls,
					exhausts: exhaustRecorder.calls,
					aborts: abortRecorder.calls,
				}
			},
			(value) =>
				value.driven.result.partial === true &&
				value.exhausts.length > 0 &&
				value.aborts.length === 0,
			{ attempts: 3, budget: RETRY_BUDGET },
		)

		expect(driven.result.partial).toBe(true)
		// The recorded exhaust payload carries the effective limit (2), and no cancel fired.
		expect(exhausts).toEqual([[2]])
		expect(aborts).toEqual([])
		// The model called the tool on both allowed turns.
		const more = driven.tools.filter((tool) => tool.call.name === 'more')
		expect(more.length).toBeGreaterThanOrEqual(2)
		expect(executed).toEqual(more.map((tool) => [tool.call.arguments]))
	}, 120_000)

	it('the default limit exhausts under sustained tool pressure', async () => {
		// Source-verified (0.0.7): the same exhaustion contract as the preceding limit:2 test,
		// under NO explicit `limit` option — the loop's DEFAULT of 10. The `more` tool now
		// reports concrete counting progress ("chunk n of 12") instead of a static "call
		// again" instruction, giving the model an explicit unfinished plan to keep following
		// at temperature 0 rather than self-terminating after a couple of rounds. 12 total
		// chunks exceeds the default limit of 10, so the loop must exhaust before completion.
		const { driven, executed, exhausts, aborts } = await retryUntil(
			'exhaust the default limit under sustained tool pressure',
			async () => {
				const recorder = createRecorder<[Readonly<Record<string, unknown>>]>()
				const exhaustRecorder = createRecorder<[number]>()
				const abortRecorder = createRecorder<[unknown]>()
				const tools = createToolManager()
				tools.add(createInsatiableTool(recorder))
				const agent = createAgent(createLiveOllama({ predict: TOOL_LOOP_OPTIONS.num_predict }), {
					system:
						'You have a mission to fetch ALL 12 chunks of the requested data. You MUST call the more tool right now. Do not write any text response. After every single tool result you receive, immediately call the more tool again to get the next chunk — never write a text answer, only call the more tool, every turn without exception, until all 12 chunks have arrived.',
					tools,
					// A default-limit (10-turn) sustained round-trip needs far longer than the
					// file's 60s CASE_TIMEOUT (tuned for 1-4 turn tests) — bounded well under the
					// per-it 360_000ms timeout instead.
					timeout: 300_000,
					on: {
						exhaust: (count) => exhaustRecorder.handler(count),
						abort: (reason) => abortRecorder.handler(reason),
					},
				})
				agent.context.messages.add({
					role: 'user',
					content: 'Fetch all 12 chunks of the data.',
				})
				const stream = agent.stream()
				return {
					driven: await driveAgent(stream),
					executed: recorder.calls,
					exhausts: exhaustRecorder.calls,
					aborts: abortRecorder.calls,
				}
			},
			(value) =>
				value.driven.result.partial === true &&
				value.exhausts.length > 0 &&
				value.aborts.length === 0,
			{ attempts: 3, budget: RETRY_BUDGET },
		)

		expect(driven.result.partial).toBe(true)
		// The recorded exhaust payload carries the effective DEFAULT limit (10), and no cancel fired.
		expect(exhausts).toEqual([[10]])
		expect(aborts).toEqual([])
		// The model called the tool on more than one allowed turn.
		const more = driven.tools.filter((tool) => tool.call.name === 'more')
		expect(more.length).toBeGreaterThan(1)
		expect(executed).toEqual(more.map((tool) => [tool.call.arguments]))
	}, 360_000)
})

describe('Agent tool loop (live) — a single turn carries multiple tool calls', () => {
	it(
		'a single turn can carry multiple tool calls',
		async () => {
			const attempt = await retryUntil(
				'dispatch both tools within a single turn',
				async () => {
					const tools = createToolManager()
					tools.add(createLookupTool())
					tools.add(createInsatiableTool())
					const agent = createAgent(createLiveOllama({ predict: TOOL_LOOP_OPTIONS.num_predict }), {
						system:
							'You MUST call BOTH the lookup tool (with query "datum") AND the more tool in the SAME turn, immediately, before saying anything else.',
						tools,
						timeout: CASE_TIMEOUT,
						limit: 2,
					})
					agent.context.messages.add({
						role: 'user',
						content: 'Call both the lookup tool and the more tool right now, in the same turn.',
					})
					const stream = agent.stream()
					await driveAgent(stream)
					// The provider replays each requested turn as a stored assistant message
					// carrying its `calls` — a message with 2+ calls proves a SINGLE turn
					// dispatched multiple tool calls together (structurally observable through the
					// conversation store, not inferred from ordering).
					const multiCallTurn = agent.context.messages
						.messages()
						.some((message) => message.role === 'assistant' && (message.calls?.length ?? 0) >= 2)
					return multiCallTurn
				},
				(multiCallTurn) => multiCallTurn,
				{ attempts: 3, budget: RETRY_BUDGET },
			)

			expect(attempt).toBe(true)
		},
		CASE_TIMEOUT,
	)
})

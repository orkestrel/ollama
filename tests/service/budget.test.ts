import type { AgentResult } from '@orkestrel/agent'
import type { TokenUsage } from '@orkestrel/budget'
import { describe, expect, it } from 'vitest'
import { createAgent } from '@orkestrel/agent'
import { createTokenBudget } from '@orkestrel/budget'
import { createRecorder } from '@orkestrel/test'
import { createToolManager } from '@orkestrel/tool'
import { createLookupTool, driveAgent } from '../setupServer.js'
import { createLiveOllama, FAST_OPTIONS, retryUntil, TOOL_LOOP_OPTIONS } from '../setupService.js'

// budget.test.ts — LIVE agent-layer usage accounting + budget enforcement +
// sequential-reuse (AGENTS §16: no mocks for the inference boundary). OllamaProvider.test.ts
// already pins the PROVIDER-level usage invariants (prompt + completion === total on a single
// provider.generate() call); this file probes the AGENT layer: how createAgent's loop
// aggregates provider-level usage into AgentResult.usage / usage chunks, how an exhausted
// token budget (@orkestrel/budget's createTokenBudget) trips the loop, and whether one agent
// instance survives repeated sequential generate() calls against the resident (keep-alive)
// model. Assertions are invariants only (sums, monotonicity, resolution semantics, partial
// flags) — never exact token counts or prose.

const TIMEOUT = 60_000

describe('Agent usage (live) — single-turn usage coherence at the agent layer', () => {
	it(
		'the single usage chunk reconciles with result.usage, and prompt + completion === total',
		async () => {
			// Recipe: FAST_OPTIONS (num_predict:8) — one provider turn, one usage chunk.
			const agent = createAgent(createLiveOllama({ predict: FAST_OPTIONS.num_predict }), {
				timeout: TIMEOUT,
			})
			agent.context.messages.add({ role: 'user', content: 'Say hello.' })

			const { usages, result } = await driveAgent(agent.stream())

			// Exactly one provider call happened (no tools ⇒ no loop), so exactly one usage chunk.
			expect(usages.length).toBe(1)
			const chunkUsage = usages[0]
			expect(chunkUsage).toBeDefined()
			expect(result.usage).toBeDefined()
			if (chunkUsage === undefined || result.usage === undefined) throw new Error('usage missing')
			// AgentResult.usage is the SUMMED usage across the turn's provider calls — with exactly
			// one call, that sum equals the single chunk's usage.
			expect(result.usage.total).toBe(chunkUsage.total)
			expect(result.usage.prompt).toBe(chunkUsage.prompt)
			expect(result.usage.completion).toBe(chunkUsage.completion)
			// Provider-level invariant re-verified at the agent layer.
			expect(result.usage.prompt).toBeGreaterThan(0)
			expect(result.usage.completion).toBeGreaterThan(0)
			expect(result.usage.prompt + result.usage.completion).toBe(result.usage.total)
		},
		TIMEOUT,
	)
})

describe('Agent budget (live) — an exhausted token budget trips the loop', () => {
	it(
		'the run resolves (never rejects) with partial: true and an abort event once the budget is exhausted',
		async () => {
			// A forced multi-turn run (the lookup tool + a steering system prompt, mirroring
			// context.test.ts's forcing technique) paired with a token budget whose ceiling (5
			// completion tokens) is tiny relative to a single real completion — the first
			// provider call alone exceeds it, so the budget's signal is guaranteed exhausted
			// before the loop can make its second (post-tool) provider call. Bounded retry over
			// the small model's tool-use nondeterminism: an attempt that answers directly in one
			// turn (no second call ever attempted) would finish naturally instead of tripping, so
			// we retry until an attempt genuinely observed the trip.
			const attemptBudgetTrip = async (): Promise<{
				readonly partial: boolean
				readonly aborted: number
			}> => {
				const recorder = createRecorder<[reason: unknown]>()
				const budget = createTokenBudget({ max: 5, scope: 'completion' })
				const tools = createToolManager()
				tools.add(createLookupTool())
				const agent = createAgent(createLiveOllama({ predict: TOOL_LOOP_OPTIONS.num_predict }), {
					system:
						'You MUST call the lookup tool with query "test" to obtain the reference datum, ' +
						'then state it in your final reply. Never invent a value.',
					tools,
					budget,
					limit: 4,
					timeout: TIMEOUT,
					on: { abort: recorder.handler },
				})
				agent.context.messages.add({ role: 'user', content: 'Look up the reference datum.' })
				const result = await agent.generate()
				return { partial: result.partial, aborted: recorder.count }
			}

			const tripped = await retryUntil(
				attemptBudgetTrip,
				(value) => value.partial === true && value.aborted > 0,
				'trip the exhausted token budget mid-run',
				3,
			)

			expect(tripped.partial).toBe(true)
			expect(tripped.aborted).toBeGreaterThan(0)
		},
		TIMEOUT,
	)
})

describe('Agent budget (live) — an exhausted token budget trips MID-GENERATION', () => {
	it(
		'a tiny completion-token budget aborts mid-stream (no tool loop needed) with partial: true, an abort event, and content bounded by the budget arithmetic',
		async () => {
			// 0.0.6: content deltas are charged to the budget INCREMENTALLY as estimated tokens
			// (ceil(chars/4)) DURING a turn — so an exhausted budget now aborts mid-generation, no
			// tool loop required. Recipe: max: 5 completion tokens (tiny relative to a real
			// completion), NO tools, a prompt inviting a long answer, num_predict: 512 (headroom so
			// the daemon would otherwise keep generating well past the budget), temperature: 0.
			// Content-bound arithmetic: the estimator charges ceil(chars/4) per delta, so the budget
			// (5 tokens) trips once ~20 chars have streamed; one more in-flight delta may land before
			// the abort signal is observed. Even a generous few-hundred-char slack keeps this WELL
			// under the ~2000 chars a full 512-token completion would produce — 1000 is an honest,
			// non-brittle upper bound that still proves the trip happened mid-stream, not at natural
			// completion.
			const attemptMidStreamTrip = async (): Promise<{
				readonly partial: boolean
				readonly aborted: number
				readonly length: number
			}> => {
				const recorder = createRecorder<[reason: unknown]>()
				const budget = createTokenBudget({ max: 5, scope: 'completion' })
				const agent = createAgent(createLiveOllama({ predict: 512, temperature: 0 }), {
					budget,
					timeout: TIMEOUT,
					on: { abort: recorder.handler },
				})
				agent.context.messages.add({
					role: 'user',
					content: 'Write a long, detailed essay about the history of the printing press.',
				})
				const { result } = await driveAgent(agent.stream())
				return { partial: result.partial, aborted: recorder.count, length: result.content.length }
			}

			const tripped = await retryUntil(
				attemptMidStreamTrip,
				(value) => value.partial === true && value.aborted > 0,
				'trip the token budget mid-generation (no tool loop)',
				3,
			)

			expect(tripped.partial).toBe(true)
			expect(tripped.aborted).toBeGreaterThan(0)
			expect(tripped.length).toBeLessThan(1000)
		},
		TIMEOUT,
	)
})

describe('Agent usage (live) — multi-turn usage accumulates across provider calls', () => {
	it(
		'a ≥2-turn tool-loop run reports result.usage.total at least as large as each individual chunk',
		async () => {
			// Forced multi-turn run: the lookup tool + a steering system prompt, TOOL_LOOP_OPTIONS
			// (num_predict:64) — a tool-call turn followed by an answer turn yields ≥2 provider
			// calls, hence ≥2 usage chunks. Bounded retry (attempts=3) over the small model's
			// tool-use nondeterminism wraps the "≥2 turns happened" condition.
			const attemptMultiTurn = async (): Promise<{
				readonly usages: readonly TokenUsage[]
				readonly result: AgentResult
			}> => {
				const tools = createToolManager()
				tools.add(createLookupTool())
				const agent = createAgent(createLiveOllama({ predict: TOOL_LOOP_OPTIONS.num_predict }), {
					system:
						'You MUST call the lookup tool with query "test" to obtain the reference datum, ' +
						'then state it in your final reply. Never invent a value.',
					tools,
					limit: 4,
					timeout: TIMEOUT,
				})
				agent.context.messages.add({ role: 'user', content: 'Look up the reference datum.' })
				const { usages, result } = await driveAgent(agent.stream())
				return { usages, result }
			}

			const attempt = await retryUntil(
				attemptMultiTurn,
				(value) => value.usages.length >= 2,
				'produce a ≥2-turn tool-call loop with ≥2 usage chunks',
				3,
			)

			expect(attempt.usages.length).toBeGreaterThanOrEqual(2)
			expect(attempt.result.usage).toBeDefined()
			const total = attempt.result.usage
			if (total === undefined) throw new Error('usage missing')

			// The documented contract (AgentResult TSDoc): "usage summed across the turn's provider
			// calls" — verify the SUM matches, not just a monotonic bound, since the source
			// explicitly commits to accumulation (not last-turn-wins).
			let summedPrompt = 0
			let summedCompletion = 0
			let summedTotal = 0
			for (const usage of attempt.usages) {
				summedPrompt += usage.prompt
				summedCompletion += usage.completion
				summedTotal += usage.total
				// Monotonic bound: the final summed total is at least each individual chunk's total.
				expect(total.total).toBeGreaterThanOrEqual(usage.total)
			}
			expect(total.prompt).toBe(summedPrompt)
			expect(total.completion).toBe(summedCompletion)
			expect(total.total).toBe(summedTotal)
		},
		TIMEOUT,
	)
})

describe('Agent reuse (live) — sequential generate() calls on ONE agent stay independent', () => {
	it(
		'three sequential generate() calls on the same agent all resolve non-partial with non-empty content',
		async () => {
			// ONE agent, three sequential generate() calls (resident-model keep-alive + no
			// cross-run state bleed at the agent layer). Distinct tiny prompts, FAST_OPTIONS.
			const agent = createAgent(createLiveOllama({ predict: FAST_OPTIONS.num_predict }), {
				timeout: TIMEOUT,
			})

			const prompts = ['Say hello.', 'Say goodbye.', 'Say thanks.']
			for (const prompt of prompts) {
				agent.context.messages.add({ role: 'user', content: prompt })
				const result = await agent.generate()
				expect(result.partial).toBe(false)
				expect(result.content.trim().length).toBeGreaterThan(0)
			}
		},
		TIMEOUT,
	)
})

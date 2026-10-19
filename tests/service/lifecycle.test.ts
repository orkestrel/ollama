import type { AgentChunk, AgentResult, AgentStatus } from '@orkestrel/agent'
import { createAgent } from '@orkestrel/agent'
import { createRecorder, retryUntil } from '@orkestrel/test'
import { createToolManager } from '@orkestrel/tool'
import { describe, expect, it } from 'vitest'
import { CASE_TIMEOUT } from '../setup.js'
import { createLookupTool } from '../setupServer.js'
import { ABORT_OPTIONS, createLiveOllama, RETRY_BUDGET, STREAM_OPTIONS } from '../setupService.js'

// Agent lifecycle (live) — the AGENT-LEVEL taxonomy (streaming chunk shape, `status`
// transitions, `emitter` lifecycle events, and abort semantics) driven through the real
// `OllamaProvider` — no mocks for the inference boundary. Assertions are
// STRUCTURAL — chunk/event/status/partial mechanics — never model prose. Complements the
// deterministic Agent.test.ts (loop trigger, cancel-path shapes) with genuine live
// round-trips proving OUR plumbing (this repo's provider) drives the agent's contract
// correctly end to end. Warmed, no skipIf.

describe('Agent (live) — streamed chunk taxonomy, status lifecycle, and emitter events on one run', () => {
	it(
		'tokens assemble into result.content, a usage chunk is observed, status transitions idle→running→done, and the emitter fires start→turn→usage→finish in order matching the result',
		async () => {
			// One live generation carries three complementary structural proofs (fewer live calls): (1) the PULL chunk stream's token/usage taxonomy assembles into the
			// settled result; (2) `status` visibly transitions across the run; (3) the PUSH emitter
			// fires the documented lifecycle events in order, and `finish`'s payload IS the result.
			const provider = createLiveOllama({ predict: STREAM_OPTIONS.num_predict, temperature: 0 })
			const agent = createAgent(provider, { timeout: CASE_TIMEOUT })
			agent.context.messages.add({ role: 'user', content: 'Count from one to five.' })

			expect(agent.status).toBe('idle')

			const order = createRecorder<[string]>()
			const finishes = createRecorder<[AgentResult]>()
			agent.emitter.on('start', () => order.handler('start'))
			agent.emitter.on('turn', () => order.handler('turn'))
			agent.emitter.on('usage', () => order.handler('usage'))
			agent.emitter.on('finish', (result) => {
				order.handler('finish')
				finishes.handler(result)
			})

			const stream = agent.stream()
			const observed: Array<{ readonly chunk: AgentChunk; readonly status: AgentStatus }> = []
			for await (const chunk of stream.events) observed.push({ chunk, status: agent.status })
			const result = await stream.result
			const tokens = observed.flatMap(({ chunk }) =>
				chunk.category === 'token' ? [chunk.content] : [],
			)
			const usages = observed.flatMap(({ chunk }) =>
				chunk.category === 'usage' ? [chunk.usage] : [],
			)
			const sawRunning = observed.some(({ status }) => status === 'running')

			// (1) Chunk taxonomy: the joined token deltas assemble into the settled content, at least
			// one usage chunk was observed, and the run completed naturally (never partial).
			// This equality holds for the pinned model with native think channels — a daemon/model
			// that inlines <think> tags in content would legitimately split channels differently (see
			// OllamaProvider.ts:182-185), so a failure after a model swap may be config, not regression.
			expect(tokens.join('')).toBe(result.content)
			expect(usages.length).toBeGreaterThan(0)
			expect(result.partial).toBe(false)

			// (2) Status lifecycle: 'running' was observed mid-stream, 'done' after settling.
			expect(sawRunning).toBe(true)
			expect(agent.status).toBe('done')

			// (3) Emitter lifecycle: start fires first, finish fires last, turn + usage occur between
			// them, and the finish payload IS the settled result the stream returned.
			const calls = order.calls.map((call) => call[0])
			expect(calls[0]).toBe('start')
			expect(calls[calls.length - 1]).toBe('finish')
			expect(calls).toContain('turn')
			expect(calls).toContain('usage')
			expect(calls.indexOf('turn')).toBeGreaterThan(calls.indexOf('start'))
			expect(calls.indexOf('usage')).toBeLessThan(calls.indexOf('finish'))
			expect(finishes.calls).toEqual([[result]])
		},
		CASE_TIMEOUT,
	)
})

describe('Agent (live) — the think channel assembles into result.thinking', () => {
	it(
		'think:true separates reasoning deltas from the answer, and their join equals the settled thinking',
		async () => {
			// Recipe: num_predict 32, temperature 0 (THINK_OPTIONS-equivalent per dispatch — thinking
			// drains the budget first, so content may legitimately be empty; only the thinking channel
			// is asserted). The model's willingness to actually emit non-empty reasoning at this cap is
			// nondeterministic, so the genuinely model-dependent half (non-empty thoughts) is wrapped in
			// a bounded retry (attempts=3); the STRUCTURAL invariant (thoughts join equals
			// settled thinking) is re-asserted unconditionally on whichever attempt satisfied it.
			const { thoughts, result } = await retryUntil(
				'produce non-empty reasoning deltas under think:true',
				async () => {
					const provider = createLiveOllama({ predict: 32, temperature: 0 })
					const agent = createAgent(provider, { timeout: CASE_TIMEOUT })
					agent.context.messages.add({
						role: 'user',
						content: 'Briefly reason step by step about what 2 + 2 equals, then answer.',
					})
					const stream = agent.stream({ think: true })
					const attemptThoughts: string[] = []
					for await (const chunk of stream.events) {
						if (chunk.category === 'think') attemptThoughts.push(chunk.content)
					}
					const attemptResult = await stream.result
					return { thoughts: attemptThoughts, result: attemptResult }
				},
				// Non-empty reasoning is the model-dependent half. The join and the settled outcome are
				// the assertions below, so an attempt that breaks either is retried rather than accepted.
				(value) =>
					value.thoughts.join('').trim().length > 0 &&
					value.thoughts.join('') === value.result.thinking &&
					value.result.partial === false,
				{ attempts: 3, budget: RETRY_BUDGET },
			)

			// The joined think-chunk deltas equal the settled `thinking` field — the same assembled
			// invariant as the content/token channel, proven for the reasoning channel.
			// This equality holds for the pinned model with native think channels — a daemon/model
			// that inlines <think> tags in content would legitimately split channels differently (see
			// OllamaProvider.ts:182-185), so a failure after a model swap may be config, not regression.
			expect(thoughts.join('')).toBe(result.thinking)
			expect(result.partial).toBe(false)
		},
		CASE_TIMEOUT,
	)
})

describe('Agent (live) — abort() mid-stream resolves partial, never rejects', () => {
	it(
		'agent.abort() after the first token event settles a partial result and the emitter fires abort',
		async () => {
			// Recipe: ABORT_OPTIONS (num_predict: 64) — headroom so the generation is virtually
			// guaranteed to still be in flight when abort() fires right after the FIRST token event,
			// guarding against the race where generation finishes before the abort lands.
			const provider = createLiveOllama({
				predict: ABORT_OPTIONS.num_predict,
				temperature: ABORT_OPTIONS.temperature,
			})
			const agent = createAgent(provider, { timeout: CASE_TIMEOUT })
			agent.context.messages.add({
				role: 'user',
				content: 'Write a short paragraph describing a sunny day in a park.',
			})

			const aborts = createRecorder<[unknown]>()
			agent.emitter.on('abort', (reason) => aborts.handler(reason))

			const stream = agent.stream()
			const chunks: AgentChunk[] = []
			for await (const chunk of stream.events) {
				if (chunk.category === 'token' && !chunks.some((seen) => seen.category === 'token'))
					agent.abort('audit-abort')
				chunks.push(chunk)
			}

			// The abort landed while a token was actually observed (not a race where the run finished
			// first) — otherwise this attempt's abort proof is meaningless.
			expect(chunks.some((chunk) => chunk.category === 'token')).toBe(true)

			// result RESOLVES (never rejects) with partial: true — the documented cancel contract.
			const result = await stream.result
			expect(result.partial).toBe(true)

			// The emitter fired the abort domain event (carrying the cancel reason).
			expect(aborts.calls).toEqual([['audit-abort']])
			expect(agent.status).toBe('done')
		},
		CASE_TIMEOUT,
	)
})

describe('Agent (live) — a construction-time timeout resolves partial, never rejects', () => {
	it(
		'timeout: 1 (ms) folds into the turn cancel and settles a partial result with an abort event, completing the abort-funnel trilogy',
		async () => {
			// Completes the abort-funnel trilogy alongside external abort() (preceding) and budget
			// exhaustion (budget.test.ts): a construction-time `timeout` (ms) folds into the same
			// `AbortSignal.any` cancel the loop arms per turn. Bounded retry (attempts=3) only to
			// absorb the astronomically-rare instant-completion race.
			const { partial, reasons } = await retryUntil(
				'settle a partial result under an exhausted 1ms timeout',
				async () => {
					const provider = createLiveOllama({ predict: 32, temperature: 0 })
					const agent = createAgent(provider, { timeout: 1 })
					agent.context.messages.add({ role: 'user', content: 'Say hello.' })

					const aborts = createRecorder<[unknown]>()
					agent.emitter.on('abort', (reason) => aborts.handler(reason))

					const result = await agent.generate()
					return {
						partial: result.partial,
						reasons: aborts.calls.map(([reason]) =>
							reason instanceof Error ? reason.name : reason,
						),
					}
				},
				// The predicate is the assertion below: one abort event, and none from a second source.
				(value) =>
					value.partial === true &&
					value.reasons.length === 1 &&
					value.reasons.every((reason) => reason === 'AbortError'),
				{ attempts: 3, budget: RETRY_BUDGET },
			)

			// result RESOLVES (never rejects) with partial: true, and the emitter fired abort.
			expect(partial).toBe(true)
			expect(reasons).toEqual(['AbortError'])
		},
		CASE_TIMEOUT,
	)
})

describe('Agent (live) — a per-run timeout override reaches the loop', () => {
	it(
		'run({ timeout: 1 }) on an agent constructed with NO timeout still resolves partial with an abort event',
		async () => {
			// AgentRunOptions.timeout (0.0.6) overrides AgentOptions.timeout for this run only —
			// `??` semantics over the construction default. The agent here is constructed with NO
			// timeout at all, so a partial+abort outcome proves the PER-RUN 1ms bound reached the
			// loop, not any construction-time default.
			const { partial, reasons } = await retryUntil(
				'settle a partial result under a per-run 1ms timeout override',
				async () => {
					const provider = createLiveOllama({ predict: 32, temperature: 0 })
					const agent = createAgent(provider, {})
					agent.context.messages.add({ role: 'user', content: 'Say hello.' })

					const aborts = createRecorder<[unknown]>()
					agent.emitter.on('abort', (reason) => aborts.handler(reason))

					const result = await agent.generate({ timeout: 1 })
					return {
						partial: result.partial,
						reasons: aborts.calls.map(([reason]) =>
							reason instanceof Error ? reason.name : reason,
						),
					}
				},
				// The predicate is the assertion below: one abort event, and none from a second source.
				(value) =>
					value.partial === true &&
					value.reasons.length === 1 &&
					value.reasons.every((reason) => reason === 'AbortError'),
				{ attempts: 3, budget: RETRY_BUDGET },
			)

			expect(partial).toBe(true)
			expect(reasons).toEqual(['AbortError'])
		},
		CASE_TIMEOUT,
	)
})

describe('Agent (live) — a per-run limit override reaches the loop', () => {
	it(
		'run({ limit: 1 }) on an agent constructed with the default limit still exhausts at 1 turn, resolving partial with an exhaust event',
		async () => {
			// AgentRunOptions.limit (0.0.6) overrides AgentOptions.limit for this run only. The
			// agent here is constructed WITHOUT a limit override (the constructed default applies),
			// so an exhaust-at-1-turn outcome proves the PER-RUN limit reached the loop.
			const { partial, exhausted } = await retryUntil(
				'exhaust the per-run limit override with unresolved tool intent',
				async () => {
					const tools = createToolManager()
					tools.add(createLookupTool())
					const exhaustRecorder = createRecorder<[number]>()
					const agent = createAgent(createLiveOllama(), {
						system: 'You MUST call the lookup tool with query "datum" immediately.',
						tools,
						timeout: CASE_TIMEOUT,
						on: { exhaust: (turns) => exhaustRecorder.handler(turns) },
					})
					agent.context.messages.add({
						role: 'user',
						content: 'Call the lookup tool with query "datum" right now.',
					})
					const result = await agent.generate({ limit: 1 })
					return {
						partial: result.partial,
						exhausted: exhaustRecorder.calls.map((call) => call[0]),
					}
				},
				// The predicate is the assertion below: one exhaust event at the first turn, partial.
				(value) =>
					value.partial === true &&
					value.exhausted.length === 1 &&
					value.exhausted.every((turns) => turns === 1),
				{ attempts: 3, budget: RETRY_BUDGET },
			)

			expect(partial).toBe(true)
			expect(exhausted).toEqual([1])
		},
		CASE_TIMEOUT,
	)
})

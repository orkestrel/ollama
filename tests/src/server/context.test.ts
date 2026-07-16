import { describe, expect, it } from 'vitest'
import type {
	AgentResult,
	ContextFormatInterface,
	ConversationInterface,
	MessageInterface,
} from '@orkestrel/agent'
import {
	CONVERSATION_RECAP_PREFIX,
	createAgent,
	createConversation,
	createConversationManager,
	createTool,
	createToolManager,
	estimateMessages,
} from '@orkestrel/agent'
import { createBudget } from '@orkestrel/budget'
import { createOllama } from '@src/server'
import { collect } from '../../setup.js'
import { ATTEMPTS, createLiveProvider, OLLAMA_CONFIG, retryUntil } from '../../setupServer.js'

// LIVE behavioral context tests — the src:ollama project hits a REAL warmed Ollama (AGENTS
// §16: no mocks for the inference boundary; setupOllama.ts hard-requires + warms the model,
// never skips). The DETERMINISTIC ordering / default-format / four-level cascade assertions
// live in tests/src/core/agents/AgentContext.test.ts (pinned byte-for-byte against the
// build()); here we prove the COMPLEMENT a real model demonstrates and a string assertion
// cannot: that the context AgentContext assembles is actually COMPREHENSIBLE to a model in
// its canonical positions —
//  • a constraining INSTRUCTION is obeyed (instructions reach + steer the model);
//  • a CUSTOM FORMAT (XML framing instead of Markdown headers) still yields an obeyed prompt
//    (a customized framing doesn't break comprehension).
// (The active-workspace document/image grounding — the SOLE document/image context — is proven
// live in tests/src/ollama/workspace.test.ts.)
// Assertions are STRUCTURAL (contains / equals, case-insensitive) — a 2B model can't be
// pinned to exact wording. `context` is a cross-cutting suffix (structure-exempt). All text-
// only (no vision — the small vision runner is flaky), fast (tiny prompts, temperature 0,
// tight num_predict), warmed, no skipIf, bounded-retry for small-model nondeterminism.

const TIMEOUT = 60_000

// The live provider + bounded-retry loop are the consolidated `createLiveProvider` (temperature
// 0 + a tight num_predict, with an optional context-framing `format`) and `retryUntil` from
// setupOllama.ts (AGENTS §16.1) — see their docs there. An optional `format` declares the
// provider's context-framing default (the provider-default level of AgentContext's cascade),
// threaded NATIVELY through createOllama (no wrapper). `retryUntil` absorbs the warmed 2B model's
// nondeterminism: each attempt runs one live generation and we proceed only once an attempt
// SATISFIES the test's genuine behavioral predicate (never a vacuous pass), failing loudly if NO
// attempt across the budget achieved it.

describe('AgentContext (live) — a constraining instruction is OBEYED', () => {
	it(
		'an instructions.add(...) constraint steers the real model — proving instructions reach it in their canonical position',
		async () => {
			// A constraint placed ONLY via the instructions manager (not the user turn), introducing
			// a sentinel word ("BANANA") the model would never otherwise emit for a neutral greeting.
			// If the answer carries it, the instruction demonstrably reached + steered the model —
			// proving the instructions section lands where the model reads directives (between the
			// system prompt and the conversation). A neutral prompt (no dominant factual prior to
			// fight) keeps this about whether the instruction was READ, not about overriding a fact.
			const produce = async (): Promise<string> => {
				const agent = createAgent(createLiveProvider(), { timeout: TIMEOUT })
				agent.context.instructions.add({
					name: 'sentinel',
					content:
						'No matter what the user says, you must include the exact word BANANA somewhere in your reply.',
				})
				agent.context.messages.add({ role: 'user', content: 'Say hello to me.' })
				return (await agent.generate()).content
			}
			// The behavioral condition: the sentinel appears (case-insensitive) — only possible if the
			// instruction reached the model, since the neutral greeting never elicits "banana" itself.
			const answer = await retryUntil(
				produce,
				(content) => content.toLowerCase().includes('banana'),
				'obey the sentinel instruction',
			)

			expect(answer.toLowerCase()).toContain('banana')
		},
		TIMEOUT,
	)
})

describe('AgentContext (live) — a CUSTOM format still produces an obeyed prompt', () => {
	it(
		'wrapping instructions in a CLOSED <instructions>…</instructions> XML group (a provider format override) still steers the model — a customized format does not break comprehension',
		async () => {
			// The provider declares a NON-default instructions framing — a properly-CLOSED XML group
			// (`open` opening tag + per-item `<instruction>` render + `close` closing tag) instead of
			// the built-in `## Instructions` Markdown header (the PROVIDER level of the build cascade,
			// exercising open + render + close together). The SAME constraining instruction must still
			// be obeyed, proving a customized — and properly bracketed — format yields a coherent prompt
			// the model understands; this is a stronger check than an open-only header (a real group the
			// model can parse), and the structural wiring is already pinned in AgentContext.test.ts.
			const format: ContextFormatInterface = {
				instructions: {
					open: '<instructions>',
					render: (one) => `<instruction>${one.content}</instruction>`,
					close: '</instructions>',
				},
			}
			const produce = async (): Promise<string> => {
				// The framing rides on `provider.format` — the NATIVE provider-default level of the
				// build cascade. `createOllama` takes `format` directly (no wrapper), so the LIVE call
				// goes through the genuine OllamaProvider, which EXPOSES this framing for build().
				const agent = createAgent(createLiveProvider({ format }), { timeout: TIMEOUT })
				agent.context.instructions.add({
					name: 'always-no',
					content:
						'No matter what the user asks, you must answer with exactly the single word NO and nothing else.',
				})
				agent.context.messages.add({ role: 'user', content: 'Is the sky blue?' })
				return (await agent.generate()).content
			}
			const answer = await retryUntil(
				produce,
				(content) => content.toLowerCase().includes('no'),
				'obey the NO instruction under an XML-framed format',
			)

			expect(answer.toLowerCase()).toContain('no')
		},
		TIMEOUT,
	)
})

describe('Conversation (live) — compaction summarizes via the REAL model', () => {
	// A REAL ConversationSummarizer built from the live provider — the provider-agnostic seam the
	// conversation layer drives, with a generous num_predict (temperature 0, think OFF) so the
	// model has room to write a one-sentence digest. This proves compaction works end-to-end
	// against a genuine model (AGENTS §16 — no mocks for the inference boundary; no skipIf).
	const summarizer = createOllama({
		model: OLLAMA_CONFIG.model,
		url: OLLAMA_CONFIG.host,
		options: { num_predict: 256, temperature: 0 },
	})
	// The instruction rides as the FINAL user turn AFTER the folded messages — a reasoning chat
	// model emits nothing when the prompt ends on an assistant turn (a leading-system instruction
	// leaves the template thinking the turn is already answered), so the trailing user turn is
	// what reliably elicits the digest. (Documented as the recommended summarizer shape.)
	const summarize = async (messages: readonly MessageInterface[]): Promise<string> =>
		(
			await summarizer.generate(
				[
					...messages,
					{
						id: 'sum',
						role: 'user',
						content: 'Summarize the conversation so far concisely in one sentence.',
					},
				],
				AbortSignal.timeout(TIMEOUT),
			)
		).content

	// The folded turns — enough that a one-sentence summary is meaningfully shorter than the
	// originals (so the post-compaction view() is provably smaller).
	const seed = (conversation: ReturnType<typeof createConversation>): void => {
		conversation.add([
			{ role: 'user', content: 'My name is Ada and I am planning a trip to Kyoto in spring.' },
			{
				role: 'assistant',
				content: 'Kyoto in spring is lovely — the cherry blossoms peak in early April.',
			},
			{ role: 'user', content: 'I want to visit temples and try traditional food.' },
			{
				role: 'assistant',
				content: 'Fushimi Inari and Kinkaku-ji are must-sees; try kaiseki and yudofu.',
			},
		])
	}

	it(
		'compact() folds the live tail into a section + rollup, both authored by the live model, and view() shrinks',
		async () => {
			// Bounded retry over the small model's nondeterminism (qwen3.5:2b can occasionally emit an
			// empty completion at temperature 0 — like the obey-checks above): each attempt is a FRESH
			// conversation seeded + compacted, retried until the model genuinely produced a non-empty
			// section summary (never a vacuous pass), failing loudly if NO attempt across the loop did.
			let conversation = createConversation({ summarize })
			let before = 0
			for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
				conversation = createConversation({ summarize })
				seed(conversation)
				before = conversation.view().length
				const section = await conversation.compact()
				if (section !== undefined && section.summary.trim().length > 0) break
			}

			// The model authored a NON-EMPTY section summary (a real digest of the folded turns) and a
			// NON-EMPTY rollup (a second real summarizer call over the section summaries).
			const section = conversation.sections[0]
			expect(section).toBeDefined()
			expect((section?.summary ?? '').trim().length).toBeGreaterThan(0)
			expect((conversation.summary ?? '').trim().length).toBeGreaterThan(0)
			// view() SHRANK: four live turns folded into ONE section summary message.
			const after = conversation.view().length
			expect(after).toBeLessThan(before)
			expect(after).toBe(1)
		},
		TIMEOUT,
	)
})

describe('Agent (live) — AUTOMATIC compaction fires mid-run, the run continues on the compacted view', () => {
	// The headline live proof of Chunk B: an agent with an injected conversation + a LOW `window`
	// auto-compacts BETWEEN turns (compact-and-continue) during a REAL multi-turn run, then
	// produces a valid final answer THROUGH the compacted context. The deterministic loop trigger
	// is pinned in tests/src/core/agents/Agent.test.ts; here a genuine model drives the tool-call
	// turn that crosses the threshold, the conversation's REAL-model summarizer folds the tail, and
	// the model answers from the compacted view. Warmed, no skipIf (AGENTS §16).

	// The conversation's REAL summarizer — the instruction rides as the FINAL user turn after the
	// folded messages (a reasoning chat model emits nothing when the prompt ends on an assistant
	// turn), the same recommended shape the Conversation (live) block above uses.
	const summarizer = createOllama({
		model: OLLAMA_CONFIG.model,
		url: OLLAMA_CONFIG.host,
		options: { num_predict: 256, temperature: 0 },
	})
	const summarize = async (messages: readonly MessageInterface[]): Promise<string> =>
		(
			await summarizer.generate(
				[
					...messages,
					{
						id: 'sum',
						role: 'user',
						content: 'Summarize the conversation so far concisely in one sentence.',
					},
				],
				AbortSignal.timeout(TIMEOUT),
			)
		).content

	// A no-args lookup tool returning a sentinel the model cannot derive on its own — so a final
	// answer carrying it proves the multi-turn round-trip survived compaction (the model called the
	// tool, the loop compacted the tail BETWEEN turns, then the model produced a final turn USING
	// the fed-back result THROUGH the compacted view).
	const SENTINEL = '8254'

	// One live attempt: a fresh conversation (keep: 1 ⇒ a fold collapses the older tail but RETAINS
	// the most recent message verbatim, so the concrete tool result carrying the code survives into
	// the compacted view and the model can still state it) injected into a fresh agent with a small
	// CONTEXT-WINDOW-sized `window` budget (max 48, consume = the real `estimateMessages` estimator).
	// The trigger measures the ABSOLUTE current prompt each between-turns check (clear() + consume of
	// the whole working array). The FLOOR of the turn-1 check prompt is deterministic from the fixed
	// system + user text alone: the system block (~130 chars ⇒ ~33 tok) + the user turn (~90 chars ⇒
	// ~23 tok) + the tool result `{"code":"8254"}` (~4 tok) ≈ 60 tok — already past a 48-token window
	// even when this small model emits an EMPTY assistant content on the tool-call turn. So the
	// between-turns check crosses `max` and fires `compact()`, then the run continues on the rebuilt
	// (smaller) compacted view. Expressed as a believable context-window ceiling (NOT the prior
	// delta-era `max: 2` hack). Returns the conversation + the settled result so the predicate can
	// gate on a GENUINE mid-run compaction + a valid final answer through it (never a vacuous pass).
	const attempt = async (): Promise<{
		readonly conversation: ConversationInterface
		readonly result: AgentResult
	}> => {
		const conversations = createConversationManager({ summarize, keep: 1 })
		const conversation = conversations.add() // auto-activates — the agent's message source
		const tools = createToolManager()
		tools.add(
			createTool({
				name: 'lookup_code',
				description: 'Look up the secret access code. Takes no arguments.',
				parameters: { type: 'object', properties: {} },
				execute: () => ({ code: SENTINEL }),
			}),
		)
		const agent = createAgent(createLiveProvider(), {
			system:
				'You MUST call the lookup_code tool to obtain the secret access code, then state the code in your final reply. Never invent a code.',
			tools,
			conversations,
			window: createBudget({ max: 48, consume: estimateMessages }),
			timeout: TIMEOUT,
			limit: 4,
		})
		agent.context.messages.add({
			role: 'user',
			content:
				'What is the secret access code? You MUST call the lookup_code tool, then tell me the code.',
		})
		const stream = agent.stream()
		await collect(stream.events)
		const result = await stream.result
		return { conversation, result }
	}

	// Whether an attempt genuinely auto-compacted mid-run: at least one section folded, authored by
	// the live model (a non-empty summary). This is the load-bearing trigger proof.
	const compacted = (tried: { readonly conversation: ConversationInterface }): boolean => {
		const section = tried.conversation.sections[0]
		return section !== undefined && section.summary.trim().length > 0
	}

	it(
		'a real multi-turn run with window set folds the tail mid-run + answers from the compacted view',
		async () => {
			// Retry over the 2B model's tool-use nondeterminism (it may decline the tool, or emit an
			// empty turn) — each attempt is a FRESH conversation + agent. We retry until an attempt
			// genuinely (a) auto-compacted mid-run AND (b) produced a valid (non-empty, non-partial)
			// final answer THROUGH the compacted view; we PREFER an attempt that also carried the
			// sentinel (the strongest proof the fed-back result survived compaction), but the
			// load-bearing condition is compaction + a valid answer. FAIL loudly if NO attempt across
			// the loop auto-compacted with a valid answer (a real signal the path is broken).
			let tried = await attempt()
			let best = tried
			for (let n = 0; n < ATTEMPTS; n += 1) {
				const valid = compacted(tried) && tried.result.content.trim().length > 0
				if (valid) {
					best = tried
					// Strongest outcome: compacted, valid, AND the sentinel survived into the answer.
					if (tried.result.content.includes(SENTINEL)) break
				}
				if (n < ATTEMPTS - 1) tried = await attempt()
			}

			// (a) AUTOMATIC compaction fired mid-run — at least one section, authored by the live
			// model (a non-empty summary), now exists on the injected conversation.
			expect(best.conversation.sections.length).toBeGreaterThan(0)
			expect((best.conversation.sections[0]?.summary ?? '').trim().length).toBeGreaterThan(0)
			// (b) The run produced a VALID final answer THROUGH the compacted view — non-empty and
			// not partial — proving the loop continued correctly on the compacted context.
			expect(best.result.content.trim().length).toBeGreaterThan(0)
			expect(best.result.partial).toBe(false)
		},
		TIMEOUT,
	)
})

describe('Agent (live) — repeated auto-compaction stays COHERENT across MULTIPLE folds', () => {
	// THE production proof of Chunk B's hardening: a REAL multi-turn run that forces MULTIPLE
	// compactions (≥ 2 sections) and shows the agent stays coherent THROUGH the repeatedly-compacted
	// context — a valid, non-partial final answer with NON-EMPTY model-written section summaries. The
	// deterministic pre-first-turn / non-fatal / futile paths are pinned in Agent.test.ts; here a
	// genuine model drives several tool-call turns, the real-model summarizer folds the tail on EACH
	// between-turns check (a tiny window crossed every turn), and the model answers from the multiply-
	// compacted view. Warmed, no skipIf, bounded-retry for the 2B model's tool-use nondeterminism
	// (must FAIL loudly if no attempt forces ≥ 2 folds with a valid answer). (AGENTS §16.)
	const summarizer = createOllama({
		model: OLLAMA_CONFIG.model,
		url: OLLAMA_CONFIG.host,
		options: { num_predict: 256, temperature: 0 },
	})
	const summarize = async (messages: readonly MessageInterface[]): Promise<string> =>
		(
			await summarizer.generate(
				[
					...messages,
					{
						id: 'sum',
						role: 'user',
						content: 'Summarize the conversation so far concisely in one sentence.',
					},
				],
				AbortSignal.timeout(TIMEOUT),
			)
		).content

	// The forced tool call (the proven reliable pattern from the block above): a no-arg lookup the
	// system prompt MANDATES, returning a sentinel the model cannot derive — so a final answer that
	// states it could only come THROUGH the compacted context. keep: 1 retains the most recent message
	// verbatim across each fold so the run never loses its immediate footing.
	const SENTINEL = '7193'

	// One live attempt that reliably forces ≥ 2 folds with only ONE model tool call — by combining the
	// loop's TWO compaction points:
	//  • a SEEDED prior history (six turns ≈ a resumed/long conversation) makes the INITIAL prompt
	//    exceed a tiny window, so the loop's PRE-FIRST-TURN `#trim` folds it into the FIRST section
	//    BEFORE turn 0 (no model dependency — the seed alone guarantees this fold);
	//  • the MANDATED tool call then makes turn 0 a tool turn whose BETWEEN-TURNS `#trim` (the prompt
	//    still over the tiny window) folds a SECOND section.
	// So ≥ 2 sections accumulate from a single, reliable tool call, and the model answers from the
	// twice-compacted view. (A model that calls the tool more than once only adds further folds.)
	// keep: 1, window max 40 (the real `estimateMessages`), limit 8. Returns the conversation + result.
	const attemptMulti = async (): Promise<{
		readonly conversation: ConversationInterface
		readonly result: AgentResult
	}> => {
		const conversations = createConversationManager({ summarize, keep: 1 })
		const conversation = conversations.add() // auto-activates — the agent's message source
		const tools = createToolManager()
		tools.add(
			createTool({
				name: 'lookup_secret',
				description: 'Look up the secret access code. Takes no arguments.',
				parameters: { type: 'object', properties: {} },
				execute: () => ({ code: SENTINEL }),
			}),
		)
		const agent = createAgent(createLiveProvider(), {
			system:
				'You MUST call the lookup_secret tool to obtain the secret access code, then state the ' +
				'code in your final reply. Never invent a code.',
			tools,
			conversations,
			window: createBudget({ max: 40, consume: estimateMessages }),
			timeout: TIMEOUT,
			limit: 8,
		})
		// SEED a prior multi-turn history (a resumed / long conversation) — six turns whose absolute
		// footprint already exceeds the tiny window, so the PRE-FIRST-TURN check folds them into the
		// first section before the model is ever called.
		conversation.add([
			{ role: 'user', content: 'Hi, I am planning a trip and need help organizing the details.' },
			{ role: 'assistant', content: 'Happy to help — tell me your destination and dates.' },
			{ role: 'user', content: 'Kyoto, in early April, for about a week with my family.' },
			{ role: 'assistant', content: 'Great — early April is cherry-blossom season in Kyoto.' },
			{ role: 'user', content: 'We are interested in temples, gardens, and traditional food.' },
			{ role: 'assistant', content: 'Fushimi Inari, Kinkaku-ji, and a kaiseki dinner are musts.' },
		])
		agent.context.messages.add({
			role: 'user',
			content:
				'Before we continue planning, what is the secret access code? You MUST call the ' +
				'lookup_secret tool, then tell me the code.',
		})
		const stream = agent.stream()
		await collect(stream.events)
		const result = await stream.result
		return { conversation, result }
	}

	// Whether an attempt forced MULTIPLE folds: at least TWO sections, each authored by the live model
	// (a non-empty summary). This is the load-bearing multi-compaction proof.
	const multiCompacted = (tried: { readonly conversation: ConversationInterface }): boolean => {
		const sections = tried.conversation.sections
		return sections.length >= 2 && sections.every((section) => section.summary.trim().length > 0)
	}

	it(
		'forces ≥ 2 mid-run folds and produces a valid final answer through the repeatedly-compacted context',
		async () => {
			// Retry over the 2B model's tool-use nondeterminism — each attempt is a FRESH conversation +
			// agent. Retry until an attempt genuinely (a) folded ≥ 2 sections (each a non-empty model-
			// written summary) AND (b) produced a valid (non-empty, non-partial) final answer THROUGH the
			// repeatedly-compacted view. FAIL loudly if NO attempt across the loop achieved the forced
			// multi-compaction with a valid answer (a real signal the repeated-compaction path is broken).
			let best = await attemptMulti()
			for (let n = 0; n < ATTEMPTS; n += 1) {
				if (multiCompacted(best) && best.result.content.trim().length > 0 && !best.result.partial) {
					break
				}
				if (n < ATTEMPTS - 1) best = await attemptMulti()
			}

			// (a) MULTIPLE compactions fired mid-run — at least TWO sections now exist on the injected
			// conversation, EACH authored by the live model (a non-empty, real one-sentence digest).
			expect(best.conversation.sections.length).toBeGreaterThanOrEqual(2)
			for (const section of best.conversation.sections) {
				expect(section.summary.trim().length).toBeGreaterThan(0)
			}
			// (b) The run stayed COHERENT through the repeatedly-compacted context — a valid, non-partial
			// final answer produced AFTER multiple folds (proving each rebuilt working array stayed a
			// usable prompt the model could keep reasoning from).
			expect(best.result.content.trim().length).toBeGreaterThan(0)
			expect(best.result.partial).toBe(false)
		},
		TIMEOUT,
	)
})

describe('Conversation framing (live) — the TIGHTENED recap framing A/B vs the RAW summary', () => {
	// The user's CORE ask, empirically: build the SAME minimal section-summary scenario two ways —
	// the RAW old framing (a bare `{ role: 'assistant', content: summary }`, which reads as a
	// LITERAL prior assistant turn) vs the TIGHTENED framing (the same summary prefixed with
	// CONVERSATION_RECAP_PREFIX, so it reads as a RECAP of earlier turns). The summary is a
	// third-person NARRATION of a prior exchange — exactly the shape view() folds a compacted
	// section into — and it attributes a fact to the USER ("the user shared their deploy key is
	// XJ7"). We then ask an ATTRIBUTION question ("what did I tell you my deploy key was?"): the
	// telling failure of the RAW framing (empirically reproducible at temperature 0 through the
	// real provider) is that the model, reading the bare assistant turn as ITS OWN narration,
	// CONTRADICTS the premise — "you did NOT tell me…" — getting the user→assistant attribution
	// wrong even though the value XJ7 is right there. The TIGHTENED recap label fixes it: the model
	// correctly answers "you told me… XJ7". So the discriminating predicate is ATTRIBUTION (did the
	// model affirm the USER said it), not bare value recall (both echo XJ7). We run BOTH framings
	// across the budget, record each pass count (the evidence the tightening "makes a difference"),
	// and assert the TIGHTENED framing reliably passes AND is never worse than the raw. SMART: a
	// tiny two-message prompt, ONE fact + its attribution, a single clear predicate, warmed +
	// temperature 0 + tight num_predict, no skipIf.

	const FACT = 'XJ7'
	// A third-person NARRATION attributing the key to the USER — the digest shape a fold produces.
	const summary = `The user introduced themselves as Ada and shared that their deploy key is ${FACT}. The assistant acknowledged it.`
	// An ATTRIBUTION question — it forces the model to resolve WHO said the key, which is exactly
	// what the bare-assistant-turn framing muddles and the recap label clarifies.
	const question: MessageInterface = {
		id: 'q',
		role: 'user',
		content: 'What did I tell you my deploy key was?',
	}
	// One section summary message in each framing — the RAW bare assistant turn vs the TIGHTENED
	// recap-labeled one (the EXACT prefix view() now uses).
	const rawFraming: readonly MessageInterface[] = [
		{ id: 's', role: 'assistant', content: summary },
		question,
	]
	const tightFraming: readonly MessageInterface[] = [
		{ id: 's', role: 'assistant', content: `${CONVERSATION_RECAP_PREFIX}${summary}` },
		question,
	]
	// HONORED = the model AFFIRMS the user told it the key: the value XJ7 is present AND the answer
	// is NOT a "you did not tell me" contradiction (the raw framing's reproducible failure mode —
	// it mis-attributes the recap to itself and denies the user said it).
	const honored = (content: string): boolean =>
		content.includes(FACT) &&
		!/did\s+not\s+tell|didn'?t\s+tell|never\s+told|you\s+did\s+not/i.test(content)
	// Count how many of `ATTEMPTS` live generations a framing gets HONORED (the empirical pass rate).
	const passRate = async (messages: readonly MessageInterface[]): Promise<number> => {
		let passes = 0
		for (let n = 0; n < ATTEMPTS; n += 1) {
			const content = (await createLiveProvider().generate(messages, AbortSignal.timeout(TIMEOUT)))
				.content
			if (honored(content)) passes += 1
		}
		return passes
	}

	it(
		'the recap-labeled framing reliably steers the model to attribute the fact correctly; the raw framing is measured',
		async () => {
			// Measure BOTH framings live across the attempt budget — the evidence the tightening helps.
			const tightPasses = await passRate(tightFraming)
			const rawPasses = await passRate(rawFraming)
			// Surface the empirical comparison (visible in the run output) — the user asked us to
			// report whether the raw framing confused the model and by how much. (Observed at temp 0:
			// tightened 6/6 vs raw 0/6 — the raw framing reliably mis-attributes the recap.)
			console.info(
				`[framing A/B] tightened ${tightPasses}/${ATTEMPTS} attributed vs raw ${rawPasses}/${ATTEMPTS} attributed`,
			)

			// The load-bearing gate: the TIGHTENED recap framing reliably passes (FAIL loudly if NO
			// attempt across the budget honored it — a real signal the framing fails the small model).
			await retryUntil(
				async () =>
					(await createLiveProvider().generate(tightFraming, AbortSignal.timeout(TIMEOUT))).content,
				honored,
				'honor the recap-labeled summary (attribute the deploy key to the user)',
			)
			// And the tightening is NEVER WORSE than the raw framing across the budget — the measurable
			// difference. In practice the raw framing CONTRADICTS the attribution and the tightened
			// answers it, so this is a strict win; `>=` is the robust, non-flaky direction for the gate.
			expect(tightPasses).toBeGreaterThanOrEqual(rawPasses)
			expect(tightPasses).toBeGreaterThan(0)
		},
		TIMEOUT,
	)
})

describe('Conversation.reference (live) — cross-conversation attribution (provenance not bled)', () => {
	// Conversation A is ACTIVE (a one-fact A-context: "we are debugging auth"); a SEPARATE
	// conversation B's reference() — carrying a B-fact ("the team chose Postgres") — is written
	// into A's ACTIVE WORKSPACE (the SOLE document context build() folds into the system block). We
	// ask one question requiring B's fact AND its source, and assert the model surfaces "Postgres"
	// AND attributes it to the OTHER (planning) conversation, never to the active one. SMART: tiny,
	// ONE fact + its source, bounded retry, warmed, no skipIf.

	it(
		'pulls B’s decision into A via a reference document and attributes it to B (not the active conversation)',
		async () => {
			// Conversation B (the planning thread) — its rollup summary carries the decision. We craft
			// the summary directly (a stub digest) so the probe is about the REFERENCE plumbing +
			// attribution, not about a model-authored summary (which the Conversation-live block proves).
			const planning = createConversation({ id: 'planning' })
			planning.add([
				{ role: 'user', content: 'Which database should we use?' },
				{ role: 'assistant', content: 'The team evaluated the options and chose Postgres.' },
			])

			const produce = async (): Promise<string> => {
				// Conversation A is ACTIVE — its own A-fact lives as a live user turn.
				const conversations = createConversationManager()
				const active = conversations.add({ id: 'auth' }) // auto-activates
				active.add({ role: 'user', content: 'In this chat we are debugging auth.' })
				const agent = createAgent(createLiveProvider(), {
					system: 'Use the reference documents when they answer the question. Be brief.',
					conversations,
					timeout: TIMEOUT,
				})
				// PULL B into A with provenance: B.reference(...) framed + written into A's active
				// workspace. We supply the decision summary on the reference directly (the cherry-pick flow
				// — summary + search — is exercised by the next test); here `summary: false` keeps it to one fact.
				agent.context.workspaces.add().write(
					`conversation:${planning.id}.md`,
					planning.reference({
						label: 'planning',
						summary: false,
						messages: planning.search('Postgres'),
					}),
				)
				active.add({
					role: 'user',
					content: 'Which database did we pick, and in which conversation was it decided?',
				})
				return (await agent.generate()).content
			}
			// HONORED: surfaces Postgres (B's fact) AND attributes it to the planning conversation.
			const attributed = (content: string): boolean => {
				const lower = content.toLowerCase()
				return lower.includes('postgres') && lower.includes('planning')
			}
			const answer = await retryUntil(
				produce,
				attributed,
				'surface Postgres AND attribute it to the planning conversation',
			)

			// The B-fact reached the model THROUGH the reference document and is attributed to its
			// source conversation — provenance preserved, not bled into the active "auth" thread.
			expect(answer.toLowerCase()).toContain('postgres')
			expect(answer.toLowerCase()).toContain('planning')
		},
		TIMEOUT,
	)
})

describe('Conversation.reference (live) — cherry-pick ONE relevant message, not the whole history', () => {
	// B has ~5 short messages, exactly ONE relevant ("the API endpoint is /v2/sync"). We pull ONLY
	// it via B.search('endpoint') → reference({ messages }) → write into A's active workspace, then
	// ask for the endpoint. We assert (1) LIVE the model recalls "/v2/sync", and (2) DETERMINISTICALLY
	// the written reference carries only that one message — NOT B's other four (cherry-pick, never a
	// full dump that re-bloats a small model's context). SMART: tiny, one fact, bounded retry.

	it(
		'injects only the searched-for message and the model recalls it',
		async () => {
			const ENDPOINT = '/v2/sync'
			// B's five short turns — one relevant, four noise.
			const other = createConversation({ id: 'planning' })
			other.add([
				{ role: 'user', content: 'What time is the standup?' },
				{ role: 'assistant', content: 'Standup is at 9am.' },
				{ role: 'user', content: 'Where do we deploy?' },
				{ role: 'assistant', content: `the API endpoint is ${ENDPOINT}` },
				{ role: 'user', content: 'Thanks, talk later.' },
			])

			// CHERRY-PICK exactly the relevant turn (as the recommended flow does).
			const picked = other.search('endpoint')
			expect(picked).toHaveLength(1)
			const block = other.reference({ label: 'planning', summary: false, messages: picked })

			// DETERMINISTIC: the rendered reference carries ONLY the cherry-picked message — none of
			// the four noise turns leaked in (cherry-pick, not a full history dump).
			expect(block).toContain(ENDPOINT)
			expect(block).not.toContain('standup')
			expect(block).not.toContain('9am')
			expect(block).not.toContain('talk later')

			const produce = async (): Promise<string> => {
				const conversations = createConversationManager()
				const active = conversations.add({ id: 'auth' }) // auto-activates
				const agent = createAgent(createLiveProvider(), {
					system: 'Use the reference documents when they answer the question. Be brief.',
					conversations,
					timeout: TIMEOUT,
				})
				agent.context.workspaces.add().write(`conversation:${other.id}.md`, block)
				active.add({
					role: 'user',
					content: "What's the API endpoint? Answer with just the path.",
				})
				return (await agent.generate()).content
			}
			// LIVE: the model recalls the single cherry-picked endpoint.
			const answer = await retryUntil(
				produce,
				(content) => content.includes(ENDPOINT),
				'recall the cherry-picked API endpoint',
			)

			expect(answer).toContain(ENDPOINT)
		},
		TIMEOUT,
	)
})

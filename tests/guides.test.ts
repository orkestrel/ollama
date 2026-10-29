// The consumer-side guides-parity entry runs `@orkestrel/guide` against this
// repository's own `guides/README.md` manifest. The constants that follow are this
// package's own, as is the executed section that closes the file.

import type { JudgeQuestion } from '@orkestrel/agent'
import { GuideCommand } from '@orkestrel/guide/server'
import { readInventory } from '@orkestrel/test/server'
import { createVitest } from 'vitest/node'

/** Every fence language this package's guides are allowed to use. */
const FENCE_LANGUAGES = Object.freeze(['ts'])
/** The fence language whose blocks count as worked examples. */
const EXAMPLE_LANGUAGE = 'ts'
/** The one guide this package sources, whose tagline the README pitch equals. */
const GUIDE_SPEC = 'guides/ollama.md'
/** The README, whose own sample fences the executed half guards beside the guide's. */
const README_SPEC = 'README.md'
/** The package identity that binds its manifest, module map, and README pitch. */
const PACKAGE_NAME = '@orkestrel/ollama'
/** Each import specifier this package's own guides may resolve against, per published face. */
const MODULES = Object.freeze({
	[PACKAGE_NAME]: 'src/core',
	'@src/core': 'src/core',
	[`${PACKAGE_NAME}/server`]: 'src/server',
	'@src/server': 'src/server',
})
/**
 * Declarations deliberately kept out of the barrel, as `computeSymbolKey` strings.
 *
 * A class that one-class-per-file evicted from its single consumer cannot become a
 * local, so it stays exported without being public. Naming it here is what makes that
 * intentional rather than forgotten, and the assertion that follows it fails when a name
 * here stops being stranded, so the list cannot rot.
 */
const INTERNAL: readonly string[] = Object.freeze([])

await new GuideCommand({
	root: new URL('../', import.meta.url),
	patterns: ['src/**/*.ts', 'tests/**/*.ts', 'guides/*.md', '*.md', 'package.json'],
	modules: MODULES,
	languages: FENCE_LANGUAGES,
	language: EXAMPLE_LANGUAGE,
	reader: readInventory,
	runner: createVitest,
}).execute(async ({ files, report, rows }) => {
	const { isRecord, parseJSON } = await import('@orkestrel/contract')
	const { computeSymbolKey, findMissingSymbols } = await import('@orkestrel/guide')
	// The setup module resolves only under the runner, so it loads inside this callback.
	const { createOllamaInstructionFormat } = await import('./setupServer.js')
	const {
		computeReading,
		createAgent,
		createInstructionManager,
		createSystemOneJudge,
		createRelay,
		createRelayProvider,
		isProviderError,
		isJudgeAbortError,
		JudgeError,
	} = await import('@orkestrel/agent')
	const { createNDJSONParser } = await import('@orkestrel/ndjson')
	const { createDispatcher } = await import('@orkestrel/router')
	const { captureError, createRecorder, requireValue } = await import('@orkestrel/test')
	const barrel = await import('@src/core')
	const {
		createOllama,
		OllamaProvider,
		createOllamaJudge,
		OllamaJudge,
		buildJudgeLabels,
		computeAnswer,
		escapeSpecialTokens,
		extractTopLogprobs,
		renderJudgeIdentity,
		renderJudgePrompt,
	} = barrel
	const {
		createOllamaDaemon,
		isOllamaError,
		isOllamaOrigin,
		readOllamaTerminal,
		retainOllamaBytes,
		verifyOllamaModels,
	} = await import('@src/server')
	const {
		createRelayServer,
		createStreamingTransport,
		createRecordingTransport,
		drive,
		extractStreamFences,
		JUDGE_RAW_NOUL,
		JUDGE_SYSTEM_ONE,
		JUDGE_NOUL_REQUEST,
		JUDGE_SYSTEM_REQUEST,
		JUDGE_WIRE_NOUL,
		JUDGE_WIRE_CHOICE,
		JUDGE_CHOICE_REQUEST,
		JUDGE_WIRE_SYSTEM,
		JUDGE_INVALID_QUESTIONS,
		MICA_SYSTEM,
		MICA_CALIBRATION,
		observeFence,
		OBFUSCATED,
	} = await import('./setupServer.js')
	const { buildFenceObservation, FENCE_MODEL, GUIDE_FENCE_PROMPT, HELLO_TURN, STREAM_FENCE_CASES } =
		await import('./setup.js')
	const { describe, expect, it } = await import('vitest')
	const manifest = parseJSON(requireValue(files['package.json'], 'Missing inventory: package.json'))
	if (!isRecord(manifest)) throw new Error('Invalid package manifest: package.json')

	it('manifest lists at least one guide', () => {
		expect(report.input).toEqual([])
		expect(rows.length).toBeGreaterThan(0)
		expect(rows.map((row) => row.entry.spec)).toContain(GUIDE_SPEC)
	})

	// The example half of the equality case is silent over an empty population: with no
	// title on either side, the comparison has no pair. This pins the population this
	// repository's own guide contributes.
	it('pairs at least one example title across the guide and the source', () => {
		expect(report.examples.titles.filter((finding) => finding.spec === GUIDE_SPEC)).toEqual([])
		expect(files['src/core/OllamaJudge.ts']).toContain('@example Ask Mica a noul')
		expect(files[GUIDE_SPEC]).toContain('### Ask Mica a noul')
	})

	it('opens the README with the guide tagline', () => {
		expect(manifest.name).toBe(PACKAGE_NAME)
		expect(report.pitch).toEqual([])
	})

	for (const { entry, guide, source } of rows) {
		describe(`${entry.concept}`, () => {
			it('uses only listed fence languages', () => {
				expect(report.fences.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('extracts a non-empty documented surface', () => {
				expect(guide.surface().length).toBeGreaterThan(0)
			})

			it('carries a summary for every documented and declared symbol', () => {
				expect(guide.surface().filter((symbol) => symbol.summary === undefined)).toEqual([])
				expect(source.surface().filter((symbol) => symbol.summary === undefined)).toEqual([])
			})

			it('re-exports every direct declaration that is not named internal', () => {
				const stranded = findMissingSymbols(source.exports(), source.surface())
				expect(stranded.filter((key) => !INTERNAL.includes(key))).toEqual([])
			})

			it('names no symbol internal that the barrel already exports', () => {
				const stranded = findMissingSymbols(source.exports(), source.surface())
				expect(INTERNAL.filter((key) => !stranded.includes(key))).toEqual([])
			})

			it('re-exports only direct declarations', () => {
				expect(findMissingSymbols(source.surface(), source.exports())).toEqual([])
			})

			it('documents every barrel export', () => {
				expect(findMissingSymbols(source.surface(), guide.surface())).toEqual([])
			})

			it('documents only barrel exports', () => {
				expect(findMissingSymbols(guide.surface(), source.surface())).toEqual([])
			})

			it('exposes no hidden module-scope declarations', () => {
				expect(source.hidden().map(computeSymbolKey)).toEqual([])
			})

			it('documents a populated method group', () => {
				expect(report.sections.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('keeps behavioral interfaces and implementing classes in parity', () => {
				expect(report.methods.filter((finding) => finding.spec === entry.spec)).toEqual([])
				expect(report.declarations.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('keeps every compared summary and example equal to its source', () => {
				expect(report.drift.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('documents an example for every Surface function', () => {
				expect(report.examples.fences.filter((finding) => finding.spec === entry.spec)).toEqual([])
				expect(report.examples.functions.filter((finding) => finding.spec === entry.spec)).toEqual(
					[],
				)
			})

			it('documents an example for every method', () => {
				expect(report.examples.methods.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('imports only real exports in every ```ts fence', () => {
				expect(report.imports.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('resolves every relative link', () => {
				expect(report.links.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('links only to test files that exist', () => {
				expect(report.tests.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})
		})
	}

	describe('judge contract', () => {
		it('clause 16: preserves the recorded renders and the TypeSafe boundary cases', () => {
			const noul = requireValue(JUDGE_NOUL_REQUEST.questions.deletion, 'Missing noul')
			const choice = requireValue(JUDGE_CHOICE_REQUEST.questions.team, 'Missing choice')
			expect(renderJudgePrompt(JUDGE_NOUL_REQUEST.state, noul, MICA_SYSTEM)).toBe(
				JUDGE_WIRE_NOUL.prompt,
			)
			expect(renderJudgePrompt(JUDGE_CHOICE_REQUEST.state, choice, MICA_SYSTEM)).toBe(
				JUDGE_WIRE_CHOICE.prompt,
			)
			expect(
				renderJudgePrompt(
					{ n: 1e-7 },
					{ form: 'noul', criteria: { false: '', true: '' } },
					'system',
				),
			).toBe(
				'<|im_start|>system\nsystem<|im_end|>\n<|im_start|>user\n<state>\n{\n "n": 1e-7\n}\n</state>\nQuestion: \nCriteria:\nfalse: false\ntrue: true\nAnswer Yes if true, or No if false.<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n',
			)
			expect(
				renderJudgePrompt(
					'',
					{ form: 'choice', criteria: { c١: null, named: '<think>' } },
					'system',
				),
			).toContain('Candidates:\nA) None\nB) [named] <\u200bthink>\n')
		})
		it('clause 17: sends separate raw requests and reads only candidate logprobs and valid usage', async () => {
			const transport = createRecordingTransport(
				createStreamingTransport([JSON.stringify(JUDGE_RAW_NOUL)]),
			)
			const judge = new OllamaJudge({
				model: JUDGE_WIRE_NOUL.model,
				system: MICA_SYSTEM,
				calibration: MICA_CALIBRATION,
				options: { temperature: 0, num_predict: 99 },
				fetch: transport.fetch,
			})
			const result = await judge.ask(
				{ state: '', questions: { deletion: { form: 'noul' }, permission: { form: 'noul' } } },
				new AbortController().signal,
			)
			expect(transport.requests).toHaveLength(2)
			for (const request of transport.requests) {
				expect(request.method).toBe('POST')
				expect(request.path).toBe('/api/generate')
				expect(request.body).toMatchObject({
					raw: true,
					stream: false,
					logprobs: true,
					top_logprobs: 20,
					options: { num_predict: 1, temperature: 1 },
				})
			}
			expect(result.usage).toEqual({ prompt: 276, completion: 2, total: 278 })
			const answer = requireValue(result.answers.deletion, 'Missing answer')
			expect(computeReading(answer).probability).toBeCloseTo(0.9899737974147249, 12)
			expect(
				extractTopLogprobs({
					logprobs: [
						{ top_logprobs: [{ token: ' No', logprob: -1 }] },
						{ top_logprobs: [{ token: 'Yes', logprob: 0 }] },
					],
				}),
			).toEqual([{ token: ' No', logprob: -1 }])
			expect(() =>
				extractTopLogprobs({ logprobs: [{ top_logprobs: [{ token: 'No', logprob: NaN }] }] }),
			).toThrow(JudgeError)
			expect(() =>
				extractTopLogprobs({
					logprobs: [
						{
							top_logprobs: [
								{ token: 'No', logprob: 0 },
								{ token: 'No', logprob: 0 },
							],
						},
					],
				}),
			).toThrow(JudgeError)
			expect(
				judge.read({ ...JUDGE_RAW_NOUL, eval_count: -1 }, JUDGE_NOUL_REQUEST).usage,
			).toBeUndefined()
			expect(
				judge.read({ ...JUDGE_RAW_NOUL, eval_count: undefined }, JUDGE_NOUL_REQUEST).usage,
			).toBeUndefined()
		})
		it('clause 18: retains the other answers and spent usage after a missing-label refusal', async () => {
			const transport = createRecordingTransport(
				createStreamingTransport([JSON.stringify(JUDGE_RAW_NOUL)]),
			)
			const judge = createOllamaJudge({
				model: JUDGE_WIRE_NOUL.model,
				system: MICA_SYSTEM,
				fetch: transport.fetch,
			})
			const result = await judge.ask(
				{
					state: '',
					questions: {
						routing: {
							form: 'choice',
							criteria: { billing: null, technical: null, sales: null, account: null },
						},
						permission: { form: 'noul' },
					},
				},
				new AbortController().signal,
			)
			expect(result.refusals).toEqual({ routing: { missing: ['account'] } })
			expect(Object.keys(result.answers)).toEqual(['permission'])
			expect(result.usage).toEqual({ prompt: 276, completion: 2, total: 278 })
		})
		it('clause 19: enforces Mica limits before transport and accepts numeric residency', async () => {
			const transport = createRecordingTransport(
				createStreamingTransport([JSON.stringify(JUDGE_RAW_NOUL)]),
			)
			const judge = new OllamaJudge({
				model: JUDGE_WIRE_NOUL.model,
				system: MICA_SYSTEM,
				fetch: transport.fetch,
				keepAlive: 0,
			})
			for (const question of JUDGE_INVALID_QUESTIONS) {
				await expect(
					judge.ask(
						{ state: '', questions: { valid: { form: 'noul' }, invalid: question } },
						new AbortController().signal,
					),
				).rejects.toMatchObject({
					code: 'QUESTION',
					message: expect.stringMatching(/^judge error: question invalid /),
				})
			}
			expect(transport.requests).toEqual([])
			expect(() => buildJudgeLabels({ form: 'choice', criteria: { alone: null } })).toThrow(
				JudgeError,
			)
			expect(buildJudgeLabels({ form: 'choice', criteria: { yes: null, no: null } }).size).toBe(2)
			expect(
				buildJudgeLabels({
					form: 'choice',
					criteria: Object.fromEntries(
						Array.from({ length: 20 }, (_, index) => [String(index), null]),
					),
				}).size,
			).toBe(20)
			expect(buildJudgeLabels({ form: 'score', criteria: ['low', 'high'] }).size).toBe(2)
			expect(
				buildJudgeLabels({
					form: 'score',
					criteria: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'],
				}).size,
			).toBe(10)
			expect(judge.encode(JUDGE_NOUL_REQUEST).keep_alive).toBe(0)
			expect(
				new OllamaJudge({ model: JUDGE_WIRE_NOUL.model, system: MICA_SYSTEM }).encode(
					JUDGE_NOUL_REQUEST,
				).keep_alive,
			).toBe('5m')
		})
		it('clause 20: carries effective identity through results and retains completed work on cancellation', async () => {
			const transport = createRecordingTransport(
				createStreamingTransport([JSON.stringify(JUDGE_RAW_NOUL)]),
			)
			const abort = new AbortController()
			const judge = new OllamaJudge({
				model: JUDGE_WIRE_NOUL.model,
				system: MICA_SYSTEM,
				options: { num_ctx: 8192, seed: 42 },
				fetch: transport.fetch,
				headers: () => {
					if (transport.requests.length === 1) abort.abort()
					return {}
				},
			})
			const identity = renderJudgeIdentity({
				model: JUDGE_WIRE_NOUL.model,
				system: MICA_SYSTEM,
				options: { seed: 42, num_ctx: 8192 },
			})
			expect(judge.model).toBe(identity)
			expect(judge.read(JUDGE_RAW_NOUL, JUDGE_NOUL_REQUEST).model).toBe(identity)
			expect(
				renderJudgeIdentity({
					model: JUDGE_WIRE_NOUL.model,
					system: MICA_SYSTEM,
					options: { seed: 42, num_ctx: 4096 },
				}),
			).not.toBe(identity)
			const error: unknown = await judge
				.ask(
					{ state: '', questions: { permission: { form: 'noul' }, routing: { form: 'noul' } } },
					abort.signal,
				)
				.catch((caught: unknown) => caught)
			if (!isJudgeAbortError(error)) throw new Error('Expected judge abort', { cause: error })
			expect(error.partial.model).toBe(identity)
			expect(Object.keys(error.partial.answers)).toEqual(['permission'])
			expect(error.partial.usage).toEqual({ prompt: 138, completion: 1, total: 139 })
			expect(transport.requests).toHaveLength(1)
		})
	})

	// The EXECUTED half. Every preceding check reads a name from guide or source text.
	// These cases run the flagship fences and assert the values their comments claim. Only
	// the hermetic half runs here: the `guides` project has no daemon, so a fence claim about
	// a live model's output is asserted in `tests/service/`.
	describe('flagship fences', () => {
		it('executes Ask Mica a noul over the recorded raw body', async () => {
			const transport = createRecordingTransport(
				createStreamingTransport([JSON.stringify(JUDGE_RAW_NOUL)]),
			)
			const judge = createOllamaJudge({
				model: 'hf.co/sky7350/Mica-v0.1-4B:Q4_K_M',
				system: MICA_SYSTEM,
				calibration: { temperature: 1.1244734010661372 },
				timeout: 300000,
				options: { num_ctx: 8192 },
				fetch: transport.fetch,
			})
			const request = {
				state: 'The user asked to delete the staging database. No approval has been given.',
				questions: {
					deletion: {
						form: 'noul',
						instructions: 'Should the agent delete it now?',
						criteria: {
							false: 'Do not delete. No approval has been given.',
							true: 'Delete the staging database now.',
						},
					},
				},
			} as const
			expect(request).toEqual(JUDGE_NOUL_REQUEST)
			const result = await judge.ask(request, new AbortController().signal)
			const answer = result.answers.deletion
			if (answer === undefined) throw new Error('Missing deletion answer')
			expect(computeReading(answer).winner).toBe('false')
			expect(computeReading(answer).probability).toBeCloseTo(0.99, 3)
			expect(transport.requests[0]?.body.prompt).toBe(JUDGE_WIRE_NOUL.prompt)
		})

		it('executes Ask a native decision model over the recorded System One body', async () => {
			const transport = createRecordingTransport(
				createStreamingTransport([JSON.stringify(JUDGE_SYSTEM_ONE)]),
			)
			const judge = createSystemOneJudge({
				url: 'http://localhost:11434',
				model: 'tev1:0.8b',
				fetch: transport.fetch,
			})
			const request = {
				state: 'Our checkout has returned 500 errors since 9am. I want a refund for today.',
				questions: {
					label: {
						form: 'choice',
						instructions: 'Which label fits this ticket?',
						criteria: {
							billing: 'Payments and refunds',
							bug: 'Software errors',
							account: null,
						},
					},
					refund: {
						form: 'noul',
						instructions: 'Does the customer ask for money back?',
						criteria: {
							true: 'The customer asks for a refund or for money back.',
							false: 'The customer does not ask for money back.',
						},
					},
					severity: {
						form: 'score',
						instructions: 'How severe is the reported issue?',
						criteria: [
							'Cosmetic; no impact',
							'Degraded, workaround exists',
							'Blocking; no workaround',
						],
					},
				},
			} as const
			expect(request).toEqual(JUDGE_SYSTEM_REQUEST)
			const result = await judge.ask(request, new AbortController().signal)
			expect(Object.keys(result.answers)).toEqual(['label', 'refund', 'severity'])
			expect(result.answers.label?.form).toBe('choice')
			expect(result.answers.refund?.form).toBe('noul')
			expect(result.answers.severity?.form).toBe('score')
			expect(transport.requests).toHaveLength(1)
			expect(transport.requests[0]?.path).toBe('/v1/systemone')
			expect(transport.requests[0]?.body).toEqual(JUDGE_WIRE_SYSTEM)
			const readings = Object.fromEntries(
				Object.entries(result.answers).map(([id, answer]) => [id, computeReading(answer)]),
			)
			expect(readings.label?.winner).toBe('bug')
			expect(readings.label?.confidence).toBeCloseTo(0.9536250219153858, 12)
			expect(readings.refund?.probability).toBeCloseTo(0.9978973674111222, 12)
			expect(readings.severity?.score).toBeCloseTo(0.9919248376139791, 12)
		})

		it('executes Inspect the raw judge wire', () => {
			const question: JudgeQuestion = { form: 'noul' }
			expect(escapeSpecialTokens('<think>')).toBe('<\u200bthink>')
			const labels = buildJudgeLabels(question)
			expect(labels.get('false')).toBe('No')
			const options = { model: 'mica', system: 'Judge the state.' }
			const prompt = renderJudgePrompt('Approved.', question, options.system)
			const identity = renderJudgeIdentity(options)
			const response = {
				done: true,
				logprobs: [
					{
						top_logprobs: [
							{ token: 'No', logprob: 0 },
							{ token: 'Yes', logprob: 0 },
						],
					},
				],
			}
			expect(computeAnswer(question, extractTopLogprobs(response))).toEqual({
				form: 'noul',
				noul: 0.5,
			})
			const judge = new OllamaJudge(options)
			const request = { state: 'Approved.', questions: { approval: question } }
			expect(judge.encode(request).prompt).toBe(prompt)
			expect(judge.read(response, request).model).toBe(identity)
		})
		const guideText = requireValue(files[GUIDE_SPEC], `Missing file: ${GUIDE_SPEC}`)
		const readmeText = requireValue(files[README_SPEC], `Missing file: ${README_SPEC}`)
		const fences = extractStreamFences(guideText, readmeText)

		// `guides/ollama.md` § Surface: the primary fence creates a provider, then generates.
		it('createOllama returns a named provider exposing generate and stream', () => {
			const provider = createOllama({ model: FENCE_MODEL })

			expect(provider.name).toBe('ollama')
			expect(typeof provider.generate).toBe('function')
			expect(typeof provider.stream).toBe('function')
		})

		// `guides/ollama.md` § Surface: the streaming fence, from its first import to the end of its
		// `catch` arm, executed as the guide shows it over a plain turn, a turn the daemon
		// reclassifies, a turn the caller cancels after its first delta, and a turn the daemon
		// refuses. The fence runs with its real imports and the global `fetch` replaced by the
		// scenario's transport. It logs what it reads, so `console` is the recorder those
		// `console.log` calls reach; every other line is the consumer's code. The observation holds the
		// logged values, the deltas, the fence's message list, the whole body of each request, and what
		// the fence threw. The plain turn joins to its settled content, the reclassified one settles
		// to content the joined deltas no longer match, the cancelled one reaches the `catch` arm,
		// which reads `error.partial.content` on its own rather than appended onto the accumulated
		// deltas, so it is not duplicated, and the refused one is not an abort, so the `else` arm
		// rethrows the daemon's 404.
		for (const scenario of STREAM_FENCE_CASES) {
			it(scenario.title, async () => {
				const observed = await observeFence(fences.guide, scenario)

				expect(observed).toEqual(buildFenceObservation(scenario, 'guide'))
			})
		}

		// `README.md`: the usage fence and the streaming fence after it, executed as one flow over the
		// two turns that settle. The usage fence's `generate` call and the streaming fence's `stream`
		// call each send the README's prompt, and the observation holds both whole request bodies.
		for (const scenario of STREAM_FENCE_CASES.filter(
			(candidate) => candidate.settled !== undefined,
		)) {
			it(`executes the README streaming fence over ${scenario.label}`, async () => {
				const observed = await observeFence(fences.readme, scenario)

				expect(observed).toEqual(buildFenceObservation(scenario, 'readme'))
			})
		}

		// The guide's streaming fence reads the same boundaries and the same settled result the
		// stream yields: the deltas split where the daemon's records do, the reasoning arrives on its
		// own channel, and the settled result carries the content, the reasoning, and the usage. A
		// reclassified turn settles to the content after the bare close and the reasoning before it.
		for (const scenario of STREAM_FENCE_CASES.filter(
			(candidate) => candidate.settled !== undefined,
		)) {
			it(`settles ${scenario.label} to the result the fences read`, async () => {
				const driven = await drive(
					createOllama({
						model: FENCE_MODEL,
						fetch: createStreamingTransport(scenario.chunks),
					}).stream(
						[{ id: '1', role: 'user', content: GUIDE_FENCE_PROMPT }],
						new AbortController().signal,
					),
				)

				expect(driven).toEqual({
					deltas: (scenario.deltas ?? [])
						.filter((delta) => delta.channel === 'content')
						.map((delta) => delta.text),
					thoughts: (scenario.deltas ?? [])
						.filter((delta) => delta.channel === 'thinking')
						.map((delta) => delta.text),
					result: scenario.settled,
				})
			})
		}

		// The comments that carry the claim each executed fence proves stay in the fences, beside the
		// executed assertions above, so a fence that drops its claim fails here.
		it('keeps the comment on each streaming fence line that states what the line returns', () => {
			expect(guideText).toContain(
				'console.log(result.content) // the answer — the settled content is the authoritative one',
			)
			expect(guideText).toContain(
				"console.log(answer.join('')) // what arrived on the content channel, which a reclassified <think> span leaves longer",
			)
			expect(readmeText).toContain(
				'console.log(streamed.content) // the answer — the settled content is the authoritative one',
			)
			expect(readmeText).toContain(
				"console.log(answer.join('')) // what arrived on the content channel",
			)
		})

		// `guides/ollama.md` § Projecting the wire without a daemon: the seam members,
		// driven directly with no socket and no daemon.
		it('answers the seam fence with the projected body, the framed record, and the read increment', () => {
			const provider = new OllamaProvider({ model: 'qwen3.5:2b-q4_K_M', keepAlive: '9m' })
			const request = provider.encode({
				messages: [{ id: '1', role: 'user', content: 'Say hello.' }],
				options: { think: true },
			})
			const parser = provider.frame()

			expect(request.stream).toBe(true)
			expect(request.think).toBe(true)
			expect(request.keep_alive).toBe('9m')
			expect(request.messages).toEqual([{ role: 'user', content: 'Say hello.' }])
			expect(parser.parse('{"message":{"content":"Hel"}}\n')).toEqual([
				{ message: { content: 'Hel' } },
			])
			expect(
				provider.read({
					message: { content: 'lo' },
					done: true,
					prompt_eval_count: 3,
					eval_count: 4,
				}),
			).toEqual({
				content: 'lo',
				thinking: '',
				tools: [],
				usage: { prompt: 3, completion: 4, total: 7 },
			})
			expect(provider.finish(parser)).toEqual([])
		})

		it('carries the seam fence lines the transcription copies', () => {
			expect(guideText).toContain('request.stream // true — every call streams')
			expect(guideText).toContain(
				'request.think // true — the per-call override beats the constructed default',
			)
			expect(guideText).toContain("request.keep_alive // '9m'")
			expect(guideText).toContain(
				'parser.parse(\'{"message":{"content":"Hel"}}\\n\') // [{ message: { content: \'Hel\' } }]',
			)
			expect(guideText).toContain('provider.finish(parser) // [] — the parser held nothing back')
		})

		// `guides/ollama.md` § Running in the browser: the same call with `url` pointed at
		// whatever the page can reach.
		it('names the provider the browser fence builds against a remote url', () => {
			const provider = createOllama({
				model: 'qwen3.5:2b-q4_K_M',
				url: 'https://llm.example.com',
			})

			expect(provider.name).toBe('ollama')
		})

		// `guides/ollama.md` § Relaying through your own server: both halves, each in the
		// composition its fence shows. The server half runs through `createRelayServer`,
		// which is that fence — `createRelay` over a real `OllamaProvider`, an
		// `@orkestrel/router` dispatcher on `POST /inference`, and an `@orkestrel/server`
		// listener started with `start` and stopped with `stop` — with the fixture's own
		// bearer and an ephemeral loopback port in place of the fence's literals. The
		// browser half is the fence's own call over the page's own `fetch`, dialling the
		// url the server half bound with that same bearer. Only the daemon is canned.
		it('round trips the relay fences over a real loopback server the browser half dials', async () => {
			const server = await createRelayServer(
				createOllama({ model: 'qwen3.5:2b-q4_K_M', fetch: createStreamingTransport(HELLO_TURN) }),
			)
			try {
				const browser = createRelayProvider({
					url: `${server.url}/inference`,
					parser: createNDJSONParser,
					headers: () => ({ authorization: OBFUSCATED }),
				})

				// The browser drives `ProviderInterface` like a local provider, and the settled
				// frame carries the reasoning and the usage across the hop.
				expect(
					await browser.generate(
						[{ id: '1', role: 'user', content: 'Say hello.' }],
						new AbortController().signal,
					),
				).toEqual({
					content: 'Hello',
					thinking: 'weighing it',
					usage: { prompt: 3, completion: 4, total: 7 },
				})
				expect(browser.name).toBe('relay')
				expect(server.requests.map((request) => request.path)).toEqual(['/inference'])
			} finally {
				await server.stop()
			}
		})

		// The refusal the prose under the fences states. The served composition is the case
		// preceding; this one calls the dispatcher directly to read the daemon transport's
		// recorded requests, which is what proves the provider is never entered.
		it('refuses the relay hop with an HTTP 401 when the credential does not match', async () => {
			const daemon = createRecordingTransport(createStreamingTransport(HELLO_TURN))
			const handler = createRelay({
				provider: createOllama({ model: 'qwen3.5:2b-q4_K_M', fetch: daemon.fetch }),
				authorize: (request) => request.headers.get('authorization') === 'Bearer session-token',
			})
			const dispatcher = createDispatcher({
				routes: [{ method: 'POST', path: '/inference', handler }],
			})
			const browser = createRelayProvider({
				url: 'https://app.example.com/inference',
				parser: createNDJSONParser,
				headers: () => ({ authorization: 'Bearer wrong' }),
				fetch: (input, init) => dispatcher.handle(new Request(input, init), undefined),
			})
			const refused = await browser
				.generate([], new AbortController().signal)
				.catch((error: unknown) => error)

			// The refusal reaches the browser as a ProviderError, and the provider on the
			// server is never entered.
			expect(isProviderError(refused)).toBe(true)
			expect(refused).toMatchObject({ code: 'HTTP', status: 401 })
			expect(daemon.requests).toEqual([])
		})

		it('carries the relay fence lines the transcription copies', () => {
			expect(guideText).toContain('const handler = createRelay({')
			expect(guideText).toContain(
				"authorize: (request) => request.headers.get('authorization') === 'Bearer session-token',",
			)
			expect(guideText).toContain("routes: [{ method: 'POST', path: '/inference', handler }],")
			expect(guideText).toContain(
				"const server = createServer({ dispatcher, state: () => ({}), host: '127.0.0.1', port: 8787 })",
			)
			expect(guideText).toContain('const port = await server.start()')
			expect(guideText).toContain('await server.stop()')
			expect(guideText).toContain('const browser = createRelayProvider({')
			expect(guideText).toContain('parser: createNDJSONParser,')
		})

		// `guides/ollama.md` § Narrowing a failed call with `isProviderError`: a non-OK status
		// becomes one error class carrying that status.
		it('narrows a non-OK daemon status to a ProviderError carrying the HTTP code and status', async () => {
			const provider = createOllama({
				model: 'qwen3.5:2b-q4_K_M',
				fetch: () => Promise.resolve(new Response('model not found', { status: 404 })),
			})
			const failure = await provider
				.generate(
					[{ id: '1', role: 'user', content: 'Reply with exactly: ok' }],
					new AbortController().signal,
				)
				.catch((error: unknown) => error)

			expect(isProviderError(failure)).toBe(true)
			expect(failure).toMatchObject({ code: 'HTTP', status: 404 })
		})

		it('carries the error-narrowing fence line the transcription copies', () => {
			expect(guideText).toContain(
				"if (isProviderError(error) && error.code === 'HTTP' && error.status === 404) {",
			)
		})

		it('frames instructions through the manager when the real agent builds context', () => {
			const format = createOllamaInstructionFormat()
			const instructions = createInstructionManager({ format })
			instructions.add({ name: 'concise', content: 'Answer briefly.' })
			const provider = createOllama({ model: 'qwen3.5:2b-q4_K_M' })
			const agent = createAgent(provider, { instructions })
			expect(
				agent.context
					.build()
					.some(
						(message) =>
							message.content.includes('<instructions>') &&
							message.content.includes('<instruction>Answer briefly.</instruction>') &&
							message.content.includes('</instructions>'),
					),
			).toBe(true)
		})
	})

	// The server face's hermetic fences, transcribed. None starts a process: the declaration
	// fence constructs, stops, and restarts a session that never spawns, and the digest and unload
	// fences read recorded 0.40.8 bodies. The dedicated daemon fence starts a real executable, so
	// only its lifecycle lines are guarded here, as text.
	describe('server face fences', () => {
		const guideText = requireValue(files[GUIDE_SPEC], `Missing file: ${GUIDE_SPEC}`)

		// `guides/ollama.md` § Refuse a declaration before any I/O.
		it('refuses the default port at construction and stops an unstarted session without a child', async () => {
			expect(isOllamaOrigin('http://127.0.0.1:11437')).toBe(true)
			expect(isOllamaOrigin('http://127.0.0.1:11434')).toBe(false)
			expect(isOllamaOrigin('http://localhost:11437')).toBe(false)

			const declaration = {
				executable: { path: '/opt/ollama/bin/ollama', digest: 'a'.repeat(64), version: '0.40.8' },
				url: 'http://127.0.0.1:11437',
				models: [{ name: 'qwen3.5:2b-q4_K_M', digest: 'b'.repeat(64) }],
				workspace: '/srv/ollama',
				fetch: globalThis.fetch.bind(globalThis),
			}
			const refusal = captureError(() => {
				createOllamaDaemon({ ...declaration, url: 'http://127.0.0.1:11434' })
			})
			expect(isOllamaError(refusal) && refusal.code).toBe('invalid')

			const stopped = createRecorder<readonly [boolean]>()
			const daemon = createOllamaDaemon({ ...declaration, on: { stop: stopped.handler } })
			expect(await daemon.stop()).toBe(true)
			expect(stopped.calls).toEqual([[true]])
			expect(daemon.identity).toBeUndefined()
			expect(
				await daemon.start().catch((error: unknown) => isOllamaError(error) && error.code),
			).toBe('state')
			expect(daemon.maintenance).toEqual([])
			await daemon.destroy()
		})

		// `guides/ollama.md` § Verify a declared model digest, over the recorded 0.40.8 digests.
		it('accepts the inventory digest and refuses the manifest file digest with model', () => {
			const TAGS_DIGEST = '78a738cc751e89cba72bb1feabf70f30c31772eb81a89a66af94ecea90dc5d11'
			const MANIFEST_DIGEST = '0645cd5db74c6b4e379efe781f6eada45759366e9123e2553a2b0801f81079f3'
			const inventory = { models: [{ name: 'qwen3.5:2b-q4_K_M', digest: TAGS_DIGEST }] }

			expect(
				verifyOllamaModels(inventory, [{ name: 'qwen3.5:2b-q4_K_M', digest: TAGS_DIGEST }]),
			).toBeUndefined()
			const mismatch = captureError(() => {
				verifyOllamaModels(inventory, [{ name: 'qwen3.5:2b-q4_K_M', digest: MANIFEST_DIGEST }])
			})
			expect(isOllamaError(mismatch) && mismatch.code).toBe('model')
			expect(isOllamaError(mismatch) && mismatch.context?.received).toEqual([TAGS_DIGEST])
		})

		// `guides/ollama.md` § Read a retained unload reply, over the recorded 0.40.8 reply.
		it('retains the exact unload request and reads the recorded terminal reply', () => {
			const model = {
				name: 'qwen3.5:2b-q4_K_M',
				digest: '78a738cc751e89cba72bb1feabf70f30c31772eb81a89a66af94ecea90dc5d11',
			}
			const request = retainOllamaBytes(
				Buffer.from(JSON.stringify({ model: model.name, keep_alive: 0 })),
				true,
			)
			expect(Buffer.from(request.content, 'base64').toString()).toBe(
				'{"model":"qwen3.5:2b-q4_K_M","keep_alive":0}',
			)
			expect(request.size).toBe(44)
			const reply = retainOllamaBytes(
				Buffer.from(
					'{"model":"qwen3.5:2b-q4_K_M","created_at":"2026-10-23T14:08:45.7014834Z","response":"","done":true,"done_reason":"unload"}',
				),
				true,
			)
			const timing = readOllamaTerminal(reply, model)
			expect(timing?.durations.total).toBeUndefined()
			expect(timing?.invalid).toEqual([])
		})

		// The prose after that fence: each refused terminal reply throws `unload`.
		it('refuses another model, an unfinished reply, an error record, and an incomplete body with unload', () => {
			const model = { name: 'qwen3.5:2b-q4_K_M', digest: 'declared' }
			const refusals = [
				retainOllamaBytes(Buffer.from('{"model":"gemma3:1b","done":true}'), true),
				retainOllamaBytes(Buffer.from('{"model":"qwen3.5:2b-q4_K_M","done":false}'), true),
				retainOllamaBytes(
					Buffer.from(
						'{"model":"qwen3.5:2b-q4_K_M","error":"refused"}\n{"model":"qwen3.5:2b-q4_K_M","done":true}',
					),
					true,
				),
				retainOllamaBytes(Buffer.from('{"model":"qwen3.5:2b-q4_K_M","done":true}'), false),
			]
			for (const bytes of refusals) {
				const refusal = captureError(() => {
					readOllamaTerminal(bytes, model)
				})
				expect(isOllamaError(refusal) && refusal.code).toBe('unload')
			}
		})

		it('carries the server fence lines the transcriptions copy', () => {
			expect(guideText).toContain(
				"isOllamaOrigin('http://127.0.0.1:11434') // false — the default port is never a dedicated one",
			)
			expect(guideText).toContain("isOllamaError(refusal) && refusal.code // 'invalid'")
			expect(guideText).toContain('await daemon.stop() // true — no child was created')
			expect(guideText).toContain(
				"await daemon.start().catch((error: unknown) => isOllamaError(error) && error.code) // 'state'",
			)
			expect(guideText).toContain("isOllamaError(mismatch) && mismatch.code // 'model'")
			expect(guideText).toContain('// \'{"model":"qwen3.5:2b-q4_K_M","keep_alive":0}\'')
			expect(guideText).toContain('request.size // 44')
			expect(guideText).toContain('timing?.invalid // []')
		})

		// The dedicated daemon fence spawns, so this guards its lifecycle lines as text only.
		it('keeps the start, unload, stop, and destroy lines in the dedicated daemon fence', () => {
			expect(guideText).toContain('const identity = await daemon.start()')
			expect(guideText).toContain('const maintenance = await daemon.unload()')
			expect(guideText).toContain('const confirmed = await daemon.stop()')
			expect(guideText).toContain('await daemon.destroy()')
			expect(guideText).toContain(
				"import { createOllamaDaemon, isOllamaError } from '@orkestrel/ollama/server'",
			)
		})
	})
})

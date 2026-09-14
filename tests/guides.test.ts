// The consumer-side guides-parity entry runs `@orkestrel/guide` against this
// repository's own `guides/README.md` manifest. The constants that follow are this
// package's own, as is the executed section that closes the file.

import type { ContextFormat } from '@orkestrel/agent'
import { GuideCommand } from '@orkestrel/guide/server'
import { readInventory } from '@orkestrel/test/server'
import { createVitest } from 'vitest/node'

/** Every fence language this package's guides are allowed to use. */
const FENCE_LANGUAGES = Object.freeze(['ts'])
/** The fence language whose blocks count as worked examples. */
const EXAMPLE_LANGUAGE = 'ts'
/** The one guide this package sources, whose tagline the README pitch equals. */
const GUIDE_SPEC = 'guides/ollama.md'
/** The package identity that binds its manifest, module map, and README pitch. */
const PACKAGE_NAME = '@orkestrel/ollama'
/** Each import specifier this package's own guides may resolve against. */
const MODULES = Object.freeze({ [PACKAGE_NAME]: 'src/core', '@src/core': 'src/core' })
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
	const { createRelay, createRelayProvider, isProviderError } = await import('@orkestrel/agent')
	const { createNDJSONParser } = await import('@orkestrel/ndjson')
	const { createDispatcher } = await import('@orkestrel/router')
	const { requireValue } = await import('@orkestrel/test')
	const barrel = await import('@src/core')
	const { createOllama, OllamaProvider } = barrel
	const { createStreamingTransport } = await import('./setupServer.js')
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

	// The EXECUTED half. Every preceding check reads a name from guide or source text.
	// These cases run the flagship fences and assert the values their comments claim. Only
	// the hermetic half runs here: the `guides` project has no daemon, so a fence claim about
	// a live model's output is asserted in `tests/service/`.
	describe('flagship fences', () => {
		const guideText = requireValue(files[GUIDE_SPEC], `Missing file: ${GUIDE_SPEC}`)

		// The daemon's side of a whole turn, as newline-delimited records: two content
		// spans, one reasoning span, and the `done` line carrying the token counts.
		const TURN = Object.freeze([
			'{"message":{"content":"Hel"}}\n',
			'{"message":{"thinking":"weighing it"}}\n{"message":{"content":"lo"}}\n',
			'{"done":true,"prompt_eval_count":3,"eval_count":4}\n',
		])

		// `guides/ollama.md` § Surface: the primary fence creates a provider, then generates.
		it('createOllama returns a named provider exposing generate and stream', () => {
			const provider = createOllama({ model: 'qwen3.5:2b-q4_K_M' })

			expect(provider.name).toBe('ollama')
			expect(typeof provider.generate).toBe('function')
			expect(typeof provider.stream).toBe('function')
		})

		// `guides/ollama.md` § Surface: the streaming fence separates the channels and claims
		// the content deltas concatenate to the settled result.
		it('joins the streamed content deltas to the settled result the stream fence reads', async () => {
			const provider = createOllama({
				model: 'qwen3.5:2b-q4_K_M',
				fetch: createStreamingTransport(TURN),
			})
			const answer: string[] = []
			const reasoning: string[] = []

			const generator = provider.stream(
				[{ id: '1', role: 'user', content: 'Say hello.' }],
				new AbortController().signal,
			)
			let step = await generator.next()
			while (!step.done) {
				if (step.value.channel === 'content') answer.push(step.value.text)
				if (step.value.channel === 'thinking') reasoning.push(step.value.text)
				step = await generator.next()
			}

			expect(answer).toEqual(['Hel', 'lo'])
			expect(reasoning).toEqual(['weighing it'])
			expect(answer.join('')).toBe(step.value.content)
			expect(step.value).toEqual({
				content: 'Hello',
				thinking: 'weighing it',
				usage: { prompt: 3, completion: 4, total: 7 },
			})
		})

		it('carries the stream fence line the transcription copies', () => {
			expect(guideText).toContain(
				"answer.join('') === result.content // true — the content deltas concatenate to the result",
			)
		})

		// `guides/ollama.md` § Projecting the wire without a daemon: the seam members,
		// driven directly with no socket and no daemon.
		it('answers the seam fence with the projected body, the framed record, and the read increment', () => {
			const provider = new OllamaProvider({ model: 'qwen3.5:2b-q4_K_M', keepAlive: '9m' })
			const request = provider.body({
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

		// `guides/ollama.md` § Relaying through your own server: the server fence's route in
		// front of a real OllamaProvider, driven by the browser fence's relay provider. The
		// daemon is canned; every other part — the relay, the dispatcher, the provider, the
		// NDJSON frames — is the real one.
		it('round trips the relay fences through a dispatcher in front of the provider', async () => {
			const handler = createRelay({
				provider: createOllama({
					model: 'qwen3.5:2b-q4_K_M',
					fetch: createStreamingTransport(TURN),
				}),
				authorize: (request) => request.headers.get('authorization') === 'Bearer session-token',
			})
			const dispatcher = createDispatcher({
				routes: [{ method: 'POST', path: '/inference', handler }],
			})
			const browser = createRelayProvider({
				url: 'https://app.example.com/inference',
				parser: createNDJSONParser,
				headers: () => ({ authorization: 'Bearer session-token' }),
				fetch: (input, init) => dispatcher.handle(new Request(input, init), undefined),
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
		})

		it('refuses the relay hop with an HTTP 401 when the credential does not match', async () => {
			const daemon = createStreamingTransport(TURN)
			const calls: string[] = []
			const handler = createRelay({
				provider: createOllama({
					model: 'qwen3.5:2b-q4_K_M',
					fetch: (input, init) => {
						calls.push(String(input))
						return daemon(input, init)
					},
				}),
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
			expect(calls).toEqual([])
		})

		it('carries the relay fence lines the transcription copies', () => {
			expect(guideText).toContain('const handler = createRelay({')
			expect(guideText).toContain(
				"authorize: (request) => request.headers.get('authorization') === 'Bearer session-token',",
			)
			expect(guideText).toContain("routes: [{ method: 'POST', path: '/inference', handler }],")
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

		// `guides/ollama.md` § Context framing: `provider.format` is the ContextFormat passed in.
		it('createOllama exposes the framing default it was given, and undefined without one', () => {
			const format: ContextFormat = {
				instructions: {
					open: '<instructions>',
					render: (instruction) => `<instruction>${instruction.content}</instruction>`,
					close: '</instructions>',
				},
			}

			expect(createOllama({ model: 'qwen3.5:2b-q4_K_M', format }).format).toBe(format)
			expect(createOllama({ model: 'qwen3.5:2b-q4_K_M' }).format).toBeUndefined()
		})
	})
})

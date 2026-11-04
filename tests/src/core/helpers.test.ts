import type { JudgeQuestion, Message } from '@orkestrel/agent'
import { measureAnswer, JudgeError } from '@orkestrel/agent'
import { isRecord } from '@orkestrel/contract'
import { createRecorder } from '@orkestrel/test'
import {
	extractArguments,
	extractContent,
	extractThinking,
	extractTiming,
	extractTools,
	extractTruncated,
	extractUsage,
	mapMessages,
	matchesCandidateName,
	matchesContextRefusal,
	matchesCriterionText,
	ollamaOptionsContract,
	readMessage,
	readMessageText,
	readUsageCount,
	renderDaemonFailure,
	scanOptionFaults,
	escapeSpecialTokens,
	renderJudgePrompt,
	buildJudgeLabels,
	extractTopLogprobs,
	computeAnswer,
	renderJudgeIdentity,
	MICA_SPECIAL_TOKENS,
	MICA_RENDER_REVISION,
} from '@src/core'
import { describe, expect, it } from 'vitest'
import {
	ABSENT_ITERATORS,
	buildClosingList,
	buildRepeatedTokenCases,
	createUserMessage,
	NON_ADJACENT_DUPLICATE_TOP,
	TIMING_FIELDS,
	TIMING_HOSTILE,
	TIMING_READING,
	TIMING_TERMINAL,
	TRUNCATED_INVALID_REASONS,
	TRUNCATED_STRING_REASONS,
} from '../../setup.js'
import {
	JUDGE_NOUL_REQUEST,
	JUDGE_CHOICE_REQUEST,
	JUDGE_RAW_NOUL,
	JUDGE_RAW_CHOICE,
	JUDGE_WIRE_NOUL,
	JUDGE_WIRE_CHOICE,
	MICA_SYSTEM,
	MICA_CALIBRATION,
} from '../../setupServer.js'

describe('Mica prompt rendering', () => {
	it('refuses a question that carries no text, and names the remedy', () => {
		for (const question of [
			{ form: 'noul' },
			{ form: 'noul', instructions: ' ' },
			{ form: 'noul', criteria: { false: '', true: '  ' } },
			{ form: 'choice', criteria: { 0: null, 1: '' } },
			{ form: 'score', criteria: [null, null] },
		] satisfies readonly JudgeQuestion[]) {
			expect(() => renderJudgePrompt('state', question, 'system')).toThrow(
				expect.objectContaining({
					code: 'QUESTION',
					message: expect.stringContaining('set instructions'),
				}),
			)
		}
	})
	it('admits a question with instructions, a described candidate, or a named one alone', () => {
		for (const question of [
			{ form: 'noul', instructions: 'Is it approved?' },
			{ form: 'noul', criteria: { true: 'It is approved.' } },
			{ form: 'choice', criteria: { 0: 'First', 1: null } },
			{ form: 'choice', criteria: { billing: null, bug: null } },
			{ form: 'score', criteria: [null, 'High'] },
		] satisfies readonly JudgeQuestion[]) {
			expect(renderJudgePrompt('state', question, 'system')).toContain('<state>')
		}
	})
	it('renders empty noul criteria as their key words', () => {
		expect(
			renderJudgePrompt(
				'',
				{ form: 'noul', instructions: 'Is it?', criteria: { false: '', true: '' } },
				'system',
			),
		).toBe(
			'<|im_start|>system\nsystem<|im_end|>\n<|im_start|>user\n<state>\n\n</state>\nQuestion: Is it?\nCriteria:\nfalse: false\ntrue: true\nAnswer Yes if true, or No if false.<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n',
		)
	})
	it('hides Unicode decimal positional ids like ASCII positional ids', () => {
		expect(
			renderJudgePrompt('', { form: 'choice', criteria: { c١: 'first', c1: 'second' } }, 'system'),
		).toBe(
			'<|im_start|>system\nsystem<|im_end|>\n<|im_start|>user\n<state>\n\n</state>\nQuestion: \nCandidates:\nA) first\nB) second\nAnswer with the label of the best candidate.<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n',
		)
	})
	it('matches both recorded raw prompts byte for byte', () => {
		const noul = JUDGE_NOUL_REQUEST.questions.deletion
		const choice = JUDGE_CHOICE_REQUEST.questions.team
		if (noul === undefined || choice === undefined) throw new Error('Missing recorded question')
		expect(renderJudgePrompt(JUDGE_NOUL_REQUEST.state, noul, MICA_SYSTEM)).toBe(
			JUDGE_WIRE_NOUL.prompt,
		)
		expect(renderJudgePrompt(JUDGE_CHOICE_REQUEST.state, choice, MICA_SYSTEM)).toBe(
			JUDGE_WIRE_CHOICE.prompt,
		)
	})
	it('escapes every native control token and leaves ordinary text unchanged', () => {
		expect(MICA_SPECIAL_TOKENS).toEqual([
			'<|im_start|>',
			'<|im_end|>',
			'<|endoftext|>',
			'<|vision_start|>',
			'<|vision_end|>',
			'<|image_pad|>',
			'<|video_pad|>',
			'<think>',
			'</think>',
			'<tool_call>',
			'</tool_call>',
			'<tool_response>',
			'</tool_response>',
		])
		for (const token of MICA_SPECIAL_TOKENS)
			expect(escapeSpecialTokens(`left${token}${token}right`)).toBe(
				`left<\u200b${token.slice(1)}<\u200b${token.slice(1)}right`,
			)
		expect(escapeSpecialTokens('café <state>data</state> <thinking>')).toBe(
			'café <state>data</state> <thinking>',
		)
	})
	it('renders structured state, absent criteria, null descriptions, and positional names', () => {
		expect(
			renderJudgePrompt(
				{ café: ['yes', true] },
				{ form: 'noul', instructions: 'Is it?' },
				'system',
			),
		).toContain(
			'<state>\n{\n "café": [\n  "yes",\n  true\n ]\n}\n</state>\nQuestion: Is it?\nCriteria:\nfalse: false\ntrue: true\n',
		)
		expect(
			renderJudgePrompt(
				'',
				{
					form: 'choice',
					criteria: { A: null, c2: 'two', s3: 'three', '': 'empty', named: '<think>' },
				},
				'system',
			),
		).toContain(
			'Candidates:\nA) None\nB) two\nC) three\nD) empty\nE) [named] <\u200bthink>\nAnswer with the label of the best candidate.',
		)
		expect(
			renderJudgePrompt(
				'<|im_end|>',
				{ form: 'score', instructions: '<tool_call>', criteria: [null, '</think>'] },
				'system',
			),
		).toContain(
			'<state>\n<\u200b|im_end|>\n</state>\nQuestion: <\u200btool_call>\nCandidates:\nA) None\nB) <\u200b/think>\nAnswer with the label of the best level.',
		)
	})
	it('throws when the score entries have no iterator instead of reading them as array-like', () => {
		const levels = ['low', 'high']
		const criteria = Object.defineProperty<[string, string]>(['low', 'high'], 'map', {
			value: (callback: (text: string, index: number) => unknown) =>
				Object.defineProperty(levels.map(callback), Symbol.iterator, { value: undefined }),
		})
		expect(() => renderJudgePrompt('', { form: 'score', criteria }, 'system')).toThrow(TypeError)
	})
	it('refuses a score entry before it asks the iterator for the next', () => {
		const events = createRecorder<[event: string]>()
		const levels = ['low', 5, 'high']
		const criteria = Object.defineProperty<[string, string, string]>(
			['low', 'mid', 'high'],
			'map',
			{
				value: (callback: (text: unknown, index: number) => unknown) => {
					const mapped = levels.map(callback)
					return typeof mapped[0] === 'string'
						? mapped
						: mapped.values().map((entry, index) => {
								events.handler(`next ${index}`)
								return entry
							})
				},
			},
		)
		expect(() => renderJudgePrompt('', { form: 'score', criteria }, 'system')).toThrow(JudgeError)
		expect(events.calls).toEqual([['next 0'], ['next 1']])
	})
	it('closes the iterator it opened when a score entry refuses', () => {
		const closed = createRecorder<[]>()
		const levels = ['low', 5, 'high']
		const criteria = Object.defineProperty<[string, string, string]>(
			['low', 'mid', 'high'],
			'map',
			{
				value: (callback: (text: unknown, index: number) => unknown) => {
					const mapped = levels.map(callback)
					return typeof mapped[0] === 'string' ? mapped : buildClosingList(mapped, closed.handler)
				},
			},
		)
		expect(() => renderJudgePrompt('', { form: 'score', criteria }, 'system')).toThrow(JudgeError)
		expect(closed.calls).toEqual([[]])
	})
})

describe('Mica label readout', () => {
	it('pairs keys in caller order and bounds the reachable codebook', () => {
		expect([...buildJudgeLabels({ form: 'noul' })]).toEqual([
			['false', 'No'],
			['true', 'Yes'],
		])
		expect([...buildJudgeLabels({ form: 'score', criteria: ['low', 'high'] })]).toEqual([
			['0', 'A'],
			['1', 'B'],
		])
		expect([
			...buildJudgeLabels({ form: 'choice', criteria: { technical: null, billing: null } }),
		]).toEqual([
			['technical', 'A'],
			['billing', 'B'],
		])
		expect(
			buildJudgeLabels({
				form: 'choice',
				criteria: Object.fromEntries(
					Array.from({ length: 20 }, (_, index) => [`option-${index}`, null]),
				),
			}).get('option-19'),
		).toBe('T')
		expect(() => buildJudgeLabels({ form: 'choice', criteria: { alone: null } })).toThrow(
			JudgeError,
		)
	})
	it('reads only the first position, keeps exact tokens, and owns the entries', () => {
		const entry = { token: ' No', logprob: -1, bytes: [32, 78, 111] }
		const result = extractTopLogprobs({
			logprobs: [{ top_logprobs: [entry] }, { top_logprobs: [{ token: 'Yes', logprob: 0 }] }],
		})
		entry.logprob = -5
		expect(result).toEqual([{ token: ' No', logprob: -1 }])
		expect(extractTopLogprobs(JUDGE_RAW_NOUL)[0]).toEqual({
			token: 'No',
			logprob: -0.01061257440596819,
		})
		expect(() => extractTopLogprobs({ logprobs: [] })).toThrow(JudgeError)
		expect(() =>
			extractTopLogprobs({ logprobs: [{ top_logprobs: [{ token: 'No', logprob: NaN }] }] }),
		).toThrow(JudgeError)
		expect(() => extractTopLogprobs({ logprobs: [{ top_logprobs: [entry, entry] }] })).toThrow(
			JudgeError,
		)
	})
	it('refuses a hole in the top list as an invalid entry', () => {
		const top = Object.assign([], {
			0: { token: 'No', logprob: -1 },
			2: { token: 'Yes', logprob: 0 },
		})
		expect(top).toHaveLength(3)
		expect(() => extractTopLogprobs({ logprobs: [{ top_logprobs: top }] })).toThrow(JudgeError)
	})
	it('refuses the first duplicate token before it reads the entries after it', () => {
		const reads = createRecorder<[index: number]>()
		const top = Object.defineProperty(
			[
				{ token: 'No', logprob: 0 },
				{ token: 'No', logprob: -1 },
			],
			2,
			{
				enumerable: true,
				get: () => {
					reads.handler(2)
					return { token: 'Yes', logprob: 0 }
				},
			},
		)
		expect(() => extractTopLogprobs({ logprobs: [{ top_logprobs: top }] })).toThrow(JudgeError)
		expect(reads.calls).toEqual([])
	})
	it('refuses a token repeated after another token as it refuses an adjacent repeat', () => {
		expect(() =>
			extractTopLogprobs({ logprobs: [{ top_logprobs: NON_ADJACENT_DUPLICATE_TOP }] }),
		).toThrow(JudgeError)
	})
	it('normalizes equal candidates uniformly and flattens gaps with calibration', () => {
		const question: JudgeQuestion = {
			form: 'choice',
			criteria: { billing: null, technical: null, sales: null },
		}
		expect(
			computeAnswer(
				question,
				[
					{ token: 'A', logprob: 0 },
					{ token: 'B', logprob: 0 },
					{ token: 'C', logprob: 0 },
				],
				MICA_CALIBRATION.temperature,
			),
		).toEqual({ form: 'choice', probabilities: { billing: 1 / 3, technical: 1 / 3, sales: 1 / 3 } })
		const top = [
			{ token: 'No', logprob: 0 },
			{ token: 'Yes', logprob: -1 },
			{ token: 'Maybe', logprob: -0.01 },
		]
		const sharp = computeAnswer({ form: 'noul' }, top)
		const flatter = computeAnswer({ form: 'noul' }, top, MICA_CALIBRATION.temperature)
		if (
			!('form' in sharp) ||
			sharp.form !== 'noul' ||
			!('form' in flatter) ||
			flatter.form !== 'noul'
		)
			throw new Error('Expected noul answers')
		expect(sharp.noul).toBeCloseTo(0.26894142137, 10)
		expect(flatter.noul).toBeGreaterThan(sharp.noul)
		expect(
			computeAnswer({ form: 'score', criteria: ['low', 'high'] }, [
				{ token: 'A', logprob: -10000 },
				{ token: 'B', logprob: -10000 },
				{ token: 'other', logprob: 0 },
			]),
		).toEqual({ form: 'score', probabilities: [0.5, 0.5] })
	})
	it('reads the recorded noul and choice at the model calibration', () => {
		const noul = computeAnswer(
			{ form: 'noul' },
			extractTopLogprobs(JUDGE_RAW_NOUL),
			MICA_CALIBRATION.temperature,
		)
		const question = JUDGE_CHOICE_REQUEST.questions.team
		if (question === undefined || !('form' in noul) || noul.form !== 'noul')
			throw new Error('Missing answer')
		expect(noul.noul).toBeCloseTo(0.01, 3)
		const choice = computeAnswer(
			question,
			extractTopLogprobs(JUDGE_RAW_CHOICE),
			MICA_CALIBRATION.temperature,
		)
		if (!('form' in choice) || choice.form !== 'choice') throw new Error('Expected choice')
		expect(measureAnswer(choice).winner).toBe('billing')
		expect(choice.probabilities.billing).toBeCloseTo(0.986855579622604, 12)
		expect(choice.probabilities.technical).toBeCloseTo(0.01299236070023817, 12)
		expect(choice.probabilities.sales).toBeCloseTo(0.00015205967715775922, 12)
		expect(Object.values(choice.probabilities).reduce((sum, value) => sum + value, 0)).toBeCloseTo(
			1,
			12,
		)
		expect(extractUsage(JUDGE_RAW_NOUL)).toEqual({ prompt: 138, completion: 1, total: 139 })
	})
	it('refuses missing caller keys without filling them with zero', () => {
		expect(computeAnswer({ form: 'noul' }, [{ token: 'Yes', logprob: 0 }])).toEqual({
			missing: ['false'],
		})
		expect(computeAnswer({ form: 'noul' }, [{ token: ' No', logprob: 0 }])).toEqual({
			missing: ['false', 'true'],
		})
		expect(
			computeAnswer({ form: 'choice', criteria: { billing: null, sales: null } }, [
				{ token: 'A', logprob: 0 },
			]),
		).toEqual({ missing: ['sales'] })
		expect(
			computeAnswer({ form: 'score', criteria: ['low', 'high'] }, [{ token: 'B', logprob: 0 }]),
		).toEqual({ missing: ['0'] })
		expect(() => computeAnswer({ form: 'noul' }, [], 0)).toThrow(JudgeError)
		expect(() => computeAnswer({ form: 'noul' }, [{ token: 'No', logprob: Infinity }])).toThrow(
			JudgeError,
		)
	})
	describe('iterator refusal boundaries', () => {
		it('reads the top list in order, so a duplicate ahead of a hole refuses as a protocol error', () => {
			const duplicate = Object.assign([], {
				0: { token: 'No', logprob: 0 },
				1: { token: 'No', logprob: 0 },
				3: { token: 'Yes', logprob: 0 },
			})
			expect(() => computeAnswer({ form: 'noul' }, duplicate)).toThrow(JudgeError)
			const holed = Object.assign([], {
				0: { token: 'No', logprob: 0 },
				2: { token: 'Yes', logprob: 0 },
			})
			expect(() => computeAnswer({ form: 'noul' }, holed)).toThrow(TypeError)
		})
		it('refuses the first duplicate token before it reads the entries after it', () => {
			const reads = createRecorder<[index: number]>()
			const top = Object.defineProperty(
				[
					{ token: 'No', logprob: 0 },
					{ token: 'No', logprob: -1 },
				],
				2,
				{
					enumerable: true,
					get: () => {
						reads.handler(2)
						return { token: 'Yes', logprob: 0 }
					},
				},
			)
			expect(() => computeAnswer({ form: 'noul' }, top)).toThrow(JudgeError)
			expect(reads.calls).toEqual([])
		})
		it('refuses a token repeated after another token as it refuses an adjacent repeat', () => {
			expect(() => computeAnswer({ form: 'noul' }, NON_ADJACENT_DUPLICATE_TOP)).toThrow(JudgeError)
		})
		it('matches a repeated token as a map key does: NaN and signed zero repeat, equal objects do not', () => {
			for (const top of buildRepeatedTokenCases())
				expect(() => computeAnswer({ form: 'noul' }, top)).toThrow(JudgeError)
			expect(
				computeAnswer({ form: 'noul' }, [
					Object.assign({ token: 'x', logprob: 0 }, { token: {} }),
					Object.assign({ token: 'x', logprob: 0 }, { token: {} }),
				]),
			).toEqual({ missing: ['false', 'true'] })
		})
	})
})

describe('renderJudgeIdentity', () => {
	it('encodes every answer-defining setting and defaults calibration consistently', () => {
		const options = { model: 'mica', system: MICA_SYSTEM }
		const identity = renderJudgeIdentity(options)
		expect(identity).toBe(
			JSON.stringify([
				'mica',
				MICA_SYSTEM,
				1,
				{ num_predict: 1, temperature: 1 },
				MICA_RENDER_REVISION,
			]),
		)
		expect(renderJudgeIdentity({ ...options, calibration: { temperature: 1 } })).toBe(identity)
		expect(renderJudgeIdentity({ ...options, model: 'mica:other' })).not.toBe(identity)
		expect(renderJudgeIdentity({ ...options, system: 'Other system' })).not.toBe(identity)
		expect(renderJudgeIdentity({ ...options, calibration: MICA_CALIBRATION })).not.toBe(identity)
		expect(renderJudgeIdentity(options, 'next-render')).not.toBe(identity)
		const configured = renderJudgeIdentity({ ...options, options: { num_ctx: 8192, seed: 42 } })
		expect(renderJudgeIdentity({ ...options, options: { seed: 42, num_ctx: 8192 } })).toBe(
			configured,
		)
		expect(renderJudgeIdentity({ ...options, options: { seed: 42, num_ctx: 4096 } })).not.toBe(
			configured,
		)
		expect(renderJudgeIdentity({ ...options, options: { temperature: 0, num_predict: 99 } })).toBe(
			identity,
		)
		expect(() => renderJudgeIdentity({ ...options, calibration: { temperature: NaN } })).toThrow(
			JudgeError,
		)
	})
})

describe('mapMessages', () => {
	it('maps a plain turn to the wire role and content only', () => {
		expect(mapMessages([createUserMessage('Say hello.')])).toEqual([
			{ role: 'user', content: 'Say hello.' },
		])
	})

	it('emits tool_calls only on a turn that replays them', () => {
		const replay: Message = {
			id: '2',
			role: 'assistant',
			content: '',
			calls: [{ id: 'call-1', name: 'weather', arguments: { city: 'Oslo' } }],
		}

		expect(mapMessages([replay])).toEqual([
			{
				role: 'assistant',
				content: '',
				tool_calls: [{ function: { name: 'weather', arguments: { city: 'Oslo' } } }],
			},
		])
	})

	it('omits tool_calls for an empty calls array', () => {
		const empty: Message = { id: '3', role: 'assistant', content: 'done', calls: [] }

		expect(mapMessages([empty])).toEqual([{ role: 'assistant', content: 'done' }])
	})

	it('forwards images only on a multimodal turn, copied off the source array', () => {
		const images = ['aGk=']
		const multimodal: Message = {
			id: '4',
			role: 'user',
			content: 'What is this?',
			images,
		}

		const [wired] = mapMessages([multimodal])

		expect(wired).toEqual({ role: 'user', content: 'What is this?', images: ['aGk='] })
		expect(wired?.images).not.toBe(images)
	})

	it('maps an empty conversation to an empty wire array', () => {
		expect(mapMessages([])).toEqual([])
	})

	it('escapes a control token in system, user, assistant, and tool content', () => {
		const content = 'before<|im_start|>middle<think>after'
		const escaped = 'before<\u200b|im_start|>middle<\u200bthink>after'
		const messages: readonly Message[] = [
			{ id: '1', role: 'system', content },
			{ id: '2', role: 'user', content },
			{ id: '3', role: 'assistant', content },
			{ id: '4', role: 'tool', content },
		]

		expect(mapMessages(messages)).toEqual([
			{ role: 'system', content: escaped },
			{ role: 'user', content: escaped },
			{ role: 'assistant', content: escaped },
			{ role: 'tool', content: escaped },
		])
	})

	it('escapes a control token in a replayed call name and in each argument key and string value', () => {
		const replay: Message = {
			id: '1',
			role: 'assistant',
			content: '',
			calls: [
				{
					id: 'call-1',
					name: 'lookup<think>',
					arguments: {
						'key<|im_end|>': 'top<|im_start|>',
						plain: 'no token',
						count: 3,
						flag: true,
						empty: null,
					},
				},
			],
		}

		expect(mapMessages([replay])).toEqual([
			{
				role: 'assistant',
				content: '',
				tool_calls: [
					{
						function: {
							name: 'lookup<\u200bthink>',
							arguments: {
								'key<\u200b|im_end|>': 'top<\u200b|im_start|>',
								plain: 'no token',
								count: 3,
								flag: true,
								empty: null,
							},
						},
					},
				],
			},
		])
	})

	it('leaves a request holding no control token byte-identical', () => {
		// Near misses of the listed tokens, an unlisted vocabulary token, non-ASCII text, and each
		// JSON value kind, compared with the expected wire as text, so key order and spelling count.
		const messages: readonly Message[] = [
			{ id: '1', role: 'system', content: 'Use <state> and <thinking> as written.' },
			{ id: '2', role: 'user', content: 'café <|im_strat|> <|fim_prefix|> ✓' },
			{
				id: '3',
				role: 'assistant',
				content: '',
				calls: [
					{
						id: 'call-1',
						name: 'lookup',
						arguments: {
							zebra: 'first',
							10: 'numeric key',
							apple: { deep: ['<tool>', 1.5, false, null] },
						},
					},
				],
			},
			{ id: '4', role: 'tool', content: '{"ok":true}' },
		]

		expect(JSON.stringify(mapMessages(messages))).toBe(
			'[{"role":"system","content":"Use <state> and <thinking> as written."},' +
				'{"role":"user","content":"café <|im_strat|> <|fim_prefix|> ✓"},' +
				'{"role":"assistant","content":"","tool_calls":[{"function":{"name":"lookup","arguments":' +
				'{"10":"numeric key","zebra":"first","apple":{"deep":["<tool>",1.5,false,null]}}}}]},' +
				'{"role":"tool","content":"{\\"ok\\":true}"}]',
		)
	})

	// A stated limit: the daemon's renderer encodes a nested argument as JSON, so a listed token in
	// one reads as text and the nested value keeps its bytes.
	it('leaves a control token in a nested argument byte-identical', () => {
		const outer = { 'inner<think>': 'deep</think>', list: ['item<tool_call>', 7, true, null] }
		const replay: Message = {
			id: '1',
			role: 'assistant',
			content: '',
			calls: [{ id: 'call-1', name: 'lookup', arguments: { outer } }],
		}

		expect(JSON.stringify(mapMessages([replay])[0]?.tool_calls)).toBe(
			'[{"function":{"name":"lookup","arguments":{"outer":' +
				'{"inner<think>":"deep</think>","list":["item<tool_call>",7,true,null]}}}}]',
		)
	})

	it('writes a __proto__ argument key as an own key and changes no prototype', () => {
		const parsed: unknown = JSON.parse('{"__proto__":{"polluted":"yes"},"safe":"plain"}')
		const replay: Message = {
			id: '1',
			role: 'assistant',
			content: '',
			calls: [{ id: 'call-1', name: 'lookup', arguments: isRecord(parsed) ? parsed : {} }],
		}

		const written = mapMessages([replay])[0]?.tool_calls?.[0]?.function.arguments

		expect(JSON.stringify(written)).toBe('{"__proto__":{"polluted":"yes"},"safe":"plain"}')
		expect(Object.getPrototypeOf(written)).toBe(Object.prototype)
		expect(Reflect.get({}, 'polluted')).toBeUndefined()
	})
})

describe('scanOptionFaults', () => {
	it('leaves the callbacks and a key set to undefined out of the contract', () => {
		expect(
			scanOptionFaults(
				ollamaOptionsContract,
				{ model: 'mica', fetch: globalThis.fetch, headers: () => ({}), url: undefined },
				['fetch', 'headers'],
			),
		).toEqual([])
	})

	it('reports an undeclared key by its path and a type fault beside it', () => {
		expect(
			scanOptionFaults(ollamaOptionsContract, { model: 7, keepalive: '5m' }, []).map(
				(fault) => fault.path,
			),
		).toEqual([['model'], ['keepalive']])
	})

	it('reports a coercible value, because nothing repairs a host-written option', () => {
		expect(
			scanOptionFaults(ollamaOptionsContract, { model: 'mica', timeout: '30' }, []),
		).toHaveLength(1)
	})
})

describe('matchesContextRefusal', () => {
	it('matches the texts a daemon has used for the window', () => {
		expect(
			matchesContextRefusal(
				'request (3245 tokens) exceeds the available context size (2048 tokens), try increasing it',
			),
		).toBe(true)
		expect(matchesContextRefusal('the input length exceeds the context length')).toBe(true)
		expect(matchesContextRefusal('Prompt exceeds the Context Window')).toBe(true)
	})

	it('leaves other refusals alone', () => {
		expect(matchesContextRefusal('model not found')).toBe(false)
		expect(matchesContextRefusal('invalid context')).toBe(false)
	})
})

describe('renderDaemonFailure', () => {
	it('keeps a short text and bounds a long one', () => {
		expect(renderDaemonFailure('the runner stopped')).toBe('the runner stopped')
		expect(renderDaemonFailure('x'.repeat(4096))).toHaveLength(2048)
	})

	it('renders a value that is no text', () => {
		expect(renderDaemonFailure({ code: 7 })).toBe('object')
	})

	it('appends the remedy when the text names the context', () => {
		expect(renderDaemonFailure('exceeds the context size')).toBe(
			"exceeds the context size; the prompt exceeds the model's context window; set AgentOptions.window to fold the conversation, raise options.num_ctx, or set truncate: true to let the daemon cut it",
		)
	})
})

describe('matchesCandidateName', () => {
	it('reads a name and refuses a position, an empty key, and the label itself', () => {
		expect(matchesCandidateName('billing', 'A')).toBe(true)
		expect(matchesCandidateName('0', 'A')).toBe(false)
		expect(matchesCandidateName('c1', 'A')).toBe(false)
		expect(matchesCandidateName('', 'A')).toBe(false)
		expect(matchesCandidateName('A', 'A')).toBe(false)
	})
})

describe('matchesCriterionText', () => {
	it('reads each form', () => {
		expect(matchesCriterionText({ form: 'noul', criteria: { true: 'It holds.' } })).toBe(true)
		expect(matchesCriterionText({ form: 'noul' })).toBe(false)
		expect(matchesCriterionText({ form: 'score', criteria: ['Low', null] })).toBe(true)
		expect(matchesCriterionText({ form: 'score', criteria: ['', null] })).toBe(false)
		expect(matchesCriterionText({ form: 'choice', criteria: { billing: null, bug: null } })).toBe(
			true,
		)
		expect(matchesCriterionText({ form: 'choice', criteria: { 0: null, 1: null } })).toBe(false)
	})
})

describe('readMessage', () => {
	it('reads a record, leaves an absent message undefined, and refuses anything else', () => {
		expect(readMessage({ message: { content: 'ok' } })).toEqual({ content: 'ok' })
		expect(readMessage({ done: true })).toBeUndefined()
		expect(() => readMessage({ message: 'ok' })).toThrow(
			expect.objectContaining({ code: 'PROTOCOL' }),
		)
	})
})

describe('readMessageText', () => {
	it('reads text, leaves an absent field empty, and refuses anything else', () => {
		expect(readMessageText({ message: { content: 'ok' } }, 'content')).toBe('ok')
		expect(readMessageText({ message: {} }, 'content')).toBe('')
		expect(readMessageText({ done: true }, 'content')).toBe('')
		expect(() => readMessageText({ message: { content: 42 } }, 'content')).toThrow(
			expect.objectContaining({ code: 'PROTOCOL' }),
		)
	})
})

describe('readUsageCount', () => {
	it('reads a count, leaves an absent one undefined, and refuses anything else', () => {
		expect(readUsageCount({ eval_count: 0 }, 'eval_count')).toBe(0)
		expect(readUsageCount({ eval_count: 1.5 }, 'eval_count')).toBe(1.5)
		expect(readUsageCount({}, 'eval_count')).toBeUndefined()
		for (const count of [-1, Number.NaN, Number.POSITIVE_INFINITY, '4', null]) {
			expect(() => readUsageCount({ eval_count: count }, 'eval_count')).toThrow(
				expect.objectContaining({ code: 'PROTOCOL' }),
			)
		}
	})
})

describe('extractContent', () => {
	it('reads a string message.content', () => {
		expect(extractContent({ message: { content: 'ok' } })).toBe('ok')
	})

	it('reads an absent message and an absent content as empty', () => {
		expect(extractContent({})).toBe('')
		expect(extractContent({ message: {} })).toBe('')
	})

	it('refuses a non-record message', () => {
		expect(() => extractContent({ message: 'ok' })).toThrow(
			expect.objectContaining({ code: 'PROTOCOL' }),
		)
	})

	it('refuses a non-string content', () => {
		expect(() => extractContent({ message: { content: 42 } })).toThrow(
			expect.objectContaining({ code: 'PROTOCOL' }),
		)
	})
})

describe('extractThinking', () => {
	it('reads a string message.thinking', () => {
		expect(extractThinking({ message: { thinking: 'weighing it' } })).toBe('weighing it')
	})

	it('reads a content-only record as empty', () => {
		expect(extractThinking({ message: { content: 'ok' } })).toBe('')
	})

	it('refuses a non-record message and a non-string thinking', () => {
		expect(() => extractThinking({ message: null })).toThrow(
			expect.objectContaining({ code: 'PROTOCOL' }),
		)
		expect(() => extractThinking({ message: { thinking: 42 } })).toThrow(
			expect.objectContaining({ code: 'PROTOCOL' }),
		)
	})
})

describe('extractUsage', () => {
	it('totals both counts when both are numbers', () => {
		expect(extractUsage({ prompt_eval_count: 3, eval_count: 4 })).toEqual({
			prompt: 3,
			completion: 4,
			total: 7,
		})
	})

	it('yields undefined when the completion count is absent', () => {
		expect(extractUsage({ prompt_eval_count: 3 })).toBeUndefined()
	})

	it('yields undefined when both counts are absent, or set to undefined', () => {
		expect(extractUsage({ done: true })).toBeUndefined()
		expect(extractUsage({ prompt_eval_count: undefined, eval_count: undefined })).toBeUndefined()
	})

	it('reads a zero count, which a repeat of a cached prompt can report', () => {
		expect(extractUsage({ prompt_eval_count: 0, eval_count: 2 })).toEqual({
			prompt: 0,
			completion: 2,
			total: 2,
		})
	})

	it('refuses a present count that is not a finite nonnegative number', () => {
		for (const count of ['3', -1, Number.NaN, Number.POSITIVE_INFINITY, null]) {
			expect(() => extractUsage({ prompt_eval_count: count, eval_count: 4 })).toThrow(
				expect.objectContaining({ code: 'PROTOCOL' }),
			)
			expect(() => extractUsage({ prompt_eval_count: 3, eval_count: count })).toThrow(
				expect.objectContaining({ code: 'PROTOCOL' }),
			)
			expect(() => extractUsage({ eval_count: count })).toThrow(
				expect.objectContaining({ code: 'PROTOCOL' }),
			)
		}
	})

	it('yields undefined for a delta line carrying neither count', () => {
		expect(extractUsage({ message: { content: 'ok' } })).toBeUndefined()
	})
})

describe('extractTruncated', () => {
	it('reads the length reason of a terminal record as true', () => {
		expect(extractTruncated({ done: true, done_reason: 'length' })).toBe(true)
	})

	it.each(TRUNCATED_STRING_REASONS)('yields undefined for the %j reason', (reason) => {
		expect(extractTruncated({ done: true, done_reason: reason })).toBeUndefined()
	})

	it('yields undefined when the reason is missing', () => {
		expect(extractTruncated({ done: true })).toBeUndefined()
	})

	it.each(TRUNCATED_INVALID_REASONS)(
		'yields undefined when the reason is not a string (%j)',
		(reason) => {
			expect(extractTruncated({ done: true, done_reason: reason })).toBeUndefined()
		},
	)
})

describe('extractTiming', () => {
	it('keeps a complete terminal record verbatim in nanoseconds and tokens', () => {
		expect(extractTiming(TIMING_TERMINAL)).toStrictEqual(TIMING_READING)
		expect(extractTiming({ done: true, total_duration: 1234567890123 })?.durations.total).toBe(
			1234567890123,
		)
	})

	it('keeps zero as a reading', () => {
		const zeros = Object.fromEntries(TIMING_FIELDS.map(([key]) => [key, 0]))
		expect(extractTiming({ done: true, ...zeros })).toStrictEqual({
			durations: { total: 0, load: 0, prompt: 0, decode: 0 },
			counts: { prompt: 0, decode: 0, cached: 0 },
			invalid: [],
		})
	})

	it('reads each absent key as unknown, never as zero and never as invalid', () => {
		for (const [key, group, member] of TIMING_FIELDS) {
			const expected = structuredClone(TIMING_READING)
			Reflect.set(expected[group], member, undefined)
			const { [key]: _omitted, ...rest } = TIMING_TERMINAL
			expect(extractTiming(rest)).toStrictEqual(expected)
		}
		expect(extractTiming({ done: true })).toStrictEqual({
			durations: { total: undefined, load: undefined, prompt: undefined, decode: undefined },
			counts: { prompt: undefined, decode: undefined, cached: undefined },
			invalid: [],
		})
	})

	it('reads each malformed, negative, fractional, or unsafe value as undefined and lists its key', () => {
		for (const [key, group, member] of TIMING_FIELDS)
			for (const value of TIMING_HOSTILE) {
				const expected = structuredClone(TIMING_READING)
				Reflect.set(expected[group], member, undefined)
				expect(extractTiming({ ...TIMING_TERMINAL, [key]: value })).toStrictEqual({
					...expected,
					invalid: [key],
				})
			}
	})

	it('accepts the largest safe integer', () => {
		expect(
			extractTiming({ done: true, total_duration: Number.MAX_SAFE_INTEGER })?.durations.total,
		).toBe(Number.MAX_SAFE_INTEGER)
	})

	it('keeps the valid fields beside the invalid ones in wire order', () => {
		expect(
			extractTiming({
				...TIMING_TERMINAL,
				eval_count: -4,
				load_duration: '2345678',
				prompt_eval_count: undefined,
			}),
		).toStrictEqual({
			durations: { total: 1234567890123, load: undefined, prompt: 345678901, decode: 987654321 },
			counts: { prompt: undefined, decode: undefined, cached: 12 },
			invalid: ['load_duration', 'prompt_eval_count', 'eval_count'],
		})
	})

	it('yields undefined unless done is true', () => {
		const { done: _done, ...unfinished } = TIMING_TERMINAL
		expect(extractTiming({ ...TIMING_TERMINAL, done: false })).toBeUndefined()
		expect(extractTiming(unfinished)).toBeUndefined()
		expect(extractTiming({ ...TIMING_TERMINAL, done: 'true' })).toBeUndefined()
		expect(extractTiming({ ...TIMING_TERMINAL, done: 1 })).toBeUndefined()
		expect(extractTiming({ ...TIMING_TERMINAL, done: undefined })).toBeUndefined()
		expect(extractTiming({ message: { content: 'ok' } })).toBeUndefined()
		expect(extractTiming({})).toBeUndefined()
	})

	it('reads only own fields', () => {
		expect(extractTiming(Object.create(TIMING_TERMINAL))).toBeUndefined()
		const { done: _done, ...inherited } = TIMING_TERMINAL
		const record: Record<string, unknown> = Object.create(inherited)
		record.done = true
		expect(extractTiming(record)).toStrictEqual({
			durations: { total: undefined, load: undefined, prompt: undefined, decode: undefined },
			counts: { prompt: undefined, decode: undefined, cached: undefined },
			invalid: [],
		})
	})

	it('neither mutates the record nor throws for hostile records', () => {
		const frozen = Object.freeze({ ...TIMING_TERMINAL, eval_count: '4', extra: { nested: [1] } })
		const before = JSON.stringify(frozen)
		expect(extractTiming(frozen)?.invalid).toEqual(['eval_count'])
		expect(JSON.stringify(frozen)).toBe(before)
		const bare: Record<string, unknown> = Object.create(null)
		bare.done = true
		bare.total_duration = 7
		expect(extractTiming(bare)?.durations.total).toBe(7)
		expect(extractTiming({ done: true, total_duration: Symbol('ns') })?.invalid).toEqual([
			'total_duration',
		])
		expect(() => extractTiming({ done: true, eval_count: () => 4 })).not.toThrow()
	})

	it('leaves usage extraction unchanged by the timing fields', () => {
		expect(extractUsage(TIMING_TERMINAL)).toEqual({ prompt: 26, completion: 298, total: 324 })
		expect(extractUsage({ ...TIMING_TERMINAL, total_duration: 'x', eval_duration: -1 })).toEqual({
			prompt: 26,
			completion: 298,
			total: 324,
		})
		expect(extractUsage({ done: true, total_duration: 1234567890123 })).toBeUndefined()
	})
})

describe('extractTools', () => {
	it('narrows an entry and mints an id when the wire omits one', () => {
		const [call] = extractTools({
			message: { tool_calls: [{ function: { name: 'weather', arguments: { city: 'Oslo' } } }] },
		})

		expect(call?.name).toBe('weather')
		expect(call?.arguments).toEqual({ city: 'Oslo' })
		expect(call?.id.length).toBeGreaterThan(0)
	})

	it('keeps a string id from the wire', () => {
		const [call] = extractTools({
			message: { tool_calls: [{ id: 'call-1', function: { name: 'weather', arguments: {} } }] },
		})

		expect(call?.id).toBe('call-1')
	})

	it('refuses an entry that is not a record, naming its position', () => {
		expect(() =>
			extractTools({
				message: { tool_calls: [{ function: { name: 'weather', arguments: {} } }, 'clock'] },
			}),
		).toThrow(
			expect.objectContaining({
				code: 'PROTOCOL',
				message: expect.stringContaining('message.tool_calls[1]'),
			}),
		)
	})

	it('refuses an entry whose function is absent or not a record', () => {
		for (const entry of [{}, { function: 'weather' }]) {
			expect(() => extractTools({ message: { tool_calls: [entry] } })).toThrow(
				expect.objectContaining({ code: 'PROTOCOL' }),
			)
		}
	})

	it('refuses an entry whose name is not a string', () => {
		expect(() =>
			extractTools({ message: { tool_calls: [{ function: { name: 7, arguments: {} } }] } }),
		).toThrow(expect.objectContaining({ code: 'PROTOCOL' }))
	})

	it('refuses a hole among the entries, because a dropped call reads as a final answer', () => {
		const calls = Object.assign([], {
			0: { id: 'call-1', function: { name: 'weather', arguments: {} } },
			2: { id: 'call-3', function: { name: 'clock', arguments: {} } },
		})

		expect(() => extractTools({ message: { tool_calls: calls } })).toThrow(
			expect.objectContaining({ code: 'PROTOCOL' }),
		)
	})

	it('throws on an array without an iterator instead of reading it as array-like', () => {
		for (const iterator of ABSENT_ITERATORS) {
			const calls = Object.defineProperty(
				[{ id: 'call', function: { name: 'lookup', arguments: {} } }],
				Symbol.iterator,
				{ value: iterator },
			)

			expect(() => extractTools({ message: { tool_calls: calls } })).toThrow(TypeError)
		}
	})

	it('closes the iterator it opened when an entry refuses', () => {
		const closed = createRecorder<[]>()
		const refusing = Object.defineProperty({}, 'function', {
			get: () => {
				throw new RangeError('entry refused')
			},
		})
		const calls = buildClosingList([refusing, refusing], closed.handler)
		expect(() => extractTools({ message: { tool_calls: calls } })).toThrow(RangeError)
		expect(closed.calls).toEqual([[]])
	})

	it('maps each entry before it asks the iterator for the next', () => {
		const events = createRecorder<[event: string]>()
		const calls = Object.defineProperty([], Symbol.iterator, {
			value: () =>
				['first', 'second'].values().map((name, index) => {
					events.handler(`next ${index}`)
					return Object.defineProperty({}, 'function', {
						get: () => {
							events.handler(`read ${index}`)
							return { name, arguments: {} }
						},
					})
				}),
		})

		expect(extractTools({ message: { tool_calls: calls } }).map((call) => call.name)).toEqual([
			'first',
			'second',
		])
		expect(events.calls).toEqual([['next 0'], ['read 0'], ['next 1'], ['read 1']])
	})

	it('returns no calls when tool_calls or the message is absent', () => {
		expect(extractTools({ message: { content: 'ok' } })).toEqual([])
		expect(extractTools({})).toEqual([])
	})

	it('refuses tool_calls that are not an array and a message that is not a record', () => {
		expect(() => extractTools({ message: { tool_calls: 'weather' } })).toThrow(
			expect.objectContaining({ code: 'PROTOCOL' }),
		)
		expect(() => extractTools({ message: 'ok' })).toThrow(
			expect.objectContaining({ code: 'PROTOCOL' }),
		)
	})
})

describe('extractArguments', () => {
	it('passes a record through unchanged', () => {
		expect(extractArguments({ city: 'Oslo' })).toEqual({ city: 'Oslo' })
	})

	it('parses a JSON string that yields a record', () => {
		expect(extractArguments('{"city":"Oslo"}')).toEqual({ city: 'Oslo' })
	})

	it('refuses a malformed JSON string', () => {
		expect(() => extractArguments('{city:')).toThrow(expect.objectContaining({ code: 'PROTOCOL' }))
	})

	it('refuses a JSON string that is not an object', () => {
		expect(() => extractArguments('42')).toThrow(expect.objectContaining({ code: 'PROTOCOL' }))
	})

	it('refuses a value that is neither, an absent one included', () => {
		for (const value of [undefined, null, 42, []]) {
			expect(() => extractArguments(value)).toThrow(expect.objectContaining({ code: 'PROTOCOL' }))
		}
	})
})

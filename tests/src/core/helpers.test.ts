import type { JudgeQuestion, Message } from '@orkestrel/agent'
import { computeReading, JudgeError } from '@orkestrel/agent'
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
	it('renders empty noul criteria as their key words', () => {
		expect(
			renderJudgePrompt('', { form: 'noul', criteria: { false: '', true: '' } }, 'system'),
		).toBe(
			'<|im_start|>system\nsystem<|im_end|>\n<|im_start|>user\n<state>\n\n</state>\nQuestion: \nCriteria:\nfalse: false\ntrue: true\nAnswer Yes if true, or No if false.<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n',
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
		expect(renderJudgePrompt({ café: ['yes', true] }, { form: 'noul' }, 'system')).toContain(
			'<state>\n{\n "café": [\n  "yes",\n  true\n ]\n}\n</state>\nQuestion: \nCriteria:\nfalse: false\ntrue: true\n',
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
		expect(computeReading(choice).winner).toBe('billing')
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
})

describe('extractContent', () => {
	it('reads a string message.content', () => {
		expect(extractContent({ message: { content: 'ok' } })).toBe('ok')
	})

	it('degrades to an empty string for a missing message', () => {
		expect(extractContent({})).toBe('')
	})

	it('degrades to an empty string for a non-record message', () => {
		expect(extractContent({ message: 'ok' })).toBe('')
	})

	it('degrades to an empty string for a non-string content', () => {
		expect(extractContent({ message: { content: 42 } })).toBe('')
	})
})

describe('extractThinking', () => {
	it('reads a string message.thinking', () => {
		expect(extractThinking({ message: { thinking: 'weighing it' } })).toBe('weighing it')
	})

	it('degrades to an empty string for a content-only record', () => {
		expect(extractThinking({ message: { content: 'ok' } })).toBe('')
	})

	it('degrades to an empty string for a non-record message', () => {
		expect(extractThinking({ message: null })).toBe('')
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

	it('yields undefined when a count is not a number', () => {
		expect(extractUsage({ prompt_eval_count: '3', eval_count: 4 })).toBeUndefined()
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
			message: { tool_calls: [{ id: 'call-1', function: { name: 'weather' } }] },
		})

		expect(call?.id).toBe('call-1')
	})

	it('drops an entry whose function is not a record', () => {
		expect(extractTools({ message: { tool_calls: [{ function: 'weather' }] } })).toEqual([])
	})

	it('drops an entry whose name is not a string', () => {
		expect(extractTools({ message: { tool_calls: [{ function: { name: 7 } }] } })).toEqual([])
	})

	it('drops a hole among the entries and keeps the others in wire order', () => {
		const calls = Object.assign([], {
			0: { id: 'call-1', function: { name: 'weather' } },
			2: { id: 'call-3', function: { name: 'clock' } },
		})

		expect(extractTools({ message: { tool_calls: calls } }).map((call) => call.id)).toEqual([
			'call-1',
			'call-3',
		])
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
							return { name }
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

	it('returns no calls when tool_calls is absent or not an array', () => {
		expect(extractTools({ message: { content: 'ok' } })).toEqual([])
		expect(extractTools({ message: { tool_calls: 'weather' } })).toEqual([])
		expect(extractTools({})).toEqual([])
	})
})

describe('extractArguments', () => {
	it('passes a record through unchanged', () => {
		expect(extractArguments({ city: 'Oslo' })).toEqual({ city: 'Oslo' })
	})

	it('parses a JSON string that yields a record', () => {
		expect(extractArguments('{"city":"Oslo"}')).toEqual({ city: 'Oslo' })
	})

	it('yields an empty record for a malformed JSON string', () => {
		expect(extractArguments('{city:')).toEqual({})
	})

	it('yields an empty record for a JSON string that is not an object', () => {
		expect(extractArguments('42')).toEqual({})
	})

	it('yields an empty record for a value that is neither', () => {
		expect(extractArguments(undefined)).toEqual({})
	})
})

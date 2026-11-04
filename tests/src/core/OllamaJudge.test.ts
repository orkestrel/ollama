import { measureAnswer, isJudgeAbortError, JudgeError } from '@orkestrel/agent'
import { waitForAbort } from '@orkestrel/test'
import { OllamaJudge, renderJudgeIdentity } from '@src/core'
import { describe, expect, it } from 'vitest'
import {
	OLLAMA_CONTEXT_REFUSAL,
	OLLAMA_INVALID_OPTIONS,
	OLLAMA_VALID_OPTIONS,
} from '../../setup.js'
import {
	createErrorTransport,
	createRecordingTransport,
	createRefusingTransport,
	createStreamingTransport,
	JUDGE_CHOICE_REQUEST,
	JUDGE_INVALID_QUESTIONS,
	JUDGE_NOUL_REQUEST,
	JUDGE_RAW_CHOICE,
	JUDGE_RAW_NOUL,
	JUDGE_WIRE_CHOICE,
	JUDGE_WIRE_NOUL,
	MICA_SYSTEM,
	MICA_CALIBRATION,
} from '../../setupServer.js'

describe('OllamaJudge', () => {
	it('sends the recorded raw noul request and reads calibration, identity, and usage', async () => {
		const transport = createRecordingTransport(
			createStreamingTransport([JSON.stringify(JUDGE_RAW_NOUL)]),
		)
		const judge = new OllamaJudge({
			model: JUDGE_WIRE_NOUL.model,
			system: MICA_SYSTEM,
			calibration: MICA_CALIBRATION,
			keepAlive: '30m',
			options: { num_ctx: 8192, temperature: 0, num_predict: 99 },
			fetch: transport.fetch,
			headers: () => ({ 'x-judge': 'fixture' }),
		})
		const result = await judge.ask(JUDGE_NOUL_REQUEST, new AbortController().signal)
		expect(transport.requests[0]?.path).toBe('/api/generate')
		expect(transport.requests[0]?.method).toBe('POST')
		expect(transport.requests[0]?.headers['x-judge']).toBe('fixture')
		expect(transport.requests[0]?.body).toEqual(JUDGE_WIRE_NOUL)
		expect(result.model).toBe(judge.model)
		expect(result.model).toBe(
			renderJudgeIdentity({
				model: JUDGE_WIRE_NOUL.model,
				system: MICA_SYSTEM,
				calibration: MICA_CALIBRATION,
				options: { num_ctx: 8192, num_predict: 1, temperature: 1 },
			}),
		)
		expect(result.usage).toEqual({ prompt: 138, completion: 1, total: 139 })
		expect(result.refusals).toBeUndefined()
		const answer = result.answers.deletion
		if (answer === undefined) throw new Error('Missing deletion answer')
		expect(measureAnswer(answer).winner).toBe('false')
		expect(measureAnswer(answer).probability).toBeCloseTo(0.99, 3)
	})
	it('sends the recorded choice prompt and reports billing as the winner', async () => {
		const transport = createRecordingTransport(
			createStreamingTransport([JSON.stringify(JUDGE_RAW_CHOICE)]),
		)
		const judge = new OllamaJudge({
			model: JUDGE_WIRE_CHOICE.model,
			system: MICA_SYSTEM,
			calibration: MICA_CALIBRATION,
			fetch: transport.fetch,
		})
		const result = await judge.ask(JUDGE_CHOICE_REQUEST, new AbortController().signal)
		expect(transport.requests[0]?.body.prompt).toBe(JUDGE_WIRE_CHOICE.prompt)
		expect(transport.requests[0]?.body.keep_alive).toBe('5m')
		const answer = result.answers.team
		if (answer === undefined) throw new Error('Missing team answer')
		expect(measureAnswer(answer).winner).toBe('billing')
	})
	it.each(JUDGE_INVALID_QUESTIONS)(
		'refuses unsupported question %j before any call',
		async (question) => {
			const transport = createRefusingTransport()
			const judge = new OllamaJudge({ model: 'mica', system: MICA_SYSTEM, fetch: transport.fetch })
			await expect(
				judge.ask(
					{
						state: 'state',
						questions: { valid: { form: 'noul', instructions: 'Is it valid?' }, invalid: question },
					},
					new AbortController().signal,
				),
			).rejects.toMatchObject({
				code: 'QUESTION',
				message: expect.stringMatching(/^judge error: question invalid /),
				cause: expect.objectContaining({
					code: 'QUESTION',
					message: expect.stringMatching(/^judge error: [a-z]/),
				}),
			})
			expect(transport.signals).toEqual([])
		},
	)
	it('sends truncate:false by default and truncate:true as the opt-out, which the identity records', () => {
		const refusing = new OllamaJudge({ model: 'mica', system: MICA_SYSTEM })
		const cutting = new OllamaJudge({ model: 'mica', system: MICA_SYSTEM, truncate: true })

		expect(refusing.encode(JUDGE_NOUL_REQUEST).truncate).toBe(false)
		expect(cutting.encode(JUDGE_NOUL_REQUEST).truncate).toBe(true)
		expect(refusing.model).toBe(
			new OllamaJudge({ model: 'mica', system: MICA_SYSTEM, truncate: false }).model,
		)
		expect(cutting.model).not.toBe(refusing.model)
		expect(refusing.model).toBe(
			JSON.stringify([
				'mica',
				MICA_SYSTEM,
				1,
				{ num_predict: 1, temperature: 1 },
				'mica-native-2026-10-07-v1',
			]),
		)
	})
	it('names the remedy on the 400 the daemon answers a prompt over its window, keeping the code and status', async () => {
		const judge = new OllamaJudge({
			model: 'mica',
			system: MICA_SYSTEM,
			fetch: createErrorTransport(400, OLLAMA_CONTEXT_REFUSAL),
		})

		await expect(judge.ask(JUDGE_NOUL_REQUEST, new AbortController().signal)).rejects.toMatchObject(
			{
				code: 'HTTP',
				status: 400,
				message: `judge error: 400 - ${OLLAMA_CONTEXT_REFUSAL}; the prompt exceeds the model's context window; shorten the state, raise options.num_ctx, or set truncate: true to let the daemon cut it`,
				cause: expect.any(JudgeError),
			},
		)
	})
	it('leaves a 400 that names no context as the daemon said it', async () => {
		const judge = new OllamaJudge({
			model: 'mica',
			system: MICA_SYSTEM,
			fetch: createErrorTransport(400, '{"error":"model does not support logprobs"}'),
		})

		await expect(judge.ask(JUDGE_NOUL_REQUEST, new AbortController().signal)).rejects.toMatchObject(
			{
				message: 'judge error: 400 - {"error":"model does not support logprobs"}',
			},
		)
	})
	it('refuses a response that names another model and admits one that names none', () => {
		const judge = new OllamaJudge({ model: 'mica', system: MICA_SYSTEM })

		expect(() => judge.read({ ...JUDGE_RAW_NOUL, model: 'other' }, JUDGE_NOUL_REQUEST)).toThrow(
			expect.objectContaining({
				code: 'PROTOCOL',
				message: expect.stringContaining('question deletion the daemon answered for model "other"'),
			}),
		)
		expect(
			judge.read({ ...JUDGE_RAW_NOUL, model: undefined }, JUDGE_NOUL_REQUEST).answers.deletion,
		).toBeDefined()
		expect(
			new OllamaJudge({ model: JUDGE_RAW_NOUL.model, system: MICA_SYSTEM }).read(
				JUDGE_RAW_NOUL,
				JUDGE_NOUL_REQUEST,
			).answers.deletion,
		).toBeDefined()
	})
	it.each(
		OLLAMA_VALID_OPTIONS.filter(([, options]) => !('think' in options || 'replay' in options)),
	)('admits %s', (_label, options) => {
		const judge: unknown = Reflect.construct(OllamaJudge, [
			{ model: 'mica', system: MICA_SYSTEM, ...options },
		])

		expect(judge).toBeInstanceOf(OllamaJudge)
	})
	it.each(OLLAMA_INVALID_OPTIONS.filter(([, options]) => !('shift' in options)))(
		'refuses %s at construction, naming the path',
		(_label, options, path) => {
			expect(() =>
				Reflect.construct(OllamaJudge, [{ model: 'mica', system: MICA_SYSTEM, ...options }]),
			).toThrow(
				expect.objectContaining({
					code: 'QUESTION',
					message: expect.stringContaining(path),
					cause: {
						faults: expect.arrayContaining([expect.objectContaining({ path: [path] })]),
					},
				}),
			)
		},
	)
	it('refuses a judge with no system prompt and a malformed calibration at construction', () => {
		expect(() => Reflect.construct(OllamaJudge, [{ model: 'mica' }])).toThrow(
			expect.objectContaining({ code: 'QUESTION', message: expect.stringContaining('system') }),
		)
		expect(
			() =>
				new OllamaJudge({
					model: 'mica',
					system: MICA_SYSTEM,
					calibration: Object.assign({ temperature: 1 }, { tempreture: 1 }),
				}),
		).toThrow(expect.objectContaining({ message: expect.stringContaining('tempreture') }))
	})
	it('keeps later answers and sums spent usage when a preceding question is refused', async () => {
		const transport = createRecordingTransport(
			createStreamingTransport([JSON.stringify({ ...JUDGE_RAW_NOUL, model: 'mica' })]),
		)
		const judge = new OllamaJudge({ model: 'mica', system: MICA_SYSTEM, fetch: transport.fetch })
		const result = await judge.ask(
			{
				state: 'state',
				questions: {
					routing: {
						form: 'choice',
						criteria: { billing: null, technical: null, sales: null, account: null },
					},
					permission: { form: 'noul', instructions: 'May the agent proceed?' },
				},
			},
			new AbortController().signal,
		)
		expect(result.refusals).toEqual({ routing: { missing: ['account'] } })
		expect(Object.keys(result.answers)).toEqual(['permission'])
		expect(result.usage).toEqual({ prompt: 276, completion: 2, total: 278 })
		expect(transport.requests).toHaveLength(2)
	})
	it('reads score distributions and preserves arbitrary caller keys', () => {
		const judge = new OllamaJudge({ model: JUDGE_RAW_CHOICE.model, system: MICA_SYSTEM })
		const result = judge.read(JUDGE_RAW_CHOICE, {
			state: '',
			questions: { ['__proto__']: { form: 'score', criteria: ['low', 'middle', 'high'] } },
		})
		const answer = result.answers.__proto__
		if (answer === undefined || answer.form !== 'score') throw new Error('Missing score')
		expect(answer.probabilities).toHaveLength(3)
		expect(answer.probabilities.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12)
	})
	it('rejects malformed or incomplete responses and omits unavailable usage', () => {
		const judge = new OllamaJudge({ model: JUDGE_RAW_NOUL.model, system: MICA_SYSTEM })
		expect(() => judge.read({ ...JUDGE_RAW_NOUL, done: false }, JUDGE_NOUL_REQUEST)).toThrow(
			expect.objectContaining({
				code: 'PROTOCOL',
				message: 'judge error: question deletion mica read requires a completed response',
				cause: expect.any(JudgeError),
			}),
		)
		expect(() => judge.read({ done: true }, JUDGE_NOUL_REQUEST)).toThrow(
			expect.objectContaining({
				code: 'PROTOCOL',
				message: 'judge error: question deletion missing first-position top logprobs',
				cause: expect.any(JudgeError),
			}),
		)
		expect(() => judge.read(null, JUDGE_NOUL_REQUEST)).toThrow(
			'judge error: question deletion mica read requires a completed response',
		)
		expect(() =>
			judge.read(
				{ ...JUDGE_RAW_NOUL, logprobs: [{ top_logprobs: [{ token: 'No', logprob: NaN }] }] },
				JUDGE_NOUL_REQUEST,
			),
		).toThrow('judge error: question deletion invalid or duplicate top logprob token')
		expect(
			judge.read({ ...JUDGE_RAW_NOUL, eval_count: undefined }, JUDGE_NOUL_REQUEST).usage,
		).toBeUndefined()
		expect(() => judge.read({ ...JUDGE_RAW_NOUL, eval_count: -1 }, JUDGE_NOUL_REQUEST)).toThrow(
			expect.objectContaining({
				code: 'PROTOCOL',
				message:
					'judge error: question deletion eval_count must be a finite nonnegative number; received -1',
				cause: expect.any(Error),
			}),
		)
		expect(() => judge.read({ ...JUDGE_RAW_NOUL, eval_count: -1 }, JUDGE_NOUL_REQUEST)).toThrow(
			JudgeError,
		)
		expect(() => judge.encode({ state: '', questions: {} })).toThrow(JudgeError)
	})
	it('rejects invalid calibration before transport', () => {
		expect(
			() =>
				new OllamaJudge({ model: 'mica', system: MICA_SYSTEM, calibration: { temperature: -1 } }),
		).toThrow('judge error: calibration temperature must be finite and positive')
		expect(
			() =>
				new OllamaJudge({
					model: 'mica',
					system: MICA_SYSTEM,
					calibration: { temperature: Infinity },
				}),
		).toThrow(JudgeError)
	})
	it('uses the inherited HTTP and transport error contracts', async () => {
		const refusing = createRefusingTransport()
		const offline = new OllamaJudge({ model: 'mica', system: MICA_SYSTEM, fetch: refusing.fetch })
		await expect(offline.ask(JUDGE_NOUL_REQUEST, new AbortController().signal)).rejects.toThrow(
			'fetch failed',
		)
		const rejected = new OllamaJudge({
			model: 'mica',
			system: MICA_SYSTEM,
			fetch: () => Promise.resolve(new Response('unavailable model', { status: 404 })),
		})
		await expect(
			rejected.ask(JUDGE_NOUL_REQUEST, new AbortController().signal),
		).rejects.toMatchObject({ code: 'HTTP', status: 404 })
	})
	it('preserves completed usage when the second header hook cancels', async () => {
		const abort = new AbortController()
		const transport = createRecordingTransport(
			createStreamingTransport([JSON.stringify({ ...JUDGE_RAW_NOUL, model: 'mica' })]),
		)
		const judge = new OllamaJudge({
			model: 'mica',
			system: MICA_SYSTEM,
			fetch: transport.fetch,
			headers: () => {
				if (transport.requests.length === 1) abort.abort()
				return {}
			},
		})
		const error: unknown = await judge
			.ask(
				{
					state: 'state',
					questions: {
						first: { form: 'noul', instructions: 'Is the first true?' },
						second: { form: 'noul', instructions: 'Is the second true?' },
					},
				},
				abort.signal,
			)
			.catch((caught: unknown) => caught)
		expect(isJudgeAbortError(error)).toBe(true)
		if (!isJudgeAbortError(error)) throw new Error('Expected abort', { cause: error })
		expect(Object.keys(error.partial.answers)).toEqual(['first'])
		expect(error.partial.usage).toEqual({ prompt: 138, completion: 1, total: 139 })
		expect(transport.requests).toHaveLength(1)
	})
	it('passes timeout into the engine and refuses pre-aborted calls without transport', async () => {
		const transport = createRefusingTransport()
		const judge = new OllamaJudge({
			model: 'mica',
			system: MICA_SYSTEM,
			fetch: transport.fetch,
			timeout: 10,
			headers: async (signal) => {
				await waitForAbort(signal)
				return {}
			},
		})
		await expect(judge.ask(JUDGE_NOUL_REQUEST, new AbortController().signal)).rejects.toMatchObject(
			{ code: 'ABORT', partial: { answers: {} } },
		)
		await expect(judge.ask(JUDGE_NOUL_REQUEST, AbortSignal.abort())).rejects.toMatchObject({
			code: 'ABORT',
		})
		expect(transport.signals).toEqual([])
	})
})

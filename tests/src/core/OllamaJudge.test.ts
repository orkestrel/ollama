import { computeReading, isJudgeAbortError, JudgeError } from '@orkestrel/agent'
import { waitForAbort } from '@orkestrel/test'
import { OllamaJudge, renderJudgeIdentity } from '@src/core'
import { describe, expect, it } from 'vitest'
import {
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
		expect(computeReading(answer).winner).toBe('false')
		expect(computeReading(answer).probability).toBeCloseTo(0.99, 3)
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
		expect(computeReading(answer).winner).toBe('billing')
	})
	it.each(JUDGE_INVALID_QUESTIONS)(
		'refuses unsupported question %j before any call',
		async (question) => {
			const transport = createRefusingTransport()
			const judge = new OllamaJudge({ model: 'mica', system: MICA_SYSTEM, fetch: transport.fetch })
			await expect(
				judge.ask(
					{ state: 'state', questions: { valid: { form: 'noul' }, invalid: question } },
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
	it('keeps later answers and sums spent usage when a preceding question is refused', async () => {
		const transport = createRecordingTransport(
			createStreamingTransport([JSON.stringify(JUDGE_RAW_NOUL)]),
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
					permission: { form: 'noul' },
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
		const judge = new OllamaJudge({ model: 'mica', system: MICA_SYSTEM })
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
		const judge = new OllamaJudge({ model: 'mica', system: MICA_SYSTEM })
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
		expect(
			judge.read({ ...JUDGE_RAW_NOUL, eval_count: -1 }, JUDGE_NOUL_REQUEST).usage,
		).toBeUndefined()
		expect(() => judge.body({ state: '', questions: {} })).toThrow(JudgeError)
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
			createStreamingTransport([JSON.stringify(JUDGE_RAW_NOUL)]),
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
				{ state: 'state', questions: { first: { form: 'noul' }, second: { form: 'noul' } } },
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

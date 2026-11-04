import { measureAnswer, createSystemOneJudge, isJudgeError } from '@orkestrel/agent'
import { createOllamaJudge } from '@src/core'
import { beforeAll, expect, it } from 'vitest'
import { JUDGE_NOUL_REQUEST, JUDGE_SYSTEM_REQUEST, MICA_SYSTEM } from '../setupServer.js'
import { isOllamaReady, OLLAMA_CONFIG, OLLAMA_JUDGE_CONFIG, warmOllama } from '../setupService.js'

beforeAll(async () => {
	for (const model of [OLLAMA_JUDGE_CONFIG.model, OLLAMA_JUDGE_CONFIG.decision]) {
		if (!(await isOllamaReady(model)))
			throw new Error(`Judge service requires ${model} at ${OLLAMA_CONFIG.host}; pull the model`)
	}
	// The recorded cold Mica load took 230850 ms on this CPU host.
	await warmOllama(OLLAMA_JUDGE_CONFIG.model, 300_000)
}, 310_000)

it('reads Mica raw probabilities, native decision forms, and the Mica System One refusal', async () => {
	const judge = createOllamaJudge({
		url: OLLAMA_CONFIG.host,
		model: OLLAMA_JUDGE_CONFIG.model,
		system: MICA_SYSTEM,
		calibration: { temperature: OLLAMA_JUDGE_CONFIG.temperature },
		options: { num_ctx: 8192 },
		keepAlive: '30m',
	})
	const result = await judge.ask(JUDGE_NOUL_REQUEST, AbortSignal.timeout(120_000))
	const answer = result.answers.deletion
	if (answer === undefined) throw new Error('Mica refused the deletion question')
	const measure = measureAnswer(answer)
	expect(measure.winner).toBe('false')
	// The raw fixture reads No 0.990 against the desk's pinned 0.9884; 0.005 covers that observed gap.
	expect(Math.abs(measure.probability - 0.9884)).toBeLessThanOrEqual(0.005)
	expect(result.usage?.completion).toBe(1)

	const native = createSystemOneJudge({
		url: OLLAMA_CONFIG.host,
		model: OLLAMA_JUDGE_CONFIG.decision,
	})
	const decisions = await native.ask(JUDGE_SYSTEM_REQUEST, AbortSignal.timeout(120_000))
	expect(decisions.refusals).toBeUndefined()
	expect(Object.keys(decisions.answers)).toEqual(['label', 'refund', 'severity'])
	expect(decisions.answers.label?.form).toBe('choice')
	expect(decisions.answers.refund?.form).toBe('noul')
	expect(decisions.answers.severity?.form).toBe('score')
	for (const decision of Object.values(decisions.answers)) {
		const observed = measureAnswer(decision)
		expect(observed.probability).toBeGreaterThanOrEqual(0)
		expect(observed.probability).toBeLessThanOrEqual(1)
	}

	const unsupported = createSystemOneJudge({
		url: OLLAMA_CONFIG.host,
		model: OLLAMA_JUDGE_CONFIG.model,
	})
	const error: unknown = await unsupported
		.ask(JUDGE_NOUL_REQUEST, AbortSignal.timeout(120_000))
		.catch((caught: unknown) => caught)
	expect(isJudgeError(error)).toBe(true)
	if (!isJudgeError(error)) throw new Error('Expected Mica System One refusal', { cause: error })
	expect(error.code).toBe('HTTP')
	expect(error.status).toBe(400)
})

// The state runs well past the 8192-token window at any tokenization, and `num_ctx` matches the case
// before it, so the daemon refuses from the loaded runner instead of reloading the model.
it('refuses a Mica prompt over the context window with its remedy, and truncate: true cuts it', async () => {
	const request = { ...JUDGE_NOUL_REQUEST, state: 'Background material. '.repeat(4096) }
	const declaration = {
		url: OLLAMA_CONFIG.host,
		model: OLLAMA_JUDGE_CONFIG.model,
		system: MICA_SYSTEM,
		calibration: { temperature: OLLAMA_JUDGE_CONFIG.temperature },
		options: { num_ctx: 8192 },
		keepAlive: '30m',
	}

	await expect(
		createOllamaJudge(declaration).ask(request, AbortSignal.timeout(120_000)),
	).rejects.toMatchObject({
		code: 'HTTP',
		status: 400,
		message: expect.stringContaining(
			"the prompt exceeds the model's context window; shorten the state, raise options.num_ctx, or set truncate: true to let the daemon cut it",
		),
	})

	const cut = await createOllamaJudge({ ...declaration, truncate: true }).ask(
		request,
		AbortSignal.timeout(120_000),
	)
	expect(Object.keys({ ...cut.answers, ...cut.refusals })).toEqual(['deletion'])
})

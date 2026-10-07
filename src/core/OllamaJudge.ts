import type { AgentJudgeInterface, JudgeRequest, JudgeResult } from '@orkestrel/agent'
import type { OllamaJudgeOptions, WireGenerateRequest } from './types.js'
import { AgentJudge, JudgeError } from '@orkestrel/agent'
import { isTokenUsage } from '@orkestrel/budget'
import { isObject } from '@orkestrel/contract'
import {
	DEFAULT_KEEP_ALIVE,
	DEFAULT_OLLAMA_URL,
	OLLAMA_GENERATE_PATH,
	TOP_LOGPROBS,
} from './constants.js'
import {
	computeAnswer,
	extractTop,
	extractUsage,
	renderJudgeIdentity,
	renderJudgePrompt,
} from './helpers.js'

/**
 * Implements Mica's raw Ollama logprob wire over the shared judge engine.
 *
 * @remarks
 * Each question uses a separate non-streaming generate request. The engine validates
 * every body before inference, bounds calls, and preserves completed answers on abort.
 * The model identity includes the tag, system prompt, calibration, and render revision.
 *
 * @example
 * ```ts
 * const judge = new OllamaJudge({ model: 'mica', system: 'Judge the state.' })
 * const result = await judge.ask({ state: 'Approved.', questions: { approval: { form: 'noul' } } }, new AbortController().signal)
 * ```
 */
export class OllamaJudge extends AgentJudge implements AgentJudgeInterface {
	readonly name = 'ollama'
	readonly #tag: string
	readonly #system: string
	readonly #temperature: number
	readonly #keepAlive: string
	readonly #options: Readonly<Record<string, unknown>>

	constructor(options: OllamaJudgeOptions) {
		const {
			model,
			system,
			calibration,
			url,
			keepAlive,
			options: sampling,
			timeout,
			fetch,
			headers,
		} = options
		const temperature = calibration?.temperature ?? 1
		super({
			url: url ?? DEFAULT_OLLAMA_URL,
			path: OLLAMA_GENERATE_PATH,
			model: renderJudgeIdentity({ model, system, calibration: { temperature } }),
			batch: false,
			...(timeout === undefined ? {} : { timeout }),
			...(fetch === undefined ? {} : { fetch }),
			...(headers === undefined ? {} : { headers }),
		})
		this.#tag = model
		this.#system = system
		this.#temperature = temperature
		this.#keepAlive = keepAlive ?? DEFAULT_KEEP_ALIVE
		this.#options = Object.freeze({ ...sampling, num_predict: 1, temperature: 1 })
	}

	/**
	 * Projects a single question onto Mica's raw generate request.
	 * @param request - The state and a single question supplied by the engine
	 * @returns The raw non-streaming body with fixed readout sampling
	 * @throws JudgeError Thrown with code `QUESTION` for multiple questions or unsupported question content
	 */
	body(request: JudgeRequest): WireGenerateRequest {
		const entries = Object.entries(request.questions)
		const entry = entries[0]
		if (entries.length !== 1 || entry === undefined)
			throw new JudgeError('QUESTION', 'Mica body requires one question')
		return {
			model: this.#tag,
			prompt: renderJudgePrompt(request.state, entry[1], this.#system),
			raw: true,
			stream: false,
			logprobs: true,
			top_logprobs: TOP_LOGPROBS,
			keep_alive: this.#keepAlive,
			options: this.#options,
		}
	}

	/**
	 * Decodes a completed raw response into an answer or a missing-label refusal.
	 * @param value - The parsed generate response
	 * @param request - The single question defining the expected candidate labels
	 * @returns The calibrated answer or refusal, configured identity, and available usage
	 * @throws JudgeError Thrown with code `PROTOCOL` for an incomplete or malformed response
	 */
	read(value: unknown, request: JudgeRequest): JudgeResult {
		const entries = Object.entries(request.questions)
		const entry = entries[0]
		if (
			entries.length !== 1 ||
			entry === undefined ||
			!isObject(value) ||
			Reflect.get(value, 'done') !== true
		)
			throw new JudgeError('PROTOCOL', 'Mica read requires one question and a completed response')
		const answer = computeAnswer(entry[1], extractTop(value), this.#temperature)
		const usage = extractUsage({
			prompt_eval_count: Reflect.get(value, 'prompt_eval_count'),
			eval_count: Reflect.get(value, 'eval_count'),
		})
		return {
			model: this.model,
			...('form' in answer
				? { answers: { [entry[0]]: answer } }
				: { answers: {}, refusals: { [entry[0]]: answer } }),
			...(isTokenUsage(usage) ? { usage } : {}),
		}
	}
}

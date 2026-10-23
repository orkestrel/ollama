import type { JudgeAnswer, JudgeEntry, JudgeQuestion, Message, Refusal } from '@orkestrel/agent'
import type { TokenUsage } from '@orkestrel/budget'
import type { ToolCall } from '@orkestrel/tool'
import type { Logprob, OllamaJudgeOptions, OllamaTiming, WireChatRequest } from './types.js'
import { JudgeError } from '@orkestrel/agent'
import {
	isArray,
	isFiniteNumber,
	isNonNegativeInteger,
	isNumber,
	isObject,
	isRecord,
	isString,
	parseJSONAs,
} from '@orkestrel/contract'
import {
	MAX_MICA_LEVELS,
	MICA_NOUL_LABELS,
	MICA_OPTION_LABELS,
	MICA_RENDER_REVISION,
	MICA_SPECIAL_TOKENS,
	TOP_LOGPROBS,
} from './constants.js'

/**
 * Escapes Mica control tokens by inserting U+200B after their opening angle bracket.
 * @param text - The untrusted text to render
 * @returns The text with control tokens escaped and all other bytes preserved
 * @example
 * ```ts
 * escapeSpecialTokens('<think>') // '<\u200bthink>'
 * ```
 */
export function escapeSpecialTokens(text: string): string {
	return MICA_SPECIAL_TOKENS.reduce(
		(escaped, token) => escaped.replaceAll(token, `<\u200b${token.slice(1)}`),
		text,
	)
}

/**
 * Mirrors the TypeSafe adapter path of Mica's server, from the `rows_from_request` function in the `typesafe_server.py` file to the `prompt_for` function in the `native.py` file, with disabled thinking. Serializes structured state as JSON with a one-space indent and JavaScript numeric spelling; parity is byte-exact for string states and structured states whose numbers spell the same in both runtimes.
 * @remarks
 * JavaScript cannot distinguish 100.0 from 100 and spells an exponent as 1e-7 where Python spells 1e-07.
 * @param state - The text or structured JSON state
 * @param question - The question with string instructions and descriptions
 * @param system - The model's training system prompt, preserved verbatim
 * @returns The complete raw generate prompt
 * @throws JudgeError Thrown with code `QUESTION` for structured instructions or criteria, or an unsupported candidate count
 * @example
 * ```ts
 * renderJudgePrompt('Approved.', { form: 'noul' }, 'Judge the state.')
 * ```
 */
export function renderJudgePrompt(
	state: JudgeEntry,
	question: JudgeQuestion,
	system: string,
): string {
	const labels = buildJudgeLabels(question)
	const instructions = question.instructions ?? ''
	if (!isString(instructions))
		throw new JudgeError('QUESTION', 'judge error: mica instructions must be text')
	const entries =
		question.form === 'choice'
			? Object.entries(question.criteria)
			: question.form === 'score'
				? question.criteria.map((text, index) => [String(index), text] as const)
				: []
	// The following iterable hands `Array.from` only the iterator protocol, as `for…of` consumed
	// `entries`: a `map` result without an iterator throws instead of falling back to array-like
	// access, and a hole is visited as `undefined`.
	const lines =
		question.form === 'noul'
			? (['false', 'true'] as const).map((key) => {
					const text = question.criteria?.[key] ?? key
					if (!isString(text))
						throw new JudgeError('QUESTION', `judge error: mica criterion ${key} must be text`)
					return `${key}: ${escapeSpecialTokens(text === '' ? key : text)}`
				})
			: Array.from(
					{
						[Symbol.iterator]() {
							return entries[Symbol.iterator]()
						},
					},
					([key, text]) => {
						if (text !== null && !isString(text))
							throw new JudgeError(
								'QUESTION',
								`judge error: mica criterion ${key} must be text or null`,
							)
						const label = labels.get(key)
						const named =
							question.form === 'choice' &&
							key !== '' &&
							key !== label &&
							!/^[cs]?\p{Nd}+$/u.test(key)
						return `${label}) ${named ? `[${escapeSpecialTokens(key)}] ` : ''}${escapeSpecialTokens(text === null ? 'None' : text)}`
					},
				)
	const ending =
		question.form === 'noul'
			? `Criteria:\n${lines.join('\n')}\nAnswer Yes if true, or No if false.`
			: `Candidates:\n${lines.join('\n')}\nAnswer with the label of the best ${question.form === 'score' ? 'level' : 'candidate'}.`
	return `<|im_start|>system\n${system}<|im_end|>\n<|im_start|>user\n<state>\n${escapeSpecialTokens(isString(state) ? state : JSON.stringify(state, null, 1))}\n</state>\nQuestion: ${escapeSpecialTokens(instructions)}\n${ending}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`
}

/**
 * Pairs caller candidate keys with Mica's output labels in criteria order.
 * @param question - The question whose candidates define the label map
 * @returns A map from caller keys to wire tokens
 * @throws JudgeError Thrown with code `QUESTION` outside the choice or score limits
 * @example
 * ```ts
 * buildJudgeLabels({ form: 'noul' }) // Map { 'false' => 'No', 'true' => 'Yes' }
 * ```
 */
export function buildJudgeLabels(question: JudgeQuestion): ReadonlyMap<string, string> {
	const keys =
		question.form === 'noul'
			? ['false', 'true']
			: question.form === 'choice'
				? Object.keys(question.criteria)
				: question.criteria.map((_, index) => String(index))
	const limit = question.form === 'score' ? MAX_MICA_LEVELS : TOP_LOGPROBS
	if (keys.length < 2 || keys.length > limit)
		throw new JudgeError(
			'QUESTION',
			`judge error: mica ${question.form} requires 2..${limit} candidates`,
		)
	const labels = question.form === 'noul' ? MICA_NOUL_LABELS : MICA_OPTION_LABELS
	return new Map(
		keys.map((key, index) => {
			const label = labels[index]
			if (label === undefined)
				throw new JudgeError('QUESTION', `judge error: missing mica label for ${key}`)
			return [key, label]
		}),
	)
}

/**
 * Extracts the first generated position's top logprobs without changing token text.
 * @param value - The parsed Ollama generate response
 * @returns The owned top list, preserving its wire order
 * @throws JudgeError Thrown with code `PROTOCOL` for a malformed list or a non-finite logprob
 * @example
 * ```ts
 * extractTopLogprobs({ logprobs: [{ top_logprobs: [{ token: 'No', logprob: -0.1 }] }] })
 * // [{ token: 'No', logprob: -0.1 }]
 * ```
 */
export function extractTopLogprobs(value: unknown): readonly Logprob[] {
	const positions: unknown = isObject(value) ? Reflect.get(value, 'logprobs') : undefined
	const first: unknown = isArray(positions) ? positions[0] : undefined
	const top: unknown = isObject(first) ? Reflect.get(first, 'top_logprobs') : undefined
	if (!isArray(top))
		throw new JudgeError('PROTOCOL', 'judge error: missing first-position top logprobs')
	const result: Logprob[] = []
	for (const entry of top) {
		const token: unknown = isObject(entry) ? Reflect.get(entry, 'token') : undefined
		const logprob: unknown = isObject(entry) ? Reflect.get(entry, 'logprob') : undefined
		if (
			!isString(token) ||
			!isFiniteNumber(logprob) ||
			result.some((earlier) => earlier.token === token)
		)
			throw new JudgeError('PROTOCOL', 'judge error: invalid or duplicate top logprob token')
		result.push({ token, logprob })
	}
	return result
}

/**
 * Computes a calibrated distribution over candidate labels or refuses missing candidates.
 * @param question - The question defining the candidate keys
 * @param top - The first position's top logprobs
 * @param temperature - The finite positive calibration temperature; default 1
 * @returns The answer, or a refusal naming every missing caller key
 * @throws JudgeError Thrown with code `QUESTION` for invalid calibration or candidate counts, or `PROTOCOL` for invalid logprobs
 * @example
 * ```ts
 * computeAnswer({ form: 'noul' }, [{ token: 'No', logprob: 0 }, { token: 'Yes', logprob: 0 }])
 * // { form: 'noul', noul: 0.5 }
 * ```
 */
export function computeAnswer(
	question: JudgeQuestion,
	top: readonly Logprob[],
	temperature = 1,
): JudgeAnswer | Refusal {
	if (!isFiniteNumber(temperature) || temperature <= 0)
		throw new JudgeError(
			'QUESTION',
			'judge error: calibration temperature must be finite and positive',
		)
	const labels = buildJudgeLabels(question)
	// A log of the readings so far: a repeated token throws, and `includes` matches a key as a `Map` does.
	const readings: Array<readonly [string, number]> = []
	for (const entry of top) {
		const { token, logprob } = entry
		if (!isFiniteNumber(logprob) || readings.map(([earlier]) => earlier).includes(token))
			throw new JudgeError('PROTOCOL', 'judge error: invalid or duplicate top logprob token')
		readings.push([token, logprob])
	}
	const available = new Map(readings)
	const answers = Array.from(labels, ([key, label]) => [key, available.get(label)] as const)
	const missing = answers.filter(([, logprob]) => logprob === undefined).map(([key]) => key)
	if (missing.length > 0) return { missing }
	const candidates = answers.flatMap(([key, logprob]) =>
		logprob === undefined ? [] : [[key, logprob] as const],
	)
	const peak = Math.max(...candidates.map(([, logprob]) => logprob))
	const weights = candidates.map(
		([key, logprob]) => [key, Math.exp((logprob - peak) / temperature)] as const,
	)
	const total = weights.reduce((sum, [, weight]) => sum + weight, 0)
	const probabilities = weights.map(([key, weight]) => [key, weight / total] as const)
	if (question.form === 'choice')
		return { form: 'choice', probabilities: Object.fromEntries(probabilities) }
	if (question.form === 'score')
		return { form: 'score', probabilities: probabilities.map(([, probability]) => probability) }
	const yes = probabilities.find(([key]) => key === 'true')
	if (yes === undefined) throw new JudgeError('PROTOCOL', 'judge error: missing true probability')
	return { form: 'noul', noul: yes[1] }
}

/**
 * Renders a stable identity from the model tag, system prompt, calibration, sorted effective options, and render revision.
 * @param options - The settings that define the judge's answers
 * @param revision - The render revision; defaults to the published revision
 * @returns An unambiguous JSON tuple identifying the configured judge
 * @throws JudgeError Thrown with code `QUESTION` for invalid calibration
 * @example
 * ```ts
 * renderJudgeIdentity({ model: 'mica', system: 'Judge.' }, 'v1')
 * // '["mica","Judge.",1,{"num_predict":1,"temperature":1},"v1"]'
 * ```
 */
export function renderJudgeIdentity(
	options: OllamaJudgeOptions,
	revision = MICA_RENDER_REVISION,
): string {
	const temperature = options.calibration?.temperature ?? 1
	if (!isFiniteNumber(temperature) || temperature <= 0)
		throw new JudgeError(
			'QUESTION',
			'judge error: calibration temperature must be finite and positive',
		)
	const effective = { ...options.options, num_predict: 1, temperature: 1 }
	const sorted = Object.fromEntries(
		Object.entries(effective).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
	)
	return JSON.stringify([options.model, options.system, temperature, sorted, revision])
}

/**
 * Maps conversation turns onto the `/api/chat` wire's minimal message shape.
 *
 * @remarks
 * `tool_calls` is emitted only on a turn that replays them and `images` only on a
 * multimodal turn, so an empty optional never reaches the wire.
 *
 * @param messages - The conversation turns to send
 * @returns The wire `messages` array, one entry per turn, in order
 *
 * @example
 * ```ts
 * mapMessages([{ id: '1', role: 'user', content: 'Say hello.' }])
 * // [{ role: 'user', content: 'Say hello.' }]
 * ```
 */
export function mapMessages(messages: readonly Message[]): WireChatRequest['messages'] {
	return messages.map((message) => ({
		role: message.role,
		content: message.content,
		...(message.calls !== undefined && message.calls.length > 0
			? {
					tool_calls: message.calls.map((call) => ({
						function: { name: call.name, arguments: call.arguments },
					})),
				}
			: {}),
		// Forward multimodal image data — Ollama accepts a base64 `images` array on a
		// message, which a vision-capable model receives alongside the text content.
		...(message.images !== undefined && message.images.length > 0
			? { images: [...message.images] }
			: {}),
	}))
}

/**
 * Extracts the assistant text of one wire record.
 *
 * @param record - One parsed `/api/chat` NDJSON record
 * @returns The record's `message.content` when it is a string, else `''`
 *
 * @example
 * ```ts
 * extractContent({ message: { content: 'ok' } }) // 'ok'
 * ```
 */
export function extractContent(record: Readonly<Record<string, unknown>>): string {
	const message = Reflect.get(record, 'message')
	if (!isRecord(message)) return ''
	const content = Reflect.get(message, 'content')
	return isString(content) ? content : ''
}

/**
 * Extracts the daemon-side reasoning of one wire record.
 *
 * @remarks
 * `message.thinking` is the `think: true` wire shape. It is read whatever the configured
 * flag says, because a daemon may separate reasoning on its own.
 *
 * @param record - One parsed `/api/chat` NDJSON record
 * @returns The record's `message.thinking` when it is a string, else `''`
 *
 * @example
 * ```ts
 * extractThinking({ message: { thinking: 'weighing it' } }) // 'weighing it'
 * ```
 */
export function extractThinking(record: Readonly<Record<string, unknown>>): string {
	const message = Reflect.get(record, 'message')
	if (!isRecord(message)) return ''
	const thinking = Reflect.get(message, 'thinking')
	return isString(thinking) ? thinking : ''
}

/**
 * Extracts the token usage of one wire record.
 *
 * @remarks
 * Both counts must be numbers, which is true of the stream's `done: true` line. A
 * delta line carries neither, so it yields `undefined`.
 *
 * @param record - One parsed `/api/chat` NDJSON record
 * @returns The `TokenUsage` shape, or `undefined` when either count is absent
 *
 * @example
 * ```ts
 * extractUsage({ prompt_eval_count: 3, eval_count: 4 })
 * // { prompt: 3, completion: 4, total: 7 }
 * ```
 */
export function extractUsage(record: Readonly<Record<string, unknown>>): TokenUsage | undefined {
	const prompt = Reflect.get(record, 'prompt_eval_count')
	const completion = Reflect.get(record, 'eval_count')
	if (!isNumber(prompt) || !isNumber(completion)) return undefined
	return { prompt, completion, total: prompt + completion }
}

/**
 * Extracts whether one terminal wire record reports that the model ended its answer at its own
 * token limit.
 *
 * @remarks
 * Projects the `/api/chat` `done_reason` field onto the domain `truncated` flag: `'length'` (the
 * `num_predict` cap or a full context window) is `true`, and any other value, or none, yields
 * `undefined`, so the flag is present only on a truncated answer. It does not read the request's
 * prompt `truncate` setting.
 *
 * @param record - One parsed `/api/chat` NDJSON record
 * @returns `true` for `'length'`, or `undefined` otherwise
 *
 * @example
 * ```ts
 * extractTruncated({ done: true, done_reason: 'length' }) // true
 * extractTruncated({ done: true, done_reason: 'stop' }) // undefined
 * ```
 */
export function extractTruncated(record: Readonly<Record<string, unknown>>): true | undefined {
	return Reflect.get(record, 'done_reason') === 'length' ? true : undefined
}

/**
 * Extracts the daemon timing of one terminal wire record.
 *
 * @remarks
 * Durations are raw nanoseconds and counts are tokens, both kept verbatim. A field the record
 * does not own is unknown and reads `undefined` without entering `invalid`. A field the record
 * owns whose value is not a non-negative safe integer (including `undefined`, `-0`, a string,
 * a fraction, or an unsafe integer) reads `undefined` and enters `invalid` under its wire key.
 * Nothing is defaulted to zero, inferred, or converted, and the record is never mutated.
 *
 * @param record - One parsed `/api/chat` or `/api/generate` record
 * @returns The timing observation, or `undefined` unless the record owns `done: true`
 *
 * @example
 * ```ts
 * extractTiming({ done: true, total_duration: 1234567890123, eval_count: 4 })
 * // durations.total is 1234567890123, counts.decode is 4, invalid is []
 * ```
 */
export function extractTiming(record: Readonly<Record<string, unknown>>): OllamaTiming | undefined {
	if (!Object.hasOwn(record, 'done') || Reflect.get(record, 'done') !== true) return undefined
	const keys = [
		'total_duration',
		'load_duration',
		'prompt_eval_duration',
		'eval_duration',
		'prompt_eval_count',
		'eval_count',
		'prompt_eval_cached_count',
	] as const
	const readings = keys.map((key) => {
		if (!Object.hasOwn(record, key)) return undefined
		const value: unknown = Reflect.get(record, key)
		return isNonNegativeInteger(value) && value <= Number.MAX_SAFE_INTEGER ? value : undefined
	})
	const [total, load, prompt, decode, promptCount, decodeCount, cached] = readings
	const invalid = keys.filter(
		(key, index) => readings[index] === undefined && Object.hasOwn(record, key),
	)
	return {
		durations: { total, load, prompt, decode },
		counts: { prompt: promptCount, decode: decodeCount, cached },
		invalid,
	}
}

/**
 * Extracts the tool calls of one wire record's `message.tool_calls`.
 *
 * @remarks
 * Each entry narrows to `{ id, name, arguments }`: the entry and its `function` must be
 * records and `name` a string, else the entry is dropped. An id is minted when the wire
 * omits one.
 *
 * @param record - One parsed `/api/chat` NDJSON record
 * @returns The narrowed tool calls, empty when the record carries none
 *
 * @example
 * ```ts
 * extractTools({ message: { tool_calls: [{ function: { name: 'weather' } }] } })
 * // [{ id: '…', name: 'weather', arguments: {} }]
 * ```
 */
export function extractTools(record: Readonly<Record<string, unknown>>): readonly ToolCall[] {
	const message = Reflect.get(record, 'message')
	if (!isRecord(message)) return []
	const calls = Reflect.get(message, 'tool_calls')
	if (!isArray(calls)) return []
	// The following iterable hands `Array.from` only the iterator protocol, as `for…of` consumed it: an
	// array without an iterator throws instead of falling back to array-like access, and a hole is
	// visited as `undefined`.
	return Array.from(
		{
			[Symbol.iterator]() {
				return calls[Symbol.iterator]()
			},
		},
		(entry) => {
			if (!isRecord(entry)) return undefined
			const callable = Reflect.get(entry, 'function')
			if (!isRecord(callable)) return undefined
			const name = Reflect.get(callable, 'name')
			if (!isString(name)) return undefined
			const id = Reflect.get(entry, 'id')
			return {
				id: isString(id) ? id : crypto.randomUUID(),
				name,
				arguments: extractArguments(Reflect.get(callable, 'arguments')),
			}
		},
	).filter((call) => call !== undefined)
}

/**
 * Extracts a wire `arguments` value as a record.
 *
 * @remarks
 * Total: an object passes through, a JSON string is parsed when it yields a record, and
 * a malformed string yields `{}` rather than throwing.
 *
 * @param value - The wire's `function.arguments` value, of unknown shape
 * @returns The argument record, or `{}` when the value carries none
 *
 * @example
 * ```ts
 * extractArguments('{"city":"Oslo"}') // { city: 'Oslo' }
 * ```
 */
export function extractArguments(value: unknown): Readonly<Record<string, unknown>> {
	if (isRecord(value)) return value
	if (isString(value)) return parseJSONAs(value, isRecord) ?? {}
	return {}
}

import type { JudgeAnswer, JudgeEntry, JudgeQuestion, Message, Refusal } from '@orkestrel/agent'
import type { TokenUsage } from '@orkestrel/budget'
import type { AuditFault, ContractInterface } from '@orkestrel/contract'
import type { ToolCall } from '@orkestrel/tool'
import type { Logprob, OllamaJudgeOptions, OllamaTiming, WireChatRequest } from './types.js'
import { JudgeError, MAX_ERROR_BODY_LENGTH, ProviderError } from '@orkestrel/agent'
import { isBudgetAmount } from '@orkestrel/budget'
import {
	isArray,
	isFiniteNumber,
	isNonNegativeInteger,
	isObject,
	isRecord,
	isString,
	parseJSONAs,
	preview,
} from '@orkestrel/contract'
import {
	MAX_MICA_LEVELS,
	MICA_NOUL_LABELS,
	MICA_OPTION_LABELS,
	MICA_RENDER_REVISION,
	MICA_SPECIAL_TOKENS,
	OLLAMA_CONTEXT_REMEDY,
	TOP_LOGPROBS,
} from './constants.js'

/**
 * Escapes each listed control token by inserting U+200B after its opening angle bracket.
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
 * @throws JudgeError Thrown with code `QUESTION` for structured instructions or criteria, an unsupported candidate count, or a question that carries no text
 * @example
 * ```ts
 * renderJudgePrompt('Approved.', { form: 'noul', instructions: 'Is it approved?' }, 'Judge the state.')
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
						return `${label}) ${question.form === 'choice' && matchesCandidateName(key, label) ? `[${escapeSpecialTokens(key)}] ` : ''}${escapeSpecialTokens(text === null ? 'None' : text)}`
					},
				)
	if (instructions.trim() === '' && !matchesCriterionText(question))
		throw new JudgeError(
			'QUESTION',
			'judge error: mica question carries no text; set instructions, or describe or name a candidate in criteria',
		)
	const ending =
		question.form === 'noul'
			? `Criteria:\n${lines.join('\n')}\nAnswer Yes if true, or No if false.`
			: `Candidates:\n${lines.join('\n')}\nAnswer with the label of the best ${question.form === 'score' ? 'level' : 'candidate'}.`
	return `<|im_start|>system\n${system}<|im_end|>\n<|im_start|>user\n<state>\n${escapeSpecialTokens(isString(state) ? state : JSON.stringify(state, null, 1))}\n</state>\nQuestion: ${escapeSpecialTokens(instructions)}\n${ending}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`
}

/**
 * Checks whether a choice key renders as a candidate name rather than as a position.
 * @param key - The caller's candidate key
 * @param label - The wire label the key maps to
 * @returns True if the key is nonempty, differs from its label, and is not positional; false otherwise
 * @example
 * ```ts
 * matchesCandidateName('billing', 'A') // true
 * matchesCandidateName('0', 'A') // false
 * ```
 */
export function matchesCandidateName(key: string, label: string | undefined): boolean {
	return key !== '' && key !== label && !/^[cs]?\p{Nd}+$/u.test(key)
}

/**
 * Checks whether a question's criteria give the model anything to read: a description, or a choice's name.
 * @param question - The question whose criteria it reads
 * @returns True if a candidate carries nonblank text or a rendered name; false otherwise
 * @example
 * ```ts
 * matchesCriterionText({ form: 'noul', criteria: { true: 'It holds.' } }) // true
 * matchesCriterionText({ form: 'noul' }) // false
 * ```
 */
export function matchesCriterionText(question: JudgeQuestion): boolean {
	const texts: readonly unknown[] =
		question.form === 'noul'
			? [question.criteria?.false, question.criteria?.true]
			: question.form === 'score'
				? question.criteria
				: Object.values(question.criteria)
	if (texts.some((text) => isString(text) && text.trim() !== '')) return true
	if (question.form !== 'choice') return false
	const labels = buildJudgeLabels(question)
	return Object.keys(question.criteria).some((key) => matchesCandidateName(key, labels.get(key)))
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
 * @remarks
 * A judge set to `truncate: true` appends the switch, because a cut prompt can answer differently; the
 * default leaves the tuple as it was, because a prompt that fits renders and answers the same.
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
	return JSON.stringify([
		options.model,
		options.system,
		temperature,
		sorted,
		revision,
		...(options.truncate === true ? [{ truncate: true }] : []),
	])
}

/**
 * Scans a constructor's options against a contract, leaving out the live values and every key set
 * to `undefined`.
 *
 * @remarks
 * A callback or a signal has no shape. A key set to `undefined` is absent under the options'
 * TypeScript type, so the contract reads it as absent too. Every fault refuses: a host writes the
 * options, so nothing here repairs a value.
 *
 * @param contract - The compiled contract of the serializable options
 * @param options - The options as the constructor received them
 * @param live - The keys that hold live values
 * @returns Every fault the contract reports, or an empty list
 *
 * @example
 * ```ts
 * scanOptionFaults(ollamaOptionsContract, { model: 'mica', fetch: globalThis.fetch }, ['fetch']) // []
 * scanOptionFaults(ollamaOptionsContract, { model: 'mica', keepalive: '5m' }, [])
 * // [{ reason: 'extra', path: ['keepalive'] }]
 * ```
 */
export function scanOptionFaults(
	contract: ContractInterface<unknown>,
	options: object,
	live: readonly string[],
): readonly AuditFault[] {
	const declared = Object.fromEntries(
		Object.entries(options).filter(([key, value]) => !live.includes(key) && value !== undefined),
	)
	return contract.is(declared) ? [] : contract.audit(declared)
}

/**
 * Checks whether a daemon's refusal text names the context window.
 *
 * @param text - The daemon's refusal text, or an error message that holds it
 * @returns True if the text names the context size, length, or window; false otherwise
 *
 * @example
 * ```ts
 * matchesContextRefusal('request (3245 tokens) exceeds the available context size (2048 tokens)') // true
 * matchesContextRefusal('model not found') // false
 * ```
 */
export function matchesContextRefusal(text: string): boolean {
	return /\bcontext (?:size|length|window)\b/iu.test(text)
}

/**
 * Renders a daemon's in-band `error` value as refusal text, bounded like an HTTP error excerpt.
 *
 * @param failure - The record's `error` value
 * @returns The bounded text, with the context remedy appended when the text names the context window
 *
 * @example
 * ```ts
 * renderDaemonFailure('the runner stopped') // 'the runner stopped'
 * ```
 */
export function renderDaemonFailure(failure: unknown): string {
	const excerpt = (isString(failure) ? failure : preview(failure)).slice(0, MAX_ERROR_BODY_LENGTH)
	return matchesContextRefusal(excerpt) ? `${excerpt}; ${OLLAMA_CONTEXT_REMEDY}` : excerpt
}

/**
 * Maps conversation turns onto the `/api/chat` wire's minimal message shape, escaping each listed control token in message content, call names, and top-level arguments.
 *
 * @remarks
 * `tool_calls` is emitted only on a turn that replays them and `images` only on a
 * multimodal turn, so an empty optional never reaches the wire. Content on every role, a replayed
 * call's name, and each top-level argument key and string value pass the escape. A nested argument
 * and `images` stay as given.
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
		content: escapeSpecialTokens(message.content),
		...(message.calls !== undefined && message.calls.length > 0
			? {
					tool_calls: message.calls.map((call) => ({
						function: {
							name: escapeSpecialTokens(call.name),
							arguments: Object.fromEntries(
								Object.entries(call.arguments).map(([key, value]) => [
									escapeSpecialTokens(key),
									isString(value) ? escapeSpecialTokens(value) : value,
								]),
							),
						},
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
 * @returns The record's `message.content`, or `''` when the record carries none
 * @throws ProviderError Thrown with code `PROTOCOL` when `message` is present and not a record, or `content` is present and not a string
 *
 * @example
 * ```ts
 * extractContent({ message: { content: 'ok' } }) // 'ok'
 * ```
 */
export function extractContent(record: Readonly<Record<string, unknown>>): string {
	return readMessageText(record, 'content')
}

/**
 * Extracts the daemon-side reasoning of one wire record.
 *
 * @remarks
 * `message.thinking` is the `think: true` wire shape. It is read whatever the configured
 * flag says, because a daemon may separate reasoning on its own.
 *
 * @param record - One parsed `/api/chat` NDJSON record
 * @returns The record's `message.thinking`, or `''` when the record carries none
 * @throws ProviderError Thrown with code `PROTOCOL` when `message` is present and not a record, or `thinking` is present and not a string
 *
 * @example
 * ```ts
 * extractThinking({ message: { thinking: 'weighing it' } }) // 'weighing it'
 * ```
 */
export function extractThinking(record: Readonly<Record<string, unknown>>): string {
	return readMessageText(record, 'thinking')
}

/**
 * Reads a record's `message`, which a record may omit.
 *
 * @param record - One parsed `/api/chat` NDJSON record
 * @returns The message record, or `undefined` when the record carries none
 * @throws ProviderError Thrown with code `PROTOCOL` when `message` is present and not a record
 *
 * @example
 * ```ts
 * readMessage({ message: { content: 'ok' } }) // { content: 'ok' }
 * readMessage({ done: true }) // undefined
 * ```
 */
export function readMessage(
	record: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
	const message = Reflect.get(record, 'message')
	if (message === undefined || isRecord(message)) return message
	throw new ProviderError(
		'PROTOCOL',
		`provider error: the record's message must be a record; received ${preview(message)}`,
	)
}

/**
 * Reads one text field of a record's `message`, which a record may omit.
 *
 * @param record - One parsed `/api/chat` NDJSON record
 * @param key - The message field to read
 * @returns The field's text, or `''` when the record carries none
 * @throws ProviderError Thrown with code `PROTOCOL` when `message` is present and not a record, or the field is present and not a string
 *
 * @example
 * ```ts
 * readMessageText({ message: { content: 'ok' } }, 'content') // 'ok'
 * readMessageText({ done: true }, 'content') // ''
 * ```
 */
export function readMessageText(record: Readonly<Record<string, unknown>>, key: string): string {
	const text = Reflect.get(readMessage(record) ?? {}, key)
	if (text === undefined) return ''
	if (isString(text)) return text
	throw new ProviderError(
		'PROTOCOL',
		`provider error: message.${key} must be a string; received ${preview(text)}`,
	)
}

/**
 * Extracts the token usage of one wire record.
 *
 * @remarks
 * Both counts were seen present on every `done: true` line Ollama 0.40.14 sent, identical repeats
 * included. A record without both yields `undefined`, and the agent bills its estimate.
 *
 * @param record - One parsed `/api/chat` NDJSON record
 * @returns The `TokenUsage` shape, or `undefined` when either count is absent
 * @throws ProviderError Thrown with code `PROTOCOL` when a present count is not a finite nonnegative number
 *
 * @example
 * ```ts
 * extractUsage({ prompt_eval_count: 3, eval_count: 4 })
 * // { prompt: 3, completion: 4, total: 7 }
 * ```
 */
export function extractUsage(record: Readonly<Record<string, unknown>>): TokenUsage | undefined {
	const prompt = readUsageCount(record, 'prompt_eval_count')
	const completion = readUsageCount(record, 'eval_count')
	if (prompt === undefined || completion === undefined) return undefined
	return { prompt, completion, total: prompt + completion }
}

/**
 * Reads one token count of a record, which a record may omit.
 *
 * @param record - One parsed `/api/chat` or `/api/generate` record
 * @param key - The wire key of the count
 * @returns The count, or `undefined` when the record carries none
 * @throws ProviderError Thrown with code `PROTOCOL` when the count is present and not a finite nonnegative number
 *
 * @example
 * ```ts
 * readUsageCount({ eval_count: 4 }, 'eval_count') // 4
 * readUsageCount({}, 'eval_count') // undefined
 * ```
 */
export function readUsageCount(
	record: Readonly<Record<string, unknown>>,
	key: string,
): number | undefined {
	const count = Reflect.get(record, key)
	if (count === undefined || isBudgetAmount(count)) return count
	throw new ProviderError(
		'PROTOCOL',
		`provider error: ${key} must be a finite nonnegative number; received ${preview(count)}`,
	)
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
 * Each entry narrows to `{ id, name, arguments }`: the entry and its `function` must be records
 * and `name` a string. A dropped call would read as a final answer, so a malformed one refuses the
 * turn. An id is minted when the wire omits one.
 *
 * @param record - One parsed `/api/chat` NDJSON record
 * @returns The narrowed tool calls, empty when the record carries none
 * @throws ProviderError Thrown with code `PROTOCOL` when `message` is present and not a record, `tool_calls` is present and not an array, or an entry is malformed
 *
 * @example
 * ```ts
 * extractTools({ message: { tool_calls: [{ function: { name: 'weather', arguments: {} } }] } })
 * // [{ id: '…', name: 'weather', arguments: {} }]
 * ```
 */
export function extractTools(record: Readonly<Record<string, unknown>>): readonly ToolCall[] {
	const calls = Reflect.get(readMessage(record) ?? {}, 'tool_calls')
	if (calls === undefined) return []
	if (!isArray(calls))
		throw new ProviderError(
			'PROTOCOL',
			`provider error: message.tool_calls must be an array; received ${preview(calls)}`,
		)
	// The following iterable hands `Array.from` only the iterator protocol, as `for…of` consumed it: an
	// array without an iterator throws instead of falling back to array-like access, and a hole is
	// visited as `undefined`.
	return Array.from(
		{
			[Symbol.iterator]() {
				return calls[Symbol.iterator]()
			},
		},
		(entry, index) => {
			const callable = isRecord(entry) ? Reflect.get(entry, 'function') : undefined
			const name = isRecord(callable) ? Reflect.get(callable, 'name') : undefined
			if (!isRecord(entry) || !isRecord(callable) || !isString(name))
				throw new ProviderError(
					'PROTOCOL',
					`provider error: message.tool_calls[${index}] must be a record whose function is a record with a string name; received ${preview(entry)}`,
				)
			const id = Reflect.get(entry, 'id')
			return {
				id: isString(id) ? id : crypto.randomUUID(),
				name,
				arguments: extractArguments(Reflect.get(callable, 'arguments')),
			}
		},
	)
}

/**
 * Extracts a wire `arguments` value as a record.
 *
 * @remarks
 * A record passes through and a string parses when it holds a JSON record. Arguments that are
 * neither would reach a tool as a call it never received, so they refuse.
 *
 * @param value - The wire's `function.arguments` value, of unknown shape
 * @returns The argument record
 * @throws ProviderError Thrown with code `PROTOCOL` when the value is neither a record nor the JSON text of one
 *
 * @example
 * ```ts
 * extractArguments('{"city":"Oslo"}') // { city: 'Oslo' }
 * ```
 */
export function extractArguments(value: unknown): Readonly<Record<string, unknown>> {
	if (isRecord(value)) return value
	const parsed = isString(value) ? parseJSONAs(value, isRecord) : undefined
	if (parsed !== undefined) return parsed
	throw new ProviderError(
		'PROTOCOL',
		`provider error: a tool call's arguments must be a record or the JSON text of one; received ${preview(value)}`,
	)
}

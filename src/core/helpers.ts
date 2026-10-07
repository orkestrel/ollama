import type { JudgeAnswer, JudgeEntry, JudgeQuestion, Message, Refusal } from '@orkestrel/agent'
import type { TokenUsage } from '@orkestrel/budget'
import type { ToolCall } from '@orkestrel/tool'
import type { Logprob, OllamaJudgeOptions, WireChatRequest } from './types.js'
import { JudgeError } from '@orkestrel/agent'
import {
	isArray,
	isFiniteNumber,
	isNumber,
	isObject,
	isRecord,
	isString,
	parseJSONAs,
} from '@orkestrel/contract'
import {
	MAX_SCORE_LEVELS,
	NOUL_LABELS,
	OPTION_LABELS,
	RENDER_REVISION,
	SPECIAL_TOKENS,
	TOP_LOGPROBS,
} from './constants.js'

/**
 * Escapes Mica control tokens by inserting U+200B after their opening angle bracket.
 * @param text - The untrusted text to render
 * @returns The text with control tokens escaped and all other bytes preserved
 * @example
 * ```ts
 * escapeSpecial('<think>') // '<\u200bthink>'
 * ```
 */
export function escapeSpecial(text: string): string {
	let escaped = text
	for (const token of SPECIAL_TOKENS)
		escaped = escaped.replaceAll(token, `<\u200b${token.slice(1)}`)
	return escaped
}

/**
 * Renders a state and question with Mica's native prompt and disabled thinking suffix.
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
	if (!isString(instructions)) throw new JudgeError('QUESTION', 'Mica instructions must be text')
	const lines: string[] = []
	if (question.form === 'noul') {
		for (const key of ['false', 'true'] as const) {
			const text = question.criteria?.[key] ?? key
			if (!isString(text)) throw new JudgeError('QUESTION', `Mica criterion ${key} must be text`)
			lines.push(`${key}: ${escapeSpecial(text)}`)
		}
	} else {
		const entries =
			question.form === 'choice'
				? Object.entries(question.criteria)
				: question.criteria.map((text, index) => [String(index), text] as const)
		for (const [key, text] of entries) {
			if (text !== null && !isString(text))
				throw new JudgeError('QUESTION', `Mica criterion ${key} must be text or null`)
			const label = labels.get(key)
			const named =
				question.form === 'choice' && key !== '' && key !== label && !/^[cs]?\d+$/.test(key)
			lines.push(
				`${label}) ${named ? `[${escapeSpecial(key)}] ` : ''}${escapeSpecial(text === null ? 'None' : text)}`,
			)
		}
	}
	const ending =
		question.form === 'noul'
			? `Criteria:\n${lines.join('\n')}\nAnswer Yes if true, or No if false.`
			: `Candidates:\n${lines.join('\n')}\nAnswer with the label of the best ${question.form === 'score' ? 'level' : 'candidate'}.`
	return `<|im_start|>system\n${system}<|im_end|>\n<|im_start|>user\n<state>\n${escapeSpecial(isString(state) ? state : JSON.stringify(state, null, 1))}\n</state>\nQuestion: ${escapeSpecial(instructions)}\n${ending}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`
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
	const limit = question.form === 'score' ? MAX_SCORE_LEVELS : TOP_LOGPROBS
	if (keys.length < 2 || keys.length > limit)
		throw new JudgeError('QUESTION', `Mica ${question.form} requires 2..${limit} candidates`)
	const labels = question.form === 'noul' ? NOUL_LABELS : OPTION_LABELS
	return new Map(
		keys.map((key, index) => {
			const label = labels[index]
			if (label === undefined) throw new JudgeError('QUESTION', `Missing Mica label for ${key}`)
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
 * extractTop({ logprobs: [{ top_logprobs: [{ token: 'No', logprob: -0.1 }] }] })
 * // [{ token: 'No', logprob: -0.1 }]
 * ```
 */
export function extractTop(value: unknown): readonly Logprob[] {
	const positions: unknown = isObject(value) ? Reflect.get(value, 'logprobs') : undefined
	const first: unknown = isArray(positions) ? positions[0] : undefined
	const top: unknown = isObject(first) ? Reflect.get(first, 'top_logprobs') : undefined
	if (!isArray(top)) throw new JudgeError('PROTOCOL', 'Missing first-position top logprobs')
	const result: Logprob[] = []
	const seen = new Set<string>()
	for (const entry of top) {
		const token: unknown = isObject(entry) ? Reflect.get(entry, 'token') : undefined
		const logprob: unknown = isObject(entry) ? Reflect.get(entry, 'logprob') : undefined
		if (!isString(token) || !isFiniteNumber(logprob) || seen.has(token))
			throw new JudgeError('PROTOCOL', 'Invalid or duplicate top logprob token')
		seen.add(token)
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
		throw new JudgeError('QUESTION', 'Calibration temperature must be finite and positive')
	const labels = buildJudgeLabels(question)
	const available = new Map<string, number>()
	for (const entry of top) {
		const { token, logprob } = entry
		if (!isFiniteNumber(logprob) || available.has(token))
			throw new JudgeError('PROTOCOL', 'Invalid or duplicate top logprob token')
		available.set(token, logprob)
	}
	const missing: string[] = []
	const candidates: Array<[string, number]> = []
	for (const [key, label] of labels) {
		const logprob = available.get(label)
		if (logprob === undefined) missing.push(key)
		else candidates.push([key, logprob])
	}
	if (missing.length > 0) return { missing }
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
	if (yes === undefined) throw new JudgeError('PROTOCOL', 'Missing true probability')
	return { form: 'noul', noul: yes[1] }
}

/**
 * Renders a stable identity from the model tag, system prompt, calibration, and render revision.
 * @param options - The settings that define the judge's answers
 * @param revision - The render revision; defaults to the published revision
 * @returns An unambiguous JSON tuple identifying the configured judge
 * @throws JudgeError Thrown with code `QUESTION` for invalid calibration
 * @example
 * ```ts
 * renderJudgeIdentity({ model: 'mica', system: 'Judge.' }, 'v1')
 * // '["mica","Judge.",1,"v1"]'
 * ```
 */
export function renderJudgeIdentity(
	options: OllamaJudgeOptions,
	revision = RENDER_REVISION,
): string {
	const temperature = options.calibration?.temperature ?? 1
	if (!isFiniteNumber(temperature) || temperature <= 0)
		throw new JudgeError('QUESTION', 'Calibration temperature must be finite and positive')
	return JSON.stringify([options.model, options.system, temperature, revision])
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
	const out: ToolCall[] = []
	for (const entry of calls) {
		if (!isRecord(entry)) continue
		const callable = Reflect.get(entry, 'function')
		if (!isRecord(callable)) continue
		const name = Reflect.get(callable, 'name')
		if (!isString(name)) continue
		const id = Reflect.get(entry, 'id')
		out.push({
			id: isString(id) ? id : crypto.randomUUID(),
			name,
			arguments: extractArguments(Reflect.get(callable, 'arguments')),
		})
	}
	return out
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

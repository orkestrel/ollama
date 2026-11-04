import {
	booleanShape,
	integerShape,
	literalShape,
	numberShape,
	objectShape,
	optionalShape,
	stringShape,
	unionShape,
} from '@orkestrel/contract'

/**
 * Describes the serializable part of {@link import('./types.js').OllamaOptions}, the record a provider's
 * constructor checks exactly.
 *
 * @remarks
 * `fetch` and `headers` are callbacks, so they stay outside the shape. `url` is an absolute URL with a
 * host, or a same-origin path a browser page resolves. `keepAlive` takes the Go duration form the
 * daemon parses, or a whole number of seconds from `-1`, which keeps the model resident, up: `0`
 * unloads it after the call. `options` is the daemon's open sampling bag.
 *
 * @example
 * ```ts
 * import { createContract } from '@orkestrel/contract'
 * import { ollamaOptionsShape } from '@orkestrel/ollama'
 *
 * createContract(ollamaOptionsShape).is({ model: 'qwen3.5:2b-q4_K_M', keepAlive: -1 }) // true
 * createContract(ollamaOptionsShape).is({ model: '' }) // false
 * ```
 */
export const ollamaOptionsShape = objectShape({
	model: stringShape({ min: 1 }),
	url: optionalShape(
		stringShape({ pattern: /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/]+\S*|\/\S*)$/ }),
	),
	keepAlive: optionalShape(
		unionShape(
			stringShape({ pattern: /^(?:0|-?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:ns|us|µs|μs|ms|s|m|h))+)$/ }),
			integerShape({ min: -1, max: Number.MAX_SAFE_INTEGER }),
		),
	),
	options: optionalShape(objectShape({}, { additionalProperties: true })),
	think: optionalShape(booleanShape()),
	truncate: optionalShape(booleanShape()),
	shift: optionalShape(booleanShape()),
	timeout: optionalShape(integerShape({ min: 1, max: Number.MAX_SAFE_INTEGER })),
	replay: optionalShape(literalShape(['none', 'turn', 'all'])),
})

/**
 * Describes the serializable part of {@link import('./types.js').OllamaJudgeOptions}, the record a
 * judge's constructor checks exactly.
 *
 * @remarks
 * `fetch` and `headers` are callbacks, so they stay outside the shape. A calibration temperature only
 * has to be a number here, because the identity it enters refuses one that is not positive.
 *
 * @example
 * ```ts
 * import { createContract } from '@orkestrel/contract'
 * import { ollamaJudgeOptionsShape } from '@orkestrel/ollama'
 *
 * createContract(ollamaJudgeOptionsShape).is({ model: 'mica', system: 'Judge the state.' }) // true
 * createContract(ollamaJudgeOptionsShape).is({ model: 'mica' }) // false
 * ```
 */
export const ollamaJudgeOptionsShape = objectShape({
	model: ollamaOptionsShape.properties.model,
	system: stringShape(),
	calibration: optionalShape(objectShape({ temperature: numberShape() })),
	url: ollamaOptionsShape.properties.url,
	keepAlive: ollamaOptionsShape.properties.keepAlive,
	options: ollamaOptionsShape.properties.options,
	truncate: ollamaOptionsShape.properties.truncate,
	timeout: ollamaOptionsShape.properties.timeout,
})

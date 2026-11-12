import {
	arrayShape,
	integerShape,
	objectShape,
	optionalShape,
	recordShape,
	stringShape,
} from '@orkestrel/contract'
import { OLLAMA_TIMER_LIMIT } from './constants.js'
import { ollamaOptionsShape } from '@src/core'

/**
 * Describes the serializable part of {@link import('./types.js').OllamaDaemonOptions}, the record whose
 * audit names a refused declaration's faults by path.
 *
 * @remarks
 * `fetch`, `on`, `error`, and `signal` are live values, so they stay outside the shape. An
 * `environment` entry can be `undefined`, which removes a variable; omit those entries from the
 * serializable record. Omit an unused `store`; an explicitly undefined store refuses in the guard
 * and the shape. What a shape cannot state
 * stays in that guard too: an absolute path, a dedicated loopback origin, and unique model names.
 *
 * @example
 * ```ts
 * import { createContract } from '@orkestrel/contract'
 * import { ollamaDaemonShape } from '@orkestrel/ollama/server'
 *
 * createContract(ollamaDaemonShape).audit({
 * 	executable: { path: '/opt/ollama', digest: 'a'.repeat(64) },
 * 	url: 'http://127.0.0.1:11437',
 * 	models: [{ name: 'cedar', digest: 'declared' }],
 * 	workspace: '/srv/ollama',
 * 	wrokspace: '/srv/ollama',
 * })
 * // [{ reason: 'extra', path: ['wrokspace'] }]
 * ```
 */
export const ollamaDaemonShape = objectShape({
	executable: objectShape({
		path: stringShape({ min: 1 }),
		digest: stringShape({ pattern: /^[a-f0-9]{64}$/ }),
		arguments: optionalShape(arrayShape(stringShape())),
	}),
	url: ollamaOptionsShape.properties.url.inner,
	models: arrayShape(
		objectShape({ name: stringShape({ min: 1 }), digest: stringShape({ min: 1 }) }),
		{ min: 1 },
	),
	workspace: stringShape({ min: 1 }),
	environment: optionalShape(recordShape(stringShape())),
	store: optionalShape(stringShape({ min: 1 })),
	readiness: optionalShape(integerShape({ min: 1, max: OLLAMA_TIMER_LIMIT })),
	metadata: optionalShape(
		objectShape({
			timeout: optionalShape(integerShape({ min: 1, max: OLLAMA_TIMER_LIMIT })),
			bytes: optionalShape(integerShape({ min: 1, max: Number.MAX_SAFE_INTEGER })),
		}),
	),
	termination: optionalShape(
		objectShape({
			grace: optionalShape(integerShape({ min: 0, max: OLLAMA_TIMER_LIMIT })),
			drain: optionalShape(integerShape({ min: 0, max: OLLAMA_TIMER_LIMIT })),
		}),
	),
})

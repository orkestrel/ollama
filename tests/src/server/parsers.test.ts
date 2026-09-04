import { parseBody } from '@src/server'
import { describe, expect, it } from 'vitest'

describe('parseBody', () => {
	it('parses a JSON object body into a record', async () => {
		const body = await parseBody(new Response('{"message":{"content":"ok"}}'))

		expect(body).toEqual({ message: { content: 'ok' } })
	})

	it('yields undefined for an empty body', async () => {
		expect(await parseBody(new Response(''))).toBeUndefined()
	})

	it('yields undefined for a malformed body rather than throwing', async () => {
		expect(await parseBody(new Response('{"message":'))).toBeUndefined()
	})

	it('yields undefined for valid JSON that is not an object', async () => {
		expect(await parseBody(new Response('42'))).toBeUndefined()
		expect(await parseBody(new Response('["ok"]'))).toBeUndefined()
		expect(await parseBody(new Response('null'))).toBeUndefined()
	})
})

import { parseBody } from '@src/server'
import { describe, expect, it } from 'vitest'

describe('parseBody', () => {
	it('parses a JSON object body into a record', async () => {
		const body = await parseBody(new Response('{"message":{"content":"ok"}}'))

		expect(body).toEqual({ message: { content: 'ok' } })
	})

	it('degrades an empty body to an empty record', async () => {
		expect(await parseBody(new Response(''))).toEqual({})
	})

	it('degrades a malformed body to an empty record rather than throwing', async () => {
		expect(await parseBody(new Response('{"message":'))).toEqual({})
	})

	it('degrades valid JSON that is not an object to an empty record', async () => {
		expect(await parseBody(new Response('42'))).toEqual({})
		expect(await parseBody(new Response('["ok"]'))).toEqual({})
		expect(await parseBody(new Response('null'))).toEqual({})
	})
})

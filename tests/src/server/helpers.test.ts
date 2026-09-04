import type { Message } from '@orkestrel/agent'
import { createThinkSplitter } from '@orkestrel/agent'
import {
	buildResult,
	extractArguments,
	extractContent,
	extractThinking,
	extractTools,
	extractUsage,
	joinThinking,
	mapMessages,
} from '@src/server'
import { describe, expect, it } from 'vitest'
import { createUserMessage } from '../../setup.js'

describe('mapMessages', () => {
	it('maps a plain turn to the wire role and content only', () => {
		expect(mapMessages([createUserMessage('Say hello.')])).toEqual([
			{ role: 'user', content: 'Say hello.' },
		])
	})

	it('emits tool_calls only on a turn that replays them', () => {
		const replay: Message = {
			id: '2',
			role: 'assistant',
			content: '',
			calls: [{ id: 'call-1', name: 'weather', arguments: { city: 'Oslo' } }],
		}

		expect(mapMessages([replay])).toEqual([
			{
				role: 'assistant',
				content: '',
				tool_calls: [{ function: { name: 'weather', arguments: { city: 'Oslo' } } }],
			},
		])
	})

	it('omits tool_calls for an empty calls array', () => {
		const empty: Message = { id: '3', role: 'assistant', content: 'done', calls: [] }

		expect(mapMessages([empty])).toEqual([{ role: 'assistant', content: 'done' }])
	})

	it('forwards images only on a multimodal turn, copied off the source array', () => {
		const images = ['aGk=']
		const multimodal: Message = {
			id: '4',
			role: 'user',
			content: 'What is this?',
			images,
		}

		const [wired] = mapMessages([multimodal])

		expect(wired).toEqual({ role: 'user', content: 'What is this?', images: ['aGk='] })
		expect(wired?.images).not.toBe(images)
	})

	it('maps an empty conversation to an empty wire array', () => {
		expect(mapMessages([])).toEqual([])
	})
})

describe('buildResult', () => {
	it('carries content alone when nothing else is present', () => {
		expect(buildResult('ok', '', [], undefined)).toEqual({ content: 'ok' })
	})

	it('adds every populated optional', () => {
		const calls = [{ id: 'call-1', name: 'weather', arguments: {} }]
		const usage = { prompt: 3, completion: 4, total: 7 }

		expect(buildResult('ok', 'weighing it', calls, usage)).toEqual({
			content: 'ok',
			thinking: 'weighing it',
			tools: calls,
			usage,
		})
	})

	it('omits an empty thinking string and an empty tools array', () => {
		expect(Object.keys(buildResult('', '', [], undefined))).toEqual(['content'])
	})
})

describe('extractContent', () => {
	it('reads a string message.content', () => {
		expect(extractContent({ message: { content: 'ok' } })).toBe('ok')
	})

	it('degrades to an empty string for a missing message', () => {
		expect(extractContent({})).toBe('')
	})

	it('degrades to an empty string for a non-record message', () => {
		expect(extractContent({ message: 'ok' })).toBe('')
	})

	it('degrades to an empty string for a non-string content', () => {
		expect(extractContent({ message: { content: 42 } })).toBe('')
	})
})

describe('extractThinking', () => {
	it('reads a string message.thinking', () => {
		expect(extractThinking({ message: { thinking: 'weighing it' } })).toBe('weighing it')
	})

	it('degrades to an empty string for a content-only record', () => {
		expect(extractThinking({ message: { content: 'ok' } })).toBe('')
	})

	it('degrades to an empty string for a non-record message', () => {
		expect(extractThinking({ message: null })).toBe('')
	})
})

describe('joinThinking', () => {
	it('returns the wire text alone when the splitter separated nothing', () => {
		expect(joinThinking(createThinkSplitter(), 'from the wire')).toBe('from the wire')
	})

	it('returns the splitter text alone when no wire thinking arrived', () => {
		const splitter = createThinkSplitter()
		splitter.split('<think>in content</think>ok')
		splitter.flush()

		expect(joinThinking(splitter, '')).toBe('in content')
	})

	it('separates the two carriers with a blank line when both exist', () => {
		const splitter = createThinkSplitter()
		splitter.split('<think>in content</think>ok')
		splitter.flush()

		expect(joinThinking(splitter, 'from the wire')).toBe('in content\n\nfrom the wire')
	})
})

describe('extractUsage', () => {
	it('totals both counts when both are numbers', () => {
		expect(extractUsage({ prompt_eval_count: 3, eval_count: 4 })).toEqual({
			prompt: 3,
			completion: 4,
			total: 7,
		})
	})

	it('yields undefined when the completion count is absent', () => {
		expect(extractUsage({ prompt_eval_count: 3 })).toBeUndefined()
	})

	it('yields undefined when a count is not a number', () => {
		expect(extractUsage({ prompt_eval_count: '3', eval_count: 4 })).toBeUndefined()
	})

	it('yields undefined for a delta line carrying neither count', () => {
		expect(extractUsage({ message: { content: 'ok' } })).toBeUndefined()
	})
})

describe('extractTools', () => {
	it('narrows an entry and mints an id when the wire omits one', () => {
		const [call] = extractTools({
			message: { tool_calls: [{ function: { name: 'weather', arguments: { city: 'Oslo' } } }] },
		})

		expect(call?.name).toBe('weather')
		expect(call?.arguments).toEqual({ city: 'Oslo' })
		expect(call?.id.length).toBeGreaterThan(0)
	})

	it('keeps a string id from the wire', () => {
		const [call] = extractTools({
			message: { tool_calls: [{ id: 'call-1', function: { name: 'weather' } }] },
		})

		expect(call?.id).toBe('call-1')
	})

	it('drops an entry whose function is not a record', () => {
		expect(extractTools({ message: { tool_calls: [{ function: 'weather' }] } })).toEqual([])
	})

	it('drops an entry whose name is not a string', () => {
		expect(extractTools({ message: { tool_calls: [{ function: { name: 7 } }] } })).toEqual([])
	})

	it('returns no calls when tool_calls is absent or not an array', () => {
		expect(extractTools({ message: { content: 'ok' } })).toEqual([])
		expect(extractTools({ message: { tool_calls: 'weather' } })).toEqual([])
		expect(extractTools({})).toEqual([])
	})
})

describe('extractArguments', () => {
	it('passes a record through unchanged', () => {
		expect(extractArguments({ city: 'Oslo' })).toEqual({ city: 'Oslo' })
	})

	it('parses a JSON string that yields a record', () => {
		expect(extractArguments('{"city":"Oslo"}')).toEqual({ city: 'Oslo' })
	})

	it('yields an empty record for a malformed JSON string', () => {
		expect(extractArguments('{city:')).toEqual({})
	})

	it('yields an empty record for a JSON string that is not an object', () => {
		expect(extractArguments('42')).toEqual({})
	})

	it('yields an empty record for a value that is neither', () => {
		expect(extractArguments(undefined)).toEqual({})
	})
})

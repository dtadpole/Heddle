import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'

import { createApp } from '../src/app.ts'
import * as announce from '../src/plugins/announce.ts'
import Greeting from '../src/plugins/greeting.ts'

test('createApp provides the service, with config that reached it', async () => {
  const app = await createApp({ punctuation: '?', target: 'tests', quiet: true })
  try {
    assert.equal(app.ctx.greeting.greet('tests'), 'hello, tests?')
  } finally {
    await app.dispose()
  }
})

test('config is validated before the plugin body runs', async () => {
  const ctx = new Context()
  const bad = ctx.plugin(Greeting, { punctuation: 7 as unknown as string })
  await assert.rejects(() => bad.await())
  await ctx.fiber.dispose()
})

test('a plugin whose inject is missing stays pending, then activates', async () => {
  const ctx = new Context()
  try {
    const waiting = ctx.plugin(announce, { target: 'later' })
    assert.equal(waiting.state, 0, 'expected pending before the service exists')

    await ctx.plugin(Greeting)
    await waiting.await()
    assert.equal(waiting.state, 2, 'expected active once the service exists')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('disposal takes the service offline with it', async () => {
  const app = await createApp({ quiet: true })
  await app.dispose()
  assert.equal(app.ctx.get('greeting', false), undefined)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { askModel, resolveWritingModel } from '../src/model.js'
import { createRequester } from '../src/context.js'
import { createLimiter } from '../src/scheduler.js'

const agent = { options: { provider: 'fake', model: 'fake' } }
const complete = { async *stream() {
  yield { type: 'text-delta', text: '{}' }
  yield { type: 'finish', reason: { kind: 'stop' } }
} }
const emptyConfig = { WLYD_ASSEMBLY_STAGE_TIMEOUT_MS: '', WLYD_ASSEMBLY_QUEUE_TIMEOUT_MS: '' }

test('draft 请求沿用阶段默认和已有配置，不再固定三分钟', async () => {
  const keys = Object.keys(emptyConfig)
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  try {
    for (const [config, expected, source] of [
      ['', 600000, 'plugin-default'],
      ['{"write":900000,"default":720000}', 900000, 'stage-config'],
      ['{"default":720000}', 720000, 'default-config'],
    ]) {
      process.env.WLYD_ASSEMBLY_STAGE_TIMEOUT_MS = config
      process.env.WLYD_ASSEMBLY_QUEUE_TIMEOUT_MS = '120000'
      const state = { modelSelection: { provider: 'fake', model: 'fake' } }
      const request = await createRequester({ llm: complete, exec: { agent }, state, saveState: async () => {} })
      assert.deepEqual(await request({ stage: 'write', qualityMode: 'draft' }), {})
      const record = state.modelRequests[0]
      assert.equal(record.executionTimeoutMs, expected)
      assert.equal(record.executionTimeoutSource, source)
      assert.equal(record.queueTimeoutMs, 120000)
      assert.equal(record.queueTimeoutSource, 'queue-config')
      assert.equal(record.status, 'completed')
    }
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
})

test('执行超时记录真实界限、来源和仅思考增量，不归为无响应', async () => {
  let metrics, calls = 0
  await assert.rejects(askModel({ async *stream(request) {
    calls++
    yield { type: 'reasoning-delta', text: '先分析' }
    yield { type: 'reasoning-delta', text: '继续' }
    await delay(80, undefined, { signal: request.signal })
  } }, agent, undefined, { stage: 'write', qualityMode: 'draft' }, {
    timeoutMs: 20, queueTimeoutMs: 1000,
    env: { WLYD_ASSEMBLY_STAGE_TIMEOUT_MS: '{"write":900000}', WLYD_ASSEMBLY_QUEUE_TIMEOUT_MS: '120000' },
    onMetrics: value => { metrics = value },
  }), error => error.code === 'MODEL_STAGE_TIMEOUT' && !error.partialOutput)
  assert.equal(calls, 1)
  assert.equal(metrics.timeoutKind, 'stage')
  assert.equal(metrics.executionTimeoutMs, 20)
  assert.equal(metrics.executionTimeoutSource, 'caller')
  assert.equal(metrics.queueTimeoutMs, 1000)
  assert.equal(metrics.queueTimeoutSource, 'caller')
  assert.equal(metrics.reasoningDeltaCount, 2)
  assert.equal(metrics.textDeltaCount, 0)
  assert.equal(metrics.reasoningCharacters, 5)
  assert.equal(metrics.hasReasoningOutput, true)
  assert.equal(metrics.hasTextOutput, false)
  assert.ok(metrics.firstReasoningAt)
  assert.equal(metrics.firstTextAt, null)
  assert.equal(metrics.attemptDetails[0].reasoningDeltaCount, 2)
  assert.equal(metrics.attemptDetails[0].hasTextOutput, false)
  assert.equal(metrics.attemptDetails[0].executionTimeoutMs, 20)
  assert.equal(metrics.attemptDetails[0].executionTimeoutSource, 'caller')
})

test('超时前正文增量和 partialOutput 保留给单章恢复', async () => {
  let metrics
  const partial = '{"blocks":[{"text":"已有证据的正文"}]}'
  await assert.rejects(askModel({ async *stream(request) {
    yield { type: 'reasoning-delta', text: '整理' }
    yield { type: 'text-delta', text: partial }
    await delay(80, undefined, { signal: request.signal })
  } }, agent, undefined, { stage: 'write' }, {
    timeoutMs: 20, queueTimeoutMs: 1000, onMetrics: value => { metrics = value },
  }), error => error.code === 'MODEL_STAGE_TIMEOUT' && error.partialOutput === partial)
  assert.equal(metrics.textDeltaCount, 1)
  assert.equal(metrics.outputCharacters, partial.length)
  assert.equal(metrics.hasReasoningOutput, true)
  assert.equal(metrics.hasTextOutput, true)
  assert.ok(metrics.firstTextAt)
  assert.equal(metrics.attemptDetails[0].hasTextOutput, true)
  assert.equal(metrics.attemptDetails[0].textDeltaCount, 1)
})

test('用户取消保留已经收到的正文，仍以取消结束而非成功', async () => {
  const controller = new AbortController()
  const partial = '{"facts":[],"sections":[{"key":"solution","blocks":[{"text":"完整段落。"}],'
  await assert.rejects(askModel({ async *stream() {
    yield { type: 'text-delta', text: partial }
    controller.abort(new Error('用户取消'))
  } }, agent, controller.signal, { stage: 'write' }, { timeoutMs: 1000 }),
  error => error.partialOutput === partial && /用户取消/u.test(error.message))
})

test('排队超时不冒充执行超时，增量保持零', async t => {
  const keepAlive = setInterval(() => {}, 1000)
  t.after(() => clearInterval(keepAlive))
  const limiter = createLimiter(1)
  let release, metrics, called = false
  const occupied = limiter(() => new Promise(resolve => { release = resolve }))
  await delay(0)
  try {
    await assert.rejects(askModel({ async *stream() { called = true } }, agent, undefined, { stage: 'write' }, {
      limiter, queueTimeoutMs: 20, timeoutMs: 1000, onMetrics: value => { metrics = value },
    }), error => error.code === 'MODEL_QUEUE_TIMEOUT')
    assert.equal(called, false)
    assert.equal(metrics.timeoutKind, 'queue')
    assert.equal(metrics.executionTimeoutMs, 1000)
    assert.equal(metrics.queueTimeoutMs, 20)
    assert.equal(metrics.requestStartedAt, null)
    assert.equal(metrics.serviceMs, null)
    assert.equal(metrics.reasoningDeltaCount, 0)
    assert.equal(metrics.textDeltaCount, 0)
    assert.equal(metrics.hasReasoningOutput, false)
    assert.equal(metrics.hasTextOutput, false)
  } finally { release(); await occupied }
})

test('非法超时配置清楚记录回退默认；不按模型名称虚构思考档位', async () => {
  let metrics
  await askModel(complete, agent, undefined, { stage: 'write' }, {
    env: { WLYD_ASSEMBLY_STAGE_TIMEOUT_MS: '{"write":0}', WLYD_ASSEMBLY_QUEUE_TIMEOUT_MS: '0' },
    onMetrics: value => { metrics = value },
  })
  assert.equal(metrics.executionTimeoutMs, 600000)
  assert.equal(metrics.queueTimeoutMs, 1800000)
  assert.equal(metrics.executionTimeoutSource, 'plugin-default')
  assert.equal(metrics.queueTimeoutSource, 'plugin-default')
  const selection = await resolveWritingModel({ resolveModelInfo: async () => ({}) },
    { options: { provider: 'bigmodel', model: 'glm-5.3-flash', reasoningEffort: 'high' } })
  assert.equal(selection.reasoningPolicy, 'unsupported')
  assert.deepEqual(selection.supportedReasoningEfforts, [])
  assert.equal(Object.hasOwn(selection, 'reasoningEffort'), false)
})

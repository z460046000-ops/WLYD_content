import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import os from 'node:os'
import path from 'node:path'
import { askModel, resolveModelSelection, resolveQueueTimeoutMs, resolveStageTimeoutMs } from '../src/model.js'
import { createLimiter } from '../src/scheduler.js'

const agent = { options: { provider: 'fake', model: 'fake', reasoningEffort: 'high' } }
const answer = { async *stream(request) {
  assert.equal(request.reasoningEffort, 'high')
  yield { type: 'reasoning-delta', index: 0, text: '先分析' }
  yield { type: 'text-delta', index: 1, text: '{"ok":true}' }
  yield { type: 'usage', usage: { inputTokens: 123, outputTokens: 9, reasoningTokens: 3 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
} }

test('阶段超时按配置解析，环境变量优先，非法值回退默认', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'wlyd-model-env-'))
  await writeFile(path.join(home, '.env'), [
    "WLYD_ASSEMBLY_STAGE_TIMEOUT_MS='{" + '"plan":900000,"extract":480000,"default":720000' + "}'",
    'WLYD_ASSEMBLY_QUEUE_TIMEOUT_MS=120000',
  ].join('\n'))
  const local = { DSH_HOME: home }
  assert.equal(resolveStageTimeoutMs('plan', local), 900000)
  assert.equal(resolveStageTimeoutMs('extract', local), 480000)
  assert.equal(resolveStageTimeoutMs('write', local), 720000)
  assert.equal(resolveQueueTimeoutMs(local), 120000)
  const override = { ...local, WLYD_ASSEMBLY_STAGE_TIMEOUT_MS: '{"plan":660000,"extract":99999999}',
    WLYD_ASSEMBLY_QUEUE_TIMEOUT_MS: '180000' }
  assert.equal(resolveStageTimeoutMs('plan', override), 660000)
  assert.equal(resolveStageTimeoutMs('extract', override), 600000)
  assert.equal(resolveQueueTimeoutMs(override), 180000)
  assert.equal(resolveStageTimeoutMs('plan', { ...local, WLYD_ASSEMBLY_STAGE_TIMEOUT_MS: 'not-json' }), 600000)
  assert.equal(resolveQueueTimeoutMs({ ...local, WLYD_ASSEMBLY_QUEUE_TIMEOUT_MS: '0' }), 1800000)
})

test('会话最近模型配置优先；缺省 effort 不继承旧 options，缺 header 才回退', async () => {
  const current = { options: { provider: 'old', model: 'old-model', reasoningEffort: 'high' },
    session: { requestHeader: () => ({ config: { provider: 'new', model: 'new-model' } }) } }
  assert.deepEqual(resolveModelSelection(current),
    { provider: 'new', model: 'new-model', selectionSource: 'session-header' })
  const metrics = []
  const llm = { async *stream(request) {
    assert.equal(request.provider, 'new')
    assert.equal(request.model, 'new-model')
    assert.equal(Object.hasOwn(request, 'reasoningEffort'), false)
    yield { type: 'text-delta', index: 0, text: '{}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  await askModel(llm, current, undefined, { stage: 'plan' }, { onMetrics: value => metrics.push(value) })
  assert.deepEqual([metrics[0].provider, metrics[0].model, metrics[0].reasoningEffort, metrics[0].selectionSource],
    ['new', 'new-model', null, 'session-header'])
  current.session.requestHeader = () => undefined
  assert.deepEqual(resolveModelSelection(current),
    { provider: 'old', model: 'old-model', reasoningEffort: 'high', selectionSource: 'agent-options' })
  current.session.requestHeader = () => ({ config: { provider: '', model: '' } })
  assert.equal(resolveModelSelection(current).selectionSource, 'agent-options')
})

test('生成任务可固定模型选择，后续会话切换不会混入同一报告', async () => {
  let header = { config: { provider: 'first', model: 'a', reasoningEffort: 'low' } }
  const current = { options: { provider: 'old', model: 'old-model' }, session: { requestHeader: () => header } }
  const fixed = resolveModelSelection(current)
  header = { config: { provider: 'second', model: 'b', reasoningEffort: 'max' } }
  let metrics
  await askModel({ async *stream(request) {
    assert.deepEqual([request.provider, request.model, request.reasoningEffort], ['first', 'a', 'low'])
    yield { type: 'text-delta', index: 0, text: '{}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }, current, undefined, { stage: 'extract' },
  { modelSelection: fixed, onMetrics: value => { metrics = value } })
  assert.deepEqual([metrics.provider, metrics.model, metrics.reasoningEffort, metrics.selectionSource],
    ['first', 'a', 'low', 'session-header'])
})

test('实测排队、首思考/正文与供应商 usage；回调异常不影响结果', async () => {
  const metrics = []
  const result = await askModel(answer, agent, undefined, { stage: 'plan' },
    { timeoutMs: 1000, queueTimeoutMs: 1000, onMetrics: value => metrics.push(value) })
  assert.deepEqual(result, { ok: true })
  assert.equal(metrics.length, 1)
  assert.ok(metrics[0].queuedAt <= metrics[0].requestStartedAt)
  assert.ok(metrics[0].requestStartedAt <= metrics[0].firstEventAt)
  assert.ok(metrics[0].firstEventAt <= metrics[0].firstTextAt)
  assert.ok(metrics[0].firstTextAt <= metrics[0].finishedAt)
  assert.ok(metrics[0].queueMs >= 0)
  assert.ok(metrics[0].serviceMs >= 0)
  assert.deepEqual(metrics[0].usage, { inputTokens: 123, outputTokens: 9, reasoningTokens: 3 })
  assert.equal(metrics[0].timeoutKind, null)
  assert.deepEqual(await askModel(answer, agent, undefined, { stage: 'plan' },
    { timeoutMs: 1000, queueTimeoutMs: 1000, onMetrics: () => { throw new Error('observability unavailable') } }), { ok: true })
})

test('排队超时单独计时，不发起模型请求，也不误记模型执行时长', async () => {
  const limiter = createLimiter(1)
  let release
  const occupied = limiter(() => new Promise(resolve => { release = resolve }))
  await delay(0)
  let called = false
  let metrics
  try {
    await assert.rejects(askModel({ async *stream() { called = true } }, agent, undefined, { stage: 'extract' },
      { limiter, queueTimeoutMs: 15, timeoutMs: 1000, onMetrics: value => { metrics = value } }),
    error => error.code === 'MODEL_QUEUE_TIMEOUT')
    assert.equal(called, false)
    assert.equal(metrics.requestStartedAt, null)
    assert.equal(metrics.serviceMs, null)
    assert.ok(metrics.queueMs >= 0)
    assert.equal(metrics.timeoutKind, 'queue')
  } finally { release(); await occupied }
})

test('排队后才开始执行超时；无 usage 时保留 null，失败也回调', async () => {
  const limiter = createLimiter(1)
  let release
  const occupied = limiter(() => new Promise(resolve => { release = resolve }))
  await delay(0)
  let metrics
  const pending = askModel({ async *stream(request) {
    await delay(50, undefined, { signal: request.signal })
    yield { type: 'text-delta', index: 0, text: '{}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }, agent, undefined, { stage: 'write' },
  { limiter, queueTimeoutMs: 200, timeoutMs: 15, onMetrics: value => { metrics = value } })
  const rejection = assert.rejects(pending, error => error.code === 'MODEL_STAGE_TIMEOUT')
  await delay(25)
  release(); await occupied; await rejection
  assert.ok(metrics.queueMs >= 20)
  assert.ok(metrics.serviceMs >= 0)
  assert.equal(metrics.timeoutKind, 'stage')
  assert.equal(metrics.usage, null)
  assert.equal(metrics.firstTextAt, null)
})

test('调用方取消保持原错误且观测回调执行', async () => {
  const controller = new AbortController()
  let metrics
  const pending = askModel({ async *stream(request) {
    await delay(100, undefined, { signal: request.signal })
  } }, agent, controller.signal, { stage: 'write' },
  { timeoutMs: 1000, queueTimeoutMs: 1000, onMetrics: value => { metrics = value } })
  const rejection = assert.rejects(pending, /用户取消/u)
  await delay(5)
  controller.abort(new Error('用户取消'))
  await rejection
  assert.ok(metrics.finishedAt)
  assert.equal(metrics.timeoutKind, null)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import os from 'node:os'
import path from 'node:path'
import { askModel, resolveModelSelection, resolveQueueTimeoutMs, resolveStageTimeoutMs, resolveWritingModel, stageOutputBudget, classifyModelFailure } from '../src/model.js'
import { createLimiter, createModelScheduler, resolveRouteConcurrency } from '../src/scheduler.js'

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

test('排队超时单独计时，不发起模型请求，也不误记模型执行时长', async t => {
  // AbortSignal.timeout is unref'ed on Node 22; the real DSH server keeps the event loop alive.
  const keepAlive = setInterval(() => {}, 1000)
  t.after(() => clearInterval(keepAlive))
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

test('默认输出预算沿用模型路由；显式配置可高于元数据默认值', async () => {
  assert.equal(stageOutputBudget('extract', { defaultMaxTokens: 3072 }, {}), undefined)
  const env = { WLYD_ASSEMBLY_OUTPUT_BUDGETS: '{"default":8192,"write":16000,"fake/fake":{"extract":12000}}' }
  assert.equal(stageOutputBudget('extract', { provider: 'fake', model: 'fake', defaultMaxTokens: 3072 }, env), 12000)
  assert.equal(stageOutputBudget('write', {}, env), 16000)
  assert.equal(stageOutputBudget('plan', {}, env), 8192)
  assert.equal(stageOutputBudget('extract', {}, { WLYD_ASSEMBLY_OUTPUT_BUDGETS: '{"extract":0}' }), undefined)
  let request
  await askModel({ async *stream(value) {
    request = value; yield { type: 'text-delta', text: '{}' }; yield { type: 'finish', reason: { kind: 'stop' } }
  } }, agent, undefined, { stage: 'extract' })
  assert.equal(Object.hasOwn(request, 'maxTokens'), false)
  const selection = await resolveWritingModel({ resolveModelInfo: async () => ({ defaultMaxTokens: 65536,
    reasoning: { efforts: [{ id: 'high' }, { id: 'low' }], defaultEffort: 'high' } }) }, agent)
  assert.deepEqual(selection.supportedReasoningEfforts, ['high', 'low'])
  assert.equal(selection.defaultReasoningEffort, 'high')
  assert.equal(selection.reasoningEffort, 'low')
  assert.equal(selection.defaultMaxTokens, 65536)
})

test('路由并发先于总槽；拥挤路由不会挡住另一个路由', async () => {
  const env = { WLYD_ASSEMBLY_CONCURRENCY: '2', WLYD_ASSEMBLY_ROUTE_CONCURRENCY: '{"fake/a":1,"fake/*":2,"default":1}' }
  assert.equal(resolveRouteConcurrency({ provider: 'fake', model: 'a' }, env), 1)
  assert.equal(resolveRouteConcurrency({ provider: 'fake', model: 'b' }, env), 2)
  assert.equal(resolveRouteConcurrency({ provider: 'other', model: 'a' }, env), 1)
  const scheduler = createModelScheduler({ globalLimiter: createLimiter(2), env })
  let release, aRuns = 0
  const first = scheduler({ provider: 'fake', model: 'a' }, () => new Promise(resolve => { aRuns++; release = resolve }))
  await delay(0)
  const second = scheduler({ provider: 'fake', model: 'a' }, () => { aRuns++; return 'second' })
  const independent = await scheduler({ provider: 'other', model: 'b' }, () => 'independent')
  assert.equal(independent, 'independent')
  assert.equal(aRuns, 1)
  release(); await first; await second
  assert.equal(aRuns, 2)
})

test('429最多退避两次，保存结构化failure，退避释放模型槽', async () => {
  const scheduler = createModelScheduler({ globalLimiter: createLimiter(1), env: { WLYD_ASSEMBLY_CONCURRENCY: '1' } })
  let calls = 0, metrics
  const sleeps = []
  const result = await askModel({ async *stream() {
    calls++
    if (calls < 3) yield { type: 'finish', reason: { kind: 'error', failure: {
      code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 1200, requestId: `request-${calls}`, message: 'busy' } } }
    else { yield { type: 'text-delta', text: '{}' }; yield { type: 'finish', reason: { kind: 'stop' } } }
  } }, agent, undefined, { stage: 'write' }, { scheduler, random: () => 0,
    sleep: async ms => {
      sleeps.push(ms)
      // This would hang if the failing request retained the route/global slot.
      await scheduler({ provider: 'fake', model: 'fake' }, async () => 'slot-released')
    }, onMetrics: value => { metrics = value } })
  assert.deepEqual(result, {})
  assert.deepEqual(sleeps, [1200, 2000])
  assert.equal(calls, 3)
  assert.equal(metrics.attempts, 3)
  assert.equal(metrics.rateLimitCount, 2)
  assert.equal(metrics.attemptDetails[0].failure.requestId, 'request-1')
  assert.equal(metrics.attemptDetails[0].failure.providerRetryAfterMs, 1200)
  assert.equal(metrics.failure, null)
})

test('持续429第三次失败；AUTH和QUOTA不会误判上下文或重试', async () => {
  for (const failure of [
    { code: 'RATE_LIMIT', status: 429, message: 'context window tokens limit' },
    { code: 'AUTH', status: 401, message: 'token limit invalid' },
    { code: 'QUOTA_EXCEEDED', status: 429, message: 'maximum token quota' },
  ]) {
    let calls = 0, metrics
    await assert.rejects(askModel({ async *stream() {
      calls++; yield { type: 'finish', reason: { kind: 'error', failure } }
    } }, agent, undefined, { stage: 'extract' }, { random: () => 0, sleep: async () => {}, onMetrics: value => { metrics = value } }),
    error => error.code === failure.code && error.failure.code === failure.code && error.failure.status === failure.status)
    assert.equal(calls, failure.code === 'RATE_LIMIT' ? 3 : 1)
    assert.equal(metrics.failure.code, failure.code)
  }
  assert.equal(classifyModelFailure(Object.assign(new Error('maximum output token limit'), { code: 'MODEL_OUTPUT_LIMIT' })), 'output')
  assert.equal(classifyModelFailure(Object.assign(new Error('context exceeded'), { code: 'CONTEXT_WINDOW_EXCEEDED' })), 'context')
  assert.equal(classifyModelFailure(new Error('maximum tokens limit')), 'other')
})

test('退避可及时取消，不再发请求', async () => {
  const controller = new AbortController()
  let calls = 0, metrics
  const pending = askModel({ async *stream() {
    calls++; yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', status: 429, message: 'busy' } } }
  } }, agent, controller.signal, { stage: 'write' }, { random: () => 0, onMetrics: value => { metrics = value } })
  const rejected = assert.rejects(pending, /停止退避/u)
  await delay(10); controller.abort(new Error('停止退避')); await rejected
  assert.equal(calls, 1)
  assert.ok(metrics.backoffMs < 500)
})

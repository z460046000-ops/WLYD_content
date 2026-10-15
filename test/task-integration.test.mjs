import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createTaskService } from '../src/tasks.js'
import { createRetrieval } from '../src/retrieval.js'
import { rootOf, runPath } from '../src/store.js'
import { completeAudit } from './helpers.mjs'
import { taskFixture, readRecord } from './task-helpers.mjs'

const singleChapter = [{ key: 'service', title: '交接服务', roleId: 'delivery-service', required: true }]
function localGenerationModel({ beforeWrite } = {}) {
  const calls = []
  return { calls, resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }] } }),
    async *stream(request) {
      const prompt = JSON.parse(request.messages[0].content[0].text)
      calls.push({ stage: prompt.stage, key: prompt.chapter?.key })
      let value
      if (prompt.stage === 'extract') value = { facts: prompt.evidence.map(source => ({ text: source.content,
        evidence: [{ id: source.id, quote: source.content }] })) }
      else if (prompt.stage === 'write') {
        await beforeWrite?.(prompt)
        const source = prompt.evidence[0]
        value = { sections: [{ key: prompt.chapter.key, blocks: [{ text: '产品支持统一维护线索状态，销售和客服可以查看同一记录。',
          supportMode: 'sourced', evidence: [{ id: source.id, quote: source.content }],
          planRefs: { capabilityIds: [], scenarioIds: [], problemIds: [], trendIds: [] } }] }] }
      } else if (prompt.stage === 'consistency-review') value = completeAudit()
      else throw new Error(`unexpected model stage: ${prompt.stage}`)
      yield { type: 'text-delta', text: JSON.stringify(value) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
}

test('真实 assemble 使用后台接纳的 runId，产物和查询保持同一运行而不创建幽灵 run', async t => {
  const f = await taskFixture({ outline: singleChapter }), llm = localGenerationModel()
  const service = createTaskService({ ...f, llm })
  t.after(() => service.close())
  const submitted = await service.submit(f.args, f.exec)
  const completed = await f.jobs.settled(submitted.jobId)
  assert.equal(completed.status, 'completed')
  const result = JSON.parse(completed.output)
  assert.equal(result.runId, submitted.runId)
  assert.equal(result.status, 'needs_human_review')
  const state = await service.query(submitted.runId, f.exec)
  assert.equal(state.runId, submitted.runId)
  assert.equal(state.kind, 'assembly-task')
  assert.equal(state.jobId, submitted.jobId)
  assert.equal(state.progress.completed, 1)
  assert.equal(state.review.passed, true)
  const report = await readRecord(path.join(runPath(f.agent, submitted.runId), 'report.json'))
  assert.equal(report.runId, submitted.runId)
  assert.equal(report.sections.length, 1)
  assert.ok(!llm.calls.some(call => call.stage === 'plan'))
  const runDirectories = (await readdir(rootOf(f.agent))).filter(name => /^[0-9a-f-]{36}$/u.test(name))
  assert.deepEqual(new Set(runDirectories), new Set([f.sourceRunId, f.args.plan_id, submitted.runId]))
  const repeated = await service.submit(f.args, f.exec)
  assert.equal(repeated.runId, submitted.runId)
  assert.equal(repeated.reused, true)
})

test('真实 assemble 失败后 resume 复用核验过的提取检查点，只补撰写并保持 runId', async t => {
  const f = await taskFixture({ outline: singleChapter })
  let fail = true
  const llm = localGenerationModel({ beforeWrite: () => {
    if (fail) throw Object.assign(new Error('模拟上游执行超时'), { code: 'MODEL_STAGE_TIMEOUT' })
  } })
  const service = createTaskService({ ...f, llm })
  t.after(() => service.close())
  const submitted = await service.submit(f.args, f.exec)
  assert.equal((await f.jobs.settled(submitted.jobId)).status, 'failed')
  const first = await service.query(submitted.runId, f.exec)
  assert.equal(first.status, 'failed')
  assert.equal(first.chapters[0].status, 'failed')
  const extractCalls = llm.calls.filter(call => call.stage === 'extract').length
  assert.equal(extractCalls, 1)
  fail = false
  const resumed = await service.submit({ mode: 'resume', run_id: submitted.runId }, f.exec)
  const completed = await f.jobs.settled(resumed.jobId)
  assert.equal(completed.status, 'completed')
  assert.equal(resumed.runId, submitted.runId)
  assert.equal(llm.calls.filter(call => call.stage === 'extract').length, extractCalls)
  const after = await service.query(submitted.runId, f.exec)
  assert.equal(after.chapters[0].reusedExtraction, true)
  assert.equal(after.chapters[0].status, 'completed')
  assert.equal(after.review.passed, true)
})

test('恢复归档证据重新核对知识库授权和文档状态，拒绝时不覆盖原 evidence 存档', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wlyd-evidence-restore-'))
  const signal = new AbortController().signal
  const originalEvidence = []
  const client = { visibleProjectBases: async () => ['BASE'], documents: async () => [{ id: 'DOC', parse_status: 'completed' }],
    searchEvidence: async () => ({ status: 'completed', source: 'unified', items: [
      { chunk_id: 'CHUNK', knowledge_id: 'DOC', content: '产品支持跨团队共享线索记录。' },
    ] }) }
  const initial = createRetrieval({ client, projectId: 'PROJECT', evidence: originalEvidence, signal, dir })
  await initial.discover()
  assert.equal(originalEvidence.length, 1)
  const before = await readFile(path.join(dir, 'evidence.json'), 'utf8')
  for (const restricted of [
    { ...client, visibleProjectBases: async () => [] },
    { ...client, documents: async () => [{ id: 'DOC', parse_status: 'pending' }] },
  ]) {
    const restored = createRetrieval({ client: restricted, projectId: 'PROJECT', evidence: [], signal, dir, deferInitialFlush: true })
    await restored.prepare()
    assert.equal(await readFile(path.join(dir, 'evidence.json'), 'utf8'), before)
    await assert.rejects(restored.restoreEvidence(originalEvidence), /当前项目权限|文档状态/u)
    await restored.flush()
    assert.equal(await readFile(path.join(dir, 'evidence.json'), 'utf8'), before)
  }
  const restored = createRetrieval({ client, projectId: 'PROJECT', evidence: [], signal, dir, deferInitialFlush: true })
  await restored.restoreEvidence(originalEvidence)
  const after = await readRecord(path.join(dir, 'evidence.json'))
  assert.deepEqual(after.evidence.map(source => source.id), originalEvidence.map(source => source.id))
})

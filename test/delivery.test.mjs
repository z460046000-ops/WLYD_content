import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { createDeliveryService } from '../src/delivery/tasks.js'
import { currentDelivery } from '../src/delivery/manifest.js'
import { createTaskService } from '../src/tasks.js'
import { createSnapshot } from '../src/content/snapshot.js'
import { createRetrieval } from '../src/retrieval.js'
import { buildPresentation } from '../src/outputs/html-slides/plan.js'
import { runPath, sourceEvidence } from '../src/store.js'
import { deferred, readRecord, taskFixture, waitControlled } from './task-helpers.mjs'

const outline = [{ key: 'solution', title: '场景解决方案', roleId: 'scenario-solution', required: true }]

function deliveryJobs() {
  const records = new Map(), controllers = new Set(), disposed = new Set()
  const ownerId = owner => owner?.id || owner?.session?.id
  const owned = (id, owner) => {
    const record = records.get(String(id))
    if (!record) throw new Error('job not found')
    if (ownerId(record.owner) !== ownerId(owner)) throw new Error('当前会话无权操作该后台任务')
    return record
  }
  return {
    records, controllers, disposed,
    attachController(name) {
      assert.ok(['wlyd-assembly-tasks', 'wlyd-assembly-delivery'].includes(name))
      assert.ok(!controllers.has(name), 'controller must be independently registered')
      controllers.add(name)
      return () => disposed.add(name)
    },
    start(spec) {
      assert.ok(spec.owner); assert.equal(spec.unowned, undefined)
      const id = randomUUID(), running = spec.run()
      const record = { id, owner: spec.owner, kind: spec.kind, status: 'running', cancel: running.cancel }
      records.set(id, record)
      record.done = Promise.resolve(running.done).then(result => {
        record.status = result.status; record.result = result; return result
      })
      return id
    },
    get: owned,
    kill(id, owner, reason) { const record = owned(id, owner); record.cancel(reason); return { id, status: 'killing' } },
    settled(id) { return records.get(String(id)).done }
  }
}

const presentationPlan = snapshot => buildPresentation({ snapshot })

async function deliveryFixture() {
  const fixture = await taskFixture({ outline })
  const evidence = (await sourceEvidence(fixture.agent, fixture.args)).evidence
  let authorizationChecks = 0
  const originalVisible = fixture.client.visibleProjectBases
  fixture.client.visibleProjectBases = async (...args) => { authorizationChecks++; return originalVisible(...args) }
  const retrieval = createRetrieval({ client: fixture.client, projectId: 'P1', evidence, signal: fixture.exec.signal })
  await retrieval.discover()
  const knowledge = evidence.find(row => row.kind === 'knowledge')
  assert.ok(knowledge)
  const runId = randomUUID(), dir = runPath(fixture.agent, runId)
  await mkdir(dir, { recursive: true })
  const report = { schemaVersion: 2, runId, title: '合成输出测试方案', qualityMode: 'draft', outline,
    reviewStatus: 'draft_ready', sections: [{ key: 'solution', title: '场景解决方案', roleId: 'scenario-solution',
      blocks: [{ id: 'solution-1', text: '产品支持统一维护线索状态，销售和客服可以查看同一记录。',
        supportMode: 'sourced', verification: 'citation_checked',
        evidence: [{ id: knowledge.id, quote: knowledge.content }],
        planRefs: { capabilityIds: [], problemIds: [], scenarioIds: [], trendIds: [] } }] }],
    chapterOutcomes: [{ key: 'solution', title: '场景解决方案', status: 'draft_unverified', version: 1 }],
    assemblyReview: { status: 'completed', passed: false },
    chapterRecords: { solution: { version: 1, approvalStatus: 'pending' } } }
  const state = { runId, actorDshId: fixture.agent.session.user.id, projectId: 'P1', status: 'draft_ready' }
  await writeFile(path.join(dir, 'run.json'), JSON.stringify(state))
  await writeFile(path.join(dir, 'run-input.json'), JSON.stringify({ args: { ...fixture.args, project_id: 'P1' } }))
  await writeFile(path.join(dir, 'report.json'), JSON.stringify(report))
  await writeFile(path.join(dir, 'evidence.json'), JSON.stringify({ evidence }))
  const originalReport = await readFile(path.join(dir, 'report.json'), 'utf8')
  const originalState = await readFile(path.join(dir, 'run.json'), 'utf8')
  return { ...fixture, jobs: deliveryJobs(), runId, dir, report, originalReport, originalState,
    get authorizationChecks() { return authorizationChecks } }
}

const localRender = async (plan, { theme }) => `<!doctype html><html><body>${theme} ${plan.slides[0].points[0].text}</body></html>`

test('MD/DOCX are published before the independent HTML host job finishes', async t => {
  const f = await deliveryFixture(), entered = deferred(), release = deferred()
  const assembly = createTaskService(f)
  const delivery = createDeliveryService({ ...f, build: async ({ snapshot, signal }) => {
    entered.resolve(); await waitControlled(signal, release); return presentationPlan(snapshot)
  }, render: localRender })
  t.after(async () => { await delivery.close(); await assembly.close() })
  assert.equal(f.jobs.controllers.size, 2)
  const submitted = await delivery.submit({ run_id: f.runId }, f.exec)
  await entered.promise
  const running = await delivery.query(f.runId, f.exec)
  assert.equal(running.documentsReady, true)
  assert.equal(running.htmlReady, false)
  assert.ok(['queued', 'rendering'].includes(running.status))
  assert.equal(f.jobs.get(submitted.jobId, f.agent).status, 'running')
  assert.match(await readFile(running.markdownPath, 'utf8'), /产品支持统一维护线索状态/u)
  assert.equal((await readFile(running.docxPath)).subarray(0, 2).toString(), 'PK')
  assert.ok(f.authorizationChecks >= 3, 'submit/query recheck current knowledge permissions')
  const reused = await delivery.submit({ run_id: f.runId }, f.exec)
  assert.equal(reused.reused, true)
  assert.equal(reused.exportId, submitted.exportId)
  assert.equal(f.jobs.records.size, 1)
  release.resolve()
  assert.equal((await f.jobs.settled(submitted.jobId)).status, 'completed')
  const completed = await delivery.query(f.runId, f.exec)
  assert.equal(completed.documentsReady, true); assert.equal(completed.htmlReady, true)
  assert.match(await readFile(completed.htmlPath, 'utf8'), /产品支持统一维护线索状态/u)
  assert.equal(await readFile(path.join(f.dir, 'report.json'), 'utf8'), f.originalReport)
  assert.equal(await readFile(path.join(f.dir, 'run.json'), 'utf8'), f.originalState)
})

test('HTML rendering failure leaves readable documents and a retryable output status', async t => {
  const f = await deliveryFixture()
  const delivery = createDeliveryService({ ...f, build: async ({ snapshot }) => presentationPlan(snapshot),
    render: async () => { throw new Error('模拟HTML渲染失败') } })
  t.after(() => delivery.close())
  const submitted = await delivery.submit({ run_id: f.runId }, f.exec)
  assert.equal((await f.jobs.settled(submitted.jobId)).status, 'failed')
  const result = await delivery.query(f.runId, f.exec)
  assert.equal(result.status, 'failed'); assert.equal(result.documentsReady, true); assert.equal(result.htmlReady, false)
  assert.match(result.error, /模拟HTML渲染失败/u)
  assert.ok((await readFile(result.markdownPath)).length)
  assert.ok((await readFile(result.docxPath)).length)
  assert.equal(await readFile(path.join(f.dir, 'report.json'), 'utf8'), f.originalReport)
})

test('cancelling an HTML job retains documents and does not cancel or rewrite the manuscript', async t => {
  const f = await deliveryFixture(), entered = deferred(), release = deferred()
  const delivery = createDeliveryService({ ...f, build: async ({ snapshot, signal }) => {
    entered.resolve(); await waitControlled(signal, release); return presentationPlan(snapshot)
  }, render: localRender })
  t.after(() => delivery.close())
  const submitted = await delivery.submit({ run_id: f.runId }, f.exec)
  await entered.promise
  const cancelling = await delivery.cancel(f.runId, f.exec)
  assert.equal(cancelling.status, 'cancelling')
  assert.equal((await f.jobs.settled(submitted.jobId)).status, 'killed')
  const result = await delivery.query(f.runId, f.exec)
  assert.equal(result.status, 'cancelled'); assert.equal(result.documentsReady, true)
  assert.ok((await readFile(result.markdownPath)).length); assert.ok((await readFile(result.docxPath)).length)
  assert.equal(await readFile(path.join(f.dir, 'report.json'), 'utf8'), f.originalReport)
  assert.equal(await readFile(path.join(f.dir, 'run.json'), 'utf8'), f.originalState)
})

test('changed prose marks previous output stale and rejects an old expected content hash', async t => {
  const f = await deliveryFixture()
  const delivery = createDeliveryService({ ...f, build: async ({ snapshot }) => presentationPlan(snapshot), render: localRender })
  t.after(() => delivery.close())
  const submitted = await delivery.submit({ run_id: f.runId, format: 'documents' }, f.exec)
  assert.equal(submitted.documentsReady, true); assert.equal(f.jobs.records.size, 0)
  const changed = structuredClone(f.report)
  changed.sections[0].blocks[0].text += '后续流程由客户确认。'
  changed.chapterRecords.solution.version = 2
  await writeFile(path.join(f.dir, 'report.json'), JSON.stringify(changed))
  const stale = await delivery.query(f.runId, f.exec)
  assert.equal(stale.stale, true); assert.match(stale.note, /旧版本/u)
  await assert.rejects(delivery.submit({ run_id: f.runId, expected_content_sha256: submitted.sourceContentSha256 }, f.exec), /文案版本已改变/u)
  assert.equal((await currentDelivery(f.agent, f.runId)).sourceContentSha256, submitted.sourceContentSha256)
})

test('a manuscript edit during HTML work cannot be overwritten by the older output job', async t => {
  const f = await deliveryFixture(), entered = deferred(), release = deferred()
  const delivery = createDeliveryService({ ...f, build: async ({ snapshot, signal }) => {
    entered.resolve(); await waitControlled(signal, release); return presentationPlan(snapshot)
  }, render: localRender })
  t.after(() => delivery.close())
  const submitted = await delivery.submit({ run_id: f.runId }, f.exec)
  await entered.promise
  const changed = structuredClone(f.report)
  changed.sections[0].blocks[0].text = '这是输出开始后保存的新版本正文，应当保持不被旧任务改写。'
  changed.chapterRecords.solution.version = 2
  const changedBytes = JSON.stringify(changed)
  await writeFile(path.join(f.dir, 'report.json'), changedBytes)
  release.resolve()
  const outputJob = await f.jobs.settled(submitted.jobId)
  assert.equal(outputJob.status, 'completed')
  assert.equal(JSON.parse(outputJob.output).stale, true, 'the host completion notification must mark this same export stale')
  const result = await delivery.query(f.runId, f.exec)
  assert.equal(result.stale, true); assert.equal(result.documentsReady, true); assert.equal(result.htmlReady, true)
  assert.equal(await readFile(path.join(f.dir, 'report.json'), 'utf8'), changedBytes)
  assert.match(await readFile(result.htmlPath, 'utf8'), /产品支持统一维护线索状态/u)
  assert.doesNotMatch(await readFile(result.htmlPath, 'utf8'), /保存的新版本正文/u)
})

test('output model uses its own route and theme changes reuse the same source slide plan', async t => {
  const f = await deliveryFixture(), requests = [], resolutions = [], builds = []
  const llm = { resolveModelInfo: async (provider, model) => {
    resolutions.push([provider, model]); return { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }
  }, async *stream(request) {
    requests.push(request)
    yield { type: 'text-delta', text: '{"selected":true}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const delivery = createDeliveryService({ ...f, llm, modelRoute: { provider: 'output-provider', model: 'output-model', reasoningEffort: 'high' },
    build: async ({ snapshot, request }) => {
      builds.push(snapshot.sourceContentSha256)
      assert.deepEqual(await request({ stage: 'presentation', task: '合成输出模型调用' }), { selected: true })
      return presentationPlan(snapshot)
    }, render: localRender })
  t.after(() => delivery.close())
  const first = await delivery.submit({ run_id: f.runId, theme: 'editorial' }, f.exec)
  assert.equal((await f.jobs.settled(first.jobId)).status, 'completed')
  assert.deepEqual(resolutions, [['output-provider', 'output-model']])
  assert.deepEqual(requests.map(request => [request.provider, request.model, request.reasoningEffort]), [['output-provider', 'output-model', 'low']])
  assert.equal(f.agent.options.model, 'fake')
  const firstManifest = await currentDelivery(f.agent, f.runId)
  const firstPlan = await readRecord(firstManifest.html.planPath)
  const second = await delivery.submit({ run_id: f.runId, theme: 'swiss' }, f.exec)
  assert.equal((await f.jobs.settled(second.jobId)).status, 'completed')
  assert.notEqual(second.exportId, first.exportId)
  assert.equal(second.sourceContentSha256, first.sourceContentSha256)
  assert.equal(builds.length, 1); assert.equal(requests.length, 1); assert.equal(resolutions.length, 1)
  const after = await currentDelivery(f.agent, f.runId)
  assert.equal(after.reusedPresentation, true)
  assert.deepEqual(await readRecord(after.html.planPath), firstPlan)
  assert.match(await readFile(after.html.path, 'utf8'), /swiss/u)
  const requestRecord = await readRecord(path.join(path.dirname(firstManifest.html.path), 'model-requests.json'))
  assert.equal(requestRecord.modelRequests.length, 1)
  assert.equal(requestRecord.modelRequests[0].stage, 'presentation')
  assert.equal(requestRecord.modelSelection.selectionSource, 'plugin-role')
  assert.equal(await readFile(path.join(f.dir, 'report.json'), 'utf8'), f.originalReport)
})

test('retry explicitly rebuilds a degraded slide plan while normal reuse and theme changes keep the cache', async t => {
  const f = await deliveryFixture()
  let builds = 0, selections = 0
  const delivery = createDeliveryService({ ...f, build: async ({ snapshot }) => {
    builds++
    return buildPresentation({ snapshot, request: async ({ units }) => {
      selections++
      if (selections === 1) throw new Error('模拟首次演示精简超时')
      return { slides: [{ title: '统一线索记录', points: [{ text: '销售和客服共享线索记录', sourceBlockIds: [units[0].sourceBlockId] }] }] }
    } })
  }, render: localRender })
  t.after(() => delivery.close())
  const first = await delivery.submit({ run_id: f.runId }, f.exec)
  assert.equal((await f.jobs.settled(first.jobId)).status, 'completed')
  const firstManifest = await currentDelivery(f.agent, f.runId)
  const firstPlan = await readRecord(firstManifest.html.planPath)
  assert.equal(firstPlan.slides[0].mode, 'source-pagination')
  assert.match(firstPlan.warnings[0], /模拟首次演示精简超时/u)
  const reused = await delivery.submit({ run_id: f.runId }, f.exec)
  assert.equal(reused.reused, true)
  assert.equal(reused.exportId, first.exportId)
  const themed = await delivery.submit({ run_id: f.runId, theme: 'swiss' }, f.exec)
  assert.equal((await f.jobs.settled(themed.jobId)).status, 'completed')
  assert.equal((await currentDelivery(f.agent, f.runId)).reusedPresentation, true)
  assert.equal(builds, 1); assert.equal(selections, 1)
  const retry = await delivery.submit({ run_id: f.runId, theme: 'swiss', retry: true }, f.exec)
  assert.equal((await f.jobs.settled(retry.jobId)).status, 'completed')
  const retriedManifest = await currentDelivery(f.agent, f.runId)
  const retriedPlan = await readRecord(retriedManifest.html.planPath)
  assert.notEqual(retry.exportId, themed.exportId)
  assert.equal(retriedManifest.reusedPresentation, undefined)
  assert.equal(builds, 2); assert.equal(selections, 2)
  assert.equal(retriedPlan.slides[0].mode, 'summary')
  assert.deepEqual(retriedPlan.warnings, [])
  assert.equal(await readFile(path.join(f.dir, 'report.json'), 'utf8'), f.originalReport)
  assert.equal(await readFile(firstManifest.html.planPath, 'utf8'), JSON.stringify(firstPlan, null, 2))
})

test('delivery rejects another user, revoked KB authorization and mismatched requested content hash', async t => {
  const f = await deliveryFixture()
  const delivery = createDeliveryService({ ...f, build: async ({ snapshot }) => presentationPlan(snapshot), render: localRender })
  t.after(() => delivery.close())
  const other = { ...f.exec, agent: { ...f.agent, id: 'other-session',
    session: { ...f.agent.session, user: { id: 'other-user' } } } }
  await assert.rejects(delivery.submit({ run_id: f.runId }, other), /无权导出/u)
  await assert.rejects(delivery.query(f.runId, other), /无权导出/u)
  await assert.rejects(delivery.submit({ run_id: f.runId, expected_content_sha256: '0'.repeat(64) }, f.exec), /文案版本已改变/u)
  assert.equal(createSnapshot(f.report).sourceContentSha256.length, 64)
  f.client.visibleProjectBases = async () => []
  await assert.rejects(delivery.submit({ run_id: f.runId }, f.exec), /当前项目权限/u)
  assert.equal(f.jobs.records.size, 0)
  assert.equal(await readFile(path.join(f.dir, 'report.json'), 'utf8'), f.originalReport)
})

test('missing or empty evidence/input archives cannot silently bypass output authorization', async t => {
  const f = await deliveryFixture()
  const delivery = createDeliveryService({ ...f, build: async ({ snapshot }) => presentationPlan(snapshot), render: localRender })
  t.after(() => delivery.close())
  for (const filename of ['run-input.json', 'evidence.json']) {
    const file = path.join(f.dir, filename), backup = `${file}.missing-fixture`
    await rename(file, backup)
    await assert.rejects(delivery.submit({ run_id: f.runId, format: 'documents' }, f.exec), /ENOENT/u)
    await assert.rejects(delivery.query(f.runId, f.exec), /ENOENT/u)
    await rename(backup, file)
  }
  const evidencePath = path.join(f.dir, 'evidence.json'), original = await readFile(evidencePath, 'utf8')
  await writeFile(evidencePath, JSON.stringify({ evidence: [] }))
  f.client.visibleProjectBases = async () => []
  await assert.rejects(delivery.submit({ run_id: f.runId, format: 'documents' }, f.exec), /知识库证据归档|权限/u)
  await assert.rejects(delivery.query(f.runId, f.exec), /知识库证据归档|权限/u)
  await writeFile(evidencePath, original)
  assert.equal(f.jobs.records.size, 0)
  assert.equal(await readFile(path.join(f.dir, 'report.json'), 'utf8'), f.originalReport)
})

test('each manuscript citation must resolve inside the restored currently authorized evidence', async t => {
  const f = await deliveryFixture()
  const delivery = createDeliveryService({ ...f, build: async ({ snapshot }) => presentationPlan(snapshot), render: localRender })
  t.after(() => delivery.close())
  for (const ref of [{ id: 'K-not-in-authorized-archive', quote: '不属于授权证据的敏感信息。' },
    { id: f.report.sections[0].blocks[0].evidence[0].id, quote: '同一证据ID中并不存在的逐字引文。' }]) {
    const changed = structuredClone(f.report)
    changed.sections[0].blocks[0].evidence.push(ref)
    await writeFile(path.join(f.dir, 'report.json'), JSON.stringify(changed))
    await assert.rejects(delivery.submit({ run_id: f.runId, format: 'documents' }, f.exec), /证据|权限|引用|归档/u)
    await assert.rejects(delivery.query(f.runId, f.exec), /证据|权限|引用|归档/u)
  }
  assert.equal(f.jobs.records.size, 0)
})

test('a queued manifest without a host job is interrupted and default submit creates a fresh output job', async t => {
  const f = await deliveryFixture()
  const delivery = createDeliveryService({ ...f, build: async ({ snapshot }) => presentationPlan(snapshot), render: localRender })
  t.after(() => delivery.close())
  const documents = await delivery.submit({ run_id: f.runId, format: 'documents' }, f.exec)
  const manifestPath = path.join(f.dir, 'outputs', documents.exportId, 'manifest.json')
  const manifest = await readRecord(manifestPath)
  manifest.jobId = randomUUID(); manifest.status = 'queued'; manifest.html.status = 'queued'
  await writeFile(manifestPath, JSON.stringify(manifest))
  const interrupted = await delivery.query(f.runId, f.exec)
  assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.documentsReady, true)
  const restarted = await delivery.submit({ run_id: f.runId }, f.exec)
  assert.notEqual(restarted.exportId, documents.exportId)
  assert.notEqual(restarted.jobId, manifest.jobId); assert.notEqual(restarted.reused, true)
  assert.equal((await f.jobs.settled(restarted.jobId)).status, 'completed')
  assert.equal((await delivery.query(f.runId, f.exec)).htmlReady, true)
})

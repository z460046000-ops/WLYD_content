import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { createDiagramService } from '../src/delivery/diagrams.js'
import { createRetrieval } from '../src/retrieval.js'
import { runPath, sourceEvidence } from '../src/store.js'
import { deferred, taskFixture, waitControlled } from './task-helpers.mjs'

const outline = [{ key: 'solution', title: '场景解决方案', roleId: 'scenario-solution', required: true }]
const kinds = ['business', 'product']

function diagramJobs() {
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
      assert.equal(name, 'wlyd-assembly-diagrams')
      assert.ok(!controllers.has(name))
      controllers.add(name)
      return () => disposed.add(name)
    },
    start(spec) {
      assert.ok(spec.owner)
      assert.equal(spec.unowned, undefined)
      assert.equal(spec.kind, 'wlyd-assembly-diagrams')
      const id = randomUUID(), running = spec.run()
      const record = { id, owner: spec.owner, status: 'running', cancel: running.cancel }
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

async function diagramFixture() {
  const fixture = await taskFixture({ outline })
  const evidence = (await sourceEvidence(fixture.agent, fixture.args)).evidence
  let authorizationChecks = 0
  const visible = fixture.client.visibleProjectBases
  fixture.client.visibleProjectBases = async (...args) => { authorizationChecks++; return visible(...args) }
  const retrieval = createRetrieval({ client: fixture.client, projectId: 'P1', evidence, signal: fixture.exec.signal })
  await retrieval.discover()
  const knowledge = evidence.find(row => row.kind === 'knowledge')
  assert.ok(knowledge)
  const runId = randomUUID(), dir = runPath(fixture.agent, runId)
  await mkdir(dir, { recursive: true })
  const report = { schemaVersion: 2, runId, title: '架构图隔离测试', outline, reviewStatus: 'draft_ready',
    sections: [{ key: 'solution', title: '场景解决方案', roleId: 'scenario-solution', blocks: [{ id: 'solution-1',
      text: '产品支持统一维护线索状态，销售和客服可以查看同一记录。',
      supportMode: 'sourced', verification: 'citation_checked', evidence: [{ id: knowledge.id, quote: knowledge.content }],
      planRefs: { capabilityIds: [], problemIds: [], scenarioIds: [], trendIds: [] } }] }],
    chapterOutcomes: [{ key: 'solution', status: 'draft_unverified', version: 1 }],
    chapterRecords: { solution: { version: 1, approvalStatus: 'pending' } },
    assemblyReview: { status: 'completed', passed: false } }
  const records = {
    'run.json': { runId, actorDshId: fixture.agent.session.user.id, projectId: 'P1', status: 'draft_ready' },
    'run-input.json': { args: { ...fixture.args, project_id: 'P1' } },
    'report.json': report,
    'evidence.json': { evidence },
    'delivery.json': { exportId: randomUUID(), sourceContentSha256: 'existing-document-html-export' }
  }
  for (const [filename, record] of Object.entries(records)) await writeFile(path.join(dir, filename), JSON.stringify(record))
  const originals = Object.fromEntries(await Promise.all(['report.json', 'run.json', 'delivery.json']
    .map(async filename => [filename, await readFile(path.join(dir, filename))])))
  return { ...fixture, jobs: diagramJobs(), runId, dir, report, originals,
    get authorizationChecks() { return authorizationChecks } }
}

const localBuild = async ({ snapshot, kind }) => ({ schemaVersion: 1, kind, status: 'planned',
  sourceContentSha256: snapshot.sourceContentSha256, mode: 'extractive-diagram', warnings: [],
  nodes: [{ id: `${kind}-1`, label: snapshot.sections[0].blocks[0].text }], edges: [] })

const localRender = async (plan, { outputDir }) => {
  const file = path.join(outputDir, `${plan.kind}.svg`)
  await writeFile(file, `<svg xmlns="http://www.w3.org/2000/svg"><text>${plan.kind}</text></svg>`)
  return { path: file, format: 'svg' }
}

async function assertExistingOutputsUnchanged(f) {
  for (const [filename, original] of Object.entries(f.originals)) {
    assert.deepEqual(await readFile(path.join(f.dir, filename)), original, `${filename} must remain byte-identical`)
  }
}

test('two SVGs finish independently of existing manuscript/document output and reuse active/completed exports', async t => {
  const f = await diagramFixture(), entered = deferred(), release = deferred(), snapshots = []
  const service = createDiagramService({ ...f, build: async args => {
    snapshots.push(args.snapshot.sourceContentSha256)
    if (args.kind === 'business') { entered.resolve(); await waitControlled(args.signal, release) }
    return localBuild(args)
  }, render: localRender })
  t.after(() => service.close())
  const submitted = await service.submit({ run_id: f.runId }, f.exec)
  await entered.promise
  assert.equal(f.jobs.get(submitted.jobId, f.agent).status, 'running')
  const activeReuse = await service.submit({ run_id: f.runId }, f.exec)
  assert.equal(activeReuse.reused, true); assert.equal(activeReuse.exportId, submitted.exportId)
  await assertExistingOutputsUnchanged(f)
  release.resolve()
  assert.equal((await f.jobs.settled(submitted.jobId)).status, 'completed')
  const result = await service.query(f.runId, f.exec)
  assert.equal(result.status, 'completed'); assert.equal(result.diagramsReady, true)
  assert.deepEqual(snapshots, [submitted.sourceContentSha256, submitted.sourceContentSha256])
  for (const kind of kinds) {
    assert.equal(result.diagrams[kind].status, 'completed')
    assert.match(await readFile(result.diagrams[kind].path, 'utf8'), /<svg/u)
    const plan = JSON.parse(await readFile(result.diagrams[kind].planPath, 'utf8'))
    assert.equal(plan.sourceContentSha256, result.sourceContentSha256)
  }
  const completedReuse = await service.submit({ run_id: f.runId }, f.exec)
  assert.equal(completedReuse.reused, true); assert.equal(completedReuse.exportId, submitted.exportId)
  assert.equal(f.jobs.records.size, 1)
  assert.ok(f.authorizationChecks >= 6, 'submit/query and finished artifacts must recheck authorization')
  await assertExistingOutputsUnchanged(f)
})

test('one diagram failure preserves the other completed SVG', async t => {
  const f = await diagramFixture()
  const service = createDiagramService({ ...f, build: localBuild, render: async (plan, options) => {
    if (plan.kind === 'business') throw new Error('模拟业务图渲染失败')
    return localRender(plan, options)
  } })
  t.after(() => service.close())
  const submitted = await service.submit({ run_id: f.runId }, f.exec)
  assert.equal((await f.jobs.settled(submitted.jobId)).status, 'completed')
  const result = await service.query(f.runId, f.exec)
  assert.equal(result.status, 'partial'); assert.equal(result.diagramsReady, false)
  assert.equal(result.diagrams.business.status, 'failed')
  assert.match(result.diagrams.business.error, /模拟业务图渲染失败/u)
  assert.equal(result.diagrams.product.status, 'completed')
  assert.ok((await readFile(result.diagrams.product.path)).length)
  await assertExistingOutputsUnchanged(f)
})

test('cancel keeps a completed SVG and rejects a different session before killing the owned job', async t => {
  const f = await diagramFixture(), entered = deferred(), release = deferred()
  const service = createDiagramService({ ...f, build: async args => {
    if (args.kind === 'product') { entered.resolve(); await waitControlled(args.signal, release) }
    return localBuild(args)
  }, render: localRender })
  t.after(() => service.close())
  const submitted = await service.submit({ run_id: f.runId }, f.exec)
  await entered.promise
  const otherSession = { ...f.exec, agent: { ...f.agent, id: 'other-session',
    session: { ...f.agent.session, id: 'other-session' } } }
  await assert.rejects(service.cancel(f.runId, otherSession), /无权操作/u)
  assert.equal(f.jobs.get(submitted.jobId, f.agent).status, 'running')
  assert.equal((await service.cancel(f.runId, f.exec)).status, 'cancelling')
  assert.equal((await f.jobs.settled(submitted.jobId)).status, 'killed')
  const result = await service.query(f.runId, f.exec)
  assert.equal(result.status, 'cancelled'); assert.equal(result.diagramsReady, false)
  assert.equal(result.diagrams.business.status, 'completed')
  assert.ok((await readFile(result.diagrams.business.path)).length)
  assert.equal(result.diagrams.product.status, 'cancelled')
  await assertExistingOutputsUnchanged(f)
})

test('another user, wrong content version and revoked knowledge permission cannot use diagram output', async t => {
  const f = await diagramFixture()
  const service = createDiagramService({ ...f, build: localBuild, render: localRender })
  t.after(() => service.close())
  const otherUser = { ...f.exec, agent: { ...f.agent, id: 'other-session',
    session: { ...f.agent.session, user: { id: 'other-user' } } } }
  await assert.rejects(service.submit({ run_id: f.runId }, otherUser), /无权导出/u)
  await assert.rejects(service.query(f.runId, otherUser), /无权导出/u)
  await assert.rejects(service.submit({ run_id: f.runId, expected_content_sha256: '0'.repeat(64) }, f.exec), /文案版本已改变/u)
  assert.equal(f.jobs.records.size, 0)
  const submitted = await service.submit({ run_id: f.runId }, f.exec)
  await f.jobs.settled(submitted.jobId)
  f.client.visibleProjectBases = async () => []
  await assert.rejects(service.query(f.runId, f.exec), /当前项目权限/u)
  await assert.rejects(service.submit({ run_id: f.runId }, f.exec), /当前项目权限/u)
  assert.equal(f.jobs.records.size, 1, 'revoked access must not start another job or reuse an export')
  await assertExistingOutputsUnchanged(f)
})

test('a manuscript edit during diagram work stays intact and marks the snapshot output stale', async t => {
  const f = await diagramFixture(), entered = deferred(), release = deferred()
  const service = createDiagramService({ ...f, build: async args => {
    if (args.kind === 'business') { entered.resolve(); await waitControlled(args.signal, release) }
    return localBuild(args)
  }, render: localRender })
  t.after(() => service.close())
  const submitted = await service.submit({ run_id: f.runId }, f.exec)
  await entered.promise
  const changed = structuredClone(f.report)
  changed.sections[0].blocks[0].text += '新增流程仍待客户确认。'
  changed.chapterRecords.solution.version = 2
  const changedBytes = Buffer.from(JSON.stringify(changed))
  await writeFile(path.join(f.dir, 'report.json'), changedBytes)
  release.resolve()
  const completed = await f.jobs.settled(submitted.jobId)
  assert.equal(completed.status, 'completed')
  assert.equal(JSON.parse(completed.output).stale, true)
  const result = await service.query(f.runId, f.exec)
  assert.equal(result.stale, true); assert.match(result.note, /旧版/u)
  await assert.rejects(service.submit({ run_id: f.runId, expected_content_sha256: submitted.sourceContentSha256 }, f.exec), /文案版本已改变/u)
  assert.deepEqual(await readFile(path.join(f.dir, 'report.json')), changedBytes)
  for (const kind of kinds) {
    assert.doesNotMatch(await readFile(result.diagrams[kind].planPath, 'utf8'), /新增流程/u)
  }
  for (const filename of ['run.json', 'delivery.json']) {
    assert.deepEqual(await readFile(path.join(f.dir, filename)), f.originals[filename])
  }
})

test('missing or altered SVGs invalidate the cache and permit an independent replacement export', async t => {
  const f = await diagramFixture()
  const service = createDiagramService({ ...f, build: localBuild, render: localRender })
  t.after(() => service.close())
  const submitted = await service.submit({ run_id: f.runId }, f.exec)
  await f.jobs.settled(submitted.jobId)
  const original = await service.query(f.runId, f.exec)
  await writeFile(original.diagrams.business.path, '<svg>changed</svg>')
  await rename(original.diagrams.product.path, `${original.diagrams.product.path}.missing-fixture`)
  const interrupted = await service.query(f.runId, f.exec)
  assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.diagramsReady, false)
  for (const kind of kinds) {
    assert.equal(interrupted.diagrams[kind].status, 'failed')
    assert.match(interrupted.diagrams[kind].error, /产物缺失或摘要已改变/u)
  }
  const replacement = await service.submit({ run_id: f.runId }, f.exec)
  assert.notEqual(replacement.exportId, submitted.exportId)
  assert.notEqual(replacement.reused, true)
  await f.jobs.settled(replacement.jobId)
  assert.equal((await service.query(f.runId, f.exec)).diagramsReady, true)
  assert.equal(f.jobs.records.size, 2)
  await assertExistingOutputsUnchanged(f)
})

test('missing diagram material does not call the renderer or claim either SVG is ready', async t => {
  const f = await diagramFixture()
  let renders = 0
  const service = createDiagramService({ ...f, build: async ({ snapshot, kind }) => ({ kind,
    sourceContentSha256: snapshot.sourceContentSha256, status: 'needs_input', reason: '没有本类架构相关正文' }),
  render: async () => { renders++; throw new Error('renderer must not run without material') } })
  t.after(() => service.close())
  const submitted = await service.submit({ run_id: f.runId }, f.exec)
  assert.equal((await f.jobs.settled(submitted.jobId)).status, 'failed')
  const result = await service.query(f.runId, f.exec)
  assert.equal(result.diagramsReady, false); assert.equal(renders, 0)
  for (const kind of kinds) {
    assert.equal(result.diagrams[kind].status, 'needs_input')
    assert.match(result.diagrams[kind].reason, /没有本类架构相关正文/u)
  }
  await assertExistingOutputsUnchanged(f)
})

test('closing during authorization cannot admit a later diagram job', async () => {
  const f = await diagramFixture(), entered = deferred(), release = deferred()
  const visible = f.client.visibleProjectBases
  f.client.visibleProjectBases = async (...args) => {
    entered.resolve(); await release.promise; return visible(...args)
  }
  const service = createDiagramService({ ...f, build: localBuild, render: localRender })
  const rejected = assert.rejects(service.submit({ run_id: f.runId }, f.exec), /停止接纳/u)
  await entered.promise
  await service.close()
  release.resolve()
  await rejected
  assert.equal(f.jobs.records.size, 0)
  assert.ok(f.jobs.disposed.has('wlyd-assembly-diagrams'))
  await assertExistingOutputsUnchanged(f)
})

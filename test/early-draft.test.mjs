import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import path from 'node:path'
import { createTaskService } from '../src/tasks.js'
import { chapterAction } from '../src/chapters.js'
import { rootOf, runPath } from '../src/store.js'
import { completeAudit } from './helpers.mjs'
import { taskFixture, deferred, waitControlled, readRecord } from './task-helpers.mjs'

const outline = [
  { key: 'service', title: '业务协作', roleId: 'delivery-service', required: true },
  { key: 'platform', title: '技术支撑', roleId: 'technical-platform', required: true },
]
async function until(read, check) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = await read()
    if (check(value)) return value
    await delay(10)
  }
  assert.fail('未观察到预期检查点')
}
function controlledModel({ slowChapter, slowGate, reviewGate, reviewStarted }) {
  const calls = []
  return { calls, resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }] } }),
    async *stream(request) {
      const prompt = JSON.parse(request.messages[0].content[0].text)
      calls.push(prompt)
      let value
      if (prompt.stage === 'write') {
        if (prompt.chapter.key === slowChapter) await waitControlled(request.signal, slowGate)
        const card = prompt.facts[0]
        value = { facts: [{ id: 'claim-1', text: card.text, sourceCardIds: [card.id], subject: 'product',
          purpose: 'capability', supportMode: 'sourced', capabilityStatus: 'existing', capabilityOwnership: 'unknown' }],
          sections: [{ key: prompt.chapter.key, blocks: [{ text: `可考虑在${prompt.chapter.title}中通过统一记录核对交接责任。`,
            supportMode: 'candidate', factIds: ['claim-1'], planRefs: { capabilityIds: [], scenarioIds: [], problemIds: [], trendIds: [] } }] }] }
      } else if (prompt.stage === 'consistency-review') {
        reviewStarted.resolve()
        await waitControlled(request.signal, reviewGate)
        value = completeAudit()
      } else assert.fail(`unexpected stage: ${prompt.stage}`)
      yield { type: 'text-delta', text: JSON.stringify(value) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
}

test('逐章先交稿且复核仍归同一后台任务；活跃期可读不能改，重复提交不重开', async t => {
  const f = await taskFixture({ outline, quality_mode: 'draft' })
  const slowGate = deferred(), reviewGate = deferred(), reviewStarted = deferred()
  const llm = controlledModel({ slowChapter: 'platform', slowGate, reviewGate, reviewStarted })
  const service = createTaskService({ ...f, llm })
  t.after(() => service.close())
  const submitted = await service.submit(f.args, f.exec)
  const dir = runPath(f.agent, submitted.runId)
  const building = await until(() => service.query(submitted.runId, f.exec), state => state.status === 'draft_building' && state.reportReady)
  assert.ok(building.firstChapterReadyAt)
  assert.equal(building.draftReadyAt, undefined)
  assert.equal(building.finishedAt, undefined)
  const partial = await readRecord(building.jsonPath)
  assert.deepEqual(partial.chapterOutcomes.map(row => row.status), ['draft_unverified', 'pending'])
  assert.match(await readFile(building.reportPath, 'utf8'), /初稿正在逐章生成/u)
  assert.match(await readFile(building.reviewPath, 'utf8'), /正在生成/u)
  const list = await chapterAction({ ...f, llm, args: { run_id: submitted.runId, action: 'list' } })
  assert.equal(list.status, 'draft_building')
  assert.equal(list.chapters[1].status, 'pending')
  await assert.rejects(chapterAction({ ...f, llm, args: { run_id: submitted.runId, action: 'comment', chapter_key: 'service', text: '改短' } }), /等待任务结束或取消/u)
  const duplicate = await service.submit(f.args, f.exec)
  assert.equal(duplicate.runId, submitted.runId)
  assert.equal(duplicate.reused, true)
  assert.equal(f.jobs.records.size, 1)
  slowGate.resolve()
  await reviewStarted.promise
  const reviewing = await service.query(submitted.runId, f.exec)
  assert.equal(reviewing.status, 'draft_reviewing')
  assert.equal(reviewing.reportReady, true)
  assert.ok(reviewing.draftReadyAt)
  assert.equal(reviewing.finishedAt, undefined)
  assert.equal(f.jobs.get(submitted.jobId, f.agent).status, 'running')
  const claim = await readRecord(path.join(rootOf(f.agent), '.claims', submitted.runId, 'claim.json'))
  assert.equal(claim.active, true)
  assert.equal((await readRecord(reviewing.jsonPath)).assemblyReview.passed, false)
  assert.equal((await readRecord(path.join(dir, 'evidence.json'))).evidence.some(source => source.kind === 'knowledge'), true)
  assert.match(await readFile(reviewing.reportPath, 'utf8'), /关联复核正在后台/u)
  assert.doesNotMatch(await readFile(reviewing.reportPath, 'utf8'), /合稿复核未通过/u)
  await assert.rejects(chapterAction({ ...f, llm, args: { run_id: submitted.runId, action: 'revise', chapter_key: 'service', expected_version: 1, instruction: '改短' } }), /等待任务结束或取消/u)
  reviewGate.resolve()
  assert.equal((await f.jobs.settled(submitted.jobId)).status, 'completed')
  const finished = await service.query(submitted.runId, f.exec)
  assert.equal(finished.status, 'draft_ready')
  assert.ok(finished.finishedAt)
  assert.equal((await readRecord(path.join(rootOf(f.agent), '.claims', submitted.runId, 'claim.json'))).active, false)
})

test('复核中取消仍保留已交初稿；恢复复用章节并接续复核', async t => {
  const f = await taskFixture({ outline, quality_mode: 'draft' })
  const reviewGate = deferred(), reviewStarted = deferred()
  const llm = controlledModel({ reviewGate, reviewStarted })
  const service = createTaskService({ ...f, llm })
  t.after(() => service.close())
  const submitted = await service.submit(f.args, f.exec)
  await reviewStarted.promise
  const before = await service.query(submitted.runId, f.exec)
  const report = await readRecord(before.jsonPath)
  const writes = llm.calls.filter(prompt => prompt.stage === 'write').length
  assert.equal((await service.cancel(submitted.runId, f.exec)).status, 'cancelling')
  assert.equal((await f.jobs.settled(submitted.jobId)).status, 'killed')
  const cancelled = await service.query(submitted.runId, f.exec)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.reportReady, true)
  assert.equal(cancelled.reportPath, before.reportPath)
  const retained = await readRecord(cancelled.jsonPath)
  assert.deepEqual(retained.sections, report.sections)
  assert.equal(retained.assemblyReview.passed, false)
  assert.equal(retained.assemblyReview.status, 'cancelled')
  assert.match(await readFile(cancelled.reportPath, 'utf8'), /已交初稿保留/u)
  assert.equal((await readRecord(path.join(rootOf(f.agent), '.claims', submitted.runId, 'claim.json'))).active, false)
  const listed = await chapterAction({ ...f, llm, args: { run_id: submitted.runId, action: 'list' } })
  assert.equal(listed.chapters.length, 2)
  reviewGate.resolve()
  const resumed = await service.submit({ mode: 'resume', run_id: submitted.runId }, f.exec)
  assert.equal(resumed.runId, submitted.runId)
  assert.equal((await f.jobs.settled(resumed.jobId)).status, 'completed')
  const final = await service.query(submitted.runId, f.exec)
  assert.equal(final.status, 'draft_ready')
  assert.equal(llm.calls.filter(prompt => prompt.stage === 'write').length, writes)
  assert.deepEqual((await readRecord(final.jsonPath)).sections, report.sections)
  assert.ok(final.chapters.every(chapter => chapter.reusedChapter))
})

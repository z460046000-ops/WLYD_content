import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { createTaskService } from '../src/tasks.js'
import { loadDraftCheckpoint, draftBinding } from '../src/content/draft-checkpoint.js'
import { loadRules } from '../src/rules.js'
import { runPath } from '../src/store.js'
import { completeAudit } from './helpers.mjs'
import { taskFixture, readRecord, deferred, waitControlled } from './task-helpers.mjs'

const node = { key: 'service', title: '业务协作', roleId: 'delivery-service', required: true }
const cases = { key: 'cases', title: '合作案例', roleId: 'customer-cases', required: false }
function response(prompt, texts = ['可考虑通过统一记录核对交接责任。']) {
  return { facts: [{ id: 'claim-1', text: '统一记录支撑业务交接。', sourceCardIds: [prompt.facts[0].id],
    subject: 'product', purpose: 'capability', supportMode: 'sourced' }],
    sections: [{ key: prompt.chapter.key, blocks: texts.map(text => ({ text, supportMode: 'candidate', factIds: ['claim-1'],
      planRefs: { capabilityIds: [], scenarioIds: [], problemIds: [], trendIds: [] } })) }] }
}
function model(write) {
  const calls = []
  return { calls, resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }] } }),
    async *stream(request) {
      const prompt = JSON.parse(request.messages[0].content[0].text)
      calls.push(prompt)
      if (prompt.stage === 'write') { yield* write(prompt, request); return }
      assert.equal(prompt.stage, 'consistency-review')
      yield { type: 'text-delta', text: JSON.stringify(completeAudit()) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
}
async function* ok(prompt, texts) {
  yield { type: 'text-delta', text: JSON.stringify(response(prompt, texts)) }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
async function setup(t, outline = [node], write = prompt => ok(prompt)) {
  const f = await taskFixture({ outline, quality_mode: 'draft' })
  const llm = model(write), service = createTaskService({ ...f, llm })
  t.after(() => service.close())
  return { ...f, llm, service }
}
async function submit(f, args = f.args) {
  const accepted = await f.service.submit(args, f.exec)
  const job = await f.jobs.settled(accepted.jobId)
  return { ...accepted, job, dir: runPath(f.agent, accepted.runId) }
}

test('两批先成功后截断：保存完整事实和正文，resume仅重试失败批、不重检索、不重复首批', async t => {
  let writes = 0, queries = 0, cut
  const f = await setup(t, [node], async function* (prompt) {
    writes++
    if (writes === 2) {
      const raw = response(prompt, ['建议核对第二批的交接信息。'])
      cut = JSON.stringify(raw).slice(0, -2) + ',{"text":"未完'
      yield { type: 'text-delta', text: cut }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    } else yield* ok(prompt, writes === 1 ? ['建议先明确第一批的交接责任。']
      : ['建议核对第二批的交接信息。', '建议补充第二批的责任确认步骤。'])
  })
  f.client.search = async () => { queries++; return [{ chunk_id: 'LONG', knowledge_id: 'D1', content: '业务线索统一维护，销售和客服核对交接责任。'.repeat(440) }] }
  const first = await submit(f), chapterDir = path.join(first.dir, 'chapters/service')
  const checkpoint = await readRecord(path.join(chapterDir, 'draft-checkpoint.json'))
  assert.equal(checkpoint.batches.length, 2)
  assert.deepEqual(checkpoint.batches.map(row => row.outputs[0].status), ['completed', 'partial'])
  const report = await readRecord(path.join(first.dir, 'report.json'))
  assert.equal(report.reviewStatus, 'partial_draft')
  assert.equal(report.contentCoverage.contentStatus, 'partial')
  assert.equal(report.sections[0].blocks.length, 2)
  assert.ok(report.sections[0].blocks[1].evidence.length, '截断前完整事实仍能为完整段落补来源')
  assert.ok((await readRecord(path.join(chapterDir, 'cards.json'))).cards.length >= 2)
  const original = await readFile(path.join(chapterDir, 'attempts/0/batch-2.partial.txt'), 'utf8')
  assert.equal(original, cut)
  const rawBefore = await readFile(path.join(chapterDir, 'draft-2.json'), 'utf8'), count = queries
  const resumed = await submit(f, { mode: 'resume', run_id: first.runId })
  assert.equal(resumed.job.status, 'completed')
  assert.equal(queries, count, '完成批及有效归档证据不重新查询')
  assert.equal(writes, 3, '只多调用第二批')
  const state = await f.service.query(first.runId, f.exec), after = await readRecord(state.jsonPath)
  assert.equal(state.chapters[0].reusedBatches, 1)
  assert.equal(after.contentCoverage.contentStatus, 'complete')
  assert.equal(after.sections[0].blocks.length, 3)
  assert.deepEqual(after.sections[0].blocks[0], report.sections[0].blocks[0])
  assert.equal(after.sections[0].blocks.filter(block => block.text.includes('第二批的交接信息')).length, 1)
  assert.equal(await readFile(path.join(chapterDir, 'draft-2.json'), 'utf8'), rawBefore)
  assert.equal(await readFile(path.join(chapterDir, 'attempts/0/batch-2.partial.txt'), 'utf8'), original)
  assert.ok((await readFile(path.join(chapterDir, 'attempts/1/batch-2.json'), 'utf8')).length)
  await submit(f, { mode: 'resume', run_id: first.runId })
  assert.equal(writes, 3); assert.equal(queries, count)
})

test('完成章和真实用途不符的无案例待补章都在检索前复用，版本与原文不变', async t => {
  const f = await setup(t, [node, cases])
  const first = await submit(f), before = await readRecord(path.join(first.dir, 'report.json'))
  assert.deepEqual(before.chapterOutcomes.map(row => row.status), ['draft_unverified', 'needs_input'])
  const writes = f.llm.calls.filter(row => row.stage === 'write').length
  f.client.search = async () => { assert.fail('不应重新检索完成章或用途不符待补章') }
  await submit(f, { mode: 'resume', run_id: first.runId })
  const state = await f.service.query(first.runId, f.exec), after = await readRecord(state.jsonPath)
  assert.equal(f.llm.calls.filter(row => row.stage === 'write').length, writes)
  assert.deepEqual(after.sections, before.sections)
  assert.ok(state.chapters.every(row => row.reusedChapter && row.version === 1 && row.knowledgeQueries === 0))
  assert.equal(state.chapters[1].reusedNeedsInput, true)
})

test('检查点绑定规划、规则、材料、模型和当前授权；哈希/窗口篡改不能跳过批次', async t => {
  const f = await setup(t), first = await submit(f), chapterDir = path.join(first.dir, 'chapters/service')
  const state = await readRecord(path.join(first.dir, 'run.json')), rules = await loadRules('presales-solution')
  const input = await readRecord(path.join(first.dir, 'run-input.json'))
  const options = { args: input.args, rules, outline: input.document.outline, node: input.document.outline[0], plan: input.document.plan, state }
  const bindingSha256 = draftBinding(options)
  const { evidence } = await readRecord(path.join(first.dir, 'evidence.json'))
  const params = { chapterDir, bindingSha256, evidence, attempt: 1 }
  assert.ok((await loadDraftCheckpoint(params)).batches.every(batch => batch.completed))
  for (const changed of [
    { ...options, args: { ...options.args, plan_sha256: 'changed' } },
    { ...options, rules: { ...rules, fingerprint: 'changed' } },
    { ...options, state: { ...state, materialSha256: 'changed' } },
    { ...options, state: { ...state, modelSelection: { provider: 'other', model: 'other' } } },
  ]) assert.equal(await loadDraftCheckpoint({ ...params, bindingSha256: draftBinding(changed) }), null)
  assert.equal(await loadDraftCheckpoint({ ...params, evidence: evidence.filter(row => row.kind !== 'knowledge') }), null)
  const manifestFile = path.join(chapterDir, 'draft-checkpoint.json'), manifest = await readRecord(manifestFile)
  const changedSource = structuredClone(manifest); changedSource.sources[0].sha256 = 'invalid'
  await writeFile(manifestFile, JSON.stringify(changedSource))
  assert.equal(await loadDraftCheckpoint(params), null)
  const failedRetrieval = structuredClone(manifest); failedRetrieval.retrieval.diagnostics.failedQueries = 1
  await writeFile(manifestFile, JSON.stringify(failedRetrieval))
  assert.equal(await loadDraftCheckpoint(params), null, '原检索部分失败须重新取材，不能冻结为完整证据')
  const changedWindow = structuredClone(manifest); changedWindow.batches[0].sourceCardIds = ['s-not-in-source']
  await writeFile(manifestFile, JSON.stringify(changedWindow))
  assert.equal((await loadDraftCheckpoint(params)).batches[0].completed, false)
  await writeFile(manifestFile, JSON.stringify(manifest))
  await writeFile(path.join(chapterDir, manifest.batches[0].outputs[0].rawPath), '{"facts":[]}')
  assert.equal((await loadDraftCheckpoint(params)).batches[0].completed, false)
})

test('写作中取消保存完整部分输出；接续原批次恢复来源并保留首段', async t => {
  const started = deferred(), gate = deferred(); let interrupt = true, cut
  const f = await setup(t, [node], async function* (prompt, request) {
    if (!interrupt) { yield* ok(prompt, ['建议保留已完成的交接段落。', '建议补充责任确认。']); return }
    const raw = response(prompt, ['建议保留已完成的交接段落。'])
    cut = JSON.stringify(raw).slice(0, -2) + ',{"text":"未完成'
    yield { type: 'text-delta', text: cut }
    started.resolve(); await waitControlled(request.signal, gate)
  })
  const accepted = await f.service.submit(f.args, f.exec)
  await started.promise
  await f.service.cancel(accepted.runId, f.exec)
  assert.equal((await f.jobs.settled(accepted.jobId)).status, 'killed')
  const dir = runPath(f.agent, accepted.runId), chapterDir = path.join(dir, 'chapters/service')
  assert.equal(await readFile(path.join(chapterDir, 'attempts/0/batch-1.partial.txt'), 'utf8'), cut)
  assert.equal((await readRecord(path.join(chapterDir, 'writing-partial.json'))).sections[0].blocks.length, 1)
  assert.ok((await readRecord(path.join(chapterDir, 'cards.json'))).cards.length)
  interrupt = false
  f.client.search = async () => { assert.fail('取消后合法检查点应复用取材') }
  const resumed = await submit(f, { mode: 'resume', run_id: accepted.runId })
  assert.equal(resumed.job.status, 'completed')
  const report = await readRecord(path.join(dir, 'report.json'))
  assert.equal(report.sections[0].blocks.length, 2)
  assert.ok(report.sections[0].blocks.every(block => block.evidence.length))
})

test('旧版无批次检查点时保守重新提写，但新失败不抹掉已核验正文', async t => {
  let fail = false
  const f = await setup(t, [node], async function* (prompt) {
    if (fail) throw new Error('模拟底层模型不可用')
    yield* ok(prompt)
  })
  const first = await submit(f), chapterDir = path.join(first.dir, 'chapters/service')
  // A legacy partially written run has no new checkpoint. Keep the original manifest as a test archive.
  await rename(path.join(chapterDir, 'draft-checkpoint.json'), path.join(chapterDir, 'new-checkpoint-archive.json'))
  const reportPath = path.join(first.dir, 'report.json'), report = await readRecord(reportPath)
  report.chapterOutcomes[0].status = 'partial'; report.chapterOutcomes[0].diagnostics.modelFailures = 1
  await writeFile(reportPath, JSON.stringify(report))
  fail = true; let queries = 0
  const search = f.client.search; f.client.search = async (...args) => { queries++; return search(...args) }
  await submit(f, { mode: 'resume', run_id: first.runId })
  const after = await readRecord(reportPath)
  assert.ok(queries > 0, '旧版失败批无有效清单仍重新取材')
  assert.equal(after.sections[0].blocks.length, 1)
  assert.deepEqual(after.sections[0].blocks[0], report.sections[0].blocks[0])
  assert.equal(after.contentCoverage.contentStatus, 'partial')
})

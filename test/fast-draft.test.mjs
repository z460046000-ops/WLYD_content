import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { createTaskService } from '../src/tasks.js'
import { chapterAction } from '../src/chapters.js'
import { factCards, attachCardEvidence, partialProse } from '../src/fact-cards.js'
import { runPath } from '../src/store.js'
import { taskFixture, readRecord } from './task-helpers.mjs'
import { completeAudit } from './helpers.mjs'

const outline = [
  { key: 'service', title: '协作服务', roleId: 'delivery-service', required: true },
  { key: 'platform', title: '技术支撑', roleId: 'technical-platform', required: true },
  { key: 'company', title: '企业介绍', roleId: 'company-profile', required: true },
]
function fakeModel({ invalid = false, extractFail = false, writeFail = false } = {}) {
  const calls = []
  return { calls, resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }] } }),
    async *stream(request) {
      const prompt = JSON.parse(request.messages[0].content[0].text)
      calls.push(prompt)
      let value
      if (prompt.stage === 'extract') {
        if (extractFail) throw new Error('提取服务不可用')
        value = { facts: prompt.evidence.map(source => ({ text: source.content, subject: 'product', purpose: 'capability',
          evidence: [{ id: source.id, quote: source.content }] })) }
      } else if (prompt.stage === 'write') {
        if (writeFail) {
          yield { type: 'text-delta', text: '{"sections":[{"blocks":[{"text":"可考虑通过统一记录核对交接责任。"},' }
          yield { type: 'finish', reason: { kind: 'max-tokens' } }
          return
        }
        value = { sections: [{ key: prompt.chapter.key, blocks: [{
          text: invalid ? '该能力已经全面交付并提升80%效率。' : prompt.instruction ? '可考虑按用户要求简化交接责任核对。' : '可考虑通过统一记录核对交接责任。',
          supportMode: invalid ? 'sourced' : 'candidate', factIds: invalid ? ['missing-card'] : [prompt.facts[0]?.id],
          planRefs: { capabilityIds: [], scenarioIds: [], problemIds: [], trendIds: [] },
        }] }] }
      } else if (prompt.stage === 'consistency-review') {
        value = completeAudit()
        value.checks[0].status = 'needs_review'; value.checks[0].reason = '需要人工确认问题与方案'; value.repairNeeded = true
      } else assert.fail(`unexpected stage ${prompt.stage}`)
      yield { type: 'text-delta', text: JSON.stringify(value) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
}
async function draftFixture(t, options = {}, modelOptions = {}) {
  const f = await taskFixture({ outline, quality_mode: 'draft', ...options })
  const llm = fakeModel(modelOptions), service = createTaskService({ ...f, llm })
  t.after(() => service.close())
  const submitted = await service.submit(f.args, f.exec)
  const job = await f.jobs.settled(submitted.jobId)
  assert.equal(job.status, 'completed')
  return { ...f, llm, service, runId: submitted.runId, result: JSON.parse(job.output),
    dir: runPath(f.agent, submitted.runId) }
}

test('事实卡引用由程序补回逐字引文；未知卡不伪造来源；中断正文只提取完整文本字段', () => {
  const cards = factCards([{ text: '统一记录', supportMode: 'sourced', evidence: [{ id: 'K1', quote: '产品支持统一记录' }] }])
  assert.deepEqual(attachCardEvidence({ factIds: [cards[0].id] }, cards).evidence, cards[0].evidence)
  const bad = attachCardEvidence({ factIds: ['fake'], evidence: [{ id: 'FAKE' }] }, cards)
  assert.deepEqual(bad.evidence, [])
  assert.equal(bad.referenceWarnings.length, 1)
  assert.equal(partialProse('{"text":"已完成一句正文。","other":"尚未完').length, 1)
})

test('默认快速初稿每章有产物；错误引用和数字带标注保留，缺企业事实给材料卡，首稿没有修正和全景调用', async t => {
  const f = await draftFixture(t, {}, { invalid: true })
  assert.equal(f.result.status, 'draft_ready')
  const report = await readRecord(f.result.jsonPath)
  assert.equal(report.qualityMode, 'draft')
  assert.equal(report.sections.length, 3)
  assert.deepEqual(report.chapterOutcomes.map(row => row.status), ['draft_unverified', 'draft_unverified', 'needs_input'])
  assert.ok(report.sections[0].blocks[0].text.includes('【未验证】'))
  assert.ok(report.sections[0].blocks[0].text.includes('80%'))
  assert.deepEqual(report.sections[0].blocks[0].evidence, [])
  assert.ok(report.sections[2].inputNeeded.questions.length)
  assert.equal(report.assemblyReview.passed, false)
  assert.equal(f.llm.calls.filter(call => call.stage === 'write').length, 2)
  assert.ok(!f.llm.calls.some(call => ['relationship-repair', 'panorama-enrichment'].includes(call.stage)))
  const text = await readFile(f.result.reportPath, 'utf8')
  assert.match(text, /企业介绍/u); assert.match(text, /待补材料/u); assert.match(text, /未验证/u)
  const state = await f.service.query(f.runId, f.exec)
  assert.equal(state.progress.pending, 0); assert.equal(state.progress.needsInput, 1)
})

test('提取失败不反复修正，使用明确原文选段；写作截断保留完整段并标记未验证', async t => {
  const f = await draftFixture(t, { outline: [outline[0]] }, { extractFail: true, writeFail: true })
  const report = await readRecord(f.result.jsonPath)
  assert.equal(report.sections[0].blocks.length, 1)
  assert.match(report.sections[0].blocks[0].text, /【未验证】/u)
  assert.equal(f.llm.calls.filter(call => call.stage === 'extract').length, 1)
  assert.equal(f.llm.calls.filter(call => call.stage === 'write').length, 1)
  const extraction = await readRecord(path.join(f.dir, 'chapters/service/extraction.json'))
  assert.equal(extraction.batches[0].status, 'source_excerpt')
})

test('standard 只修正一次，仍有问题保留带标注初稿', async t => {
  const f = await draftFixture(t, { outline: [outline[0]], quality_mode: 'standard' }, { invalid: true })
  assert.equal(f.llm.calls.filter(call => call.stage === 'write').length, 2)
  assert.equal(f.result.status, 'draft_ready')
  assert.match((await readRecord(f.result.jsonPath)).sections[0].blocks[0].text, /未验证/u)
})

test('公开生成入口省略质量参数时使用draft；相同规划不同质量模式不共用任务', async t => {
  const f = await taskFixture({ outline: [outline[0]] }), llm = fakeModel()
  const service = createTaskService({ ...f, llm })
  t.after(() => service.close())
  const { quality_mode, ...args } = f.args
  const fast = await service.submit(args, f.exec)
  await f.jobs.settled(fast.jobId)
  assert.equal((await readRecord(path.join(runPath(f.agent, fast.runId), 'report.json'))).qualityMode, 'draft')
  const strict = await service.submit(f.args, f.exec)
  await f.jobs.settled(strict.jobId)
  assert.notEqual(strict.runId, fast.runId)
})

test('章节评论追问与解决不调用模型；修改只影响指定章，保留版本；过期版本和无确认定稿拒绝', async t => {
  const f = await draftFixture(t)
  const call = args => chapterAction({ client: f.client, llm: f.llm, exec: f.exec, args: { run_id: f.runId, ...args } })
  const before = await readRecord(f.result.jsonPath), calls = f.llm.calls.length
  const comment = await call({ action: 'comment', chapter_key: 'service', text: '改短一些' })
  await call({ action: 'question', chapter_key: 'service', text: '谁核对交接责任？' })
  await call({ action: 'resolve', chapter_key: 'service', note_id: comment.chapter.notes[0].id, text: '下版处理' })
  assert.equal(f.llm.calls.length, calls)
  const revised = await call({ action: 'revise', chapter_key: 'service', expected_version: 1, instruction: '缩短，强调责任核对' })
  assert.equal(revised.chapter.version, 2)
  const after = await readRecord(f.result.jsonPath)
  assert.deepEqual(after.sections.filter(row => row.key !== 'service'), before.sections.filter(row => row.key !== 'service'))
  assert.deepEqual(after.chapterOutcomes.filter(row => row.key !== 'service'), before.chapterOutcomes.filter(row => row.key !== 'service'))
  assert.equal(f.llm.calls.filter(call => call.stage === 'write').length, 3)
  const v1 = await readRecord(path.join(f.dir, 'chapters/service/versions/1.json'))
  assert.deepEqual(v1.section, before.sections[0])
  await assert.rejects(call({ action: 'revise', chapter_key: 'service', expected_version: 1, instruction: '过期修改' }), /版本已改变/u)
  await assert.rejects(call({ action: 'approve', chapter_key: 'service', expected_version: 2 }), /明确确认/u)
  const approved = await call({ action: 'approve', chapter_key: 'service', expected_version: 2, confirmed: true })
  assert.equal(approved.chapter.approvalStatus, 'approved')
  await assert.rejects(call({ action: 'revise', chapter_key: 'service', expected_version: 2, instruction: '再改' }), /已定稿/u)
  await call({ action: 'reopen', chapter_key: 'service', expected_version: 2, confirmed: true })
  await assert.rejects(call({ action: 'approve', chapter_key: 'company', expected_version: 1, confirmed: true }), /材料卡/u)
  const restricted = { ...f.client, visibleProjectBases: async () => [] }
  await assert.rejects(chapterAction({ client: restricted, llm: f.llm, exec: f.exec, args: {
    run_id: f.runId, action: 'revise', chapter_key: 'service', expected_version: 2, instruction: '再改' } }), /当前项目权限/u)
  const resumed = await f.service.submit({ mode: 'resume', run_id: f.runId }, f.exec)
  await f.jobs.settled(resumed.jobId)
  const latest = await call({ action: 'list' })
  assert.equal(latest.chapters[0].version, 2)
  assert.equal(latest.chapters[0].notes.length, 2)
  assert.equal(latest.chapters[2].version, 2)
  assert.deepEqual(latest.chapters[0].blocks, revised.chapter.blocks)
})

test('修改服务失败时原章节和版本不变；段落范围修改保留其他段落内容和引用', async t => {
  const f = await draftFixture(t, { outline: [outline[0]] })
  const args = { run_id: f.runId, action: 'revise', chapter_key: 'service', expected_version: 1, instruction: '改短', block_ids: ['service-1'] }
  const before = await readRecord(f.result.jsonPath)
  const failed = { async *stream() { throw new Error('暂不可用') } }
  await assert.rejects(chapterAction({ client: f.client, llm: failed, exec: f.exec, args }), /暂不可用/u)
  assert.deepEqual((await readRecord(f.result.jsonPath)).sections, before.sections)
  const revised = await chapterAction({ client: f.client, llm: f.llm, exec: f.exec, args })
  assert.equal(revised.chapter.version, 2)
  assert.equal(revised.chapter.blocks[0].id, 'service-2')
  assert.ok(revised.chapter.blocks[0].evidence.every(ref => before.sections[0].blocks[0].evidence.some(old => old.id === ref.id && old.quote === ref.quote)))
})

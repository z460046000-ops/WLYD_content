import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { coverageFromReport } from '../src/content/coverage.js'
import { createTaskService } from '../src/tasks.js'
import { runPath } from '../src/store.js'
import { taskFixture, readRecord } from './task-helpers.mjs'
import { completeAudit } from './helpers.mjs'

test('2章正文7章待补材料卡只计2/9正文；空白段落不算正文', () => {
  const outline = Array.from({ length: 9 }, (_, i) => ({ key: `chapter-${i}`, title: `章节${i}`, roleId: 'custom' }))
  const report = { outline, sections: outline.map((node, i) => ({ ...node, blocks: i < 2 ? [{ text: '可供阅读的正文。' }] : [{ text: '  ' }],
    ...(i >= 2 ? { inputNeeded: { reason: '尚未完成' } } : {}) })),
    chapterOutcomes: outline.map((node, i) => ({ key: node.key, status: i < 2 ? 'draft_unverified' : 'needs_input' })) }
  const result = coverageFromReport(report)
  assert.equal(result.totalChapters, 9); assert.equal(result.proseChapters, 2); assert.equal(result.needsInputChapters, 7)
  assert.equal(result.blockCount, 2); assert.equal(result.proseRatio, 2 / 9); assert.equal(result.prosePercent, 22.2)
})

test('正文覆盖与运行完成状态分开，分支章节、部分正文、可选省略和待生成均纳入确认目录', () => {
  const report = { outline: [{ key: 'parent', title: '总览', children: [{ key: 'optional', title: '案例', required: false },
    { key: 'pending', title: '正在生成' }, { key: 'failed', title: '未完成' }] }],
    sections: [{ key: 'parent', blocks: [{ text: '保留部分正文。' }] }, { key: 'extra', blocks: [{ text: '目录外不计入。' }] }],
    chapterOutcomes: [{ key: 'parent', status: 'partial' }, { key: 'optional', status: 'omitted' },
      { key: 'pending', status: 'writing' }, { key: 'failed', status: 'failed' }] }
  const result = coverageFromReport(report)
  assert.equal(result.totalChapters, 4); assert.equal(result.proseChapters, 1); assert.equal(result.partialChapters, 1)
  assert.equal(result.omittedChapters, 1); assert.equal(result.pendingChapters, 1); assert.equal(result.failedChapters, 1)
  assert.equal(result.chapterDiagnostics[1].reasonCode, 'omitted')
})

test('不把未知失败推断为知识库缺料，优先使用可追踪的结构化原因', () => {
  const outline = ['zero', 'failure', 'purpose', 'unknown'].map(key => ({ key, title: key }))
  const result = coverageFromReport({ outline, chapterOutcomes: [
    { key: 'zero', status: 'needs_input', diagnostics: { knowledgeHits: 0, successfulQueries: 1 } },
    { key: 'failure', status: 'needs_input', diagnostics: { knowledgeHits: 0, failedQueries: 1 } },
    { key: 'purpose', status: 'needs_input', diagnostics: { reasonCode: 'purpose_mismatch', excludedFacts: 3 } },
    { key: 'unknown', status: 'needs_input' }] })
  assert.deepEqual(result.chapterDiagnostics.map(row => row.reasonCode), ['zero_knowledge_hits', 'retrieval_failed', 'purpose_mismatch', 'no_prose'])
})

const node = { key: 'business', title: '业务情况', roleId: 'business-challenges', required: true }
function model({ purposeMismatch = false, timeout = false, interrupted = false } = {}) {
  return { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }] } }), async *stream(request) {
    const prompt = JSON.parse(request.messages[0].content[0].text)
    if (prompt.stage === 'consistency-review') {
      yield { type: 'text-delta', text: JSON.stringify(completeAudit()) }; yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    if (timeout) throw Object.assign(new Error('upstream timed out'), { code: 'MODEL_STAGE_TIMEOUT' })
    if (interrupted) {
      yield { type: 'text-delta', text: '{"sections":[{"blocks":[{"text":"可考虑通过统一记录核对交接。"},' }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }; return
    }
    const value = { facts: [{ id: 'claim', text: '销售与客服核对同一交接记录。', sourceCardIds: [prompt.facts[0].id],
      subject: purposeMismatch ? 'company' : 'customer', purpose: purposeMismatch ? 'company-profile' : 'business-problem', supportMode: 'sourced' }],
      sections: [{ key: prompt.chapter.key, blocks: [{ text: '可考虑通过统一记录核对销售与客服交接。', factIds: ['claim'], supportMode: 'candidate' }] }] }
    yield { type: 'text-delta', text: JSON.stringify(value) }; yield { type: 'finish', reason: { kind: 'stop' } }
  } }
}
async function run(t, options = {}, configure) {
  const f = await taskFixture({ outline: [node], quality_mode: 'draft' })
  if (configure) configure(f.client)
  const service = createTaskService({ ...f, llm: model(options) }); t.after(() => service.close())
  const submitted = await service.submit(f.args, f.exec)
  assert.equal((await f.jobs.settled(submitted.jobId)).status, options.timeout || options.retrievalFail ? 'failed' : 'completed')
  const dir = runPath(f.agent, submitted.runId), report = await readRecord(path.join(dir, 'report.json'))
  const chapter = await readRecord(path.join(dir, 'chapters/business/chapter.json'))
  return { chapter, report, state: JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8')) }
}

test('生成中区分知识库零命中与检索请求失败，规划锚点不冒充当章新命中', async t => {
  const empty = await run(t, {}, client => { client.search = async () => [] })
  assert.equal(empty.chapter.diagnostics.knowledgeHits, 0)
  assert.ok(empty.chapter.diagnostics.reasonCodes.includes('zero_knowledge_hits'))
  const failed = await run(t, { retrievalFail: true }, client => { client.search = async () => { throw new Error('network unavailable') } })
  assert.equal(failed.chapter.status, 'failed')
  assert.equal(failed.chapter.diagnostics.reasonCode, 'retrieval_failed')
  assert.ok(failed.chapter.diagnostics.failedQueries > 0)
  assert.ok(!failed.chapter.diagnostics.reasonCodes.includes('zero_knowledge_hits'))
})

test('用途不匹配、模型超时和截断可定位；截断仍保留已写正文', async t => {
  const mismatch = await run(t, { purposeMismatch: true })
  assert.equal(mismatch.chapter.status, 'needs_input')
  assert.equal(mismatch.chapter.diagnostics.reasonCode, 'purpose_mismatch')
  assert.ok(mismatch.chapter.diagnostics.excludedFacts > 0)
  const timed = await run(t, { timeout: true })
  assert.equal(timed.chapter.diagnostics.reasonCode, 'model_timeout')
  assert.equal(timed.chapter.diagnostics.modelTimeouts, 1)
  const interrupted = await run(t, { interrupted: true })
  assert.equal(interrupted.chapter.diagnostics.reasonCode, 'model_output_limit')
  assert.equal(interrupted.chapter.status, 'draft_unverified')
  assert.equal(interrupted.chapter.section.blocks.length, 1)
  assert.equal(interrupted.chapter.diagnostics.hasProse, true)
  assert.equal(interrupted.state.chapters[0].diagnostics.reasonCode, 'model_output_limit')
})

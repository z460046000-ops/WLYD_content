import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile, mkdir } from 'node:fs/promises'
import { taskFixture, readRecord } from './task-helpers.mjs'
import { completeAudit } from './helpers.mjs'
import { createTaskService } from '../src/tasks.js'
import { runPath } from '../src/store.js'
import { createSnapshot } from '../src/content/snapshot.js'
import { renderMarkdown } from '../src/outputs/markdown.js'
import { generateFastDraft } from '../src/draft-generation.js'
import { loadRules } from '../src/rules.js'
import { buildPresentation } from '../src/outputs/html-slides/plan.js'

const node = { key: 'service', title: '协作方案', roleId: 'delivery-service', required: true }
async function fixture(t, mode, outline = [node]) {
  const f = await taskFixture({ outline, quality_mode: 'draft' })
  const archived = await readRecord(path.join(runPath(f.agent, f.args.plan_id), 'evidence.json'))
  const knowledgeId = archived.evidence.find(row => row.kind === 'knowledge').id
  const calls = []
  const llm = { resolveModelInfo: f.llm.resolveModelInfo, async *stream(request) {
    const prompt = JSON.parse(request.messages[0].content[0].text); calls.push(prompt)
    let value
    if (prompt.stage === 'consistency-review') value = completeAudit()
    else {
      assert.equal(prompt.stage, 'write')
      const combined = prompt.generationMode === 'retrieve-write'
      if (combined) {
        assert.ok(prompt.facts.every(card => /^s-[a-f\d]{20}$/u.test(card.id)))
        assert.ok(prompt.facts.every(card => card.sourceEvidenceId === undefined && card.evidence === undefined))
        assert.match(prompt.task, /顶层id/u)
        const invalid = mode === 'outside' || mode === 'mixed' && prompt.chapter.key === node.key
        value = { facts: [{ id: 'claim', text: '销售与客服共同核对记录。', subject: 'product', purpose: 'capability', supportMode: 'sourced',
          sourceCardIds: [invalid ? 'K-outside-batch' : mode === 'knowledge-id' ? knowledgeId : prompt.facts[0].id] }],
          sections: [{ key: prompt.chapter.key, blocks: mode.startsWith('empty') ? [] : [{ text: '建议销售和客服依据同一记录核对交接。', factIds: ['claim'], supportMode: 'candidate' }] }] }
      } else {
        assert.match(prompt.instruction, /正文为空/u)
        assert.ok(prompt.facts.every(card => /^f-[a-f\d]{20}$/u.test(card.id)))
        value = { sections: [{ key: prompt.chapter.key, blocks: mode === 'empty-again' ? []
          : [{ text: '建议销售和客服依据同一记录核对交接。', factIds: [prompt.facts[0].id], supportMode: 'candidate' }] }] }
      }
    }
    yield { type: 'text-delta', text: JSON.stringify(value) }; yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const tasks = createTaskService({ ...f, llm }); t.after(() => tasks.close())
  const submitted = await tasks.submit(f.args, f.exec), job = await f.jobs.settled(submitted.jobId)
  const dir = runPath(f.agent, submitted.runId), report = await readRecord(path.join(dir, 'report.json'))
  const chapter = await readRecord(path.join(dir, 'chapters', node.key, 'chapter.json'))
  return { ...f, calls, job, dir, report, chapter, state: await readRecord(path.join(dir, 'run.json')) }
}

test('真实流水线接受本批唯一K编号，保留原始响应与归一化审计，不增加模型调用', async t => {
  const f = await fixture(t, 'knowledge-id')
  assert.equal(f.job.status, 'completed'); assert.equal(f.report.contentCoverage.contentStatus, 'complete')
  assert.equal(f.chapter.section.blocks.length, 1); assert.ok(f.chapter.section.blocks[0].evidence.length)
  assert.equal(f.chapter.diagnostics.referenceIdRepairs, 1); assert.equal(f.chapter.diagnostics.recoveryAttempts, 0)
  assert.equal(f.calls.filter(x => x.stage === 'write').length, 1)
  const extraction = await readRecord(path.join(f.dir, 'chapters/service/extraction.json'))
  assert.equal(extraction.batches[0].referenceAudit.normalized.length, 1)
  const raw = await readRecord(path.join(f.dir, 'chapters/service/draft-1.json'))
  assert.ok(raw.facts[0].sourceCardIds[0].startsWith('K'))
  const request = f.state.modelRequests.find(x => x.generationMode === 'retrieve-write')
  assert.equal(request.evidenceIds.length, 1); assert.ok(request.evidenceCharacters > 0)
})

test('有已核验卡但无正文只补写本章一次，正文引用真实卡片', async t => {
  const f = await fixture(t, 'empty-once')
  assert.equal(f.job.status, 'completed'); assert.equal(f.chapter.section.blocks.length, 1)
  assert.equal(f.chapter.diagnostics.recoveryAttempts, 1); assert.equal(f.chapter.diagnostics.recoveredBlocks, 1)
  assert.equal(f.calls.filter(x => x.stage === 'write').length, 2)
  assert.ok(f.chapter.section.blocks[0].evidence.length)
  assert.ok((await readRecord(path.join(f.dir, 'chapters/service/cards.json'))).cards.length)
})

test('补写再次为空不循环；故障和材料缺失分开，保留报告和卡池', async t => {
  const f = await fixture(t, 'empty-again')
  assert.equal(f.calls.filter(x => x.stage === 'write').length, 2)
  assert.equal(f.job.status, 'failed'); assert.equal(f.state.status, 'failed')
  assert.equal(f.chapter.status, 'failed'); assert.equal(f.chapter.section.inputNeeded.kind, 'generation_error')
  assert.equal(f.report.contentCoverage.contentStatus, 'empty'); assert.equal(f.report.contentCoverage.needsInputChapters, 0)
  assert.equal(f.report.contentCoverage.failedChapters, 1)
  assert.match(renderMarkdown(createSnapshot(f.report)), /\*\*生成故障\*\*/u)
  assert.match(await readFile(path.join(f.dir, 'report.md'), 'utf8'), /生成故障/u)
  assert.ok((await readRecord(path.join(f.dir, 'chapters/service/cards.json'))).cards.length)
})

test('批外K编号不能扩大来源；故障章不拖垮已有正文，整体标部分稿', async t => {
  const f = await fixture(t, 'mixed', [node, { ...node, key: 'other', title: '其他协作' }])
  assert.equal(f.state.status, 'partial_draft'); assert.equal(f.report.contentCoverage.contentStatus, 'partial')
  assert.equal(f.report.contentCoverage.proseChapters, 1); assert.equal(f.report.contentCoverage.failedChapters, 1)
  assert.equal(f.report.sections.find(x => x.key === 'other').blocks.length, 1)
  assert.equal(f.chapter.diagnostics.reasonCode, 'reference_id_mismatch')
  assert.equal(f.chapter.diagnostics.referenceIdRejectedFacts, 1)
  assert.deepEqual(f.chapter.diagnostics.referenceExamples, ['K-outside-batch'])
  assert.equal(f.calls.filter(x => x.stage === 'write').length, 2)
})

test('检索失败且无锚点是故障，不能计为缺材料；HTML同样显示故障', async () => {
  const f = await taskFixture({ outline: [node], quality_mode: 'draft' }), rules = await loadRules('presales-solution')
  const dir = path.join(f.cwd, 'no-sources'); await mkdir(dir)
  let writes = 0
  const llm = { resolveModelInfo: f.llm.resolveModelInfo, async *stream(request) {
    const prompt = JSON.parse(request.messages[0].content[0].text)
    if (prompt.stage === 'write') writes++
    yield { type: 'text-delta', text: JSON.stringify(completeAudit()) }; yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const state = {}, retrieval = { forChapter: async () => [], chapterKnowledgeHits: () => [], chapterKnowledgeQueries: () => 1,
    coverage: [{ status: 'failed' }], issues: ['模拟检索故障'] }
  const result = await generateFastDraft({ llm, exec: f.exec, args: f.args, rules, outline: [node], evidence: [], dir,
    state, saveState: async () => {}, retrieval, acceptedPlan: { title: '测试稿', capabilities: [], problems: [], trends: [], scenarios: [] } })
  assert.equal(state.chapters[0].status, 'failed'); assert.equal(result.sections[0].inputNeeded.kind, 'generation_error')
  assert.equal(writes, 0)
  const snapshot = createSnapshot({ ...result, runId: 'test-run', chapterOutcomes: state.chapters })
  const plan = await buildPresentation({ snapshot })
  assert.equal(plan.slides[0].status, 'failed'); assert.ok(plan.slides[0].boundaries.includes('生成故障'))
  assert.ok(!plan.slides[0].boundaries.includes('待补材料'))
})

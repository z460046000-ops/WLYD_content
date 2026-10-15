import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import os from 'node:os'
import path from 'node:path'
import { generateChapters, normalizePlan, applyPlanTitles, contentBalance } from '../src/generation.js'
import { loadRules, flattenOutline, applyModes, requestedModes } from '../src/rules.js'
import { validateDraft, reportText } from '../src/content.js'
import { askModel } from '../src/model.js'
import { createLimiter, mapConcurrent } from '../src/scheduler.js'
import { assemble, status } from '../src/workflow.js'

const evidence = [{ id: 'M1-1', content: '产品支持统一维护线索状态，销售和客服可查看同一记录。' }]
const ref = { id: 'M1-1', quote: '产品支持统一维护线索状态' }
const agent = { options: { provider: 'fake', model: 'fake' } }
const plan = {
  title: '线索协作方案', businessMode: { value: 'needs-challenges' }, trendFramework: { value: 'management-business-technology' },
  capabilities: [{ id: 'cap-1', text: '统一线索记录', evidence: [ref] }],
  problems: [{ id: 'problem-1', text: '如果分开记录可能交接不清', scope: 'customer' }],
  trends: [{ id: 'trend-1', text: '可关注协作衔接' }],
  scenarios: [{ id: 'scenario-1', title: '跨团队线索交接', capabilityIds: ['cap-1'], problemIds: ['problem-1'], trendIds: ['trend-1'] }],
  chapterGuidance: [{ key: 'business-challenges', title: '业务运行情况', focus: '解释业务运行流程' },
    { key: 'policy-trends', title: '外部环境与建设方向' }, { key: 'scenarios', title: '协作场景落地路径' }],
}
const blockFor = chapter => ({ id: `${chapter.key}-7`, text: '可考虑以统一线索记录衔接销售和客服的业务动作。',
  supportMode: 'candidate', evidence: [], ...(chapter.framework ? { dimension: '技术' } : {}),
  planRefs: { capabilityIds: ['cap-1'], scenarioIds: ['scenario-1'], problemIds: ['problem-1'], trendIds: ['trend-1'] } })
const answerFor = prompt => prompt.stage === 'plan' ? plan
  : prompt.stage === 'extract' ? { facts: [{ text: evidence[0].content, evidence: [ref] }], writingOutline: [] }
  : prompt.stage === 'panorama-enrichment' ? { additions: [], reviewItems: [] }
  : prompt.stage === 'consistency-review' ? { reviewItems: ['请业务负责人核对场景适用性'] }
  : { sections: [{ key: prompt.chapter.key, blocks: [blockFor(prompt.chapter)] }], gaps: ['对应关系待核对'] }
function fakeModel(handle = answerFor) {
  return { async *stream(request) {
    const answer = await handle(JSON.parse(request.messages[0].content[0].text), request.signal)
    yield { type: 'text-delta', text: JSON.stringify(answer) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
}
async function fixture(llm, args = {}, signal = new AbortController().signal) {
  const rules = await loadRules()
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wlyd-chapters-'))
  const state = {}
  const snapshots = []
  const options = { llm, exec: { agent, signal }, args, rules, outline: rules.template.sections, evidence, dir, state,
    saveState: async () => { snapshots.push(structuredClone(state)) } }
  return { options, snapshots, dir, state }
}

test('四条章节流水线共享规划、原文与模型额度，乱序完成仍按目录合稿，单章错误只重试该章', async () => {
  let active = 0, peak = 0, extractionFailures = 0, writeFailures = 0
  const calls = []
  const f = await fixture(fakeModel(async prompt => {
    calls.push({ stage: prompt.stage, key: prompt.chapter?.key })
    assert.deepEqual(prompt.evidence, evidence)
    active++; peak = Math.max(peak, active)
    try {
      await delay(prompt.chapter?.key === 'policy-trends' ? 20 : 4)
      if (prompt.stage === 'extract' && prompt.chapter.key === 'technical-platform' && !extractionFailures++) throw new Error('temporary extract failure')
      if (prompt.stage === 'write' && prompt.chapter.key === 'solution' && !writeFailures++) throw new Error('temporary write failure')
      if (prompt.stage === 'write') {
        assert.ok(prompt.extraction.facts.length)
        assert.equal(prompt.plan.choices.businessMode.value, 'current-state')
        assert.equal(prompt.plan.choices.trendFramework.value, 'pest')
      }
      return answerFor(prompt)
    } finally { active-- }
  }), { business_mode: 'current-state', trend_framework: 'pest' })
  const result = await generateChapters(f.options)
  assert.equal(peak, 4)
  assert.equal(calls[0].stage, 'plan')
  assert.equal(calls.at(-1).stage, 'consistency-review')
  const nodes = flattenOutline(f.options.outline)
  assert.deepEqual(result.sections.map(s => s.key), nodes.map(n => n.key))
  for (const node of nodes) {
    const stages = calls.filter(call => call.key === node.key).map(call => call.stage)
    assert.ok(stages.indexOf('write') > stages.indexOf('extract'))
    assert.equal(stages.filter(s => s === 'extract').length, node.key === 'technical-platform' ? 2 : 1)
    assert.equal(stages.filter(s => s === 'write').length, node.key === 'solution' ? 2 : 1)
    const file = JSON.parse(await readFile(path.join(f.dir, 'chapters', node.key, 'chapter.json'), 'utf8'))
    assert.equal(file.section.blocks[0].id, `${node.key}-7`)
  }
  assert.equal(result.sections[1].title, '业务运行情况')
  assert.equal(result.outline[1].canonicalTitle, '业务现状')
  assert.equal(result.assemblyLinks.length, 1)
  assert.equal(result.assemblyLinks[0].scenarioBlockId, 'scenarios-7')
  assert.equal(result.assemblyLinks[0].challengeBlockId, 'business-challenges-7')
  assert.equal(result.assemblyLinks[0].trendBlockId, 'policy-trends-7')
  assert.ok(!result.gaps.some(gap => gap.includes('对应关系')))
  assert.ok(result.reviewItems.includes('请业务负责人核对场景适用性'))
  assert.ok(f.state.chapters.every(c => c.status === 'completed'))
  assert.equal(f.state.concurrency, 4)
  assert.ok((await readdir(f.dir)).includes('plan.json'))
  const markdown = reportText({ ...result, title: '测试' })
  assert.match(markdown, /## 业务运行情况/u)
  assert.match(markdown, /### 协作场景落地路径/u)
})

test('共享模型额度覆盖同时生成的报告，排队取消不会消耗额度或堵塞后续请求', async () => {
  let active = 0, peak = 0
  const llm = fakeModel(async () => { active++; peak = Math.max(peak, active); await delay(10); active--; return {} })
  await Promise.all(Array.from({ length: 12 }, () => askModel(llm, agent, undefined, { stage: 'plan' })))
  assert.equal(peak, 4)
  const limit = createLimiter(1)
  let release
  const first = limit(() => new Promise(resolve => { release = resolve }))
  await delay(0)
  const controller = new AbortController()
  const cancelled = limit(() => assert.fail('cancelled job ran'), controller.signal)
  const rejection = assert.rejects(cancelled, /取消/u)
  controller.abort(new Error('取消'))
  const next = limit(() => 'next')
  release(); await first; await rejection
  assert.equal(await next, 'next')
  await assert.rejects(mapConcurrent([1], async x => x, { concurrency: 0 }), /并发数/u)
})

test('永久失败只留下本章缺项，其他章节、规划和错误均保存；全失败诚实报错', async () => {
  const f = await fixture(fakeModel(prompt => {
    if (prompt.chapter?.key === 'business-challenges') throw new Error('provider failure')
    return answerFor(prompt)
  }))
  const result = await generateChapters(f.options)
  assert.equal(result.sections.length, 8)
  assert.equal(f.state.chapters.find(c => c.key === 'business-challenges').status, 'failed')
  assert.ok(result.gaps.some(gap => gap.includes('provider failure')))
  assert.ok(JSON.parse(await readFile(path.join(f.dir, 'chapters/business-challenges/error.json'), 'utf8')).error)
  const failed = await fixture(fakeModel(prompt => {
    if (prompt.stage === 'extract') throw new Error('unavailable')
    return answerFor(prompt)
  }))
  await assert.rejects(generateChapters(failed.options), /全部章节未完成/u)
  assert.ok(failed.state.chapters.every(c => c.status === 'failed' && c.extractAttempts === 2))
})

test('上下文超限不重复同一章节请求，运行记录保留阶段和完整输入规模', async () => {
  const f = await fixture({ async *stream() {
    throw Object.assign(new Error('maximum context length exceeded'), { code: 'context_length_exceeded' })
  } })
  await assert.rejects(generateChapters(f.options), /全部章节未完成.*上下文超限/u)
  assert.ok(f.state.chapters.every(c => c.extractAttempts === 1 && c.writeAttempts === 0))
  assert.equal(f.state.modelRequests.length, 1 + flattenOutline(f.options.outline).length)
  assert.ok(f.state.modelRequests.every(r => r.code === 'MODEL_CONTEXT_LIMIT' && r.inputCharacters > 0 && r.finishedAt))
  assert.ok(f.state.modelRequests.every(r => r.evidenceCharacters === evidence[0].content.length))
})

test('取消保留已完成章，停止启动排队章；生成状态查询不覆盖进度', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'wlyd-cancel-'))
  const controller = new AbortController()
  let cancellationStarted = false
  const runningAgent = { ...agent, session: { header: { cwd } } }
  const client = { visibleProjectBases: async () => ['K1'], documents: async () => [{ id: 'D1', parse_status: 'completed' }],
    search: async () => [{ chunk_id: 'C1', knowledge_id: 'D1', content: evidence[0].content }] }
  const llm = fakeModel(async (prompt, signal) => {
    if (prompt.chapter?.key === 'product-architecture' && !cancellationStarted) {
      cancellationStarted = true
      controller.abort(new Error('用户取消'))
    }
    await delay(prompt.chapter?.key === 'policy-trends' ? 1 : 10, undefined, { signal })
    return answerFor(prompt)
  })
  await assert.rejects(assemble({ client, llm, args: { project_id: 'P1' }, exec: { agent: runningAgent, signal: controller.signal } }), /用户取消|aborted/u)
  const root = path.join(cwd, 'artifacts/material-knowledge-assembly/runs')
  const [runId] = await readdir(root)
  const before = await readFile(path.join(root, runId, 'run.json'), 'utf8')
  const state = JSON.parse(before)
  assert.equal(state.status, 'cancelled')
  assert.ok(state.chapters.some(c => c.status === 'completed'))
  assert.ok(state.chapters.some(c => c.status === 'cancelled' && c.extractAttempts === 0))
  const completed = state.chapters.find(c => c.status === 'completed')
  assert.ok(await readFile(path.join(root, runId, completed.path), 'utf8'))
  assert.equal((await status({ client, runId, agent: runningAgent })).status, 'cancelled')
  assert.equal(await readFile(path.join(root, runId, 'run.json'), 'utf8'), before)
})

test('模式二选一，标题由 LLM 改写但角色不变；无据、混合或重复标题回退', async () => {
  const rules = await loadRules()
  const selected = normalizePlan(plan, evidence, rules.template.sections)
  assert.equal(selected.choices.businessMode.value, 'needs-challenges')
  const outline = applyModes(rules.template.sections, { businessMode: 'needs-challenges', trendFramework: 'pest' })
  const proposed = { ...selected, chapterGuidance: [
    { key: 'business-challenges', title: '经营现状与需求挑战' },
    { key: 'policy-trends', title: '行业环境研判' },
    { key: 'solution', title: '行业环境研判' },
    { key: 'technical-platform', title: '效率提升99%' },
    { key: 'scenarios', title: '业务难题的场景化应对' },
  ] }
  const resolved = applyPlanTitles(outline, proposed, evidence)
  assert.deepEqual(flattenOutline(resolved).map(n => [n.key, n.roleId]), flattenOutline(outline).map(n => [n.key, n.roleId]))
  assert.equal(resolved[1].title, '需求挑战')
  assert.equal(resolved[0].title, '行业环境研判')
  assert.equal(resolved[2].title, '解决方案')
  assert.equal(resolved[3].title, '技术平台方案')
  assert.equal(resolved[2].children[2].title, '业务难题的场景化应对')
  assert.equal(proposed.reviewItems.length, 3)
  assert.throws(() => requestedModes(outline, { business_mode: 'both' }), /业务章/u)
  assert.throws(() => requestedModes(outline, { trend_framework: 'both' }), /趋势章/u)
  const checked = validateDraft({ sections: [{ key: 'policy-trends', blocks: [
    { ...blockFor(resolved[0]), dimension: '管理' }, { ...blockFor(resolved[0]), id: 'policy-trends-9', dimension: '政治' },
  ] }] }, evidence, resolved)
  assert.equal(checked.sections[0].blocks.length, 1)
  assert.match(checked.issues[0], /未选择/u)
})

test('篇幅软目标合并解决方案子节点，忽略标题和引用，缺组的自定义结构不强套比例', async () => {
  const rules = await loadRules()
  const outline = rules.template.sections
  const sections = [
    { key: 'business-challenges', blocks: [{ text: '业'.repeat(20), evidence: [ref] }] },
    { key: 'solution', blocks: [{ text: '总'.repeat(10) }] },
    { key: 'scenarios', blocks: [{ text: '景'.repeat(40) }] },
    { key: 'policy-trends', blocks: [{ text: '趋'.repeat(30) }] },
  ]
  const balance = contentBalance(sections, outline, rules.global.contentBalance)
  assert.equal(balance.total, 100)
  assert.deepEqual(balance.groups.map(g => g.share), [20, 50])
  assert.ok(balance.groups.every(g => g.withinTarget))
  const short = contentBalance([{ ...sections[0], blocks: [{ text: '业' }] }, ...sections.slice(1)], outline, rules.global.contentBalance)
  assert.ok(short.reviewItems.length)
  assert.equal(short.soft, true)
  const custom = contentBalance([sections[1], sections[2]], outline, rules.global.contentBalance)
  assert.equal(custom.applicable, false)
  assert.deepEqual(custom.reviewItems, [])
})

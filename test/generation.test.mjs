import test from 'node:test'
import { assembleConfirmed, completeAudit } from './helpers.mjs'
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

const evidence = [{ id: 'M1-1', content: '产品支持统一维护线索状态，销售和客服可查看同一记录。获准公开的客户案例中，客户使用统一记录完成销售和客服交接。公司提供协作软件与实施服务。' }]
const ref = { id: 'M1-1', quote: '产品支持统一维护线索状态' }
const caseRef = { id: 'M1-1', quote: '客户使用统一记录完成销售和客服交接' }
const companyRef = { id: 'M1-1', quote: '公司提供协作软件与实施服务' }
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
  ...(chapter.roleId === 'customer-cases' ? { text: '获准公开的案例中，客户使用统一记录完成销售和客服交接。', supportMode: 'sourced', evidence: [caseRef] } : {}),
  ...(chapter.roleId === 'company-profile' ? { text: '公司提供协作软件与实施服务。', supportMode: 'sourced', evidence: [companyRef] } : {}),
  planRefs: { capabilityIds: ['cap-1'], scenarioIds: ['scenario-1'], problemIds: ['problem-1'], trendIds: ['trend-1'] } })
const answerFor = prompt => prompt.stage === 'plan' ? plan
  : prompt.stage === 'extract' ? { facts: [prompt.chapter.roleId === 'customer-cases'
    ? { text: '客户使用统一记录完成销售和客服交接。', subject: 'customer', purpose: 'case', supportMode: 'sourced', evidence: [caseRef] }
    : prompt.chapter.roleId === 'company-profile' ? { text: '公司提供协作软件与实施服务。', subject: 'company', purpose: 'company-profile', supportMode: 'sourced', evidence: [companyRef] }
      : { text: evidence[0].content, evidence: [ref] }], writingOutline: [] }
  : prompt.stage === 'panorama-enrichment' ? { additions: [], reviewItems: [] }
  : prompt.stage === 'consistency-review' ? completeAudit(['请业务负责人核对场景适用性'])
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
  options.acceptedPlan = normalizePlan(plan, evidence, options.outline, args)
  options.outline = applyPlanTitles(applyModes(options.outline, { businessMode: options.acceptedPlan.choices.businessMode.value, trendFramework: options.acceptedPlan.choices.trendFramework.value }), options.acceptedPlan, evidence)
  return { options, snapshots, dir, state }
}

test('八条章节流水线共享规划、原文与模型额度，乱序完成仍按目录合稿，单章错误只重试该章', async () => {
  let active = 0, peak = 0, extractionFailures = 0, writeFailures = 0
  const calls = []
  const f = await fixture(fakeModel(async prompt => {
    calls.push({ stage: prompt.stage, key: prompt.chapter?.key })
    assert.ok(prompt.evidence.every(row => evidence.some(source => source.id === row.id)))
    active++; peak = Math.max(peak, active)
    try {
      await delay(prompt.chapter?.key === 'policy-trends' ? 20 : 4)
      if (prompt.stage === 'extract' && prompt.chapter.key === 'technical-platform' && !extractionFailures++) throw new Error('temporary extract failure')
      if (prompt.stage === 'write' && prompt.chapter.key === 'solution' && !writeFailures++) throw new Error('temporary write failure')
      if (prompt.stage === 'write') {
        assert.match(prompt.task, /先概括材料/u)
        assert.ok(prompt.styleRules.some(item => item.includes('小标题或短语')))
        assert.ok(prompt.extraction.facts.length)
        assert.equal(prompt.plan.choices.businessMode.value, 'current-state')
        assert.equal(prompt.plan.choices.trendFramework.value, 'pest')
      }
      return answerFor(prompt)
    } finally { active-- }
  }), { business_mode: 'current-state', trend_framework: 'pest' })
  const result = await generateChapters(f.options)
  assert.equal(peak, 8)
  assert.equal(calls[0].stage, 'extract')
  assert.ok(!calls.some(call => call.stage === 'plan'))
  assert.equal(calls.at(-1).stage, 'consistency-review')
  const nodes = flattenOutline(f.options.outline)
  assert.deepEqual(result.sections.map(s => s.key), nodes.map(n => n.key))
  for (const node of nodes) {
    const stages = calls.filter(call => call.key === node.key).map(call => call.stage)
    assert.ok(stages.indexOf('write') > stages.indexOf('extract'))
    assert.equal(stages.filter(s => s === 'extract').length, node.key === 'technical-platform' ? 2 : 1)
    assert.equal(stages.filter(s => s === 'write').length, node.key === 'solution' ? 2 : 1)
    const file = JSON.parse(await readFile(path.join(f.dir, 'chapters', node.key, 'chapter.json'), 'utf8'))
    assert.equal(file.section.blocks[0].id, `${node.key}-1`)
  }
  assert.equal(result.sections[1].title, '业务运行情况')
  assert.equal(result.outline[1].canonicalTitle, '业务现状')
  assert.equal(result.assemblyLinks.length, 1)
  assert.equal(result.assemblyLinks[0].scenarioBlockId, 'scenarios-1')
  assert.equal(result.assemblyLinks[0].challengeBlockId, 'business-challenges-1')
  assert.equal(result.assemblyLinks[0].trendBlockId, 'policy-trends-1')
  assert.ok(!result.gaps.some(gap => gap.includes('对应关系')))
  assert.ok(result.reviewItems.includes('请业务负责人核对场景适用性'))
  assert.ok(f.state.chapters.every(c => c.status === 'completed'))
  assert.equal(f.state.concurrency, 8)
  assert.ok((await readdir(f.dir)).includes('plan.json'))
  const markdown = reportText({ ...result, title: '测试' })
  assert.match(markdown, /## 业务运行情况/u)
  assert.match(markdown, /### 协作场景落地路径/u)
})

test('共享模型额度覆盖同时生成的报告，排队取消不会消耗额度或堵塞后续请求', async () => {
  let active = 0, peak = 0
  const llm = fakeModel(async () => { active++; peak = Math.max(peak, active); await delay(10); active--; return {} })
  await Promise.all(Array.from({ length: 12 }, () => askModel(llm, agent, undefined, { stage: 'plan' })))
  assert.equal(peak, 8)
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

test('永久失败只留下本章缺项，其他章节、规划和错误均保存；全失败返回待补目录', async () => {
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
  const empty = await generateChapters(failed.options)
  assert.deepEqual(empty.sections, [])
  assert.equal(empty.review.passed, false)
  assert.equal(empty.chapterOutcomes.filter(row => row.status === 'failed').length, flattenOutline(failed.options.outline).length)
  assert.ok(failed.state.chapters.every(c => c.status === 'failed' && c.extractAttempts === 2))
})

test('上下文超限不重复同一章节请求，运行记录保留阶段和完整输入规模', async () => {
  const f = await fixture({ async *stream() {
    throw Object.assign(new Error('maximum context length exceeded'), { code: 'context_length_exceeded' })
  } })
  const empty = await generateChapters(f.options)
  assert.deepEqual(empty.sections, [])
  assert.equal(empty.review.status, 'partial')
  assert.ok(f.state.chapters.every(c => c.extractAttempts === 1 && c.writeAttempts === 0))
  assert.equal(f.state.modelRequests.length, flattenOutline(f.options.outline).length)
  assert.ok(f.state.modelRequests.every(r => r.code === 'MODEL_CONTEXT_LIMIT' && r.inputCharacters > 0 && r.finishedAt))
  assert.ok(f.state.modelRequests.every(r => r.evidenceCharacters === evidence[0].content.length))
})

test('取消保留已完成章，停止启动排队章；生成状态查询不覆盖进度', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'wlyd-cancel-'))
  const controller = new AbortController()
  let cancellationStarted = false
  const rules = await loadRules()
  const outline = [...structuredClone(rules.template.sections), ...[1, 2, 3].map(index => ({
    key: `extra-${index}`, title: `补充主题 ${index}`, roleId: 'custom', goal: '解释补充主题',
    audience: '业务负责人', questions: ['如何落地'], evidenceScope: '已授权材料', acceptance: '事实和建议分明',
  }))]
  const runningAgent = { ...agent, session: { header: { cwd } } }
  const client = { visibleProjectBases: async () => ['K1'], documents: async () => [{ id: 'D1', parse_status: 'completed' }],
    search: async () => [{ chunk_id: 'C1', knowledge_id: 'D1', content: evidence[0].content }] }
  const llm = fakeModel(async (prompt, signal) => {
    if (prompt.stage === 'write' && prompt.chapter?.key === 'extra-3' && !cancellationStarted) {
      cancellationStarted = true
      await delay(20)
      controller.abort(new Error('用户取消'))
    }
    await delay(prompt.chapter?.key === 'policy-trends' ? 1 : 10, undefined, { signal })
    if (prompt.stage === 'extract') return { facts: prompt.evidence.map(source => ({ text: source.content, evidence: [{ id: source.id, quote: source.content }] })), writingOutline: [] }
    return answerFor(prompt)
  })
  await assert.rejects(assembleConfirmed({ client, llm, args: { project_id: 'P1', outline }, exec: { agent: runningAgent, signal: controller.signal } }), /用户取消|aborted/u)
  const root = path.join(cwd, 'artifacts/material-knowledge-assembly/runs')
  const runs = await readdir(root)
  const runId = (await Promise.all(runs.map(async id => ({ id, state: JSON.parse(await readFile(path.join(root, id, 'run.json'), 'utf8')) })))).find(row => row.state.kind !== 'outline-plan').id
  const before = await readFile(path.join(root, runId, 'run.json'), 'utf8')
  const state = JSON.parse(before)
  assert.equal(state.status, 'cancelled')
  assert.ok(state.chapters.some(c => c.status === 'completed'))
  assert.ok(state.chapters.some(c => c.status === 'cancelled'))
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
  assert.equal(custom.applicable, true)
  assert.deepEqual(custom.missingGroups, ['business'])
  assert.equal(custom.groups.find(group => group.group === 'business').withinTarget, false)
  assert.ok(custom.reviewItems.length)
  const customOutline = outline.filter(node => node.key === 'solution')
  assert.equal(contentBalance([sections[1], sections[2]], customOutline, rules.global.contentBalance).applicable, false)
})

test('每章拿自己的证据；具体缺项只补一轮，新增原文进入撰写与最终复核', async () => {
  const initial = { id: 'A', content: '销售人员可以统一维护线索记录。' }
  const other = { id: 'B', content: '财务人员根据审批制度核验凭证。' }
  const extra = { id: 'C', content: '销售转交线索时需要接收人确认。' }
  const noise = { id: 'N', content: '机房空调维护注意事项。'.repeat(100) }
  const all = [initial, other, noise]
  const supplied = []
  const calls = []
  const f = await fixture(fakeModel(prompt => {
    supplied.push(prompt)
    if (prompt.stage === 'plan') return { title: '协作方案', chapterGuidance: [] }
    if (prompt.stage === 'extract') return { facts: prompt.evidence.map(source => ({
      text: source.content, evidence: [{ id: source.id, quote: source.content }],
    })), writingOutline: [], retrievalQueries: prompt.chapter.key === 'sales' ? ['销售转交如何确认'] : [] }
    if (prompt.stage === 'consistency-review') return completeAudit()
    assert.equal(prompt.stage, 'write')
    return { sections: [{ key: prompt.chapter.key, blocks: prompt.evidence.map((source, i) => ({
      id: `${prompt.chapter.key}-${i + 1}`, text: source.content, supportMode: 'sourced',
      evidence: [{ id: source.id, quote: source.content }],
    })) }] }
  }))
  f.options.outline = ['sales', 'finance'].map(key => ({ key, title: key, roleId: 'custom' }))
  f.options.evidence = all
  f.options.planningEvidence = [initial, other]
  f.options.retrieval = {
    issues: [], catalog: () => ({ documents: ['sales', 'finance'] }), flush: async () => {},
    forChapter: async (node, _plan, queries = []) => {
      calls.push({ key: node.key, queries })
      if (queries.length) { all.push(extra); return [extra] }
      return node.key === 'sales' ? [initial] : [other]
    },
    selectForSections: sections => all.filter(source => sections.some(section =>
      section.blocks.some(block => block.evidence.some(ref => ref.id === source.id)))),
  }
  const result = await generateChapters(f.options)
  assert.equal(calls.filter(call => call.queries.length).length, 1)
  assert.deepEqual(supplied.filter(prompt => prompt.stage === 'extract' && prompt.retrievalRound).flatMap(prompt => prompt.evidence.map(source => source.id)), ['C'])
  assert.equal(f.state.chapters.find(chapter => chapter.key === 'sales').supplementRounds, 1)
  const sales = supplied.find(prompt => prompt.stage === 'write' && prompt.chapter.key === 'sales')
  assert.deepEqual(sales.evidence.map(source => source.id), ['A', 'C'])
  const finance = supplied.find(prompt => prompt.stage === 'write' && prompt.chapter.key === 'finance')
  assert.deepEqual(finance.evidence.map(source => source.id), ['B'])
  assert.ok(!supplied.some(prompt => prompt.evidence.some(source => source.id === 'N')))
  assert.equal(result.sections.length, 2)
  assert.deepEqual(new Set(supplied.filter(prompt => prompt.stage === 'consistency-review').flatMap(prompt => prompt.evidence.map(source => source.id))), new Set(['A', 'B', 'C']))
  for (const [i, record] of f.state.modelRequests.entries()) {
    assert.equal(record.evidenceCharacters, supplied[i].evidence.reduce((sum, source) => sum + source.content.length, 0))
    assert.equal(record.inputBytes, Buffer.byteLength(JSON.stringify(supplied[i])))
    assert.equal(record.usage, null)
    assert.ok(record.requestStartedAt && record.finishedAt && record.serviceMs >= 0)
  }
})

test('补充提取失败仍保留首次事实；正文只复用确认规划，其他章继续', async () => {
  const f = await fixture(fakeModel(prompt => {
    if (prompt.stage === 'plan') throw new Error('plan unavailable')
    if (prompt.stage === 'extract' && prompt.retrievalRound) throw new Error('supplement unavailable')
    if (prompt.stage === 'extract') return { ...answerFor(prompt), retrievalQueries: ['需要进一步核实交接方式'] }
    if (prompt.stage === 'write') assert.ok(prompt.extraction.facts.length)
    return answerFor(prompt)
  }))
  const extra = { id: 'new', content: '可以记录线索接收确认时间。' }
  f.options.evidence = [...evidence]
  f.options.planningEvidence = evidence
  f.options.retrieval = { issues: [], catalog: () => ({}), flush: async () => {},
    forChapter: async (_node, _plan, queries = []) => queries.length ? [extra] : evidence,
    selectForSections: () => evidence }
  const result = await generateChapters(f.options)
  assert.equal(f.state.planning.status, 'confirmed')
  assert.ok(!f.state.modelRequests.some(row => row.stage === 'plan'))
  assert.equal(result.sections.length, 9)
  assert.ok(result.reviewItems.some(item => item.includes('supplement unavailable')))
  assert.ok(f.state.chapters.every(chapter => chapter.supplementRounds === 1))
})

test('合稿默认分章与关联检查，失败不能标为通过，不发送整稿大上下文', async () => {
  const calls = []
  const f = await fixture(fakeModel(prompt => {
    if (prompt.stage === 'consistency-review') {
      calls.push(prompt)
      if (prompt.reviewScope.startsWith('relationship:')) throw Object.assign(new Error('maximum context length exceeded'), { code: 'context_length_exceeded' })
    }
    return answerFor(prompt)
  }))
  const result = await generateChapters(f.options)
  assert.ok(!calls.some(prompt => prompt.reviewScope === 'whole-report'))
  assert.equal(calls.filter(prompt => prompt.reviewScope.startsWith('chapter:')).length, 9)
  assert.ok(calls.some(prompt => prompt.reviewScope.startsWith('relationship:')))
  assert.equal(result.sections.length, 9)
  assert.equal(f.state.review.status, 'partial')
  assert.equal(f.state.review.passed, false)
  assert.ok(result.reviewItems.some(item => item.includes('合稿检查未完成')))
})

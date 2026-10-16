import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { planOutline, confirmOutline, confirmedPlan } from '../src/planning.js'
import { assemble } from '../src/workflow.js'
import { evidenceBatches } from '../src/context.js'
import { collectFacts } from '../src/facts.js'
import { reviewAssembly, reviewGroups, REVIEW_CHECKS } from '../src/review.js'
import { generateChapters, normalizePlan } from '../src/generation.js'
import { loadRules } from '../src/rules.js'
import { resolveWritingModel, askModel, stageOutputBudget } from '../src/model.js'
import { completeAudit } from './helpers.mjs'

const content = '产品支持统一线索记录，当前仅在试点范围内开放。销售和客服可按同一记录交接。'
const ref = { id: 'M1', quote: '产品支持统一线索记录' }
const original = [{ id: 'M1', content }]
const model = handler => ({ async *stream(request) {
  const value = await handler(JSON.parse(request.messages[0].content[0].text), request)
  yield { type: 'text-delta', text: JSON.stringify(value) }
  yield { type: 'finish', reason: { kind: 'stop' } }
} })
async function setup() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'wlyd-phased-'))
  const exec = { agent: { session: { header: { cwd } }, options: { provider: 'test', model: 'test', reasoningEffort: 'high' } }, signal: new AbortController().signal }
  const client = { visibleProjectBases: async () => ['KB'], documents: async () => [{ id: 'D', parse_status: 'completed' }],
    search: async () => [{ id: 'C', knowledge_id: 'D', content }] }
  return { cwd, exec, client }
}
const planningModel = model(prompt => ({ facts: prompt.evidence.map(source => ({ text: content,
  evidence: [{ id: source.id, quote: '产品支持统一线索记录' }] })),
    title: '线索协作方案', businessMode: 'needs-challenges', trendFramework: 'pest',
    capabilities: [{ id: 'cap-record', text: '统一记录', capabilityStatus: 'pilot', capabilityOwnership: 'self',
      evidence: [{ id: prompt.evidence[0].id, quote: '产品支持统一线索记录' }] }],
    chapterGuidance: [{ key: 'service', focus: '解释销售与客服交接', retrievalQueries: ['销售与客服如何确认交接'] }] }))

test('规划必须有当次知识库命中；本地材料无法单独换取可确认 planId', async () => {
  const f = await setup()
  const sourceId = randomUUID()
  const root = path.join(f.cwd, 'artifacts/material-knowledge-assembly/runs')
  const sourceDir = path.join(root, sourceId)
  await mkdir(path.join(sourceDir, 'materials'), { recursive: true })
  await writeFile(path.join(sourceDir, 'run.json'), JSON.stringify({ projectId: 'P', files: [
    { name: 'local.md', status: 'converted', materialPath: 'materials/local.md' },
  ] }))
  await writeFile(path.join(sourceDir, 'materials/local.md'), content)
  f.client.search = async () => []
  await assert.rejects(planOutline({ ...f, llm: model(() => assert.fail('零命中不应调用模型')), args: {
    project_id: 'P', source_run_id: sourceId, outline: [{ key: 'service', title: '协作服务', roleId: 'delivery-service' }],
  } }), /知识库检索零命中/u)
  const planRuns = (await readdir(root)).filter(id => id !== sourceId)
  assert.equal(planRuns.length, 1)
  const state = JSON.parse(await readFile(path.join(root, planRuns[0], 'run.json'), 'utf8'))
  assert.equal(state.status, 'failed')
  assert.equal(state.knowledgeHits, 0)
  await assert.rejects(readFile(path.join(root, planRuns[0], 'outline-plan.json')), /ENOENT/u)
})

test('规划宏观取材并绑定身份目标，明确确认版本后才能生成；篡改、目录变化和跨项目均拒绝', async () => {
  const f = await setup(), prompts = []
  const args = { project_id: 'P', author_identity: '营销顾问', domain: '企业营销', objective: '说明线索协作', audience: '营销负责人',
    outline: [{ key: 'service', title: '协作服务', roleId: 'delivery-service' }] }
  const llm = model((prompt, request) => {
    prompts.push(prompt)
    assert.ok(!Object.hasOwn(prompt, 'globalRules'))
    if (prompt.stage === 'plan') {
      assert.equal(prompt.author.author_identity, '营销顾问')
      assert.equal(prompt.audience, '营销负责人')
      assert.ok(!Object.hasOwn(prompt, 'panoramaRules'))
      assert.equal(Object.hasOwn(request, 'maxTokens'), false)
      return { title: '线索协作方案', chapterGuidance: [{ key: 'service', focus: '解释交接服务', retrievalQueries: ['交接如何确认'] }] }
    }
    return { facts: prompt.evidence.map(source => ({ text: content, evidence: [{ id: source.id, quote: '产品支持统一线索记录' }] })) }
  })
  await assert.rejects(assemble({ ...f, llm, args: {} }), /先调用/u)
  const preview = await planOutline({ ...f, llm, args })
  assert.equal(preview.status, 'awaiting_confirmation')
  assert.equal(preview.knowledgeHits, 1)
  const selected = { plan_id: preview.planId, plan_sha256: preview.planSha256 }
  await assert.rejects(confirmedPlan({ args: selected, exec: f.exec }), /尚未确认/u)
  await assert.rejects(confirmOutline({ args: { ...selected, confirmed: false }, exec: f.exec }), /明确确认/u)
  await assert.rejects(confirmOutline({ args: { ...selected, confirmed: true, outline: [] }, exec: f.exec }), /目录已改变/u)
  await confirmOutline({ args: { ...selected, confirmed: true }, exec: f.exec })
  const accepted = await confirmedPlan({ args: selected, exec: f.exec })
  assert.equal(accepted.args.author_identity, '营销顾问')
  await assert.rejects(confirmedPlan({ args: { ...selected, project_id: 'OTHER' }, exec: f.exec }), /不一致/u)
  await assert.rejects(confirmedPlan({ args: { ...selected, audience: '其他读者' }, exec: f.exec }), /不一致/u)
  const file = path.join(f.cwd, 'artifacts/material-knowledge-assembly/runs', preview.planId, 'outline-plan.json')
  const doc = JSON.parse(await readFile(file, 'utf8')); doc.document.outline[0].title = '篡改目录'
  await writeFile(file, JSON.stringify(doc))
  await assert.rejects(confirmedPlan({ args: selected, exec: f.exec }), /版本不匹配/u)
  assert.equal(prompts.filter(prompt => prompt.stage === 'plan').length, 1)
  assert.equal(prompts.length, 1, '宏观取材与粗纲仅需一次模型请求')
  const overview = JSON.parse(await readFile(path.join(path.dirname(file), 'overview-facts.json'), 'utf8'))
  assert.equal(overview.verification, 'quote-match-only')
  assert.equal(overview.batches[0].status, 'source_excerpt')
  assert.equal(overview.facts[0].semanticStatus, 'source_excerpt_unreviewed')
  assert.ok(preview.reviewItems.some(item => item.includes('主线语义需用户审阅')))
})

test('一次规划核对事实与主线引用，长知识原文只传有限宏观选段且完整留档', async () => {
  const f = await setup(), prompts = []
  const long = content.repeat(500) + '末尾绝不能作为模型未见引文。'
  f.client.search = async () => [{ id: 'LONG', knowledge_id: 'D', content: long }]
  const preview = await planOutline({ ...f, args: { project_id: 'P',
    outline: [{ key: 'service', title: '协作服务', roleId: 'delivery-service' }] },
  llm: model(prompt => {
    prompts.push(prompt)
    assert.equal(prompt.stage, 'plan')
    assert.equal(prompt.planningMode, 'macro-single-pass')
    assert.ok(prompt.evidence.length <= 4)
    assert.ok(prompt.evidence.every(source => source.content.length <= 1800))
    assert.equal(prompt.evidence[0].partial, true)
    const id = prompt.evidence[0].id
    return { title: '线索协作方案', facts: [
      { text: '产品线索记录目前仅在试点范围开放', subject: 'product', purpose: 'capability', capabilityStatus: 'pilot',
        evidence: [{ id, quote: '当前仅在试点范围内开放' }] },
      { text: '未见原文不能算通过', evidence: [{ id, quote: '末尾绝不能作为模型未见引文' }] },
    ], capabilities: [
      { id: 'cap-record', text: '统一线索记录', subject: 'product', purpose: 'capability', capabilityStatus: 'pilot',
        evidence: [{ id, quote: '当前仅在试点范围内开放' }] },
      { id: 'cap-fake', text: '隐藏能力', evidence: [{ id, quote: '末尾绝不能作为模型未见引文' }] },
    ], chapterGuidance: [{ key: 'service', capabilityIds: ['cap-record'], retrievalQueries: ['销售与客服交接'] }] }
  }) })
  assert.equal(prompts.length, 1)
  assert.deepEqual(preview.capabilities.map(row => row.id), ['cap-record'])
  const dir = path.join(f.cwd, 'artifacts/material-knowledge-assembly/runs', preview.planId)
  const overview = JSON.parse(await readFile(path.join(dir, 'overview-facts.json'), 'utf8'))
  assert.equal(overview.planningMode, 'macro-single-pass')
  assert.equal(overview.verification, 'quote-match-only')
  assert.equal(overview.facts.length, 1)
  assert.equal(overview.batches[0].status, 'completed')
  const archive = JSON.parse(await readFile(path.join(dir, 'evidence.json'), 'utf8'))
  assert.equal(archive.evidence[0].content, long)
})

test('模型能力声明决定低思考档位，不继承会话 high；输出预算和输出耗尽独立记录', async () => {
  const f = await setup()
  const llm = { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] }, defaultMaxTokens: 8000 }) }
  const selection = await resolveWritingModel(llm, f.exec.agent, f.exec.signal)
  assert.equal(selection.reasoningEffort, 'low')
  assert.equal(selection.reasoningPolicy, 'low')
  assert.equal(stageOutputBudget('write', selection), undefined)
  const unverified = await resolveWritingModel({}, f.exec.agent)
  assert.equal(unverified.reasoningEffort, undefined)
  assert.equal(unverified.reasoningPolicy, 'unverified')
  const unsupported = await resolveWritingModel({ resolveModelInfo: async () => ({}) }, f.exec.agent)
  assert.equal(unsupported.reasoningPolicy, 'unsupported')
  let metrics
  await assert.rejects(askModel({ async *stream(request) {
    assert.equal(request.reasoningEffort, 'low'); assert.equal(request.maxTokens, 3072)
    yield { type: 'reasoning-delta', text: '分析' }
    yield { type: 'text-delta', text: '{"unfinished":' }
    yield { type: 'finish', reason: { kind: 'max-tokens' } }
  } }, f.exec.agent, f.exec.signal, { stage: 'extract' }, { modelSelection: selection, maxTokens: 3072, onMetrics: value => { metrics = value } }),
  error => error.code === 'MODEL_OUTPUT_LIMIT')
  assert.equal(metrics.finishReason, 'max-tokens')
  assert.equal(metrics.maxTokens, 3072)
  assert.ok(metrics.outputCharacters > 0 && metrics.reasoningCharacters > 0)
})

test('长原文分批覆盖到末尾，条件窗口重叠，资源限制只拆失败批且拒绝伪造引文', async () => {
  const long = [{ id: 'LONG', content: '业务资料正文。'.repeat(1800) + '末尾边界：本能力仍在试点，尚未全面上线。' }]
  const batches = evidenceBatches(long)
  assert.ok(batches.length > 1)
  assert.ok(batches.every(batch => batch.reduce((sum, source) => sum + source.content.length, 0) <= 6000))
  const spans = batches.flat()
  assert.equal(spans[0].span.start, 0)
  assert.equal(spans.at(-1).span.end, long[0].content.length)
  for (let i = 1; i < spans.length; i++) assert.ok(spans[i].span.start < spans[i - 1].span.end)
  assert.ok(spans.at(-1).content.includes('尚未全面上线'))
  const sizes = []
  const facts = await collectFacts({ common: {}, node: { key: 'chapter' }, rule: {}, plan: {}, evidence: long,
    request: async prompt => {
      const size = prompt.evidence.reduce((sum, source) => sum + source.content.length, 0); sizes.push(size)
      if (size > 3000) throw Object.assign(new Error('output limit after partial body'), { code: 'MODEL_OUTPUT_LIMIT', outputCharacters: 80 })
      return { facts: prompt.evidence.map(source => ({ text: '保留业务信息和试点边界', evidence: [{ id: source.id, quote: source.content.slice(0, 30) }] })) }
    } })
  assert.ok(facts.batches.some(batch => batch.status === 'split'))
  assert.ok(facts.facts.length)
  assert.ok(sizes.some(size => size <= 3000))
  await assert.rejects(collectFacts({ common: {}, node: {}, rule: {}, evidence: original, plan: {}, request: async () =>
    ({ facts: [{ text: '伪造能力', evidence: [{ id: 'M1', quote: '没有在原文中出现的虚构引文' }] }] }) }), /均未通过/u)
})

test('生成复用确认规划，所有章节进入任务，模型有八路额度，正文限于本章事实卡', async () => {
  const f = await setup(), seen = []
  const prepared = await planOutline({ ...f, llm: planningModel, args: { project_id: 'P', outline: [{ key: 'service', title: '交接服务', roleId: 'delivery-service' }] } })
  await confirmOutline({ args: { plan_id: prepared.planId, plan_sha256: prepared.planSha256, confirmed: true }, exec: f.exec })
  const llm = model(prompt => {
    seen.push(prompt)
    assert.notEqual(prompt.stage, 'plan')
    if (prompt.stage === 'extract') return { facts: prompt.evidence.map(source => ({ text: '统一记录处于试点范围', evidence: [{ id: source.id, quote: '产品支持统一线索记录' }] })) }
    if (prompt.stage === 'consistency-review') return completeAudit()
    assert.equal(prompt.stage, 'write')
    assert.ok(!Object.hasOwn(prompt, 'globalRules'))
    return { sections: [{ key: prompt.chapter.key, blocks: [{ text: '产品支持统一线索记录，适用范围仍需结合试点条件核对。',
      evidence: [{ id: prompt.evidence[0].id, quote: '产品支持统一线索记录' }] }] }] }
  })
  const result = await assemble({ ...f, llm, args: { plan_id: prepared.planId, plan_sha256: prepared.planSha256 } })
  assert.equal(result.planningStatus, 'confirmed')
  assert.equal(result.sections, 1)
  assert.equal(result.assemblyReview.status, 'completed')
  assert.equal(result.assemblyReview.passed, true)
  const run = JSON.parse(await readFile(path.join(path.dirname(result.reportPath), 'run.json'), 'utf8'))
  assert.equal(run.chapterScheduling, 'all-parallel')
  assert.equal(run.concurrency, 8)
  assert.ok(seen.every(prompt => !Object.hasOwn(prompt, 'materialCatalog')))
})

const outline = [{ key: 'problem', title: '需求挑战', roleId: 'business-challenges' },
  { key: 'scenario', title: '交接方案', roleId: 'scenario-solution' }, { key: 'map', title: '业务全景', roleId: 'business-architecture' }]
const sections = outline.map(node => ({ key: node.key, title: node.title, blocks: [{ id: `${node.key}-1`, text: '可考虑通过统一线索记录核对交接责任。', supportMode: 'candidate', evidence: [], planRefs: {} }] }))
async function reviewFixture(request) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wlyd-audit-'))
  const state = {}
  const options = { request, common: {}, plan: { capabilities: [], scenarios: [], problems: [], trends: [] }, outline,
    sections, evidence: original, dir, state, saveState: async () => {}, signal: new AbortController().signal }
  return { options, state, dir }
}

test('必检覆盖全部段落及没有共享 ID 的孤立问题；缺检查项、超时、缺章均不能标通过', async () => {
  const groups = reviewGroups(sections, outline)
  assert.ok(groups.some(group => group.scope === 'relationship:problem-1'))
  assert.deepEqual(new Set(groups.filter(group => group.scope.startsWith('chapter:')).flatMap(group => group.blocks.map(block => block.id))), new Set(sections.flatMap(section => section.blocks.map(block => block.id))))
  const f = await reviewFixture(async () => ({ reviewItems: [] }))
  const result = await reviewAssembly(f.options)
  assert.equal(result.review.passed, false); assert.equal(result.review.status, 'partial')
  const failed = await reviewFixture(async () => { throw Object.assign(new Error('timeout'), { code: 'MODEL_STAGE_TIMEOUT' }) })
  const fail = await reviewAssembly(failed.options)
  assert.equal(fail.review.passed, false)
  const missing = await reviewFixture(async () => completeAudit())
  missing.options.sections = [sections[0]]
  const partial = await reviewAssembly(missing.options)
  assert.equal(partial.review.passed, false)
  assert.deepEqual(partial.review.missingChapters, ['scenario', 'map'])
})

test('合稿有问题只修已有段落一次，修后重新检查全部受影响关系；越界修正保留原稿', async () => {
  let repaired = false, repairCalls = 0, secondChecks = 0
  const f = await reviewFixture(async prompt => {
    if (prompt.stage === 'relationship-repair') {
      repairCalls++; repaired = true
      return { replacements: [{ id: 'problem-1', text: '可考虑以统一记录核对交接责任，回应后文的交接协作方案。', supportMode: 'candidate', evidence: [], planRefs: {} }] }
    }
    if (prompt.round === 1) secondChecks++
    const audit = completeAudit()
    if (prompt.reviewScope === 'relationship:problem-1' && !repaired) {
      audit.checks[0] = { id: REVIEW_CHECKS[0], status: 'needs_review', reason: '问题需要明确回扣交接方案', blockIds: ['problem-1'] }
      audit.repairNeeded = true
    }
    return audit
  })
  const result = await reviewAssembly(f.options)
  assert.equal(repairCalls, 1); assert.ok(secondChecks > 0)
  assert.match(result.sections[0].blocks[0].text, /回应后文/u)
  assert.equal(result.review.passed, true)
  assert.deepEqual(result.sections[1], sections[1])
  const bad = await reviewFixture(async prompt => {
    if (prompt.stage === 'relationship-repair') return { replacements: [{ id: 'outside-1', text: '不能跨范围修改现有段落' }] }
    const audit = completeAudit()
    if (prompt.reviewScope === 'relationship:problem-1') { audit.checks[0].status = 'needs_review'; audit.repairNeeded = true }
    return audit
  })
  const retained = await reviewAssembly(bad.options)
  assert.deepEqual(retained.sections, sections)
  assert.equal(retained.review.passed, false)
  assert.ok(retained.reviewItems.some(item => item.includes('范围外')))
})

test('长章节证据不重复喂给撰写：尾部事实进入成稿，超限写作只拆当前事实批', async () => {
  const f = await setup(), rules = await loadRules()
  const tail = '末尾限制：当前能力仅供试点客户使用，不能承诺全面开放。'
  const sources = [{ id: 'LONG', content: '销售交接业务资料。'.repeat(1200) + tail }]
  const outline = [{ key: 'service', title: '协作服务', roleId: 'delivery-service' }]
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wlyd-long-write-'))
  const seen = [], state = {}
  let forcedSplit = false
  const llm = model(prompt => {
    seen.push(prompt)
    if (prompt.stage === 'extract') return { facts: prompt.evidence.map((source, i) => ({
      text: source.content.includes(tail) ? '当前能力仅供试点客户使用，不能承诺全面开放。' : `可考虑根据当前批次资料组织交接核对。${source.span.start}`,
      evidence: [{ id: source.id, quote: source.content.includes(tail) ? tail : source.content.slice(0, 30) }],
    })) }
    if (prompt.stage === 'consistency-review') return completeAudit()
    if (prompt.stage === 'write' && prompt.extraction.facts.length > 1 && !forcedSplit) {
      forcedSplit = true
      throw Object.assign(new Error('maximum context length exceeded'), { code: 'context_length_exceeded' })
    }
    return { sections: [{ key: 'service', blocks: prompt.extraction.facts.map(fact => ({
      text: fact.text.includes('试点') ? '当前能力仅供试点客户使用，不能承诺全面开放。' : '销售交接业务资料可作为交接责任核对的参考。',
      evidence: fact.evidence,
    })) }] }
  })
  const result = await generateChapters({ llm, exec: f.exec, args: {}, rules, outline, evidence: sources, dir, state, saveState: async () => {},
    acceptedPlan: normalizePlan({}, sources, outline) })
  assert.ok(forcedSplit, `写作事实批规模：${seen.filter(prompt => prompt.stage === 'write').map(prompt => prompt.extraction.facts.length).join(',')}`)
  const extract = seen.filter(prompt => prompt.stage === 'extract')
  assert.ok(extract.length > 1)
  assert.ok(extract.some(prompt => prompt.evidence.some(source => source.content.includes(tail))))
  assert.ok(seen.filter(prompt => prompt.stage === 'write').every(prompt => prompt.evidence.every(source => source.content.length < sources[0].content.length)))
  assert.ok(result.sections[0].blocks.some(block => block.text.includes('不能承诺全面开放')))
  const writes = state.modelRequests.filter(row => row.stage === 'write')
  assert.equal(writes.filter(row => row.code === 'MODEL_CONTEXT_LIMIT').length, 1)
  assert.ok(writes.every(row => row.inputCharacters < 16000))
})

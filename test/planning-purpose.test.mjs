import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePlan, applyPlanTitles } from '../src/plan-model.js'
import { loadRules } from '../src/rules.js'

const outline = [{ key: 'needs', roleId: 'business-challenges', title: '需求挑战', mode: 'needs-challenges' },
  { key: 'panorama', roleId: 'business-architecture', title: '业务架构全景' }]
const evidence = [{ id: 'K1', content: '产品支持销售与客服共同查看线索记录。' },
  { id: 'K2', content: '供应商自身缺少场景诊断，存在定位不清与信任赤字。' },
  { id: 'K3', content: '客户销售部门反映跨团队交接时记录丢失。' }]
const ref = index => ({ id: evidence[index].id, quote: evidence[index].content })
const capability = { id: 'cap-record', text: '共享线索记录', subject: 'product', purpose: 'capability',
  capabilityStatus: 'pilot', capabilityOwnership: 'self', evidence: [ref(0)] }

test('供应方经营判断不能因scope误标customer且有有效引用进入问题和趋势主线', () => {
  const raw = { capabilities: [capability], problems: [
    { id: 'bad-label', text: '供应商自身缺少场景诊断', scope: 'customer', evidence: [ref(1)] },
    { id: 'bad-source', text: '缺少专业场景诊断能力', scope: 'customer', subject: 'customer', purpose: 'business-problem', evidence: [ref(1)] },
    { id: 'real', text: '客户销售跨团队交接时记录丢失', scope: 'customer', subject: 'customer', purpose: 'business-problem', evidence: [ref(2)] },
  ], trends: [{ id: 'bad-trend', text: '需要建立市场信任', subject: 'industry', purpose: 'trend', evidence: [ref(1)] }] }
  const facts = [{ text: evidence[1].content, subject: 'vendor-internal', purpose: 'internal', supportMode: 'sourced', evidence: [ref(1)] },
    { text: evidence[2].content, subject: 'customer', purpose: 'business-problem', supportMode: 'sourced', evidence: [ref(2)] }]
  const plan = normalizePlan(raw, evidence, outline, {}, facts)
  assert.deepEqual(plan.problems.map(row => row.id), ['real'])
  assert.equal(plan.problems[0].supportMode, 'sourced')
  assert.deepEqual(plan.trends, [])
  assert.ok(plan.reviewItems.some(item => item.includes('供应方内部判断')))
  const noLabels = normalizePlan({ problems: [{ id: 'paraphrase', text: '缺少场景诊断', scope: 'customer', evidence: [ref(1)] }] }, evidence, outline)
  assert.deepEqual(noLabels.problems, [])
})

test('引用产品能力只能支持典型问题推演，典型假设即使有原文也保持candidate', () => {
  const raw = { capabilities: [capability], problems: [
    { id: 'implicit', text: '跨团队交接容易失去记录', scope: 'customer', subject: 'customer', purpose: 'business-problem', evidence: [ref(0)] },
    { id: 'explicit', text: '典型场景可能存在交接不清', scope: 'customer', evidence: [ref(2)] },
    { id: 'typical', text: '跨团队交接不清', scope: 'typical', evidence: [ref(2)] },
  ] }
  const facts = [{ ...capability, supportMode: 'sourced' }]
  const plan = normalizePlan(raw, evidence, outline, {}, facts)
  assert.equal(plan.problems.length, 3)
  for (const problem of plan.problems) {
    assert.equal(problem.supportMode, 'candidate')
    assert.equal(problem.scope, 'typical')
    assert.ok(problem.evidence.length)
  }
  assert.equal(plan.capabilities[0].capabilityStatus, 'pilot')
})

test('场景必须有可核对能力，错误用途不能当能力，旧版unknown材料仍保留兼容', () => {
  const raw = { capabilities: [capability,
    { id: 'no-ref', text: '自动预测业绩', subject: 'product', purpose: 'capability', evidence: [] },
    { id: 'wrong-role', text: '客户交接记录丢失', subject: 'customer', purpose: 'business-problem', evidence: [ref(2)] },
    { id: 'legacy', text: '共同查看记录', evidence: [ref(0)] }],
  scenarios: [{ id: 'good', title: '销售客服交接', capabilityIds: ['cap-record'] },
    { id: 'bad', title: '预测业绩', capabilityIds: ['no-ref'] },
    { id: 'wrong', title: '改进记录', capabilityIds: ['wrong-role'] }] }
  const plan = normalizePlan(raw, evidence, outline)
  assert.deepEqual(plan.capabilities.map(row => row.id), ['cap-record', 'legacy'])
  assert.deepEqual(plan.scenarios.map(row => row.id), ['good'])
  assert.ok(plan.reviewItems.some(item => item.includes('没有可核对的产品能力')))
})

test('阶段控制说明不污染方案和章节标题，focus仍保留有用内容目的', () => {
  const raw = { title: 'Callwan解决方案（粗目录）', chapterGuidance: [
    { key: 'needs', title: '需求挑战（粗目录）', focus: '说明跨团队交接中的客户问题；下一阶段再取证；解释可观察影响',
      retrievalQueries: ['跨团队交接如何确认', '下一阶段补检索'] },
    { key: 'panorama', title: '协作业务全景', focus: '解释角色与交接',
      organization: { purpose: '解释业务链；不写全景', scope: '销售与客服；待用户确认', dimensions: ['角色', '交接'] } },
  ] }
  const plan = normalizePlan(raw, evidence, outline)
  const resolved = applyPlanTitles(outline, plan, evidence)
  assert.equal(plan.title, 'Callwan解决方案')
  assert.equal(resolved[0].title, '需求挑战')
  assert.equal(resolved[1].title, '协作业务全景')
  assert.equal(plan.chapterGuidance[0].focus, '说明跨团队交接中的客户问题；解释可观察影响')
  assert.deepEqual(plan.chapterGuidance[0].retrievalQueries, ['跨团队交接如何确认'])
  assert.equal(plan.chapterGuidance[1].organization.purpose, '解释业务链')
  assert.equal(plan.chapterGuidance[1].organization.scope, '销售与客服')
  assert.deepEqual(resolved.map(row => row.key), outline.map(row => row.key))
})

test('章节用途策略由规则配置，可选案例和公司不允许凭空补正文，两类全景职责不同', async () => {
  const rules = await loadRules()
  const cases = rules.chapters['customer-cases'].contentPolicy
  assert.equal(cases.optional, true)
  assert.equal(cases.omitWhenNoEligibleFacts, true)
  assert.equal(cases.requiresPositiveEvidence, true)
  assert.equal(cases.allowCandidate, false)
  assert.equal(cases.requireKnownPurpose, true)
  assert.equal(rules.chapters['company-profile'].contentPolicy.allowCandidate, false)
  assert.equal(rules.chapters['company-profile'].contentPolicy.requireKnownPurpose, true)
  assert.equal(rules.chapters['business-challenges'].contentPolicy.allowCandidate, true)
  assert.notEqual(rules.chapters['business-architecture'].contentPolicy.roleFocus, rules.chapters['product-architecture'].contentPolicy.roleFocus)
  assert.ok(rules.global.fact_usage_policy.subjects.includes('vendor-internal'))
})

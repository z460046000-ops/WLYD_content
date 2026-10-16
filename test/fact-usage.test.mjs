import test from 'node:test'
import assert from 'node:assert/strict'
import { checkedFacts, evidenceBatches, uniqueFacts } from '../src/context.js'
import { collectFacts } from '../src/facts.js'
import { internalNarrative, normalizeFactMetadata, routeFacts } from '../src/evidence-policy.js'

const original = [{ id: 'K1', source: '架构审查与知识库目录.md', kind: 'knowledge', content:
  '产品支持统一线索记录，当前处于试点，依赖第三方模型。供应商定位不清，存在信任赤字，缺少场景诊断。典型团队可能存在交接遗漏。当前没有可核验客户案例。'
}]
const ref = quote => [{ id: 'K1', quote }]
const fact = (text, metadata = {}) => ({ text, supportMode: 'sourced', evidence: ref(text), ...metadata })

test('逐字引文不将典型假设升级为客户已发生事实，候选可保留背景引用', () => {
  const rows = checkedFacts({ facts: [fact('典型团队可能存在交接遗漏', { subject: 'customer', purpose: 'business-problem', scope: 'typical', supportMode: 'sourced' }),
    { text: '假设团队交接缺少共用记录', subject: 'customer', purpose: 'business-problem', scope: 'typical', evidence: [] }] }, original)
  assert.equal(rows.length, 2)
  assert.ok(rows.every(row => row.supportMode === 'candidate'))
  assert.equal(rows[0].evidence.length, 1)
  assert.equal(rows[1].evidence.length, 0)
  assert.equal(checkedFacts({ facts: [{ text: '典型假设：客户交接需统一记录', evidence: ref('产品支持统一线索记录') }] }, original)[0].supportMode, 'candidate')
})

test('内部来源可提取产品能力和边界，不按文件标题丢弃，保留主题、时效及第三方试点归属', () => {
  const rows = checkedFacts({ facts: [fact('产品支持统一线索记录', { subject: 'product', purpose: 'capability', topic: '线索协作',
    capabilityStatus: 'pilot', capabilityOwnership: 'third-party', asOf: '截至2026年10月' })] }, original)
  const routed = routeFacts(rows, { key: 'technical', roleId: 'technical-platform' }, { contentPolicy: { subjects: ['product'], purposes: ['capability', 'constraint'] } })
  assert.equal(routed.facts.length, 1)
  assert.equal(routed.facts[0].topic, '线索协作')
  assert.equal(routed.facts[0].asOf, '截至2026年10月')
  assert.equal(routed.facts[0].capabilityStatus, 'pilot')
  assert.equal(routed.facts[0].capabilityOwnership, 'third-party')
  assert.equal(original[0].content.includes('供应商定位不清'), true)
  assert.equal(routeFacts([{ ...rows[0], text: '本次材料显示产品支持统一线索记录' }], { roleId: 'technical-platform' }).facts.length, 1)
})

test('ce84d35a主体错位：明确厂商经营判断即使误标客户且引用有效也只入审核', () => {
  const rows = checkedFacts({ facts: [fact('供应商定位不清，存在信任赤字，缺少场景诊断', { subject: 'customer', purpose: 'business-problem' })] }, original)
  assert.equal(rows.length, 1)
  const routed = routeFacts(rows, { key: 'business', roleId: 'business-challenges' })
  assert.equal(routed.facts.length, 0)
  assert.equal(routed.excludedFacts.length, 1)
  assert.match(routed.reviewItems.join(''), /内部经营/u)
  assert.equal(routed.excludedFacts[0].evidence[0].quote, '供应商定位不清，存在信任赤字，缺少场景诊断')
})

test('用途显式不匹配退出正文，自定义章节由可配置用途决定，旧unknown仍兼容', () => {
  const product = fact('产品支持统一线索记录', { subject: 'product', purpose: 'capability' })
  assert.equal(routeFacts([product], { roleId: 'business-challenges' }).facts.length, 0)
  assert.equal(routeFacts([product], { roleId: 'custom' }, { contentPolicy: { subjects: ['product'], purposes: ['capability'] } }).facts.length, 1)
  const legacy = checkedFacts({ facts: [{ text: '统一线索记录能力', evidence: ref('产品支持统一线索记录') }] }, original)
  assert.equal(routeFacts(legacy, { roleId: 'business-challenges' }).facts.length, 1)
  assert.equal(legacy[0].subject, 'unknown')
})

test('无法核验或计划补充案例属于审核内容，有引用也不充当合作案例', () => {
  const rows = checkedFacts({ facts: [fact('当前没有可核验客户案例', { subject: 'company', purpose: 'case' })] }, original)
  const planned = { text: '后续计划收集成功案例', supportMode: 'sourced', subject: 'company', purpose: 'case', evidence: ref('当前没有可核验客户案例') }
  const rule = { contentPolicy: { allowCandidate: false, requiresPositiveEvidence: true } }
  assert.equal(routeFacts([...rows, planned], { roleId: 'customer-cases' }, rule).facts.length, 0)
  const actual = { text: '客户A已上线线索管理', supportMode: 'sourced', subject: 'customer', purpose: 'case', evidence: ref('产品支持统一线索记录') }
  assert.equal(routeFacts([actual], { roleId: 'customer-cases' }, rule).facts.length, 1)
  // Routing checks purpose only; original quote-to-claim entailment still needs final review.
})

test('候选不充当公司背书，无效分类不能降级unknown后直接穿透正文', () => {
  const raw = fact('产品支持统一线索记录', { subject: 'invented-subject', purpose: 'capability', capabilityStatus: 'finished', asOf: {} })
  const rows = checkedFacts({ facts: [raw] }, original)
  assert.equal(rows[0].subject, 'unknown')
  assert.equal(rows[0].capabilityStatus, 'unknown')
  assert.ok(rows[0].classificationIssues.length >= 3)
  assert.equal(routeFacts(rows, { roleId: 'custom' }).facts.length, 0)
  assert.equal(routeFacts([{ text: '可考虑参与行业生态', subject: 'company', purpose: 'company-profile', supportMode: 'candidate', evidence: [] }],
    { roleId: 'company-profile' }, { contentPolicy: { allowCandidate: false } }).facts.length, 0)
  assert.equal(normalizeFactMetadata({ scope: 'hypothetical' }).scope, 'typical')
})

test('同文引用但不同状态、主体或候选性不能被去重覆盖', () => {
  const a = fact('产品支持统一线索记录', { subject: 'product', purpose: 'capability', capabilityStatus: 'pilot' })
  assert.equal(uniqueFacts([a, { ...a, capabilityStatus: 'existing' }, { ...a, supportMode: 'candidate' }, a]).length, 3)
})

test('证据窗口只携带必要来源字段，不复制任意元数据或截掉原文尾部', () => {
  const source = { ...original[0], content: '技术材料。'.repeat(1200) + '尾部保留条件', locator: 'chunk=1', publishedAt: '2026-10-01',
    enormousMetadata: { arbitrary: 'ignore' }, retrievedBy: [{ long: 'ignore' }] }
  const rows = evidenceBatches([source]).flat()
  assert.equal(rows[0].source, source.source)
  assert.equal(rows[0].kind, 'knowledge')
  assert.equal(rows[0].publishedAt, '2026-10-01')
  assert.equal(Object.hasOwn(rows[0], 'enormousMetadata'), false)
  assert.equal(Object.hasOwn(rows[0], 'retrievedBy'), false)
  assert.ok(rows.at(-1).content.endsWith('尾部保留条件'))
})

test('提取问题非白名单，新增用途元数据与其他有价值事实通过原有一次提取调用保留', async () => {
  let calls = 0
  const result = await collectFacts({ common: {}, node: { key: 'tech', roleId: 'technical-platform' },
    rule: { extractQuestions: ['仅重点关注记录管理'], contentPolicy: { purposes: ['capability', 'constraint'] } }, evidence: original, plan: {},
    request: async prompt => {
      calls++
      assert.match(prompt.task, /非白名单/u)
      assert.match(prompt.schema.facts[0].subject, /vendor-internal/u)
      assert.equal(prompt.chapterRule.contentPolicy.purposes.includes('constraint'), true)
      return { facts: [fact('依赖第三方模型', { subject: 'product', purpose: 'constraint', capabilityOwnership: 'third-party', topic: '模型集成' })] }
    } })
  assert.equal(calls, 1)
  assert.equal(result.facts.length, 1)
  assert.equal(result.facts[0].topic, '模型集成')
  assert.equal(routeFacts(result.facts, { roleId: 'technical-platform' }).facts.length, 1)
})

test('案例与企业简介可要求明确用途，其他章节仍兼容unknown', () => {
  const unknown = checkedFacts({ facts: [{ text: '统一线索记录能力', evidence: ref('产品支持统一线索记录') }] }, original)
  for (const [roleId, purpose] of [['customer-cases', 'case'], ['company-profile', 'company-profile']]) {
    const rule = { contentPolicy: { requireKnownPurpose: true, purposes: [purpose] } }
    assert.equal(routeFacts(unknown, { roleId }, rule).facts.length, 0)
    const matched = { ...unknown[0], subject: roleId === 'customer-cases' ? 'customer' : 'company', purpose }
    assert.equal(routeFacts([matched], { roleId }, rule).facts.length, 1)
  }
  assert.equal(routeFacts(unknown, { roleId: 'technical-platform' }).facts.length, 1)
  assert.equal(routeFacts(unknown, { roleId: 'custom' }).facts.length, 1)
})

test('明确无外部或真实案例、案例为零等否定不伪装为正向案例，缺少其他附件不误伤实际案例', () => {
  const makeCase = text => ({ text, subject: 'customer', purpose: 'case', supportMode: 'sourced', evidence: ref('产品支持统一线索记录') })
  const node = { roleId: 'customer-cases' }, rule = { contentPolicy: { purposes: ['case'], requireKnownPurpose: true } }
  for (const text of ['无外部案例', '案例为零', '案例数为0', '0个案例', '暂无真实案例', '没有可核对的真实客户成功案例']) {
    assert.equal(routeFacts([makeCase(text)], node, rule).facts.length, 0, text)
  }
  for (const text of ['客户A已经上线统一线索记录，缺少案例截图', '客户A完成业务上线，暂无案例附件', '已有10个案例', '客户A已上线，后续补充附件，已有客户案例']) {
    assert.equal(routeFacts([makeCase(text)], node, rule).facts.length, 1, text)
  }
})

test('业务与趋势的未知主体有引用也降为候选，明确客户或行业事实保持有据身份', () => {
  const legacy = checkedFacts({ facts: [{ text: '需要统一记录', evidence: ref('产品支持统一线索记录') }] }, original)[0]
  for (const [roleId, purpose] of [['business-challenges', 'business-problem'], ['policy-trends', 'trend']]) {
    const pending = routeFacts([{ ...legacy, purpose }], { roleId })
    assert.equal(pending.facts.length, 1)
    assert.equal(pending.facts[0].supportMode, 'candidate')
    assert.equal(pending.facts[0].evidence.length, 1)
    assert.match(pending.reviewItems.join(''), /主体尚不明确/u)
    for (const subject of ['customer', 'industry']) {
      const known = routeFacts([{ ...legacy, purpose, subject }], { roleId })
      assert.equal(known.facts[0].supportMode, 'sourced')
      const unknownPurpose = routeFacts([{ ...legacy, subject }], { roleId })
      assert.equal(unknownPurpose.facts[0].supportMode, 'candidate')
      assert.match(unknownPurpose.reviewItems.join(''), /用途尚不明确/u)
    }
  }
})

test('客户研发、经营与培训场景不会因出现内部或代码等词误当厂商叙事', () => {
  const customerTexts = ['客户研发缺陷需要统一跟踪与关闭', '客户代码审查缺少统一记录', '客户内部经营流程存在交接滞后',
    '客户内部研发问题需要跨团队协作', '客户新人培训与知识接入需要统一入口', '客户知识库目录结构包括业务制度和常见问题',
    '客户资料维护人是业务主管', '目标客户的代码现状缺少变更追踪']
  for (const text of customerTexts) {
    assert.equal(internalNarrative(text), false, text)
    const item = { text, subject: 'customer', purpose: 'business-problem', scope: 'customer', supportMode: 'sourced', evidence: ref('产品支持统一线索记录') }
    const result = routeFacts([item], { roleId: 'business-challenges' })
    assert.equal(result.facts.length, 1, text)
    assert.equal(result.facts[0].supportMode, 'sourced', text)
  }
  // A mislabeled subject must not hide an explicit supplier-side statement.
  for (const text of ['供应商定位不清且存在信任赤字', '我司内部研发缺陷尚未处理', '厂商自身代码审查发现问题']) {
    assert.equal(internalNarrative(text), true, text)
    assert.equal(routeFacts([{ text, subject: 'customer', purpose: 'business-problem', supportMode: 'sourced', evidence: [] }],
      { roleId: 'business-challenges' }).facts.length, 0, text)
  }
  assert.equal(internalNarrative('本次报告组稿阶段先补证据'), true)
  assert.equal(internalNarrative('本批材料缺少正式客户案例'), true)
  for (const text of ['供应商研发缺陷管理平台支持闭环处理', '供应商代码审查产品支持自动检查']) {
    assert.equal(internalNarrative(text), false, text)
  }
})

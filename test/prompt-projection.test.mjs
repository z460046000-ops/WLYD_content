import test from 'node:test'
import assert from 'node:assert/strict'
import { loadRules } from '../src/rules.js'
import { commonContext } from '../src/context.js'
import { stageContext, chapterContext } from '../src/prompts.js'

test('独立阶段只携带本阶段共用规则与本章差异，关联原则统一维护', async () => {
  const rules = await loadRules()
  const common = commonContext(rules, { author_identity: '售前顾问', audience: '客户' })
  const extract = stageContext(common, 'extract')
  const write = stageContext(common, 'write')
  const review = stageContext(common, 'consistency-review')
  assert.equal(extract.author.identity, '售前顾问')
  assert.equal(extract.audience, '客户')
  assert.equal(Object.hasOwn(extract, 'promptPolicy'), false)
  assert.equal(Object.hasOwn(extract, 'styleRules'), false)
  assert.equal(Object.hasOwn(extract.sharedRules, 'links'), false)
  assert.match(extract.task, /非白名单/u)
  assert.equal(write.sharedRules.links, rules.global.sharedRules.links)
  assert.ok(write.styleRules.length > 0)
  assert.equal(Object.hasOwn(review, 'styleRules'), false)
  assert.deepEqual(Object.keys(review.sharedRules), ['evidence', 'facts'])
  assert.match(review.task, /问题方案、能力证据、场景全景、趋势建设、矛盾孤立/u)
  assert.throws(() => stageContext(common, 'unknown-stage'), /未知提示词阶段/u)

  const node = { roleId: 'product-architecture' }
  const rule = rules.chapters[node.roleId]
  const extraction = chapterContext(rule, node, 'extract')
  const writing = chapterContext(rule, node, 'write')
  assert.ok(extraction.extractQuestions.length > 0)
  assert.equal(Object.hasOwn(extraction, 'write'), false)
  assert.ok(writing.write.length > 0)
  assert.equal(Object.hasOwn(writing, 'extractQuestions'), false)
  assert.equal(Object.hasOwn(writing, 'validate'), false)
  assert.equal(Object.hasOwn(writing.contentPolicy, 'roleFocus'), false)
  assert.deepEqual(writing.contentPolicy.subjects, rule.contentPolicy.subjects)
})

test('精简后仍保留章节的程序约束、选项与版本追踪', async () => {
  const rules = await loadRules()
  assert.equal(rules.global.version, '0.11.0')
  assert.equal(rules.global.contentBalance.groups.business.range[0], 15)
  assert.equal(rules.global.contentBalance.groups.solution.range[1], 60)
  assert.ok(rules.global.assemblyReview.mandatory)
  for (const [role, rule] of Object.entries(rules.chapters)) {
    assert.match(rule.version, /^0\.\d+\.\d+$/u, role)
    assert.ok(rule.extractQuestions.length > 0 && rule.write.length > 0 && rule.validate.length > 0, role)
    assert.ok(rule.contentPolicy.subjects.length > 0 && rule.contentPolicy.purposes.length > 0, role)
    assert.equal(rule.contentPolicy.excludePurposes.includes('internal'), true, role)
  }
  const business = rules.chapters['business-challenges']
  const trends = rules.chapters['policy-trends']
  const cases = rules.chapters['customer-cases']
  const company = rules.chapters['company-profile']
  assert.deepEqual(Object.keys(business.modes), ['current-state', 'needs-challenges'])
  assert.deepEqual(Object.keys(trends.frameworks), ['pest', 'management-business-technology'])
  for (const rule of [cases, company]) {
    assert.equal(rule.contentPolicy.allowCandidate, false)
    assert.equal(rule.contentPolicy.requireKnownPurpose, true)
  }
  assert.equal(cases.contentPolicy.omitWhenNoEligibleFacts, true)
  assert.equal(cases.contentPolicy.requiresPositiveEvidence, true)
})

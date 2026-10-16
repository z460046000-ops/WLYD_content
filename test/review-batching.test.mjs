import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { reviewGroups, reviewAssembly, REVIEW_CHECKS } from '../src/review.js'
import { completeAudit } from './helpers.mjs'

const outline = [{ key: 'problems', roleId: 'business-challenges', title: '业务问题' },
  { key: 'scenes', roleId: 'scenario-solution', title: '典型场景' },
  { key: 'business', roleId: 'business-architecture', title: '业务全景' },
  { key: 'product', roleId: 'product-architecture', title: '产品全景' },
  { key: 'trends', roleId: 'policy-trends', title: '趋势方向' }]
const makeSections = (count = 6) => outline.map(node => ({ key: node.key, title: node.title,
  blocks: Array.from({ length: count }, (_, index) => ({ id: `${node.key}-${index + 1}`,
    text: `【待确认·典型场景假设】可考虑通过线索协作记录明确交接责任，结合业务阶段 ${String.fromCharCode(65 + index)} 进行核验。`,
    supportMode: 'candidate', evidence: [], planRefs: { capabilityIds: [`cap-${index}`], scenarioIds: [`scene-${index}`], problemIds: [`problem-${index}`], trendIds: [`trend-${index}`] } })) }))
const makePlan = (count = 6) => ({ capabilities: Array.from({ length: count }, (_, i) => ({ id: `cap-${i}`, text: '协作记录', evidence: [] })),
  scenarios: Array.from({ length: count }, (_, i) => ({ id: `scene-${i}` })), problems: Array.from({ length: count }, (_, i) => ({ id: `problem-${i}` })),
  trends: Array.from({ length: count }, (_, i) => ({ id: `trend-${i}` })) })
async function fixture({ sections = makeSections(), request = async () => completeAudit(), dir, plan = makePlan() } = {}) {
  return { request, common: {}, plan, outline, sections, evidence: [],
    dir: dir || await mkdtemp(path.join(os.tmpdir(), 'wlyd-review-batches-')), state: {}, saveState: async () => {}, signal: new AbortController().signal }
}

test('关系按相关章节合批且完整保留每个正文、重点关系与显式对应，导航有界', () => {
  const sections = makeSections(12), jobs = reviewGroups(sections, outline)
  const chapterIds = jobs.filter(job => job.kind === 'chapter').flatMap(job => job.blocks.map(block => block.id))
  assert.deepEqual(new Set(chapterIds), new Set(sections.flatMap(section => section.blocks.map(block => block.id))))
  const relationships = jobs.filter(job => job.kind === 'relationship')
  const focuses = relationships.flatMap(job => job.relationships.map(row => row.focusId))
  assert.equal(new Set(focuses).size, 36)
  assert.ok(relationships.length < 36, '不能继续每个重点段落单独调用')
  assert.ok(relationships.every(job => job.index.length <= 8 && job.blocks.length <= 12))
  for (const job of relationships) for (const row of job.relationships) {
    assert.ok(job.blocks.some(block => block.id === row.focusId))
    assert.ok(row.targetIds.every(id => job.blocks.some(block => block.id === id)))
  }
  // Shared IDs retain all explicitly related target paragraphs, not a single sampled role representative.
  const grouped = reviewGroups(sections.map(section => ({ ...section, blocks: section.blocks.map(block => ({ ...block, planRefs: { capabilityIds: ['shared'] } })) })), outline)
  const problem = grouped.flatMap(job => job.relationships).filter(row => row.focusId === 'problems-1')
  assert.equal(new Set(problem.flatMap(row => row.targetIds)).size, 12)
})

test('三章二十四段与十条主线合为有界复核批，正文和显式对应均不丢失', () => {
  const threeChapters = [
    { key: 'business', roleId: 'business-architecture', count: 9 },
    { key: 'product', roleId: 'product-architecture', count: 5 },
    { key: 'scenes', roleId: 'scenario-solution', count: 10 },
  ]
  const sections = threeChapters.map(chapter => ({ key: chapter.key,
    blocks: Array.from({ length: chapter.count }, (_, i) => ({ id: `${chapter.key}-${i + 1}`,
      text: `【待确认·典型场景假设】线索协作场景 ${i + 1} 需核对问题、产品能力与落地条件。`.repeat(4),
      planRefs: { capabilityIds: [`cap-${i % 5}`] }, evidence: [], supportMode: 'candidate' })) }))
  const jobs = reviewGroups(sections, threeChapters)
  assert.ok(jobs.length <= 9, `预期至多九次复核请求，实际 ${jobs.length} 次`)
  assert.deepEqual(new Set(jobs.filter(job => job.kind === 'chapter').flatMap(job => job.blocks.map(block => block.id))),
    new Set(sections.flatMap(section => section.blocks.map(block => block.id))))
  assert.deepEqual(new Set(jobs.flatMap(job => job.relationships.map(row => row.focusId))),
    new Set(sections[2].blocks.map(block => block.id)))
  for (const job of jobs.filter(row => row.kind === 'relationship')) {
    assert.ok(job.blocks.length <= 12 && JSON.stringify(job.blocks).length <= 15000)
    for (const relation of job.relationships) {
      assert.ok(relation.targetIds.length > 0)
      assert.ok(relation.targetIds.every(id => job.blocks.some(block => block.id === id)))
    }
  }
})

test('相同指纹复用已完成复核；改动只重查受影响段落和关系，规则变化使旧结果失效', async () => {
  const calls = []
  const options = await fixture({ request: async prompt => { calls.push(prompt); return completeAudit() } })
  const first = await reviewAssembly(options)
  const originalCount = calls.length
  assert.equal(first.review.passed, true)
  assert.equal(first.review.coverage.paragraphs.completed, 30)
  assert.equal(first.review.coverage.relationships.completed, 18)
  const stored = JSON.parse(await readFile(path.join(options.dir, 'consistency-review.json'), 'utf8'))
  assert.ok(stored.reviews.every(row => /^[a-f0-9]{64}$/u.test(row.fingerprint)))
  calls.length = 0
  const second = await reviewAssembly(options)
  assert.equal(calls.length, 0)
  assert.equal(second.review.coverage.reusedGroups, originalCount)
  options.sections = structuredClone(options.sections)
  options.sections[2].blocks[0].text += ' 交接责任需要明确确认。'
  const third = await reviewAssembly(options)
  assert.ok(calls.length > 0 && calls.length < originalCount)
  assert.ok(third.review.coverage.reusedGroups > 0)
  calls.length = 0
  options.common = { evidenceRules: { version: 'changed' } }
  await reviewAssembly(options)
  assert.ok(calls.length >= originalCount)
})

test('限流与排队超时不拆批制造额外请求，未检查关系不能通过', async () => {
  let calls = 0
  const options = await fixture({ request: async () => { calls++; throw Object.assign(new Error('queue timeout'), { code: 'MODEL_QUEUE_TIMEOUT' }) } })
  const expected = reviewGroups(options.sections, outline).length
  const result = await reviewAssembly(options)
  assert.equal(calls, expected)
  assert.equal(result.review.passed, false)
  assert.equal(result.review.coverage.paragraphs.completed, 0)
  assert.equal(result.review.coverage.relationships.completed, 0)
  assert.equal(result.review.coverage.relationships.uncheckedIds.length, 18)
})

test('无目标正文的主线不能由模型伪通过，空章和缺章明确记录', async () => {
  const sections = makeSections(1).filter(section => section.key === 'problems')
  const options = await fixture({ sections })
  const result = await reviewAssembly(options)
  assert.equal(result.review.passed, false)
  assert.ok(result.review.coverage.relationships.uncheckedIds.includes('problems-1'))
  assert.ok(result.review.missingChapters.includes('scenes'))
  assert.ok(result.reviewItems.some(item => item.includes('缺少可联合检查')))
})

test('修正后仅重查改变指纹，未改变章节复用，新增关联纳入复核', async () => {
  const sections = makeSections(1), prompts = []
  let repaired = false
  const options = await fixture({ sections, plan: makePlan(1), request: async prompt => {
    prompts.push(prompt)
    if (prompt.stage === 'relationship-repair') {
      repaired = true
      return { replacements: [{ id: 'problems-1', text: '【待确认·典型场景假设】可考虑明确问题与后续交接场景方案的对应。', supportMode: 'candidate', evidence: [], planRefs: sections[0].blocks[0].planRefs }] }
    }
    const audit = completeAudit()
    if (prompt.reviewScope === 'relationship:problems-1' && !repaired) {
      audit.checks[0] = { id: REVIEW_CHECKS[0], status: 'needs_review', reason: '问题需对应后续方案', blockIds: ['problems-1'] }
      audit.repairNeeded = true
    }
    return audit
  } })
  const result = await reviewAssembly(options)
  assert.equal(result.review.passed, true)
  const second = prompts.filter(prompt => prompt.stage === 'consistency-review' && prompt.round === 1)
  assert.ok(second.length > 0)
  assert.ok(second.every(prompt => prompt.sections.some(block => block.id === 'problems-1') || prompt.relationshipIndex.some(row => row.id === 'problems-1')))
  assert.ok(result.review.coverage.reusedGroups > 0)
})

test('同能力状态归属差异由程序标识，章节语义审核仍覆盖全部正文', async () => {
  const sections = makeSections(1)
  sections[0].blocks[0].capabilityStatus = 'pilot'; sections[1].blocks[0].capabilityStatus = 'existing'
  sections[0].blocks[0].capabilityOwnership = 'third-party'; sections[1].blocks[0].capabilityOwnership = 'self'
  const jobs = reviewGroups(sections, outline)
  assert.ok(jobs.filter(job => job.kind === 'chapter').every(job => job.blocks.length))
  assert.ok(jobs.some(job => job.boundaryConflicts.some(row => row.field === 'capabilityStatus')))
  assert.ok(jobs.some(job => job.boundaryConflicts.some(row => row.field === 'capabilityOwnership')))
  assert.ok(!jobs.some(job => job.scope.startsWith('capability:')))
})

test('部分失败保存已完成结果，恢复只重试失败批；证据选段改变时相关缓存失效', async () => {
  const calls = []
  let rejectOnce = true
  const options = await fixture({ request: async prompt => {
    calls.push(prompt)
    if (prompt.reviewScope === 'chapter:product:1' && rejectOnce) throw Object.assign(new Error('temporary timeout'), { code: 'MODEL_STAGE_TIMEOUT' })
    return completeAudit()
  } })
  const first = await reviewAssembly(options)
  assert.equal(first.review.passed, false)
  rejectOnce = false; calls.length = 0
  const next = await reviewAssembly(options)
  assert.equal(next.review.passed, true)
  assert.deepEqual(calls.map(prompt => prompt.reviewScope), ['chapter:product:1'])
  const quote = '产品支持在试点范围记录协作信息'
  options.evidence = [{ id: 'E', content: quote + '，须保留客户确认。' }]
  options.sections[0].blocks[0].evidence = [{ id: 'E', quote }]
  calls.length = 0
  await reviewAssembly(options)
  assert.ok(calls.some(prompt => prompt.evidence.some(source => source.id === 'E')))
  calls.length = 0
  options.evidence[0].content = quote + '，尚未全面开放。'
  await reviewAssembly(options)
  assert.ok(calls.some(prompt => prompt.evidence.some(source => source.content.includes('尚未全面开放'))))
  assert.ok(calls.length < reviewGroups(options.sections, options.outline).length)
})

test('联合语义超限后子批通过也不能冒充原批通过，所有缺检保留', async () => {
  const options = await fixture({ request: async prompt => {
    if (prompt.reviewScope === 'relationship:problems-1') throw Object.assign(new Error('maximum context length'), { code: 'MODEL_CONTEXT_LIMIT' })
    return completeAudit()
  }, sections: makeSections(1), plan: makePlan(1) })
  const result = await reviewAssembly(options)
  assert.equal(result.review.passed, false)
  assert.ok(result.review.coverage.relationships.uncheckedIds.includes('problems-1'))
  const stored = JSON.parse(await readFile(path.join(options.dir, 'consistency-review.json'), 'utf8'))
  assert.ok(stored.reviews.some(row => row.scope.startsWith('relationship:problems-1:part') && row.status === 'completed'))
  assert.ok(stored.reviews.some(row => row.scope === 'relationship:problems-1' && row.status === 'incomplete'))
})

test('没有内容变更的修正结果也缓存，不在恢复时重复相同模型修正', async () => {
  let calls = 0
  const options = await fixture({ sections: makeSections(1), plan: makePlan(1), request: async prompt => {
    calls++
    if (prompt.stage === 'relationship-repair') return { replacements: [], reviewItems: ['没有足够证据自动调整'] }
    const audit = completeAudit()
    if (prompt.reviewScope === 'relationship:problems-1') {
      audit.checks[0] = { id: REVIEW_CHECKS[0], status: 'needs_review', reason: '需要客户确认', blockIds: ['problems-1'] }
      audit.repairNeeded = true
    }
    return audit
  } })
  const first = await reviewAssembly(options)
  assert.equal(first.review.passed, false)
  calls = 0
  const next = await reviewAssembly(options)
  assert.equal(calls, 0)
  assert.equal(next.review.passed, false)
  assert.ok(next.reviewItems.includes('没有足够证据自动调整'))
})

test('合稿替换和缓存替换均须通过用途回调，拒绝时保留原有效段落', async () => {
  for (const cached of [false, true]) {
    let calls = 0, repaired = false
    const sections = makeSections(1)
    const options = await fixture({ sections, plan: makePlan(1), request: async prompt => {
      calls++
      if (prompt.stage === 'relationship-repair') {
        repaired = true
        return { replacements: [{ id: 'problems-1', text: '【待确认·典型场景假设】可考虑将内部审核过程说明写进客户正文。',
          supportMode: 'candidate', evidence: [], planRefs: sections[0].blocks[0].planRefs }] }
      }
      const audit = completeAudit()
      if (prompt.reviewScope === 'relationship:problems-1' && !repaired) {
        audit.checks[0] = { id: REVIEW_CHECKS[0], status: 'needs_review', reason: '问题需对应后续方案', blockIds: ['problems-1'] }
        audit.repairNeeded = true
      }
      return audit
    } })
    if (cached) {
      const first = await reviewAssembly(options)
      assert.match(first.sections[0].blocks[0].text, /内部审核过程/u)
      calls = 0
    }
    let gateCalls = 0
    options.validateBlock = (replacement, chapterKey) => {
      gateCalls++
      assert.equal(chapterKey, 'problems')
      assert.match(replacement.text, /内部审核过程/u)
      throw new Error('审核过程不进入客户正文')
    }
    const result = await reviewAssembly(options)
    assert.deepEqual(result.sections, sections)
    assert.equal(gateCalls, 1)
    assert.equal(result.review.passed, false)
    assert.ok(result.reviewItems.some(item => item.includes('审核过程不进入客户正文')))
    if (cached) assert.equal(calls, 0)
  }
})

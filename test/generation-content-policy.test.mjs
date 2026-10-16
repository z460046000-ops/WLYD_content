import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateChapters, normalizePlan, organizeChapterFacts } from '../src/generation.js'
import { loadRules } from '../src/rules.js'
import { completeAudit } from './helpers.mjs'

const quote = '产品支持统一记录线索，销售和客服共享协作记录。'
const ref = { id: 'E', quote }
const fact = i => ({ text: `可围绕线索交接组织${String.fromCharCode(65 + i)}类协作事项。`, topic: '线索交接',
  subject: 'product', purpose: 'capability', supportMode: 'sourced', evidence: [ref] })
const candidate = text => ({ text, supportMode: 'candidate', evidence: [] })
async function fixture(handler, outline = [{ key: 'service', title: '交接服务', roleId: 'delivery-service', required: true }], audit = completeAudit) {
  const rules = await loadRules(), dir = await mkdtemp(path.join(tmpdir(), 'wlyd-content-policy-'))
  const evidence = [{ id: 'E', content: quote }], state = {}, prompts = []
  const llm = { async *stream(request) {
    const prompt = JSON.parse(request.messages[0].content[0].text); prompts.push(prompt)
    const value = prompt.stage === 'consistency-review' ? audit(prompt) : await handler(prompt)
    yield { type: 'text-delta', text: JSON.stringify(value) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  return { state, dir, prompts, options: { llm, rules, outline, evidence, dir, state, args: {},
    exec: { agent: { options: { provider: 'fake', model: 'fake' } }, signal: new AbortController().signal },
    saveState: async () => {}, acceptedPlan: normalizePlan({}, evidence, outline) } }
}

test('同批坏引文只修被拒段落，有效段落保留且不重复', async () => {
  const f = await fixture(prompt => {
    if (prompt.stage === 'extract') return { facts: [fact(0)] }
    if (prompt.failedBlocks.length) {
      assert.equal(prompt.failedBlocks.length, 1)
      assert.equal(prompt.previousTopics.length, 1)
      return { sections: [{ key: 'service', blocks: [candidate('可在交接后核对线索接收状态，责任分工由业务团队确认。')] }] }
    }
    return { sections: [{ key: 'service', blocks: [candidate('可用统一记录组织销售向客服的线索交接。'),
      { text: '产品可用于业务交接记录。', supportMode: 'sourced', evidence: [{ id: 'E', quote: '不属于原始资料的假引文' }] }] }] }
  })
  const result = await generateChapters(f.options)
  assert.equal(result.sections[0].blocks.length, 2)
  assert.equal(new Set(result.sections[0].blocks.map(row => row.id)).size, 2)
  assert.equal(f.prompts.filter(row => row.stage === 'write').length, 2)
  assert.equal(f.state.chapters[0].status, 'completed')
  assert.equal(f.state.chapters[0].failedBatches.length, 0)
})

test('后续批失败仍交付前批正文，标partial且合稿不能算通过，恢复可复用事实卡', async () => {
  let fail = true
  const f = await fixture(prompt => {
    if (prompt.stage === 'extract') return { facts: Array.from({ length: 6 }, (_, i) => fact(i)) }
    if (prompt.batchId === '2' && fail) throw Object.assign(new Error('上游执行超时'), { code: 'MODEL_STAGE_TIMEOUT' })
    return { sections: [{ key: 'service', blocks: [candidate(prompt.batchId === '1'
      ? '可用统一记录组织销售和客服的线索交接。' : '可在交接完成后核对接收责任及后续处理动作。')] }] }
  })
  const result = await generateChapters(f.options)
  assert.equal(result.sections[0].blocks.length, 1)
  assert.equal(result.chapterOutcomes[0].status, 'partial')
  assert.equal(result.review.passed, false)
  assert.ok(result.gaps.some(row => row.includes('部分成稿')))
  const partial = JSON.parse(await readFile(path.join(f.dir, 'chapters/service/writing-partial.json'), 'utf8'))
  assert.equal(partial.sections[0].blocks.length, 1)
  const extractCalls = f.prompts.filter(row => row.stage === 'extract').length
  fail = false
  const resumed = await generateChapters({ ...f.options, resume: true })
  assert.equal(f.prompts.filter(row => row.stage === 'extract').length, extractCalls)
  assert.equal(resumed.chapterOutcomes[0].status, 'completed')
  assert.equal(resumed.sections[0].blocks.length, 2)
})

test('无正向案例时省略可选章、不给模型写无案例说明，必需案例不能省略', async () => {
  const outline = [{ key: 'service', title: '交接服务', roleId: 'delivery-service', required: true },
    { key: 'cases', title: '项目实践', roleId: 'customer-cases', required: false }]
  const f = await fixture(prompt => prompt.stage === 'extract' ? { facts: [fact(0)] }
    : { sections: [{ key: prompt.chapter.key, blocks: [candidate('可用统一记录组织团队间的业务交接。')] }] }, outline)
  const result = await generateChapters(f.options)
  assert.deepEqual(result.sections.map(row => row.key), ['service'])
  assert.equal(result.chapterOutcomes.find(row => row.key === 'cases').status, 'omitted')
  assert.ok(!f.prompts.some(row => row.stage === 'write' && row.chapter.key === 'cases'))
  assert.equal(result.review.passed, true)
  assert.deepEqual(result.review.missingChapters, [])
  const required = structuredClone(outline); required[1].required = true
  const second = await fixture(prompt => prompt.stage === 'extract' ? { facts: [fact(0)] }
    : { sections: [{ key: prompt.chapter.key, blocks: [candidate('可按交接责任核对业务处理动作。')] }] }, required)
  const incomplete = await generateChapters(second.options)
  assert.equal(incomplete.chapterOutcomes.find(row => row.key === 'cases').status, 'failed')
  assert.equal(incomplete.review.passed, false)
})

test('内部组稿说明不会借候选标记混入正文，修正失败仍保留同批合格段', async () => {
  const f = await fixture(prompt => prompt.stage === 'extract' ? { facts: [fact(0)] }
    : { sections: [{ key: 'service', blocks: prompt.failedBlocks.length
      ? [candidate('本批材料需要补充，组稿过程只给粗目录。')]
      : [candidate('可按统一记录核对团队之间的交接动作。'), candidate('本批材料需要补充，组稿过程只给粗目录。')] }] })
  const result = await generateChapters(f.options)
  assert.equal(result.chapterOutcomes[0].status, 'partial')
  assert.equal(result.sections[0].blocks.length, 1)
  assert.ok(!result.sections[0].blocks.some(row => row.text.includes('粗目录')))
  assert.equal(f.prompts.filter(row => row.stage === 'write').length, 2)
})

test('主题组织合并相同事实引文，但不丢不同状态或不同主题的有价值事实', () => {
  const first = { ...fact(0), capabilityStatus: 'pilot' }
  const grouped = organizeChapterFacts([first, { ...first, evidence: [ref, { id: 'E', quote: '销售和客服共享协作记录' }] },
    { ...first, capabilityStatus: 'planned' }, { ...fact(1), topic: '售后处理' }])
  assert.equal(grouped.facts.length, 3)
  assert.equal(grouped.facts[0].evidence.length, 2)
  assert.deepEqual(grouped.topics.map(row => row.title), ['线索交接', '售后处理'])
})

test('拆分子批鉴权失败会停止兄弟与后续批，不放大无效请求', async () => {
  let writes = 0
  const f = await fixture(prompt => {
    if (prompt.stage === 'extract') return { facts: Array.from({ length: 8 }, (_, i) => fact(i)) }
    writes++
    if (writes === 1) throw Object.assign(new Error('context length exceeded'), { code: 'CONTEXT_LENGTH_EXCEEDED' })
    throw Object.assign(new Error('凭证失效'), { code: 'AUTH', status: 401 })
  })
  const result = await generateChapters(f.options)
  assert.deepEqual(result.sections, [])
  assert.equal(result.chapterOutcomes[0].status, 'failed')
  assert.equal(writes, 2)
  assert.ok(f.state.chapters[0].failedBatches.some(row => row.batchId === 'remaining'))
})

test('邻近上下文中被排除的句子不能绕过本批事实引用权限', async () => {
  const approved = { id: 'E', quote: '产品支持统一记录线索' }
  const f = await fixture(prompt => prompt.stage === 'extract' ? { facts: [{ text: '产品支持统一记录线索。',
    subject: 'product', purpose: 'capability', supportMode: 'sourced', evidence: [approved] }] }
    : { sections: [{ key: 'service', blocks: prompt.failedBlocks.length
      ? [{ text: '当前定位仍需要进一步明确。', supportMode: 'sourced', evidence: [{ id: 'E', quote: '厂商自身定位不清' }] }]
      : [candidate('可按统一记录组织团队间的业务交接。'),
        { text: '当前定位仍需要进一步明确。', supportMode: 'sourced', evidence: [{ id: 'E', quote: '厂商自身定位不清' }] }] }] })
  f.options.evidence[0].content = '产品支持统一记录线索。厂商自身定位不清。'
  const result = await generateChapters(f.options)
  assert.equal(result.chapterOutcomes[0].status, 'partial')
  assert.equal(result.sections[0].blocks.length, 1)
  assert.ok(result.validationIssues.some(row => row.includes('本批已核验事实')))
})

test('客户主体未知的背景引用不升级客户已发生事实，局部修正保持候选', async () => {
  const f = await fixture(prompt => {
    if (prompt.stage === 'extract') return { facts: [{ text: '可通过统一记录衔接团队。', evidence: [ref] }] }
    return { sections: [{ key: 'needs', blocks: prompt.failedBlocks.length
      ? [candidate('如果团队交接缺少统一记录，可考虑先确认责任和记录方式。')]
      : [{ text: '客户目前缺少统一记录，影响团队交接。', supportMode: 'sourced', evidence: [ref] }] }] }
  }, [{ key: 'needs', title: '需求挑战', roleId: 'business-challenges', required: true }])
  const result = await generateChapters(f.options)
  assert.equal(result.sections[0].blocks[0].supportMode, 'candidate')
  assert.equal(f.prompts.filter(row => row.stage === 'write').length, 2)
  assert.ok(f.prompts.filter(row => row.stage === 'write').every(row => row.extraction.facts[0].supportMode === 'candidate'))
})

test('合稿修正继续执行本章用途与引文边界，拒绝污染时保留已通过原稿', async () => {
  const cases = [
    { roleId: 'company-profile', subject: 'company', purpose: 'company-profile', patch: candidate('可考虑提供更多团队介绍与相关服务，内容等待确认。') },
    { roleId: 'delivery-service', subject: 'product', purpose: 'capability', patch: candidate('本批材料需要补充，组稿过程只给粗目录。') },
    { roleId: 'delivery-service', subject: 'product', purpose: 'capability', patch: { text: '当前定位仍需要进一步明确。',
      supportMode: 'sourced', evidence: [{ id: 'E', quote: '厂商自身定位不清' }] } },
  ]
  for (const row of cases) {
    const f = await fixture(prompt => {
      if (prompt.stage === 'extract') return { facts: [{ text: quote, subject: row.subject, purpose: row.purpose, supportMode: 'sourced', evidence: [ref] }] }
      if (prompt.stage === 'relationship-repair') return { replacements: [{ ...row.patch, id: prompt.blocks[0].id }] }
      return { sections: [{ key: 'service', blocks: [{ text: quote, supportMode: 'sourced', evidence: [ref] }] }] }
    }, [{ key: 'service', title: '交接服务', roleId: row.roleId, required: true }], () => {
      const audit = completeAudit(); audit.checks[4].status = 'needs_review'; audit.repairNeeded = true; return audit
    })
    f.options.evidence[0].content += '厂商自身定位不清。'
    const result = await generateChapters(f.options)
    assert.equal(result.sections[0].blocks[0].text, quote)
    assert.equal(result.review.passed, false)
    assert.ok(result.reviewItems.some(text => text.includes('局部修正未完成')))
    assert.equal(f.prompts.filter(prompt => prompt.stage === 'relationship-repair').length, 1)
  }
})

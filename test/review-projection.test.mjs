import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { reviewAssembly, reviewGroups, REVIEW_CHECKS } from '../src/review.js'
import { completeAudit } from './helpers.mjs'

const quote = '原文条件：统一记录仅面向试点客户开放，第三方系统负责执行动作。'.repeat(100).slice(0, 2400)
const source = { id: 'K1', content: `前文条件应保留。${quote}后文条件也应保留。` }
const outline = [{ key: 'service', title: '协作服务', roleId: 'delivery-service' }]
const section = (node, count = 6) => ({ ...node, blocks: Array.from({ length: count }, (_, index) => ({
  id: `${node.key}-${index + 1}`, text: `可考虑通过统一记录确认本场景的交接责任与核对动作。${index}`,
  supportMode: 'candidate', evidence: [{ id: source.id, quote }],
  planRefs: { capabilityIds: ['cap-record'], scenarioIds: ['scenario-handoff'], problemIds: ['problem-handoff'], trendIds: [] },
  capabilityStatus: 'pilot', capabilityOwnership: 'third-party',
})) })
const plan = { capabilities: [], problems: [], trends: [], scenarios: [] }
async function fixture(common = { qualityMode: 'draft' }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wlyd-review-projection-')), prompts = [], state = {}
  return { prompts, options: { dir, common, state, plan, outline, sections: [section(outline[0])], evidence: [source],
    saveState: async () => {}, signal: new AbortController().signal, allowRepairs: false,
    sourceWindowProjection: true, request: async prompt => { prompts.push(prompt); return completeAudit() } } }
}

test('初稿六段复用同一原文窗时只传一份完整原文，段落改用准确位置并减少分组', async () => {
  const f = await fixture()
  const original = structuredClone(f.options.sections)
  const before = reviewGroups(original, outline)
  const after = reviewGroups(original, outline, { sourceWindowProjection: true, evidence: [source] })
  assert.ok(after.length < before.length)
  const result = await reviewAssembly(f.options)
  assert.equal(f.prompts.length, 1)
  const prompt = f.prompts[0]
  assert.equal(prompt.sourceProjection.version, 1)
  assert.equal(prompt.evidence.length, 1)
  assert.ok(prompt.evidence[0].content.includes(quote))
  assert.ok(prompt.evidence[0].content.includes('前文条件'))
  assert.ok(prompt.evidence[0].content.includes('后文条件'))
  assert.deepEqual(prompt.checks, REVIEW_CHECKS)
  assert.equal(prompt.sections.length, 6)
  for (const block of prompt.sections) {
    assert.equal(Object.hasOwn(block.evidence[0], 'quote'), false)
    const { start, end } = block.evidence[0].span
    assert.equal(source.content.slice(start, end), quote)
    assert.deepEqual(block.planRefs, original[0].blocks[0].planRefs)
  }
  assert.ok(JSON.stringify(prompt.sections).length < JSON.stringify(original[0].blocks).length / 2)
  assert.deepEqual(result.sections, original, '投影不得改写存档或交付正文引用')
  assert.equal(result.review.coverage.paragraphs.total, 6)
  assert.equal(result.review.coverage.paragraphs.completed, 6)
  assert.deepEqual(result.review.coverage.paragraphs.uncheckedIds, [])
})

test('投影调整分组仍保留全部段落和每条显式跨章关系', () => {
  const nodes = [{ key: 'needs', title: '需求挑战', roleId: 'business-challenges' },
    { key: 'scenario', title: '交接场景', roleId: 'scenario-solution' },
    { key: 'map', title: '业务全景', roleId: 'business-architecture' }]
  const sections = nodes.map(node => section(node))
  const before = reviewGroups(sections, nodes)
  const after = reviewGroups(sections, nodes, { sourceWindowProjection: true, evidence: [source] })
  assert.ok(after.length < before.length)
  const paragraphs = jobs => new Set(jobs.filter(job => job.kind === 'chapter').flatMap(job => job.blocks.map(block => block.id)))
  const edges = jobs => new Set(jobs.flatMap(job => job.relationships.flatMap(relation => relation.targetIds.map(id => `${relation.focusId}->${id}`))))
  assert.deepEqual(paragraphs(after), paragraphs(before))
  assert.deepEqual(edges(after), edges(before))
  assert.ok(after.every(job => job.sourceWindowProjectionVersion === 1))
  assert.ok(after.flatMap(job => job.blocks).every(block => block.evidence[0].quote === quote), '分组job保留完整引用供取证')
})

test('不同长窗口仍计入分组预算，投影不会把多份原文硬塞进同一请求', () => {
  const evidence = Array.from({ length: 6 }, (_, i) => ({ id: `K${i}`, content: `第${i}份材料。${quote}` }))
  const sections = [section(outline[0])]
  sections[0].blocks = sections[0].blocks.map((block, i) => ({ ...block, evidence: [{ id: evidence[i].id, quote: evidence[i].content }] }))
  const groups = reviewGroups(sections, outline, { sourceWindowProjection: true, evidence })
  assert.ok(groups.length > 1)
  assert.equal(new Set(groups.flatMap(group => group.blocks.map(block => block.id))).size, 6)
})

test('strict与未显式启用的改单章复核保持原提示词和分组', async () => {
  const strict = await fixture({ qualityMode: 'strict' })
  await reviewAssembly(strict.options)
  assert.equal(strict.prompts.length, reviewGroups(strict.options.sections, outline).length)
  assert.ok(strict.prompts.every(prompt => !Object.hasOwn(prompt, 'sourceProjection') && prompt.sections.every(block => block.evidence[0].quote === quote)))
  const revise = await fixture()
  delete revise.options.sourceWindowProjection
  await reviewAssembly(revise.options)
  assert.equal(revise.prompts.length, reviewGroups(revise.options.sections, outline).length)
  assert.ok(revise.prompts.every(prompt => !Object.hasOwn(prompt, 'sourceProjection') && prompt.sections.every(block => block.evidence[0].quote === quote)))
})

test('初稿复核缓存绑定实际正文、完整原文及投影版本，不能复用旧内容结果', async () => {
  const f = await fixture()
  await reviewAssembly(f.options)
  assert.equal(f.prompts.length, 1)
  await reviewAssembly(f.options)
  assert.equal(f.prompts.length, 1, '同稿同来源复用已完成检查')
  f.options.sections[0].blocks[0].text += '新增的业务核对要求。'
  await reviewAssembly(f.options)
  assert.equal(f.prompts.length, 2, '正文改变触发新检查')
  f.options.evidence = [{ ...source, content: source.content + '新增适用条件。' }]
  await reviewAssembly(f.options)
  assert.equal(f.prompts.length, 3, '完整来源选段改变触发新检查')
  const audit = JSON.parse(await readFile(path.join(f.options.dir, 'consistency-review.json'), 'utf8'))
  assert.equal(audit.reviewVersion, 3)
  assert.equal(audit.coverage.paragraphs.completed, 6)
})

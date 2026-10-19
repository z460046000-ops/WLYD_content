import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePlan } from '../src/plan-model.js'
import { reportText, reviewDocument, reviewText, validateDraft } from '../src/content.js'

const outline = [
  { key: 'business-map', title: '业务全景', roleId: 'business-architecture' },
  { key: 'scene', title: '交接场景', roleId: 'scenario-solution' },
  { key: 'platform', title: '技术平台', roleId: 'technical-platform' },
]
const evidence = [
  { id: 'E1', content: '可考虑建设自动交接核对能力，具体范围待确认。' },
  { id: 'E2', content: '产品支持统一记录线索，销售和客服可共同查看。' },
]
const ref = index => ({ id: evidence[index].id, quote: evidence[index].content })
const raw = { capabilities: [
  { id: 'cap-candidate', text: '自动交接核对', supportMode: 'candidate', subject: 'product', purpose: 'capability',
    capabilityStatus: 'existing', capabilityOwnership: 'self', evidence: [ref(0)] },
  { id: 'cap-existing', text: '统一记录线索', supportMode: 'sourced', subject: 'product', purpose: 'capability',
    capabilityStatus: 'existing', capabilityOwnership: 'self', evidence: [ref(1)] },
] }
const plan = normalizePlan(raw, evidence, outline)
const candidate = (text, capabilityId = 'cap-candidate') => ({ text, supportMode: 'candidate', evidence: [],
  planRefs: { capabilityIds: [capabilityId] } })

test('规划中的候选能力不能同时标为已具备或自有，有据能力保持原状态', () => {
  assert.deepEqual(plan.capabilities.map(row => [row.id, row.supportMode, row.capabilityStatus, row.capabilityOwnership]), [
    ['cap-candidate', 'candidate', 'unknown', 'unknown'],
    ['cap-existing', 'sourced', 'existing', 'self'],
  ])
  assert.ok(plan.reviewItems.some(item => item.includes('cap-candidate') && item.includes('撤销')))
})

test('模型误标 sourced 时，能力原文含明确推演仍按候选处理', () => {
  const mislabelled = normalizePlan({ capabilities: [{ id: 'cap-mislabelled', text: '自动交接核对',
    supportMode: 'sourced', subject: 'product', purpose: 'capability', capabilityStatus: 'existing',
    capabilityOwnership: 'self', evidence: [ref(0)] }] }, evidence, outline)
  assert.equal(mislabelled.capabilities[0].supportMode, 'candidate')
  assert.equal(mislabelled.capabilities[0].capabilityStatus, 'unknown')
  assert.equal(mislabelled.capabilities[0].capabilityOwnership, 'unknown')
})

test('全景、场景和技术章均拒绝把候选写成已有能力，同时保留合格段落', () => {
  const draft = { sections: [
    { key: 'business-map', blocks: [
      candidate('可按已有、自有产品能力呈现业务全景。'),
      candidate('可考虑围绕交接核对规划业务节点，具体范围待确认。'),
    ] },
    { key: 'scene', blocks: [
      { text: '平台已有自动交接核对能力，可直接交付这一场景。', supportMode: 'sourced',
        evidence: [ref(0)], planRefs: { capabilityIds: ['cap-candidate'] } },
      candidate('可考虑在场景中规划交接核对动作，待确认产品范围。'),
    ] },
    { key: 'platform', blocks: [
      candidate('本产品已实现自动交接核对能力。'),
      { text: '按已有、自有产品能力提供技术支持。', supportMode: 'candidate', evidence: [] },
      candidate('可考虑设置交接核对接口，具体实现待确认。'),
    ] },
  ] }
  const checked = validateDraft(draft, evidence, outline, plan)
  assert.deepEqual(checked.sections.map(section => section.blocks.length), [1, 1, 1])
  assert.equal(checked.issues.length, 4)
  assert.ok(checked.issues.some(item => item.includes('scene') && item.includes('已有')))
})

test('明确否定的说法不误判；同句随后出现肯定断言仍拦截；有据已有能力可正常引用', () => {
  const checked = validateDraft({ sections: [{ key: 'scene', blocks: [
    candidate('不能把候选功能写成已有或自有能力，可考虑后续核对交接责任。'),
    candidate('不是已有能力而是已实现自动交接核对。'),
    candidate('可考虑用现有的统一记录线索支撑交接确认。', 'cap-existing'),
  ] }] }, evidence, outline, plan)
  assert.equal(checked.sections[0].blocks.length, 2)
  assert.equal(checked.issues.length, 1)
  assert.match(checked.sections[0].blocks[1].text, /现有的统一记录线索/u)
})

test('旧版已确认目录中的候选加已有标签不会挡住安全改写', () => {
  const legacy = { capabilities: [{ ...plan.capabilities[0], capabilityStatus: 'existing', capabilityOwnership: 'self' }] }
  const checked = validateDraft({ sections: [{ key: 'scene', blocks: [
    candidate('可考虑规划交接核对能力，实际产品范围待确认。'),
    candidate('产品已有自有交接核对能力。'),
  ] }] }, evidence, outline, legacy)
  assert.equal(checked.sections[0].blocks.length, 1)
  assert.equal(checked.sections[0].blocks[0].capabilityStatus, 'proposed')
  assert.equal(checked.sections[0].blocks[0].capabilityOwnership, 'unknown')
  assert.equal(checked.issues.length, 1)
})

test('客户现有记录和系统可用于场景推演；产品现有与明确能力断言被拒绝', () => {
  const checked = validateDraft({ sections: [{ key: 'scene', blocks: [
    candidate('先整合客户现有线索记录，再设计协同处理流程。'),
    candidate('根据客户现有业务系统规划对接方式，具体范围待确认。'),
    candidate('可考虑让平台支持自动处理，需进一步核对产品范围。'),
    candidate('平台现有产品能力可直接完成交接核对。'),
    candidate('本产品具备自动核对能力。'),
    candidate('平台支持自动处理。'),
    candidate('还未上线但已经具备自动核对能力。'),
    candidate('公司已经交付自动交接核对能力。'),
  ] }] }, evidence, outline, plan)
  assert.equal(checked.sections[0].blocks.length, 3)
  assert.equal(checked.issues.length, 5)
  assert.match(checked.sections[0].blocks[0].text, /客户现有线索记录/u)
})

test('零正文失败保留目录占位，并明确标注生成失败', () => {
  const failed = { title: '测试方案', outline: [outline[0]], sections: [],
    chapterOutcomes: [{ key: 'business-map', status: 'failed' }], reviewStatus: 'failed' }
  assert.match(reportText(failed), /生成未完成：没有可校验正文/u)
  assert.match(reportText(failed), /生成故障：本章尚未完成，不能据此认定缺料/u)
  assert.match(reviewText(reviewDocument(failed)), /稿件状态：生成失败/u)
})

test('章节齐全但合稿复核未通过时，报告显式提示查审核清单', () => {
  const report = { title: '测试方案', outline: [outline[0]], reviewStatus: 'needs_human_review',
    sections: [{ key: 'business-map', blocks: [{ text: '可考虑先确认业务交接责任。', supportMode: 'candidate', evidence: [] }] }],
    chapterOutcomes: [{ key: 'business-map', status: 'completed' }], assemblyReview: { passed: false } }
  const text = reportText(report)
  assert.match(text, /合稿复核未通过，须查看独立审核清单/u)
  assert.doesNotMatch(text, /部分草稿/u)
  assert.equal(report.reviewStatus, 'needs_human_review')
})

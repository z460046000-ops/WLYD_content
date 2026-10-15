import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { generateChapters, normalizePlan } from '../src/generation.js'
import { validateDraft } from '../src/content.js'
import { loadRules } from '../src/rules.js'
import { enrichPanoramas, panoramaCoverage } from '../src/panorama.js'

const outline = [
  { key: 'business-map', title: '业务运转全景', roleId: 'business-architecture' },
  { key: 'product-map', title: '功能支撑全景', roleId: 'product-architecture' },
  { key: 'handoff', title: '跨团队交接', roleId: 'scenario-solution' },
  { key: 'platform', title: '技术平台', roleId: 'technical-platform' },
]
const evidence = [{ id: 'M1', content: '产品支持统一线索记录。预警功能处于规划阶段。签署通过第三方平台集成，仍在试点。' }]
const shared = {
  title: '线索协作方案', capabilities: [
    { id: 'cap-record', text: '统一记录', capabilityStatus: 'existing', capabilityOwnership: 'self', evidence: [{ id: 'M1', quote: '产品支持统一线索记录' }] },
    { id: 'cap-alert', text: '规划预警', capabilityStatus: 'planned', capabilityOwnership: 'self', evidence: [{ id: 'M1', quote: '预警功能处于规划阶段' }] },
    { id: 'cap-sign', text: '第三方签署', capabilityStatus: 'pilot', capabilityOwnership: 'third-party', evidence: [{ id: 'M1', quote: '签署通过第三方平台集成，仍在试点' }] },
  ], problems: [{ id: 'problem-handoff', text: '可考虑应对交接不清' }],
  scenarios: [{ id: 'scenario-handoff', title: '销售交接', capabilityIds: ['cap-record'], problemIds: ['problem-handoff'] }],
  chapterGuidance: outline.slice(0, 2).map(node => ({ key: node.key, title: node.title, organization: {
    purpose: '解释跨团队协作', scope: '从线索建立到交接确认', dimensions: ['交接前', '交接中', '交接后'], reason: '围绕关键交接问题组织，避免按部门割裂业务' },
  })),
}
const candidate = (text, scenario = false) => ({ text, supportMode: 'candidate', evidence: [],
  planRefs: { capabilityIds: ['cap-record'], problemIds: ['problem-handoff'], scenarioIds: scenario ? ['scenario-handoff'] : [], trendIds: [] } })
const agent = { options: { provider: 'fake', model: 'fake' } }
const fakeModel = handler => ({ async *stream(request) {
  const output = await handler(JSON.parse(request.messages[0].content[0].text), request.signal)
  yield { type: 'text-delta', text: JSON.stringify(output) }
  yield { type: 'finish', reason: { kind: 'stop' } }
} })
const response = prompt => prompt.stage === 'plan' ? shared
  : prompt.stage === 'extract' ? { facts: [], writingOutline: [] }
  : prompt.stage === 'write' ? { sections: [{ key: prompt.chapter.key, blocks: [{ ...candidate('可考虑依据统一记录组织协作，明确交接责任与业务状态。', prompt.chapter.key === 'handoff'), id: `${prompt.chapter.key}-2` }] }] }
  : prompt.stage === 'panorama-enrichment' ? { additions: [], reviewItems: [] }
  : { reviewItems: [] }

async function generationFixture(handler = response, signal = new AbortController().signal) {
  const rules = await loadRules()
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wlyd-panorama-'))
  const state = {}
  const options = { acceptedPlan: normalizePlan(shared, evidence, outline), llm: fakeModel(handler), exec: { agent, signal }, args: {}, rules, outline, evidence, dir, state, saveState: async () => {} }
  return { options, dir, state }
}

test('组织维度由共享规划选择，任意业务维度可保留，两图规则进入规划和逐章生成', async () => {
  const rules = await loadRules()
  const other = structuredClone(shared)
  other.chapterGuidance[0].organization = { purpose: '解释供需协作', scope: '上下游合作', dimensions: ['供应侧', '服务撮合', '需求侧', '合作保障'], reason: '用协作关系解释业务边界' }
  const left = normalizePlan(shared, evidence, outline)
  const right = normalizePlan(other, evidence, outline)
  assert.equal(left.chapterGuidance[0].organization.dimensions.length, 3)
  assert.equal(right.chapterGuidance[0].organization.dimensions.length, 4)
  assert.deepEqual(right.chapterGuidance[0].organization.dimensions, other.chapterGuidance[0].organization.dimensions)
  assert.equal(rules.chapters['business-architecture'].organization.examplesOnly, true)
  assert.equal(rules.chapters['product-architecture'].organization.examplesOnly, true)
  const f = await generationFixture(prompt => {
    assert.ok(prompt.evidence.every(row => row.id === 'M1'))
    if (prompt.stage === 'plan') assert.ok(prompt.panoramaRules['business-architecture'].organization.examplesOnly)
    if (prompt.stage === 'write' && prompt.chapter.key.endsWith('-map')) {
      assert.deepEqual(prompt.organization.dimensions, ['交接前', '交接中', '交接后'])
      assert.ok(prompt.chapterRule.validate.some(item => item.includes('价值机制')))
    }
    return response(prompt)
  })
  await generateChapters(f.options)
  const saved = JSON.parse(await readFile(path.join(f.dir, 'plan.json'), 'utf8'))
  assert.equal(saved.chapterGuidance[0].organization.reason, shared.chapterGuidance[0].organization.reason)
})

test('合稿后最多一轮补充，只追加两类全景，旧段落和非全景文件不变，场景覆盖重新计算', async () => {
  const calls = []
  const f = await generationFixture(prompt => {
    calls.push(prompt.stage)
    if (prompt.stage === 'panorama-enrichment') {
      assert.equal(calls.filter(stage => stage === 'write').length, outline.length)
      assert.deepEqual(prompt.coverageBefore.map(item => item.missingScenarioIds), [['scenario-handoff'], ['scenario-handoff']])
      return { additions: prompt.targetChapters.map(node => ({ key: node.key, blocks: [candidate('可补充交接确认这一上级节点，通过统一记录让责任人与接收方核对输出，回应交接信息不一致。', true)] })), reviewItems: [] }
    }
    if (prompt.stage === 'consistency-review') assert.ok(prompt.sections.length > 0)
    return response(prompt)
  })
  const generated = await generateChapters(f.options)
  assert.equal(calls.filter(stage => stage === 'panorama-enrichment').length, 1)
  assert.ok(calls.indexOf('panorama-enrichment') < calls.indexOf('consistency-review'))
  assert.deepEqual(generated.sections.map(section => section.key), outline.map(node => node.key))
  for (const key of ['business-map', 'product-map']) {
    const initial = JSON.parse(await readFile(path.join(f.dir, 'chapters', key, 'chapter.json'), 'utf8'))
    const enriched = JSON.parse(await readFile(path.join(f.dir, 'chapters', key, 'enriched.json'), 'utf8'))
    assert.deepEqual(enriched.section.blocks[0], initial.section.blocks[0])
    assert.equal(initial.section.blocks[0].id, `${key}-1`)
    assert.equal(enriched.section.blocks[1].id, `${key}-2`)
    assert.equal(generated.sections.find(section => section.key === key).blocks.length, 2)
    assert.equal(f.state.chapters.find(chapter => chapter.key === key).path, `chapters/${key}/enriched.json`)
  }
  assert.ok(!(await readdir(path.join(f.dir, 'chapters/platform'))).includes('enriched.json'))
  const record = JSON.parse(await readFile(path.join(f.dir, 'panorama-enrichment.json'), 'utf8'))
  assert.equal(record.additions, 2)
  assert.ok(record.coverageAfter.every(item => item.missingScenarioIds.length === 0))
  assert.equal(generated.gaps.length, 0)
})

test('补充过滤越界、无据数字、未知 ID、能力升级和重复内容，仍可接受其他有效段落', async () => {
  const f = await generationFixture(prompt => {
    if (prompt.stage !== 'panorama-enrichment') return response(prompt)
    return { additions: [
      { key: 'platform', blocks: [candidate('不允许补充到技术平台这一非全景章节。')] },
      { key: 'business-map', blocks: [
        candidate('可考虑依据统一记录组织协作，明确交接责任与业务状态。'),
        candidate('可将业务处理效率提升90%，并进行追踪。', true),
        { ...candidate('可补充一个来自未知场景的业务节点。'), planRefs: { scenarioIds: ['unknown-scenario'] } },
        { text: '预警功能已上线，产品具备全面自动预警能力。', supportMode: 'sourced', capabilityStatus: 'existing', evidence: [{ id: 'M1', quote: '预警功能处于规划阶段' }], planRefs: { capabilityIds: ['cap-alert'] } },
        candidate('可围绕交接输出增加核对节点，帮助明确后续跟进责任。', true),
      ] },
    ] }
  })
  const generated = await generateChapters(f.options)
  assert.equal(generated.sections.find(s => s.key === 'business-map').blocks.length, 2)
  assert.equal(f.state.panoramaEnrichment.status, 'partial')
  assert.equal(f.state.panoramaEnrichment.rounds, 1)
  assert.equal(f.state.panoramaEnrichment.additions, 1)
  assert.ok(generated.validationIssues.length >= 4)
  assert.ok(generated.reviewItems.some(item => item.includes('product-map') && item.includes('scenario-handoff')))
})

test('补充请求失败或结构无效均保留原稿，不重试、不阻断成稿', async () => {
  for (const malformed of [false, true]) {
    let attempts = 0
    const f = await generationFixture(prompt => {
      if (prompt.stage !== 'panorama-enrichment') return response(prompt)
      attempts++
      if (malformed) return { sections: [] }
      throw new Error('supplement unavailable')
    })
    const generated = await generateChapters(f.options)
    assert.equal(attempts, 1)
    assert.equal(generated.sections.length, 4)
    assert.ok(generated.sections.every(section => section.blocks.length === 1))
    assert.equal(f.state.panoramaEnrichment.status, 'failed')
    assert.ok(generated.reviewItems.some(item => item.includes('保留原稿')))
    assert.equal(generated.gaps.length, 0)
    assert.ok(!(await readdir(path.join(f.dir, 'chapters/business-map'))).includes('enriched.json'))
  }
})

test('没有全景或没有场景时跳过补充，不新建目录外章节', async () => {
  for (const subset of [outline.filter(node => !node.key.endsWith('-map')), outline.filter(node => node.key !== 'handoff')]) {
    const f = await generationFixture(prompt => {
      assert.notEqual(prompt.stage, 'panorama-enrichment')
      return response(prompt)
    })
    f.options.outline = subset
    const generated = await generateChapters(f.options)
    assert.deepEqual(generated.sections.map(section => section.key), subset.map(node => node.key))
    assert.equal(f.state.panoramaEnrichment.status, 'skipped')
    assert.equal(f.state.panoramaEnrichment.rounds, 0)
  }
})

test('补充阶段取消保留初稿并停止合稿复核', async () => {
  const controller = new AbortController()
  const f = await generationFixture(prompt => {
    if (prompt.stage === 'panorama-enrichment') { controller.abort(new Error('取消全景补充')); throw controller.signal.reason }
    assert.notEqual(prompt.stage, 'consistency-review')
    return response(prompt)
  }, controller.signal)
  await assert.rejects(generateChapters(f.options), /取消全景补充/u)
  assert.equal(f.state.panoramaEnrichment.status, 'cancelled')
  assert.ok(f.state.chapters.every(chapter => chapter.status === 'completed'))
  assert.ok(await readFile(path.join(f.dir, 'chapters/business-map/chapter.json'), 'utf8'))
})

test('第三方与试点规划保持状态边界，显式升级被过滤，未知不默认自有或已具备', () => {
  const plan = normalizePlan(shared, evidence, outline)
  const section = { key: 'product-map', blocks: [
    { text: '签署可通过第三方平台集成，目前仍在试点，尚未全面上线，非自研。', evidence: [{ id: 'M1', quote: '签署通过第三方平台集成，仍在试点' }], planRefs: { capabilityIds: ['cap-sign'] } },
    { text: '统一记录可支撑团队依据同一信息交接线索。', evidence: [{ id: 'M1', quote: '产品支持统一线索记录' }] },
    { text: '签署属于自主研发功能，面向所有业务全面上线。', capabilityOwnership: 'self', capabilityStatus: 'existing', evidence: [{ id: 'M1', quote: '签署通过第三方平台集成，仍在试点' }], planRefs: { capabilityIds: ['cap-sign'] } },
    { text: '预警已经上线，能够自动识别所有异常。', capabilityStatus: 'existing', evidence: [{ id: 'M1', quote: '预警功能处于规划阶段' }], planRefs: { capabilityIds: ['cap-alert'] } },
    { text: '预警功能处于规划阶段，建议明确触发条件和责任人。', evidence: [{ id: 'M1', quote: '预警功能处于规划阶段' }], planRefs: { capabilityIds: ['cap-alert'] } },
  ] }
  const checked = validateDraft({ sections: [section] }, evidence, outline, plan)
  assert.equal(checked.sections[0].blocks.length, 3)
  assert.equal(checked.issues.length, 2)
  const [external, unknown, planned] = checked.sections[0].blocks
  assert.equal(external.capabilityOwnership, 'third-party')
  assert.equal(external.capabilityStatus, 'pilot')
  assert.match(external.text, /【试点中·第三方能力】/u)
  assert.equal(unknown.capabilityStatus, 'unknown')
  assert.equal(unknown.capabilityOwnership, 'unknown')
  assert.match(planned.text, /【规划中】/u)
  assert.deepEqual(validateDraft({ sections: checked.sections }, evidence, outline, plan).sections, checked.sections)
  const suggestion = { ...candidate('可考虑用现有的统一记录支撑交接核对，这一流程组织仍请确认。'), capabilityStatus: 'existing' }
  assert.equal(validateDraft({ sections: [{ key: 'product-map', blocks: [suggestion] }] }, evidence, outline, plan).sections[0].blocks[0].supportMode, 'candidate')
  assert.throws(() => validateDraft({ sections: [{ key: 'product-map', blocks: [{ ...suggestion, planRefs: {} }] }] }, evidence, outline, plan), /升级为已具备/u)
  const mixed = { text: '统一记录为现有能力，预警为规划方向；签署仍在第三方试点，不能写成全面具备或自研。', capabilityStatus: 'existing', capabilityOwnership: 'self', evidence: [{ id: 'M1', quote: evidence[0].content }], planRefs: { capabilityIds: ['cap-record', 'cap-alert', 'cap-sign'] } }
  const grouped = validateDraft({ sections: [{ key: 'product-map', blocks: [mixed] }] }, evidence, outline, plan)
  assert.equal(grouped.sections[0].blocks[0].capabilityStatus, 'unknown')
  assert.equal(grouped.sections[0].blocks[0].capabilityOwnership, 'unknown')
  assert.ok(grouped.reviewItems.some(item => item.includes('同段')))
  const qualified = { ...section.blocks[0], text: '电子签署仍在试点，不能写成全面具备；它属于第三方集成，不把它写成自研能力。' }
  assert.equal(validateDraft({ sections: [{ key: 'product-map', blocks: [qualified] }] }, evidence, outline, plan).sections[0].blocks.length, 1)
})

test('落盘失败不改原稿和运行指针，全景覆盖仅为 ID 提示', async () => {
  const f = await generationFixture()
  const plan = normalizePlan(shared, evidence, outline)
  const chapters = outline.map(node => ({ section: validateDraft(response({ stage: 'write', chapter: node }), evidence, [node], plan).sections[0], gaps: [], reviewItems: [], validationIssues: [] }))
  f.state.chapters = chapters.map(chapter => ({ key: chapter.section.key, path: `chapters/${chapter.section.key}/chapter.json` }))
  await mkdir(path.join(f.dir, 'chapters/business-map'), { recursive: true })
  await writeFile(path.join(f.dir, 'chapters/business-map/enriched.json'), 'untouched')
  // The second target directory is intentionally absent, forcing a disk error.
  const before = structuredClone(chapters)
  const result = await enrichPanoramas({ ...f.options, chapters, plan, common: {}, signal: f.options.exec.signal,
    request: async () => ({ additions: outline.slice(0, 2).map(node => ({ key: node.key, blocks: [candidate('可将交接核对作为关键节点，让输出与责任能够相互对应。', true)] })) }) })
  assert.deepEqual(result.chapters, before)
  assert.ok(f.state.chapters.every(chapter => chapter.path.endsWith('chapter.json')))
  assert.equal(f.state.panoramaEnrichment.status, 'failed')
  assert.ok(panoramaCoverage(chapters.map(chapter => chapter.section), outline).every(item => item.missingScenarioIds.includes('scenario-handoff')))
})

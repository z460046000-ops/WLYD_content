import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { buildDiagram, diagramSources } from '../src/outputs/diagrams/plan.js'
import { renderDiagram } from '../src/outputs/diagrams/render.js'

const python = process.env.PYTHON || 'python3'
const checks = ['xml', 'markers', 'collisions', 'geometry', 'composition']

function snapshot() {
  return { sourceContentSha256: '9'.repeat(64), sections: [
    { key: 'business', roleId: 'business-architecture', title: '业务架构', version: 3,
      blocks: [{ id: 'business-1', text: '需求受理通过业务协同进入方案交付。需客户授权后试点。',
        supportMode: 'candidate', verification: 'unverified', capabilityStatus: 'pilot', capabilityOwnership: 'third-party',
        conditions: ['需客户授权后试点'], evidence: [{ id: 'e-business', quote: '需求受理通过业务协同进入方案交付。' }] }] },
    { key: 'product', roleId: 'product-architecture', title: '产品功能架构', version: 5,
      blocks: [{ id: 'product-1', text: '能力入口通过统一组件支撑流程管理。',
        supportMode: 'sourced', verification: 'verified', capabilityStatus: 'existing', capabilityOwnership: 'customer',
        evidence: [{ id: 'e-product', quote: '能力入口通过统一组件支撑流程管理。' }] }] },
    { key: 'company', roleId: 'company', title: '公司介绍', version: 1,
      blocks: [{ id: 'company-1', text: '此章公司介绍不作为业务和产品图来源。' }] }
  ] }
}

function extraction({ diagramKind, units }) {
  const business = diagramKind === 'business'
  return { nodes: [
    { id: 'start', label: business ? '需求受理' : '能力入口', unitIds: [units[0].id] },
    { id: 'end', label: business ? '方案交付' : '流程管理', unitIds: [units[0].id] }
  ], edges: [{ source: 'start', target: 'end', label: business ? '进入' : '支撑', unitIds: [units[0].id] }] }
}

function sourceMetadata(svg) {
  const value = svg.match(/<metadata id="wlyd-source">([\s\S]*?)<\/metadata>/u)?.[1]
  assert.ok(value, 'SVG 应带有固定文案来源信息')
  return JSON.parse(value.replace(/&quot;/gu, '"').replace(/&apos;/gu, "'").replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&amp;/gu, '&'))
}

test('业务与产品中文图实际经 fireworks 渲染和五项校验，来源版本写入 SVG', async t => {
  const probe = spawnSync(python, ['-B', '-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3,9) else 1)'], { encoding: 'utf8' })
  if (probe.error?.code === 'ENOENT') return t.skip('本机没有 Python；真实渲染未验证')
  assert.ifError(probe.error)
  assert.equal(probe.status, 0, '实际渲染需要 Python 3.9+')
  const outputDir = await mkdtemp(join(tmpdir(), 'assembly-diagrams-render-'))
  t.after(() => rm(outputDir, { recursive: true, force: true }))
  const source = snapshot(), before = structuredClone(source)
  for (const kind of ['business', 'product']) {
    const plan = await buildDiagram({ snapshot: source, kind, request: async prompt => extraction(prompt) })
    assert.equal(plan.status, 'planned')
    assert.equal(plan.mode, 'extractive-diagram')
    assert.equal(plan.sources.length, 1, '各图使用对应架构章节')
    assert.equal(plan.edges.length, 1)
    const result = await renderDiagram(plan, { outputDir, python })
    assert.equal(result.path, join(outputDir, `${kind}.svg`))
    assert.deepEqual(result.validation, checks)
    assert.equal(result.visualReview, 'pending')
    assert.equal(result.semanticStatus, 'draft_unverified')
    const svg = await readFile(result.path, 'utf8')
    for (const node of plan.nodes) assert.ok(svg.includes(node.label), node.label)
    assert.ok(svg.includes(kind === 'business' ? '候选·待确认 / 试点 / 第三方' : '原文提炼·待复核 / 现有 / 客户能力'))
    assert.deepEqual(sourceMetadata(svg), {
      sourceContentSha256: source.sourceContentSha256, semanticStatus: 'draft_unverified',
      mode: 'extractive-diagram', sourceBlockIds: [`${kind}-1`]
    })
    const report = JSON.parse(await readFile(result.reportPath, 'utf8'))
    assert.equal(report.ok, true)
    assert.deepEqual(report.issues, [])
    assert.equal(JSON.parse(await readFile(result.inputPath, 'utf8')).text_policy, 'strict')
  }
  assert.deepEqual(source, before, '制图不能改正文及其版本')
})

test('模型未知来源、虚构名称和无原文明示关系被排除，保留可定位节点和连线', async () => {
  const plan = await buildDiagram({ snapshot: snapshot(), kind: 'business', request: async prompt => {
    const good = extraction(prompt), unitId = prompt.units[0].id
    return { nodes: [...good.nodes,
      { id: 'unknown', label: '未知模块', unitIds: ['u-not-exists'] },
      { id: 'invented', label: '营收增长百分之八十', unitIds: [unitId] }
    ], edges: [...good.edges,
      { source: 'start', target: 'end', label: '自动调用', unitIds: [unitId] },
      { source: 'start', target: 'end', label: '进入', unitIds: ['u-not-exists'] }
    ] }
  } })
  assert.deepEqual(plan.nodes.map(node => node.label).sort(), ['方案交付', '需求受理'].sort())
  assert.equal(plan.edges.length, 1)
  assert.equal(plan.edges[0].label, '进入')
  assert.equal(plan.mode, 'source-overview')
  assert.ok(plan.warnings.some(message => message.includes('未知来源')))
  assert.ok(plan.warnings.some(message => message.includes('无法在本章原文定位')))
  assert.ok(plan.warnings.some(message => message.includes('连线已拒绝')))
})

test('长正文所有分片都交给模型处理，尾部和覆盖关系不因分批丢失', async () => {
  const source = snapshot()
  const text = '这是完整长文中的业务模块与条件说明。'.repeat(650) + '末尾关键能力需要客户授权后试点。'
  source.sections = [{ ...source.sections[0], blocks: [{ ...source.sections[0].blocks[0], text }] }]
  const calls = []
  const plan = await buildDiagram({ snapshot: source, kind: 'business', request: async prompt => {
    calls.push(prompt)
    return { nodes: prompt.units.map((unit, index) => ({ id: `local-${index}`, label: unit.text.slice(0, 16), unitIds: [unit.id] })), edges: [] }
  } })
  const units = diagramSources(source, 'business')
  assert.ok(calls.length >= 2, '长文必须分批')
  assert.equal(units.map(unit => unit.text).join(''), text)
  assert.deepEqual(calls.flatMap(call => call.units.map(unit => unit.id)), units.map(unit => unit.id))
  assert.deepEqual([...new Set(plan.nodes.flatMap(node => node.unitIds))].sort(), units.map(unit => unit.id).sort())
  assert.ok(calls.at(-1).units.at(-1).text.endsWith('末尾关键能力需要客户授权后试点。'))
  assert.equal(plan.mode, 'extractive-diagram')
  assert.deepEqual(plan.warnings, [])
})

test('模型故障返回有来源的原文摘录；无相关章节时明确 needs_input', async () => {
  const source = snapshot()
  const fallback = await buildDiagram({ snapshot: source, kind: 'business', request: async () => { throw new Error('模拟提炼超时') } })
  assert.equal(fallback.status, 'planned')
  assert.equal(fallback.mode, 'source-overview')
  assert.equal(fallback.nodes.length, fallback.sources.length)
  assert.deepEqual(fallback.edges, [])
  assert.deepEqual(fallback.nodes[0].sourceBlockIds, ['business-1'])
  assert.ok(fallback.sources[0].text.includes(fallback.nodes[0].label))
  assert.ok(fallback.warnings.some(message => message.includes('模拟提炼超时')))
  const unrelated = { ...source, sections: [source.sections[2]] }
  let requests = 0
  const missing = await buildDiagram({ snapshot: unrelated, kind: 'business', request: async () => { requests++; return {} } })
  assert.equal(missing.status, 'needs_input')
  assert.deepEqual(missing.nodes, [])
  assert.deepEqual(missing.edges, [])
  assert.equal(requests, 0)
})

test('无句号长文 fallback 拆成完整短卡并实际通过 fireworks 五项校验', async t => {
  const probe = spawnSync(python, ['-B', '-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3,9) else 1)'], { encoding: 'utf8' })
  if (probe.error?.code === 'ENOENT') return t.skip('本机没有 Python；长文 fallback 真实渲染未验证')
  assert.ifError(probe.error)
  assert.equal(probe.status, 0, '实际渲染需要 Python 3.9+')
  const outputDir = await mkdtemp(join(tmpdir(), 'assembly-diagrams-long-fallback-'))
  t.after(() => rm(outputDir, { recursive: true, force: true }))
  const source = snapshot()
  const repeatedCard = '客户授权后可以跨部门协同处理订单并保存完整记录客户确认后由业务专员核对结果并跟进下一步执行状态并明确责任'.slice(0, 48)
  const text = repeatedCard.repeat(4) + '尾部条件必须继续保留'
  assert.ok([...text].length >= 184)
  source.sections = [{ ...source.sections[0], blocks: [{ ...source.sections[0].blocks[0], text }] }]
  const plan = await buildDiagram({ snapshot: source, kind: 'business' })
  assert.equal(plan.mode, 'source-overview')
  assert.ok(plan.nodes.length > 1)
  assert.ok(plan.nodes.every(node => [...node.label].length <= 48))
  assert.equal(plan.nodes.map(node => node.label).join(''), text, '拆卡须逐字保留长文，不能截断或丢弃尾部')
  for (const node of plan.nodes) assert.deepEqual(node.unitIds, [plan.sources[0].id])
  const result = await renderDiagram(plan, { outputDir, python })
  assert.deepEqual(result.validation, checks)
  const report = JSON.parse(await readFile(result.reportPath, 'utf8'))
  assert.equal(report.ok, true)
  assert.deepEqual(report.issues, [])
  assert.equal(JSON.parse(await readFile(result.inputPath, 'utf8')).text_policy, 'strict')
  assert.equal(sourceMetadata(await readFile(result.path, 'utf8')).mode, 'source-overview')
})

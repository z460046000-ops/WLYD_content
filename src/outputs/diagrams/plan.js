import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const list = value => Array.isArray(value) ? value : []
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20)
export const DIAGRAM_KINDS = ['business', 'product']
const titles = { business: '业务架构全景', product: '产品功能架构全景' }
const roles = { business: ['business-architecture', 'business-challenges', 'scenario-solution', 'solution'],
  product: ['product-architecture', 'technical-platform', 'scenario-solution', 'solution'] }

/** Retain every selected paragraph and its tail; unrelated policy/company sections stay out. */
export function diagramSources(snapshot, kind) {
  if (!DIAGRAM_KINDS.includes(kind)) throw new Error('未知架构图类型')
  const available = list(snapshot.sections).filter(section => list(section.blocks).some(block => block.text?.trim()))
  const primary = available.filter(section => section.roleId === roles[kind][0])
  const sections = primary.length ? primary : available.filter(section => roles[kind].includes(section.roleId))
  const units = []
  for (const section of sections) for (const block of list(section.blocks)) {
    const chars = [...String(block.text || '')]
    for (let start = 0; start < chars.length; start += 1800) {
      const text = chars.slice(start, start + 1800).join('')
      if (!text.trim()) continue
      units.push({ id: `u-${hash([section.key, block.id, start, text])}`, text, sectionKey: section.key,
        sectionTitle: section.title, sourceBlockId: block.id, planRefs: structuredClone(block.planRefs || {}),
        evidence: structuredClone(list(block.evidence)), conditions: structuredClone(list(block.conditions)),
        supportMode: block.supportMode, verification: block.verification,
        capabilityStatus: block.capabilityStatus || 'unknown', capabilityOwnership: block.capabilityOwnership || 'unknown' })
    }
  }
  return units
}

function batches(units) {
  const rows = []; let current = [], size = 0
  for (const unit of units) {
    if (current.length && size + unit.text.length > 6000) { rows.push(current); current = []; size = 0 }
    current.push(unit); size += unit.text.length
  }
  if (current.length) rows.push(current)
  return rows
}

const nodeFrom = (kind, label, selected) => ({ id: `n-${hash([kind, label, selected.map(unit => unit.id)])}`,
  label, unitIds: selected.map(unit => unit.id), sectionKey: selected[0].sectionKey,
  sourceBlockIds: [...new Set(selected.map(unit => unit.sourceBlockId))] })

// Fireworks strict titles fit at most two lines. Preserve long source text across cards.
function excerptNodes(kind, unit) {
  const chars = [...unit.text], nodes = []
  for (let start = 0; start < chars.length; start += 48) {
    const label = chars.slice(start, start + 48).join('').trim()
    if (label) nodes.push({ ...nodeFrom(kind, label, [unit]), id: `n-${hash([kind, unit.id, start, label])}`, sourceOffset: start })
  }
  return nodes
}

function normalize(raw, units, kind) {
  const known = new Map(units.map(unit => [unit.id, unit])), used = new Set(), aliases = new Map(), nodes = [], edges = [], warnings = []
  if (!Array.isArray(raw?.nodes)) throw new Error('未返回图节点数组')
  for (const input of raw.nodes) {
    const ids = list(input?.unitIds)
    if (typeof input?.id !== 'string' || aliases.has(input.id) || typeof input.label !== 'string' || !input.label.trim()
      || [...input.label].length > 48 || !ids.length || ids.some(id => !known.has(id)) || new Set(ids).size !== ids.length) {
      warnings.push('未知来源或格式异常节点已拒绝'); continue
    }
    const selected = ids.map(id => known.get(id))
    if (new Set(selected.map(unit => unit.sectionKey)).size !== 1 || !selected.some(unit => unit.text.includes(input.label))) {
      warnings.push('节点名称无法在本章原文定位，已改用原文摘录'); continue
    }
    const node = nodeFrom(kind, input.label, selected)
    aliases.set(input.id, node); nodes.push(node); ids.forEach(id => used.add(id))
  }
  for (const unit of units) if (!used.has(unit.id)) {
    nodes.push(...excerptNodes(kind, unit)); warnings.push('未归入模型节点的原文片段已保留为摘录节点')
  }
  for (const edge of list(raw.edges)) {
    const source = aliases.get(edge?.source), target = aliases.get(edge?.target)
    const selected = list(edge?.unitIds).map(id => known.get(id))
    if (!source || !target || source.id === target.id || typeof edge.label !== 'string' || !edge.label.trim()
      || [...edge.label].length > 16 || !selected.length || selected.some(unit => !unit)
      || !selected.some(unit => unit.text.includes(source.label) && unit.text.includes(target.label) && unit.text.includes(edge.label))) {
      warnings.push('无法在同一原文片段定位两端及关系的连线已拒绝'); continue
    }
    edges.push({ source: source.id, target: target.id, label: edge.label, unitIds: selected.map(unit => unit.id) })
  }
  return { nodes, edges, warnings }
}

/** One small extraction per relevant batch; model failure keeps a clearly labelled source overview. */
export async function buildDiagram({ snapshot, kind, request, signal }) {
  if (!snapshot?.sourceContentSha256) throw new Error('架构图需要固定文案快照')
  const sources = diagramSources(snapshot, kind), prompt = await readFile(new URL('../../../prompts/outputs/diagrams.md', import.meta.url), 'utf8')
  const result = { schemaVersion: 1, kind, title: titles[kind], sourceContentSha256: snapshot.sourceContentSha256,
    semanticStatus: 'draft_unverified', sources, nodes: [], edges: [], warnings: [], mode: 'extractive-diagram' }
  if (!sources.length) return { ...result, status: 'needs_input', reason: '没有本类架构相关正文；未用其他章节补造架构' }
  for (const [index, units] of batches(sources).entries()) {
    if (signal?.aborted) throw signal.reason || new Error('架构图生成已取消')
    let normalized
    try {
      if (!request) throw new Error('绘图提炼模型不可用')
      const raw = await request({ stage: 'diagram', qualityMode: 'draft', diagramKind: kind, batchId: String(index + 1), task: prompt,
        instruction: '只提取本批原文中的简短模块名，label须为原文连续短语，最多48字。用unitIds绑定来源，覆盖所有片段；连线仅表示原文明示的关系，不能把位置或共同编号当作调用。无明确关系返回空edges。只返回JSON。',
        units: units.map(({ id, text }) => ({ id, text })),
        schema: { nodes: [{ id: 'local-1', label: '原文模块名', unitIds: ['u-原文编号'] }],
          edges: [{ source: 'local-1', target: 'local-2', label: '原文关系词', unitIds: ['u-原文编号'] }] } })
      normalized = normalize(raw, units, kind)
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error
      normalized = { nodes: units.flatMap(unit => excerptNodes(kind, unit)), edges: [], warnings: [`第${index + 1}批提炼未完成，使用原文摘录：${error.message}`] }
      result.mode = 'source-overview'
    }
    result.nodes.push(...normalized.nodes); result.edges.push(...normalized.edges); result.warnings.push(...normalized.warnings)
  }
  result.nodes = [...new Map(result.nodes.map(node => [node.id, node])).values()]
  result.edges = [...new Map(result.edges.map(edge => [JSON.stringify(edge), edge])).values()]
  result.warnings = [...new Set(result.warnings)]
  if (result.warnings.length) result.mode = 'source-overview'
  return { ...result, status: 'planned' }
}

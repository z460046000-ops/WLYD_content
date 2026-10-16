import { createHash } from 'node:crypto'
import { list, strings } from './context.js'
import { validateDraft } from './content.js'

export const QUALITY_MODES = ['draft', 'standard', 'strict']
export function qualityMode(value = 'draft') {
  if (!QUALITY_MODES.includes(value)) throw new Error('quality_mode 必须为 draft、standard 或 strict')
  return value
}

/** IDs bind the full fact and its verified provenance, including conditions and ownership. */
export function factCards(facts) {
  return facts.map(fact => ({ ...fact, id: `f-${createHash('sha256').update(JSON.stringify(fact)).digest('hex').slice(0, 20)}` }))
}

export function attachCardEvidence(block, cards) {
  if (!Array.isArray(block.factIds)) return { ...block }
  const selected = cards.filter(card => block.factIds.includes(card.id))
  const unknown = block.factIds.filter(id => !cards.some(card => card.id === id))
  return { ...block, factIds: selected.map(card => card.id),
    supportMode: block.supportMode === 'candidate' || !selected.length || selected.some(card => card.supportMode === 'candidate') ? 'candidate' : 'sourced',
    evidence: [...new Map(selected.flatMap(card => list(card.evidence)).map(ref => [JSON.stringify(ref), ref])).values()],
    ...(unknown.length ? { referenceWarnings: [`未知事实卡：${unknown.join('、')}`] } : {}) }
}

/** Drafts retain prose but never invent a citation or imply that machine checks passed. */
export function annotateDraft(raw, cards, evidence, node, plan) {
  const issues = [], blocks = []
  for (const [index, input] of list(raw).entries()) {
    if (!input || typeof input !== 'object' || !String(input.text || '').trim()) continue
    const hydrated = attachCardEvidence(input, cards)
    const warnings = [...list(hydrated.referenceWarnings)]
    const allowedRefs = list(hydrated.evidence).filter(ref => cards.some(card => list(card.evidence).some(allowed =>
      allowed.id === ref.id && allowed.quote === ref.quote)) && evidence.some(source => source.id === ref.id && source.content.includes(ref.quote)))
    if (allowedRefs.length !== list(hydrated.evidence).length) warnings.push('引用未通过事实卡核对，已移除无效引用')
    if (!allowedRefs.length) warnings.push('本段没有已核验事实卡引用')
    const candidate = hydrated.supportMode === 'candidate' || !allowedRefs.length
    let block = { ...hydrated, id: `${node.key}-${index + 1}`, evidence: allowedRefs, supportMode: candidate ? 'candidate' : 'sourced' }
    try {
      const checked = validateDraft({ sections: [{ key: node.key, blocks: [block] }] }, evidence, [node], plan)
      warnings.push(...checked.issues)
      if (checked.sections[0]?.blocks[0]) block = { ...block, ...checked.sections[0].blocks[0] }
    } catch (error) { warnings.push(error.message) }
    const labels = strings(warnings)
    if (labels.length) {
      block.text = `【未验证】${String(block.text).replace(/^【未验证】/u, '')}`
      block.verification = 'unverified'; block.reviewItems = labels
      issues.push(...labels.map(issue => `${node.key} / ${block.id}：${issue}`))
    } else block.verification = candidate ? 'candidate' : 'citation_checked'
    blocks.push(block)
  }
  return { section: { key: node.key, title: node.title, roleId: node.roleId,
    ...(node.framework ? { framework: node.framework } : {}), blocks }, issues: strings(issues) }
}

export function inputCard(node, rule, reason) {
  return { key: node.key, title: node.title, roleId: node.roleId, blocks: [], inputNeeded: {
    reason, questions: list(rule.extractQuestions).slice(0, 3), nextAction: '补充资料或直接对本章提出修改要求后，用 chapter action=revise 再生成' } }
}

/** Preserve only complete JSON string fields from an interrupted write, never raw JSON as prose. */
export function partialProse(text = '') {
  return [...String(text).matchAll(/"text"\s*:\s*("(?:[^"\\]|\\.)*")/gu)].flatMap(match => {
    try { return [{ text: JSON.parse(match[1]), supportMode: 'candidate', factIds: [] }] } catch { return [] }
  })
}

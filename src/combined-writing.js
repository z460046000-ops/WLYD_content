import { createHash } from 'node:crypto'
import { evidenceBatches, checkedFacts, list, strings } from './context.js'
import { factCards, attachCardEvidence, partialProse } from './fact-cards.js'
import { routeFacts, internalNarrative } from './evidence-policy.js'

/** Complete, overlapping source windows. Only text (not repeated quote fields) belongs in the prompt. */
export function sourceCardBatches(sources) {
  return evidenceBatches(sources, 8000).map(batch => batch.map(source => ({
    id: `s-${createHash('sha256').update(JSON.stringify([source.id, source.span, source.content])).digest('hex').slice(0, 20)}`,
    text: source.content, topic: '原文选段，尚未概括', sourceEvidenceId: source.id,
    subject: 'unknown', purpose: 'unknown', scope: 'unknown', supportMode: 'sourced',
    capabilityStatus: 'unknown', capabilityOwnership: 'unknown', semanticStatus: 'source_excerpt_unreviewed',
    span: source.span, partial: source.partial,
    ...(source.source ? { source: source.source } : {}), ...(source.locator ? { locator: source.locator } : {}),
    evidence: [{ id: source.id, quote: source.content }],
  })))
}

/** A cut-off combined response may contain facts.text before any prose. Only recover root sections. */
export function partialCombinedProse(text = '') {
  const value = String(text), stack = []
  let inString = false, escaped = false, tokenStart = -1, sectionStart = -1, sectionDepth = -1
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') {
        inString = false
        if (sectionStart < 0 && stack.length === 1 && stack[0] === '{') {
          let name
          try { name = JSON.parse(value.slice(tokenStart, i + 1)) } catch { continue }
          if (name === 'sections') {
            const suffix = value.slice(i + 1).match(/^\s*:\s*\[/u)
            if (suffix) { sectionStart = i + suffix[0].length; sectionDepth = stack.length + 1 }
          }
        }
      }
    } else if (char === '"') { inString = true; tokenStart = i }
    else if (char === '{' || char === '[') stack.push(char)
    else if (char === '}' || char === ']') {
      if (sectionStart >= 0 && char === ']' && stack.length === sectionDepth) return partialProse(value.slice(sectionStart, i))
      stack.pop()
    }
  }
  return sectionStart < 0 ? [] : partialProse(value.slice(sectionStart))
}

const sourceWarning = '本段直接依据原文选段，尚未独立概括或核验语义，请确认表述和能力边界'
const uniqueRefs = refs => [...new Map(refs.map(ref => [JSON.stringify(ref), ref])).values()]

/** Resolve only this batch's aliases; model labels do not themselves prove the resulting prose. */
export function materializeCombined(raw, inputCards, evidence, node, rule = {}) {
  const reviewItems = [], excludedFacts = [], aliases = new Map(), rejected = new Set(), cardPool = new Map()
  const originals = new Map(evidence.map(source => [source.id, source]))
  const sources = new Map(list(inputCards).filter(card => typeof card?.id === 'string' && String(card.text || '').trim()
    && list(card.evidence).length && list(card.evidence).every(ref => typeof ref?.quote === 'string' && ref.quote.length >= 6
      && ref.quote === card.text && originals.get(ref.id)?.content.includes(ref.quote))).map(card => [card.id, card]))
  if (sources.size !== list(inputCards).length) reviewItems.push('部分输入原文卡无法核对，已排除')

  const add = (fact, alias) => {
    const routed = routeFacts([fact], node, rule)
    reviewItems.push(...routed.reviewItems); excludedFacts.push(...routed.excludedFacts)
    if (!routed.facts.length) { rejected.add(alias); return null }
    const card = factCards(routed.facts)[0]
    cardPool.set(card.id, card); aliases.set(alias, card.id)
    return card
  }
  const sourceAlias = id => {
    if (aliases.has(id)) return aliases.get(id)
    if (rejected.has(id)) return null
    const source = sources.get(id)
    if (!source) return null
    const { id: sourceId, ...fact } = source
    const card = add({ ...fact, supportMode: 'candidate' }, sourceId)
    return card?.id || null
  }
  const rawFacts = list(raw?.facts)
  const counts = new Map()
  for (const fact of rawFacts) if (typeof fact?.id === 'string') counts.set(fact.id, (counts.get(fact.id) || 0) + 1)
  for (const claim of rawFacts) {
    const alias = typeof claim?.id === 'string' ? claim.id.trim() : ''
    if (!alias || alias.length > 128 || counts.get(alias) !== 1 || sources.has(alias)) {
      if (alias && !sources.has(alias)) rejected.add(alias)
      reviewItems.push(`事实别名无效或重复，已排除：${alias || '未提供ID'}`); continue
    }
    const sourceIds = strings(claim.sourceCardIds)
    if (sourceIds.some(id => !sources.has(id)) || !sourceIds.length && claim.supportMode !== 'candidate') {
      rejected.add(alias); reviewItems.push(`事实 ${alias} 引用了本批以外或缺失的原文卡，已排除`); continue
    }
    const refs = uniqueRefs(sourceIds.flatMap(id => sources.get(id).evidence))
    const fact = checkedFacts({ facts: [{ ...claim, evidence: refs }] }, evidence)[0]
    if (!fact) { rejected.add(alias); reviewItems.push(`事实 ${alias} 无法核对，已排除`); continue }
    add({ ...fact, sourceCardIds: sourceIds, semanticStatus: 'model_summary_unreviewed' }, alias)
  }

  const blocks = []
  const candidates = list(raw?.sections).filter(section => section?.key === node.key).flatMap(section => list(section.blocks))
  for (const input of candidates) {
    if (!input || typeof input !== 'object' || !String(input.text || '').trim()) continue
    if (internalNarrative(input.text)) { reviewItems.push('厂商内部或组稿叙事已退出本章正文'); continue }
    const warnings = strings(input.referenceWarnings), ids = strings(input.factIds)
    const legacyRefs = list(input.evidence)
    if (!ids.length && legacyRefs.length) {
      for (const ref of legacyRefs) {
        const match = [...sources.values()].find(card => list(card.evidence).some(allowed => allowed.id === ref?.id
          && typeof ref?.quote === 'string' && ref.quote.length >= 6 && allowed.quote.includes(ref.quote)))
        if (match) ids.push(match.id)
        else warnings.push('旧格式引文不在本批原文卡内，已移除')
      }
    }
    // A rejected classified fact must not sneak back through a paragraph that cites it.
    if (ids.some(id => rejected.has(id))) { reviewItems.push('引用已排除事实的段落已退出本章正文'); continue }
    const mapped = []
    let sourceOnly = false
    for (const id of ids) {
      const source = sources.has(id)
      const resolved = source ? sourceAlias(id) : aliases.get(id)
      if (resolved) { mapped.push(resolved); if (source) sourceOnly = true }
      else if (rejected.has(id)) break
      else warnings.push(`未知事实卡 ${id}，已移除引用`)
    }
    if (ids.some(id => rejected.has(id))) { reviewItems.push('缺少适合本章用途的事实，相关段落已排除'); continue }
    const selected = [...new Set(mapped)]
    const positiveOnly = rule.contentPolicy?.allowCandidate === false || ['customer-cases', 'company-profile'].includes(node.roleId)
    if (positiveOnly && (!selected.length || input.supportMode === 'candidate')) {
      reviewItems.push('本章需要明确用途和正向事实，未采用无据或候选段落'); continue
    }
    if (sourceOnly) warnings.push(sourceWarning)
    if (!selected.length) warnings.push('本段没有可核对的本批事实卡引用，保留为待确认初稿')
    const hydrated = attachCardEvidence({ ...input, evidence: [], factIds: selected,
      ...(sourceOnly || warnings.length ? { supportMode: 'candidate' } : {}), referenceWarnings: strings(warnings) }, [...cardPool.values()])
    blocks.push(hydrated)
    reviewItems.push(...warnings)
  }
  const cards = [...cardPool.values()]
  return { cards, facts: cards.map(({ id, ...fact }) => fact), blocks, reviewItems: strings([...reviewItems, ...strings(raw?.reviewItems)]), excludedFacts }
}

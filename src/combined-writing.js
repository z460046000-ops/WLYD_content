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

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Recover complete direct children of the response contract, never arbitrary nested text. */
export function partialCombinedResponse(text = '') {
  const value = String(text).trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')
  const normalize = raw => ({ facts: list(raw?.facts).filter(object), sections: list(raw?.sections).filter(object).map(section => ({
    ...(Object.hasOwn(section, 'key') ? { key: section.key } : {}), blocks: list(section.blocks).filter(object),
  })) })
  try { const raw = JSON.parse(value); return object(raw) ? normalize(raw) : { facts: [], sections: [] } } catch { /* Inspect the valid prefix only. */ }
  const skip = start => { while (/\s/u.test(value[start] || '') && start < value.length) start++; return start }
  const incomplete = { complete: false, end: value.length }
  const parsed = (start, end) => {
    try { return { complete: true, end, value: JSON.parse(value.slice(start, end)) } } catch { return incomplete }
  }
  const readValue = start => {
    start = skip(start)
    const first = value[start]
    if (first === '"') {
      let escaped = false
      for (let index = start + 1; index < value.length; index++) {
        if (escaped) escaped = false
        else if (value[index] === '\\') escaped = true
        else if (value[index] === '"') return parsed(start, index + 1)
      }
      return incomplete
    }
    if (first === '{' || first === '[') {
      const stack = [first]; let quoted = false, escaped = false
      for (let index = start + 1; index < value.length; index++) {
        const char = value[index]
        if (quoted) {
          if (escaped) escaped = false
          else if (char === '\\') escaped = true
          else if (char === '"') quoted = false
        } else if (char === '"') quoted = true
        else if (char === '{' || char === '[') stack.push(char)
        else if (char === '}' || char === ']') {
          if (stack.pop() !== (char === '}' ? '{' : '[')) return incomplete
          if (!stack.length) return parsed(start, index + 1)
        }
      }
      return incomplete
    }
    let end = start
    while (end < value.length && !/[\s,\]}]/u.test(value[end])) end++
    return end > start ? parsed(start, end) : incomplete
  }
  const readArray = (start, readItem = readValue) => {
    const items = []; let index = skip(start + 1)
    while (index < value.length) {
      if (value[index] === ']') return { complete: true, end: index + 1, value: items }
      const item = readItem(index)
      if (item.value !== undefined) items.push(item.value)
      if (!item.complete) return { ...incomplete, value: items }
      index = skip(item.end)
      if (value[index] === ']') return { complete: true, end: index + 1, value: items }
      if (value[index] !== ',') break
      index = skip(index + 1)
    }
    return { ...incomplete, value: items }
  }
  const readObject = (start, field) => {
    let index = skip(start + 1)
    while (index < value.length) {
      if (value[index] === '}') return { complete: true, end: index + 1 }
      const name = readValue(index)
      if (!name.complete || typeof name.value !== 'string') break
      index = skip(name.end)
      if (value[index] !== ':') break
      const item = field(name.value, skip(index + 1))
      if (!item.complete) return incomplete
      index = skip(item.end)
      if (value[index] === '}') return { complete: true, end: index + 1 }
      if (value[index] !== ',') break
      index = skip(index + 1)
    }
    return incomplete
  }
  const readSection = start => {
    start = skip(start)
    if (value[start] !== '{') return readValue(start)
    const section = { blocks: [] }
    const result = readObject(start, (name, index) => {
      const item = name === 'blocks' && value[index] === '[' ? readArray(index) : readValue(index)
      // An announced but unfinished key is not a keyless legacy section.
      if (name === 'key') section.key = item.complete ? item.value : null
      if (name === 'blocks' && value[index] === '[') section.blocks = item.value.filter(object)
      return item
    })
    return { ...result, value: section }
  }
  const result = { facts: [], sections: [] }
  if (value[0] !== '{') return result
  readObject(0, (name, index) => {
    const selected = ['facts', 'sections'].includes(name) && value[index] === '['
    const item = selected ? readArray(index, name === 'sections' ? readSection : readValue) : readValue(index)
    if (selected) result[name] = item.value.filter(object)
    return item
  })
  return result
}

const sourceWarning = '本段直接依据原文选段，尚未独立概括或核验语义，请确认表述和能力边界'
const uniqueRefs = refs => [...new Map(refs.map(ref => [JSON.stringify(ref), ref])).values()]

/** Resolve only this batch's aliases; model labels do not themselves prove the resulting prose. */
export function materializeCombined(raw, inputCards, evidence, node, rule = {}) {
  const reviewItems = [], excludedFacts = [], aliases = new Map(), rejected = new Set(), cardPool = new Map()
  const referenceAudit = { normalized: [], rejected: [] }
  const originals = new Map(evidence.map(source => [source.id, source]))
  const sources = new Map(list(inputCards).filter(card => typeof card?.id === 'string' && String(card.text || '').trim()
    && list(card.evidence).length && list(card.evidence).every(ref => typeof ref?.quote === 'string' && ref.quote.length >= 6
      && ref.quote === card.text && originals.get(ref.id)?.content.includes(ref.quote))).map(card => [card.id, card]))
  if (sources.size !== list(inputCards).length) reviewItems.push('部分输入原文卡无法核对，已排除')

  const rejectReference = (factAlias, sourceCardIds, reason) => {
    referenceAudit.rejected.push({ factAlias, sourceCardIds, reason })
    rejected.add(factAlias)
  }
  const resolveSource = (id, claim, sourceIds) => {
    if (sources.has(id)) return { id }
    // A knowledge chunk may have several windows in this batch. Never choose the first or widen its scope.
    const matches = [...sources.values()].filter(card => card.sourceEvidenceId === id && list(card.evidence).some(ref => ref.id === id))
    if (!matches.length) return { error: 'unknown_source_reference' }
    const quotes = strings([...list(claim.evidence).filter(ref => ref?.id === id).map(ref => ref?.quote),
      ...(sourceIds.length === 1 ? [claim.quote, claim.sourceQuote] : [])]).filter(quote => quote.length >= 6)
    const located = quotes.length ? matches.filter(card => quotes.every(quote => card.text.includes(quote))) : matches
    if (!located.length) return { error: 'source_quote_mismatch' }
    if (located.length !== 1) return { error: 'ambiguous_source_reference' }
    return { id: located[0].id, reason: quotes.length ? 'unique_quote_window' : 'unique_source_evidence' }
  }

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
      referenceAudit.rejected.push({ factAlias: alias, sourceCardIds: strings(claim?.sourceCardIds), reason: 'invalid_fact_alias' })
      reviewItems.push(`事实别名无效或重复，已排除：${alias || '未提供ID'}`); continue
    }
    if (claim.sourceCardIds !== undefined && (!Array.isArray(claim.sourceCardIds)
      || claim.sourceCardIds.some(id => typeof id !== 'string' || !id.trim()))) {
      rejectReference(alias, strings(claim.sourceCardIds), 'invalid_source_reference_shape')
      reviewItems.push(`事实 ${alias} 的 sourceCardIds 必须为本批原文卡ID字符串数组，已排除`); continue
    }
    const originalIds = strings(claim.sourceCardIds), sourceIds = [], normalized = []
    let referenceError
    for (const id of originalIds) {
      const resolved = resolveSource(id, claim, originalIds)
      if (resolved.error) { referenceError = resolved.error; break }
      if (!sourceIds.includes(resolved.id)) sourceIds.push(resolved.id)
      if (resolved.reason) normalized.push({ factAlias: alias, from: id, to: resolved.id, reason: resolved.reason })
    }
    if (referenceError || !sourceIds.length && claim.supportMode !== 'candidate') {
      rejectReference(alias, originalIds, referenceError || 'missing_source_reference')
      reviewItems.push(referenceError === 'ambiguous_source_reference'
        ? `事实 ${alias} 的来源ID对应本批多个原文窗口，缺少可唯一定位的逐字引文，已排除`
        : `事实 ${alias} 引用了本批以外、缺失或无法定位的原文卡，已排除`); continue
    }
    referenceAudit.normalized.push(...normalized)
    for (const item of normalized) reviewItems.push(`事实 ${alias} 的来源引用已按本批${item.reason === 'unique_quote_window' ? '唯一逐字引文' : '唯一原文卡'}归一化：${item.from} → ${item.to}`)
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
  return { cards, facts: cards.map(({ id, ...fact }) => fact), blocks, reviewItems: strings([...reviewItems, ...strings(raw?.reviewItems)]), excludedFacts, referenceAudit }
}

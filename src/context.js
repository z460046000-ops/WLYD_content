import { atomicJson } from './persistence.js'
import { askModel, resolveWritingModel, stageOutputBudget } from './model.js'
import { normalizeFactMetadata } from './evidence-policy.js'

export const list = value => Array.isArray(value) ? value : []
export const strings = value => [...new Set(list(value).filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()))]
export const writeJson = atomicJson
export const NON_REPEATABLE = new Set(['MODEL_CONTEXT_LIMIT', 'MODEL_OUTPUT_LIMIT', 'MODEL_STAGE_TIMEOUT', 'MODEL_QUEUE_TIMEOUT'])

/** Stage projections: full rules stay in the run fingerprint, not every prompt. */
export function commonContext(rules, args) {
  return { author: { identity: args.author_identity || '售前方案作者', domain: args.domain || '', objective: args.objective || '编制产品解决方案' },
    audience: args.audience || '首次接触方案的企业客户',
    promptPolicy: { global: rules.global, style: rules.style } }
}

export async function createRequester({ llm, exec, state, saveState }) {
  const selection = state.modelSelection || await resolveWritingModel(llm, exec.agent, exec.signal)
  state.modelSelection = selection
  state.modelRequests ||= []
  await saveState()
  return async prompt => {
    const input = JSON.stringify(prompt)
    const supplied = list(prompt.evidence)
    const record = { stage: prompt.stage, ...(prompt.chapter?.key ? { chapterKey: prompt.chapter.key } : {}),
      ...(prompt.reviewScope ? { reviewScope: prompt.reviewScope } : {}),
      ...(prompt.retrievalRound ? { retrievalRound: prompt.retrievalRound } : {}),
      ...(prompt.batchId ? { batchId: prompt.batchId } : {}),
      inputCharacters: input.length, inputBytes: Buffer.byteLength(input), inputCharacterUnit: 'UTF-16',
      evidenceCount: supplied.length, evidenceIds: supplied.map(item => item.id),
      evidenceCharacters: supplied.reduce((n, item) => n + item.content.length, 0),
      factCardCount: list(prompt.facts || prompt.extraction?.facts).length,
      ...(prompt.qualityMode ? { qualityMode: prompt.qualityMode } : {}),
      ...selection, outputBudgetSource: stageOutputBudget(prompt.stage, selection) === undefined ? 'adapter-default' : 'plugin-config',
      resumeAttempt: state.resumeCount || 0, startedAt: new Date().toISOString(), status: 'pending' }
    state.modelRequests.push(record); await saveState()
    try {
      const result = await askModel(llm, exec.agent, exec.signal, prompt, { modelSelection: selection,
        maxTokens: stageOutputBudget(prompt.stage, selection),
        ...(prompt.qualityMode === 'draft' ? { timeoutMs: 180000 } : {}),
        onMetrics: metrics => Object.assign(record, metrics) })
      record.status = 'completed'
      return result
    } catch (error) {
      record.status = exec.signal?.aborted ? 'cancelled' : 'failed'
      record.error = error.message
      if (error.code) record.code = error.code
      throw error
    } finally { record.finishedAt = new Date().toISOString(); await saveState() }
  }
}

/** Batch complete sources without discarding tails. Offsets refer to archived originals. */
export function evidenceBatches(evidence, size = 6000) {
  const batches = []
  let batch = [], length = 0
  for (const source of evidence) {
    const content = String(source.content || '')
    for (let start = 0; start < content.length;) {
      const end = Math.min(start + 2400, content.length)
      const row = { id: source.id, content: content.slice(start, end), span: { start, end }, partial: content.length > end || start > 0,
        ...Object.fromEntries(Object.entries({ kind: 64, source: 512, locator: 256, publishedAt: 120, asOf: 120 }).filter(([key]) =>
          typeof source[key] === 'string' && source[key].trim()).map(([key, limit]) => [key, source[key].slice(0, limit)])) }
      if (batch.length && length + row.content.length > size) { batches.push(batch); batch = []; length = 0 }
      batch.push(row); length += row.content.length
      if (end === content.length) break
      start = end - 160
    }
  }
  if (batch.length) batches.push(batch)
  return batches
}

export function checkedFacts(raw, originals) {
  return list(raw?.facts).flatMap(item => {
    if (!item || !String(item.text || '').trim()) return []
    const metadata = normalizeFactMetadata(item)
    const refs = list(item.evidence).map(ref => {
      const quote = String(ref?.quote || '').trim()
      const source = originals.find(row => row.id === String(ref?.id) && row.content.includes(quote))
      return source && quote.length >= 6 && source.content.includes(quote) ? { id: source.id, quote } : null
    })
    if (refs.some(ref => !ref) || (!refs.length && metadata.supportMode !== 'candidate')) return []
    return [{ text: String(item.text), ...metadata,
      supportMode: metadata.supportMode === 'candidate' || !refs.length ? 'candidate' : 'sourced', evidence: refs }]
  })
}

export function uniqueFacts(facts) {
  return [...new Map(facts.map(item => [JSON.stringify([item.text, item.evidence, item.subject, item.purpose, item.scope,
    item.supportMode, item.capabilityStatus, item.capabilityOwnership, item.asOf, item.topic]), item])).values()]
}

/** Pass the checked original quote plus its nearby conditions, not the original pool. */
export function citedEvidence(factsOrBlocks, originals) {
  const sources = new Map(originals.map(item => [item.id, item]))
  const excerpts = new Map()
  for (const row of factsOrBlocks) for (const ref of list(row.evidence)) {
    const source = sources.get(ref.id)
    const offset = source?.content.indexOf(ref.quote) ?? -1
    if (offset < 0) continue
    const start = Math.max(0, offset - 180), end = Math.min(source.content.length, offset + ref.quote.length + 180)
    const spans = excerpts.get(ref.id) || []
    if (!spans.some(span => span.start <= start && span.end >= end)) spans.push({ start, end, text: source.content.slice(start, end) })
    excerpts.set(ref.id, spans)
  }
  return [...excerpts].map(([id, spans]) => ({ id, content: spans.map(span => span.text).join('\n[另一处原文]\n'),
    excerpts: spans.map(({ start, end }) => ({ start, end })), note: '原文选段，完整来源另存 evidence.json；跨段不视作连续引文' }))
}

export function itemBatches(items, size = 6000, count = 6) {
  const result = []; let batch = [], length = 0
  for (const item of items) {
    const cost = JSON.stringify(item).length
    if (batch.length && (length + cost > size || batch.length >= count)) { result.push(batch); batch = []; length = 0 }
    batch.push(item); length += cost
  }
  if (batch.length) result.push(batch)
  return result
}

/** Keep guidance for this chapter and only the IDs it actually needs. */
export function chapterPlan(plan, node) {
  const guidance = list(plan.chapterGuidance).find(row => row.key === node.key) || {}
  const roles = { 'business-challenges': 'problemIds', 'policy-trends': 'trendIds' }
  const ids = new Set(Object.values(guidance).filter(Array.isArray).flat())
  if (!ids.size || ['solution', 'scenario-solution', 'business-architecture', 'product-architecture'].includes(node.roleId)) {
    for (const scenario of list(plan.scenarios)) { ids.add(scenario.id); for (const field of ['capabilityIds', 'problemIds', 'trendIds']) for (const id of scenario[field] || []) ids.add(id) }
  }
  if (roles[node.roleId]) for (const row of list(plan[roles[node.roleId] === 'problemIds' ? 'problems' : 'trends'])) ids.add(row.id)
  return { choices: plan.choices, chapterGuidance: [guidance],
    ...Object.fromEntries(['capabilities', 'problems', 'trends', 'scenarios'].map(field => [field,
      list(plan[field]).filter(row => ids.has(row.id)).map(({ evidence, ...row }) => ({ ...row,
        ...(field === 'capabilities' || field === 'problems' || field === 'trends' ? { evidence: [], evidenceIds: list(evidence).map(ref => ref.id) } : {}) }))])) }
}

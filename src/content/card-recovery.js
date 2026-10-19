import path from 'node:path'
import { readJson } from '../persistence.js'
import { checkedFacts, list, strings } from '../context.js'
import { factCards } from '../fact-cards.js'
import { routeFacts } from '../evidence-policy.js'
import { materializeCombined, sourceCardBatches } from '../combined-writing.js'

const semanticFields = ['subject', 'purpose', 'scope', 'supportMode', 'capabilityStatus', 'capabilityOwnership']
const sameSet = (left, right) => left.length === right.length && left.every(value => right.includes(value))
const hasVerifiedRefs = (fact, evidence) => list(fact?.evidence).length > 0 && list(fact.evidence).every(ref =>
  typeof ref?.quote === 'string' && ref.quote.length >= 6 && evidence.some(source => source.id === ref.id && source.content.includes(ref.quote)))

function checkedStoredCards(value, evidence, node, rule) {
  return list(value).filter(card => {
    if (!card || typeof card.id !== 'string' || !/^f-[a-f\d]{20}$/u.test(card.id) || !hasVerifiedRefs(card, evidence)) return false
    const { id, ...fact } = card
    if (factCards([fact])[0].id !== id) return false
    const checked = checkedFacts({ facts: [fact] }, evidence)[0]
    if (!checked) return false
    const routed = routeFacts([checked], node, rule).facts[0]
    return Boolean(routed) && semanticFields.every(field => fact[field] === undefined || fact[field] === routed[field])
  })
}

/** Read only. Caller must first restore evidence under current project authorization and hold the run lock. */
export async function resolveChapterCards({ chapterDir, evidence, node, rule = {} }) {
  const reviewItems = [], referenceAudit = { normalized: [], rejected: [] }
  const readOptional = async (file, fallback) => {
    try { return await readJson(path.join(chapterDir, file), fallback) }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      reviewItems.push(`${file} 格式无效，已跳过该恢复来源`); return fallback
    }
  }
  const finish = (cards, source, extra = {}) => ({ cards, source, reviewItems, referenceAudit, ...extra })
  const stored = await readOptional('cards.json', null)
  const validStored = checkedStoredCards(stored?.cards, evidence, node, rule)
  if (validStored.length) {
    if (validStored.length !== list(stored?.cards).length) reviewItems.push('部分已存事实卡无法核对或不符合本章用途，已退出本次修订')
    return finish(validStored, 'stored', { changed: validStored.length !== list(stored?.cards).length })
  }
  if (list(stored?.cards).length) reviewItems.push('已存事实卡无法通过当前证据与用途核对，尝试恢复')

  const extraction = await readOptional('extraction.json', {})
  const checked = checkedFacts({ facts: list(extraction.facts).filter(fact => hasVerifiedRefs(fact, evidence)) }, evidence)
  const routed = routeFacts(checked, node, rule)
  reviewItems.push(...routed.reviewItems)
  if (routed.facts.length) return finish(factCards(routed.facts), 'extraction', { changed: true })

  const batches = list(extraction.batches)
  if (extraction.mode !== 'retrieve-write' || !batches.length) return finish([], 'empty', { failureCode: 'recovery_manifest_missing' })
  const byId = new Map(evidence.map(source => [source.id, source])), recovered = new Map(), seenBatches = new Set()
  let failureCode = 'card_pool_empty'
  for (const batch of batches) {
    const batchId = String(batch?.batchId || ''), sourceIds = strings(batch?.sourceCardIds), evidenceIds = strings(batch?.evidenceIds)
    if (!/^[1-9]\d{0,5}$/u.test(batchId) || seenBatches.has(batchId) || !sourceIds.length || !evidenceIds.length
      || sourceIds.length !== list(batch?.sourceCardIds).length || evidenceIds.length !== list(batch?.evidenceIds).length
      || evidenceIds.some(id => byId.get(id)?.kind !== 'knowledge')) {
      failureCode = 'recovery_manifest_mismatch'; reviewItems.push('原批次清单缺失、重复或不属于当前授权知识证据，未重放该批'); continue
    }
    seenBatches.add(batchId)
    // Reconstruct only windows from the recorded evidence IDs, then select the exact recorded s-IDs.
    const windows = new Map(sourceCardBatches(evidenceIds.map(id => byId.get(id))).flat().map(card => [card.id, card]))
    const inputCards = sourceIds.map(id => windows.get(id))
    if (inputCards.some(card => !card) || !sameSet(strings(inputCards.map(card => card.sourceEvidenceId)), evidenceIds)) {
      failureCode = 'recovery_manifest_mismatch'; reviewItems.push(`批次 ${batchId} 的原文窗口清单无法复核，未重放`); continue
    }
    const raw = await readOptional(`draft-${batchId}.json`, null)
    if (!raw) { reviewItems.push(`批次 ${batchId} 原始响应缺失或无效，未重放`); continue }
    const materialized = materializeCombined(raw, inputCards, evidence, node, rule)
    for (const card of checkedStoredCards(materialized.cards, evidence, node, rule)) recovered.set(card.id, card)
    reviewItems.push(...materialized.reviewItems)
    referenceAudit.normalized.push(...materialized.referenceAudit.normalized)
    referenceAudit.rejected.push(...materialized.referenceAudit.rejected)
    if (materialized.referenceAudit.rejected.some(item => item.reason === 'ambiguous_source_reference')) failureCode = 'ambiguous_source_reference'
  }
  if (recovered.size) return finish([...recovered.values()], 'replayed', { changed: true })
  return finish([], 'empty', { failureCode })
}

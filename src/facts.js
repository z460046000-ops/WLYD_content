import { list, strings, evidenceBatches, checkedFacts, uniqueFacts } from './context.js'
import { classifyModelFailure } from './model.js'
import { abortError } from './scheduler.js'
import { FACT_SUBJECTS, FACT_PURPOSES } from './evidence-policy.js'
import { stageContext, chapterContext } from './prompts.js'

/** Extract each evidence batch once; on resource limits split the failed batch only. */
export async function collectFacts({ request, common, node, rule, evidence, plan, signal, round = 0, tolerant = false, onBatch = async () => {}, onProgress = async () => {} }) {
  const result = { facts: [], writingOutline: [], retrievalQueries: [], gaps: [], reviewItems: [], batches: [] }
  const visit = async (batch, batchId, depth = 0, retry = false) => {
    if (signal?.aborted) throw abortError(signal)
    await onBatch()
    try {
      const raw = await request({ ...stageContext(common, 'extract'), stage: 'extract', chapter: node, chapterRule: chapterContext(rule, node, 'extract'),
        plan, retrievalRound: round, batchId, evidence: batch, ...(tolerant ? { qualityMode: 'draft' } : {}),
        schema: { facts: [{ text: '简短事实或明确假设', topic: '简短主题，同一主题复用', supportMode: 'sourced/candidate',
          subject: FACT_SUBJECTS.join('/'), purpose: FACT_PURPOSES.join('/'), scope: 'customer/typical/vendor-internal/unknown',
          capabilityStatus: 'existing/pilot/planned/proposed/unknown', capabilityOwnership: 'self/third-party/customer/unknown',
          asOf: '原文明确的适用或发布日期，不明则空；不可从文件名推定', evidence: [{ id: '输入 ID', quote: '短的逐字引文，至少六字' }] }],
          writingOutline: [{ topic: '简短主题', points: ['要点'] }], retrievalQueries: [], gaps: [], reviewItems: [] } })
      if (!Array.isArray(raw.facts)) throw new Error('章节提取缺少 facts 数组')
      const facts = checkedFacts(raw, batch)
      if (raw.facts.length && !facts.length) throw new Error('本批次事实卡引用均未通过原文校验')
      result.facts.push(...facts); result.writingOutline.push(...list(raw.writingOutline))
      result.retrievalQueries.push(...strings(raw.retrievalQueries)); result.gaps.push(...strings(raw.gaps)); result.reviewItems.push(...strings(raw.reviewItems))
      result.batches.push({ batchId, status: 'completed', evidenceIds: [...new Set(batch.map(row => row.id))], facts: facts.length })
      await onProgress(result)
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') throw signal?.aborted ? abortError(signal) : error
      const kind = classifyModelFailure(error)
      if (tolerant) {
        const snippets = batch.filter(source => source.content.trim().length >= 6).map(source => ({
          text: source.content.slice(0, 400), topic: '原文选段，尚未概括', supportMode: 'sourced', subject: 'unknown', purpose: 'unknown',
          evidence: [{ id: source.id, quote: source.content.slice(0, 400) }] }))
        result.facts.push(...snippets)
        result.reviewItems.push(`本章提取未完成，暂用原文选段供初稿参考：${error.message}`)
        result.batches.push({ batchId, status: 'source_excerpt', error: error.message, facts: snippets.length,
          evidenceIds: batch.map(row => row.id) })
        await onProgress(result)
        return
      }
      const canSplit = kind === 'context' || kind === 'output' && error.outputCharacters > 0
      if (canSplit && depth < 2 && (batch.length > 1 || batch[0]?.content.length > 900)) {
        result.batches.push({ batchId, status: 'split', error: error.message })
        let parts
        if (batch.length > 1) { const mid = Math.ceil(batch.length / 2); parts = [batch.slice(0, mid), batch.slice(mid)] }
        else {
          const source = batch[0], mid = Math.ceil(source.content.length / 2), offset = source.span?.start || 0
          parts = [[{ ...source, content: source.content.slice(0, mid + 80), span: { start: offset, end: offset + mid + 80 } }],
            [{ ...source, content: source.content.slice(mid - 80), span: { start: offset + mid - 80, end: offset + source.content.length } }]]
        }
        for (const [index, part] of parts.entries()) await visit(part, `${batchId}.${index + 1}`, depth + 1)
      } else if (kind === 'other' && !error.code && !retry) await visit(batch, `${batchId}-retry`, depth, true)
      else throw error
    }
  }
  for (const [index, batch] of evidenceBatches(evidence).entries()) await visit(batch, `${round}-${index + 1}`)
  return { ...result, facts: uniqueFacts(result.facts), retrievalQueries: strings(result.retrievalQueries).slice(0, 2),
    gaps: strings(result.gaps), reviewItems: strings(result.reviewItems) }
}

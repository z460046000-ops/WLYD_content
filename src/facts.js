import { list, strings, evidenceBatches, checkedFacts, uniqueFacts } from './context.js'
import { classifyModelFailure } from './model.js'
import { abortError } from './scheduler.js'
import { FACT_SUBJECTS, FACT_PURPOSES } from './evidence-policy.js'

/** Extract each evidence batch once; on resource limits split the failed batch only. */
export async function collectFacts({ request, common, node, rule, evidence, plan, signal, round = 0, onBatch = async () => {}, onProgress = async () => {} }) {
  const result = { facts: [], writingOutline: [], retrievalQueries: [], gaps: [], reviewItems: [], batches: [] }
  const visit = async (batch, batchId, depth = 0, retry = false) => {
    if (signal?.aborted) throw abortError(signal)
    await onBatch()
    try {
      const raw = await request({ ...common, stage: 'extract', chapter: node, chapterRule: { extractQuestions: rule.extractQuestions || [], contentPolicy: rule.contentPolicy || {} },
        plan, retrievalRound: round, batchId, evidence: batch,
        task: '只提取当前批次与本章有关的事实卡，不写正文。最多八条简短事实，每条概括意思并附短的逐字原文，保留条件、否定、时间、能力归属与状态；避免整段复制。提取问题不是白名单，其他相关价值也可保留；同一主题复用简短 topic，但不能为归并丢掉不同事实或条件。逐条判断事实主体 subject、用途 purpose 与适用时间 asOf，来源是内部文件不代表其中产品能力无效；逐字引文只证明原文存在，不证明它适合作为客户痛点、行业趋势或客户案例。内部经营/竞争/研发/知识库维护和组稿说明标 vendor-internal/internal，仅供审核；产品能力与已知边界仍按实际主体和用途保留，不按文件名整篇丢弃。未具备、试点、规划及第三方能力不得升级为已具备或自有。客户实际事实 scope=customer；典型假设或从产品能力反推的问题 scope=typical 且 supportMode=candidate，即使有背景引用也不能变 sourced；主体不明就 unknown。没有案例的说明不是正向案例。只在缺失具体且影响本章的问题时给最多两条带业务术语的 retrievalQueries；其他批次可能有答案，不泛泛要求更多材料。',
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

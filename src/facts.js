import { list, strings, evidenceBatches, checkedFacts, uniqueFacts, NON_REPEATABLE } from './context.js'

/** Extract each evidence batch once; on resource limits split the failed batch only. */
export async function collectFacts({ request, common, node, rule, evidence, plan, round = 0, onBatch = async () => {}, onProgress = async () => {} }) {
  const result = { facts: [], writingOutline: [], retrievalQueries: [], gaps: [], reviewItems: [], batches: [] }
  const visit = async (batch, batchId, depth = 0, retry = false) => {
    await onBatch()
    try {
      const raw = await request({ ...common, stage: 'extract', chapter: node, chapterRule: { extractQuestions: rule.extractQuestions || [] },
        plan, retrievalRound: round, batchId, evidence: batch,
        task: '只提取当前批次与本章有关的事实卡，不写正文。最多八条简短事实，每条概括意思并附短的逐字原文，保留条件、否定、时间、能力归属与状态；避免整段复制。提取问题不是白名单，其他相关价值也可保留。作者内部研发问题不可当客户事实。无证据推演标 candidate。只在缺失具体且影响本章的问题时给最多两条带业务术语的 retrievalQueries；其他批次可能有答案，不泛泛要求更多材料。',
        schema: { facts: [{ text: '简短事实或明确假设', supportMode: 'sourced/candidate', evidence: [{ id: '输入 ID', quote: '短的逐字引文，至少六字' }] }],
          writingOutline: [{ topic: '简短主题', points: ['要点'] }], retrievalQueries: [], gaps: [], reviewItems: [] } })
      if (!Array.isArray(raw.facts)) throw new Error('章节提取缺少 facts 数组')
      const facts = checkedFacts(raw, batch)
      if (raw.facts.length && !facts.length) throw new Error('本批次事实卡引用均未通过原文校验')
      result.facts.push(...facts); result.writingOutline.push(...list(raw.writingOutline))
      result.retrievalQueries.push(...strings(raw.retrievalQueries)); result.gaps.push(...strings(raw.gaps)); result.reviewItems.push(...strings(raw.reviewItems))
      result.batches.push({ batchId, status: 'completed', evidenceIds: [...new Set(batch.map(row => row.id))], facts: facts.length })
      await onProgress(result)
    } catch (error) {
      if (NON_REPEATABLE.has(error.code) && depth < 2 && (batch.length > 1 || batch[0]?.content.length > 900)) {
        result.batches.push({ batchId, status: 'split', error: error.message })
        let parts
        if (batch.length > 1) { const mid = Math.ceil(batch.length / 2); parts = [batch.slice(0, mid), batch.slice(mid)] }
        else {
          const source = batch[0], mid = Math.ceil(source.content.length / 2), offset = source.span?.start || 0
          parts = [[{ ...source, content: source.content.slice(0, mid + 80), span: { start: offset, end: offset + mid + 80 } }],
            [{ ...source, content: source.content.slice(mid - 80), span: { start: offset + mid - 80, end: offset + source.content.length } }]]
        }
        for (const [index, part] of parts.entries()) await visit(part, `${batchId}.${index + 1}`, depth + 1)
      } else if (!NON_REPEATABLE.has(error.code) && !retry) await visit(batch, `${batchId}-retry`, depth, true)
      else throw error
    }
  }
  for (const [index, batch] of evidenceBatches(evidence).entries()) await visit(batch, `${round}-${index + 1}`)
  return { ...result, facts: uniqueFacts(result.facts), retrievalQueries: strings(result.retrievalQueries).slice(0, 2),
    gaps: strings(result.gaps), reviewItems: strings(result.reviewItems) }
}

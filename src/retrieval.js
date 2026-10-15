import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createLimiter } from './scheduler.js'

const retrievalSlot = createLimiter(4)
const hash = value => createHash('sha256').update(value).digest('hex')
const textOf = value => String(value ?? '').trim()
const unique = values => [...new Set(values.filter(Boolean))]
const knownSources = new Set(['unified', 'legacy'])

function localDocumentKey(item) {
  if (item.locator) return `path:${String(item.locator).split('#')[0]}`
  if (item.sourceSha256) return `hash:${item.sourceSha256}`
  const match = /^(M\d+)-\d+$/u.exec(String(item.id))
  return match ? match[1] : `item:${item.id}`
}

function termsOf(value) {
  const text = String(value || '').toLowerCase()
  const words = text.match(/[a-z][a-z0-9-]{2,}|[\p{Script=Han}]{2,}/gu) || []
  const terms = new Set()
  for (const word of words) {
    if (/^[\p{Script=Han}]+$/u.test(word)) {
      for (let i = 0; i < word.length - 1; i++) terms.add(word.slice(i, i + 2))
    } else terms.add(word)
  }
  for (const common of ['什么', '哪些', '如何', '相关', '内容', '本章', '本次', '材料', '客户', '企业', '业务', '方案', '需要', '可以', '是否', '说明']) terms.delete(common)
  return terms
}

function score(item, terms) {
  if (!terms.size) return 0
  const body = String(item.content || '').toLowerCase()
  const source = String(item.source || '').toLowerCase()
  let result = 0
  for (const term of terms) {
    if (source.includes(term)) result += 3
    else if (body.includes(term)) result += 1
  }
  return result
}

function guidanceFor(plan, key) {
  return (plan?.chapterGuidance || []).find(item => item?.key === key) || {}
}

function planEvidenceIds(plan, guidance) {
  const fields = { capabilityIds: 'capabilities', problemIds: 'problems', trendIds: 'trends', scenarioIds: 'scenarios' }
  const refs = []
  for (const [field, collection] of Object.entries(fields)) {
    const selected = new Set(Array.isArray(guidance[field]) ? guidance[field] : [])
    for (const item of plan?.[collection] || []) if (selected.has(item.id)) {
      for (const ref of item.evidence || []) refs.push(String(ref.id))
      if (collection === 'scenarios') {
        for (const related of Object.entries({ capabilityIds: 'capabilities', problemIds: 'problems', trendIds: 'trends' })) {
          const [idsField, rowsField] = related
          const ids = new Set(item[idsField] || [])
          for (const row of plan?.[rowsField] || []) if (ids.has(row.id)) {
            for (const ref of row.evidence || []) refs.push(String(ref.id))
          }
        }
      }
    }
  }
  return unique(refs)
}

function chapterQueries(node, plan, rules, audience, extraQueries) {
  const guidance = guidanceFor(plan, node.key)
  const rule = rules?.chapters?.[node.roleId] || rules?.global?.customChapter || {}
  const focus = textOf(guidance.focus)
  const anchors = Object.entries({ capabilityIds: 'capabilities', problemIds: 'problems', trendIds: 'trends', scenarioIds: 'scenarios' })
    .flatMap(([field, collection]) => {
      const ids = new Set(guidance[field] || [])
      return (plan?.[collection] || []).filter(item => ids.has(item.id)).map(item => textOf(item.text || item.title))
    }).slice(0, 4)
  const custom = Array.isArray(node.questions) ? node.questions : []
  const questions = Array.isArray(rule.extractQuestions) ? rule.extractQuestions : []
  const dynamic = [node.title, textOf(node.goal), focus, anchors.join('；'), textOf(node.audience || audience), textOf(node.evidenceScope)].filter(Boolean).join('；')
  const initial = unique([
    ...(Array.isArray(guidance.retrievalQueries) ? guidance.retrievalQueries : []).slice(0, 2).map(textOf),
    ...custom.slice(0, 1).map(textOf),
    dynamic,
    ...questions.slice(0, 1).map(textOf),
  ]).slice(0, 4)
  const supplemental = unique((Array.isArray(extraQueries) ? extraQueries : []).map(textOf)).filter(q => !initial.includes(q)).slice(0, 3)
  return (extraQueries?.length ? supplemental : initial).map(query => ({ query, purpose: extraQueries?.length ? 'supplement' : 'chapter',
    chapterKey: node.key, roleId: node.roleId }))
}

function balanced(items, descriptors, limit) {
  if (items.length <= limit) return items
  const bases = unique(items.map(item => item.knowledgeBaseId))
  const chosen = []
  const seen = new Set()
  const groups = []
  for (const descriptor of descriptors) {
    const queryId = `Q${hash(JSON.stringify([descriptor.chapterKey || '', descriptor.purpose, descriptor.query])).slice(0, 16)}`
    for (const baseId of bases) groups.push(items.filter(item =>
      item.knowledgeBaseId === baseId && item.retrievedBy?.some(ref => ref.queryId === queryId)))
  }
  while (chosen.length < limit && groups.some(group => group.length)) {
    for (const group of groups) {
      const item = group.shift()
      if (item && !seen.has(item.id)) { chosen.push(item); seen.add(item.id) }
      if (chosen.length === limit) break
    }
  }
  return chosen
}

/** An in-run registry: original chunks stay complete; prompts receive a bounded, relevant subset. */
export function createRetrieval({ client, projectId, evidence, dir, signal, rules, outline, audience }) {
  if (!Array.isArray(evidence)) throw new Error('evidence 必须是共享数组')
  const byId = new Map(evidence.map(item => [item.id, item]))
  const bySource = new Map()
  const initial = [...evidence]
  for (const item of initial.filter(value => value?.kind === 'knowledge')) {
    if (item.knowledgeBaseId && item.knowledgeId && item.chunkId && item.content) {
      bySource.set(JSON.stringify([item.knowledgeBaseId, item.knowledgeId, item.chunkId, hash(item.content)]), item)
    }
  }
  const local = initial.filter(item => item?.kind !== 'knowledge')
  const coverage = []
  const issues = []
  const queries = []
  const cache = new Map()
  const docsByBase = new Map()
  const hitIdsByBase = new Map()
  const chapterSelection = new Map()
  const supplemented = new Set()
  let prepared
  let pendingWrite = Promise.resolve()

  const catalog = () => {
    const localDocs = new Map()
    for (const item of local) {
      const key = localDocumentKey(item)
      const row = localDocs.get(key) || { source: textOf(item.source) || key, documentKey: key, chunks: 0, headings: [] }
      row.chunks++
      const heading = /^\s*#{1,6}\s+(.+)$/mu.exec(item.content || '')?.[1]?.trim()
      if (heading && row.headings.length < 4 && !row.headings.includes(heading)) row.headings.push(heading)
      localDocs.set(key, row)
    }
    return { local: [...localDocs.values()], knowledgeBases: [...docsByBase].map(([baseId, docs]) =>
      ({ baseId, documents: docs.map(doc => ({ id: String(doc.id), title: textOf(doc.title || doc.name || doc.filename || doc.file_name || doc.id) })) })) }
  }

  const flush = () => {
    if (!dir) return Promise.resolve()
    const snapshot = JSON.parse(JSON.stringify({ evidence, coverage }))
    const audit = JSON.parse(JSON.stringify({ queries: [...queries].sort((a, b) => a.queryId.localeCompare(b.queryId) || a.baseId.localeCompare(b.baseId)),
      issues, catalog: catalog(), evidenceCount: evidence.length }))
    const write = pendingWrite.then(async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await writeFile(path.join(dir, 'evidence.json'), JSON.stringify(snapshot, null, 2), { mode: 0o600 })
      await writeFile(path.join(dir, 'retrieval.json'), JSON.stringify(audit, null, 2), { mode: 0o600 })
    })
    pendingWrite = write.catch(() => {})
    return write
  }

  const prepare = () => {
    if (prepared) return prepared
    prepared = (async () => {
      if (!projectId || !client?.visibleProjectBases) { await flush(); return }
      let bases
      try { bases = await retrievalSlot(() => client.visibleProjectBases(projectId, signal), signal) }
      catch (error) {
        if (signal?.aborted) throw error
        issues.push(`知识库授权范围准备失败：${error.message}`)
        await flush()
        return
      }
      if (!Array.isArray(bases)) {
        issues.push('项目绑定知识库列表响应异常')
        await flush()
        return
      }
      const results = await Promise.allSettled(unique(bases.map(String)).map(baseId =>
        retrievalSlot(async () => {
          const docs = await client.documents(baseId, signal)
          if (!Array.isArray(docs)) throw new Error('知识文档列表响应异常')
          return { baseId, docs: docs.filter(doc => doc?.parse_status === 'completed' && doc.id) }
        }, signal)))
      for (const [index, result] of results.entries()) {
        const baseId = unique(bases.map(String))[index]
        if (result.status === 'rejected') {
          if (signal?.aborted) throw result.reason
          coverage.push({ baseId, status: 'failed', completedDocuments: 0, completedQueries: 0,
            hits: 0, errors: [{ error: result.reason.message }] })
          issues.push(`知识库 ${baseId} 文档列表失败：${result.reason.message}`)
          continue
        }
        docsByBase.set(baseId, result.value.docs)
        coverage.push({ baseId, status: result.value.docs.length ? 'ready' : 'no_completed_documents',
          completedDocuments: result.value.docs.length, completedQueries: 0, hits: 0, errors: [] })
        hitIdsByBase.set(baseId, new Set())
      }
      await flush()
    })()
    return prepared
  }

  const register = (baseId, row, descriptor) => {
    const knowledgeId = textOf(row?.knowledge_id)
    const chunkId = textOf(row?.chunk_id ?? row?.id)
    const content = textOf(row?.content ?? row?.matched_content)
    if (!knowledgeId || !chunkId || !content) return null
    const allowed = new Set((docsByBase.get(baseId) || []).map(doc => String(doc.id)))
    if (!allowed.has(knowledgeId)) return null
    const key = JSON.stringify([baseId, knowledgeId, chunkId, hash(content)])
    const reason = { queryId: descriptor.queryId, chapterKey: descriptor.chapterKey || null,
      roleId: descriptor.roleId || null, purpose: descriptor.purpose }
    let item = bySource.get(key)
    if (!item) {
      item = { id: `K${hash(key).slice(0, 24)}`, kind: 'knowledge', knowledgeBaseId: baseId, knowledgeId,
        chunkId, source: textOf(row.knowledge_title || row.knowledge_filename || knowledgeId),
        locator: `chunk=${chunkId}${row.chunk_index != null ? `;index=${row.chunk_index}` : ''}`,
        ...(row.parent_chunk_id ? { parentChunkId: String(row.parent_chunk_id) } : {}),
        ...(row.chunk_index != null ? { chunkIndex: row.chunk_index } : {}),
        ...(row.start_at != null ? { startAt: row.start_at } : {}),
        ...(row.end_at != null ? { endAt: row.end_at } : {}),
        content, retrievedBy: [reason] }
      bySource.set(key, item)
      byId.set(item.id, item)
      evidence.push(item)
    } else {
      item.retrievedBy ||= []
      if (!item.retrievedBy.some(ref => ref.queryId === reason.queryId)) item.retrievedBy.push(reason)
    }
    hitIdsByBase.get(baseId)?.add(item.id)
    return item
  }

  const runQueries = async descriptors => {
    const activeBases = [...docsByBase].filter(([, docs]) => docs.length)
    const jobs = activeBases.flatMap(([baseId, docs]) => descriptors.map(descriptor => ({
      baseId, documentIds: docs.map(doc => String(doc.id)), descriptor: {
        ...descriptor, queryId: `Q${hash(JSON.stringify([descriptor.chapterKey || '', descriptor.purpose, descriptor.query])).slice(0, 16)}`,
      },
    })))
    const attempts = jobs.map(job => {
      const key = JSON.stringify([job.baseId, job.documentIds, job.descriptor.query])
      const queuedAt = new Date().toISOString()
      const cacheHit = cache.has(key)
      if (!cacheHit) {
        const timing = { queuedAt, requestStartedAt: null, finishedAt: null, queueMs: null, serviceMs: null }
        const promise = retrievalSlot(async () => {
          timing.requestStartedAt = new Date().toISOString()
          timing.queueMs = Date.parse(timing.requestStartedAt) - Date.parse(timing.queuedAt)
          try {
            if (client?.searchEvidence) return await client.searchEvidence(job.baseId, job.descriptor.query, job.documentIds, signal)
            if (!client?.search) throw new Error('后台检索接口不可用')
            const rows = await client.search(job.baseId, job.descriptor.query, job.documentIds, signal)
            return { items: rows, status: 'completed', partial: false, traceId: null, source: 'legacy' }
          } finally {
            timing.finishedAt = new Date().toISOString()
            timing.serviceMs = Date.parse(timing.finishedAt) - Date.parse(timing.requestStartedAt)
          }
        }, signal).finally(() => { timing.finishedAt ||= new Date().toISOString() })
        cache.set(key, { promise, timing })
      }
      return { ...cache.get(key), cacheHit, queuedAt }
    })
    const results = await Promise.allSettled(attempts.map(item => item.promise))
    const selected = []
    for (const [index, result] of results.entries()) {
      const { baseId, descriptor } = jobs[index]
      const attempt = attempts[index]
      const timing = attempt.timing
      const record = { baseId, ...descriptor, status: 'failed', hits: 0,
        queuedAt: attempt.queuedAt, requestStartedAt: attempt.cacheHit ? null : timing.requestStartedAt,
        finishedAt: attempt.cacheHit ? new Date().toISOString() : timing.finishedAt,
        queueMs: attempt.cacheHit ? 0 : timing.queueMs,
        serviceMs: attempt.cacheHit ? 0 : timing.serviceMs, cacheHit: attempt.cacheHit,
        ...(attempt.cacheHit ? { sharedWaitMs: Date.now() - Date.parse(attempt.queuedAt) } : {}) }
      const cover = coverage.find(item => item.baseId === baseId)
      if (result.status === 'rejected') {
        if (signal?.aborted) throw result.reason
        record.error = result.reason.message
        cover?.errors.push({ queryId: descriptor.queryId, error: record.error })
        issues.push(`知识库 ${baseId} 查询失败（${descriptor.chapterKey || '发现'}）：${record.error}`)
      } else {
        const response = result.value
        if (!knownSources.has(response?.source) || !['completed', 'failed'].includes(response.status) || !Array.isArray(response.items)) {
          record.error = '检索结果结构异常'
          cover?.errors.push({ queryId: descriptor.queryId, error: record.error })
          issues.push(`知识库 ${baseId} 查询失败（${descriptor.chapterKey || '发现'}）：${record.error}`)
        } else {
          record.status = response.status
          record.source = response.source
          record.partial = Boolean(response.partial)
          record.traceId = response.traceId || null
          if (response.status === 'failed') {
            record.error = response.error || 'hybrid 检索失败'
            cover?.errors.push({ queryId: descriptor.queryId, error: record.error })
            issues.push(`知识库 ${baseId} 查询失败（${descriptor.chapterKey || '发现'}）：${record.error}`)
          } else {
            if (cover) cover.completedQueries++
            const current = new Set()
            for (const row of response.items) {
              const item = register(baseId, row, descriptor)
              if (item) { selected.push(item); current.add(item.id) }
            }
            record.hits = current.size
          }
        }
      }
      queries.push(record)
      if (cover && cover.completedDocuments > 0) {
        cover.hits = hitIdsByBase.get(baseId)?.size || 0
        cover.status = cover.errors.length ? cover.completedQueries ? 'partial' : 'failed' : cover.hits ? 'matched' : 'empty'
      }
    }
    return unique(selected.map(item => item.id)).map(id => byId.get(id))
  }

  const localFor = (queryTexts, max = 12) => {
    if (!local.length) return []
    if (local.length === 1) return [...local]
    const terms = termsOf(queryTexts.join('；'))
    const ranked = local.map((item, index) => ({ item, index, score: score(item, terms) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
    const matched = ranked.filter(row => row.score > 0).slice(0, Math.min(max, 8))
    const chosen = matched.length ? matched : ranked.slice(0, 1)
    const indices = new Set(chosen.map(row => row.index))
    for (const row of chosen) for (const neighbor of [row.index - 1, row.index + 1]) {
      if (neighbor >= 0 && neighbor < local.length &&
        localDocumentKey(local[neighbor]) === localDocumentKey(row.item) && indices.size < max) indices.add(neighbor)
    }
    return [...indices].sort((a, b) => a - b).map(index => local[index])
  }

  const discover = async () => {
    await prepare()
    const descriptors = [
      { query: '本项目产品能力、功能模块、状态归属、适用边界与典型业务场景', purpose: 'discovery' },
      { query: '本项目客户业务问题、行业趋势、客户合作案例与企业介绍', purpose: 'discovery' },
    ]
    const found = balanced(await runQueries(descriptors), descriptors, 16)
    const fromLocal = localFor(descriptors.map(item => item.query), 16)
    const localDocs = new Map()
    for (const item of local) {
      const key = localDocumentKey(item)
      if (!localDocs.has(key)) localDocs.set(key, item)
    }
    for (const item of [...localDocs.values()].slice(0, 12)) if (!fromLocal.includes(item)) fromLocal.push(item)
    const selected = unique([...fromLocal, ...found].map(item => item.id)).map(id => byId.get(id))
    await flush()
    return selected
  }

  const forChapter = async (node, plan, extraQueries = []) => {
    await prepare()
    if (!/^[a-z][a-z0-9-]*$/u.test(String(node?.key || '')) || !node?.roleId) throw new Error('章节缺少有效 key 或 roleId')
    if (extraQueries.length && supplemented.has(node.key)) return chapterSelection.get(node.key) || []
    if (extraQueries.length) supplemented.add(node.key)
    const descriptors = chapterQueries(node, plan, rules, audience, extraQueries)
    const found = balanced(await runQueries(descriptors), descriptors, 16)
    const terms = descriptors.map(item => item.query)
    const fromLocal = localFor(terms)
    const searchTerms = termsOf(terms.join('；'))
    const relatedFound = [...evidence].filter(item => item.kind === 'knowledge' && score(item, searchTerms) > 0)
      .sort((a, b) => score(b, searchTerms) - score(a, searchTerms)).slice(0, 4)
    const guidance = guidanceFor(plan, node.key)
    const anchorIds = planEvidenceIds(plan, guidance)
    const anchors = anchorIds.map(id => byId.get(id)).filter(Boolean)
    const chosen = unique([...(chapterSelection.get(node.key) || []), ...fromLocal, ...anchors, ...found, ...relatedFound]
      .map(item => item.id)).map(id => byId.get(id))
    chapterSelection.set(node.key, chosen)
    const chapterQueriesLog = queries.filter(item => item.chapterKey === node.key)
    if (dir) {
      const chapterDir = path.join(dir, 'chapters', node.key)
      await mkdir(chapterDir, { recursive: true, mode: 0o700 })
      await writeFile(path.join(chapterDir, 'retrieval.json'), JSON.stringify({
        chapterKey: node.key, roleId: node.roleId, evidenceIds: chosen.map(item => item.id),
        queries: chapterQueriesLog, localSelected: fromLocal.map(item => item.id), planAnchors: anchors.map(item => item.id),
      }, null, 2), { mode: 0o600 })
    }
    await flush()
    return chosen
  }

  const selectForSections = (sections, plan) => {
    const ids = new Set()
    const keys = new Set()
    const planRefs = { capabilityIds: new Set(), problemIds: new Set(), trendIds: new Set(), scenarioIds: new Set() }
    for (const section of sections || []) {
      keys.add(section.key)
      for (const block of section.blocks || []) {
        for (const ref of block.evidence || []) ids.add(String(ref.id))
        for (const field of Object.keys(planRefs)) for (const id of block.planRefs?.[field] || []) planRefs[field].add(id)
      }
    }
    for (const key of keys) for (const id of planEvidenceIds(plan, guidanceFor(plan, key))) ids.add(id)
    for (const scenario of plan?.scenarios || []) if (planRefs.scenarioIds.has(scenario.id)) {
      for (const [field, collection] of Object.entries({ capabilityIds: 'capabilities', problemIds: 'problems', trendIds: 'trends' })) {
        for (const id of scenario[field] || []) planRefs[field].add(id)
        for (const row of plan?.[collection] || []) if (planRefs[field].has(row.id)) {
          for (const ref of row.evidence || []) ids.add(String(ref.id))
        }
      }
    }
    for (const [field, collection] of Object.entries({ capabilityIds: 'capabilities', problemIds: 'problems',
      trendIds: 'trends', scenarioIds: 'scenarios' })) {
      for (const row of plan?.[collection] || []) if (planRefs[field].has(row.id)) {
        for (const ref of row.evidence || []) ids.add(String(ref.id))
      }
    }
    const selected = new Set(ids)
    for (const id of ids) {
      const index = local.findIndex(item => item.id === id)
      if (index < 0) continue
      for (const neighbor of [index - 1, index + 1]) {
        if (neighbor >= 0 && neighbor < local.length &&
          localDocumentKey(local[neighbor]) === localDocumentKey(local[index])) selected.add(local[neighbor].id)
      }
    }
    return [...selected].map(id => byId.get(id)).filter(Boolean)
  }

  return { prepare, discover, forChapter, selectForSections, catalog, flush, coverage, issues, evidence }
}

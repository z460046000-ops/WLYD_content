import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { flattenOutline } from './rules.js'
import { validateDraft } from './content.js'
import { mapConcurrent } from './scheduler.js'
import { citedEvidence, itemBatches, list, strings, writeJson } from './context.js'
import { stageContext } from './prompts.js'

export const REVIEW_CHECKS = ['problem-solution', 'capability-evidence', 'scenario-panorama', 'trend-construction', 'contradictions-orphans']
const REVIEW_VERSION = 3
const CHAPTER_BATCH_CHARACTERS = 12000
const CHAPTER_BATCH_BLOCKS = 10
const RELATION_TARGET_CHARACTERS = 8000
const RELATION_TARGET_BLOCKS = 10
const RELATION_GROUP_CHARACTERS = 15000
const RELATION_GROUP_BLOCKS = 12
const refIds = block => Object.values(block.planRefs || {}).flat()
const tokens = text => new Set(String(text).toLowerCase().match(/[a-z]{3,}|[\p{Script=Han}]{2}/gu) || [])
const roleTargets = role => role === 'business-challenges' || role === 'policy-trends'
  ? ['solution', 'scenario-solution'] : ['business-architecture', 'product-architecture', 'business-challenges']
const requiredRelation = role => ({ 'business-challenges': 'problem-solution', 'policy-trends': 'trend-construction', 'scenario-solution': 'scenario-panorama' })[role]
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const uniqueBlocks = blocks => [...new Map(blocks.map(block => [block.id, block])).values()]
const navigation = blocks => blocks.map(block => ({ id: block.id, chapterKey: block.chapterKey, roleId: block.roleId,
  navigationExcerpt: block.text.slice(0, 120), planRefs: block.planRefs }))

/** Full paragraph coverage plus bounded, chapter-coherent relation batches; indexes are navigation only. */
export function reviewGroups(sections, outline) {
  const roles = new Map(flattenOutline(outline).map(node => [node.key, node.roleId]))
  const all = sections.flatMap(section => section.blocks.map(block => ({ ...block, chapterKey: section.key, roleId: roles.get(section.key) })))
  const jobs = []
  for (const section of sections) for (const [i, blocks] of itemBatches(section.blocks, CHAPTER_BATCH_CHARACTERS, CHAPTER_BATCH_BLOCKS).entries()) {
    jobs.push({ scope: `chapter:${section.key}:${i + 1}`, kind: 'chapter',
      blocks: blocks.map(block => ({ ...block, chapterKey: section.key, roleId: roles.get(section.key) })), index: [], relationships: [] })
  }
  const focusRoles = new Set(['business-challenges', 'policy-trends', 'scenario-solution'])
  const relations = []
  for (const focus of all.filter(block => focusRoles.has(block.roleId))) {
    const candidates = all.filter(block => roleTargets(focus.roleId).includes(block.roleId))
    const ids = refIds(focus), words = tokens(focus.text)
    const ranked = candidates.map(block => ({ block, shared: refIds(block).filter(id => ids.includes(id)).length,
      score: refIds(block).filter(id => ids.includes(id)).length * 20 + [...tokens(block.text)].filter(term => words.has(term)).length }))
      .sort((a, b) => b.score - a.score || a.block.id.localeCompare(b.block.id))
    // Every explicit relation is retained. Lexical candidates supplement blocks without shared IDs.
    const selected = ranked.filter(row => row.shared > 0).map(row => row.block)
    for (const role of roleTargets(focus.roleId)) {
      const match = ranked.find(row => row.block.roleId === role)
      if (match) selected.push(match.block)
    }
    const targets = uniqueBlocks(selected)
    const expectedRoles = roleTargets(focus.roleId).filter(role => [...roles.values()].includes(role))
    const missingRoles = expectedRoles.filter(role => !candidates.some(block => block.roleId === role))
    // Keep every known edge, even when a large mainline requires several bounded batches.
    const batches = itemBatches(targets, RELATION_TARGET_CHARACTERS, RELATION_TARGET_BLOCKS)
    if (!batches.length) batches.push([])
    for (const [part, batch] of batches.entries()) relations.push({ focus, targets: batch,
      relation: { id: focus.id, focusId: focus.id, check: requiredRelation(focus.roleId),
        targetIds: batch.map(block => block.id), expectedRoles, missingRoles, part: part + 1, parts: batches.length },
      index: navigation(ranked.filter(row => !batch.some(block => block.id === row.block.id)).slice(0, 8).map(row => row.block)) })
  }
  // Related focuses from the same chapter share one semantic request instead of one call per block.
  let pending
  const commit = () => {
    if (!pending) return
    const focusIds = strings(pending.relationships.map(row => row.focusId))
    const part = pending.relationships[0]
    const scopeSuffix = focusIds.length === 1 && part.parts > 1 ? `:part${part.part}` : ''
    jobs.push({ ...pending, scope: `relationship:${focusIds.join('+')}${scopeSuffix}`,
      index: [...new Map(pending.index.map(row => [row.id, row])).values()].slice(0, 8),
      note: '逐项检查 relationships 中每条主线和全部 targetIds 的完整正文。没有共享 ID 的候选也必须核对；导航不是事实。候选不足或无法核实时写 needs_review，不能凭索引宣称全篇关联通过。' })
    pending = null
  }
  for (const relation of relations) {
    const blocks = uniqueBlocks([relation.focus, ...relation.targets])
    const combined = uniqueBlocks([...(pending?.blocks || []), ...blocks])
    const exceeds = pending && (pending.chapterKey !== relation.focus.chapterKey || combined.length > RELATION_GROUP_BLOCKS
      || JSON.stringify(combined).length > RELATION_GROUP_CHARACTERS || pending.relationships.length >= 4
      || pending.relationships.some(row => row.focusId === relation.focus.id))
    if (exceeds) commit()
    if (!pending) pending = { kind: 'relationship', chapterKey: relation.focus.chapterKey, blocks: [], relationships: [], index: [] }
    pending.blocks = uniqueBlocks([...pending.blocks, ...blocks])
    pending.relationships.push(relation.relation)
    pending.index.push(...relation.index)
  }
  commit()
  // Structured disagreements are cheap to discover; semantic contradictions remain mandatory in chapter audits.
  for (const job of jobs) {
    const ids = new Set(job.blocks.flatMap(block => list(block.planRefs?.capabilityIds)))
    job.boundaryConflicts = [...ids].flatMap(id => {
      const related = all.filter(block => list(block.planRefs?.capabilityIds).includes(id))
      return ['capabilityStatus', 'capabilityOwnership'].flatMap(field => {
        const values = strings(related.map(block => block[field])).filter(value => value !== 'unknown')
        return values.length > 1 ? [{ capabilityId: id, field, values, blockIds: related.map(block => block.id) }] : []
      })
    })
  }
  return jobs
}

export async function reviewAssembly({ request, common, plan, outline, sections, evidence, dir, state, saveState, signal, ruleFingerprint = null, validateBlock,
  allowRepairs = true, splitOnResource = true }) {
  let current = structuredClone(sections)
  const records = [], repairs = [], reviewItems = []
  const cache = new Map(), repairCache = new Map()
  try {
    const history = JSON.parse(await readFile(path.join(dir, 'consistency-review.json'), 'utf8'))
    if (history.reviewVersion === REVIEW_VERSION) for (const row of list(history.reviews)) {
      if (row.fingerprint && row.status === 'completed') cache.set(row.fingerprint, row)
    }
    if (history.reviewVersion === REVIEW_VERSION) for (const row of list(history.repairs)) {
      if (row.fingerprint && row.status === 'completed' && Array.isArray(row.response?.replacements)) repairCache.set(row.fingerprint, row.response)
    }
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
  let persistQueue = Promise.resolve()
  const persist = () => {
    const snapshot = structuredClone({ ...state.review, reviewVersion: REVIEW_VERSION, ruleFingerprint, checks: REVIEW_CHECKS,
      reviews: records, repairs, reviewItems: strings(reviewItems) })
    persistQueue = persistQueue.then(() => writeJson(path.join(dir, 'consistency-review.json'), snapshot))
    return persistQueue
  }
  const inspect = async (job, round, splitDepth = 0) => {
    const inputEvidence = citedEvidence([...job.blocks, ...list(plan.capabilities).filter(cap => job.blocks.some(block =>
      list(block.planRefs?.capabilityIds).includes(cap.id)))], evidence)
    const sourceIds = new Set(inputEvidence.map(row => row.id))
    const relevantIds = new Set(job.blocks.flatMap(refIds))
    const relationPlan = Object.fromEntries(['capabilities', 'problems', 'trends', 'scenarios'].map(field => [field,
      list(plan[field]).filter(row => relevantIds.has(row.id)).map(row => ({ ...row,
        ...(row.evidence ? { evidence: row.evidence.filter(ref => sourceIds.has(ref.id)) } : {}) }))]))
    const hash = fingerprint({ reviewVersion: REVIEW_VERSION, ruleFingerprint, job, common, plan: relationPlan, outline, evidence: inputEvidence })
    const previous = cache.get(hash)
    if (previous) {
      const record = { ...structuredClone(previous), scope: job.scope, round, cached: true }
      records.push(record); await persist(); return record
    }
    try {
      const audit = await request({ ...stageContext(common, 'consistency-review'), stage: 'consistency-review', reviewScope: job.scope, round,
        evidence: inputEvidence, sections: job.blocks, relationshipIndex: job.index, relationships: job.relationships,
        boundaryConflicts: job.boundaryConflicts, plan: relationPlan,
        confirmedOutline: outline, scopeNote: job.note || '本批完整正文逐段核对，包含事实边界和语义矛盾；本章不承担的跨章项可说明不适用，由主线批次联合检查。',
        checks: REVIEW_CHECKS,
        schema: { checks: [{ id: '检查项目 ID', status: 'pass/needs_review/not_applicable', reason: '对应段落与具体理由', blockIds: ['当前范围段落 ID'] }],
          reviewItems: ['具体问题'], repairNeeded: false } })
      const checks = REVIEW_CHECKS.map(id => {
        const row = list(audit.checks).find(item => item?.id === id)
        let status = ['pass', 'needs_review', 'not_applicable'].includes(row?.status) && String(row.reason || '').trim() ? row.status : 'unverified'
        const blockIds = list(row?.blockIds).filter(value => job.blocks.some(block => block.id === value))
        const required = id === 'capability-evidence' || id === 'contradictions-orphans' || job.relationships.some(relation => relation.check === id)
        if (required && status === 'not_applicable') status = 'unverified'
        const missing = job.relationships.filter(relation => relation.check === id && (!relation.targetIds.length || relation.missingRoles.length))
        if (missing.length && ['pass', 'not_applicable'].includes(status)) status = 'unverified'
        const reason = missing.length ? `缺少可联合检查的目标正文：${missing.map(relation => relation.focusId).join('、')}；${row?.reason || ''}` : String(row?.reason || '模型未完整返回本项检查')
        return { id, status, reason, blockIds }
      })
      const passed = checks.every(row => ['pass', 'not_applicable'].includes(row.status))
      const record = { scope: job.scope, round, fingerprint: hash, status: checks.some(row => row.status === 'unverified') ? 'incomplete' : 'completed',
        passed, checks, reviewItems: strings(audit.reviewItems), blockIds: job.blocks.map(block => block.id),
        focusIds: strings(job.relationships.map(row => row.focusId)), relationshipIds: job.relationships.map(row => `${row.id}:${row.part}`),
        repairNeeded: !passed && checks.some(row => row.status === 'needs_review' && (row.blockIds.length > 0 || audit.repairNeeded === true)) }
      records.push(record)
      if (record.status === 'completed') cache.set(hash, record)
      await persist(); return record
    } catch (error) {
      if (signal?.aborted) throw error
      if (splitOnResource && ['MODEL_CONTEXT_LIMIT', 'MODEL_OUTPUT_LIMIT', 'context_length_exceeded'].includes(error.code) && splitDepth < 2 && job.blocks.length > 1) {
        const mid = Math.ceil(job.blocks.length / 2)
        records.push({ scope: job.scope, round, fingerprint: hash, status: 'split', passed: false, error: error.message })
        for (const [i, blocks] of [job.blocks.slice(0, mid), job.blocks.slice(mid)].entries()) await inspect({ ...job,
          scope: `${job.scope}:part${i + 1}`, blocks, index: [] }, round, splitDepth + 1)
        // A split never substitutes for the original semantic relation audit.
        const record = { scope: job.scope, round, fingerprint: hash, status: 'incomplete', passed: false,
          error: '关联或章节批次因资源限制拆分，子批检查保留；联合语义未完成', blockIds: job.blocks.map(block => block.id) }
        records.push(record); await persist(); return record
      }
      const record = { scope: job.scope, round, fingerprint: hash, status: 'failed', passed: false, error: error.message, blockIds: job.blocks.map(block => block.id) }
      records.push(record); await persist(); return record
    }
  }
  state.status = 'reviewing'; state.review = { status: 'running', passed: false, mode: 'chapter-and-relationships' }; await saveState()
  const jobs = reviewGroups(current, outline)
  const first = await mapConcurrent(jobs, job => inspect(job, 0), { signal })
  if (signal?.aborted) throw signal.reason
  const repairJobs = first.flatMap((result, i) => result?.status === 'fulfilled' && result.value.repairNeeded ? [{ job: jobs[i], audit: result.value }] : [])
  // Commit repairs sequentially and revalidate sources; at most one small repair round.
  for (const { job, audit } of (allowRepairs ? repairJobs.slice(0, 3) : [])) {
    try {
      const blocks = job.blocks.map(block => ({ ...block, ...current.flatMap(section => section.blocks).find(row => row.id === block.id) }))
      const sources = citedEvidence(blocks, evidence)
      const repairFingerprint = fingerprint({ reviewVersion: REVIEW_VERSION, ruleFingerprint, blocks, sources, common, outline, plan,
        issues: audit.checks.filter(row => row.status === 'needs_review'), reviewItems: audit.reviewItems })
      const cachedResponse = repairCache.get(repairFingerprint)
      const response = cachedResponse || await request({ ...stageContext(common, 'relationship-repair'), stage: 'relationship-repair', reviewScope: job.scope, evidence: sources,
        blocks, issues: audit.checks.filter(row => row.status === 'needs_review'), reviewItems: audit.reviewItems,
        schema: { replacements: [{ id: '现有段落 ID', text: '修正正文', supportMode: 'sourced/candidate', evidence: [{ id: '原文 ID', quote: '逐字原文' }], planRefs: {} }], reviewItems: [] } })
      const next = structuredClone(current), changed = []
      if (!Array.isArray(response.replacements) || response.replacements.length > 2) throw new Error('局部修正格式或数量无效')
      for (const patch of response.replacements) {
        const original = blocks.find(block => block.id === patch.id)
        if (!original) throw new Error('修正包含范围外段落')
        const section = next.find(row => row.blocks.some(block => block.id === patch.id))
        const replacement = { ...original, ...patch, id: original.id }
        if (original.supportMode === 'candidate' && replacement.supportMode !== 'candidate') throw new Error('局部修正不得将候选提升为事实')
        if (!list(replacement.evidence).every(ref => sources.some(source => source.id === ref.id && source.content.includes(ref.quote)))) throw new Error('局部修正引用不在当前证据内')
        validateBlock?.(replacement, section.key)
        const checked = validateDraft({ sections: [{ key: section.key, blocks: [replacement] }] }, evidence, outline, plan)
        if (checked.issues.length) throw new Error(checked.issues.join('；'))
        const before = section.blocks.find(block => block.id === patch.id)
        const after = checked.sections[0].blocks[0]
        if (fingerprint(before) !== fingerprint(after)) {
          section.blocks[section.blocks.findIndex(block => block.id === patch.id)] = after; changed.push(patch.id)
        }
      }
      current = next
      const safeResponse = { replacements: response.replacements, reviewItems: strings(response.reviewItems) }
      repairCache.set(repairFingerprint, safeResponse)
      repairs.push({ scope: job.scope, status: 'completed', fingerprint: repairFingerprint, cached: Boolean(cachedResponse),
        response: safeResponse, changed, reviewItems: strings(response.reviewItems) })
      await writeJson(path.join(dir, 'assembly-reviewed.json'), { sections: current, review: state.review })
      await persist()
    } catch (error) { if (signal?.aborted) throw error; repairs.push({ scope: job.scope, status: 'failed', error: error.message }); await persist() }
  }
  const changed = repairs.some(row => row.changed?.length)
  const finalJobs = changed ? reviewGroups(current, outline) : jobs
  // Rebuilding discovers new relationships; unchanged fingerprints reuse results without a model call.
  const finalResults = changed ? await mapConcurrent(finalJobs, job => inspect(job, 1), { signal }) : first
  const final = finalResults.map(result => result.status === 'fulfilled' ? result.value : { status: 'failed', passed: false, error: result.reason.message })
  const missingChapters = flattenOutline(outline).filter(node => !current.some(section => section.key === node.key && section.blocks?.length)).map(node => node.key)
  const paragraphs = current.flatMap(section => section.blocks.map(block => block.id))
  const focusIds = strings(finalJobs.flatMap(job => job.relationships.map(row => row.focusId)))
  const completedParagraphs = new Set(finalJobs.flatMap((job, i) => job.kind === 'chapter' && final[i]?.status === 'completed' ? job.blocks.map(block => block.id) : []))
  const completedRelations = focusIds.filter(id => finalJobs.every((job, i) => !job.relationships.some(row => row.focusId === id) || final[i]?.status === 'completed'))
  const coverage = { paragraphs: { total: paragraphs.length, completed: completedParagraphs.size, uncheckedIds: paragraphs.filter(id => !completedParagraphs.has(id)) },
    relationships: { total: focusIds.length, completed: completedRelations.length, uncheckedIds: focusIds.filter(id => !completedRelations.includes(id)) },
    reusedGroups: final.filter(row => row.cached).length,
    capabilityChecks: 'structured-boundaries-and-chapter-semantics', indexLimit: 8 }
  const completed = final.every(row => row.status === 'completed') && !coverage.paragraphs.uncheckedIds.length && !coverage.relationships.uncheckedIds.length
  const passed = completed && !missingChapters.length && final.length > 0 && final.every(row => row.passed)
  if (missingChapters.length) reviewItems.push(`缺少章节 ${missingChapters.join('、')}，整体关联检查不能算通过`)
  for (const row of final) {
    reviewItems.push(...(row.reviewItems || []))
    for (const check of row.checks || []) if (['needs_review', 'unverified'].includes(check.status)) reviewItems.push(`${row.scope} / ${check.id}：${check.reason}`)
    if (row.error) reviewItems.push(`${row.scope} 合稿检查未完成：${row.error}`)
  }
  for (const row of repairs) { reviewItems.push(...(row.reviewItems || [])); if (row.error) reviewItems.push(`局部修正未完成：${row.error}`) }
  state.review = { status: completed ? 'completed' : 'partial', passed, mode: 'chapter-and-relationships',
    groups: final.length, missingChapters, repairs: repairs.filter(row => row.changed?.length).length, coverage }
  await persist()
  await writeJson(path.join(dir, 'assembly-reviewed.json'), { sections: current, review: state.review })
  await saveState()
  return { sections: current, reviewItems: strings(reviewItems), review: state.review }
}

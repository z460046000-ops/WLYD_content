import path from 'node:path'
import { flattenOutline } from './rules.js'
import { validateDraft } from './content.js'
import { mapConcurrent } from './scheduler.js'
import { citedEvidence, itemBatches, list, strings, writeJson, NON_REPEATABLE } from './context.js'

export const REVIEW_CHECKS = ['problem-solution', 'capability-evidence', 'scenario-panorama', 'trend-construction', 'contradictions-orphans']
const refIds = block => Object.values(block.planRefs || {}).flat()
const tokens = text => new Set(String(text).toLowerCase().match(/[a-z]{3,}|[\p{Script=Han}]{2}/gu) || [])
const roleTargets = role => role === 'business-challenges' || role === 'policy-trends'
  ? ['solution', 'scenario-solution'] : ['business-architecture', 'product-architecture', 'business-challenges']

/** Every paragraph is checked; cross-chapter candidates include blocks without shared IDs. */
export function reviewGroups(sections, outline) {
  const roles = new Map(flattenOutline(outline).map(node => [node.key, node.roleId]))
  const all = sections.flatMap(section => section.blocks.map(block => ({ ...block, chapterKey: section.key, roleId: roles.get(section.key) })))
  const index = all.map(block => ({ id: block.id, chapterKey: block.chapterKey, roleId: block.roleId,
    navigationExcerpt: block.text.slice(0, 120), planRefs: block.planRefs }))
  const jobs = []
  for (const section of sections) for (const [i, blocks] of itemBatches(section.blocks, 4500, 3).entries()) {
    jobs.push({ scope: `chapter:${section.key}:${i + 1}`, blocks: blocks.map(block => ({ ...block, chapterKey: section.key, roleId: roles.get(section.key) })), index })
  }
  const focusRoles = new Set(['business-challenges', 'policy-trends', 'scenario-solution'])
  for (const focus of all.filter(block => focusRoles.has(block.roleId))) {
    const candidates = all.filter(block => roleTargets(focus.roleId).includes(block.roleId))
    const ids = refIds(focus), words = tokens(focus.text)
    const ranked = candidates.map(block => ({ block, score: refIds(block).filter(id => ids.includes(id)).length * 20
      + [...tokens(block.text)].filter(term => words.has(term)).length })).sort((a, b) => b.score - a.score)
    const selected = []
    for (const role of roleTargets(focus.roleId)) {
      const match = ranked.find(row => row.block.roleId === role)
      if (match) selected.push(match.block)
    }
    jobs.push({ scope: `relationship:${focus.id}`, blocks: [focus, ...selected], index,
      note: '逐项核对 focus 与候选正文的对应，目录索引仅供发现其他关联，不是事实证据；没有候选不能宣称全篇没有关联。无匹配时标 needs_review。' })
  }
  const capabilityIds = [...new Set(all.flatMap(block => list(block.planRefs?.capabilityIds)))]
  for (const id of capabilityIds) {
    const related = all.filter(block => list(block.planRefs?.capabilityIds).includes(id))
    if (new Set(related.map(block => block.chapterKey)).size < 2) continue
    const anchor = related[0]
    for (const [i, batch] of itemBatches(related.slice(1), 3500, 3).entries()) {
      jobs.push({ scope: `capability:${id}:${i + 1}`, blocks: [anchor, ...batch], index: [],
        note: '同一能力在多章的重复表述，核对是否存在状态、归属、适用条件或承诺矛盾；候选不能升级为事实。' })
    }
  }
  return jobs
}

export async function reviewAssembly({ request, common, plan, outline, sections, evidence, dir, state, saveState, signal }) {
  let current = structuredClone(sections)
  const records = [], repairs = [], reviewItems = []
  const inspect = async (job, round, splitDepth = 0) => {
    const inputEvidence = citedEvidence([...job.blocks, ...list(plan.capabilities).filter(cap => job.blocks.some(block =>
      list(block.planRefs?.capabilityIds).includes(cap.id)))], evidence)
    const sourceIds = new Set(inputEvidence.map(row => row.id))
    const relevantIds = new Set(job.blocks.flatMap(refIds))
    const relationPlan = Object.fromEntries(['capabilities', 'problems', 'trends', 'scenarios'].map(field => [field,
      list(plan[field]).filter(row => relevantIds.has(row.id)).map(row => ({ ...row,
        ...(row.evidence ? { evidence: row.evidence.filter(ref => sourceIds.has(ref.id)) } : {}) }))]))
    try {
      const audit = await request({ ...common, stage: 'consistency-review', reviewScope: job.scope, round,
        evidence: inputEvidence, sections: job.blocks, relationshipIndex: job.index,
        plan: relationPlan, confirmedOutline: outline, scopeNote: job.note || '本批完整正文逐段核对；索引是导航选段，不能当事实依据。',
        task: '必须逐项检查 checks 中所有项目：重点问题是否有方案回应，能力是否有证据，重点场景是否在两类全景对应，趋势是否关联建设内容，有无矛盾、无关堆砌或孤立内容。检查引用语义、客户与厂商内部问题、试点规划和第三方边界。索引未提供完整正文时不能判定跨章通过；未知写 needs_review。范围确不涉及某项时可 not_applicable 并说明理由；本章角色涉及的项目不能借此跳过。不得把候选当客户事实。只返回短审核结果；不重写正文。',
        checks: REVIEW_CHECKS,
        schema: { checks: [{ id: '检查项目 ID', status: 'pass/needs_review/not_applicable', reason: '对应段落与具体理由', blockIds: ['当前范围段落 ID'] }],
          reviewItems: ['具体问题'], repairNeeded: false } })
      const checks = REVIEW_CHECKS.map(id => {
        const row = list(audit.checks).find(item => item?.id === id)
        const status = ['pass', 'needs_review', 'not_applicable'].includes(row?.status) && String(row.reason || '').trim() ? row.status : 'unverified'
        const blockIds = list(row?.blockIds).filter(value => job.blocks.some(block => block.id === value))
        const required = id === 'capability-evidence' || id === 'contradictions-orphans'
          || (job.scope.startsWith('relationship:') && ({ 'problem-solution': 'business-challenges', 'trend-construction': 'policy-trends', 'scenario-panorama': 'scenario-solution' })[id] === job.blocks[0]?.roleId)
        return { id, status: required && status === 'not_applicable' ? 'unverified' : status,
          reason: String(row?.reason || '模型未完整返回本项检查'), blockIds }
      })
      const passed = checks.every(row => ['pass', 'not_applicable'].includes(row.status))
      const record = { scope: job.scope, round, status: checks.some(row => row.status === 'unverified') ? 'incomplete' : 'completed',
        passed, checks, reviewItems: strings(audit.reviewItems), blockIds: job.blocks.map(block => block.id),
        repairNeeded: !passed && checks.some(row => row.status === 'needs_review'
          && (row.blockIds.length > 0 || audit.repairNeeded === true)) }
      records.push(record)
      return record
    } catch (error) {
      if (signal?.aborted) throw error
      if (NON_REPEATABLE.has(error.code) && splitDepth < 2 && job.blocks.length > 1) {
        const mid = Math.ceil(job.blocks.length / 2)
        records.push({ scope: job.scope, round, status: 'split', passed: false, error: error.message })
        // Splitting a relation loses joint context: never promote these subchecks to relation approval.
        const sub = []
        for (const [i, blocks] of [job.blocks.slice(0, mid), job.blocks.slice(mid)].entries()) sub.push(await inspect({ ...job,
          scope: `${job.scope}:part${i + 1}`, blocks }, round, splitDepth + 1))
        const record = { scope: job.scope, round, status: 'incomplete', passed: false,
          error: '关联或章节批次因资源限制拆分，子批检查保留；联合语义未完成', blockIds: job.blocks.map(block => block.id) }
        records.push(record); return record
      }
      const record = { scope: job.scope, round, status: 'failed', passed: false, error: error.message, blockIds: job.blocks.map(block => block.id) }
      records.push(record); return record
    }
  }
  state.status = 'reviewing'; state.review = { status: 'running', passed: false, mode: 'chapter-and-relationships' }; await saveState()
  const jobs = reviewGroups(current, outline)
  const first = await mapConcurrent(jobs, job => inspect(job, 0), { signal })
  if (signal?.aborted) throw signal.reason
  const repairJobs = first.flatMap((result, i) => result?.status === 'fulfilled' && result.value.repairNeeded ? [{ job: jobs[i], audit: result.value }] : [])
  // A bounded repair round; sequential commits avoid racing changes to the same paragraph.
  for (const { job, audit } of repairJobs.slice(0, 3)) {
    try {
      const blocks = job.blocks.map(block => ({ ...block, ...current.flatMap(section => section.blocks).find(row => row.id === block.id) }))
      const sources = citedEvidence(blocks, evidence)
      const response = await request({ ...common, stage: 'relationship-repair', reviewScope: job.scope, evidence: sources,
        blocks, issues: audit.checks.filter(row => row.status === 'needs_review'), reviewItems: audit.reviewItems,
        task: '只修正当前已有段落的前后关联或事实边界，最多两段。保持 id、章节、原有事实与候选标签。不能新增能力、数字、承诺或客户事实，不能删除段落；无法有据修正时不修改并说明原因。只用本次 evidence 引文。',
        schema: { replacements: [{ id: '现有段落 ID', text: '修正正文', supportMode: 'sourced/candidate', evidence: [{ id: '原文 ID', quote: '逐字原文' }], planRefs: {} }], reviewItems: [] } })
      const next = structuredClone(current), changed = []
      if (!Array.isArray(response.replacements) || response.replacements.length > 2) throw new Error('局部修正格式或数量无效')
      for (const patch of response.replacements) {
        const original = blocks.find(block => block.id === patch.id)
        if (!original) throw new Error('修正包含范围外段落')
        const section = next.find(row => row.blocks.some(block => block.id === patch.id))
        const replacement = { ...original, ...patch, id: original.id }
        if (original.supportMode === 'candidate' && replacement.supportMode !== 'candidate') throw new Error('局部修正不得将候选提升为事实')
        const refsAllowed = list(replacement.evidence).every(ref => sources.some(source => source.id === ref.id && source.content.includes(ref.quote)))
        if (!refsAllowed) throw new Error('局部修正引用不在当前证据内')
        const checked = validateDraft({ sections: [{ key: section.key, blocks: [replacement] }] }, evidence, outline, plan)
        if (checked.issues.length) throw new Error(checked.issues.join('；'))
        section.blocks[section.blocks.findIndex(block => block.id === patch.id)] = checked.sections[0].blocks[0]
        changed.push(patch.id)
      }
      current = next
      repairs.push({ scope: job.scope, status: 'completed', changed, reviewItems: strings(response.reviewItems) })
    } catch (error) { if (signal?.aborted) throw error; repairs.push({ scope: job.scope, status: 'failed', error: error.message }) }
  }
  const changed = repairs.some(row => row.changed?.length)
  let finalResults = first
  if (changed) finalResults = await mapConcurrent(reviewGroups(current, outline), job => inspect(job, 1), { signal })
  const final = finalResults.map(result => result.status === 'fulfilled' ? result.value : { status: 'failed', passed: false, error: result.reason.message })
  const missingChapters = flattenOutline(outline).filter(node => !current.some(section => section.key === node.key)).map(node => node.key)
  const completed = final.every(row => row.status === 'completed')
  const passed = completed && !missingChapters.length && final.length > 0 && final.every(row => row.passed)
  if (missingChapters.length) reviewItems.push(`缺少章节 ${missingChapters.join('、')}，整体关联检查不能算通过`)
  for (const row of final) {
    reviewItems.push(...(row.reviewItems || []))
    for (const check of row.checks || []) if (['needs_review', 'unverified'].includes(check.status)) reviewItems.push(`${row.scope} / ${check.id}：${check.reason}`)
    if (row.error) reviewItems.push(`${row.scope} 合稿检查未完成：${row.error}`)
  }
  for (const row of repairs) { reviewItems.push(...(row.reviewItems || [])); if (row.error) reviewItems.push(`局部修正未完成：${row.error}`) }
  state.review = { status: completed ? 'completed' : 'partial', passed, mode: 'chapter-and-relationships',
    groups: final.length, missingChapters, repairs: repairs.filter(row => row.changed?.length).length }
  await writeJson(path.join(dir, 'consistency-review.json'), { ...state.review, checks: REVIEW_CHECKS, reviews: records, repairs, reviewItems: strings(reviewItems) })
  await writeJson(path.join(dir, 'assembly-reviewed.json'), { sections: current, review: state.review })
  await saveState()
  return { sections: current, reviewItems: strings(reviewItems), review: state.review }
}

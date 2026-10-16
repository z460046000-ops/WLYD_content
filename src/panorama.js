import { createHash } from 'node:crypto'
import path from 'node:path'
import { flattenOutline } from './rules.js'
import { validateDraft, PANORAMA_ROLES } from './content.js'
import { abortError } from './scheduler.js'
import { atomicJson as writeJson, readJson } from './persistence.js'

const list = value => Array.isArray(value) ? value : []
const strings = value => list(value).filter(item => typeof item === 'string' && item.trim()).map(item => item.trim())
const bodyKey = text => String(text || '').replace(/^(?:【[^】]*】)*/u, '').replace(/\s/gu, '')
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')

/** Cached enrichment is reusable only as an intact add-only result with valid original sources. */
async function reusableEnrichment({ file, inputSha256, chapters, targets, outline, plan, evidence, dir, validateBlock }) {
  try {
    const saved = await readJson(file, null)
    if (saved?.cacheVersion !== 1 || saved.status !== 'completed' || saved.inputSha256 !== inputSha256
      || !Array.isArray(saved.result?.chapters) || digest(saved.result) !== saved.resultSha256
      || saved.result.chapters.length !== chapters.length) return null
    const targetKeys = new Set(targets.map(section => section.key))
    const appended = []
    for (const [index, chapter] of saved.result.chapters.entries()) {
      const original = chapters[index]
      if (chapter.section?.key !== original.section.key) return null
      if (!targetKeys.has(chapter.section.key)) {
        if (digest(chapter) !== digest(original)) return null
        continue
      }
      const initial = original.section.blocks, blocks = chapter.section.blocks
      if (!Array.isArray(blocks) || blocks.length < initial.length || digest(blocks.slice(0, initial.length)) !== digest(initial)) return null
      const additions = blocks.slice(initial.length)
      appended.push(...additions.map(block => ({ block, chapterKey: chapter.section.key })))
      if (additions.length) {
        const checked = validateDraft({ sections: [{ key: chapter.section.key, blocks: additions }] }, evidence, outline, plan)
        if (checked.issues.length || digest(checked.sections[0].blocks) !== digest(additions)) return null
      }
    }
    for (const item of list(saved.updatedChapters)) {
      if (!targetKeys.has(item.key) || item.path !== `chapters/${item.key}/enriched.json`) return null
      const output = await readJson(path.join(dir, item.path), null)
      if (!output || !item.outputSha256 || digest(output) !== item.outputSha256) return null
      const chapter = saved.result.chapters.find(row => row.section.key === item.key)
      if (digest(output.section) !== digest(chapter.section)) return null
    }
    const policyIssues = []
    for (const { block, chapterKey } of appended) {
      try { validateBlock?.(block, chapterKey) }
      catch (error) { policyIssues.push(`${chapterKey} 缓存补充未通过用途校验：${error.message}`) }
    }
    if (policyIssues.length) return { policyRejected: true, validationIssues: policyIssues }
    return saved
  } catch { return null }
}

/** ID coverage is an organization hint; it does not prove semantic support. */
export function panoramaCoverage(sections, outline) {
  const roles = new Map(flattenOutline(outline).map(node => [node.key, node.roleId]))
  const scenarioIds = [...new Set(sections.filter(section => roles.get(section.key) === 'scenario-solution')
    .flatMap(section => section.blocks.flatMap(block => block.planRefs.scenarioIds)))]
  return sections.filter(section => PANORAMA_ROLES.includes(roles.get(section.key))).map(section => {
    const covered = new Set(section.blocks.flatMap(block => block.planRefs.scenarioIds))
    return { key: section.key, missingScenarioIds: scenarioIds.filter(id => !covered.has(id)) }
  })
}

/** One add-only pass after all chapters settle. Original chapter files stay intact. */
export async function enrichPanoramas({ request, common, plan, outline, rules, chapters, evidence, dir, state, saveState, signal, selectEvidence, validateBlock }) {
  const nodes = flattenOutline(outline)
  const byKey = new Map(nodes.map(node => [node.key, node]))
  const sections = chapters.map(chapter => chapter.section)
  const targets = sections.filter(section => PANORAMA_ROLES.includes(byKey.get(section.key)?.roleId))
  const hasScenarios = sections.some(section => byKey.get(section.key)?.roleId === 'scenario-solution')
  const reviewItems = []
  const validationIssues = []
  const result = { chapters: [...chapters], reviewItems, validationIssues }
  const coverageBefore = panoramaCoverage(sections, outline)
  const progress = state.panoramaEnrichment = { status: 'skipped', rounds: 0, additions: 0 }
  if (!targets.length || !hasScenarios) {
    progress.reason = !targets.length ? '没有已完成的全景章' : '没有已完成的场景章'
    await saveState()
    return result
  }
  state.status = 'enriching_panoramas'
  Object.assign(progress, { status: 'running', rounds: 1 })
  await saveState()
  let draft
  let inputSha256
  try {
    const relevantSections = sections.filter(section => PANORAMA_ROLES.includes(byKey.get(section.key)?.roleId)
      || byKey.get(section.key)?.roleId === 'scenario-solution')
    const selected = selectEvidence ? selectEvidence(relevantSections) : evidence.filter(item => relevantSections.some(section =>
      section.blocks.some(block => list(block.evidence).some(ref => ref.id === item.id)
        || list(block.planRefs?.capabilityIds).some(id => plan.capabilities.some(cap => cap.id === id && cap.evidence.some(ref => ref.id === item.id))))))
    const ids = new Set(selected.map(item => item.id))
    if (JSON.stringify(relevantSections).length + JSON.stringify(selected).length > 12000) {
      Object.assign(progress, { status: 'skipped', reason: '全景补充输入较大，交由分组关联检查和局部修正处理' })
      reviewItems.push(progress.reason)
      return result
    }
    const scopedPlan = { ...plan, ...Object.fromEntries(['capabilities', 'problems', 'trends'].map(field => [field,
      list(plan[field]).map(item => ({ ...item, evidence: list(item.evidence).filter(ref => ids.has(ref.id)) })),
    ])) }
    inputSha256 = digest({ cacheVersion: 1, chapters, common, plan, outline, evidence, selected,
      ruleFingerprint: rules.fingerprint || null, chapterRules: rules.chapters,
      modelSelection: state.modelSelection || null })
    const cached = await reusableEnrichment({ file: path.join(dir, 'panorama-enrichment.json'), inputSha256,
      chapters, targets, outline, plan, evidence, dir, validateBlock })
    if (cached?.policyRejected) {
      validationIssues.push(...cached.validationIssues)
      reviewItems.push('全景缓存补充未通过本章用途校验，原有正文已保留')
      Object.assign(progress, { status: 'partial', additions: 0, cached: false, inputSha256, validationIssues: [...validationIssues] })
      for (const target of targets) {
        const chapterState = state.chapters.find(chapter => chapter.key === target.key)
        if (chapterState) {
          chapterState.enrichment = { status: 'rejected', addedBlocks: 0 }
          chapterState.path = `chapters/${target.key}/chapter.json`
        }
      }
      return result
    }
    if (cached) {
      result.chapters = structuredClone(cached.result.chapters)
      reviewItems.push(...strings(cached.result.reviewItems)); validationIssues.push(...strings(cached.result.validationIssues))
      Object.assign(progress, { status: 'completed', rounds: 1, additions: cached.additions, cached: true, inputSha256 })
      for (const item of list(cached.updatedChapters)) {
        const chapterState = state.chapters.find(chapter => chapter.key === item.key)
        if (chapterState) {
          chapterState.enrichment = { status: 'completed', addedBlocks: item.addedBlockIds.length, path: item.path, cached: true }
          chapterState.path = item.path
        }
      }
      return result
    }
    draft = await request({ ...common, evidence: selected.map(item => ({ id: item.id, content: item.content })),
      stage: 'panorama-enrichment', plan: scopedPlan, outline, sections: relevantSections,
      targetChapters: targets.map(section => byKey.get(section.key)), coverageBefore,
      panoramaRules: Object.fromEntries(targets.map(section => [byKey.get(section.key).roleId, rules.chapters[byKey.get(section.key).roleId]])),
      task: '只做一轮全景内容补充。查看后文实际展开的重点场景及其他章节，检查两类全景是否遗漏上级业务节点、关键产品支撑或必要价值解释。优先复用已有节点承接；若原稿已充分覆盖，返回 additions:[]。只对 targetChapters 追加必要正文，不重写或删除原段落，不更改标题、维度选择、目录或共享 ID，不重复细节。按本次业务的读者、问题与场景动态组织，不强套三层或五层。补充解释问题→使用者与动作→支撑能力→产出和价值机制，两类全景互相可定位，具体操作仍留在场景章。节点归类、流程、依赖和支撑关系分别说明，不因位置推定关系。每段复用已存在的 planRefs；有据事实给逐字引文，推演标 supportMode=candidate 并用条件语气。标明能力状态与归属，正文说明第三方、客户已有、试点和规划，不能升级为自有或已具备。引用不能用来证明不相干能力。coverageBefore 只是 ID 覆盖提示，是否有必要补充仍按正文判断；关联不足只列 reviewItems，不阻断成稿。',
      schema: { additions: [{ key: 'targetChapters 中的 key', blocks: [{ text: '必要补充正文', supportMode: 'sourced 或 candidate',
        capabilityStatus: 'existing/pilot/planned/proposed/unknown 选一', capabilityOwnership: 'self/third-party/customer/unknown 选一',
        evidence: [{ id: '原始证据 ID', quote: '逐字原文' }],
        planRefs: { capabilityIds: [], scenarioIds: [], problemIds: [], trendIds: [] } }] }], reviewItems: [] } })
    if (!Array.isArray(draft.additions)) throw new Error('全景补充缺少 additions 数组')
    reviewItems.push(...strings(draft.reviewItems))
    const targetKeys = new Set(targets.map(section => section.key))
    const grouped = new Map(targets.map(section => [section.key, []]))
    for (const entry of draft.additions) {
      if (!entry || !targetKeys.has(entry.key) || !Array.isArray(entry.blocks)) {
        validationIssues.push('全景补充包含目录外、未完成或非全景章节，已略过'); continue
      }
      grouped.get(entry.key).push(...entry.blocks)
    }
    // Validate and prepare every result before writing or changing run pointers.
    const prepared = []
    for (const original of targets) {
      const accepted = []
      const seen = new Set(original.blocks.map(block => bodyKey(block.text)))
      const usedIds = new Set(original.blocks.map(block => block.id))
      let serial = original.blocks.length
      for (const block of grouped.get(original.key)) {
        if (!block || !String(block.text || '').trim()) { validationIssues.push(`${original.key} 补充有无效段落`); continue }
        if (seen.has(bodyKey(block.text))) continue
        const unknownRefs = Object.entries({ capabilityIds: 'capabilities', scenarioIds: 'scenarios', problemIds: 'problems', trendIds: 'trends' })
          .some(([field, collection]) => list(block.planRefs?.[field]).some(id => !(plan[collection] || []).some(item => item.id === id)))
        if (unknownRefs) { validationIssues.push(`${original.key} 补充引用了共享规划外的 ID，已略过`); continue }
        let id
        do { id = `${original.key}-${++serial}` } while (usedIds.has(id))
        try {
          validateBlock?.({ ...block, id }, original.key)
          const checked = validateDraft({ sections: [{ key: original.key, blocks: [{ ...block, id }] }] }, evidence, [byKey.get(original.key)], plan)
          const valid = checked.sections[0].blocks[0]
          accepted.push(valid); seen.add(bodyKey(valid.text)); usedIds.add(id)
        } catch (error) { validationIssues.push(`${original.key} 补充未通过校验：${error.message}`) }
      }
      if (accepted.length) {
        const index = result.chapters.findIndex(chapter => chapter.section.key === original.key)
        const chapter = { ...result.chapters[index], section: { ...original, blocks: [...original.blocks, ...accepted] } }
        prepared.push({ index, chapter, addedBlockIds: accepted.map(block => block.id), path: `chapters/${original.key}/enriched.json` })
      }
    }
    if (signal?.aborted) throw abortError(signal)
    for (const item of prepared) {
      const output = { ...item.chapter, enrichment: { round: 1, addedBlockIds: item.addedBlockIds } }
      await writeJson(path.join(dir, item.path), output)
      item.outputSha256 = digest(output)
    }
    const nextChapters = result.chapters.map((chapter, index) => prepared.find(item => item.index === index)?.chapter || chapter)
    const coverageAfter = panoramaCoverage(nextChapters.map(chapter => chapter.section), outline)
    for (const item of coverageAfter.filter(item => item.missingScenarioIds.length)) {
      reviewItems.push(`${item.key} 尚未按共享 ID 覆盖场景 ${item.missingScenarioIds.join('、')}，请人工核对正文归属；不代表语义必然缺失`)
    }
    if (validationIssues.length) reviewItems.push('全景补充有内容被过滤，原有正文已保留，请核对补充记录')
    const nextProgress = { ...progress, status: validationIssues.length ? 'partial' : 'completed',
      additions: prepared.reduce((n, item) => n + item.addedBlockIds.length, 0) }
    const completedResult = { chapters: nextChapters, reviewItems, validationIssues }
    await writeJson(path.join(dir, 'panorama-enrichment.json'), { ...nextProgress, cacheVersion: 1, inputSha256,
      resultSha256: digest(completedResult), result: completedResult, draft, validationIssues, reviewItems,
      coverageBefore, coverageAfter, updatedChapters: prepared.map(({ chapter, path: file, addedBlockIds, outputSha256 }) => ({ key: chapter.section.key, path: file, addedBlockIds, outputSha256 })) })
    result.chapters = nextChapters
    Object.assign(progress, nextProgress)
    for (const item of prepared) {
      const chapterState = state.chapters.find(chapter => chapter.key === item.chapter.section.key)
      chapterState.enrichment = { status: 'completed', addedBlocks: item.addedBlockIds.length, path: item.path }
      chapterState.path = item.path
    }
  } catch (error) {
    progress.status = signal?.aborted ? 'cancelled' : 'failed'
    progress.error = error.message
    await writeJson(path.join(dir, 'panorama-enrichment.json'), { ...progress, ...(inputSha256 ? { inputSha256 } : {}), ...(draft ? { draft } : {}), coverageBefore, validationIssues })
    if (signal?.aborted) throw abortError(signal)
    reviewItems.push(`全景补充未完成：${error.message}；保留原稿，关联待人工核对`)
  } finally { await saveState() }
  return result
}

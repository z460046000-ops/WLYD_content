import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { mapConcurrent, GENERATION_CONCURRENCY, abortError } from './scheduler.js'
import { flattenOutline, FRAMEWORK_DIMENSIONS } from './rules.js'
import { validateDraft, PANORAMA_ROLES } from './content.js'
import { createRetrieval } from './retrieval.js'
import { collectFacts } from './facts.js'
import { classifyModelFailure } from './model.js'
import { sha256 } from './store.js'
import { readJson } from './persistence.js'
import { routeFacts, internalNarrative } from './evidence-policy.js'
import { reviewAssembly } from './review.js'
import { enrichPanoramas } from './panorama.js'
import { list, strings, writeJson, createRequester, commonContext, chapterPlan, citedEvidence, itemBatches, uniqueFacts, checkedFacts } from './context.js'
export { normalizePlan, applyPlanTitles } from './plan-model.js'
const SOLUTION_WEIGHTS = { solution: 0.15, 'business-architecture': 0.18, 'product-architecture': 0.17, 'scenario-solution': 0.5 }

const digest = value => sha256(JSON.stringify(value))
const provenance = source => ({ id: source.id, contentSha256: sha256(String(source.content || '')),
  ...Object.fromEntries(['kind', 'source', 'sourceSha256', 'locator', 'knowledgeBaseId', 'knowledgeId', 'chunkId']
    .filter(key => source[key] !== undefined).map(key => [key, source[key]])) })

/** Reuse only atomically completed files bound to this plan, rules and exact source provenance. */
async function reusableChapter({ chapterDir, bindingSha256, evidence, node, plan, completed }) {
  try {
    const checkpoint = await readJson(path.join(chapterDir, 'checkpoint.json'), null)
    if (!checkpoint || checkpoint.version !== 1 || checkpoint.bindingSha256 !== bindingSha256
      || !['extracted', 'completed'].includes(checkpoint.phase) || !Array.isArray(checkpoint.evidence)) return null
    const sources = new Map(evidence.map(row => [row.id, row]))
    const chapterEvidence = checkpoint.evidence.map(row => sources.get(row.id))
    if (chapterEvidence.some((row, index) => !row || digest(provenance(row)) !== digest(checkpoint.evidence[index]))) return null
    const extraction = await readJson(path.join(chapterDir, 'extraction.json'), null)
    if (!extraction || digest(extraction) !== checkpoint.extractionSha256 || !Array.isArray(extraction.facts)
      || checkedFacts(extraction, chapterEvidence).length !== extraction.facts.length
      || !['writingOutline', 'retrievalQueries', 'gaps', 'reviewItems', 'batches'].every(key => Array.isArray(extraction[key]))) return null
    let chapter = null
    if (completed && checkpoint.phase === 'completed') {
      const saved = await readJson(path.join(chapterDir, 'chapter.json'), null)
      if (saved?.section?.key === node.key && digest(saved) === checkpoint.chapterSha256
        && ['validationIssues', 'gaps', 'reviewItems'].every(key => Array.isArray(saved[key]))) {
        const checked = validateDraft({ sections: [saved.section] }, evidence, [node], plan)
        if (!checked.issues.length && checked.sections[0]?.blocks.length === saved.section.blocks.length) {
          chapter = { ...saved, section: checked.sections[0] }
        }
      }
    }
    return { checkpoint, extraction, chapterEvidence, chapter }
  } catch { return null }
}

function writingBatchSize(node, selection) {
  const foundational = ['business-challenges', 'scenario-solution', 'technical-platform'].includes(node.roleId)
  const panorama = PANORAMA_ROLES.includes(node.roleId)
  const base = panorama ? { characters: 3600, count: 3 } : foundational ? { characters: 4200, count: 3 } : { characters: 5000, count: 5 }
  // A route with a small configured default benefits from smaller tasks, not a second output cap.
  return selection?.defaultMaxTokens > 0 && selection.defaultMaxTokens < 6000
    ? { characters: Math.min(base.characters, 2800), count: Math.min(base.count, 2) } : base
}

function groupsFor(outline, config) {
  const groups = new Map()
  const walk = (nodes, inherited) => {
    for (const node of nodes) {
      const group = Object.entries(config.groups).find(([, value]) => value.roles.includes(node.roleId))?.[0] || inherited
      groups.set(node.key, group || 'other')
      walk(node.children || [], group)
    }
  }
  walk(outline)
  return groups
}

export function contentBalance(sections, outline, config) {
  const groupOf = groupsFor(outline, config)
  const characters = text => [...text.replace(/【待确认[^】]*】/gu, '').replace(/\s/gu, '')].length
  const sizes = new Map(sections.map(section => [section.key, section.blocks.reduce((n, block) => n + characters(block.text), 0)]))
  const total = [...sizes.values()].reduce((a, b) => a + b, 0)
  const expected = new Set([...groupOf.values()])
  const present = new Set([...sizes.keys()].map(key => groupOf.get(key)))
  const applicable = Object.keys(config.groups).every(group => expected.has(group)) && expected.has('other')
  const missingGroups = Object.keys(config.groups).filter(group => expected.has(group) && !present.has(group))
  const groups = Object.entries(config.groups).map(([group, value]) => {
    const count = [...sizes].filter(([key]) => groupOf.get(key) === group).reduce((n, [, size]) => n + size, 0)
    const share = total ? Math.round(count / total * 1000) / 10 : 0
    return { group, characters: count, share, target: value.range,
      withinTarget: !applicable || (share >= value.range[0] && share <= value.range[1]) }
  })
  return { unit: '正文非空白字符，排除标题、引用与审核清单', soft: true, applicable, total, groups,
    missingGroups, reviewItems: applicable ? groups.filter(group => !group.withinTarget).map(group =>
      `${group.group === 'business' ? '业务分析' : '解决方案及子章节'}篇幅为 ${group.share}%，建议范围 ${group.target[0]}–${group.target[1]}%；请核对深度，勿重复凑字数`) : [] }
}

/** Group checked facts before writing; no extra model round or source truncation. */
export function organizeChapterFacts(facts) {
  const unique = new Map()
  for (const fact of facts) {
    const key = digest([String(fact.text).replace(/\s+/gu, ''), fact.supportMode, fact.subject, fact.purpose,
      fact.capabilityStatus, fact.capabilityOwnership, fact.asOf])
    const previous = unique.get(key)
    if (previous) previous.evidence = [...new Map([...previous.evidence, ...fact.evidence].map(ref => [JSON.stringify(ref), ref])).values()]
    else unique.set(key, structuredClone(fact))
  }
  const topics = new Map()
  for (const fact of unique.values()) {
    const title = String(fact.topic || '本章相关内容').trim().slice(0, 80)
    if (!topics.has(title)) topics.set(title, { id: `topic-${topics.size + 1}`, title, facts: [] })
    topics.get(title).facts.push(fact)
  }
  return { facts: [...topics.values()].flatMap(topic => topic.facts),
    topics: [...topics.values()].map(({ id, title, facts: rows }) => ({ id, title, factCount: rows.length })) }
}

function depthBudget(node, nodes, outline, config) {
  const groupOf = groupsFor(outline, config)
  const group = groupOf.get(node.key)
  if (!config.groups[group]) return { group, guidance: '按材料充分解释变化、影响和建设回应；与重点章节保持比例，不机械凑字数' }
  const members = nodes.filter(item => groupOf.get(item.key) === group)
  const weight = item => group === 'solution' ? (SOLUTION_WEIGHTS[item.roleId] || 0.2) : 1
  const fraction = weight(node) / members.reduce((n, item) => n + weight(item), 0)
  return { group, groupShareRange: config.groups[group].range,
    chapterShareRange: config.groups[group].range.map(value => Math.round(value * fraction * 10) / 10),
    guidance: '这是正文篇幅软目标；解决方案范围为全部子节点合计。本章须充分解释业务动作与价值机制，不靠重复、无据数字或新增能力凑比例' }
}

function linksFromPlan(plan, sections, outline) {
  const roles = new Map(flattenOutline(outline).map(node => [node.key, node.roleId]))
  const blocks = sections.flatMap(section => section.blocks.map(block => ({ ...block, roleId: roles.get(section.key) })))
  const links = []
  for (const scenario of plan.scenarios) {
    const scenarioBlock = blocks.find(block => block.roleId === 'scenario-solution' && block.planRefs?.scenarioIds.includes(scenario.id))
    if (!scenarioBlock) continue
    const problem = blocks.find(block => block.roleId === 'business-challenges' && block.planRefs?.problemIds.some(id => scenario.problemIds.includes(id)))
    const trend = blocks.find(block => block.roleId === 'policy-trends' && block.planRefs?.trendIds.some(id => scenario.trendIds.includes(id)))
    for (const id of scenario.capabilityIds) {
      const capability = plan.capabilities.find(item => item.id === id)
      const ref = capability?.evidence[0]
      if (!ref) continue
      links.push({ capabilityEvidenceId: ref.id, capabilityQuote: ref.quote, scenarioBlockId: scenarioBlock.id,
        ...(problem ? { challengeBlockId: problem.id } : {}), ...(trend ? { trendBlockId: trend.id } : {}),
        relationReason: scenario.relationReason, status: 'proposed' })
    }
  }
  return links
}

const writingContract = '只写当前章节，标题与 key 使用目录给定值。事实逐段 supportMode=sourced，附原文 evidence:[{id,quote}]；引文逐字复制至少六字，含数字的正文须在引文中支持相同数字。合理推演用条件语气并标 supportMode=candidate，不能冒充客户事实、已具备能力、正式政策或效果承诺。保留所有有价值的相关材料，extractQuestions 只是重点。大段原文先概括关键意思，再用简短小标题或短语引出论点，并以短句解释动作、因果、条件和边界；不得把长原文直接堆入正文，也不能为短语化丢掉事实与引文。业务章采用所选一种写法，趋势章只用所选一种框架。对外读者不能把厂商内部研发问题、经营判断当客户痛点。问题与方案以共享规划 ID 对应；每个段落给 planRefs:{capabilityIds,scenarioIds,problemIds,trendIds}。只有真正缺失的事实进入 gaps；关系不足在 reviewItems 中说明，正文可保留待确认候选。'

/** The same body boundary applies to initial writing, panorama additions and review repairs. */
function validateBodyBlock(block, facts, rule, supplied) {
  if (internalNarrative(block.text)) throw new Error('内部经营、研发、材料审核或组稿过程说明不进入正文')
  if (rule.contentPolicy?.allowCandidate === false && block.supportMode === 'candidate') throw new Error('本章需要真实可核对事实，不用候选推演替代案例或企业介绍')
  const supportsRef = (fact, ref) => list(fact.evidence).some(allowed => allowed.id === ref.id
    && String(allowed.quote).includes(String(ref.quote || '')))
  const validRefs = list(block.evidence).every(ref => (!supplied || supplied.some(source => source.id === ref.id && source.content.includes(String(ref.quote || ''))))
    && facts.some(fact => supportsRef(fact, ref)))
  if (!validRefs) throw new Error('撰写引用超出本批已核验事实卡的证据')
  if (block.supportMode !== 'candidate' && list(block.evidence).length
    && list(block.evidence).every(ref => facts.filter(fact => supportsRef(fact, ref)).every(fact => fact.supportMode === 'candidate'))) {
    throw new Error('候选事实的背景引用不能证明客户事实，正文须保持 candidate')
  }
}

/** All chapter pipelines are submitted together; shared model slots still bound actual requests. */
export async function generateChapters({ llm, exec, args, rules, outline, evidence, dir, state, saveState, retrieval, acceptedPlan, resume = false }) {
  if (!acceptedPlan) throw new Error('缺少已确认大纲，不能在正文生成中重新规划')
  if (!retrieval) {
    retrieval = createRetrieval({ evidence, dir, signal: exec.signal, rules, outline, audience: args.audience })
    await retrieval.prepare()
  }
  const request = await createRequester({ llm, exec, state, saveState })
  const common = commonContext(rules, args)
  const plan = structuredClone(acceptedPlan)
  const resolvedOutline = outline
  const nodes = flattenOutline(outline)
  const bodyFactsByKey = new Map()
  const validatePostWriteBlock = (block, key) => {
    const node = nodes.find(row => row.key === key)
    if (!node) throw new Error('正文修正包含目录外章节')
    validateBodyBlock(block, bodyFactsByKey.get(key) || [], rules.chapters[node.roleId] || rules.global.customChapter)
  }
  state.planning = { status: 'confirmed', planId: args.plan_id || null }
  await writeJson(path.join(dir, 'plan.json'), { ...plan, outline, ruleFingerprint: rules.fingerprint, confirmation: { planId: args.plan_id || null, sha256: args.plan_sha256 || null } })
  state.status = 'generating'; state.concurrency = GENERATION_CONCURRENCY; state.chapterScheduling = 'all-parallel'
  state.choices = plan.choices
  const priorChapters = new Map((resume ? state.chapters || [] : []).map(row => [row.key, row]))
  state.chapters = nodes.map(node => ({ key: node.key, title: node.title, status: 'queued', extractAttempts: 0, writeAttempts: 0,
    ...priorChapters.get(node.key) }))
  await saveState()
  let results
  try {
    results = await mapConcurrent(nodes, async (node, index) => {
      const progress = state.chapters[index]
      const chapterDir = path.join(dir, 'chapters', node.key)
      await mkdir(chapterDir, { recursive: true, mode: 0o700 })
      const chapterRule = rules.chapters[node.roleId] || rules.global.customChapter
      const scoped = chapterPlan(plan, node)
      const bindingSha256 = digest({ version: 1, planId: args.plan_id || null, planSha256: args.plan_sha256 || null,
        plan, outline, node, ruleFingerprint: rules.fingerprint, chapterRule, common,
        model: { provider: state.modelSelection.provider, model: state.modelSelection.model,
          reasoningEffort: state.modelSelection.reasoningEffort } })
      const base = { ...common, chapter: node, plan: scoped,
        ...(PANORAMA_ROLES.includes(node.roleId) ? { organization: scoped.chapterGuidance[0]?.organization } : {}),
        chapterRule: { write: chapterRule.write || [], validate: chapterRule.validate || [], missing: chapterRule.missing || '',
          contentPolicy: chapterRule.contentPolicy || {},
          ...(chapterRule.modes?.[node.mode] ? { selectedMode: chapterRule.modes[node.mode] } : {}) },
        depthBudget: depthBudget(node, nodes, outline, rules.global.contentBalance),
        selectedDimensions: FRAMEWORK_DIMENSIONS[node.framework] || [] }
      try {
        const saved = resume ? await reusableChapter({ chapterDir, bindingSha256, evidence, node, plan,
          completed: progress.status === 'completed' }) : null
        if (saved) bodyFactsByKey.set(node.key, organizeChapterFacts(routeFacts(saved.extraction.facts, node, chapterRule).facts).facts)
        if (saved?.chapter) {
          progress.reusedChapter = true; progress.reusedExtraction = true; progress.resumeDecision = 'reused-completed-chapter'
          delete progress.error; await saveState(); return saved.chapter
        }
        progress.reusedChapter = false; progress.reusedExtraction = !!saved
        progress.resumeDecision = saved ? 'reused-extraction' : resume ? 'checkpoint-unavailable-or-invalid' : 'new-chapter'
        delete progress.error
        if (!saved) { progress.status = 'retrieving'; await saveState() }
        let chapterEvidence = saved?.chapterEvidence || await retrieval.forChapter(node, plan)
        const evidenceIds = new Set(chapterEvidence.map(row => row.id))
        // An injected retrieval adapter must register new sources as well.
        for (const source of chapterEvidence) if (!evidence.some(row => row.id === source.id)) evidence.push(source)
        const onBatch = async () => { progress.status = 'extracting'; progress.extractAttempts++; await saveState() }
        let extraction = saved?.extraction || await collectFacts({ request, common: { author: common.author, audience: common.audience }, node,
          rule: chapterRule, evidence: chapterEvidence, plan: scoped, onBatch,
          signal: exec.signal,
          onProgress: partial => writeJson(path.join(chapterDir, 'extraction-partial.json'), partial) })
        const saveCheckpoint = async (chapter = null) => {
          await writeJson(path.join(chapterDir, 'extraction.json'), extraction)
          await writeJson(path.join(chapterDir, 'checkpoint.json'), { version: 1, bindingSha256,
            phase: chapter ? 'completed' : 'extracted', evidence: chapterEvidence.map(provenance),
            extractionSha256: digest(extraction), ...(chapter ? { chapterSha256: digest(chapter) } : {}),
            savedAt: new Date().toISOString() })
        }
        await saveCheckpoint()
        progress.supplementRounds ||= 0
        if (extraction.retrievalQueries.length) {
          progress.status = 'supplementing'; progress.supplementRounds = 1; await saveState()
          try {
            const found = await retrieval.forChapter(node, plan, extraction.retrievalQueries)
            const knownContent = new Set(chapterEvidence.map(row => row.content.trim()))
            const added = found.filter(row => !evidenceIds.has(row.id) && !knownContent.has(row.content.trim()))
            progress.supplement = { questions: extraction.retrievalQueries, newEvidenceCount: added.length, newFactsCount: 0 }
            for (const source of added) if (!evidence.some(row => row.id === source.id)) evidence.push(source)
            if (added.length) {
              const extra = await collectFacts({ request, common: { author: common.author, audience: common.audience }, node,
                rule: chapterRule, evidence: added, plan: scoped, round: 1, onBatch,
                signal: exec.signal,
                onProgress: partial => writeJson(path.join(chapterDir, 'supplement-partial.json'), partial) })
              const previous = extraction.facts.length
              const merged = uniqueFacts([...extraction.facts, ...extra.facts])
              progress.supplement.newFactsCount = merged.length - previous
              extraction = { facts: merged, writingOutline: [...extraction.writingOutline, ...extra.writingOutline], retrievalQueries: [],
                gaps: strings([...extraction.gaps, ...extra.gaps]), reviewItems: strings([...extraction.reviewItems, ...extra.reviewItems]),
                batches: [...extraction.batches, ...extra.batches] }
              chapterEvidence = [...chapterEvidence, ...added]
            } else extraction.reviewItems.push('本章补查未取得新增且去重后的证据，保留现有事实继续撰写')
          } catch (error) {
            if (exec.signal?.aborted) throw error
            extraction.reviewItems.push(`补查或新增事实提取未完成：${error.message}；保留已有事实卡`)
          }
          extraction.retrievalQueries = []
          await saveCheckpoint()
        }
        progress.evidenceCount = chapterEvidence.length; progress.factCount = extraction.facts.length
        const routed = routeFacts(extraction.facts, node, chapterRule)
        extraction.reviewItems.push(...routed.reviewItems)
        const organized = organizeChapterFacts(routed.facts)
        bodyFactsByKey.set(node.key, organized.facts)
        progress.bodyFactCount = organized.facts.length; progress.excludedFactCount = routed.excludedFacts.length
        await writeJson(path.join(chapterDir, 'fact-routing.json'), { chapterKey: node.key,
          bodyFacts: organized.facts, topics: organized.topics, excludedFacts: routed.excludedFacts, reviewItems: routed.reviewItems })
        if (!organized.facts.length && node.required === false && chapterRule.contentPolicy?.omitWhenNoEligibleFacts) {
          progress.status = 'omitted'; progress.omissionReason = '没有符合本章用途的正向证据，按可选章节规则省略'
          await saveCheckpoint(); await saveState(); return null
        }
        if (!organized.facts.length && chapterRule.contentPolicy?.allowCandidate === false) throw new Error('本章没有符合用途的可核对事实，已保留目录待补；不以内部说明替代正文')
        progress.failedBatches = []
        let serial = 0
        const blocks = [], validationIssues = []
        const bodyKeys = new Set()
        const recordFailure = async (partId, error, issues = []) => {
          const message = error?.message || String(error)
          progress.failedBatches.push({ batchId: partId, error: message, ...(error?.code ? { code: error.code } : {}) })
          validationIssues.push(...issues)
          await writeJson(path.join(chapterDir, `failed-${partId}.json`), { error: message, issues })
          await saveState()
        }
        const batchSize = writingBatchSize(node, state.modelSelection)
        progress.writingBatchSize = batchSize
        const parts = itemBatches(organized.facts, batchSize.characters, batchSize.count)
        if (!parts.length) parts.push([])
        const writePart = async (facts, partId, depth = 0, repairIssues = [], failedBlocks = []) => {
          progress.status = 'writing'; progress.writeAttempts++; await saveState()
          const supplied = citedEvidence(facts, chapterEvidence)
          const prompt = { ...base, stage: 'write', batchId: partId, evidence: supplied,
            chapterTopics: organized.topics,
            extraction: { facts, writingOutline: strings(facts.map(fact => fact.topic || '本章相关内容')).map(topic => ({ topic })) },
            previousTopics: blocks.map(block => ({ id: block.id, navigationExcerpt: block.text.slice(0, 120) })), repairIssues, failedBlocks,
            task: writingContract + '按 chapterTopics 组织本章，本批只写 facts 涉及的主题，最多四个段落，合并重复意思，不重复 previousTopics。服从 chapterRule.contentPolicy 的主体用途与职责；candidate 事实即使有背景引用，正文仍标 candidate，不能因附引文变成真实客户事实。引用仅从 facts.evidence.quote 中逐字选取，不能扩大到原文选段的邻近内容；选段上下文用于理解条件。仅写读者需要的业务内容，不讲检索、证据缺口、粗目录、章节安排或内部审阅过程。正文解释参与者、触发、用户动作、系统支撑、输出、价值和边界；小标题简短。两类全景分别承担业务流程与功能支撑职责，不在每批重写全章。事实不足时只可围绕 plan 有据能力写条件性的典型建议，不新增产品能力、客户事实或政策。failedBlocks 非空时只修这些被拒段落，其他已通过段落已保留，不重写它们；删除不必要的无据数字，不伪造引文。',
            schema: { sections: [{ key: node.key, title: node.title, blocks: [{ text: '完整主题正文', supportMode: 'sourced/candidate',
              ...(node.framework ? { dimension: 'selectedDimensions 中的一项，导语可省略' } : {}),
              ...(PANORAMA_ROLES.includes(node.roleId) ? { capabilityStatus: 'existing/pilot/planned/proposed/unknown', capabilityOwnership: 'self/third-party/customer/unknown' } : {}),
              evidence: [{ id: '本批原文 ID', quote: '短的逐字引文' }],
              planRefs: { capabilityIds: [], scenarioIds: [], problemIds: [], trendIds: [] } }] }], gaps: [], reviewItems: [] } }
          try {
            const draft = await request(prompt)
            await writeJson(path.join(chapterDir, `draft-${partId}.json`), draft)
            const raw = list(draft.sections).filter(section => section.key === node.key).flatMap(section => list(section.blocks))
              .map((block, i) => ({ ...block, id: `${node.key}-${serial + i + 1}` }))
            if (!raw.length) throw new Error('撰写没有返回本章正文段落')
            serial += raw.length
            const invalid = [], issues = []
            for (const block of raw) {
              try {
                validateBodyBlock(block, facts, chapterRule, supplied)
                const checked = validateDraft({ sections: [{ key: node.key, blocks: [block] }] }, evidence, [node], plan)
                if (checked.issues.length) throw new Error(checked.issues.join('；'))
                const accepted = checked.sections[0].blocks[0]
                const key = accepted.text.replace(/^【待确认[^】]*】/u, '').replace(/\s+/gu, '')
                if (!bodyKeys.has(key)) { bodyKeys.add(key); blocks.push(accepted) }
              } catch (error) { invalid.push(block); issues.push(error.message) }
            }
            // Valid paragraphs survive a later repair or batch failure.
            await writeJson(path.join(chapterDir, 'writing-partial.json'), { sections: [{ key: node.key, blocks }],
              failedBatches: progress.failedBatches })
            extraction.gaps.push(...strings(draft.gaps)); extraction.reviewItems.push(...strings(draft.reviewItems))
            if (invalid.length) {
              if (!repairIssues.length) return writePart(facts, `${partId}-repair`, depth, issues, invalid)
              await recordFailure(partId, new Error('局部修正后仍有段落未通过，保留本章有效正文'), issues)
            }
          } catch (error) {
            if (exec.signal?.aborted) throw error
            const kind = classifyModelFailure(error)
            if (kind === 'context' || kind === 'output' && error.outputCharacters > 0) {
              if (depth < 2 && facts.length > 1) {
                const mid = Math.ceil(facts.length / 2)
                const left = await writePart(facts.slice(0, mid), `${partId}.1`, depth + 1)
                if (left?.stop) return left
                return writePart(facts.slice(mid), `${partId}.2`, depth + 1)
              }
            }
            if (kind === 'other' && !error.code && !repairIssues.length) return await writePart(facts, `${partId}-retry`, depth, [error.message])
            await recordFailure(partId, error)
            return { stop: ['auth', 'quota', 'rate-limit'].includes(kind) }
          }
        }
        for (const [i, facts] of parts.entries()) {
          const outcome = await writePart(facts, String(i + 1))
          if (outcome?.stop) {
            if (i < parts.length - 1) await recordFailure('remaining', new Error('本章后续批次因鉴权、额度或限流失败尚未执行'))
            break
          }
        }
        progress.status = 'validating'; await saveState()
        if (!blocks.length) throw new Error(progress.failedBatches[0]?.error || '本章尚无通过校验的正文')
        const checked = validateDraft({ sections: [{ key: node.key, blocks }] }, evidence, [node], plan)
        const chapter = { section: checked.sections[0], validationIssues: strings([...validationIssues, ...checked.issues]),
          gaps: strings(extraction.gaps), reviewItems: strings(extraction.reviewItems),
          status: progress.failedBatches.length || checked.issues.length ? 'partial' : 'completed' }
        await writeJson(path.join(chapterDir, 'draft.json'), { sections: [{ key: node.key, blocks }] })
        await writeJson(path.join(chapterDir, 'chapter.json'), chapter)
        await saveCheckpoint(chapter.status === 'completed' ? chapter : null)
        progress.status = chapter.status; progress.path = `chapters/${node.key}/chapter.json`
        if (chapter.status === 'partial') progress.error = '部分写作批次未完成，已保留通过校验的正文'
        await saveState()
        return chapter
      } catch (error) {
        progress.status = exec.signal?.aborted ? 'cancelled' : 'failed'; progress.error = error.message
        await writeJson(path.join(chapterDir, 'error.json'), { status: progress.status, error: error.message })
        await saveState(); throw error
      }
    }, { concurrency: Math.max(1, nodes.length), signal: exec.signal })
  } catch (error) {
    if (exec.signal?.aborted) {
      for (const item of state.chapters) if (['queued', 'retrieving', 'extracting', 'writing', 'supplementing'].includes(item.status)) item.status = 'cancelled'
      await saveState(); throw abortError(exec.signal)
    }
    throw error
  }
  const successful = results.filter(result => result.status === 'fulfilled' && result.value?.section).map(result => result.value)
  if (!successful.length) throw new Error(`全部章节未完成；已保留逐章提取、错误和运行记录：${state.chapters.find(item => item.error)?.error || '无有效正文'}`)
  const enriched = await enrichPanoramas({ request, common: { author: common.author, audience: common.audience }, plan, outline,
    rules, chapters: successful, evidence, dir, state, saveState, signal: exec.signal,
    validateBlock: validatePostWriteBlock,
    selectEvidence: sections => citedEvidence([...sections.flatMap(section => section.blocks), ...plan.capabilities], evidence) })
  const omitted = new Set(state.chapters.filter(row => row.status === 'omitted').map(row => row.key))
  const activeOutline = nodes.filter(node => !omitted.has(node.key)).map(({ children, ...node }) => node)
  const review = await reviewAssembly({ request, common: { author: common.author, audience: common.audience }, plan, outline: activeOutline,
    sections: enriched.chapters.map(row => row.section), evidence, dir, state, saveState, signal: exec.signal, ruleFingerprint: rules.fingerprint,
    validateBlock: validatePostWriteBlock })
  const checked = validateDraft({ sections: review.sections, assemblyLinks: linksFromPlan(plan, review.sections, outline) }, evidence, outline, plan)
  const balance = contentBalance(checked.sections, outline, rules.global.contentBalance)
  const gaps = [], reviewItems = [...plan.reviewItems, ...retrieval.issues, ...enriched.reviewItems, ...checked.reviewItems, ...balance.reviewItems, ...review.reviewItems]
  if (state.modelSelection.reasoningPolicy !== 'low') reviewItems.push(state.modelSelection.reasoningNote)
  for (const chapter of successful) {
    reviewItems.push(...chapter.reviewItems)
    for (const gap of chapter.gaps) (/关联不足|关系不足|对应关系/u.test(gap) ? reviewItems : gaps).push(gap)
  }
  const missing = state.chapters.filter(row => !['completed', 'omitted'].includes(row.status))
  for (const row of missing) gaps.push(`${row.title}：${row.status === 'partial' ? '部分成稿' : '生成未完成'}（${row.error}），有效内容已保留`)
  if (missing.length) {
    state.review.passed = false; state.review.incompleteChapters = missing.map(row => row.key)
    reviewItems.push('报告存在缺章或部分成稿章节，整体关联检查不能算通过')
  }
  await saveState()
  return { title: plan.title, outline: resolvedOutline, sections: checked.sections, choices: plan.choices,
    assemblyLinks: checked.assemblyLinks, reviewItems: strings(reviewItems), gaps: strings(gaps), review: state.review,
    validationIssues: strings([...successful.flatMap(chapter => chapter.validationIssues), ...enriched.validationIssues, ...checked.issues]), contentBalance: balance,
    chapterOutcomes: state.chapters.map(({ key, title, status, error, omissionReason }) => ({ key, title, status,
      ...(error ? { error } : {}), ...(omissionReason ? { omissionReason } : {}) })) }
}

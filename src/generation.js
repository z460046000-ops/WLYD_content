import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { askModel } from './model.js'
import { mapConcurrent, GENERATION_CONCURRENCY, abortError } from './scheduler.js'
import { applyModes, flattenOutline, FRAMEWORK_DIMENSIONS, requestedModes } from './rules.js'
import { validateDraft, PANORAMA_ROLES, CAPABILITY_STATUSES, CAPABILITY_OWNERS } from './content.js'
import { enrichPanoramas } from './panorama.js'

const list = value => Array.isArray(value) ? value : []
const strings = value => [...new Set(list(value).filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()))]
const writeJson = (file, value) => writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 })
const validId = value => typeof value === 'string' && /^[a-z][a-z0-9-]*$/u.test(value)
const SOLUTION_WEIGHTS = { solution: 0.15, 'business-architecture': 0.18, 'product-architecture': 0.17, 'scenario-solution': 0.5 }

function checkedRefs(refs, sources) {
  return list(refs).flatMap(ref => {
    const source = sources.get(String(ref?.id))
    const quote = String(ref?.quote || '').trim()
    return source && quote.length >= 6 && source.content.includes(quote) ? [{ id: source.id, quote }] : []
  })
}

export function normalizePlan(raw, evidence, outline, args = {}) {
  const sources = new Map(evidence.map(item => [item.id, item]))
  const issues = []
  const requested = requestedModes(outline, args)
  const proposal = (field, allowed, fallback) => {
    const value = raw?.[field]?.value ?? raw?.[field]
    return allowed.includes(value) ? { value, reason: String(raw[field]?.reason || '依据材料与受众选择') }
      : { value: fallback, reason: '模型未提供有效选择，采用保守默认；可通过参数覆盖' }
  }
  const business = proposal('businessMode', ['current-state', 'needs-challenges'], 'needs-challenges')
  const trend = proposal('trendFramework', ['pest', 'management-business-technology'], 'management-business-technology')
  const choices = {
    businessMode: requested.businessMode === 'auto' ? business : { value: requested.businessMode, reason: '用户或目录明确指定' },
    trendFramework: requested.trendFramework === 'auto' ? trend : { value: requested.trendFramework, reason: '用户或目录明确指定' },
  }
  const factRows = (field, requireSource = false) => {
    const seen = new Set()
    return list(raw?.[field]).flatMap(item => {
      if (!item || !validId(item.id) || seen.has(item.id) || !String(item.text || '').trim()) return []
      if (field === 'problems' && item.scope === 'vendor-internal') {
        issues.push('共享规划已排除厂商内部问题，客户业务分析须重新按客户视角组织'); return []
      }
      const refs = checkedRefs(item.evidence, sources)
      if (requireSource && !refs.length) { issues.push(`规划能力 ${item.id} 缺少有效原文，未作为已具备能力使用`); return [] }
      seen.add(item.id)
      return [{ id: item.id, text: String(item.text), supportMode: refs.length ? 'sourced' : 'candidate', evidence: refs,
        ...(field === 'capabilities' ? {
          capabilityStatus: CAPABILITY_STATUSES.includes(item.capabilityStatus) ? item.capabilityStatus : 'unknown',
          capabilityOwnership: CAPABILITY_OWNERS.includes(item.capabilityOwnership) ? item.capabilityOwnership : 'unknown',
        } : {}) }]
    })
  }
  const capabilities = factRows('capabilities', true)
  const problems = factRows('problems')
  const trends = factRows('trends')
  const ids = rows => new Set(rows.map(item => item.id))
  const select = (value, rows) => strings(value).filter(id => ids(rows).has(id))
  const seenScenarios = new Set()
  const scenarios = list(raw?.scenarios).flatMap(item => {
    if (!item || !validId(item.id) || seenScenarios.has(item.id) || !String(item.title || '').trim()) return []
    seenScenarios.add(item.id)
    return [{ id: item.id, title: String(item.title), capabilityIds: select(item.capabilityIds, capabilities),
      problemIds: select(item.problemIds, problems), trendIds: select(item.trendIds, trends),
      relationReason: String(item.relationReason || '模型建议的能力、场景和业务问题对应关系，待人工核对') }]
  })
  const keys = new Set(flattenOutline(outline).map(node => node.key))
  return { title: String(raw?.title || '产品售前解决方案'), choices, capabilities, problems, trends, scenarios,
    chapterGuidance: list(raw?.chapterGuidance).filter(item => item && keys.has(item.key)).map(item => ({ key: item.key, title: String(item.title || ''), focus: String(item.focus || ''),
      ...(item.organization && typeof item.organization === 'object' ? { organization: {
        purpose: String(item.organization.purpose || ''), scope: String(item.organization.scope || ''),
        dimensions: strings(item.organization.dimensions), reason: String(item.organization.reason || ''),
      } } : {}) })),
    reviewItems: [...issues, ...strings(raw?.reviewItems)] }
}

export function applyPlanTitles(outline, plan, evidence) {
  const titles = new Set()
  const visit = nodes => nodes.map(node => {
    const proposal = plan.chapterGuidance.find(item => item.key === node.key)?.title.trim()
    const numbers = proposal?.match(/\d+(?:[.,]\d+)*/gu) || []
    const mixedBusinessModes = node.roleId === 'business-challenges' &&
      ((node.mode === 'current-state' && /挑战|痛点/u.test(proposal || '')) ||
       (node.mode === 'needs-challenges' && /现状|概况|运行情况/u.test(proposal || '')))
    const valid = proposal && proposal.length <= 100 && !/[\r\n<>#]/u.test(proposal) && !titles.has(proposal)
      && !mixedBusinessModes && numbers.every(number => evidence.some(item => item.content.includes(number)))
    if (proposal && !valid) plan.reviewItems.push(`${node.key} 的标题变体不合格，已使用该章节默认标题`)
    const title = valid ? proposal : node.title
    titles.add(title)
    return { ...node, canonicalTitle: node.title, title, ...(node.children ? { children: visit(node.children) } : {}) }
  })
  return visit(outline)
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
  const present = new Set([...sizes.keys()].map(key => groupOf.get(key)))
  const applicable = Object.keys(config.groups).every(group => present.has(group)) && present.has('other')
  const groups = Object.entries(config.groups).map(([group, value]) => {
    const count = [...sizes].filter(([key]) => groupOf.get(key) === group).reduce((n, [, size]) => n + size, 0)
    const share = total ? Math.round(count / total * 1000) / 10 : 0
    return { group, characters: count, share, target: value.range,
      withinTarget: !applicable || (share >= value.range[0] && share <= value.range[1]) }
  })
  return { unit: '正文非空白字符，排除标题、引用与审核清单', soft: true, applicable, total, groups,
    reviewItems: applicable ? groups.filter(group => !group.withinTarget).map(group =>
      `${group.group === 'business' ? '业务分析' : '解决方案及子章节'}篇幅为 ${group.share}%，建议范围 ${group.target[0]}–${group.target[1]}%；请核对深度，勿重复凑字数`) : [] }
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

const writingContract = '只写当前章节，标题与 key 使用目录给定值。事实逐段 supportMode=sourced，附原文 evidence:[{id,quote}]；引文逐字复制至少六字，含数字的正文须在引文中支持相同数字。合理推演用条件语气并标 supportMode=candidate，不能冒充客户事实、已具备能力、正式政策或效果承诺。保留所有有价值的相关材料，extractQuestions 只是重点。业务章采用所选一种写法，趋势章只用所选一种框架。对外读者不能把厂商内部研发问题、经营判断当客户痛点。问题与方案以共享规划 ID 对应；每个段落给 planRefs:{capabilityIds,scenarioIds,problemIds,trendIds}。只有真正缺失的事实进入 gaps；关系不足在 reviewItems 中说明，正文可保留待确认候选。'

export async function generateChapters({ llm, exec, args, rules, outline, evidence, dir, state, saveState }) {
  state.modelRequests = []
  const request = async prompt => {
    const record = { stage: prompt.stage, chapterKey: prompt.chapter?.key,
      inputCharacters: JSON.stringify(prompt).length, evidenceCount: evidence.length,
      evidenceCharacters: evidence.reduce((n, item) => n + item.content.length, 0),
      provider: exec.agent?.options?.provider, model: exec.agent?.options?.model,
      reasoningEffort: exec.agent?.options?.reasoningEffort, startedAt: new Date().toISOString(), status: 'pending' }
    state.modelRequests.push(record); await saveState()
    try {
      const result = await askModel(llm, exec.agent, exec.signal, prompt)
      record.status = 'completed'
      return result
    } catch (error) {
      record.status = exec.signal?.aborted ? 'cancelled' : 'failed'
      record.error = error.message
      if (error.code) record.code = error.code
      throw error
    } finally { record.finishedAt = new Date().toISOString(); await saveState() }
  }
  const common = { audience: args.audience || '首次接触方案的企业客户', globalRules: rules.global,
    styleRules: rules.style, evidence: evidence.map(item => ({ id: item.id, content: item.content })) }
  const requested = requestedModes(outline, args)
  const panoramaRules = Object.fromEntries(flattenOutline(outline).filter(node => PANORAMA_ROLES.includes(node.roleId))
    .map(node => [node.roleId, rules.chapters[node.roleId]]))
  state.status = 'planning'
  await saveState()
  let rawPlan
  let planningError
  try {
    rawPlan = await request({ ...common, stage: 'plan', outline, requestedModes: requested, panoramaRules,
      task: '先制定共享能力→场景→客户问题→趋势计划，再让各章节共用。先全量盘点再按目标读者、问题与重点场景为两类全景各自选择组织维度、范围和理由，分层、分模块、提炼关键内容；维度示例不是白名单，不固定管理执行底座三层或产品五层。业务全景解释角色与业务运转，产品全景解释功能支撑与归属边界，用同一批问题、能力和场景 ID 关联。能力必须有原文，并区分已具备、试点、规划及第三方/客户已有/自有；未知不能默认已具备。内部研发缺陷和厂商自身经营困境不作为客户问题。选择业务现状 current-state 或需求挑战 needs-challenges；选择 PEST pest 或管理业务技术 management-business-technology。用户明确指定时服从指定；auto 时按材料和受众选择并说明理由。为每个章节及子节点给出自然的近义标题，每次可变化表达，不从固定候选列表抽签。标题须保持章节含义和所选写法，不混写业务现状与需求挑战，不增加事实、数字或承诺，不改变 key、roleId 和目录层级。规划只作内容组织，不替代原始证据，不压缩或丢弃输入材料。',
      schema: { title: '方案标题', businessMode: { value: 'current-state 或 needs-challenges', reason: '选择理由' },
        trendFramework: { value: 'pest 或 management-business-technology', reason: '选择理由' },
        capabilities: [{ id: 'cap-1', text: '有据能力及其状态边界', capabilityStatus: 'existing/pilot/planned/proposed/unknown 选一', capabilityOwnership: 'self/third-party/customer/unknown 选一', evidence: [{ id: '输入证据 ID', quote: '逐字原文' }] }],
        problems: [{ id: 'problem-1', text: '客户业务问题或明确标明的典型假设', scope: 'customer 或 vendor-internal', evidence: [] }],
        trends: [{ id: 'trend-1', text: '趋势或建设方向', evidence: [] }],
        scenarios: [{ id: 'scenario-1', title: '场景名', capabilityIds: ['cap-1'], problemIds: ['problem-1'], trendIds: ['trend-1'], relationReason: '机制说明' }],
        chapterGuidance: [{ key: '目录中的 key', title: '由 LLM 自然改写的近义章节标题', focus: '章节重点，业务分析和解决方案需展开',
          organization: { purpose: '全景目标，其他角色可省略本对象', scope: '业务或产品范围', dimensions: ['按本次业务选择的维度，可组合或自建'], reason: '对读者、核心问题和重点场景为何合适' } }], reviewItems: [] } })
  } catch (error) {
    if (exec.signal?.aborted) throw error
    planningError = `共享规划未完成：${error.message}；仍使用全部原始材料逐章生成，关联需人工核对`
    rawPlan = {}
  }
  const plan = normalizePlan(rawPlan, evidence, outline, args)
  if (planningError) plan.reviewItems.push(planningError)
  const resolvedOutline = applyPlanTitles(applyModes(outline, { businessMode: plan.choices.businessMode.value, trendFramework: plan.choices.trendFramework.value }), plan, evidence)
  const nodes = flattenOutline(resolvedOutline)
  for (const node of nodes.filter(item => PANORAMA_ROLES.includes(item.roleId))) {
    const organization = plan.chapterGuidance.find(item => item.key === node.key)?.organization
    if (!organization?.dimensions.length || !organization.reason || !organization.purpose || !organization.scope) {
      plan.reviewItems.push(`${node.key} 的全景组织维度或选择依据不完整，请核对；本章仍按资料生成，不强套固定层级`)
    }
  }
  await writeJson(path.join(dir, 'plan.json'), { ...plan, outline: resolvedOutline, ruleFingerprint: rules.fingerprint })
  state.status = 'generating'
  state.concurrency = GENERATION_CONCURRENCY
  state.choices = plan.choices
  state.chapters = nodes.map(node => ({ key: node.key, title: node.title, status: 'queued', extractAttempts: 0, writeAttempts: 0 }))
  await saveState()
  let results
  try {
    results = await mapConcurrent(nodes, async (node, index) => {
      const progress = state.chapters[index]
      const chapterDir = path.join(dir, 'chapters', node.key)
      await mkdir(chapterDir, { recursive: true, mode: 0o700 })
      const chapterRule = rules.chapters[node.roleId] || rules.global.customChapter
      const base = { ...common, chapter: node, chapterRule, plan,
        ...(PANORAMA_ROLES.includes(node.roleId) ? { organization: plan.chapterGuidance.find(item => item.key === node.key)?.organization } : {}),
        depthBudget: depthBudget(node, nodes, resolvedOutline, rules.global.contentBalance),
        selectedDimensions: FRAMEWORK_DIMENSIONS[node.framework] || [] }
      try {
        let extraction
        for (let attempt = 1; attempt <= 2; attempt++) {
          progress.status = 'extracting'; progress.extractAttempts = attempt; await saveState()
          try {
            const raw = await request({ ...base, stage: 'extract',
              task: '提取当前章需要的事实、场景动作、影响与约束。检查全部输入，不仅是提取问题命中；业务现状用流程和运行情况，需求挑战用痛点、影响和诉求，二选一。政策趋势仅采用 selectedDimensions；资料少时展开机制、业务影响和建设回应，区分事实和推演。输出事实及结构化写作提纲，不写一段摘要代替完整分析。',
              schema: { facts: [{ text: '事实或候选', supportMode: 'sourced 或 candidate', evidence: [{ id: '原始 ID', quote: '逐字引文' }] }],
                writingOutline: [{ topic: '本章主题', points: ['场景、表现、影响、做法或边界'] }], gaps: [], reviewItems: [] } })
            if (!Array.isArray(raw.facts)) throw new Error('章节提取缺少 facts 数组')
            const sources = new Map(evidence.map(item => [item.id, item]))
            extraction = { facts: raw.facts.flatMap(item => {
              if (!item || !String(item.text || '').trim()) return []
              const refs = checkedRefs(item.evidence, sources)
              if (list(item.evidence).length && refs.length !== list(item.evidence).length) return []
              return [{ text: String(item.text), supportMode: refs.length ? 'sourced' : 'candidate', evidence: refs }]
            }), writingOutline: list(raw.writingOutline), gaps: strings(raw.gaps), reviewItems: strings(raw.reviewItems) }
            await writeJson(path.join(chapterDir, 'extraction.json'), extraction)
            break
          } catch (error) { if (exec.signal?.aborted || error.code === 'MODEL_CONTEXT_LIMIT' || attempt === 2) throw error }
        }
        let checked
        let draft
        let repairIssues = []
        for (let attempt = 1; attempt <= 2; attempt++) {
          progress.status = 'writing'; progress.writeAttempts = attempt; await saveState()
          try {
            draft = await request({ ...base, stage: 'write', extraction, repairIssues,
              task: writingContract + '业务分析与解决方案是正文重点。业务主题逐项解释参与者、流程、表现、原因与影响；场景逐项解释触发、用户动作、系统动作、产品能力、输出、价值机制和边界。趋势逐维度解释变化→影响→建设回应，材料少可丰富条件性分析。完整写作，不只写概括句。',
              schema: { sections: [{ key: node.key, title: node.title, blocks: [{ id: `${node.key}-1`, text: '完整正文',
                supportMode: 'sourced 或 candidate', dimension: node.roleId === 'policy-trends' ? 'selectedDimensions 中的一项，导语可省略' : undefined,
                ...(PANORAMA_ROLES.includes(node.roleId) ? { capabilityStatus: 'existing/pilot/planned/proposed/unknown 选一', capabilityOwnership: 'self/third-party/customer/unknown 选一' } : {}),
                evidence: [{ id: '原始证据 ID', quote: '逐字原文，不要改写' }],
                planRefs: { capabilityIds: [], scenarioIds: [], problemIds: [], trendIds: [] } }] }], gaps: [], reviewItems: [] } })
            await writeJson(path.join(chapterDir, 'draft.json'), draft)
            progress.status = 'validating'; await saveState()
            checked = validateDraft({ sections: list(draft.sections).filter(section => section?.key === node.key) }, evidence, [node], plan)
            repairIssues = checked.issues
            if (repairIssues.length && attempt === 1) continue
            break
          } catch (error) {
            repairIssues = [error.message]
            if (exec.signal?.aborted || error.code === 'MODEL_CONTEXT_LIMIT' || attempt === 2) throw error
          }
        }
        const chapter = { section: checked.sections[0], validationIssues: checked.issues,
          gaps: [...extraction.gaps, ...strings(draft.gaps)], reviewItems: [...extraction.reviewItems, ...strings(draft.reviewItems)] }
        await writeJson(path.join(chapterDir, 'chapter.json'), chapter)
        progress.status = 'completed'; progress.path = `chapters/${node.key}/chapter.json`; await saveState()
        return chapter
      } catch (error) {
        progress.status = exec.signal?.aborted ? 'cancelled' : 'failed'; progress.error = error.message
        await writeJson(path.join(chapterDir, 'error.json'), { status: progress.status, error: error.message })
        await saveState()
        throw error
      }
    }, { signal: exec.signal })
  } catch (error) {
    if (exec.signal?.aborted) {
      for (const item of state.chapters) if (item.status === 'queued') item.status = 'cancelled'
      await saveState()
      throw abortError(exec.signal)
    }
    throw error
  }
  const successful = results.filter(result => result.status === 'fulfilled').map(result => result.value)
  if (!successful.length) throw new Error(`全部章节未完成；已保留逐章提取、错误和运行记录：${state.chapters.find(item => item.error)?.error || '无有效正文'}`)
  const enriched = await enrichPanoramas({ request, common, plan, outline: resolvedOutline, rules, chapters: successful, evidence, dir, state, saveState, signal: exec.signal })
  const sections = enriched.chapters.map(result => result.section)
  const proposedLinks = linksFromPlan(plan, sections, resolvedOutline)
  const checked = validateDraft({ sections, assemblyLinks: proposedLinks }, evidence, resolvedOutline, plan)
  const balance = contentBalance(checked.sections, resolvedOutline, rules.global.contentBalance)
  const gaps = []
  const reviewItems = [...plan.reviewItems, ...enriched.reviewItems, ...checked.reviewItems, ...balance.reviewItems]
  for (const chapter of successful) {
    reviewItems.push(...chapter.reviewItems)
    for (const gap of chapter.gaps) (/关联不足|关系不足|对应关系/u.test(gap) ? reviewItems : gaps).push(gap)
  }
  for (const item of state.chapters.filter(item => item.status === 'failed')) gaps.push(`${item.title}：生成未完成（${item.error}），其他章节已保留`)
  state.status = 'reviewing'; await saveState()
  try {
    const audit = await request({ ...common, stage: 'consistency-review', plan, outline: resolvedOutline,
      sections: checked.sections, assemblyLinks: checked.assemblyLinks, contentBalance: balance,
      panoramaRules,
      task: '只审核合稿，不重写正文、不增加事实。检查近义标题是否仍符合原章节角色和所选写法，客户现状是否混入厂商内部问题，方法是否二选一，业务分析与场景深度、问题与方案是否对应、引用语义和能力边界。两类全景是否按读者、问题、重点场景动态组织，核心模块是否解释问题→使用者与动作→支撑能力→产出和价值；后续重点场景是否可定位，是否把同组/上下位置当调用关系，第三方/客户已有/规划/试点是否误写自有和全面具备。缺少组织理由也列具体复核项，不自动认定内容错误。篇幅比例是软目标，不为凑比例提无据要求。返回待人工核对项；不得宣称自动证明语义正确。',
      schema: { reviewItems: ['具体问题，标明章节 key'] } })
    const auditItems = strings(audit.reviewItems)
    reviewItems.push(...auditItems)
    await writeJson(path.join(dir, 'consistency-review.json'), { reviewItems: auditItems })
  } catch (error) {
    if (exec.signal?.aborted) throw error
    reviewItems.push(`合稿模型复核未完成：${error.message}；逐字引文检查已执行，语义仍需人工核对`)
  }
  return { title: plan.title, outline: resolvedOutline, sections: checked.sections, choices: plan.choices,
    assemblyLinks: checked.assemblyLinks, reviewItems: strings(reviewItems), gaps: strings(gaps),
    validationIssues: strings([...successful.flatMap(chapter => chapter.validationIssues), ...enriched.validationIssues, ...checked.issues]), contentBalance: balance }
}

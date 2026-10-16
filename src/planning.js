import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { loadRules, validateOutline, requestedModes, applyModes } from './rules.js'
import { normalizePlan, applyPlanTitles } from './plan-model.js'
import { createRetrieval } from './retrieval.js'
import { createRequester, writeJson, checkedFacts, uniqueFacts, strings, commonContext } from './context.js'
import { FACT_SUBJECTS, FACT_PURPOSES } from './evidence-policy.js'
import { stageContext } from './prompts.js'
import { runPath, clone, sha256, sourceEvidence } from './store.js'

export const planHash = document => sha256(JSON.stringify(document))
const readJson = async file => JSON.parse(await readFile(file, 'utf8'))
const identity = args => ({ audience: args.audience || '首次接触方案的企业客户', author_identity: args.author_identity || '售前方案作者',
  domain: args.domain || '', objective: args.objective || '编制产品解决方案' })

// Planning needs a macro view only. Complete sources remain in evidence.json for chapter retrieval.
const macroEvidence = evidence => evidence.slice(0, 4).map(source => ({
  id: source.id, kind: source.kind, source: source.source, locator: source.locator,
  content: source.content.slice(0, 1800), span: { start: 0, end: Math.min(source.content.length, 1800) },
  partial: source.content.length > 1800,
}))

function overviewFacts(raw, evidence) {
  const verified = uniqueFacts(checkedFacts(raw, evidence)).slice(0, 8)
  const hasSourced = verified.some(row => row.supportMode === 'sourced')
  const reviewItems = strings(raw?.reviewItems)
  if (!hasSourced) reviewItems.push('模型未返回可核对的宏观事实，暂以原文选段作为规划锚点；选段尚未概括，主线语义需用户审阅')
  const facts = hasSourced ? verified : evidence.filter(source => source.content.trim().length >= 6).map(source => ({
    text: source.content.slice(0, 400), topic: '宏观原文选段，尚未概括', supportMode: 'sourced',
    subject: 'unknown', purpose: 'unknown', scope: 'unknown', capabilityStatus: 'unknown', capabilityOwnership: 'unknown',
    semanticStatus: 'source_excerpt_unreviewed', evidence: [{ id: source.id, quote: source.content.slice(0, 400) }],
  }))
  return { facts, writingOutline: [], retrievalQueries: [], gaps: [], reviewItems,
    verification: 'quote-match-only', planningMode: 'macro-single-pass',
    batches: [{ batchId: 'overview-plan', status: hasSourced ? 'completed' : 'source_excerpt',
      evidenceIds: evidence.map(source => source.id), facts: facts.length }] }
}

export async function planOutline({ client, llm, args, exec }) {
  const rules = await loadRules(args.template_id || 'presales-solution')
  const outline = validateOutline(clone(args.outline || rules.template.sections), rules)
  const requested = requestedModes(outline, args)
  const source = await sourceEvidence(exec.agent, args)
  const runId = randomUUID(), dir = runPath(exec.agent, runId)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const state = { runId, kind: 'outline-plan', status: 'planning', startedAt: new Date().toISOString(),
    projectId: source.projectId, sourceRunId: args.source_run_id || null }
  const saveState = () => writeJson(path.join(dir, 'run.json'), state)
  const retrieval = createRetrieval({ client, projectId: source.projectId, evidence: source.evidence, rules, outline, dir, signal: exec.signal })
  try {
    const request = await createRequester({ llm, exec, state, saveState })
    const author = identity(args)
    const common = commonContext(rules, args)
    const evidence = await retrieval.discover({ light: true, context: [author.author_identity, author.domain, author.objective].filter(Boolean).join('；') })
    const knowledgeHits = evidence.filter(row => row.kind === 'knowledge' && row.knowledgeBaseId && row.knowledgeId && row.chunkId).length
    state.knowledgeHits = knowledgeHits
    await saveState()
    if (!knowledgeHits) throw new Error('规划阶段知识库检索零命中：请检查项目绑定、文档解析状态和检索接口；本地材料不能代替知识库命中创建大纲')
    const selected = macroEvidence(evidence)
    const context = stageContext(common, 'plan')
    const raw = await request({ ...context, author, stage: 'plan', planningMode: 'macro-single-pass', outline, requestedModes: requested,
      task: `${context.task} 同一次输出最多八条宏观事实、少量主线和粗目录，不做逐章细取证。输入可能只是原文选段；未见的状态、归属和条件写unknown。事实与主线引用输入ID及逐字短引文；引文存在仅代表来源可定位，仍待用户审阅语义。`,
      evidence: selected,
      schema: { facts: [{ text: '简短宏观事实或明确假设', supportMode: 'sourced/candidate',
        subject: FACT_SUBJECTS.join('/'), purpose: FACT_PURPOSES.join('/'), scope: 'customer/typical/vendor-internal/unknown',
        capabilityStatus: 'existing/pilot/planned/proposed/unknown', capabilityOwnership: 'self/third-party/customer/unknown',
        evidence: [{ id: '输入 ID', quote: '至少六字的逐字短引文' }] }],
        title: '方案标题', businessMode: { value: 'current-state/needs-challenges', reason: '简短理由' },
        trendFramework: { value: 'pest/management-business-technology', reason: '简短理由' },
        capabilities: [{ id: 'cap-1', text: '核心能力', subject: 'product', purpose: 'capability', capabilityStatus: 'existing/pilot/planned/proposed/unknown', capabilityOwnership: 'self/third-party/customer/unknown', evidence: [{ id: '原文 ID', quote: '短的逐字引文' }] }],
        problems: [{ id: 'problem-1', text: '有据客户问题或典型假设', subject: 'customer/industry/unknown', purpose: 'business-problem', scope: 'customer/typical/unknown', supportMode: 'sourced/candidate', evidence: [] }],
        trends: [{ id: 'trend-1', text: '相关建设方向，允许不填', subject: 'industry/unknown', purpose: 'trend', supportMode: 'sourced/candidate', evidence: [] }],
        scenarios: [{ id: 'scenario-1', title: '场景', capabilityIds: ['cap-1'], problemIds: ['problem-1'], trendIds: [], relationReason: '为何对应' }],
        chapterGuidance: [{ key: '输入 key', title: '近义标题', focus: '一句目的', retrievalQueries: ['一条具体取材方向'], capabilityIds: [], scenarioIds: [], problemIds: [], trendIds: [] }], reviewItems: [] } })
    const facts = overviewFacts(raw, selected)
    if (!facts.facts.some(row => row.supportMode === 'sourced')) throw new Error('宏观规划没有取得可定位原文，请检查材料后再规划')
    const plan = normalizePlan(raw, selected, outline, args, facts.facts)
    plan.reviewItems = strings([...plan.reviewItems, ...facts.reviewItems])
    const resolved = applyPlanTitles(applyModes(outline, { businessMode: plan.choices.businessMode.value, trendFramework: plan.choices.trendFramework.value }), plan, selected)
    const document = { schemaVersion: 1, templateId: rules.template.id, projectId: source.projectId, sourceRunId: args.source_run_id || null,
      ...author, ruleFingerprint: rules.fingerprint, plan, outline: resolved, createdAt: new Date().toISOString() }
    const hash = planHash(document)
    await writeJson(path.join(dir, 'outline-plan.json'), { document, hash })
    await writeJson(path.join(dir, 'overview-facts.json'), facts)
    Object.assign(state, { status: 'awaiting_confirmation', planSha256: hash })
    await saveState()
    return { planId: runId, planSha256: hash, status: state.status, knowledgeHits, outline: resolved, choices: plan.choices,
      author, chapterGuidance: plan.chapterGuidance, mainlines: plan.scenarios,
      capabilities: plan.capabilities, problems: plan.problems, trends: plan.trends,
      reviewItems: plan.reviewItems, note: '请展示粗目录和主线让用户确认；确认后调用 outline action=confirm，不能自行确认。修改目录需重新 action=plan。' }
  } catch (error) { state.status = exec.signal?.aborted ? 'cancelled' : 'failed'; state.error = error.message; await saveState(); throw error }
  finally { await retrieval.flush() }
}

export async function confirmOutline({ args, exec }) {
  const dir = runPath(exec.agent, args.plan_id)
  const saved = await readJson(path.join(dir, 'outline-plan.json'))
  if (!args.plan_sha256 || saved.hash !== args.plan_sha256 || saved.hash !== planHash(saved.document)) throw new Error('确认版本不匹配，请重新展示大纲')
  if (args.outline && JSON.stringify(args.outline) !== JSON.stringify(saved.document.outline)) throw new Error('目录已改变，请重新规划并展示后确认')
  const state = await readJson(path.join(dir, 'run.json'))
  if (state.kind !== 'outline-plan' || !['awaiting_confirmation', 'confirmed'].includes(state.status)) throw new Error('此大纲未完成，不能确认')
  if (args.confirmed !== true) throw new Error('收到用户明确确认后才可设置 confirmed=true')
  const rules = await loadRules(saved.document.templateId)
  if (rules.fingerprint !== saved.document.ruleFingerprint) throw new Error('规则已更新，请重新规划确认')
  Object.assign(state, { status: 'confirmed', confirmedSha256: saved.hash, confirmedAt: new Date().toISOString() })
  await writeJson(path.join(dir, 'run.json'), state)
  return { planId: args.plan_id, planSha256: saved.hash, status: 'confirmed', outline: saved.document.outline }
}

export async function confirmedPlan({ args, exec }) {
  if (!args.plan_id || !args.plan_sha256) throw new Error('请先调用 wlyd_assembly_outline action=plan，展示大纲，取得用户确认后 action=confirm；生成需 plan_id 和 plan_sha256')
  const dir = runPath(exec.agent, args.plan_id)
  const saved = await readJson(path.join(dir, 'outline-plan.json'))
  const state = await readJson(path.join(dir, 'run.json'))
  if (state.status !== 'confirmed' || state.confirmedSha256 !== saved.hash || args.plan_sha256 !== saved.hash || saved.hash !== planHash(saved.document)) throw new Error('大纲尚未确认或版本不匹配')
  const doc = saved.document
  for (const [arg, field] of Object.entries({ project_id: 'projectId', source_run_id: 'sourceRunId', template_id: 'templateId',
    audience: 'audience', author_identity: 'author_identity', domain: 'domain', objective: 'objective' })) {
    if (args[arg] !== undefined && args[arg] !== doc[field]) throw new Error(`${arg} 与确认大纲不一致，请重新规划确认`)
  }
  if (args.outline && JSON.stringify(args.outline) !== JSON.stringify(doc.outline)) throw new Error('目录与确认版本不一致，请重新规划确认')
  if (args.business_mode !== undefined && args.business_mode !== doc.plan.choices.businessMode.value) throw new Error('业务写法与确认版本不一致')
  if (args.trend_framework !== undefined && args.trend_framework !== doc.plan.choices.trendFramework.value) throw new Error('趋势框架与确认版本不一致')
  const rules = await loadRules(doc.templateId)
  if (rules.fingerprint !== doc.ruleFingerprint) throw new Error('规则与确认版本不一致，请重新规划确认')
  return { document: doc, rules, args: { ...args, ...identity(doc), project_id: doc.projectId, source_run_id: doc.sourceRunId, template_id: doc.templateId } }
}

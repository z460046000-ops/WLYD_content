import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { loadRules, validateOutline, requestedModes, applyModes } from './rules.js'
import { normalizePlan, applyPlanTitles } from './plan-model.js'
import { createRetrieval } from './retrieval.js'
import { collectFacts } from './facts.js'
import { createRequester, writeJson, citedEvidence } from './context.js'
import { runPath, clone, sha256, sourceEvidence } from './store.js'

export const planHash = document => sha256(JSON.stringify(document))
const readJson = async file => JSON.parse(await readFile(file, 'utf8'))
const identity = args => ({ audience: args.audience || '首次接触方案的企业客户', author_identity: args.author_identity || '售前方案作者',
  domain: args.domain || '', objective: args.objective || '编制产品解决方案' })

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
    const evidence = await retrieval.discover({ light: true, context: [author.author_identity, author.domain, author.objective].filter(Boolean).join('；') })
    if (!evidence.length) throw new Error('没有宏观规划所需的可核对资料，请检查知识库或导入材料')
    const facts = await collectFacts({ request, common: { author, audience: author.audience },
      node: { key: 'overview', title: '产品与业务宏观了解', roleId: 'custom' }, rule: {}, evidence, plan: {},
      onBatch: async () => {} })
    if (!facts.facts.some(row => row.supportMode === 'sourced')) throw new Error('宏观规划没有取得有据事实，请检查材料后再规划')
    const raw = await request({ stage: 'plan', author, audience: author.audience, outline, requestedModes: requested,
      factUsagePolicy: rules.global.fact_usage_policy,
      evidence: citedEvidence(facts.facts, evidence), facts: facts.facts,
      task: '从作者身份、领域、写作目标和读者出发，只提出供用户确认的粗目录，不写正文或详细全景设计。保留输入目录 key、roleId、顺序及层级，标题可自然近义改写；每章一句面向读者的内容目的和一条具体检索方向。“粗目录、不写正文、下阶段取证、待用户确认”只是本阶段控制指令，不得出现在方案标题、章节标题、focus或organization中。只挑最多三项有原文的核心产品能力，先确定其真实支持的业务动作与场景，再对应客户问题及相关趋势，最多三条主线；场景没有有据能力不得成立，厂商定位、竞争、获客、缺少案例或内部研发等自身问题不得反推为客户需求或行业趋势。问题无客户证据或属于典型推演时，即使引用产品材料也必须supportMode=candidate、scope=typical；引文有效不代表主体或用途适合。各项标明subject和purpose，客户事实、产品能力、行业背景与公司背书分别取证。趋势不强凑，能力状态与归属未知就写unknown。选择业务现状/需求挑战和PEST/管理业务技术各一种，服从用户指定。业务全景说明角色、流程与交接，产品全景说明功能支撑与能力边界，具体组织维度留给章节取证后决定。无正向真实案例不规划负面案例说明，企业介绍不写知识库目录与维护入口。',
      schema: { title: '方案标题', businessMode: { value: 'current-state/needs-challenges', reason: '简短理由' },
        trendFramework: { value: 'pest/management-business-technology', reason: '简短理由' },
        capabilities: [{ id: 'cap-1', text: '核心能力', subject: 'product', purpose: 'capability', capabilityStatus: 'existing/pilot/planned/proposed/unknown', capabilityOwnership: 'self/third-party/customer/unknown', evidence: [{ id: '原文 ID', quote: '短的逐字引文' }] }],
        problems: [{ id: 'problem-1', text: '有据客户问题或典型假设', subject: 'customer/industry/unknown', purpose: 'business-problem', scope: 'customer/typical/unknown', supportMode: 'sourced/candidate', evidence: [] }],
        trends: [{ id: 'trend-1', text: '相关建设方向，允许不填', subject: 'industry/unknown', purpose: 'trend', supportMode: 'sourced/candidate', evidence: [] }],
        scenarios: [{ id: 'scenario-1', title: '场景', capabilityIds: ['cap-1'], problemIds: ['problem-1'], trendIds: [], relationReason: '为何对应' }],
        chapterGuidance: [{ key: '输入 key', title: '近义标题', focus: '一句目的', retrievalQueries: ['一条具体取材方向'], capabilityIds: [], scenarioIds: [], problemIds: [], trendIds: [] }], reviewItems: [] } })
    const plan = normalizePlan(raw, evidence, outline, args, facts.facts)
    const resolved = applyPlanTitles(applyModes(outline, { businessMode: plan.choices.businessMode.value, trendFramework: plan.choices.trendFramework.value }), plan, evidence)
    const document = { schemaVersion: 1, templateId: rules.template.id, projectId: source.projectId, sourceRunId: args.source_run_id || null,
      ...author, ruleFingerprint: rules.fingerprint, plan, outline: resolved, createdAt: new Date().toISOString() }
    const hash = planHash(document)
    await writeJson(path.join(dir, 'outline-plan.json'), { document, hash })
    await writeJson(path.join(dir, 'overview-facts.json'), facts)
    Object.assign(state, { status: 'awaiting_confirmation', planSha256: hash })
    await saveState()
    return { planId: runId, planSha256: hash, status: state.status, outline: resolved, choices: plan.choices,
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

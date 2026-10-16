import { flattenOutline, requestedModes } from './rules.js'
import { CAPABILITY_STATUSES, CAPABILITY_OWNERS } from './content.js'
import { normalizeFactMetadata, isHypothesis, internalNarrative } from './evidence-policy.js'
const list = value => Array.isArray(value) ? value : []
const strings = value => [...new Set(list(value).filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()))]
const validId = value => typeof value === 'string' && /^[a-z][a-z0-9-]*$/u.test(value)
const speculativeCapability = /可考虑|待确认|尚待确认|需(?:进一步)?确认|拟(?:建设|实现|提供|支持|上线|交付)|(?:计划|规划)(?:建设|实现|提供|支持|上线|交付)/u
const processLanguage = /粗目录|粗大纲|下一阶段|下阶段|下一步|待用户确认|用户确认后|不写(?:正文|全景)|暂不(?:展开|撰写)|后续(?:取证|阶段)/u
const contentFocus = value => String(value || '').split(/[。；;，]/u).map(part => part.trim())
  .filter(part => part && !processLanguage.test(part)).join('；')
const planTitle = value => {
  const title = String(value || '').replace(/[（(【\[]([^）)】\]]*)[）)】\]]/gu,
    (whole, inner) => processLanguage.test(inner) ? '' : whole).trim()
  return title && !processLanguage.test(title) ? title : '产品售前解决方案'
}

function checkedRefs(refs, sources) {
  return list(refs).flatMap(ref => {
    const source = sources.get(String(ref?.id))
    const quote = String(ref?.quote || '').trim()
    return source && quote.length >= 6 && source.content.includes(quote) ? [{ id: source.id, quote }] : []
  })
}

export function normalizePlan(raw, evidence, outline, args = {}, facts = []) {
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
      const refs = checkedRefs(item.evidence, sources)
      const metadata = normalizeFactMetadata(item)
      if (metadata.classificationIssues?.length) issues.push(`规划项 ${item.id}：${metadata.classificationIssues.join('；')}`)
      const linkedFacts = facts.filter(fact => list(fact.evidence).some(ref => refs.some(checked => checked.id === ref.id
        && (checked.quote.includes(ref.quote) || ref.quote.includes(checked.quote)))))
      const subjects = [item.subject, item.scope, ...linkedFacts.flatMap(fact => [fact.subject, fact.scope])].filter(Boolean)
      const purposes = [item.purpose, ...linkedFacts.map(fact => fact.purpose)].filter(Boolean)
      const internal = subjects.includes('vendor-internal') || purposes.includes('internal') || internalNarrative(String(item.text))
        || ['problems', 'trends'].includes(field) && refs.some(ref => internalNarrative(ref.quote))
      if (internal && ['problems', 'trends'].includes(field)) {
        issues.push(`共享规划已排除 ${item.id} 的供应方内部判断，不能作为客户问题或行业趋势`); return []
      }
      if (field === 'capabilities' && (internal || subjects.some(subject => ['industry', 'company'].includes(subject)) && !purposes.includes('capability')
        || purposes.some(purpose => ['business-problem', 'trend', 'case', 'company-profile'].includes(purpose)))) {
        issues.push(`规划能力 ${item.id} 的材料主体或用途不匹配，未作为产品能力使用`); return []
      }
      if (requireSource && !refs.length) { issues.push(`规划能力 ${item.id} 缺少有效原文，未作为已具备能力使用`); return [] }
      const candidate = isHypothesis(item) || item.hypothesis === true
        || field === 'capabilities' && (speculativeCapability.test(String(item.text)) || refs.some(ref => speculativeCapability.test(ref.quote)))
        || ['problems', 'trends'].includes(field) && /典型|假设|可能|可考虑|待确认|推测|推演|建议/u.test(String(item.text))
        || linkedFacts.some(fact => fact.supportMode === 'candidate' || isHypothesis(fact))
        || field === 'problems' && (subjects.some(subject => ['product', 'industry', 'company'].includes(subject))
          || purposes.some(purpose => !['business-problem', 'unknown'].includes(purpose)))
        || field === 'trends' && (subjects.some(subject => ['product', 'company'].includes(subject))
          || purposes.some(purpose => !['trend', 'unknown'].includes(purpose)))
      if (field === 'capabilities' && candidate && ['existing', 'pilot'].includes(item.capabilityStatus)) {
        issues.push(`规划能力 ${item.id} 为待确认候选，已撤销未经核实的已具备或试点状态`)
      }
      seen.add(item.id)
      return [{ id: item.id, text: String(item.text), supportMode: refs.length && !candidate ? 'sourced' : 'candidate', evidence: refs,
        subject: metadata.subject,
        purpose: metadata.purpose,
        scope: candidate ? 'typical' : item.scope === 'customer' ? 'customer' : 'unknown',
        ...(field === 'capabilities' ? {
          capabilityStatus: candidate && ['existing', 'pilot'].includes(item.capabilityStatus)
            ? 'unknown' : CAPABILITY_STATUSES.includes(item.capabilityStatus) ? item.capabilityStatus : 'unknown',
          capabilityOwnership: candidate ? 'unknown'
            : CAPABILITY_OWNERS.includes(item.capabilityOwnership) ? item.capabilityOwnership : 'unknown',
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
    if (internalNarrative(`${item.title}；${item.relationReason || ''}`)) {
      issues.push(`场景 ${item.id} 是供应方内部经营或组稿事项，未纳入客户主线`); return []
    }
    const capabilityIds = select(item.capabilityIds, capabilities)
    if (!capabilityIds.length) { issues.push(`场景 ${item.id} 没有可核对的产品能力支撑，未纳入共享主线`); return [] }
    seenScenarios.add(item.id)
    return [{ id: item.id, title: String(item.title), capabilityIds,
      problemIds: select(item.problemIds, problems), trendIds: select(item.trendIds, trends),
      relationReason: String(item.relationReason || '模型建议的能力、场景和业务问题对应关系，待人工核对') }]
  })
  const keys = new Set(flattenOutline(outline).map(node => node.key))
  return { title: planTitle(raw?.title), choices, capabilities, problems, trends, scenarios,
    chapterGuidance: list(raw?.chapterGuidance).filter(item => item && keys.has(item.key)).map(item => ({ key: item.key, title: String(item.title || ''), focus: contentFocus(item.focus),
      retrievalQueries: strings(item.retrievalQueries).filter(query => !processLanguage.test(query)).slice(0, 3),
      capabilityIds: select(item.capabilityIds, capabilities), scenarioIds: select(item.scenarioIds, scenarios),
      problemIds: select(item.problemIds, problems), trendIds: select(item.trendIds, trends),
      ...(item.organization && typeof item.organization === 'object' ? { organization: {
        purpose: contentFocus(item.organization.purpose), scope: contentFocus(item.organization.scope),
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
    const valid = proposal && proposal.length <= 100 && !/[\r\n<>#]/u.test(proposal) && !processLanguage.test(proposal) && !titles.has(proposal)
      && !mixedBusinessModes && numbers.every(number => evidence.some(item => item.content.includes(number)))
    if (proposal && !valid) plan.reviewItems.push(`${node.key} 的标题变体不合格，已使用该章节默认标题`)
    const title = valid ? proposal : node.title
    titles.add(title)
    return { ...node, canonicalTitle: node.title, title, ...(node.children ? { children: visit(node.children) } : {}) }
  })
  return visit(outline)
}

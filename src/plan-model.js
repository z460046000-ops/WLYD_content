import { flattenOutline, requestedModes } from './rules.js'
import { CAPABILITY_STATUSES, CAPABILITY_OWNERS } from './content.js'
const list = value => Array.isArray(value) ? value : []
const strings = value => [...new Set(list(value).filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()))]
const validId = value => typeof value === 'string' && /^[a-z][a-z0-9-]*$/u.test(value)

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
      retrievalQueries: strings(item.retrievalQueries).slice(0, 3),
      capabilityIds: select(item.capabilityIds, capabilities), scenarioIds: select(item.scenarioIds, scenarios),
      problemIds: select(item.problemIds, problems), trendIds: select(item.trendIds, trends),
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

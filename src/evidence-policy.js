/** Subject and purpose describe a claim, never the filename of the source. */
export const FACT_SUBJECTS = ['customer', 'product', 'industry', 'company', 'vendor-internal', 'unknown']
export const FACT_PURPOSES = ['capability', 'business-problem', 'trend', 'case', 'company-profile', 'constraint', 'internal', 'unknown']
const CAPABILITY_STATUSES = ['existing', 'pilot', 'planned', 'proposed', 'unknown']
const CAPABILITY_OWNERS = ['self', 'third-party', 'customer', 'unknown']
const SCOPES = ['customer', 'typical', 'vendor-internal', 'unknown']

export function isHypothesis(item) {
  return item?.supportMode === 'candidate' || ['typical', 'inferred', 'hypothetical'].includes(item?.scope)
    || item?.isHypothesis === true || /【(?:典型假设|合理推演|待确认[：·]?(?:假设|推演))】|^(?:典型假设|合理推演|待确认(?:假设|推演))[：:]/u.test(String(item?.text || ''))
}

/** Conservative backstop for explicit internal narration; classification still needs the model. */
export function internalNarrative(text) {
  const value = String(text || '')
  return /(?:厂商|供应商|我司|我们|自身).{0,18}(?:定位不清|信任赤字|获客困难|缺(?:少|乏)?(?:成功)?案例|缺少场景诊断|缺乏客户信任|竞争判断|流量不足|商业化困难)/u.test(value)
    || /(?:厂商|供应商|我司)(?:自身|自有|的|内部){0,3}(?:(?:研发缺陷|研发问题)(?!管理|跟踪|分析|识别|检测|处理|治理|平台|系统|工具|能力|解决方案)|代码(?:审查|现状)(?:发现|暴露|存在|显示|结论|问题)|经营困境|竞争判断)/u.test(value)
    || /(?:(?:本批|本次)材料.{0,8}(?:不足|缺少|缺失|没有|不包含|未提供|需要补充|仍需补充)|(?:本批|本次)(?:报告|方案)?(?:提取|组稿|撰写)(?:的)?(?:过程|安排|阶段|结果|规则)|(?:本报告|本方案)(?:的)?(?:组稿|撰写)(?:过程|安排|阶段))/u.test(value)
    || (!/客户.{0,12}(?:知识库|资料|目录|维护)/u.test(value) && /(?:知识库(?:的)?目录(?:如下|结构|包括|说明)|(?:资料|知识库)(?:维护人|负责人)(?:是|为|：))/u.test(value))
}

/** These labels are model assertions, not evidence that the claim itself is true. */
export function normalizeFactMetadata(item = {}) {
  const issues = []
  const choice = (field, allowed) => {
    if (item[field] === undefined || item[field] === null || item[field] === '') return 'unknown'
    if (allowed.includes(item[field])) return item[field]
    issues.push(`${field} 分类无效`); return 'unknown'
  }
  const scope = ['typical', 'inferred', 'hypothetical'].includes(item.scope) ? 'typical' : choice('scope', SCOPES)
  const metadata = {
    subject: choice('subject', FACT_SUBJECTS), purpose: choice('purpose', FACT_PURPOSES), scope,
    capabilityStatus: choice('capabilityStatus', CAPABILITY_STATUSES), capabilityOwnership: choice('capabilityOwnership', CAPABILITY_OWNERS),
  }
  for (const [field, limit] of [['asOf', 120], ['topic', 120]]) {
    if (item[field] === undefined || item[field] === null || item[field] === '') continue
    if (typeof item[field] === 'string' && item[field].trim().length <= limit) metadata[field] = item[field].trim()
    else issues.push(`${field} 须为不超过 ${limit} 字的简短文本`)
  }
  if (isHypothesis(item)) metadata.supportMode = 'candidate'
  else if (item.supportMode === 'sourced') metadata.supportMode = 'sourced'
  else if (item.supportMode !== undefined && item.supportMode !== null && item.supportMode !== '') issues.push('supportMode 分类无效')
  if (issues.length) metadata.classificationIssues = issues
  return metadata
}

const roleDefaults = {
  'business-challenges': { subjects: ['customer', 'industry'], purposes: ['business-problem', 'constraint'] },
  'policy-trends': { subjects: ['industry', 'customer'], purposes: ['trend', 'constraint'] },
  'customer-cases': { subjects: ['customer', 'company'], purposes: ['case'] },
  'company-profile': { subjects: ['company'], purposes: ['company-profile'] },
}

function noCaseStatement(text) {
  const modifiers = '(?:可(?:核验|验证|核对)|真实|正式|外部|已落地|已实施|实际|成功|客户|合作|行业|落地|项目|历史|相关|任何|足够)(?:的)?'
  // Missing a case and missing a case attachment describe different facts.
  const attachment = '(?!附件|截图|合同|授权|数据|证明|材料|文档|介绍|细节)'
  return new RegExp(`(?:没有|缺少|缺乏|尚无|暂无|未提供|未取得|未检索到|找不到|不足以证明|无)(?:${modifiers}){0,5}案例${attachment}`, 'u').test(text)
    || new RegExp(`(?<![\\d.])(?:0|零)\\s*(?:个|项)(?:${modifiers}){0,3}案例${attachment}`, 'u').test(text)
    || /案例(?:数量|数)?(?:为|是|：|:)\s*(?:零|0)(?![\d.])/u.test(text)
    || /案例(?:本身)?(?:仍|尚|暂)?(?:缺失|待补充|不可核验|未经验证)/u.test(text)
    || /(?:未来|后续|计划|拟|待)[^，,。；;]{0,12}(?:补充|提供|收集|整理|建设|形成)[^，,。；;]{0,12}(?:客户|合作|成功|行业|落地)?案例/u.test(text)
}

/** Route facts after extraction without removing their archived original sources. */
export function routeFacts(facts, node = {}, rule = {}) {
  const policy = { ...(roleDefaults[node.roleId] || {}), ...(rule.contentPolicy || {}) }
  const kept = [], excludedFacts = [], reviewItems = []
  for (const fact of Array.isArray(facts) ? facts : []) {
    const metadata = normalizeFactMetadata(fact)
    const row = { ...fact, ...metadata }
    const reasons = [...(Array.isArray(fact.classificationIssues) ? fact.classificationIssues : []), ...(metadata.classificationIssues || [])]
    if (row.subject === 'vendor-internal' || row.scope === 'vendor-internal' || row.purpose === 'internal') reasons.push('厂商内部或过程信息仅供内部审核')
    if (internalNarrative(row.text)) reasons.push('明确内部经营、研发或组稿叙事不进入客户正文')
    if (node.roleId === 'customer-cases' && noCaseStatement(String(row.text || ''))) reasons.push('没有可核验案例的说明不是合作案例')
    if (policy.requireKnownPurpose === true && (row.purpose === 'unknown' || !Array.isArray(policy.purposes) || !policy.purposes.includes(row.purpose))) reasons.push('本章需要明确且匹配的事实用途')
    if ((row.subject === 'unknown' || row.purpose === 'unknown') && ['business-challenges', 'policy-trends'].includes(node.roleId) && row.supportMode === 'sourced') {
      row.supportMode = 'candidate'
      reviewItems.push(`${node.key || node.roleId}：事实${row.subject === 'unknown' ? '主体' : '用途'}尚不明确，保留引用并按待确认候选撰写：${String(row.text || '').slice(0, 120)}`)
    }
    if (policy.allowCandidate === false && row.supportMode === 'candidate') reasons.push('本章只接受有据事实，候选推演仅供审核')
    if (policy.requiresPositiveEvidence === true && (row.supportMode !== 'sourced' || !Array.isArray(row.evidence) || !row.evidence.length)) reasons.push('本章需要正向事实及其原文证据')
    for (const [field, allowedKey, excludedKey] of [['subject', 'subjects', 'excludeSubjects'], ['purpose', 'purposes', 'excludePurposes']]) {
      if (Array.isArray(policy[excludedKey]) && policy[excludedKey].includes(row[field])) reasons.push(`${field}=${row[field]} 被本章用途规则排除`)
      // Missing labels from older models remain usable; explicit mismatches do not.
      if (row[field] !== 'unknown' && Array.isArray(policy[allowedKey]) && !policy[allowedKey].includes(row[field])) reasons.push(`${field}=${row[field]} 不适合本章正文`)
    }
    const uniqueReasons = [...new Set(reasons)]
    if (uniqueReasons.length) {
      excludedFacts.push({ ...row, exclusionReasons: uniqueReasons })
      reviewItems.push(`${node.key || node.roleId || '本章'}：${uniqueReasons.join('；')}：${String(row.text || '').slice(0, 120)}`)
    } else kept.push(row)
  }
  return { facts: kept, excludedFacts, reviewItems: [...new Set(reviewItems)] }
}

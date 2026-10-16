import { flattenOutline, FRAMEWORK_DIMENSIONS } from './rules.js'

export const PANORAMA_ROLES = ['business-architecture', 'product-architecture']
export const CAPABILITY_STATUSES = ['existing', 'pilot', 'planned', 'proposed', 'unknown']
export const CAPABILITY_OWNERS = ['self', 'third-party', 'customer', 'unknown']

function capabilityBoundary(block, planRefs, plan, candidate) {
  for (const [field, allowed] of [['capabilityStatus', CAPABILITY_STATUSES], ['capabilityOwnership', CAPABILITY_OWNERS]]) {
    if (block[field] !== undefined && !allowed.includes(block[field])) return { error: `${field} 无效` }
  }
  const capabilities = (plan.capabilities || []).filter(item => planRefs.capabilityIds.includes(item.id))
  const states = capabilities.map(item => item.capabilityStatus || 'unknown')
  const owners = capabilities.map(item => item.capabilityOwnership || 'unknown')
  const inferredStatus = ['planned', 'proposed', 'pilot', 'unknown', 'existing'].find(value => states.includes(value)) || 'unknown'
  const mixedStatus = new Set(states.filter(value => value !== 'unknown')).size > 1
  const mixedOwnership = new Set(owners.filter(value => value !== 'unknown')).size > 1
  const capabilityStatus = mixedStatus ? 'unknown' : block.capabilityStatus || (candidate ? 'proposed' : inferredStatus)
  const capabilityOwnership = mixedOwnership ? 'unknown' : block.capabilityOwnership || (owners.length && new Set(owners).size === 1 ? owners[0] : 'unknown')
  if ((candidate && capabilityStatus === 'existing' && (!states.length || states.some(value => value !== 'existing'))) ||
    (capabilityStatus === 'existing' && states.some(value => ['planned', 'proposed', 'pilot'].includes(value)))) {
    return { error: '候选、试点或规划能力被升级为已具备' }
  }
  const text = String(block.text || '')
  const positiveClaims = text.split(/[，,。；;！？!?]/u).filter(clause => !/不能|不得|不应|不把|不写|不作为|不代表|不等于|不意味着|尚未|还未|并未|暂未|尚不|暂不|并不|不是|并非|不属于|非自研|非自主/u.test(clause)).join('，')
  const stateClaim = positiveClaims.replace(/未(?:全面具备|全面上线|全面支持|全面交付|已具备|已实现|已上线|已交付|现已支持|已经支持)/gu, '')
  if (!mixedStatus && (['planned', 'proposed'].includes(capabilityStatus) || states.some(value => ['planned', 'proposed'].includes(value))) &&
    /已具备|已实现|已上线|已交付|现已支持|已经支持/u.test(stateClaim)) return { error: '建议或规划能力写成了已具备' }
  if (!mixedStatus && (capabilityStatus === 'pilot' || states.includes('pilot')) && /全面具备|全面上线|全面支持|全面交付/u.test(stateClaim)) return { error: '试点能力写成了全面具备' }
  const external = owners.some(value => ['third-party', 'customer'].includes(value)) || ['third-party', 'customer'].includes(capabilityOwnership)
  const ownershipClaim = positiveClaims.replace(/非(?:自主研发|自主开发|自研|我司自有)/gu, '')
  if (!mixedOwnership && external && (capabilityOwnership === 'self' || /自主研发|自主开发|自研|我司自有/u.test(ownershipClaim))) return { error: '外部能力写成了自有或自研功能' }
  const labels = [({ pilot: '试点中', planned: '规划中' })[capabilityStatus],
    ({ 'third-party': '第三方能力', customer: '客户已有能力' })[capabilityOwnership]].filter(Boolean)
  const label = labels.length ? `【${labels.join('·')}】` : ''
  return { capabilityStatus, capabilityOwnership, mixed: mixedStatus || mixedOwnership, text: label && !text.includes(label) ? label + text : text }
}

/** A chapter with retained paragraphs can still be partial; only explicit optional omissions are complete. */
export function chapterOutcomes(report) {
  const sections = new Map((report.sections || []).map(section => [section.key, section]))
  const recorded = new Map((report.chapterOutcomes || []).map(row => [row.key, row]))
  return flattenOutline(report.outline || []).map(node => {
    const row = recorded.get(node.key)
    const hasContent = Boolean(sections.get(node.key)?.blocks?.length)
    let status = row?.status || (hasContent ? 'completed' : 'failed')
    if (status === 'omitted' && (node.required !== false || hasContent)) status = hasContent ? 'partial' : 'failed'
    if (status === 'completed' && !hasContent) status = 'failed'
    if (status === 'partial' && !hasContent) status = 'failed'
    if (!['completed', 'partial', 'omitted', 'failed', 'cancelled'].includes(status)) status = hasContent ? 'partial' : 'failed'
    if (hasContent && !['completed', 'omitted'].includes(status)) status = 'partial'
    return { ...row, key: node.key, title: node.title, required: node.required !== false, status }
  })
}

export function reportText(report) {
  const byKey = new Map((report.sections || []).map(section => [section.key, section]))
  const outcomes = chapterOutcomes(report)
  const byOutcome = new Map(outcomes.map(row => [row.key, row]))
  const incomplete = outcomes.filter(row => !['completed', 'omitted'].includes(row.status))
  const lines = [`# ${report.title}`, '']
  if (incomplete.length || report.reviewStatus === 'partial_draft') {
    lines.push('> 部分草稿：仍有章节未完成。已保留可用正文，请结合独立审核清单确认后使用。', '')
  }
  const hasContent = node => byOutcome.get(node.key)?.status !== 'omitted' || (node.children || []).some(hasContent)
  const visit = (nodes, depth) => {
    for (const node of nodes) {
      if (!hasContent(node)) continue
      lines.push(`${'#'.repeat(depth)} ${node.title}`, '')
      const section = byKey.get(node.key)
      const outcome = byOutcome.get(node.key)
      if (outcome?.status === 'partial') lines.push('> 本章尚未完整，以下保留已通过校验的内容。', '')
      else if (outcome?.status !== 'omitted' && !section?.blocks?.length) lines.push('> 本章尚未完成，待补充。', '')
      if (section?.framework && FRAMEWORK_DIMENSIONS[section.framework]) {
        lines.push(`分析框架：${section.framework === 'pest' ? 'PEST' : '管理、业务、技术'}`, '')
      }
      for (const block of section?.blocks || []) {
        lines.push(block.text, '')
        if (block.evidence?.length) lines.push(`依据：${[...new Set(block.evidence.map(ref => `[${ref.id}]`))].join('、')}`, '')
      }
      visit(node.children || [], depth + 1)
    }
  }
  visit(report.outline || [], 2)
  return lines.join('\n')
}

const reviewLabels = { review: '待审', validation: '校验', gap: '缺项', chapter: '章节' }
const normalizeReviewText = text => String(text).trim().replace(/\s+/gu, ' ')
const mentionsChapter = (text, node) => {
  const escapedKey = node.key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(?:^|[^a-z0-9-])${escapedKey}(?=$|[^a-z0-9-]|-\\d+(?:\\b|$))`, 'u').test(text)
    || Boolean(node.title && text.includes(node.title))
}

/** Keep the full audit outside the customer manuscript; grouping never drops the raw records. */
export function reviewDocument(report) {
  const outcomes = chapterOutcomes(report)
  const nodes = flattenOutline(report.outline || [])
  const items = [], byText = new Map()
  const add = (value, category, explicitKey) => {
    const text = normalizeReviewText(value)
    if (!text) return
    const matches = explicitKey ? [explicitKey] : nodes.filter(node => mentionsChapter(text, node)).map(node => node.key)
    const existing = byText.get(text)
    if (existing) {
      existing.occurrences++
      if (!existing.categories.includes(category)) existing.categories.push(category)
      existing.chapterKeys = [...new Set([...existing.chapterKeys, ...matches])]
      return
    }
    const item = { id: `audit-${items.length + 1}`, text, categories: [category], chapterKeys: matches, occurrences: 1 }
    byText.set(text, item); items.push(item)
  }
  for (const [field, category] of [['reviewItems', 'review'], ['validationIssues', 'validation'], ['gaps', 'gap']]) {
    for (const value of Array.isArray(report[field]) ? report[field] : []) add(value, category)
  }
  for (const row of outcomes) if (!['completed', 'omitted'].includes(row.status)) {
    add(`${row.title}：${row.status === 'partial' ? '保留部分有效正文，仍未完成' : '未完成正文'}${row.error ? `（${row.error}）` : ''}`, 'chapter', row.key)
  }
  const groups = [{ key: null, title: '整体审核', itemIds: items.filter(item => !item.chapterKeys.length).map(item => item.id) },
    ...nodes.map(node => ({ key: node.key, title: node.title,
      itemIds: items.filter(item => item.chapterKeys[0] === node.key).map(item => item.id) }))].filter(group => group.itemIds.length)
  return { schemaVersion: 1, runId: report.runId, reviewStatus: report.reviewStatus,
    generatedAt: report.generatedAt, chapterOutcomes: outcomes,
    summary: { uniqueItems: items.length, sourceItems: items.reduce((count, item) => count + item.occurrences, 0),
      completedChapters: outcomes.filter(row => row.status === 'completed').length,
      partialChapters: outcomes.filter(row => row.status === 'partial').length,
      failedChapters: outcomes.filter(row => ['failed', 'cancelled'].includes(row.status)).length,
      omittedChapters: outcomes.filter(row => row.status === 'omitted').length },
    groups, items,
    raw: { reviewItems: report.reviewItems || [], validationIssues: report.validationIssues || [], gaps: report.gaps || [],
      assemblyReview: report.assemblyReview || null, contentBalance: report.contentBalance || null } }
}

export function reviewText(review) {
  const byId = new Map(review.items.map(item => [item.id, item]))
  const lines = ['# 内部审核清单', '', `稿件状态：${review.reviewStatus === 'partial_draft' ? '部分草稿' : '待人工审核'}`, '',
    `审核事项：${review.summary.uniqueItems} 项（原始记录 ${review.summary.sourceItems} 条，重复内容已合并）。`, '']
  const omitted = review.chapterOutcomes.filter(row => row.status === 'omitted')
  if (omitted.length) lines.push('## 已省略的可选章节', '', ...omitted.map(row => `- ${row.title}：${row.omissionReason || '未取得适合正文的证据'}`), '')
  for (const group of review.groups) {
    lines.push(`## ${group.title}`, '')
    for (const id of group.itemIds) {
      const item = byId.get(id)
      lines.push(`- 【${item.categories.map(category => reviewLabels[category]).join('、')}】${item.text}`)
    }
    lines.push('')
  }
  if (!review.items.length) lines.push('未记录额外审核事项，仍需人工确认业务事实、方案适用性与对外表述。', '')
  return lines.join('\n')
}

export function validateDraft(draft, evidence, outline, plan = {}) {
  const sources = new Map(evidence.map(item => [item.id, item]))
  const nodes = new Map(flattenOutline(outline).map(node => [node.key, node]))
  const allowed = new Set()
  const visit = sections => { for (const item of sections) { allowed.add(item.key); if (item.children) visit(item.children) } }
  visit(outline)
  const sections = []
  const issues = []
  const reviewItems = []
  for (const item of Array.isArray(draft?.sections) ? draft.sections : []) {
    if (!item || !allowed.has(item.key) || !Array.isArray(item.blocks)) { issues.push('模型返回目录外章节'); continue }
    const blocks = []
    const ids = new Set()
    const node = nodes.get(item.key)
    for (const [index, block] of item.blocks.entries()) {
      if (!block || typeof block !== 'object') { issues.push(`${item.key} 有格式无效段落`); continue }
      const refs = Array.isArray(block.evidence) ? block.evidence : []
      const text = String(block.text ?? '').trim()
      const candidate = block.supportMode === 'candidate'
      if (text.length < 8 || (!refs.length && !candidate)) {
        issues.push(`${item.key} 有无正文或无来源段落`); continue
      }
      // Exclude only an explicitly negated claim token; positive claims elsewhere still fail.
      const candidateClaims = text.replace(/(?:不能|不得|不应|不可)(?:作为|视为|表述为|写成|宣称为)(?:(?:本产品|我司|客户)?(?:现已|已经|已)(?:实现|上线|交付|获得)|保证|承诺)/gu, '')
      if (candidate && /(?:本产品|我司|客户)(?:已|现已|已经)|已实现|已上线|已交付|已获得|保证|承诺/iu.test(candidateClaims)) {
        issues.push(`${item.key} 的待确认内容写成了已发生事实`); continue
      }
      const checked = refs.map(ref => {
        const source = sources.get(String(ref?.id))
        const quote = String(ref?.quote ?? '').trim()
        return source && quote.length >= 6 && source.content.includes(quote) ? { id: source.id, quote } : null
      })
      if (checked.some(ref => !ref)) { issues.push(`${item.key} 的引用无法逐字定位`); continue }
      const numbers = text.match(/\d+(?:[.,]\d+)*(?:%|％|万|亿|年|月|日|家|人)?/gu) ?? []
      if (numbers.some(number => !checked.some(ref => ref.quote.includes(number)))) {
        issues.push(`${item.key} 含引文未支持的数字`); continue
      }
      const dimension = String(block.dimension || '')
      const dimensions = FRAMEWORK_DIMENSIONS[node.framework]
      if (dimension && dimensions && !dimensions.includes(dimension)) {
        issues.push(`${item.key} 混用了未选择的方法维度`); continue
      }
      const proposedId = String(block.id || '')
      const blockId = proposedId.startsWith(item.key + '-') && /^\d+$/u.test(proposedId.slice(item.key.length + 1))
        ? proposedId : `${item.key}-${index + 1}`
      if (ids.has(blockId)) { issues.push(`${item.key} 段落 ID 重复`); continue }
      const planRefs = {}
      for (const [field, collection] of Object.entries({ capabilityIds: 'capabilities', scenarioIds: 'scenarios', problemIds: 'problems', trendIds: 'trends' })) {
        const validIds = new Set((plan[collection] || []).map(entry => entry.id))
        planRefs[field] = [...new Set((Array.isArray(block.planRefs?.[field]) ? block.planRefs[field] : []).filter(id => validIds.has(id)))]
      }
      const boundary = PANORAMA_ROLES.includes(node.roleId) ? capabilityBoundary(block, planRefs, plan, candidate) : null
      if (boundary?.error) { issues.push(`${item.key}：${boundary.error}`); continue }
      if (boundary?.mixed) reviewItems.push(`${item.key} 同段涉及不同能力状态或归属，整体标签保留未知，请逐项核对正文边界`)
      ids.add(blockId)
      const body = boundary?.text || text
      blocks.push({ id: blockId, ...(dimension ? { dimension } : {}), planRefs,
        ...(boundary ? { capabilityStatus: boundary.capabilityStatus, capabilityOwnership: boundary.capabilityOwnership } : {}),
        text: candidate && !body.includes('【待确认') ? `【待确认·典型场景假设】${body}` : body,
        supportMode: candidate ? 'candidate' : 'sourced', evidence: checked })
    }
    if (blocks.length) sections.push({ key: item.key, title: node.title, roleId: node.roleId, ...(node.mode ? { mode: node.mode } : {}), ...(node.framework ? { framework: node.framework } : {}), blocks })
  }
  if (!sections.length) throw new Error(`模型没有生成有据正文：${issues.join('；')}`)
  const blockIds = new Set(sections.flatMap(section => section.blocks.map(block => block.id)))
  const assemblyLinks = []
  for (const link of Array.isArray(draft?.assemblyLinks) ? draft.assemblyLinks : []) {
    if (!link || typeof link !== 'object') { reviewItems.push('有一条组稿关系格式不正确，已略过该关系'); continue }
    const source = sources.get(String(link.capabilityEvidenceId ?? ''))
    const quote = String(link.capabilityQuote ?? '').trim()
    const scenarioBlockId = String(link.scenarioBlockId ?? '')
    const challengeBlockId = String(link.challengeBlockId ?? '')
    const trendBlockId = String(link.trendBlockId ?? '')
    if (!source || quote.length < 6 || !source.content.includes(quote) || !blockIds.has(scenarioBlockId) ||
      (challengeBlockId && !blockIds.has(challengeBlockId)) || (trendBlockId && !blockIds.has(trendBlockId))) {
      reviewItems.push('有一条组稿关系无法定位到证据或正文，已略过该关系')
      continue
    }
    assemblyLinks.push({ capabilityEvidenceId: source.id, capabilityQuote: quote,
      scenarioBlockId, ...(challengeBlockId ? { challengeBlockId } : {}),
      ...(trendBlockId ? { trendBlockId } : {}), relationReason: String(link.relationReason ?? '').slice(0, 300),
      status: 'proposed' })
  }
  if (!assemblyLinks.length) reviewItems.push('产品能力、场景、问题和趋势的对应关系尚待人工核对')
  if (sections.some(section => section.blocks.some(block => block.supportMode === 'candidate'))) {
    reviewItems.push('正文含待确认的典型场景假设，请核对后再作为客户事实使用')
  }
  return { sections, issues, assemblyLinks, reviewItems: [...new Set(reviewItems)] }
}

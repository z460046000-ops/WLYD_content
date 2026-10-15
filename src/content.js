import { flattenOutline, FRAMEWORK_DIMENSIONS } from './rules.js'

export function reportText(report) {
  const byKey = new Map(report.sections.map(section => [section.key, section]))
  const lines = [`# ${report.title}`, '']
  const hasContent = node => byKey.has(node.key) || (node.children || []).some(hasContent)
  const visit = (nodes, depth) => {
    for (const node of nodes) {
      if (!hasContent(node)) continue
      lines.push(`${'#'.repeat(depth)} ${node.title}`, '')
      const section = byKey.get(node.key)
      if (section?.framework && FRAMEWORK_DIMENSIONS[section.framework]) {
        lines.push(`分析框架：${section.framework === 'pest' ? 'PEST' : '管理、业务、技术'}`, '')
      }
      for (const block of section?.blocks || []) {
        lines.push(block.text, '')
        if (block.evidence.length) lines.push(`依据：${[...new Set(block.evidence.map(ref => `[${ref.id}]`))].join('、')}`, '')
      }
      visit(node.children || [], depth + 1)
    }
  }
  visit(report.outline, 2)
  if (report.reviewItems.length) lines.push('## 待核对的组稿关系与内容', '', ...report.reviewItems.map(item => `- ${item}`), '')
  if (report.validationIssues?.length) lines.push('## 生成时过滤或修正的内容', '', ...report.validationIssues.map(item => `- ${item}`), '')
  if (report.gaps.length) lines.push('## 待补充或人工确认', '', ...report.gaps.map(item => `- ${item}`), '')
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
      if (candidate && /(?:本产品|我司|客户)(?:已|现已|已经)|已实现|已上线|已交付|已获得|保证|承诺/iu.test(text)) {
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
      ids.add(blockId)
      const planRefs = {}
      for (const [field, collection] of Object.entries({ capabilityIds: 'capabilities', scenarioIds: 'scenarios', problemIds: 'problems', trendIds: 'trends' })) {
        const validIds = new Set((plan[collection] || []).map(entry => entry.id))
        planRefs[field] = [...new Set((Array.isArray(block.planRefs?.[field]) ? block.planRefs[field] : []).filter(id => validIds.has(id)))]
      }
      blocks.push({ id: blockId, ...(dimension ? { dimension } : {}), planRefs,
        text: candidate && !text.startsWith('【待确认') ? `【待确认·典型场景假设】${text}` : text,
        supportMode: candidate ? 'candidate' : 'sourced', evidence: checked })
    }
    if (blocks.length) sections.push({ key: item.key, title: node.title, roleId: node.roleId, ...(node.mode ? { mode: node.mode } : {}), ...(node.framework ? { framework: node.framework } : {}), blocks })
  }
  if (!sections.length) throw new Error(`模型没有生成有据正文：${issues.join('；')}`)
  const blockIds = new Set(sections.flatMap(section => section.blocks.map(block => block.id)))
  const assemblyLinks = []
  const reviewItems = []
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


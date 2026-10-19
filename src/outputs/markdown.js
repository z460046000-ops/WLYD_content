import { displayBlockText } from './display.js'

const list = value => Array.isArray(value) ? value : []
const text = value => value === undefined || value === null ? '' : String(value)
const unique = values => [...new Set(values.filter(Boolean))]
const headingText = value => text(value).replace(/[\r\n]+/gu, ' ').trim()
const escaped = value => text(value).replace(/([\\`*_{}\[\]<>])/gu, '\\$1')

const chapterLabels = {
  completed: '正文已生成', partial: '部分正文，仍待补充', draft_unverified: '待审初稿',
  needs_input: '待补材料', pending: '尚未生成', failed: '生成未完成', cancelled: '生成已停止', omitted: '已省略的可选章节'
}
const stateLabels = { existing: '已具备', pilot: '试点中', planned: '规划中', proposed: '建议方案', unknown: '待确认' }
const ownerLabels = { self: '自有能力', 'third-party': '第三方能力', customer: '客户已有能力', unknown: '归属待确认' }

function blockLabels(block) {
  return unique([
    block.supportMode === 'candidate' ? '候选方案' : '',
    block.verification === 'unverified' ? '未验证' : '',
    block.capabilityStatus && `能力状态：${stateLabels[block.capabilityStatus] || text(block.capabilityStatus)}`,
    block.capabilityOwnership && `能力归属：${ownerLabels[block.capabilityOwnership] || text(block.capabilityOwnership)}`,
    list(block.reviewItems).length ? '本段有待审事项' : ''
  ])
}

/** Full prose stays in the body; provenance and review details share one appendix in MD/DOCX. */
export function documentView(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== 1 || !text(snapshot.title).trim() || !Array.isArray(snapshot.outline) || !Array.isArray(snapshot.sections)) {
    throw new Error('输出需要 schemaVersion=1 的完整文案快照')
  }
  const byKey = new Map()
  for (const section of snapshot.sections) {
    if (!section?.key || byKey.has(section.key)) throw new Error('文案快照含无效或重复章节')
    byKey.set(section.key, section)
  }
  const seen = new Set(), sections = [], sources = [], sourceIndices = new Map()
  const metadata = new Map(list(snapshot.sources || snapshot.evidence).map(source => [text(source.id), source]))
  const sourceIndex = ref => {
    if (!ref || !text(ref.id).trim()) throw new Error('文案快照含无效来源引用')
    const id = text(ref.id), quote = text(ref.quote), key = JSON.stringify([id, quote])
    if (!sourceIndices.has(key)) {
      const original = metadata.get(id) || {}
      const index = sources.length + 1
      sources.push({ index, id, quote, title: text(original.title || original.source || original.name),
        locator: text(original.locator), url: text(original.url) })
      sourceIndices.set(key, index)
    }
    return sourceIndices.get(key)
  }
  const visit = (nodes, depth) => {
    for (const node of nodes) {
      if (!node?.key || seen.has(node.key)) throw new Error('文案快照目录含无效或重复章节')
      seen.add(node.key)
      const section = byKey.get(node.key) || { key: node.key, title: node.title, status: 'pending', blocks: [] }
      const blocks = list(section.blocks).map((block, index) => {
        if (!block || typeof block.text !== 'string') throw new Error(`章节 ${node.key} 含无效正文段落`)
        return { ...block, id: block.id || `${node.key}-${index + 1}`, position: index + 1,
          displayText: displayBlockText(block), labels: blockLabels(block), sourceIndices: unique(list(block.evidence).map(sourceIndex)) }
      })
      const hasBody = blocks.some(block => block.text.trim())
      const status = section.status || (hasBody ? 'draft_unverified' : section.inputNeeded ? 'needs_input' : 'pending')
      const approved = section.approvalStatus === 'approved'
      sections.push({ key: node.key, title: headingText(node.title || section.title || node.key), depth,
        status, statusLabel: chapterLabels[status] || `章节状态：${status}`, version: section.version,
        approvalLabel: approved ? '用户已确认' : '待用户确认', blocks,
        inputNeeded: section.inputNeeded || null, inputLabel: section.inputNeeded?.kind === 'generation_error' || status === 'failed' ? '生成故障' : '待补材料', hasBody })
      visit(list(node.children), depth + 1)
    }
  }
  visit(snapshot.outline, 1)
  for (const key of byKey.keys()) if (!seen.has(key)) throw new Error(`文案快照含目录外章节：${key}`)
  const bodyCount = sections.filter(section => section.hasBody).length
  const materialCount = sections.filter(section => !section.hasBody && section.inputLabel !== '生成故障' && (section.inputNeeded || section.status === 'needs_input')).length
  const failureCount = sections.filter(section => !section.hasBody && section.inputLabel === '生成故障').length
  const pendingCount = sections.filter(section => !section.hasBody && !section.inputNeeded && section.status !== 'omitted' && section.status !== 'failed').length
  const review = snapshot.assemblyReview || {}
  const reviewLabel = ['pending', 'running'].includes(review.status) ? '关联复核尚未完成'
    : review.passed === true ? '关联复核已完成，仍需用户确认业务内容'
      : review.status === 'cancelled' ? '关联复核已停止'
        : review.status === 'failed' ? '关联复核未完成'
          : review.passed === false ? '关联复核存在待处理事项' : '关联复核状态待确认'
  return { title: headingText(snapshot.title), sections, sources, sourceContentSha256: text(snapshot.sourceContentSha256),
    assemblyReview: structuredClone(review),
    notes: [`正文覆盖：${bodyCount}/${sections.length} 章；待补材料：${materialCount} 章；生成故障：${failureCount} 章；其他未生成：${pendingCount} 章。`,
      reviewLabel + '。', '来源、段落对应关系与审核记录列于本附录；材料卡不代表已完成正文。'] }
}

export function renderMarkdown(snapshot) {
  const view = documentView(snapshot)
  const lines = [`# ${escaped(view.title)}`, '']
  for (const section of view.sections) {
    lines.push(`${'#'.repeat(Math.min(section.depth + 1, 6))} ${escaped(section.title)}`, '')
    if (section.inputNeeded) {
      lines.push(`**${section.inputLabel}**：${text(section.inputNeeded.reason) || '尚缺本章资料'}`, '')
      for (const question of list(section.inputNeeded.questions)) lines.push(`- ${text(question)}`)
      if (list(section.inputNeeded.questions).length) lines.push('')
      if (section.inputNeeded.nextAction) lines.push(text(section.inputNeeded.nextAction), '')
    }
    if (!section.hasBody && !section.inputNeeded) lines.push(`${section.statusLabel}。`, '')
    for (const block of section.blocks) if (block.displayText) lines.push(block.displayText, '')
  }
  lines.push('## 来源与审核附录', '', ...view.notes.flatMap(note => [note, '']))
  if (view.sourceContentSha256) lines.push(`文案版本指纹：${escaped(view.sourceContentSha256)}`, '')
  if (Object.keys(view.assemblyReview).length) lines.push(`关联复核记录：${escaped(JSON.stringify(view.assemblyReview))}`, '')
  lines.push('### 章节与段落记录', '')
  for (const section of view.sections) {
    lines.push(`#### ${escaped(section.title)}`, '', `${section.statusLabel}；${section.approvalLabel}${section.version === undefined ? '' : `；章节版本 ${section.version}`}。`, '')
    for (const block of section.blocks) {
      lines.push(`段落 ${escaped(block.id)}（第 ${block.position} 段）`, '')
      if (block.sourceIndices.length) lines.push(`来源：${block.sourceIndices.map(index => `来源 ${index}`).join('、')}`, '')
      if (block.labels.length) lines.push(`审核信息：${block.labels.join('；')}。`, '')
      for (const [label, values] of [['复核记录', block.reviewItems], ['引用提醒', block.referenceWarnings]]) {
        for (const value of list(values)) lines.push(`${label}：${escaped(typeof value === 'string' ? value : JSON.stringify(value))}`, '')
      }
    }
  }
  if (view.sources.length) {
    lines.push('### 来源记录', '')
    for (const source of view.sources) {
      lines.push(`#### 来源 ${source.index}`, '', `原始来源 ID：${escaped(source.id)}`, '')
      if (source.title) lines.push(`资料：${escaped(source.title)}`, '')
      if (source.locator) lines.push(`位置：${escaped(source.locator)}`, '')
      if (source.url) lines.push(`链接：${escaped(source.url)}`, '')
      if (source.quote) lines.push('原文摘录：', '', ...source.quote.split(/\r?\n/u).map(line => `> ${line}`), '')
    }
  }
  return lines.join('\n').replace(/\n*$/u, '\n')
}

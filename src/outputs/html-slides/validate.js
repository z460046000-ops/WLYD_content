import { createHash } from 'node:crypto'
import { cleanDisplayText, displayIdentity } from '../display.js'
import { presentationCaveats, validateSummaryText } from './summary-policy.js'

const list = value => Array.isArray(value) ? value : []
const strings = value => list(value).filter(item => typeof item === 'string')
const sourceKey = (sectionKey, id) => `${sectionKey}\0${id}`
const unique = values => [...new Set(values)]
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value
const equals = (first, second) => JSON.stringify(stable(first)) === JSON.stringify(stable(second))
const conditions = value => typeof value === 'string' ? [value] : strings(value)
const length = value => [...String(value || '')].length

/** Clean only display artifacts. Raw paragraphs and all provenance stay in presentationSource. */
export function presentationUnits(section, block, blockIndex) {
  const body = cleanDisplayText(typeof block.text === 'string' ? block.text : '').trim()
  const id = typeof block.id === 'string' && block.id ? block.id : `${section.key}-${blockIndex + 1}`
  const sentences = body.match(/[^。！？\n]+[。！？]?|[。！？]/gu) || []
  let position = 0
  return sentences.flatMap(sentence => {
    const original = sentence.trim()
    if (!original) return []
    const chars = [...original], result = []
    // Balance long sentences rather than creating a final one-character punctuation card.
    const chunks = Math.ceil(chars.length / 180), size = Math.ceil(chars.length / chunks)
    for (let start = 0; start < chars.length; start += size) {
      const value = chars.slice(start, start + size).join('')
      const key = `${section.key}\0${id}\0${position++}\0${value}`
      result.push({ id: `u-${createHash('sha256').update(key).digest('hex').slice(0, 20)}`,
        text: value, sourceBlockId: id, sectionKey: section.key, continuation: chunks > 1 })
    }
    return result
  })
}

export function presentationBatches(units) {
  const batches = []; let current = [], size = 0
  for (const unit of units) {
    if (current.length && size + unit.text.length > 6000) { batches.push(current); current = []; size = 0 }
    current.push(unit); size += unit.text.length
  }
  if (current.length) batches.push(current)
  return batches
}

export function presentationSource(section, block, blockIndex) {
  const identity = displayIdentity(block)
  const boundaries = []
  if (section.approvalStatus !== 'approved') boundaries.push('待用户确认')
  if (identity.candidate) boundaries.push('候选方案')
  if (identity.unverified) boundaries.push('来源待核验')
  const status = { pilot: '试点中', planned: '规划中', proposed: '建议方案', unknown: '能力状态待确认' }[block.capabilityStatus]
  const owner = { 'third-party': '第三方能力', customer: '客户已有能力', unknown: '能力归属待确认' }[block.capabilityOwnership]
  if (status) boundaries.push(status)
  if (owner) boundaries.push(owner)
  return { sectionKey: section.key, sectionTitle: section.title,
    id: typeof block.id === 'string' && block.id ? block.id : `${section.key}-${blockIndex + 1}`, text: block.text,
    evidence: structuredClone(list(block.evidence)), planRefs: structuredClone(block.planRefs || {}), boundaries: unique(boundaries),
    conditions: unique([...conditions(block.conditions), ...conditions(block.limitations)]),
    capabilityStatus: block.capabilityStatus, capabilityOwnership: block.capabilityOwnership,
    supportMode: identity.candidate ? 'candidate' : block.supportMode,
    verification: identity.unverified ? 'unverified' : block.verification,
    isHypothesis: Boolean(block.isHypothesis),
    chapterVersion: section.version, approvalStatus: section.approvalStatus }
}

/** Provenance, explicit restrictions and obvious new claims are checked; rewriting semantics still need review. */
function inspectPresentation(plan, snapshot, { scope } = {}) {
  const issues = []
  if (plan?.schema !== 2) issues.push('旧版演示计划须重新概括，不能复用')
  if (plan?.semanticStatus !== 'draft_unverified') issues.push('概括的待审身份缺失或被提升')
  if (plan?.sourceContentSha256 !== snapshot?.sourceContentSha256) issues.push('源文案指纹不一致')
  if (plan?.title !== (snapshot?.title || '解决方案') || plan?.runId !== snapshot?.runId) issues.push('源文案标题或运行编号不一致')
  const expectedVersions = list(snapshot?.sections).map(section => ({ key: section.key, version: section.version, approvalStatus: section.approvalStatus }))
  if (!equals(plan?.sourceVersions, expectedVersions)) issues.push('源章节版本或确认状态不一致')
  if (!equals(plan?.assemblyReview, snapshot?.assemblyReview || { status: 'pending', passed: false })) issues.push('关联复核状态不一致')
  const sections = new Map(list(snapshot?.sections).map(section => [section.key, section]))
  const expectedSources = new Map(), expectedBatches = new Map()
  for (const section of sections.values()) {
    const units = []
    for (const [index, block] of list(section.blocks).entries()) if (typeof block.text === 'string' && block.text.trim()) {
      const source = presentationSource(section, block, index)
      expectedSources.set(sourceKey(section.key, source.id), source)
      units.push(...presentationUnits(section, block, index))
    }
    presentationBatches(units).forEach((batch, index) => expectedBatches.set(sourceKey(section.key, index + 1), batch))
  }
  const archived = new Map(list(plan?.sources).map(source => [sourceKey(source.sectionKey, source.id), source]))
  if (archived.size !== expectedSources.size || archived.size !== list(plan?.sources).length) issues.push('原文来源记录缺失或重复')
  for (const [key, expected] of expectedSources) if (!equals(archived.get(key), expected)) issues.push('原文来源元数据或审核身份被改写')
  const selectedScope = key => !scope || key === sourceKey(scope.sectionKey, scope.batch)
  const rows = list(plan?.batches), batchRows = new Map(rows.map(row => [sourceKey(row.sectionKey, row.batch), row]))
  if (batchRows.size !== rows.length || rows.some(row => !expectedBatches.has(sourceKey(row.sectionKey, row.batch)))) issues.push('演示批次缺失、未知或重复')
  for (const [key, units] of expectedBatches) if (selectedScope(key)) {
    const row = batchRows.get(key)
    if (!row || !equals(row.sourceUnitIds, units.map(unit => unit.id))) issues.push('演示输入批次不完整或被改写')
  }
  const seen = new Set(), pageBatches = new Map(), visibleSections = new Set()
  for (const slide of list(plan?.slides)) {
    if (!slide?.id || seen.has(slide.id)) issues.push('页面ID缺失或重复')
    seen.add(slide?.id)
    const section = sections.get(slide?.sectionKey)
    if (!section) { issues.push('页面引用未知章节'); continue }
    visibleSections.add(section.key)
    if (slide.sectionTitle !== section.title) issues.push('页面章节标题与原文不一致')
    if (slide.kind === 'material-card') {
      if (list(section.blocks).some(block => cleanDisplayText(block.text || '').trim())) issues.push('有正文的章节不能替换为材料卡')
      const label = section.status === 'failed' ? '生成故障' : '待补材料'
      if (slide.status !== section.status || !list(slide.boundaries).includes(label)) issues.push('故障或缺料标记不一致')
      if (slide.reason !== (section.inputNeeded?.reason || '本章暂无正文，待补充或重新生成')) issues.push('材料卡原因被改写')
      continue
    }
    const key = sourceKey(section.key, slide.batch), units = expectedBatches.get(key) || []
    if (!units.length || !batchRows.has(key)) issues.push('页面引用未知输入批次')
    if (!pageBatches.has(key)) pageBatches.set(key, [])
    pageBatches.get(key).push(slide)
    const isSummary = slide.mode === 'summary'
    if (!['summary', 'source-pagination'].includes(slide.mode)) issues.push('未知演示模式')
    if (slide.kind !== 'content' || !list(slide.points).length || list(slide.points).length > 3) issues.push('页面必须有一至三个要点')
    if (list(slide.points).reduce((sum, point) => sum + length(point.text), 0) > (isSummary ? 200 : 300)) issues.push('页面文案过多')
    if (!slide.title || isSummary && length(slide.title) > 36 || !isSummary && slide.title !== section.title) issues.push('页面标题无效')
    const pointSources = unique(list(slide.points).flatMap(point => strings(point.sourceBlockIds)))
    if (!equals(slide.sourceBlockIds, pointSources)) issues.push('页面来源与要点来源不一致')
    const selectedSources = pointSources.map(id => expectedSources.get(sourceKey(section.key, id))).filter(Boolean)
    const expectedRefs = {}
    for (const source of selectedSources) for (const [field, ids] of Object.entries(source.planRefs)) {
      if (Array.isArray(ids)) expectedRefs[field] = unique([...(expectedRefs[field] || []), ...strings(ids)])
    }
    if (!equals(slide.planRefs, expectedRefs)) issues.push('主线关联丢失或引入未知关联')
    if (!equals(slide.boundaries, unique(selectedSources.flatMap(source => source.boundaries)))) issues.push('能力与审核身份被改写')
    if (!equals(slide.sourceConditions, unique(selectedSources.flatMap(source => source.conditions)))) issues.push('适用条件丢失或被改写')
    if (!equals(slide.caveats, unique(selectedSources.flatMap(presentationCaveats)))) issues.push('实质条件或能力限定丢失')
    if (isSummary) issues.push(...validateSummaryText(slide.title, selectedSources))
    const pointTexts = new Set()
    for (const point of list(slide.points)) {
      const refs = strings(point.sourceBlockIds), known = new Set(units.map(unit => unit.sourceBlockId))
      if (!refs.length || refs.length !== list(point.sourceBlockIds).length || new Set(refs).size !== refs.length || refs.some(id => !known.has(id))) issues.push('要点缺少有效的本章本批来源')
      if (!point.text || cleanDisplayText(point.text) !== point.text || isSummary && pointTexts.has(point.text)) issues.push('要点为空、重复或含机械标签')
      pointTexts.add(point.text)
      if (isSummary) {
        if (length(point.text) > 90) issues.push('要点未精简为短句')
        issues.push(...validateSummaryText(point.text, refs.map(id => expectedSources.get(sourceKey(section.key, id))).filter(Boolean)))
      } else {
        if (refs.length !== 1 || !equals(point.unitIds, units.filter(unit => unit.sourceBlockId === refs[0] && unit.text === point.text && unit.continuation === point.continuation).map(unit => unit.id).filter(id => list(point.unitIds).includes(id)))
          || list(point.unitIds).length !== 1) issues.push('原文分页要点不是完整原文句段')
      }
    }
  }
  for (const [key, units] of expectedBatches) if (selectedScope(key)) {
    const pages = pageBatches.get(key) || [], row = batchRows.get(key)
    if (!pages.length || row?.pages !== pages.length || pages.some(page => page.mode !== row?.mode)) issues.push('演示页面或模式与批次记录不一致')
    if (row?.mode === 'source-pagination') {
      const ids = pages.flatMap(page => list(page.points).flatMap(point => list(point.unitIds)))
      if (!equals(ids, units.map(unit => unit.id))) issues.push('原文分页遗漏或改乱句段')
    }
  }
  if (!scope) for (const section of sections.values()) if (!visibleSections.has(section.key)) issues.push('章节未映射到演示')
  if (!list(plan?.slides).length) issues.push('没有演示页面')
  return [...new Set(issues)]
}

export function validatePresentation(plan, snapshot, options) {
  try { return inspectPresentation(plan, snapshot, options) }
  catch { return ['演示计划结构无效，请重新生成输出'] }
}

/** Quick structural checks complement browser layout checks; they do not claim visual acceptance. */
export function validatePresentationHtml(html) {
  const issues = []
  for (const token of ['id="stage"', 'id="presentation-prev"', 'id="presentation-next"', 'id="presentation-fullscreen"',
    'id="deck-num"', 'id="deck-progress"', 'MS.deck(', 'ArrowRight', 'ArrowLeft']) {
    if (!html.includes(token)) issues.push(`缺少演示结构：${token}`)
  }
  if (/<(?:script|link)\b[^>]*(?:src|href)\s*=\s*["'](?:https?:)?\/\//iu.test(html)) issues.push('HTML 依赖远程脚本或样式')
  return issues
}

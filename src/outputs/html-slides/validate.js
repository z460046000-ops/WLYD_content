import { createHash } from 'node:crypto'

const list = value => Array.isArray(value) ? value : []
const strings = value => list(value).filter(item => typeof item === 'string')
const sourceKey = (sectionKey, id) => `${sectionKey}\0${id}`
const unique = values => [...new Set(values)]
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value
const equals = (first, second) => JSON.stringify(stable(first)) === JSON.stringify(stable(second))
const conditions = value => typeof value === 'string' ? [value] : strings(value)
const PROTECTED = /不|未|待|仅|只|若|如|条件|前提|依赖|需要|须|试点|规划|拟|计划|建议|候选|第三方|客户已有/u

/** The source adapter is shared by planning and cache validation, including negative/conditional prose. */
export function presentationUnits(section, block, blockIndex) {
  const body = typeof block.text === 'string' ? block.text.trim() : ''
  const id = typeof block.id === 'string' && block.id ? block.id : `${section.key}-${blockIndex + 1}`
  const sentences = body.match(/[^。！？\n]+[。！？]?|[。！？]/gu) || []
  let position = 0
  return sentences.flatMap(sentence => {
    const original = sentence.trim()
    if (!original) return []
    const codepoints = [...original], result = []
    for (let start = 0; start < codepoints.length; start += 180) {
      const value = codepoints.slice(start, start + 180).join('')
      const key = `${section.key}\0${id}\0${position++}\0${value}`
      result.push({ id: `u-${createHash('sha256').update(key).digest('hex').slice(0, 20)}`,
        text: value, sourceBlockId: id, sectionKey: section.key,
        continuation: codepoints.length > 180, protected: PROTECTED.test(original) || codepoints.length > 180 })
    }
    return result
  })
}

export function presentationSource(section, block, blockIndex) {
  const boundaries = []
  if (section.approvalStatus !== 'approved') boundaries.push('待用户确认')
  if (block.supportMode === 'candidate' || block.verification === 'candidate') boundaries.push('候选方案')
  if (block.verification === 'unverified') boundaries.push('来源待核验')
  const status = { pilot: '试点中', planned: '规划中', proposed: '建议方案', unknown: '能力状态待确认' }[block.capabilityStatus]
  const owner = { 'third-party': '第三方能力', customer: '客户已有能力', unknown: '能力归属待确认' }[block.capabilityOwnership]
  if (status) boundaries.push(status)
  if (owner) boundaries.push(owner)
  return { sectionKey: section.key, sectionTitle: section.title,
    id: typeof block.id === 'string' && block.id ? block.id : `${section.key}-${blockIndex + 1}`, text: block.text,
    evidence: structuredClone(list(block.evidence)), planRefs: structuredClone(block.planRefs || {}), boundaries: unique(boundaries),
    conditions: unique([...conditions(block.conditions), ...conditions(block.limitations)]),
    capabilityStatus: block.capabilityStatus, capabilityOwnership: block.capabilityOwnership,
    supportMode: block.supportMode, verification: block.verification,
    chapterVersion: section.version, approvalStatus: section.approvalStatus }
}

/** The output may select and paginate source prose; it cannot supply new prose or downgrade its labels. */
export function validatePresentation(plan, snapshot) {
  const issues = []
  if (plan?.sourceContentSha256 !== snapshot?.sourceContentSha256) issues.push('源文案指纹不一致')
  if (plan?.title !== (snapshot?.title || '解决方案') || plan?.runId !== snapshot?.runId) issues.push('源文案标题或运行编号不一致')
  const expectedVersions = list(snapshot?.sections).map(section => ({ key: section.key, version: section.version, approvalStatus: section.approvalStatus }))
  if (!equals(plan?.sourceVersions, expectedVersions)) issues.push('源章节版本或确认状态不一致')
  if (!equals(plan?.assemblyReview, snapshot?.assemblyReview || { status: 'pending', passed: false })) issues.push('关联复核状态不一致')
  const sections = new Map(list(snapshot?.sections).map(section => [section.key, section]))
  const originals = new Map(list(snapshot?.sections).flatMap(section => list(section.blocks).map((block, index) => [
    sourceKey(section.key, block.id || `${section.key}-${index + 1}`), block,
  ])))
  const archived = new Map(list(plan?.sources).map(source => [sourceKey(source.sectionKey, source.id), source]))
  const expectedSources = new Map(list(snapshot?.sections).flatMap(section => list(section.blocks).flatMap((block, index) =>
    typeof block.text === 'string' && block.text.trim() ? [[sourceKey(section.key, block.id || `${section.key}-${index + 1}`), presentationSource(section, block, index)]] : [])))
  if (archived.size !== expectedSources.size || archived.size !== list(plan?.sources).length) issues.push('原文来源记录缺失或重复')
  for (const [key, expected] of expectedSources) {
    const actual = archived.get(key)
    if (!actual || !equals(Object.fromEntries(Object.keys(expected).map(field => [field, actual[field]])), expected)) issues.push('原文来源元数据或审核身份被改写')
  }
  const expectedUnits = new Map(list(snapshot?.sections).flatMap(section => list(section.blocks).map((block, index) =>
    [sourceKey(section.key, block.id || `${section.key}-${index + 1}`), presentationUnits(section, block, index)])))
  const covered = new Set(), selectedUnitTexts = new Map(), seen = new Set()
  for (const slide of list(plan?.slides)) {
    if (!slide?.id || seen.has(slide.id)) issues.push('页面 ID 缺失或重复')
    seen.add(slide?.id)
    const section = sections.get(slide?.sectionKey)
    if (!section) { issues.push('页面引用未知章节'); continue }
    if (slide.sectionTitle !== section.title) issues.push('页面章节标题与原文不一致')
    if (slide.kind === 'material-card') {
      if (list(section.blocks).some(block => String(block.text || '').trim())) issues.push('有正文的章节不能替换为材料卡')
      const label = section.status === 'failed' ? '生成故障' : '待补材料'
      if (slide.status !== section.status || !list(slide.boundaries).includes(label)) issues.push('无正文页的故障或缺料标记不一致')
      if (slide.reason !== (section.inputNeeded?.reason || '本章暂无正文，待补充或重新生成')) issues.push('材料卡原因被改写')
      continue
    }
    if (slide.kind !== 'content' || !list(slide.points).length || list(slide.points).length > 3) issues.push('正文页面必须有一至三个要点')
    if (list(slide.points).reduce((sum, point) => sum + [...String(point.text || '')].length, 0) > 300) issues.push('页面文案过多，需要拆页')
    const sourceIds = new Set(strings(slide.sourceBlockIds))
    const pointSources = unique(list(slide.points).flatMap(point => strings(point.sourceBlockIds)))
    if (pointSources.length !== sourceIds.size || pointSources.some(id => !sourceIds.has(id))) issues.push('页面来源与要点来源不一致')
    const selectedSources = [...sourceIds].map(id => expectedSources.get(sourceKey(slide.sectionKey, id))).filter(Boolean)
    const expectedRefs = {}
    for (const source of selectedSources) for (const [field, ids] of Object.entries(source.planRefs)) {
      if (Array.isArray(ids)) expectedRefs[field] = unique([...(expectedRefs[field] || []), ...strings(ids)])
    }
    if (!equals(slide.planRefs, expectedRefs)) issues.push('主线关联丢失或引入未知关联')
    if (!equals(slide.sourceConditions, unique(selectedSources.flatMap(source => source.conditions)))) issues.push('适用条件丢失或被改写')
    if (!equals(slide.boundaries, unique(selectedSources.flatMap(source => source.boundaries)))) issues.push('能力与审核标记被改写')
    for (const id of sourceIds) {
      const key = sourceKey(slide.sectionKey, id), original = originals.get(key), source = archived.get(key)
      if (!original || !source || source.text !== original.text) { issues.push('页面源段缺失或被改写'); continue }
      covered.add(key)
      if (section.approvalStatus !== 'approved' && !list(slide.boundaries).includes('待用户确认')) issues.push('丢失待用户确认标记')
      if ((original.supportMode === 'candidate' || original.verification === 'candidate') && !list(slide.boundaries).includes('候选方案')) issues.push('丢失候选方案标记')
      if (original.verification === 'unverified' && !list(slide.boundaries).includes('来源待核验')) issues.push('丢失未核验标记')
      const expected = {
        pilot: '试点中', planned: '规划中', proposed: '建议方案', unknown: '能力状态待确认',
      }[original.capabilityStatus]
      if (expected && !list(slide.boundaries).includes(expected)) issues.push('能力状态被提升或丢失')
      const owner = { 'third-party': '第三方能力', customer: '客户已有能力', unknown: '能力归属待确认' }[original.capabilityOwnership]
      if (owner && !list(slide.boundaries).includes(owner)) issues.push('能力归属被改写或丢失')
      for (const [field, ids] of Object.entries(original.planRefs || {})) {
        if (strings(ids).some(id => !strings(slide.planRefs?.[field]).includes(id))) issues.push('主线关联丢失')
      }
    }
    for (const point of list(slide.points)) {
      const refs = strings(point.sourceBlockIds)
      if (refs.length !== 1 || !point.text || !refs.every(id => sourceIds.has(id))) { issues.push('演示要点没有来源映射'); continue }
      const key = sourceKey(slide.sectionKey, refs[0]), units = expectedUnits.get(key) || []
      if (!units.some(unit => unit.text === point.text && !!point.continuation === unit.continuation)) issues.push('演示要点不是完整原文句段')
      if (!selectedUnitTexts.has(key)) selectedUnitTexts.set(key, new Set())
      selectedUnitTexts.get(key).add(point.text)
    }
    if (slide.title !== section.title && !list(slide.points).some(point => point.text === slide.title)) issues.push('页面标题引入新文案')
  }
  for (const [key, block] of originals) if (String(block.text || '').trim() && !covered.has(key)) issues.push('原文段落未映射到演示')
  for (const [key, units] of expectedUnits) if (units.some(unit => unit.protected && !selectedUnitTexts.get(key)?.has(unit.text))) issues.push('原文条件或能力边界被遗漏')
  if (!list(plan?.slides).length) issues.push('没有演示页面')
  return [...new Set(issues)]
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

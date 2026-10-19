import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { presentationSource, presentationUnits, presentationBatches, validatePresentation } from './validate.js'
import { presentationCaveats } from './summary-policy.js'
import { cleanDisplayText } from '../display.js'

const hash = value => createHash('sha256').update(value).digest('hex')
const list = value => Array.isArray(value) ? value : []
const text = value => typeof value === 'string' ? value : ''
const unique = values => [...new Set(values)]
const length = value => [...value].length

function prepare(snapshot) {
  const sources = [], sections = []
  for (const section of list(snapshot.sections)) {
    const units = []
    for (const [index, block] of list(section.blocks).entries()) {
      if (!text(block.text).trim()) continue
      sources.push(presentationSource(section, block, index))
      units.push(...presentationUnits(section, block, index))
    }
    sections.push({ key: section.key, roleId: section.roleId, title: text(section.title) || section.key,
      status: section.status, inputNeeded: structuredClone(section.inputNeeded || null), units })
  }
  return { sources, sections }
}

function mergeRefs(sources) {
  const result = {}
  for (const source of sources) for (const [key, ids] of Object.entries(source.planRefs || {})) {
    if (Array.isArray(ids)) result[key] = unique([...(result[key] || []), ...ids.filter(id => typeof id === 'string')])
  }
  return result
}

function pageFrom(points, title, section, sources, mode, batch) {
  const sourceBlockIds = unique(points.flatMap(point => point.sourceBlockIds))
  const selected = sources.filter(source => source.sectionKey === section.key && sourceBlockIds.includes(source.id))
  return { kind: 'content', sectionKey: section.key, sectionTitle: section.title, title, mode, batch,
    sourceBlockIds, points, planRefs: mergeRefs(selected), boundaries: unique(selected.flatMap(source => source.boundaries)),
    caveats: unique(selected.flatMap(presentationCaveats)), sourceConditions: unique(selected.flatMap(source => source.conditions)),
    ...(points.some(point => point.continuation) ? { continuation: true } : {}) }
}

function summaryPages(raw, units, section, sources, batch) {
  if (!raw || !Array.isArray(raw.slides) || !raw.slides.length) throw new Error('没有返回概括页面')
  const known = new Set(units.map(unit => unit.sourceBlockId)), seen = new Set()
  return raw.slides.map(slide => {
    if (!slide || Object.keys(slide).some(key => !['title', 'points'].includes(key))
      || typeof slide.title !== 'string' || !Array.isArray(slide.points) || !slide.points.length || slide.points.length > 3) throw new Error('页面须有短标题和一至三个带来源的要点')
    const points = slide.points.map(point => {
      if (!point || Object.keys(point).some(key => !['text', 'sourceBlockIds'].includes(key)) || typeof point.text !== 'string'
        || !Array.isArray(point.sourceBlockIds) || !point.sourceBlockIds.length
        || new Set(point.sourceBlockIds).size !== point.sourceBlockIds.length || point.sourceBlockIds.some(id => !known.has(id))) throw new Error('概括要点引用未知或重复的原文段落')
      const value = cleanDisplayText(point.text).trim()
      if (!value || length(value) > 90 || seen.has(value)) throw new Error('概括要点为空、过长或重复')
      seen.add(value)
      return { text: value, sourceBlockIds: [...point.sourceBlockIds] }
    })
    const title = cleanDisplayText(slide.title).replace(/[\r\n]+/gu, ' ').trim()
    if (!title || length(title) > 36 || points.reduce((n, point) => n + length(point.text), 0) > 200) throw new Error('概括标题或页面超过篇幅上限')
    return pageFrom(points, title, section, sources, 'summary', batch)
  })
}

function originalPages(units, section, sources, batch) {
  const groups = []
  for (const unit of units) {
    const prior = groups.at(-1)
    if (prior && prior.length < 3 && !unit.continuation && !prior.some(item => item.continuation)
      && prior.reduce((sum, item) => sum + length(item.text), 0) + length(unit.text) <= 300) prior.push(unit)
    else groups.push([unit])
  }
  return groups.map(group => pageFrom(group.map(unit => ({ text: unit.text, sourceBlockIds: [unit.sourceBlockId],
    unitIds: [unit.id], continuation: unit.continuation })), section.title, section, sources, 'source-pagination', batch))
}

function reduction(slides, units) {
  const inputCharacters = units.reduce((n, unit) => n + length(unit.text), 0)
  const outputCharacters = slides.reduce((n, slide) => {
    const body = [slide.title, ...slide.points.map(point => point.text)].join('\n')
    return n + length(slide.title) + slide.points.filter(point => point.text !== slide.title).reduce((sum, point) => sum + length(point.text), 0)
      + slide.caveats.filter(value => !body.includes(value)).reduce((sum, value) => sum + length(value), 0)
  }, 0)
  return { inputCharacters, outputCharacters, ratio: inputCharacters ? Number((outputCharacters / inputCharacters).toFixed(3)) : 0 }
}

async function skillResources() {
  const paths = ['SKILL.md', 'references/slides.md', 'references/aesthetics.md']
  const files = await Promise.all(paths.map(async path => ({ path,
    body: await readFile(new URL(`../../../vendor/xiaoma-studio/${path}`, import.meta.url), 'utf8') })))
  const upstream = JSON.parse(await readFile(new URL('../../../vendor/xiaoma-studio/UPSTREAM.json', import.meta.url), 'utf8'))
  return { commit: upstream.commit, hash: hash(files.map(file => `${file.path}\0${file.body}`).join('\0')),
    files: files.map(file => ({ path: file.path, sha256: hash(file.body) })),
    // Only output-relevant guidance enters the model; complete upstream files stay pinned and hashed.
    guidance: files.filter(file => file.path.startsWith('references/')).map(file => ({ path: file.path,
      text: file.path.endsWith('slides.md') ? file.body.split('## 幻灯片的审美规矩')[1]?.split('## 验收')[0]?.trim()
        : [file.body.split('**色彩**')[1]?.split('**字体**')[0],
          `编辑部数据叙事${file.body.split('### 2 编辑部数据叙事')[1]?.split('### 3 ')[0] || ''}`].filter(Boolean).join('\n').trim() })) }
}

/** One output-only summary per bounded batch. Source prose remains in documents and the source panel. */
export async function buildPresentation({ snapshot, request, signal } = {}) {
  if (!snapshot || !text(snapshot.sourceContentSha256)) throw new Error('演示需要带源版本指纹的文案快照')
  const prompt = await readFile(new URL('../../../prompts/outputs/presentation.md', import.meta.url), 'utf8')
  const skill = await skillResources(), { sources, sections } = prepare(snapshot)
  const slides = [], warnings = [], batches = []
  const base = () => ({ schema: 2, semanticStatus: 'draft_unverified', runId: snapshot.runId, title: text(snapshot.title) || '解决方案',
    sourceContentSha256: snapshot.sourceContentSha256,
    sourceVersions: list(snapshot.sections).map(section => ({ key: section.key, version: section.version, approvalStatus: section.approvalStatus })),
    assemblyReview: structuredClone(snapshot.assemblyReview || { status: 'pending', passed: false }), coverage: structuredClone(snapshot.coverage || {}),
    skill: { commit: skill.commit, hash: skill.hash, files: skill.files, promptSha256: hash(prompt) }, warnings, batches, sources })
  for (const section of sections) {
    if (signal?.aborted) throw signal.reason || new Error('演示生成已取消')
    if (!section.units.length) {
      slides.push({ kind: 'material-card', sectionKey: section.key, sectionTitle: section.title, status: section.status,
        title: section.title, reason: text(section.inputNeeded?.reason) || '本章暂无正文，待补充或重新生成',
        questions: list(section.inputNeeded?.questions).filter(value => typeof value === 'string'),
        boundaries: [section.status === 'failed' ? '生成故障' : '待补材料', '不属于已完成正文'], sourceBlockIds: [], planRefs: {} })
      continue
    }
    for (const [index, units] of presentationBatches(section.units).entries()) {
      if (signal?.aborted) throw signal.reason || new Error('演示生成已取消')
      const batch = index + 1, inputCharacters = units.reduce((n, unit) => n + length(unit.text), 0)
      const selectedSources = sources.filter(source => source.sectionKey === section.key && units.some(unit => unit.sourceBlockId === source.id))
      const targetCharacters = Math.max(90, Math.ceil(inputCharacters * 0.35)), targetPages = Math.max(1, Math.ceil(targetCharacters / 140))
      const record = { sectionKey: section.key, batch, inputCharacters, inputUnits: units.length,
        sourceUnitIds: units.map(unit => unit.id), targetCharacters, targetPages }
      let pages, reason
      if (request) {
        try {
          const raw = await request({ stage: 'presentation', qualityMode: 'draft', task: prompt,
            skill: { commit: skill.commit, hash: skill.hash, guidance: skill.guidance },
            chapter: { key: section.key, title: section.title, roleId: section.roleId },
            budget: { targetCharacters, targetPages, titleMaxCharacters: 36, pointMaxCharacters: 90, pageMaxCharacters: 200 },
            units: units.map(({ id, text, sourceBlockId }) => ({ id, text, sourceBlockId })),
            sourceHints: selectedSources.map(source => ({ sourceBlockId: source.id, caveats: presentationCaveats(source), planRefs: source.planRefs })),
            schema: { slides: [{ title: '概括后的短标题', points: [{ text: '提炼改写的短语或短句', sourceBlockIds: ['原文段落ID，可合并多个'] }] }] } })
          pages = summaryPages(raw, units, section, sources, batch)
          // Reuse the same validator for new output and cached output; no extra review model.
          const draft = { ...base(), slides: pages.map((page, i) => ({ ...page, id: `check-${i}` })), batches: [{ ...record, mode: 'summary', pages: pages.length }] }
          const issues = validatePresentation(draft, snapshot, { scope: { sectionKey: section.key, batch } })
          if (issues.length) throw new Error(issues.join('；'))
        } catch (error) {
          if (signal?.aborted) throw signal.reason || error
          reason = String(error.message || error); pages = null
        }
      } else reason = '未配置演示精简模型'
      if (!pages) {
        pages = originalPages(units, section, sources, batch)
        warnings.push(`${section.title} / 批次${batch}：未完成概括，已保留原文分页（${reason}）`)
      }
      const metrics = reduction(pages, units)
      if (!reason && inputCharacters >= 400 && metrics.ratio > 0.65) warnings.push(`${section.title} / 批次${batch}：概括减量不足，建议继续精简；未自动追加模型调用`)
      if (!reason && pages.length > targetPages) warnings.push(`${section.title} / 批次${batch}：页数超过软目标${targetPages}，保留现有结果供迭代`)
      slides.push(...pages)
      batches.push({ ...record, ...metrics, pages: pages.length, mode: reason ? 'source-pagination' : 'summary', ...(reason ? { fallbackReason: reason } : {}) })
    }
  }
  const used = new Set(slides.flatMap(slide => slide.sourceBlockIds.map(id => `${slide.sectionKey}\0${id}`)))
  const allRefs = {}, shownRefs = {}
  for (const source of sources) for (const [key, ids] of Object.entries(source.planRefs || {})) {
    allRefs[key] = unique([...(allRefs[key] || []), ...list(ids)])
    if (used.has(`${source.sectionKey}\0${source.id}`)) shownRefs[key] = unique([...(shownRefs[key] || []), ...list(ids)])
  }
  const omittedPlanRefs = Object.fromEntries(Object.entries(allRefs).map(([key, ids]) => [key, ids.filter(id => !list(shownRefs[key]).includes(id))]).filter(([, ids]) => ids.length))
  if (Object.keys(omittedPlanRefs).length) warnings.push('部分问题、场景或能力关联未进入演示要点；完整内容与关联保留在文档和来源记录，请审阅重点覆盖')
  const contentSlides = slides.filter(slide => slide.kind === 'content')
  const plan = { ...base(), slides: slides.map((slide, index) => ({ ...slide, id: `slide-${index + 1}` })),
    summaryMetrics: { inputCharacters: batches.reduce((n, row) => n + row.inputCharacters, 0),
      outputCharacters: batches.reduce((n, row) => n + row.outputCharacters, 0),
      summaryPages: contentSlides.filter(slide => slide.mode === 'summary').length,
      originalPages: contentSlides.filter(slide => slide.mode === 'source-pagination').length,
      omittedPlanRefs,
      omittedSourceBlockIds: sources.filter(source => !used.has(`${source.sectionKey}\0${source.id}`)).map(source => ({ sectionKey: source.sectionKey, id: source.id })) } }
  const issues = validatePresentation(plan, snapshot)
  if (issues.length) throw new Error(`演示来源映射校验失败：${issues.join('；')}`)
  return plan
}

export const planPresentation = buildPresentation

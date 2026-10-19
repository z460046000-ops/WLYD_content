import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { presentationSource, presentationUnits, validatePresentation } from './validate.js'

const hash = value => createHash('sha256').update(value).digest('hex')
const list = value => Array.isArray(value) ? value : []
const text = value => typeof value === 'string' ? value : ''
const unique = values => [...new Set(values)]
const MAX_BATCH_CHARACTERS = 6000

function prepare(snapshot) {
  const sources = [], sections = []
  for (const section of list(snapshot.sections)) {
    const units = []
    for (const [index, block] of list(section.blocks).entries()) {
      if (!text(block.text).trim()) continue
      sources.push(presentationSource(section, block, index))
      units.push(...presentationUnits(section, block, index))
    }
    sections.push({ key: section.key, title: text(section.title) || section.key,
      status: section.status, inputNeeded: structuredClone(section.inputNeeded || null), units })
  }
  return { sources, sections }
}

function batchesFor(units) {
  const batches = [], current = []
  let characters = 0
  for (const unit of units) {
    if (current.length && characters + unit.text.length > MAX_BATCH_CHARACTERS) {
      batches.push(current.splice(0)); characters = 0
    }
    current.push(unit); characters += unit.text.length
  }
  if (current.length) batches.push(current)
  return batches
}

/** Sentences with conditions and each source paragraph must survive the selection. */
function selectedGroups(raw, units) {
  if (!raw || !Array.isArray(raw.slides) || !raw.slides.length) throw new Error('没有返回演示页面')
  const known = new Map(units.map(unit => [unit.id, unit])), positions = new Map(units.map((unit, index) => [unit.id, index]))
  const seen = new Set(), groups = [], selected = []
  let lastPosition = -1, repaginate = false
  for (const slide of raw.slides) {
    if (!slide || Object.keys(slide).some(key => key !== 'unitIds') || !Array.isArray(slide.unitIds)
      || !slide.unitIds.length || slide.unitIds.length > 3) throw new Error('页面必须仅包含一至三个原文句段 ID')
    const group = []
    for (const id of slide.unitIds) {
      if (typeof id !== 'string' || !known.has(id) || seen.has(id)) throw new Error('句段 ID 未知或重复')
      if (positions.get(id) < lastPosition) repaginate = true
      lastPosition = positions.get(id)
      seen.add(id); group.push(known.get(id)); selected.push(known.get(id))
    }
    if (group.reduce((sum, unit) => sum + [...unit.text].length, 0) > 300) repaginate = true
    groups.push(group)
  }
  if (units.some(unit => unit.protected && !seen.has(unit.id))) throw new Error('精简遗漏条件或能力边界')
  const selectedBlocks = new Set([...seen].map(id => known.get(id).sourceBlockId))
  if (units.some(unit => !selectedBlocks.has(unit.sourceBlockId))) throw new Error('精简遗漏原文段落')
  // A model may group later sentences before earlier ones. Restore the complete
  // selection's source order before pagination, including crossings between pages.
  return repaginate ? fallbackGroups(selected.sort((first, second) => positions.get(first.id) - positions.get(second.id))) : groups
}

function fallbackGroups(units) {
  const groups = []
  for (const unit of units) {
    const prior = groups.at(-1)
    if (prior && prior.length < 3 && prior.reduce((sum, item) => sum + item.text.length, 0) + unit.text.length <= 300
      && !unit.continuation && !prior.some(item => item.continuation)) prior.push(unit)
    else groups.push([unit])
  }
  return groups
}

function mergeRefs(sources) {
  const result = {}
  for (const source of sources) for (const [key, ids] of Object.entries(source.planRefs || {})) {
    if (Array.isArray(ids)) result[key] = unique([...(result[key] || []), ...ids.filter(id => typeof id === 'string')])
  }
  return result
}

function pageFrom(group, section, sources, mode) {
  const selected = sources.filter(source => source.sectionKey === section.key && group.some(unit => unit.sourceBlockId === source.id))
  const headline = group.find(unit => !unit.continuation && [...unit.text].length <= 48)?.text
  return { kind: 'content', sectionKey: section.key, sectionTitle: section.title,
    title: mode === 'source-pagination' ? section.title : headline || section.title, mode, sourceBlockIds: unique(group.map(unit => unit.sourceBlockId)),
    planRefs: mergeRefs(selected), boundaries: unique(selected.flatMap(source => source.boundaries)),
    points: group.map(unit => ({ text: unit.text, sourceBlockIds: [unit.sourceBlockId], continuation: unit.continuation })),
    sourceConditions: unique(selected.flatMap(source => source.conditions)),
    ...(group.some(unit => unit.continuation) ? { continuation: true } : {}) }
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

/** Output-only extractive planning: no source retrieval, source mutation, or model-generated HTML. */
export async function buildPresentation({ snapshot, request, signal } = {}) {
  if (!snapshot || !text(snapshot.sourceContentSha256)) throw new Error('演示需要带源版本指纹的文案快照')
  const prompt = await readFile(new URL('../../../prompts/outputs/presentation.md', import.meta.url), 'utf8')
  const skill = await skillResources()
  const { sources, sections } = prepare(snapshot), slides = [], warnings = [], batches = []
  for (const section of sections) {
    if (signal?.aborted) throw signal.reason || new Error('演示生成已取消')
    if (!section.units.length) {
      slides.push({ kind: 'material-card', sectionKey: section.key, sectionTitle: section.title, status: section.status,
        title: section.title, reason: text(section.inputNeeded?.reason) || '本章暂无正文，待补充或重新生成',
        questions: list(section.inputNeeded?.questions).filter(value => typeof value === 'string'),
        boundaries: [section.status === 'failed' ? '生成故障' : '待补材料', '不属于已完成正文'], sourceBlockIds: [], planRefs: {} })
      continue
    }
    for (const [batchIndex, units] of batchesFor(section.units).entries()) {
      if (signal?.aborted) throw signal.reason || new Error('演示生成已取消')
      let groups, mode = 'extractive-selection', reason
      if (request) {
        try {
          const raw = await request({ stage: 'presentation', qualityMode: 'draft', task: prompt, sourceContentSha256: snapshot.sourceContentSha256,
            skill: { commit: skill.commit, hash: skill.hash, guidance: skill.guidance },
            chapter: { key: section.key, title: section.title },
            units: units.map(unit => ({ id: unit.id, text: unit.text, sourceBlockId: unit.sourceBlockId })),
            protectedUnitIds: units.filter(unit => unit.protected).map(unit => unit.id),
            schema: { slides: [{ unitIds: ['u-原文句段ID，最多三个'] }] } })
          groups = selectedGroups(raw, units)
        } catch (error) {
          if (signal?.aborted) throw signal.reason || error
          reason = String(error.message || error)
        }
      } else reason = '未配置演示精简模型'
      if (!groups) {
        groups = fallbackGroups(units); mode = 'source-pagination'
        warnings.push(`${section.title} / 批次${batchIndex + 1}：未完成模型精简，已保留原文分页（${reason}）`)
      }
      for (const group of groups) slides.push(pageFrom(group, section, sources, mode))
      batches.push({ sectionKey: section.key, batch: batchIndex + 1, inputCharacters: units.reduce((sum, unit) => sum + unit.text.length, 0),
        inputUnits: units.length, pages: groups.length, mode, ...(reason ? { fallbackReason: reason } : {}) })
    }
  }
  if (!slides.length) throw new Error('文案快照没有可展示的章节')
  const plan = { schema: 1, runId: snapshot.runId, title: text(snapshot.title) || '解决方案',
    sourceContentSha256: snapshot.sourceContentSha256,
    sourceVersions: list(snapshot.sections).map(section => ({ key: section.key, version: section.version, approvalStatus: section.approvalStatus })),
    assemblyReview: structuredClone(snapshot.assemblyReview || { status: 'pending', passed: false }), coverage: structuredClone(snapshot.coverage || {}),
    skill: { commit: skill.commit, hash: skill.hash, files: skill.files, promptSha256: hash(prompt) },
    warnings, batches, sources, slides: slides.map((slide, index) => ({ ...slide, id: `slide-${index + 1}` })) }
  const issues = validatePresentation(plan, snapshot)
  if (issues.length) throw new Error(`演示来源映射校验失败：${issues.join('；')}`)
  return plan
}

export const planPresentation = buildPresentation

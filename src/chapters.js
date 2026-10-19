import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { runPath, rootOf, sourceEvidence } from './store.js'
import { readJson, atomicJson, claimRun } from './persistence.js'
import { loadRules, flattenOutline } from './rules.js'
import { reportText, reviewDocument, reviewText } from './content.js'
import { commonContext, createRequester, chapterPlan, list, strings } from './context.js'
import { annotateDraft } from './fact-cards.js'
import { draftWritePrompt } from './draft-generation.js'
import { createRetrieval } from './retrieval.js'
import { reviewAssembly } from './review.js'
import { linksFromPlan } from './generation.js'
import { coverageFromReport } from './content/coverage.js'
import { resolveChapterCards } from './content/card-recovery.js'

const TERMINAL = new Set(['draft_ready', 'needs_human_review', 'partial_draft', 'failed', 'cancelled'])
const manuscriptStatus = report => list(report.chapterOutcomes).some(row => row.status === 'failed')
  ? list(report.sections).some(section => list(section.blocks).some(block => String(block.text || '').trim())) ? 'partial_draft' : 'failed'
  : 'draft_ready'
function revisedDiagnostics(rows, cards) {
  const prior = rows.filter(Boolean)
  return { ...Object.assign({}, ...prior), reasonCode: null, reasonCodes: [], hasProse: true, selectedFacts: cards.length,
    historicalReasonCodes: strings(prior.flatMap(row => [...list(row.historicalReasonCodes), ...list(row.reasonCodes), row.reasonCode])) }
}
function revisedOutcome(row, chapter) {
  const { error, ...previous } = row
  return { ...previous, status: chapter.status, version: chapter.version, diagnostics: chapter.diagnostics,
    ...(error ? { historicalErrors: strings([...list(row.historicalErrors), error]) } : {}) }
}
const summary = (report, node) => {
  const record = report.chapterRecords?.[node.key] || {}
  const outcome = report.chapterOutcomes.find(row => row.key === node.key) || {}
  return { key: node.key, title: node.title, version: record.version || outcome.version || 1, status: outcome.status,
    approvalStatus: record.approvalStatus || 'pending', notes: record.notes || [],
    blocks: report.sections.find(row => row.key === node.key)?.blocks || [],
    inputNeeded: report.sections.find(row => row.key === node.key)?.inputNeeded || null }
}
async function writeViews(dir, report, state) {
  state.contentCoverage = coverageFromReport(report)
  const review = reviewDocument(report)
  await writeFile(path.join(dir, 'report.md'), reportText(report), { mode: 0o600 })
  await atomicJson(path.join(dir, 'review.json'), review)
  await writeFile(path.join(dir, 'review.md'), reviewText(review), { mode: 0o600 })
  await atomicJson(path.join(dir, 'run.json'), state)
}

/** Only the requested chapter is versioned; the report JSON is the canonical editable document. */
export async function chapterAction({ client, llm, args, exec }) {
  const dir = runPath(exec.agent, args.run_id)
  let state = await readJson(path.join(dir, 'run.json'))
  if (state.actorDshId && state.actorDshId !== exec.agent.session?.user?.id) throw new Error('当前用户无权修改此稿件')
  const action = args.action || 'list'
  if (!TERMINAL.has(state.status) && !(action === 'list' && state.reportReady)) throw new Error('初稿仍在生成或复核，请等待任务结束或取消后再修改章节')
  let report = await readJson(path.join(dir, 'report.json'))
  const nodes = flattenOutline(report.outline)
  if (action === 'list') return { runId: args.run_id, qualityMode: report.qualityMode || 'strict',
    status: state.status, reportReady: Boolean(state.reportReady),
    chapters: nodes.map(node => summary(report, node)), reportPath: path.join(dir, 'report.md') }
  const node = nodes.find(row => row.key === args.chapter_key)
  if (!node) throw new Error('chapter_key 不在本稿件目录中，请先 action=list')
  const lock = await claimRun(rootOf(exec.agent), args.run_id, randomUUID(), { resume: true,
    sessionId: exec.agent.session?.id || exec.agent.id || null })
  if (lock.existing) throw new Error('该稿件正在修改，请稍后再试')
  try {
    state = await readJson(path.join(dir, 'run.json'))
    if (!TERMINAL.has(state.status)) throw new Error('该稿件正在生成，请结束后再修改')
    report = await readJson(path.join(dir, 'report.json'))
    report.chapterRecords ||= {}
    const record = report.chapterRecords[node.key] ||= { version: report.chapterOutcomes.find(row => row.key === node.key)?.version || 1, approvalStatus: 'pending', notes: [] }
    if (['revise', 'approve', 'reopen'].includes(action) && args.expected_version !== record.version) throw new Error('章节版本已改变；请先 list 并传最新 expected_version')
    const text = String(args.instruction || args.text || '').trim()
    if (['comment', 'question'].includes(action)) {
      if (!text) throw new Error('请提供评论或追问内容')
      record.notes.push({ id: randomUUID(), kind: action, text, version: record.version, status: 'open', createdAt: new Date().toISOString() })
    } else if (action === 'resolve') {
      const note = record.notes.find(row => row.id === args.note_id)
      if (!note) throw new Error('找不到该评论或追问')
      note.status = 'resolved'; note.resolution = text; note.resolvedAt = new Date().toISOString()
    } else if (action === 'approve' || action === 'reopen') {
      if (args.confirmed !== true) throw new Error('请在用户明确确认后传 confirmed=true')
      if (action === 'approve' && !report.sections.find(row => row.key === node.key)?.blocks?.length) throw new Error('本章只有待补材料卡，不能作为正文定稿')
      record.approvalStatus = action === 'approve' ? 'approved' : 'pending'
      record.approvedAt = action === 'approve' ? new Date().toISOString() : null
    } else if (action === 'revise') {
      if (record.approvalStatus === 'approved') throw new Error('本章已定稿，请先明确 reopen 再修改')
      if (!text) throw new Error('请提供本章修改要求')
      const rules = await loadRules(report.templateId)
      if (rules.fingerprint !== report.ruleFingerprint) throw new Error('规则已更新，请重新规划生成后再修改章节')
      const evidence = (await readJson(path.join(dir, 'evidence.json'))).evidence
      if (!evidence.some(source => source.kind === 'knowledge')) throw new Error('本稿件没有知识库证据，请先从项目知识库重新规划生成')
      const saved = await readJson(path.join(dir, 'run-input.json'), { args: {} })
      const source = await sourceEvidence(exec.agent, saved.args)
      const access = createRetrieval({ client, projectId: state.projectId, rules, evidence: source.evidence, signal: exec.signal })
      await access.restoreEvidence(evidence)
      const chapterDir = path.join(dir, 'chapters', node.key)
      const old = await readJson(path.join(chapterDir, 'chapter.json'), {})
      const rule = rules.chapters[node.roleId] || rules.global.customChapter
      const recovered = await resolveChapterCards({ chapterDir, evidence: access.evidence, node, rule })
      const cards = recovered.cards
      if (!cards.length) {
        const error = new Error(`本章事实卡池无法安全恢复（${recovered.failureCode || 'card_pool_empty'}）；未调用修订模型，当前稿件和版本已保留。请核对原批次来源或仅重新生成本章`)
        error.code = 'CHAPTER_CARD_POOL_EMPTY'
        throw error
      }
      const plan = await readJson(path.join(dir, 'plan.json'))
      const common = commonContext(rules, saved.args)
      const request = await createRequester({ llm, exec, state,
        saveState: () => atomicJson(path.join(dir, 'run.json'), state) })
      const current = report.sections.find(row => row.key === node.key) || { ...node, blocks: [] }
      const targetIds = args.block_ids ? strings(args.block_ids) : null
      if (targetIds && (!targetIds.length || targetIds.some(id => !current.blocks.some(block => block.id === id)))) throw new Error('block_ids 含无效段落，请先 list')
      const target = targetIds ? current.blocks.filter(block => targetIds.includes(block.id)) : current.blocks
      const started = Date.now()
      const raw = await request(draftWritePrompt({ common, node, rule,
        cards, plan: chapterPlan(plan, node), blocks: target,
        instruction: `${text}\n本章尚未解决的用户意见：${record.notes.filter(note => note.status === 'open').map(note => note.text).join('；')}` }))
      const checked = annotateDraft(list(raw.sections).filter(row => row.key === node.key).flatMap(row => list(row.blocks)), cards, evidence, node, plan)
      if (rule.contentPolicy?.allowCandidate === false || ['customer-cases', 'company-profile'].includes(node.roleId)) {
        checked.section.blocks = checked.section.blocks.filter(block => block.supportMode === 'sourced' && block.evidence.length
          && block.factIds?.some(id => cards.some(card => card.id === id && card.supportMode === 'sourced')))
      }
      if (!checked.section.blocks.length) throw new Error('修改未返回正文，原版本已保留')
      let next = checked.section
      if (targetIds) {
        let inserted = false
        const maximum = Math.max(0, ...current.blocks.map(block => Number(block.id.slice(node.key.length + 1)) || 0))
        const replacements = next.blocks.map((block, i) => ({ ...block, id: `${node.key}-${maximum + i + 1}` }))
        next = { ...current, blocks: current.blocks.flatMap(block => {
          if (!targetIds.includes(block.id)) return [block]
          if (inserted) return []
          inserted = true; return replacements
        }) }
      }
      await mkdir(path.join(chapterDir, 'versions'), { recursive: true, mode: 0o700 })
      if (recovered.changed) await atomicJson(path.join(chapterDir, 'cards.json'), { cards, recovery: {
        source: recovered.source, referenceAudit: recovered.referenceAudit, checkedAt: new Date().toISOString() } })
      const beforeVersion = record.version
      await atomicJson(path.join(chapterDir, 'versions', `${beforeVersion}.json`), { ...old, section: current, version: beforeVersion })
      record.version++; record.approvalStatus = 'pending'
      record.lastInstruction = text; record.updatedAt = new Date().toISOString(); record.writeMs = Date.now() - started
      const diagnostics = revisedDiagnostics([old.diagnostics, state.chapters?.find(row => row.key === node.key)?.diagnostics,
        state.chapterOutcomes?.find(row => row.key === node.key)?.diagnostics,
        report.chapterOutcomes.find(row => row.key === node.key)?.diagnostics], cards)
      const chapter = { section: next, version: record.version, status: 'draft_unverified', reviewItems: strings([...recovered.reviewItems, ...checked.issues]),
        diagnostics,
        cardRecovery: { source: recovered.source, referenceAudit: recovered.referenceAudit },
        parentVersion: beforeVersion, instruction: text, generatedAt: record.updatedAt }
      await atomicJson(path.join(chapterDir, 'versions', `${record.version}.json`), chapter)
      report.sections = report.sections.map(section => section.key === node.key ? next : section)
      report.assemblyLinks = linksFromPlan(plan, report.sections, report.outline)
      report.chapterOutcomes = report.chapterOutcomes.map(row => row.key === node.key ? revisedOutcome(row, chapter) : row)
      state.chapters = state.chapters.map(row => row.key === node.key ? revisedOutcome(row, chapter) : row)
      state.chapterOutcomes = Array.isArray(state.chapterOutcomes)
        ? state.chapterOutcomes.map(row => row.key === node.key ? revisedOutcome(row, chapter) : row) : structuredClone(report.chapterOutcomes)
      report.reviewItems = strings([...report.reviewItems, ...chapter.reviewItems.map(issue => `v${record.version} ${issue}`)])
      report.reviewStatus = manuscriptStatus(report); state.status = report.reviewStatus
      report.assemblyReview = { ...report.assemblyReview, status: 'pending', passed: false, changedChapters: [node.key] }
      await atomicJson(path.join(dir, 'report.json'), report)
      await atomicJson(path.join(chapterDir, 'chapter.json'), chapter)
      await writeViews(dir, report, state)
      // Fingerprint caching reuses unchanged chapter/relationship checks; no writing repair loop.
      const reviewed = await reviewAssembly({ request, common: { ...common, qualityMode: 'draft' }, plan, outline: report.outline,
        sections: report.sections, evidence, dir, state, saveState: () => atomicJson(path.join(dir, 'run.json'), state),
        signal: exec.signal, ruleFingerprint: rules.fingerprint, allowRepairs: false, splitOnResource: false })
      report.assemblyReview = { ...reviewed.review, passed: false, changedChapters: [node.key] }
      report.reviewItems = strings([...report.reviewItems, ...reviewed.reviewItems])
      state.status = manuscriptStatus(report); report.reviewStatus = state.status; record.totalMs = Date.now() - started
    } else throw new Error('未知章节操作')
    report.generatedAt = new Date().toISOString()
    report.contentCoverage = coverageFromReport(report)
    await atomicJson(path.join(dir, 'report.json'), report)
    await writeViews(dir, report, state)
    return { runId: args.run_id, chapter: summary(report, node), reportPath: path.join(dir, 'report.md'),
      reviewPath: path.join(dir, 'review.md'), note: '用户定稿表示人工认可；引用定位不代替事实与语义核验' }
  } catch (error) {
    if (state.status === 'reviewing') {
      state.status = manuscriptStatus(report); report.reviewStatus = state.status
      state.review = { ...state.review, status: 'partial', passed: false, error: error.message }
      report.assemblyReview = state.review
      report.reviewItems = strings([...report.reviewItems, `章节修改后的复核未完成：${error.message}`])
      await atomicJson(path.join(dir, 'report.json'), report)
      await writeViews(dir, report, state)
    }
    throw error
  } finally { await lock.release() }
}

import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { flattenOutline } from './rules.js'
import { mapConcurrent, abortError } from './scheduler.js'
import { createRequester, commonContext, chapterPlan, writeJson, list, strings } from './context.js'
import { annotateDraft, inputCard } from './fact-cards.js'
import { sourceCardBatches, materializeCombined, partialCombinedProse } from './combined-writing.js'
import { reviewAssembly } from './review.js'
import { classifyModelFailure } from './model.js'

function modelReason(error) {
  const kind = classifyModelFailure(error)
  if (['queue', 'stage'].includes(kind) || error?.name === 'TimeoutError' || /\b(?:timed?\s*out|timeout)\b|超时/iu.test(error?.message || '')) return 'model_timeout'
  return ({ output: 'model_output_limit', context: 'model_context_limit', auth: 'model_auth_failed', quota: 'model_quota_failed' })[kind] || 'model_failed'
}

async function retrievalDiagnostics(retrieval, chapterDir, node, sources) {
  let queries = []
  try { queries = list(JSON.parse(await readFile(path.join(chapterDir, 'retrieval.json'), 'utf8')).queries) } catch { /* Optional for retrieval adapters without a disk audit. */ }
  const knownHits = retrieval.chapterKnowledgeHits?.(node.key)
  const knowledgeHits = Array.isArray(knownHits) ? knownHits.length : null
  const failedQueries = queries.filter(query => query.status === 'failed').length
  const failedPreparation = !queries.length && list(retrieval.coverage).some(base => base.status === 'failed')
  const successfulQueries = queries.filter(query => query.status === 'completed').length
  const partialQueries = queries.filter(query => query.partial).length
  const reasonCodes = []
  if (failedQueries || failedPreparation) reasonCodes.push('retrieval_failed')
  if (partialQueries) reasonCodes.push('retrieval_partial')
  if (knowledgeHits === 0 && successfulQueries > 0 && !partialQueries && !failedQueries) reasonCodes.push('zero_knowledge_hits')
  return { reasonCode: reasonCodes[0] || null, reasonCodes, knowledgeHits,
    knowledgeQueries: retrieval.chapterKnowledgeQueries?.(node.key) || queries.length,
    successfulQueries, failedQueries, partialQueries, selectedKnowledgeSources: sources.length,
    selectedFacts: 0, excludedFacts: 0, modelFailures: 0, modelTimeouts: 0, emptyBatches: 0 }
}

function addDiagnostic(diagnostics, reason) {
  if (!diagnostics.reasonCodes.includes(reason)) diagnostics.reasonCodes.push(reason)
  diagnostics.reasonCode = diagnostics.reasonCodes[0] || null
}

export function draftWritePrompt({ common, node, rule, cards, plan, instruction, blocks, combined = false }) {
  return { stage: 'write', qualityMode: 'draft', author: common.author, audience: common.audience, chapter: node,
    task: combined ? '同一次完成本批原文归纳与本章撰写。facts列简短事实、主体、用途和原文sourceCardIds；正文用factIds引用facts的id。短标题概括后解释业务动作，复用主线编号。只返回JSON。推演标candidate；不编造数字、客户、能力或资质，不把内部经营研发和无案例说明当客户事实。'
      : '写本章可供用户修改的完整初稿。短标题、短语概括后解释业务动作；复用主线编号维持前后关联。只返回JSON。引用factIds，不抄引文、不创建事实卡。推演标candidate，未知数字、客户、能力状态和企业资质不要当事实。',
    ...(combined ? { generationMode: 'retrieve-write' } : {}),
    chapterRule: { write: rule.write || [] }, plan,
    facts: cards.map(({ evidence, ...card }) => card),
    ...(instruction ? { instruction, currentBlocks: blocks } : { lengthGuidance: '本章一次完成，围绕关键主题写3至6段；重点业务/场景充分说明动作和价值，避免重复凑字' }),
    schema: { ...(combined ? { facts: [{ id: 'claim-1', text: '本批原文的简短概括', sourceCardIds: ['输入原文卡ID'], subject: 'customer/product/industry/company/vendor-internal/unknown',
      purpose: 'capability/business-problem/trend/case/company-profile/constraint/internal/unknown', supportMode: 'sourced/candidate',
      capabilityStatus: 'existing/pilot/planned/proposed/unknown', capabilityOwnership: 'self/third-party/customer/unknown' }] } : {}),
      sections: [{ key: node.key, blocks: [{ text: '本章正文', factIds: [combined ? 'claim-1' : '输入事实卡ID'],
      supportMode: 'sourced/candidate', planRefs: { capabilityIds: [], scenarioIds: [], problemIds: [], trendIds: [] } }] }], reviewItems: [] } }
}

/** Fast first pass: summarize and write each bounded source batch together; retain issues for iteration. */
export async function generateFastDraft({ llm, exec, args, rules, outline, evidence, dir, state, saveState, retrieval, acceptedPlan, resume, onDraft }) {
  const request = await createRequester({ llm, exec, state, saveState })
  const common = commonContext(rules, args), plan = acceptedPlan, nodes = flattenOutline(outline)
  const prior = new Map((resume ? state.chapters || [] : []).map(row => [row.key, row]))
  state.planning = { status: 'confirmed', planId: args.plan_id }
  state.status = 'generating'; state.qualityMode = args.quality_mode; state.chapterScheduling = 'all-parallel'; state.concurrency = 8
  state.chapters = nodes.map(node => ({ key: node.key, title: node.title, status: 'queued' }))
  await writeJson(path.join(dir, 'plan.json'), { ...plan, outline, ruleFingerprint: rules.fingerprint,
    confirmation: { planId: args.plan_id, sha256: args.plan_sha256 } })
  await saveState()
  const finishedChapters = new Map()
  let publication = Promise.resolve()
  const snapshot = () => ({ title: plan.title, outline, choices: plan.choices,
    sections: nodes.map(node => finishedChapters.get(node.key)?.section || { key: node.key, title: node.title, roleId: node.roleId, blocks: [] }),
    chapterOutcomes: state.chapters.map(row => ({ ...row, status: finishedChapters.has(row.key) ? row.status : 'pending' })),
    assemblyLinks: [], validationIssues: [], gaps: [],
    reviewItems: strings([...list(plan.reviewItems), ...retrieval.issues, ...[...finishedChapters.values()].flatMap(chapter => chapter.reviewItems)]),
    review: { status: 'pending', passed: false },
  })
  const publish = (node, chapter) => {
    finishedChapters.set(node.key, chapter)
    if (!onDraft) return Promise.resolve()
    const draft = structuredClone(snapshot())
    const phase = finishedChapters.size === nodes.length ? 'draft_reviewing' : 'draft_building'
    publication = publication.then(() => onDraft(draft, phase))
    return publication
  }
  const results = await mapConcurrent(nodes, async (node, index) => {
    const progress = state.chapters[index], chapterDir = path.join(dir, 'chapters', node.key)
    const rule = rules.chapters[node.roleId] || rules.global.customChapter
    await mkdir(path.join(chapterDir, 'versions'), { recursive: true, mode: 0o700 })
    let section, cards = [], issues = [], status = 'draft_unverified'
    let diagnostics = { reasonCode: null, reasonCodes: [], knowledgeHits: null, knowledgeQueries: 0,
      selectedFacts: 0, excludedFacts: 0, modelFailures: 0, modelTimeouts: 0, emptyBatches: 0 }
    try {
      progress.status = 'retrieving'; await saveState()
      let found
      try { found = await retrieval.forChapter(node, plan, [], { strategy: 'fast' }) }
      catch (error) { addDiagnostic(diagnostics, 'retrieval_failed'); throw error }
      const sources = found.filter(source => source.kind === 'knowledge')
      diagnostics = await retrievalDiagnostics(retrieval, chapterDir, node, sources)
      progress.diagnostics = diagnostics
      progress.knowledgeHits = retrieval.chapterKnowledgeHits?.(node.key).length || 0
      progress.knowledgeQueries = retrieval.chapterKnowledgeQueries?.(node.key) || 0
      progress.knowledgeStatus = diagnostics.reasonCodes.includes('retrieval_failed') ? progress.knowledgeHits ? 'partial' : 'failed'
        : diagnostics.partialQueries ? 'partial' : progress.knowledgeHits ? 'matched' : 'empty'
      if (resume && ['completed', 'draft_unverified'].includes(prior.get(node.key)?.status)) {
        let reusable
        try {
          const old = JSON.parse(await readFile(path.join(chapterDir, 'chapter.json'), 'utf8'))
          if (old.section?.blocks?.length && old.section.blocks.every(block => list(block.evidence).every(ref =>
            evidence.some(source => source.id === ref.id && source.content.includes(ref.quote))))) {
            Object.assign(progress, prior.get(node.key), { reusedChapter: true, knowledgeHits: progress.knowledgeHits,
              knowledgeQueries: progress.knowledgeQueries, knowledgeStatus: progress.knowledgeStatus })
            if (!progress.knowledgeHits) progress.status = 'draft_unverified'
            reusable = { ...old, diagnostics: { ...old.diagnostics, ...diagnostics,
              selectedFacts: old.diagnostics?.selectedFacts || 0, reusedChapter: true } }
            progress.diagnostics = reusable.diagnostics
          }
        } catch { /* Missing or invalid chapter is generated again. */ }
        if (reusable) { await saveState(); await publish(node, reusable); return reusable }
      }
      if (!sources.length) {
        if (!diagnostics.reasonCode) addDiagnostic(diagnostics, 'no_usable_evidence')
        section = inputCard(node, rule, diagnostics.reasonCode === 'retrieval_failed'
          ? '本章检索请求未成功，暂不能判断是否缺料；可恢复检索后重试'
          : diagnostics.reasonCode === 'zero_knowledge_hits' ? '本章当次检索没有命中，请调整检索或补充材料'
            : '本章尚无可用知识库片段，请检查检索范围或补充材料')
        status = 'needs_input'
      } else {
        const allCards = new Map(), body = [], bodyKeys = new Set()
        const extraction = { facts: [], writingOutline: [], retrievalQueries: [], gaps: [], reviewItems: [], batches: [], mode: 'retrieve-write' }
        const batches = sourceCardBatches(sources)
        let repaired = false
        progress.writeAttempts = 0; progress.extractionMode = 'combined-with-writing'
        for (const [batchIndex, sourceCards] of batches.entries()) {
          if (exec.signal?.aborted) throw abortError(exec.signal)
          progress.status = 'writing'; progress.writeAttempts++; await saveState()
          let raw, partial = false
          try {
            raw = await request(draftWritePrompt({ common, node, rule, cards: sourceCards,
              plan: chapterPlan(plan, node), combined: true,
              ...(body.length ? { instruction: '继续本章尚未展开的主题，不重复最近已写内容', blocks: body.slice(-8).map(block => ({ text: block.text.slice(0, 120) })) } : {}) }))
          } catch (error) {
            if (exec.signal?.aborted) throw error
            const reason = modelReason(error)
            addDiagnostic(diagnostics, reason); diagnostics.modelFailures++
            if (reason === 'model_timeout') diagnostics.modelTimeouts++
            partial = true; issues.push(`本章撰写未完整结束：${error.message}`)
            raw = { sections: [{ key: node.key, blocks: partialCombinedProse(error.partialOutput) }] }
          }
          await writeJson(path.join(chapterDir, `draft-${batchIndex + 1}.json`), raw)
          const materialized = materializeCombined(raw, sourceCards, evidence, node, rule)
          diagnostics.selectedFacts += materialized.facts.length
          diagnostics.excludedFacts += materialized.excludedFacts.length
          if (materialized.excludedFacts.length) {
            const reasons = materialized.excludedFacts.flatMap(fact => list(fact.exclusionReasons))
            addDiagnostic(diagnostics, reasons.some(reason => /用途|(?:purpose|subject)=|本章只接受|正向事实|不是合作案例/u.test(reason))
              ? 'purpose_mismatch' : 'material_not_applicable')
          }
          for (const card of materialized.cards) allCards.set(card.id, card)
          extraction.facts.push(...materialized.facts)
          issues.push(...materialized.reviewItems, ...strings(raw?.reviewItems))
          let checked = annotateDraft(materialized.blocks, materialized.cards, evidence, node, plan)
          if (args.quality_mode === 'standard' && !repaired && checked.issues.length && checked.section.blocks.length) {
            repaired = true
            try {
              progress.writeAttempts++; await saveState()
              const repair = await request(draftWritePrompt({ common, node, rule, cards: materialized.cards, plan: chapterPlan(plan, node),
                instruction: `修正本章问题，保留其他内容：${checked.issues.join('；')}`, blocks: checked.section.blocks }))
              const next = annotateDraft(list(repair.sections).filter(row => row.key === node.key).flatMap(row => list(row.blocks)), materialized.cards, evidence, node, plan)
              if (next.section.blocks.length) checked = next
            } catch (error) { if (exec.signal?.aborted) throw error; issues.push(`单轮修正未完成，保留初稿：${error.message}`) }
          }
          issues.push(...checked.issues)
          if (!checked.section.blocks.length) {
            diagnostics.emptyBatches++
            issues.push(`第${batchIndex + 1}批未返回适合本章的正文；已保留其他批次内容，可按章补充或重试`)
          }
          for (const block of checked.section.blocks) {
            const key = JSON.stringify([block.text, block.supportMode, block.factIds, block.capabilityStatus, block.capabilityOwnership])
            if (!bodyKeys.has(key)) { bodyKeys.add(key); body.push({ ...block, id: `${node.key}-${body.length + 1}` }) }
          }
          extraction.batches.push({ batchId: String(batchIndex + 1), status: partial || !checked.section.blocks.length ? 'partial' : 'completed',
            facts: materialized.facts.length, sourceCardIds: sourceCards.map(card => card.id),
            evidenceIds: [...new Set(sourceCards.flatMap(card => card.evidence.map(ref => ref.id)))] })
          extraction.reviewItems = strings(issues)
          await writeJson(path.join(chapterDir, 'extraction.json'), extraction)
          await writeJson(path.join(chapterDir, 'cards.json'), { cards: [...allCards.values()] })
          await writeJson(path.join(chapterDir, 'writing-partial.json'), { sections: [{ key: node.key, blocks: body }] })
        }
        cards = [...allCards.values()]
        section = { key: node.key, title: node.title, roleId: node.roleId,
          ...(node.framework ? { framework: node.framework } : {}), blocks: body }
        if (!body.length) {
          if (!diagnostics.reasonCode) addDiagnostic(diagnostics, 'no_prose')
          section = inputCard(node, rule, issues[0] || '知识库材料尚不能支持本章正文，请补充对应事实或按章重试')
          status = 'needs_input'
        } else status = 'draft_unverified'
        await writeJson(path.join(chapterDir, 'draft.json'), { sections: [section] })
      }
      if (!progress.knowledgeHits) issues.push('本章当次检索零命中；规划锚点不算本章新命中，请补查')
    } catch (error) {
      if (exec.signal?.aborted) { progress.status = 'cancelled'; await saveState(); throw abortError(exec.signal) }
      if (!diagnostics.reasonCode) addDiagnostic(diagnostics, 'generation_failed')
      issues.push(error.message)
      section = inputCard(node, rule, `本章暂未完成：${error.message}`); status = 'needs_input'
    }
    const version = (prior.get(node.key)?.version || 0) + 1
    const chapter = { section, status, version, diagnostics: { ...diagnostics, hasProse: Boolean(section.blocks?.length) }, reviewItems: strings(issues), validationIssues: [], gaps: [],
      generatedAt: new Date().toISOString() }
    await writeJson(path.join(chapterDir, 'chapter.json'), chapter)
    await writeJson(path.join(chapterDir, 'versions', `${version}.json`), chapter)
    Object.assign(progress, { status, version, diagnostics: chapter.diagnostics, evidenceCount: cards.length, reviewItems: chapter.reviewItems,
      path: `chapters/${node.key}/chapter.json` })
    await saveState()
    await publish(node, chapter)
    return chapter
  }, { concurrency: Math.max(1, nodes.length), signal: exec.signal })
  if (exec.signal?.aborted) throw abortError(exec.signal)
  const chapters = results.map((result, index) => result.status === 'fulfilled' ? result.value : {
    section: inputCard(nodes[index], rules.chapters[nodes[index].roleId] || {}, result.reason.message),
    status: 'needs_input', reviewItems: [result.reason.message] })
  const sections = chapters.map(chapter => chapter.section)
  await publication
  if (!state.draftReadyAt) state.draftReadyAt = new Date().toISOString()
  // Draft checks run once and annotate; no automatic repairs, panorama round, or recheck loop.
  const reviewed = await reviewAssembly({ request, common: { ...common, qualityMode: 'draft' }, plan, outline,
    sections, evidence, dir, state, saveState, signal: exec.signal, ruleFingerprint: rules.fingerprint,
    allowRepairs: false, splitOnResource: false, sourceWindowProjection: true })
  state.review.passed = false
  state.reviewFinishedAt = new Date().toISOString()
  await saveState()
  return { title: plan.title, outline, sections, choices: plan.choices, assemblyLinks: [],
    reviewItems: strings([...list(plan.reviewItems), ...retrieval.issues, ...chapters.flatMap(chapter => chapter.reviewItems),
      ...reviewed.reviewItems, '初稿待逐章审阅；引用可定位不代表表述已获业务确认']),
    validationIssues: [], gaps: chapters.filter(chapter => chapter.status === 'needs_input').map(chapter => `${chapter.section.key}：待补材料或按章重试`),
    review: state.review, chapterOutcomes: state.chapters }
}

import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { flattenOutline } from './rules.js'
import { mapConcurrent, abortError } from './scheduler.js'
import { createRequester, commonContext, chapterPlan, writeJson, list, strings, itemBatches } from './context.js'
import { annotateDraft, inputCard } from './fact-cards.js'
import { sourceCardBatches, materializeCombined, partialCombinedResponse } from './combined-writing.js'
import { reviewAssembly } from './review.js'
import { classifyModelFailure } from './model.js'
import { draftBinding, loadDraftCheckpoint, createDraftCheckpoint, saveDraftBatch, saveDraftRecovery, reusableDraftChapter } from './content/draft-checkpoint.js'
import { resolveChapterCards } from './content/card-recovery.js'

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
    task: combined ? '同一次归纳本批原文并撰写本章。sourceCardIds只填输入原文卡顶层id（s-加20位hex），不得填知识库K编号；正文factIds填本次输出facts的id。短标题概括后解释业务动作，复用主线编号。只返回JSON。推演标candidate，不编造数字、客户、能力或资质，不把内部经营研发和无案例说明当客户事实。'
      : '写本章可供用户修改的初稿。短标题、短语概括后解释业务动作，复用主线编号。只返回JSON。factIds只填输入facts的完整id（f-…），不可自造fact-1或新事实卡。推演标candidate，未知数字、客户、能力状态和资质不要当事实。',
    ...(combined ? { generationMode: 'retrieve-write' } : {}),
    chapterRule: { write: rule.write || [] }, plan,
    facts: cards.map(({ evidence, sourceEvidenceId, ...card }) => card),
    ...(instruction ? { instruction, currentBlocks: blocks } : { lengthGuidance: '本章一次完成，围绕关键主题写3至6段；重点业务/场景充分说明动作和价值，避免重复凑字' }),
    schema: { ...(combined ? { facts: [{ id: 'claim-1', text: '本批原文的简短概括', sourceCardIds: [cards[0]?.id || 's-<20位hex>'], subject: 'customer/product/industry/company/vendor-internal/unknown',
      purpose: 'capability/business-problem/trend/case/company-profile/constraint/internal/unknown', supportMode: 'sourced/candidate',
      capabilityStatus: 'existing/pilot/planned/proposed/unknown', capabilityOwnership: 'self/third-party/customer/unknown' }] } : {}),
      sections: [{ key: node.key, blocks: [{ text: '本章正文', factIds: [combined ? 'claim-1' : cards[0]?.id || 'f-<输入事实卡id>'],
      supportMode: 'sourced/candidate', planRefs: { capabilityIds: [], scenarioIds: [], problemIds: [], trendIds: [] } }] }], reviewItems: [] } }
}

/** Fast first pass: summarize and write each bounded source batch together; retain issues for iteration. */
export async function generateFastDraft({ llm, exec, args, rules, outline, evidence, dir, state, saveState, retrieval, acceptedPlan, resume, onDraft }) {
  const request = await createRequester({ llm, exec, state, saveState })
  const common = commonContext(rules, args), plan = acceptedPlan, nodes = flattenOutline(outline)
  const prior = new Map((resume ? state.chapters || [] : []).map(row => [row.key, row]))
  const attempt = state.resumeCount || 0
  let previousReport = null
  if (resume) { try { previousReport = JSON.parse(await readFile(path.join(dir, 'report.json'), 'utf8')) } catch { /* No valid prior report: generate from authorized sources. */ } }
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
      const bindingSha256 = draftBinding({ args, rules, outline, node, plan, state })
      const restored = resume ? await loadDraftCheckpoint({ chapterDir, bindingSha256, evidence, attempt }) : null
      const reusable = resume ? await reusableDraftChapter({ chapterDir, previousReport, prior: prior.get(node.key), args,
        rules, evidence, node, checkpoint: restored }) : null
      if (reusable) {
        const chapter = reusable.chapter
        chapter.diagnostics = { ...chapter.diagnostics, knowledgeHits: 0, knowledgeQueries: 0,
          checkpointKnowledgeHits: reusable.retrieval.knowledgeHitCount || 0, checkpointAttempt: attempt }
        Object.assign(progress, prior.get(node.key), { status: chapter.status, version: chapter.version, reusedChapter: true,
          reusedNeedsInput: Boolean(chapter.diagnostics.reusedNeedsInput), resumeDecision: 'reused-authorized-chapter',
          knowledgeHits: 0, knowledgeQueries: 0, knowledgeStatus: 'checkpoint', diagnostics: chapter.diagnostics })
        await saveState(); await publish(node, chapter); return chapter
      }
      let sources
      if (restored) {
        sources = restored.sources
        diagnostics = { ...diagnostics, ...restored.checkpoint.retrieval?.diagnostics, knowledgeHits: 0, knowledgeQueries: 0,
          checkpointKnowledgeHits: restored.checkpoint.retrieval?.knowledgeHitIds?.length || 0, reusedEvidence: true }
        progress.resumeDecision = 'reused-authorized-batches'; progress.knowledgeStatus = 'checkpoint'
      } else {
        progress.status = 'retrieving'; progress.resumeDecision = resume ? 'checkpoint-missing-or-invalid' : 'new-chapter'; await saveState()
        let found
        try { found = await retrieval.forChapter(node, plan, [], { strategy: 'fast' }) }
        catch (error) { addDiagnostic(diagnostics, 'retrieval_failed'); throw error }
        sources = found.filter(source => source.kind === 'knowledge')
        diagnostics = await retrievalDiagnostics(retrieval, chapterDir, node, sources)
        progress.knowledgeStatus = diagnostics.reasonCodes.includes('retrieval_failed') ? diagnostics.knowledgeHits ? 'partial' : 'failed'
          : diagnostics.partialQueries ? 'partial' : diagnostics.knowledgeHits ? 'matched' : 'empty'
      }
      progress.diagnostics = diagnostics
      progress.knowledgeHits = diagnostics.knowledgeHits || 0; progress.knowledgeQueries = diagnostics.knowledgeQueries || 0
      const checkpoint = restored?.checkpoint || createDraftCheckpoint({ bindingSha256, attempt, sources,
        retrieval: { knowledgeHitIds: retrieval.chapterKnowledgeHits?.(node.key) || [],
          knowledgeQueryCount: progress.knowledgeQueries, diagnostics: structuredClone(diagnostics) } })
      if (sources.length) await writeJson(path.join(chapterDir, 'draft-checkpoint.json'), checkpoint)
      if (!sources.length) {
        if (!diagnostics.reasonCode) addDiagnostic(diagnostics, 'no_usable_evidence')
        section = inputCard(node, rule, diagnostics.reasonCode === 'retrieval_failed'
          ? '本章检索请求未成功，暂不能判断是否缺料；可恢复检索后重试'
          : diagnostics.reasonCode === 'zero_knowledge_hits' ? '本章当次检索没有命中，请调整检索或补充材料'
            : '本章尚无可用知识库片段，请检查检索范围或补充材料')
        const retrievalFault = diagnostics.reasonCodes.some(code => ['retrieval_failed', 'retrieval_partial'].includes(code))
        status = retrievalFault ? 'failed' : 'needs_input'
        if (retrievalFault) section.inputNeeded = { ...section.inputNeeded, kind: 'generation_error', questions: [],
          nextAction: '检索请求未完整成功；恢复后重试本章，暂不能判断是否需要补料。' }
      } else {
        const allCards = new Map(), body = [], bodyKeys = new Set()
        const extraction = { facts: [], writingOutline: [], retrievalQueries: [], gaps: [], reviewItems: [], batches: [], mode: 'retrieve-write' }
        const batches = sourceCardBatches(sources)
        let repaired = false, recoveryCards = []
        diagnostics = { ...diagnostics, reasonCode: null, reasonCodes: list(diagnostics.reasonCodes).filter(code =>
          ['retrieval_failed', 'retrieval_partial', 'zero_knowledge_hits'].includes(code)),
          selectedFacts: 0, excludedFacts: 0, modelFailures: 0, modelTimeouts: 0, emptyBatches: 0 }
        diagnostics.reasonCode = diagnostics.reasonCodes[0] || null
        diagnostics.referenceIdMismatches = 0; diagnostics.referenceIdRepairs = 0; diagnostics.referenceIdRejectedFacts = 0
        diagnostics.recoveryAttempts = 0; diagnostics.recoveredBlocks = 0
        progress.diagnostics = diagnostics
        progress.writeAttempts = 0; progress.reusedBatches = 0; progress.extractionMode = 'combined-with-writing'
        const addBlocks = blocks => {
          for (const block of blocks) {
            const key = JSON.stringify([block.text, block.supportMode, block.factIds, block.capabilityStatus, block.capabilityOwnership])
            if (!bodyKeys.has(key)) { bodyKeys.add(key); body.push({ ...block, id: `${node.key}-${body.length + 1}` }) }
          }
        }
        const consume = (raw, sourceCards, view) => {
          const materialized = materializeCombined(raw, sourceCards, evidence, node, rule)
          const referenceAudit = materialized.referenceAudit || { normalized: [], rejected: [] }
          diagnostics.referenceIdRepairs += referenceAudit.normalized.length
          diagnostics.referenceIdRejectedFacts += referenceAudit.rejected.length
          diagnostics.referenceIdMismatches += referenceAudit.normalized.length + referenceAudit.rejected.length
          if (referenceAudit.rejected.length) addDiagnostic(diagnostics, 'reference_id_mismatch')
          diagnostics.referenceExamples = strings([...(diagnostics.referenceExamples || []), ...referenceAudit.rejected.flatMap(row => row.sourceCardIds || [])]).slice(0, 3)
          diagnostics.selectedFacts += materialized.facts.length
          diagnostics.excludedFacts += materialized.excludedFacts.length
          if (materialized.excludedFacts.length) {
            const reasons = materialized.excludedFacts.flatMap(fact => list(fact.exclusionReasons))
            addDiagnostic(diagnostics, reasons.some(reason => /用途|(?:purpose|subject)=|本章只接受|正向事实|不是合作案例/u.test(reason))
              ? 'purpose_mismatch' : 'material_not_applicable')
          }
          for (const card of materialized.cards) allCards.set(card.id, card)
          if (!recoveryCards.length && materialized.cards.length) recoveryCards = materialized.cards
          extraction.facts.push(...materialized.facts)
          issues.push(...materialized.reviewItems, ...strings(raw?.reviewItems))
          const checked = annotateDraft(view ? list(view.sections).filter(row => row?.key === node.key).flatMap(row => list(row.blocks))
            : materialized.blocks, materialized.cards, evidence, node, plan)
          return { materialized, checked, referenceAudit }
        }
        const persistPartial = async () => {
          extraction.reviewItems = strings(issues)
          await writeJson(path.join(chapterDir, 'extraction.json'), extraction)
          await writeJson(path.join(chapterDir, 'cards.json'), { cards: [...allCards.values()] })
          await writeJson(path.join(chapterDir, 'writing-partial.json'), { sections: [{ key: node.key, blocks: body }] })
        }
        if (resume && !restored && previousReport?.ruleFingerprint === rules.fingerprint
          && previousReport.confirmedPlan?.planId === args.plan_id && previousReport.confirmedPlan?.sha256 === args.plan_sha256) {
          // Legacy runs still retry conservatively, but a new failure must not erase verified old paragraphs.
          const legacy = await resolveChapterCards({ chapterDir, evidence, node, rule })
          const oldSection = list(previousReport.sections).find(row => row.key === node.key)
          for (const card of legacy.cards) allCards.set(card.id, card)
          const retained = annotateDraft(oldSection?.blocks, legacy.cards, evidence, node, plan)
          addBlocks(retained.section.blocks.filter(block => list(block.evidence).length))
          diagnostics.retainedLegacyBlocks = body.length
        }
        for (const [batchIndex, sourceCards] of batches.entries()) {
          if (exec.signal?.aborted) throw abortError(exec.signal)
          const factsBefore = extraction.facts.length
          const previous = restored?.batches[batchIndex]
          let referenceAudit = { normalized: [], rejected: [] }, batchHasProse = false
          for (const saved of previous?.outputs || []) {
            const replay = consume(saved.raw, sourceCards, saved.view)
            issues.push(...replay.checked.issues)
            addBlocks(replay.checked.section.blocks)
            batchHasProse ||= replay.checked.section.blocks.length > 0
            referenceAudit = replay.referenceAudit
          }
          let partial = !previous?.completed
          if (previous?.completed) progress.reusedBatches++
          else {
            progress.status = 'writing'; progress.writeAttempts++; await saveState()
            let raw, partialOutput, cancelled = false
            try {
              raw = await request(draftWritePrompt({ common, node, rule, cards: sourceCards,
                plan: chapterPlan(plan, node), combined: true,
                ...(body.length ? { instruction: '继续本章尚未展开的主题，不重复最近已写内容', blocks: body.slice(-8).map(block => ({ text: block.text.slice(0, 120) })) } : {}) }), { sourceCards })
              partial = false
            } catch (error) {
              cancelled = Boolean(exec.signal?.aborted)
              const reason = modelReason(error)
              addDiagnostic(diagnostics, reason); diagnostics.modelFailures++
              if (reason === 'model_timeout') diagnostics.modelTimeouts++
              partial = true; issues.push(`本章撰写未完整结束：${error.message}`)
              partialOutput = String(error.partialOutput || '')
              raw = partialCombinedResponse(partialOutput)
              // Only the one truly keyless legacy section can belong to this single-chapter request.
              if (raw.sections.length === 1 && !Object.hasOwn(raw.sections[0], 'key')) raw.sections[0].key = node.key
            }
            // Preserve legacy first-attempt drafts; every new attempt has its own immutable archive path.
            try { await readFile(path.join(chapterDir, `draft-${batchIndex + 1}.json`)) }
            catch (error) { if (error.code !== 'ENOENT') throw error; await writeJson(path.join(chapterDir, `draft-${batchIndex + 1}.json`), raw) }
            const consumed = consume(raw, sourceCards)
            let checked = consumed.checked
            referenceAudit = consumed.referenceAudit
            if (!cancelled && args.quality_mode === 'standard' && !repaired && checked.issues.length && checked.section.blocks.length) {
              repaired = true
              try {
                progress.writeAttempts++; await saveState()
                const repair = await request(draftWritePrompt({ common, node, rule, cards: consumed.materialized.cards, plan: chapterPlan(plan, node),
                  instruction: `修正本章问题，保留其他内容：${checked.issues.join('；')}`, blocks: checked.section.blocks }))
                const next = annotateDraft(list(repair.sections).filter(row => row.key === node.key).flatMap(row => list(row.blocks)), consumed.materialized.cards, evidence, node, plan)
                if (next.section.blocks.length) checked = next
              } catch (error) { issues.push(`单轮修正未完成，保留初稿：${error.message}`) }
            }
            issues.push(...checked.issues)
            addBlocks(checked.section.blocks)
            batchHasProse ||= checked.section.blocks.length > 0
            partial ||= !checked.section.blocks.length
            await saveDraftBatch({ chapterDir, checkpoint, batchIndex, attempt, raw,
              status: partial ? 'partial' : 'completed', partialOutput, view: { sections: [checked.section] } })
            if (cancelled || exec.signal?.aborted) { await persistPartial(); throw abortError(exec.signal) }
          }
          if (partial) {
            diagnostics.emptyBatches++
            issues.push(`第${batchIndex + 1}批${batchHasProse ? '尚未完整结束' : '未返回适合本章的正文'}；已保留其他批次内容，可按章补充或重试`)
          }
          extraction.batches.push({ batchId: String(batchIndex + 1), status: partial ? 'partial' : 'completed',
            facts: extraction.facts.length - factsBefore, reused: Boolean(previous?.completed), sourceCardIds: sourceCards.map(card => card.id),
            evidenceIds: [...new Set(sourceCards.flatMap(card => card.evidence.map(ref => ref.id)))], referenceAudit })
          await persistPartial()
        }
        // Keep an earlier bounded prose recovery too; it cannot mark unfinished source batches complete.
        for (const saved of restored?.recoveryOutputs || []) {
          const checked = annotateDraft(list(saved.raw.sections).filter(row => row?.key === node.key).flatMap(row => list(row.blocks)),
            [...allCards.values()], evidence, node, plan)
          issues.push(...checked.issues)
          addBlocks(checked.section.blocks.filter(block => list(block.evidence).length))
        }
        cards = [...allCards.values()]
        // Only an empty chapter with verified, suitable cards gets one bounded prose-only recovery.
        // It does not repeat retrieval, extraction, successful chapters, or the whole report.
        if (!body.length && recoveryCards.length && !repaired) {
          diagnostics.recoveryAttempts = 1
          const selected = itemBatches(recoveryCards, 6000, 6)[0]
          let raw, partialOutput, cancelled = false
          try {
            progress.status = 'writing'; progress.writeAttempts++; await saveState()
            raw = await request(draftWritePrompt({ common, node, rule, cards: selected, plan: chapterPlan(plan, node),
              instruction: '已有可核对事实但本章正文为空。仅使用这些事实卡写3至6段，factIds填写卡片完整id；不重新提取或补造事实。', blocks: [] }))
          } catch (error) {
            cancelled = Boolean(exec.signal?.aborted)
            addDiagnostic(diagnostics, modelReason(error)); diagnostics.modelFailures++
            if (modelReason(error) === 'model_timeout') diagnostics.modelTimeouts++
            issues.push(`单章补写未完成，已核验事实卡保留：${error.message}`)
            partialOutput = String(error.partialOutput || '')
            raw = partialCombinedResponse(partialOutput)
          }
          await saveDraftRecovery({ chapterDir, checkpoint, attempt, raw, partialOutput })
          try { await readFile(path.join(chapterDir, 'recovery-draft.json')) }
          catch (error) { if (error.code !== 'ENOENT') throw error; await writeJson(path.join(chapterDir, 'recovery-draft.json'), raw) }
          const checked = annotateDraft(list(raw?.sections).filter(row => row?.key === node.key).flatMap(row => list(row.blocks)), selected, evidence, node, plan)
          issues.push(...checked.issues)
          addBlocks(checked.section.blocks.filter(block => list(block.evidence).length))
          diagnostics.recoveredBlocks = body.length
          if (cancelled || exec.signal?.aborted) { await persistPartial(); throw abortError(exec.signal) }
          await writeJson(path.join(chapterDir, 'writing-partial.json'), { sections: [{ key: node.key, blocks: body }] })
        }
        section = { key: node.key, title: node.title, roleId: node.roleId,
          ...(node.framework ? { framework: node.framework } : {}), blocks: body }
        if (!body.length) {
          if (!diagnostics.reasonCode) addDiagnostic(diagnostics, 'no_prose')
          const fault = diagnostics.referenceIdRejectedFacts > 0 || diagnostics.modelFailures > 0 || cards.length > 0
            || diagnostics.reasonCodes.includes('no_prose')
          section = inputCard(node, rule, fault ? `本章生成未完成（${diagnostics.reasonCode}），不能据此判断知识库缺料。详细原因见逐章故障和审核记录。`
            : issues[0] || '知识库材料尚不能支持本章正文，请补充对应事实或按章重试')
          status = fault ? 'failed' : 'needs_input'
          if (fault) section.inputNeeded = { ...section.inputNeeded, kind: 'generation_error', questions: [],
            nextAction: '已保存证据和模型草稿；可用本章 revise 恢复卡池后补写，或显式 resume 接续。' }
        } else status = extraction.batches.some(batch => batch.status === 'partial') ? 'partial' : 'draft_unverified'
        await writeJson(path.join(chapterDir, 'draft.json'), { sections: [section] })
      }
      if (!progress.knowledgeHits && !diagnostics.reusedEvidence) issues.push('本章当次检索零命中；规划锚点不算本章新命中，请补查')
    } catch (error) {
      if (exec.signal?.aborted) { progress.status = 'cancelled'; await saveState(); throw abortError(exec.signal) }
      if (!diagnostics.reasonCode) addDiagnostic(diagnostics, 'generation_failed')
      issues.push(error.message)
      section = inputCard(node, rule, `本章生成未完成（${diagnostics.reasonCode}），详细原因见审核记录，不能据此判断缺料。`); status = 'failed'
      section.inputNeeded = { ...section.inputNeeded, kind: 'generation_error', questions: [], nextAction: '查看逐章故障记录后恢复或重试本章。' }
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
    status: 'failed', reviewItems: [result.reason.message] })
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
    validationIssues: [], gaps: chapters.filter(chapter => ['needs_input', 'failed'].includes(chapter.status))
      .map(chapter => `${chapter.section.key}：${chapter.status === 'failed' ? '生成故障，已保留可恢复记录' : '待补材料或按章重试'}`),
    review: state.review, chapterOutcomes: state.chapters }
}

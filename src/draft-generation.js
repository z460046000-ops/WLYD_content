import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { flattenOutline } from './rules.js'
import { mapConcurrent, abortError } from './scheduler.js'
import { createRequester, commonContext, chapterPlan, writeJson, list, strings } from './context.js'
import { collectFacts } from './facts.js'
import { routeFacts } from './evidence-policy.js'
import { factCards, annotateDraft, inputCard, partialProse } from './fact-cards.js'
import { reviewAssembly } from './review.js'

export function draftWritePrompt({ common, node, rule, cards, plan, instruction, blocks }) {
  return { stage: 'write', qualityMode: 'draft', author: common.author, audience: common.audience, chapter: node,
    task: '写本章可供用户修改的完整初稿。短标题、短语概括后解释业务动作；复用主线编号维持前后关联。只返回JSON。引用factIds，不抄引文、不创建事实卡。推演标candidate，未知数字、客户、能力状态和企业资质不要当事实。',
    chapterRule: { write: rule.write || [] }, plan,
    facts: cards.map(({ evidence, ...card }) => card),
    ...(instruction ? { instruction, currentBlocks: blocks } : { lengthGuidance: '本章一次完成，围绕关键主题写3至6段；重点业务/场景充分说明动作和价值，避免重复凑字' }),
    schema: { sections: [{ key: node.key, blocks: [{ text: '本章正文', factIds: ['输入事实卡ID'],
      supportMode: 'sourced/candidate', planRefs: { capabilityIds: [], scenarioIds: [], problemIds: [], trendIds: [] } }] }], reviewItems: [] } }
}

/** Fast first pass: one write per chapter; quality issues remain visible for later iteration. */
export async function generateFastDraft({ llm, exec, args, rules, outline, evidence, dir, state, saveState, retrieval, acceptedPlan, resume }) {
  const request = await createRequester({ llm, exec, state, saveState })
  const common = commonContext(rules, args), plan = acceptedPlan, nodes = flattenOutline(outline)
  const prior = new Map((resume ? state.chapters || [] : []).map(row => [row.key, row]))
  state.planning = { status: 'confirmed', planId: args.plan_id }
  state.status = 'generating'; state.qualityMode = args.quality_mode; state.chapterScheduling = 'all-parallel'; state.concurrency = 8
  state.chapters = nodes.map(node => ({ key: node.key, title: node.title, status: 'queued' }))
  await writeJson(path.join(dir, 'plan.json'), { ...plan, outline, ruleFingerprint: rules.fingerprint,
    confirmation: { planId: args.plan_id, sha256: args.plan_sha256 } })
  await saveState()
  const results = await mapConcurrent(nodes, async (node, index) => {
    const progress = state.chapters[index], chapterDir = path.join(dir, 'chapters', node.key)
    const rule = rules.chapters[node.roleId] || rules.global.customChapter
    await mkdir(path.join(chapterDir, 'versions'), { recursive: true, mode: 0o700 })
    let section, cards = [], issues = [], status = 'draft_unverified'
    try {
      progress.status = 'retrieving'; await saveState()
      const found = await retrieval.forChapter(node, plan)
      const sources = found.filter(source => source.kind === 'knowledge')
      progress.knowledgeHits = retrieval.chapterKnowledgeHits?.(node.key).length || 0
      progress.knowledgeQueries = retrieval.chapterKnowledgeQueries?.(node.key) || 0
      progress.knowledgeStatus = progress.knowledgeHits ? 'matched' : 'empty'
      if (resume && ['completed', 'draft_unverified'].includes(prior.get(node.key)?.status)) {
        try {
          const old = JSON.parse(await readFile(path.join(chapterDir, 'chapter.json'), 'utf8'))
          if (old.section?.blocks?.length && old.section.blocks.every(block => list(block.evidence).every(ref =>
            evidence.some(source => source.id === ref.id && source.content.includes(ref.quote))))) {
            Object.assign(progress, prior.get(node.key), { reusedChapter: true, knowledgeHits: progress.knowledgeHits,
              knowledgeQueries: progress.knowledgeQueries, knowledgeStatus: progress.knowledgeStatus })
            if (!progress.knowledgeHits) progress.status = 'draft_unverified'
            await saveState(); return old
          }
        } catch { /* Missing or invalid chapter is generated again. */ }
      }
      if (!sources.length) {
        section = inputCard(node, rule, '本章知识库没有可用片段，请补充材料或调整章节要求')
        status = 'needs_input'
      } else {
        progress.status = 'extracting'; await saveState()
        const extraction = await collectFacts({ request, common, node, rule, evidence: sources, plan: chapterPlan(plan, node),
          signal: exec.signal, tolerant: args.quality_mode === 'draft', onProgress: partial => writeJson(path.join(chapterDir, 'extraction-partial.json'), partial) })
        await writeJson(path.join(chapterDir, 'extraction.json'), extraction)
        const routed = routeFacts(extraction.facts, node, rule)
        cards = factCards(routed.facts)
        issues.push(...extraction.reviewItems, ...routed.reviewItems)
        await writeJson(path.join(chapterDir, 'cards.json'), { cards })
        if (!cards.length) {
          section = inputCard(node, rule, '知识库命中材料尚不能支持本章内容，请补充对应事实')
          status = 'needs_input'
        } else {
          progress.status = 'writing'; progress.writeAttempts = 1; await saveState()
          let raw
          try { raw = await request(draftWritePrompt({ common, node, rule, cards, plan: chapterPlan(plan, node) })) }
          catch (error) {
            if (exec.signal?.aborted) throw error
            issues.push(`本章撰写未完整结束：${error.message}`)
            raw = { sections: [{ key: node.key, blocks: partialProse(error.partialOutput) }] }
          }
          await writeJson(path.join(chapterDir, 'draft.json'), raw)
          let checked = annotateDraft(list(raw.sections).filter(row => row.key === node.key).flatMap(row => list(row.blocks)), cards, evidence, node, plan)
          if (args.quality_mode === 'standard' && checked.issues.length && checked.section.blocks.length) {
            try {
              progress.writeAttempts++; await saveState()
              const repaired = await request(draftWritePrompt({ common, node, rule, cards, plan: chapterPlan(plan, node),
                instruction: `修正本章问题，保留其他内容：${checked.issues.join('；')}`, blocks: checked.section.blocks }))
              const next = annotateDraft(list(repaired.sections).filter(row => row.key === node.key).flatMap(row => list(row.blocks)), cards, evidence, node, plan)
              if (next.section.blocks.length) checked = next
            } catch (error) { if (exec.signal?.aborted) throw error; issues.push(`单轮修正未完成，保留初稿：${error.message}`) }
          }
          section = checked.section; issues.push(...checked.issues, ...strings(raw.reviewItems))
          if (!section.blocks.length) {
            section = inputCard(node, rule, issues[0] || '本章暂未返回正文，请按章重试')
            status = 'needs_input'
          } else status = 'draft_unverified'
        }
      }
      if (!progress.knowledgeHits) issues.push('本章当次检索零命中；规划锚点不算本章新命中，请补查')
    } catch (error) {
      if (exec.signal?.aborted) { progress.status = 'cancelled'; await saveState(); throw abortError(exec.signal) }
      issues.push(error.message)
      section = inputCard(node, rule, `本章暂未完成：${error.message}`); status = 'needs_input'
    }
    const version = (prior.get(node.key)?.version || 0) + 1
    const chapter = { section, status, version, reviewItems: strings(issues), validationIssues: [], gaps: [],
      generatedAt: new Date().toISOString() }
    await writeJson(path.join(chapterDir, 'chapter.json'), chapter)
    await writeJson(path.join(chapterDir, 'versions', `${version}.json`), chapter)
    Object.assign(progress, { status, version, evidenceCount: cards.length, reviewItems: chapter.reviewItems,
      path: `chapters/${node.key}/chapter.json` })
    await saveState()
    return chapter
  }, { concurrency: Math.max(1, nodes.length), signal: exec.signal })
  if (exec.signal?.aborted) throw abortError(exec.signal)
  const chapters = results.map((result, index) => result.status === 'fulfilled' ? result.value : {
    section: inputCard(nodes[index], rules.chapters[nodes[index].roleId] || {}, result.reason.message),
    status: 'needs_input', reviewItems: [result.reason.message] })
  const sections = chapters.map(chapter => chapter.section)
  // Draft checks run once and annotate; no automatic repairs, panorama round, or recheck loop.
  const reviewed = await reviewAssembly({ request, common: { ...common, qualityMode: 'draft' }, plan, outline,
    sections, evidence, dir, state, saveState, signal: exec.signal, ruleFingerprint: rules.fingerprint,
    allowRepairs: false, splitOnResource: false })
  state.review.passed = false
  await saveState()
  return { title: plan.title, outline, sections, choices: plan.choices, assemblyLinks: [],
    reviewItems: strings([...list(plan.reviewItems), ...retrieval.issues, ...chapters.flatMap(chapter => chapter.reviewItems),
      ...reviewed.reviewItems, '初稿待逐章审阅；引用可定位不代表表述已获业务确认']),
    validationIssues: [], gaps: chapters.filter(chapter => chapter.status === 'needs_input').map(chapter => `${chapter.section.key}：待补材料或按章重试`),
    review: state.review, chapterOutcomes: state.chapters }
}

import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { atomicJson, readJson } from '../persistence.js'
import { sourceCardBatches } from '../combined-writing.js'

const list = value => Array.isArray(value) ? value : []
const hash = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const ids = cards => [...new Set(cards.flatMap(card => card.evidence.map(ref => ref.id)))]
const refsValid = (blocks, evidence) => list(blocks).every(block => block && typeof block === 'object' && list(block.evidence).every(ref =>
  typeof ref?.quote === 'string' && ref.quote.length >= 6 && evidence.some(source => source.id === ref.id && source.content.includes(ref.quote))))
const optional = async (file, fallback = null) => {
  try { return await readJson(file, fallback) } catch (error) { if (error instanceof SyntaxError) return fallback; throw error }
}

export function draftBinding({ args, rules, outline, node, plan, state }) {
  return hash(JSON.stringify(canonical({ version: 1, planId: args.plan_id, planSha256: args.plan_sha256,
    ruleFingerprint: rules.fingerprint, outline, node, plan, qualityMode: args.quality_mode,
    sourceRunId: args.source_run_id || null, projectId: args.project_id || null,
    materialSha256: state.materialSha256 || null, modelSelection: state.modelSelection || null })))
}

/** All inputs here have already passed restoreEvidence under the current project permissions. */
export async function loadDraftCheckpoint({ chapterDir, bindingSha256, evidence, attempt }) {
  const saved = await optional(path.join(chapterDir, 'draft-checkpoint.json'))
  if (!saved || saved.schemaVersion !== 1 || saved.bindingSha256 !== bindingSha256
    || !Number.isSafeInteger(saved.attempt) || saved.attempt < 0 || saved.attempt > attempt || !list(saved.sources).length) return null
  if (saved.retrieval?.diagnostics?.failedQueries || saved.retrieval?.diagnostics?.partialQueries
    || list(saved.retrieval?.diagnostics?.reasonCodes).some(code => ['retrieval_failed', 'retrieval_partial'].includes(code))) return null
  const sources = list(saved.sources).map(row => evidence.find(source => source.kind === 'knowledge' && source.id === row?.id && hash(source.content) === row?.sha256))
  if (sources.some(source => !source) || new Set(sources.map(source => source.id)).size !== sources.length) return null
  const expected = sourceCardBatches(sources), batches = [], records = []
  for (const [index, cards] of expected.entries()) {
    const row = list(saved.batches).find(batch => batch?.batchId === String(index + 1))
    const output = [], validRecords = []
    if (row && equal(row.sourceCardIds, cards.map(card => card.id)) && equal(row.evidenceIds, ids(cards))) {
      for (const record of list(row.outputs)) {
        if (!record || !Number.isSafeInteger(record.attempt) || record.attempt < 0 || record.attempt > attempt
          || !['completed', 'partial'].includes(record.status)
          || record.rawPath !== `attempts/${record.attempt}/batch-${index + 1}.json`) continue
        try {
          const text = await readFile(path.join(chapterDir, record.rawPath), 'utf8')
          if (hash(text) !== record.rawSha256) continue
          const raw = JSON.parse(text)
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
          let view
          if (record.viewPath && record.viewPath !== `attempts/${record.attempt}/batch-${index + 1}.view.json`) continue
          if (record.viewPath === `attempts/${record.attempt}/batch-${index + 1}.view.json`) {
            const viewText = await readFile(path.join(chapterDir, record.viewPath), 'utf8')
            if (hash(viewText) !== record.viewSha256) continue
            view = JSON.parse(viewText)
            if (!view || typeof view !== 'object' || Array.isArray(view)) continue
          }
          output.push({ ...record, raw, view }); validRecords.push(record)
        } catch (error) { if (!['ENOENT'].includes(error.code) && !(error instanceof SyntaxError)) throw error }
      }
    }
    batches.push({ cards, outputs: output, completed: output.some(record => record.status === 'completed') })
    records.push({ batchId: String(index + 1), sourceCardIds: cards.map(card => card.id), evidenceIds: ids(cards), outputs: validRecords })
  }
  const hits = list(saved.retrieval?.knowledgeHitIds)
  if (hits.some(id => !evidence.some(source => source.kind === 'knowledge' && source.id === id))) return null
  const recoveryOutputs = []
  for (const record of list(saved.recoveryOutputs)) {
    if (!record || !Number.isSafeInteger(record.attempt) || record.attempt < 0 || record.attempt > attempt
      || record.rawPath !== `attempts/${record.attempt}/recovery.json`) continue
    try {
      const text = await readFile(path.join(chapterDir, record.rawPath), 'utf8')
      if (hash(text) !== record.rawSha256) continue
      const raw = JSON.parse(text)
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) recoveryOutputs.push({ ...record, raw })
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
  }
  return { sources, batches, recoveryOutputs, checkpoint: { ...saved, batches: records,
    recoveryOutputs: recoveryOutputs.map(({ raw, ...record }) => record) } }
}

export function createDraftCheckpoint({ bindingSha256, attempt, sources, retrieval }) {
  return { schemaVersion: 1, bindingSha256, attempt,
    sources: sources.map(source => ({ id: source.id, sha256: hash(source.content) })), retrieval,
    batches: sourceCardBatches(sources).map((cards, index) => ({ batchId: String(index + 1),
      sourceCardIds: cards.map(card => card.id), evidenceIds: ids(cards), outputs: [] })) }
}

/** Append attempts instead of replacing earlier partial responses or completed batch output. */
export async function saveDraftBatch({ chapterDir, checkpoint, batchIndex, attempt, raw, status, partialOutput, view }) {
  const relative = `attempts/${attempt}/batch-${batchIndex + 1}`, rawPath = `${relative}.json`
  await mkdir(path.join(chapterDir, 'attempts', String(attempt)), { recursive: true, mode: 0o700 })
  if (typeof partialOutput === 'string') await writeFile(path.join(chapterDir, `${relative}.partial.txt`), partialOutput, { mode: 0o600 })
  await atomicJson(path.join(chapterDir, rawPath), raw)
  const bytes = await readFile(path.join(chapterDir, rawPath))
  const viewPath = `${relative}.view.json`
  if (view) await atomicJson(path.join(chapterDir, viewPath), view)
  const row = checkpoint.batches[batchIndex]
  row.outputs = [...list(row.outputs).filter(record => record.attempt !== attempt), { attempt, status, rawPath, rawSha256: hash(bytes),
    ...(view ? { viewPath, viewSha256: hash(await readFile(path.join(chapterDir, viewPath))) } : {}),
    ...(typeof partialOutput === 'string' ? { partialPath: `${relative}.partial.txt`, partialSha256: hash(partialOutput) } : {}) }]
  checkpoint.attempt = attempt
  await atomicJson(path.join(chapterDir, 'draft-checkpoint.json'), checkpoint)
}

export async function saveDraftRecovery({ chapterDir, checkpoint, attempt, raw, partialOutput }) {
  const relative = `attempts/${attempt}/recovery`, rawPath = `${relative}.json`
  await mkdir(path.join(chapterDir, 'attempts', String(attempt)), { recursive: true, mode: 0o700 })
  await atomicJson(path.join(chapterDir, rawPath), raw)
  if (typeof partialOutput === 'string') await writeFile(path.join(chapterDir, `${relative}.partial.txt`), partialOutput, { mode: 0o600 })
  checkpoint.recoveryOutputs = [...list(checkpoint.recoveryOutputs).filter(record => record.attempt !== attempt),
    { attempt, rawPath, rawSha256: hash(await readFile(path.join(chapterDir, rawPath))),
      ...(typeof partialOutput === 'string' ? { partialPath: `${relative}.partial.txt`, partialSha256: hash(partialOutput) } : {}) }]
  await atomicJson(path.join(chapterDir, 'draft-checkpoint.json'), checkpoint)
}

export async function reusableDraftChapter({ chapterDir, previousReport, prior, args, rules, evidence, node, checkpoint }) {
  if (!previousReport || previousReport.ruleFingerprint !== rules.fingerprint
    || previousReport.confirmedPlan?.planId !== args.plan_id || previousReport.confirmedPlan?.sha256 !== args.plan_sha256) return null
  // A present but invalid checkpoint must not silently become a legacy full-chapter cache hit.
  if (!checkpoint) {
    try { await readFile(path.join(chapterDir, 'draft-checkpoint.json')); return null }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const stored = await optional(path.join(chapterDir, 'chapter.json'))
  const outcome = list(previousReport.chapterOutcomes).find(row => row.key === node.key)
  const section = list(previousReport.sections).find(row => row.key === node.key)
  const currentStatus = outcome?.status || prior?.status
  if (!section || !stored || !refsValid(section.blocks, evidence)) return null
  const retrieval = await optional(path.join(chapterDir, 'retrieval.json'))
  const knownIds = list(retrieval?.evidenceIds)
  if (!knownIds.length || knownIds.some(id => !evidence.some(source => source.id === id))
    || !knownIds.some(id => evidence.some(source => source.id === id && source.kind === 'knowledge'))) return null
  const hasProse = list(section.blocks).some(block => typeof block.text === 'string' && block.text.trim())
  const diagnostics = outcome?.diagnostics || stored.diagnostics || {}
  const reasons = list(diagnostics.reasonCodes)
  const safeMissing = currentStatus === 'needs_input' && !hasProse && reasons.length > 0
    && reasons.every(reason => ['purpose_mismatch', 'material_not_applicable'].includes(reason))
    && !diagnostics.modelFailures && !diagnostics.referenceIdRejectedFacts && !diagnostics.failedQueries && !diagnostics.partialQueries
    && retrieval.knowledgeHitCount > 0
    && list(retrieval.queries).length > 0 && list(retrieval.queries).every(query => query.status === 'completed' && !query.partial)
  const whole = ['completed', 'draft_unverified'].includes(currentStatus) && hasProse
    && (checkpoint ? checkpoint.batches.length > 0 && checkpoint.batches.every(batch => batch.completed)
      : !diagnostics.modelFailures && !diagnostics.emptyBatches)
  if (!whole && !safeMissing) return null
  const version = previousReport.chapterRecords?.[node.key]?.version || outcome?.version || stored.version
  return { chapter: { ...stored, section: structuredClone(section), status: currentStatus, version,
    diagnostics: { ...diagnostics, reusedChapter: true, reusedNeedsInput: safeMissing } }, retrieval }
}

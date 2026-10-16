import { flattenOutline } from '../rules.js'

const list = value => Array.isArray(value) ? value : []
const active = new Set(['pending', 'queued', 'retrieving', 'extracting', 'writing', 'validating'])
const prose = section => list(section?.blocks).filter(block => typeof block?.text === 'string' && block.text.trim())

/** Counts prose against the confirmed outline. A material card is never a chapter of prose. */
export function coverageFromReport(report = {}) {
  const sections = new Map(list(report.sections).map(section => [section.key, section]))
  const outcomes = new Map(list(report.chapterOutcomes).map(row => [row.key, row]))
  const chapterDiagnostics = flattenOutline(list(report.outline)).map(node => {
    const section = sections.get(node.key), row = outcomes.get(node.key) || {}
    const blocks = prose(section)
    const status = row.status || section?.status || (blocks.length ? 'completed' : 'pending')
    const diagnostics = structuredClone(row.diagnostics || section?.diagnostics || {})
    const reasonCode = diagnostics.reasonCode || (active.has(status) ? 'pending' : status === 'omitted' ? 'omitted'
      : diagnostics.failedQueries > 0 && !blocks.length ? 'retrieval_failed'
        : diagnostics.partialQueries > 0 && !blocks.length ? 'retrieval_partial'
          : diagnostics.knowledgeHits === 0 && diagnostics.successfulQueries > 0 && !blocks.length ? 'zero_knowledge_hits'
          : blocks.length ? null : 'no_prose')
    return { key: node.key, title: node.title, required: node.required !== false, status,
      hasProse: blocks.length > 0, blockCount: blocks.length, reasonCode, diagnostics }
  })
  const count = predicate => chapterDiagnostics.filter(predicate).length
  const totalChapters = chapterDiagnostics.length, proseChapters = count(row => row.hasProse)
  return { totalChapters, proseChapters, proseRatio: totalChapters ? proseChapters / totalChapters : 0,
    prosePercent: totalChapters ? Math.round(proseChapters / totalChapters * 1000) / 10 : 0,
    blockCount: chapterDiagnostics.reduce((sum, row) => sum + row.blockCount, 0),
    needsInputChapters: count(row => row.status === 'needs_input'), omittedChapters: count(row => row.status === 'omitted'),
    partialChapters: count(row => row.status === 'partial'), pendingChapters: count(row => active.has(row.status)),
    failedChapters: count(row => ['failed', 'cancelled'].includes(row.status)),
    draftChapters: count(row => row.status === 'draft_unverified'), completedChapters: count(row => row.status === 'completed'),
    chapterDiagnostics }
}

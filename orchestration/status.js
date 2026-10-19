import { createHash } from 'node:crypto'

/** Keep raw run/model traces on disk and in explicit detail views, outside normal model context. */
export function statusSummary(state) {
  const coverage = state.contentCoverage
  const count = coverage ? Object.fromEntries(['totalChapters', 'proseChapters', 'prosePercent', 'contentStatus', 'needsInputChapters', 'failedChapters', 'partialChapters', 'pendingChapters'].map(key => [key, coverage[key]])) : undefined
  return { runId: state.runId, kind: state.kind || (state.files ? 'ingest' : 'outline-plan'), status: state.status,
    ...(state.runtimeVersion ? { runtimeVersion: state.runtimeVersion, contractVersion: state.contractVersion } : {}),
    ...(state.jobId ? { jobId: state.jobId } : {}),
    ...(state.progress ? { progress: state.progress } : {}), ...(count ? { contentCoverage: count } : {}),
    reportReady: Boolean(state.reportReady), ...(state.reportPath ? { reportPath: state.reportPath, jsonPath: state.jsonPath, reviewPath: state.reviewPath } : {}),
    ...(state.delivery ? { delivery: state.delivery } : {}),
    ...(state.review ? { review: { status: state.review.status, passed: Boolean(state.review.passed) } } : {}),
    ...(state.files ? { files: state.files.map(file => ({ name: file.name, status: file.status, uploadStatus: file.uploadStatus,
      ...(file.statusError || file.uploadError ? { error: String(file.statusError || file.uploadError).slice(0, 180) } : {}) })) } : {}),
    ...(state.error ? { error: String(state.error).slice(0, 240) } : {}),
    ...(state.firstChapterReadyAt ? { firstChapterReadyAt: state.firstChapterReadyAt } : {}),
    ...(state.draftReadyAt ? { draftReadyAt: state.draftReadyAt } : {}),
    ...(state.reviewFinishedAt ? { reviewFinishedAt: state.reviewFinishedAt } : {}),
    ...(state.finishedAt ? { finishedAt: state.finishedAt } : {}),
    ...(state.nextAction ? { nextAction: state.nextAction } : {}) }
}

export function createStatusRenderer() {
  const history = new Map()
  return (args, state) => {
    if (args.view === 'detail') return [{ type: 'text', text: JSON.stringify(state, null, 2) }]
    const summary = statusSummary(state)
    const revision = createHash('sha256').update(JSON.stringify(summary)).digest('hex').slice(0, 20)
    const key = `${state.runId}:${state.actorDshId || ''}:${revision}`
    const previous = args.after_revision ? history.get(`${state.runId}:${state.actorDshId || ''}:${args.after_revision}`) : null
    const changed = args.after_revision !== revision
    let value = { ...summary, revision, changed }
    if (!changed) value = { runId: state.runId, status: state.status, revision, changed: false }
    else if (previous) value = { runId: state.runId, revision, changed: true,
      changes: Object.fromEntries([...new Set([...Object.keys(previous), ...Object.keys(summary)])]
        .filter(field => JSON.stringify(previous[field]) !== JSON.stringify(summary[field])).map(field => [field, summary[field] ?? null])) }
    history.set(key, summary)
    if (history.size > 256) history.delete(history.keys().next().value)
    return [{ type: 'text', text: JSON.stringify(value) }]
  }
}

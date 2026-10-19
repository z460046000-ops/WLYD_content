import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { authorizeContent } from './authorize.js'
import { atomicJson, readJson, claimRun } from '../persistence.js'
import { rootOf, sha256 } from '../store.js'
import { createSnapshot } from '../content/snapshot.js'
import { createRequester } from '../context.js'
import { resolveWritingModel } from '../model.js'
import { DIAGRAM_KINDS, buildDiagram } from '../outputs/diagrams/plan.js'
import { renderDiagram } from '../outputs/diagrams/render.js'

const rendererVersion = createRequire(import.meta.url)('../../package.json').version
const finished = new Set(['draft_ready', 'needs_human_review', 'partial_draft', 'failed', 'cancelled'])
const active = value => ['queued', 'running'].includes(value?.status)
const summary = value => value ? { runId: value.runId, exportId: value.exportId, format: 'diagrams', jobId: value.jobId || null,
  status: value.status, sourceContentSha256: value.sourceContentSha256, stale: Boolean(value.stale),
  diagramsReady: DIAGRAM_KINDS.every(kind => value.diagrams[kind]?.status === 'completed'),
  diagrams: value.diagrams, ...(value.note ? { note: value.note } : {}), ...(value.error ? { error: value.error } : {}) }
  : { format: 'diagrams', status: 'not_started', diagramsReady: false, diagrams: {} }

/** Manual first-stage output. Its pointer/jobs never replace the existing document/HTML delivery. */
export function createDiagramService({ jobs, client, llm, modelRoute, python = 'python3', build = buildDiagram, render = renderDiagram }) {
  const live = new Map(), detach = jobs.attachController('wlyd-assembly-diagrams')
  let closing = false
  const authorize = (runId, exec) => authorizeContent(client, runId, exec)
  const current = async (runId, exec) => {
    const { dir, report } = await authorize(runId, exec)
    const pointer = await readJson(path.join(dir, 'diagram-delivery.json'), null)
    if (!pointer) return null
    if (!/^[a-f\d-]{36}$/iu.test(pointer.exportId)) throw new Error('无效的架构图输出记录')
    const outputDir = path.join(dir, 'diagrams', pointer.exportId), manifest = await readJson(path.join(outputDir, 'manifest.json'))
    const value = { ...manifest, stale: manifest.sourceContentSha256 !== createSnapshot(report).sourceContentSha256 }
    if (value.stale) value.note = '文案已更新，这两图基于旧版文案'
    for (const kind of DIAGRAM_KINDS) {
      const item = value.diagrams[kind]
      if (item?.status !== 'completed') continue
      try {
        if (!item.path.startsWith(outputDir + path.sep) || sha256(await readFile(item.path)) !== item.sha256
          || !item.planPath.startsWith(outputDir + path.sep) || sha256(await readFile(item.planPath)) !== item.planSha256) throw new Error('摘要不符')
      } catch {
        value.status = 'interrupted'; value.diagrams[kind] = { status: 'failed', error: '图产物缺失或摘要已改变，请重新生成两图' }
      }
    }
    if (active(value) && value.jobId && jobs.get) {
      try { if (jobs.get(value.jobId, exec.agent)?.status !== 'running') value.status = 'interrupted' }
      catch (error) { if (/无权/u.test(error.message)) throw error; value.status = 'interrupted' }
    }
    return value
  }
  const query = async (runId, exec) => summary(await current(runId, exec))
  const submit = async (args, exec) => {
    if (closing || exec.signal?.aborted) throw new Error('架构图输出已停止接纳')
    if (args.theme) throw new Error('SVG首版使用固定浅色主题；theme目前仅用于HTML')
    const { dir, state, report } = await authorize(args.run_id, exec)
    if (!finished.has(state.status)) throw new Error('文案尚在生成或复核，请结束后再生成架构图')
    const snapshot = createSnapshot(report)
    if (args.expected_content_sha256 && args.expected_content_sha256 !== snapshot.sourceContentSha256) throw new Error('文案版本已改变')
    const lock = await claimRun(rootOf(exec.agent), `diagrams-${args.run_id}`, args.run_id,
      { resume: true, sessionId: exec.agent.id || exec.agent.session?.id })
    if (lock.existing) throw new Error('正在准备架构图任务，请稍后查询')
    try {
      const previous = await current(args.run_id, exec)
      if (active(previous) || !args.retry && previous?.status === 'completed' && !previous.stale && previous.rendererVersion === rendererVersion) {
        return { ...summary(previous), reused: true }
      }
      const exportId = randomUUID(), outputDir = path.join(dir, 'diagrams', exportId)
      await mkdir(outputDir, { recursive: true, mode: 0o700 })
      const manifest = { schemaVersion: 1, rendererVersion, exportId, runId: args.run_id, sourceContentSha256: snapshot.sourceContentSha256,
        status: 'queued', createdAt: new Date().toISOString(), diagrams: Object.fromEntries(DIAGRAM_KINDS.map(kind => [kind, { status: 'pending' }])) }
      const save = () => atomicJson(path.join(outputDir, 'manifest.json'), manifest)
      await atomicJson(path.join(outputDir, 'content.json'), snapshot)
      const controller = new AbortController()
      let jobId, release
      const start = new Promise(resolve => { release = resolve })
      const done = start.then(async () => {
        if (!jobId) return { status: 'failed', detail: '架构图作业未被宿主接纳' }
        try {
          manifest.status = 'running'; await save()
          const modelState = { modelRequests: [] }
          let request
          try {
            modelState.modelSelection = await resolveWritingModel(llm, exec.agent, controller.signal, modelRoute)
            request = await createRequester({ llm, exec: { ...exec, signal: controller.signal }, state: modelState,
              saveState: () => atomicJson(path.join(outputDir, 'model-requests.json'), modelState) })
          } catch (error) { manifest.note = `提炼模型不可用，尝试原文摘录视图：${error.message}` }
          // First-stage MVP deliberately runs the pair in one job. Parallel HTML/diagram fan-out is deferred.
          for (const kind of DIAGRAM_KINDS) {
            if (controller.signal.aborted) throw controller.signal.reason
            manifest.diagrams[kind] = { status: 'running' }; await save()
            try {
              const plan = await build({ snapshot, kind, request, signal: controller.signal })
              const planPath = path.join(outputDir, `${kind}.plan.json`)
              await atomicJson(planPath, plan)
              if (plan.status === 'needs_input') { manifest.diagrams[kind] = { status: 'needs_input', reason: plan.reason }; await save(); continue }
              const artifact = await render(plan, { outputDir, python, signal: controller.signal })
              const fresh = await authorize(args.run_id, { ...exec, signal: controller.signal })
              manifest.stale = createSnapshot(fresh.report).sourceContentSha256 !== snapshot.sourceContentSha256
              if (manifest.stale) manifest.note = '文案已更新，本图仅保留为旧版输出'
              manifest.diagrams[kind] = { status: 'completed', ...artifact, sha256: sha256(await readFile(artifact.path)),
                planPath, planSha256: sha256(await readFile(planPath)), mode: plan.mode, warnings: plan.warnings.slice(0, 3),
                nodeCount: plan.nodes.length, edgeCount: plan.edges.length }
            } catch (error) {
              if (controller.signal.aborted) throw controller.signal.reason
              manifest.diagrams[kind] = { status: 'failed', error: String(error.message).slice(0, 1200) }
            }
            await save()
          }
          const count = DIAGRAM_KINDS.filter(kind => manifest.diagrams[kind].status === 'completed').length
          manifest.status = count === 2 ? 'completed' : count ? 'partial' : 'failed'
          manifest.finishedAt = new Date().toISOString(); await save()
          return { status: count ? 'completed' : 'failed', output: JSON.stringify(summary(manifest)), detail: '架构图输出结束；文案与HTML未改动' }
        } catch (error) {
          manifest.status = controller.signal.aborted ? 'cancelled' : 'failed'; manifest.error = String(error.message).slice(0, 1200)
          for (const kind of DIAGRAM_KINDS) if (['pending', 'running'].includes(manifest.diagrams[kind].status)) manifest.diagrams[kind] = { status: manifest.status }
          await save()
          return { status: controller.signal.aborted ? 'killed' : 'failed', detail: manifest.error }
        } finally { live.delete(exportId) }
      })
      try {
        if (closing || exec.signal?.aborted) throw new Error('架构图输出已停止接纳')
        jobId = jobs.start({ kind: 'wlyd-assembly-diagrams', label: `生成两张架构图 ${args.run_id}`, owner: exec.agent,
          outputLimitBytes: 6000, run: () => ({ cancel: reason => controller.abort(new Error(reason || '用户取消架构图')), done }) })
        manifest.jobId = String(jobId); live.set(exportId, { jobId, controller, done })
        await save()
        await atomicJson(path.join(dir, 'diagram-delivery.json'), { exportId, sourceContentSha256: snapshot.sourceContentSha256 })
      } catch (error) {
        controller.abort(error); manifest.status = 'failed'; manifest.error = error.message; await save(); throw error
      } finally { release() }
      return { ...summary(manifest), nextAction: '等待宿主完成通知；查询或取消时继续传format=diagrams。首版重试生成两图，不重写文案。' }
    } finally { await lock.release() }
  }
  const cancel = async (runId, exec) => {
    const value = await current(runId, exec)
    if (active(value)) { jobs.kill(value.jobId, exec.agent, '用户取消架构图'); return { ...summary(value), status: 'cancelling' } }
    return summary(value)
  }
  const close = async () => {
    closing = true
    const pending = [...live.values()]
    for (const entry of pending) entry.controller.abort(new Error('插件停止，已完成架构图保留'))
    await Promise.allSettled(pending.map(entry => entry.done)); detach?.()
  }
  return { submit, query, cancel, close }
}

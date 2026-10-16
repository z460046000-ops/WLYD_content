import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, rename, readFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { rootOf, runPath, sourceEvidence } from '../store.js'
import { readJson, atomicJson, claimRun } from '../persistence.js'
import { createSnapshot } from '../content/snapshot.js'
import { renderOutput } from '../outputs/registry.js'
import { buildPresentation } from '../outputs/html-slides/plan.js'
import { renderPresentation } from '../outputs/html-slides/render.js'
import { validatePresentation } from '../outputs/html-slides/validate.js'
import { createRequester } from '../context.js'
import { resolveWritingModel } from '../model.js'
import { createRetrieval } from '../retrieval.js'
import { currentDelivery, deliverySummary, saveManifest } from './manifest.js'

const FINISHED = new Set(['draft_ready', 'needs_human_review', 'partial_draft', 'failed', 'cancelled'])
const rendererVersion = createRequire(import.meta.url)('../../package.json').version
async function writeArtifact(file, content) {
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, content, { mode: 0o600 }); await rename(temporary, file)
}

/** Output jobs read immutable content snapshots, and never write the source report or run state. */
export function createDeliveryService({ jobs, client, llm, modelRoute, build = buildPresentation, render = renderPresentation }) {
  const live = new Map()
  let closing = false
  const detach = jobs.attachController('wlyd-assembly-delivery')
  const authorize = async (runId, exec) => {
    const dir = runPath(exec.agent, runId), state = await readJson(path.join(dir, 'run.json'))
    if (state.actorDshId && state.actorDshId !== exec.agent.session?.user?.id) throw new Error('当前用户无权导出此文案')
    const saved = await readJson(path.join(dir, 'run-input.json'))
    if (!saved?.args || !state.projectId) throw new Error('缺少文案输入或项目记录，不能验证导出权限')
    const source = await sourceEvidence(exec.agent, saved.args)
    const evidence = (await readJson(path.join(dir, 'evidence.json'))).evidence
    if (!Array.isArray(evidence) || !evidence.some(row => row.kind === 'knowledge')) throw new Error('缺少知识库证据归档，不能验证导出权限')
    const access = createRetrieval({ client, projectId: state.projectId, evidence: source.evidence, signal: exec.signal })
    await access.restoreEvidence(evidence)
    const report = await readJson(path.join(dir, 'report.json'))
    for (const section of report.sections || []) for (const block of section.blocks || []) for (const ref of block.evidence || []) {
      if (typeof ref.quote !== 'string' || ref.quote.length < 6 || !access.evidence.some(row => row.id === ref.id && row.content.includes(ref.quote))) {
        throw new Error('正文引用不在当前授权证据归档内，不能导出')
      }
    }
    return { dir, state, report }
  }
  const query = async (runId, exec) => {
    await authorize(runId, exec)
    const current = await currentDelivery(exec.agent, runId)
    if (['queued', 'running'].includes(current?.html?.status) && current.jobId && jobs.get) {
      try {
        const job = jobs.get(current.jobId, exec.agent)
        if (job.status !== 'running') return { ...deliverySummary(current), status: 'interrupted', note: '输出任务已停止，可只重试输出；原文档保留' }
      } catch { return { ...deliverySummary(current), status: 'interrupted', note: '宿主输出任务已不存在，可只重试输出；原文档保留' } }
    }
    return deliverySummary(current) || { runId, status: 'not_started', documentsReady: false, htmlReady: false }
  }
  const submit = async (args, exec) => {
    if (closing || exec.signal?.aborted) throw new Error('输出任务已停止接纳')
    const format = args.format || 'all', theme = args.theme || 'editorial'
    if (!['all', 'documents', 'html'].includes(format)) throw new Error('format 必须为 all、documents 或 html')
    if (!['editorial', 'swiss', 'blueprint'].includes(theme)) throw new Error('不支持的演示主题')
    const { dir, state, report } = await authorize(args.run_id, exec)
    if (!FINISHED.has(state.status)) throw new Error('文案尚在生成或复核，请结束后再导出')
    const snapshot = createSnapshot(report)
    if (args.expected_content_sha256 && snapshot.sourceContentSha256 !== args.expected_content_sha256) throw new Error('文案版本已改变，请重新查看后导出')
    const claim = await claimRun(rootOf(exec.agent), `delivery-${args.run_id}`, args.run_id, { resume: true, sessionId: exec.agent.id || exec.agent.session?.id })
    if (claim.existing) throw new Error('正在准备输出文档，请稍后查询')
    try {
      const previous = await currentDelivery(exec.agent, args.run_id)
      let previousAlive = true
      if (previous?.jobId && ['queued', 'running'].includes(previous.html?.status)) {
        try { previousAlive = jobs.get(previous.jobId, exec.agent)?.status === 'running' } catch { previousAlive = false }
      }
      if (!args.retry && previous && !previous.stale && previous.theme === theme && previous.rendererVersion === rendererVersion
        && previousAlive
        && (format === 'documents' ? previous.documentsReady : ['queued', 'running', 'completed'].includes(previous.html?.status))) {
        return { ...deliverySummary(previous), reused: true }
      }
      const exportId = randomUUID(), outputDir = path.join(dir, 'outputs', exportId)
      await mkdir(outputDir, { recursive: true, mode: 0o700 })
      const manifest = { schemaVersion: 1, rendererVersion, exportId, runId: args.run_id, sourceContentSha256: snapshot.sourceContentSha256,
        chapterVersions: snapshot.sections.map(row => ({ key: row.key, version: row.version })), theme,
        status: 'preparing_documents', documentsReady: false, documents: {}, html: { status: 'not_started' },
        createdAt: new Date().toISOString(), snapshotPath: path.join(outputDir, 'content.json') }
      const refreshStale = async () => {
        manifest.stale = createSnapshot(await readJson(path.join(dir, 'report.json'))).sourceContentSha256 !== manifest.sourceContentSha256
        if (manifest.stale) manifest.note = '文案已更新，此输出基于旧版本；请仅重新生成输出物'
      }
      await atomicJson(manifest.snapshotPath, snapshot)
      await saveManifest(outputDir, manifest)
      // Each document is published only once complete. DOCX failure does not hide the readable MD.
      for (const type of ['markdown', 'docx']) {
        try {
          const artifact = await renderOutput(type, snapshot)
          const target = path.join(outputDir, `document.${artifact.extension}`)
          await writeArtifact(target, artifact.content)
          manifest.documents[type] = target
        } catch (error) { manifest.documentErrors ||= {}; manifest.documentErrors[type] = error.message }
      }
      manifest.documentsReady = Boolean(manifest.documents.markdown && manifest.documents.docx)
      manifest.documentsReadyAt = new Date().toISOString()
      manifest.status = manifest.documentsReady ? 'documents_ready' : 'documents_partial'
      await refreshStale()
      await saveManifest(outputDir, manifest)
      await atomicJson(path.join(dir, 'delivery.json'), { exportId, sourceContentSha256: snapshot.sourceContentSha256 })
      if (format === 'documents' || !manifest.documents.markdown) return deliverySummary(manifest)
      if (closing || exec.signal?.aborted) {
        manifest.status = 'cancelled'; manifest.html.status = 'cancelled'; manifest.error = '输出接纳期间停止，文档已保留'
        await saveManifest(outputDir, manifest); return deliverySummary(manifest)
      }
      let released, jobId
      const start = new Promise(resolve => { released = resolve })
      const controller = new AbortController()
      const done = start.then(async () => {
        if (!jobId) return { status: 'failed', detail: '输出任务未被宿主接纳，文档已保留' }
        try {
          manifest.status = 'rendering'; manifest.html.status = 'running'; await saveManifest(outputDir, manifest)
          let plan
          if (previous && !previous.stale && previous.rendererVersion === rendererVersion && previous.html?.planPath) {
            try { plan = JSON.parse(await readFile(previous.html.planPath, 'utf8')) } catch { /* Rebuild only the presentation. */ }
            if (plan && validatePresentation(plan, snapshot).length) plan = null
          }
          const modelState = { modelRequests: [] }
          let request
          if (!plan) {
            try {
              modelState.modelSelection = await resolveWritingModel(llm, exec.agent, controller.signal, modelRoute)
              request = await createRequester({ llm, exec: { ...exec, signal: controller.signal }, state: modelState,
                saveState: () => atomicJson(path.join(outputDir, 'model-requests.json'), modelState) })
            } catch (error) { manifest.warnings = [`演示模型未就绪，改用原文分页：${error.message}`] }
            plan = await build({ snapshot, request, signal: controller.signal })
          } else manifest.reusedPresentation = true
          if (controller.signal.aborted) throw controller.signal.reason
          const issues = validatePresentation(plan, snapshot)
          if (issues.length) throw new Error(`演示内容映射未通过：${issues.join('；')}`)
          const html = await render(plan, { theme })
          if (controller.signal.aborted) throw controller.signal.reason
          await authorize(args.run_id, { ...exec, signal: controller.signal })
          const planPath = path.join(outputDir, 'slides.json'), htmlPath = path.join(outputDir, 'presentation.html')
          await atomicJson(planPath, plan); await writeArtifact(htmlPath, html)
          manifest.html = { status: 'completed', planPath, path: htmlPath, slideCount: plan.slides.length,
            skill: plan.skill, finishedAt: new Date().toISOString() }
          manifest.status = 'completed'; manifest.warnings = [...(manifest.warnings || []), ...(plan.warnings || [])]
          await refreshStale()
          await saveManifest(outputDir, manifest)
          return { status: 'completed', output: JSON.stringify(deliverySummary(manifest)), detail: '演示HTML已生成，文案版本未改动' }
        } catch (error) {
          manifest.status = controller.signal.aborted ? 'cancelled' : 'failed'
          manifest.html.status = manifest.status; manifest.error = error.message; await saveManifest(outputDir, manifest)
          return { status: controller.signal.aborted ? 'killed' : 'failed', detail: `HTML未完成，文档已保留：${error.message}` }
        } finally { live.delete(exportId) }
      })
      try {
        jobId = jobs.start({ kind: 'wlyd-assembly-output', label: `文档转演示 ${args.run_id}`, owner: exec.agent,
          outputLimitBytes: 6000, run: () => ({ cancel: reason => controller.abort(new Error(reason || '用户取消HTML输出')), done }) })
        manifest.jobId = String(jobId); manifest.html.status = 'queued'; manifest.status = 'queued'
        live.set(exportId, { done, controller, jobId })
        await saveManifest(outputDir, manifest)
      } catch (error) {
        controller.abort(error); manifest.status = 'failed'; manifest.error = error.message; manifest.html.status = 'failed'
        await saveManifest(outputDir, manifest)
        if (!jobId) return deliverySummary(manifest)
        throw error
      } finally { released() }
      return { ...deliverySummary(manifest), nextAction: '先交付MD/DOCX；HTML完成由宿主job通知，用job_output取结果，不代理循环轮询' }
    } finally { await claim.release() }
  }
  const cancel = async (runId, exec) => {
    const current = await query(runId, exec)
    if (current.jobId && ['queued', 'rendering'].includes(current.status)) jobs.kill(current.jobId, exec.agent, '用户取消HTML输出')
    return { ...current, status: ['queued', 'rendering'].includes(current.status) ? 'cancelling' : current.status }
  }
  const close = async () => {
    closing = true
    const pending = [...live.values()]
    for (const entry of pending) entry.controller.abort(new Error('插件停止，文档保留，可重新生成输出'))
    await Promise.allSettled(pending.map(entry => entry.done)); detach?.()
  }
  return { submit, query, cancel, close }
}

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { hostname } from 'node:os'
import path from 'node:path'
import { confirmedPlan } from './planning.js'
import { assemble, status } from './workflow.js'
import { rootOf, runPath, sourceEvidence, sha256, clone } from './store.js'
import { atomicJson, readJson, reserveRun, claimRun, processAlive } from './persistence.js'
import { resolveWritingModel } from './model.js'
import { qualityMode } from './fact-cards.js'

export const ACTIVE_STATUSES = new Set(['admission_pending', 'queued', 'collecting_evidence', 'generating', 'draft_building', 'draft_reviewing', 'enriching_panoramas', 'reviewing', 'cancelling'])
export function materialFingerprint(source) {
  return sha256(JSON.stringify(source.evidence.map(row => [row.id, sha256(row.content)])))
}
export function taskProgress(state) {
  const chapters = state.chapters || []
  return { total: chapters.length || state.expectedChapters || 0,
    completed: chapters.filter(row => row.status === 'completed').length,
    partial: chapters.filter(row => row.status === 'partial').length,
    omitted: chapters.filter(row => row.status === 'omitted').length,
    failed: chapters.filter(row => row.status === 'failed').length,
    draft: chapters.filter(row => row.status === 'draft_unverified').length,
    needsInput: chapters.filter(row => row.status === 'needs_input').length,
    pending: chapters.length ? chapters.filter(row => !['completed', 'partial', 'omitted', 'failed', 'cancelled', 'draft_unverified', 'needs_input'].includes(row.status)).length : state.expectedChapters || 0,
    cancelled: chapters.filter(row => row.status === 'cancelled').length,
    remainingUnit: '章节节点（不是预计时间）' }
}
export function observedTask(state) {
  const admissionExpired = state.status === 'admission_pending' && Date.parse(state.admissionExpiresAt || '') <= Date.now()
  const interrupted = ACTIVE_STATUSES.has(state.status) && (admissionExpired
    || state.worker && (state.worker.active === false || !processAlive(state.worker)))
  return { ...state, ...(interrupted ? { status: 'interrupted', storedStatus: state.status,
    recoveryNote: '原执行进程已退出；已保存检查点，可用 generate mode=resume 接续' } : {}),
    ...(state.reportReady && ACTIVE_STATUSES.has(state.status) ? { nextAction: interrupted
      ? '可先阅读已交初稿；用 generate mode=resume 接续中断任务' : '可先阅读已交初稿；后台任务仍在运行，用 status 查看进度，不重复 generate' } : {}), progress: taskProgress(state) }
}

/** Host jobs own cancellation; disk checkpoints own restart recovery. No unowned jobs. */
export function createTaskService({ jobs, client, llm, execute = assemble, persist = atomicJson }) {
  const live = new Map()
  let closing = false
  const controllerDisposer = jobs.attachController('wlyd-assembly-tasks')
  const observe = async (state, exec) => {
    if (ACTIVE_STATUSES.has(state.status) && state.worker?.token) {
      const claim = await readJson(path.join(rootOf(exec.agent), '.claims', state.runId, 'claim.json'), null)
      if (!claim || claim.token !== state.worker.token || !claim.active) state = { ...state, worker: { ...state.worker, active: false } }
    }
    return observedTask(state)
  }
  const query = async (runId, exec) => observe(await status({ client, runId, agent: exec.agent, signal: exec.signal }), exec)
  const summary = state => ({ runId: state.runId, run_id: state.runId, status: state.status, jobId: state.jobId || null,
    progress: taskProgress(state), reportReady: Boolean(state.reportReady), ...(state.reportPath ? { reportPath: state.reportPath, jsonPath: state.jsonPath,
      reviewPath: state.reviewPath, reviewJsonPath: state.reviewJsonPath } : {}),
    nextAction: ACTIVE_STATUSES.has(state.status) ? state.reportReady ? '可先阅读已交初稿；后台任务仍在运行，用 status 查看进度，不重复 generate' : '调用 status 查询进度，不重复 generate'
      : ['partial_draft', 'failed', 'cancelled', 'interrupted'].includes(state.status) ? 'generate mode=resume 只接续未完成部分' : '查看产物与待审项' })
  const submit = async (args, exec) => {
    if (closing) throw new Error('插件正在停止，暂不接收新任务')
    if (!exec.agent) throw new Error('后台任务必须绑定当前 DSH 会话')
    if (exec.signal?.aborted) throw exec.signal.reason || new Error('任务提交已取消')
    const mode = args.mode || 'start'
    if (!['start', 'resume', 'regenerate'].includes(mode)) throw new Error('mode 必须为 start、resume 或 regenerate')
    let saved, old, runId, admission
    const root = rootOf(exec.agent)
    if (mode === 'resume') {
      if (!args.run_id) throw new Error('恢复必须提供 run_id')
      runId = args.run_id
      const dir = runPath(exec.agent, runId)
      old = await readJson(path.join(dir, 'run.json'))
      saved = await readJson(path.join(dir, 'run-input.json'))
      if (saved.schemaVersion !== 1 || old.kind !== 'assembly-task') throw new Error('该运行没有新版恢复检查点；旧版不能直接恢复')
      if (JSON.stringify(saved.modelSelection) !== JSON.stringify(old.modelSelection)) throw new Error('恢复模型快照与运行记录不一致，请重新规划生成')
      const actor = exec.agent.session?.user?.id
      if (old.actorDshId && actor !== old.actorDshId) throw new Error('当前用户不能接管该运行')
      const current = await observe(old, exec)
      if (ACTIVE_STATUSES.has(current.status)) return { ...summary(current), reused: true }
      args = { ...saved.args, ...args }
    }
    const confirmed = await confirmedPlan({ args, exec })
    if (saved && args.quality_mode !== undefined && args.quality_mode !== saved.args.quality_mode) throw new Error('恢复不能更改 quality_mode，请明确重新生成')
    confirmed.args.quality_mode = qualityMode(args.quality_mode ?? saved?.args?.quality_mode ?? 'draft')
    const source = await sourceEvidence(exec.agent, confirmed.args)
    const materialHash = materialFingerprint(source)
    if (saved && (saved.materialSha256 !== materialHash || saved.planSha256 !== args.plan_sha256
      || saved.ruleFingerprint !== confirmed.rules.fingerprint)) throw new Error('恢复输入、规划或规则已改变，不能复用旧章节；请重新规划生成')
    const modelSelection = saved?.modelSelection || await resolveWritingModel(llm, exec.agent, exec.signal)
    if (closing) throw new Error('插件正在停止，暂不接收新任务')
    if (exec.signal?.aborted) throw exec.signal.reason || new Error('任务提交已取消')
    if (mode !== 'resume') {
      const proposal = randomUUID()
      saved = { schemaVersion: 1, args: clone(confirmed.args), document: confirmed.document,
        materialSha256: materialHash, planSha256: args.plan_sha256, ruleFingerprint: confirmed.rules.fingerprint, modelSelection }
      const proposalDir = runPath(exec.agent, proposal)
      await mkdir(proposalDir, { recursive: true, mode: 0o700 })
      admission = { runId: proposal, kind: 'assembly-task', checkpointVersion: 1, status: 'admission_pending',
        startedAt: new Date().toISOString(), admissionExpiresAt: new Date(Date.now() + 45000).toISOString(),
        actorDshId: exec.agent.session?.user?.id || null, ownerSessionId: exec.agent.id || exec.agent.session?.id || null,
        worker: { pid: process.pid, host: hostname(), active: true }, modelSelection,
        materialSha256: materialHash, planSha256: args.plan_sha256 }
      // Publish the pointer only after its target is a complete, resumable admission record.
      await persist(path.join(proposalDir, 'run-input.json'), saved)
      await persist(path.join(proposalDir, 'run.json'), admission)
      const key = sha256(JSON.stringify([confirmed.document.projectId, materialHash, args.plan_sha256,
        confirmed.rules.fingerprint, modelSelection.provider, modelSelection.model, modelSelection.reasoningEffort || '', confirmed.args.quality_mode,
        exec.agent.session?.user?.id || null, mode === 'regenerate' ? proposal : '']))
      runId = await reserveRun(root, key, proposal)
      if (runId !== proposal) {
        await persist(path.join(proposalDir, 'run.json'), { ...admission, status: 'deduplicated', deduplicatedTo: runId,
          worker: { ...admission.worker, active: false }, finishedAt: new Date().toISOString() })
        const existing = await readJson(path.join(runPath(exec.agent, runId), 'run.json'), null)
        return existing ? { ...summary(await observe(existing, exec)), reused: true }
          : { runId, run_id: runId, status: 'admission_failed', reused: true,
            nextAction: '旧接纳记录缺失，无法恢复；请明确使用 generate mode=regenerate 新建版本' }
      }
    }
    const dir = runPath(exec.agent, runId)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const claim = await claimRun(root, runId, runId, { resume: mode === 'resume', sessionId: exec.agent.id || exec.agent.session?.id || null })
    if (claim.existing) return { ...summary(observedTask(await readJson(path.join(dir, 'run.json')))), reused: true }
    const state = { ...(old || admission || {}), runId, kind: 'assembly-task', checkpointVersion: 1, status: 'queued',
      startedAt: old?.startedAt || new Date().toISOString(), acceptedAt: new Date().toISOString(),
      actorDshId: old?.actorDshId || exec.agent.session?.user?.id || null,
      ownerSessionId: exec.agent.id || exec.agent.session?.id || null, worker: claim.record,
      modelSelection, materialSha256: materialHash, planSha256: args.plan_sha256,
      resumeCount: (old?.resumeCount || 0) + (mode === 'resume' ? 1 : 0),
      expectedChapters: confirmed.document.outline.flatMap(function flatten(node) { return [node, ...(node.children || []).flatMap(flatten)] }).length }
    for (const record of state.modelRequests || []) if (record.status === 'pending') {
      record.status = 'interrupted'; record.finishedAt = new Date().toISOString()
    }
    try {
      await persist(path.join(dir, 'run-input.json'), saved)
      await persist(path.join(dir, 'run.json'), state)
      if (closing || exec.signal?.aborted) throw new Error('接纳期间插件停止或提交已取消')
    } catch (error) {
      state.status = closing || exec.signal?.aborted ? 'cancelled' : 'failed'; state.error = error.message
      state.worker = { ...state.worker, active: false }
      try { await persist(path.join(dir, 'run.json'), state) } catch { /* The last complete admission remains recoverable. */ }
      await claim.release()
      throw error
    }
    let heartbeat = Promise.resolve(), timer, releaseStart, jobId
    const ready = new Promise(resolve => { releaseStart = resolve })
    const controller = new AbortController()
    const done = ready.then(async () => {
      if (!jobId) return { status: 'failed', detail: '任务未被宿主接纳' }
      try {
        const result = await execute({ client, llm, args: saved.args, exec: { ...exec, signal: controller.signal },
          runId, prepared: { ...confirmed, source, state }, resume: mode === 'resume' })
        return { status: result.status === 'failed' ? 'failed' : 'completed', output: JSON.stringify(result), detail: result.status }
      } catch (error) {
        const latest = await readJson(path.join(dir, 'run.json'), state)
        latest.status = controller.signal.aborted ? 'cancelled' : 'failed'; latest.error = error.message
        latest.updatedAt = new Date().toISOString()
        await persist(path.join(dir, 'run.json'), latest)
        return { status: controller.signal.aborted ? 'killed' : 'failed', detail: error.message }
      } finally {
        clearInterval(timer)
        await heartbeat.catch(() => {})
        await claim.release()
        live.delete(runId)
      }
    }).catch(error => ({ status: 'failed', detail: `任务清理失败：${error.message}` }))
    try {
      jobId = jobs.start({ kind: 'wlyd-assembly', label: `章节组稿 ${runId}`, owner: exec.agent, outputLimitBytes: 6000,
        run: () => ({ cancel: reason => controller.abort(new Error(reason || '用户取消组稿')), done }) })
      state.jobId = String(jobId)
      live.set(runId, { done, controller, jobId, owner: exec.agent })
      timer = setInterval(() => {
        heartbeat = heartbeat.then(() => claim.renew()).catch(error => { controller.abort(error) })
      }, 15000)
      timer.unref?.()
      await persist(path.join(dir, 'run.json'), state)
      return { ...summary(state), reused: false }
    } catch (error) {
      controller.abort(error)
      if (!jobId) {
        state.status = 'failed'; state.error = `宿主后台任务未接纳：${error.message}`
        try { await persist(path.join(dir, 'run.json'), state) } finally { await claim.release() }
      }
      throw error
    } finally { releaseStart() }
  }
  const cancel = async (runId, exec) => {
    const state = await query(runId, exec)
    if (!ACTIVE_STATUSES.has(state.status)) return { ...summary(state), cancellation: 'already-stopped' }
    if (!state.jobId) throw new Error('任务尚未完成接纳，请稍后再取消')
    // Host jobs retain the session authorization boundary; no cross-session bypass.
    const result = jobs.kill(state.jobId, exec.agent, '用户通过 assembly_cancel 取消')
    return { ...summary(state), status: 'cancelling', cancellation: result }
  }
  const close = async () => {
    closing = true
    for (const entry of live.values()) entry.controller.abort(new Error('插件停止，运行可从检查点恢复'))
    await Promise.allSettled([...live.values()].map(entry => entry.done))
    controllerDisposer?.()
  }
  return { submit, query, cancel, close }
}

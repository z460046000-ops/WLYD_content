import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { coverageFromReport } from './content/coverage.js'
import { convertFile, MAX_BYTES } from './convert.js'
import { confirmedPlan } from './planning.js'
import { sourceEvidence, runPath } from './store.js'
import { generateChapters } from './generation.js'
import { chapterOutcomes, reportText, reviewDocument, reviewText } from './content.js'
import { createRetrieval } from './retrieval.js'
import { atomicJson, readJson } from './persistence.js'
export { validateDraft } from './content.js'

const sha256 = value => createHash('sha256').update(value).digest('hex')
const writeJson = atomicJson
const safeName = name => path.basename(String(name)).replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 100) || 'material'
const attachmentKey = value => /^[a-f0-9]{64}$/u.test(String(value)) ? `sha256:${value}` : String(value)
const deepClone = value => JSON.parse(JSON.stringify(value))

async function writeText(file, text) {
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, text, { mode: 0o600 })
  await rename(temporary, file)
}

async function* readInputs(ctx, exec, args) {
  const paths = Array.isArray(args.files) ? args.files : []
  const refs = Array.isArray(args.attachment_refs) ? args.attachment_refs : []
  if (!paths.length && !refs.length) throw new Error('请提供文件路径或本次会话附件')
  if (paths.length + refs.length > 100) throw new Error('每批最多 100 个文件')
  const cwd = exec.agent?.session?.header?.cwd || process.cwd()
  for (const file of paths) {
    const name = safeName(file)
    try {
      const target = await ctx.fs.resolve(String(file), { cwd, signal: exec.signal })
      const stat = await ctx.fs.stat(target, exec.signal)
      if (stat?.type !== 'file') throw new Error('不是普通文件')
      if (stat.size > MAX_BYTES) throw new Error('超过 500 MB')
      const bytes = await ctx.fs.readBytes(target, exec.signal, MAX_BYTES)
      yield { name, bytes: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), source: String(file) }
    } catch (error) { yield { name, source: String(file), error: error.message } }
  }
  if (refs.length) {
    const history = exec.agent?.session?.deriveMessages?.() ?? []
    const userRefs = history.filter(message => message.source?.kind === 'user')
      .flatMap(message => message.content?.filter(block => block.type === 'file').map(block => block.attachment) ?? [])
    const allowed = new Map(userRefs.map(ref => [ref.attachmentId, ref]))
    const store = ctx.get?.('attachments')
    for (const ref of refs) {
      const name = safeName(ref.name)
      try {
        const valid = allowed.get(attachmentKey(ref.attachmentId))
        if (!valid || valid.name !== ref.name || valid.bytes !== ref.bytes) throw new Error('附件不属于当前会话用户')
        if (!store?.readFileStream) throw new Error('DSH 附件读取服务不可用')
        const chunks = []
        let size = 0
        for await (const chunk of store.readFileStream(valid, exec.signal)) {
          size += chunk.length
          if (size > MAX_BYTES) throw new Error('超过 500 MB')
          chunks.push(Buffer.from(chunk))
        }
        yield { name, bytes: Buffer.concat(chunks, size), source: `attachment:${ref.attachmentId}` }
      } catch (error) { yield { name, source: 'attachment', error: error.message } }
    }
  }
}

/** 可信身份只从会话结构取；不接受调用参数传来的用户 ID。 */
function actor(agent) {
  const session = agent?.session
  return { actorDshId: session?.user?.id || null, platformUserId: null, identityAssurance: session?.user?.id ? 'dsh-session' : 'unavailable' }
}

export async function ingest({ ctx, client, args, exec }) {
  const runId = randomUUID()
  const dir = runPath(exec.agent, runId)
  await mkdir(path.join(dir, 'materials'), { recursive: true, mode: 0o700 })
  const state = { runId, status: 'converting', startedAt: new Date().toISOString(), ...actor(exec.agent),
    projectId: null, knowledgeBaseId: null, files: [] }
  await writeJson(path.join(dir, 'run.json'), state)
  try {
    let index = 0
    for await (const input of readInputs(ctx, exec, args)) {
      if (input.error) { state.files.push({ name: input.name, source: input.source, status: 'failed', reason: input.error }); continue }
      const converted = await convertFile(input.name, input.bytes)
      for (const item of converted) {
        const { text, markdown, ...record } = item
        if (item.status === 'converted') {
          const name = `${String(++index).padStart(3, '0')}-${safeName(item.name)}.md`
          await writeFile(path.join(dir, 'materials', name), markdown, { mode: 0o600 })
          record.materialPath = `materials/${name}`
          record.contentSha256 = sha256(markdown)
          record.materialMd5 = createHash('md5').update(markdown).digest('hex')
          record.materialBytes = Buffer.byteLength(markdown)
        }
        record.source = input.source
        state.files.push(record)
      }
    }
    const converted = state.files.filter(file => file.status === 'converted')
    if (!converted.length) { state.status = 'no_readable_material'; return { ...state, runDir: dir } }
    let projects
    try { projects = await client.projects(exec.signal) }
    catch (error) { state.status = 'local_only'; state.platformIssue = error.message; return { ...state, runDir: dir } }
    if (!Array.isArray(projects)) throw new Error('项目列表响应异常')
    const requested = String(args.project_id || '')
    const project = requested ? projects.find(item => String(item.id) === requested) : projects.length === 1 ? projects[0] : null
    if (!project) {
      state.status = projects.length ? 'needs_project_selection' : 'local_only'
      state.availableProjects = projects.map(item => ({ id: String(item.id), name: String(item.name ?? '') }))
      return { ...state, runDir: dir }
    }
    state.projectId = String(project.id)
    let bases
    try { bases = await client.visibleProjectBases(state.projectId, exec.signal) }
    catch (error) { state.status = 'local_only'; state.platformIssue = error.message; return { ...state, runDir: dir } }
    const requestedBase = String(args.knowledge_base_id || '')
    const baseId = requestedBase ? bases.find(value => value === requestedBase) : bases.length === 1 ? bases[0] : null
    if (!baseId) {
      state.status = bases.length ? 'needs_knowledge_base_selection' : 'local_only'
      state.availableKnowledgeBases = bases
      return { ...state, runDir: dir }
    }
    state.knowledgeBaseId = baseId
    let existing = []
    try { existing = await client.documents(baseId, exec.signal) }
    catch (error) { state.deduplicationIssue = `未能查询已有文档：${error.message}` }
    for (const file of converted) {
      try {
        const duplicate = existing.find(item => !item.deleted_at && item.id
          && item.file_hash === file.materialMd5 && Number(item.file_size) === file.materialBytes)
        if (duplicate) {
          file.knowledgeId = String(duplicate.id)
          file.uploadStatus = String(duplicate.parse_status || 'unknown')
          file.uploadDisposition = 'reused'
          continue
        }
        const response = await client.upload(state.projectId, baseId, safeName(file.name) + '.md',
          path.join(dir, file.materialPath), exec.signal)
        if (!response.data?.id) throw new Error('上传响应缺少知识文档 ID')
        file.knowledgeId = String(response.data.id)
        file.uploadStatus = String(response.data.parse_status || 'pending')
        file.uploadRequestId = response.requestId
      } catch (error) { file.uploadStatus = 'upload_failed'; file.uploadError = error.message }
    }
    state.status = converted.every(file => file.uploadStatus === 'upload_failed') ? 'upload_failed' : 'uploaded_or_pending'
    return { ...state, runDir: dir }
  } catch (error) {
    state.status = 'failed'; state.error = error.message
    throw error
  } finally { state.updatedAt = new Date().toISOString(); await writeJson(path.join(dir, 'run.json'), state) }
}

export async function status({ client, runId, agent, signal }) {
  const dir = runPath(agent, runId)
  const state = JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8'))
  if (!Array.isArray(state.files)) return state
  const before = JSON.stringify(state)
  for (const file of state.files.filter(item => item.knowledgeId && !['completed', 'failed'].includes(item.uploadStatus))) {
    try {
      const item = await client.knowledge(file.knowledgeId, signal)
      file.uploadStatus = String(item.parse_status || 'unknown')
      delete file.statusError
    } catch (error) { file.statusError = error.message }
  }
  if (JSON.stringify(state) !== before) {
    state.updatedAt = new Date().toISOString()
    await writeJson(path.join(dir, 'run.json'), state)
  }
  return state
}

/** Compatibility entry for discovery; generation owns chapter-specific retrieval. */
export async function retrieve(client, projectId, rules, signal) {
  const evidence = []
  const retrieval = await createRetrieval({ client, projectId, rules, signal, evidence, outline: rules.template.sections })
  await retrieval.prepare()
  await retrieval.discover()
  return { evidence, coverage: retrieval.coverage, issues: retrieval.issues }
}


export async function assemble({ client, llm, args, exec, runId, prepared, resume = false }) {
  const confirmed = prepared || await confirmedPlan({ args, exec })
  const rules = confirmed.rules
  args = confirmed.args
  const outline = deepClone(confirmed.document.outline)
  const outputId = runId || randomUUID()
  const dir = runPath(exec.agent, outputId)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const state = { ...(prepared?.state || {}), runId: outputId, status: 'collecting_evidence', startedAt: prepared?.state?.startedAt || new Date().toISOString(),
    sourceRunId: args.source_run_id || null, projectId: args.project_id || null,
    ruleFingerprint: rules.fingerprint, loadedRules: rules.loaded, outlineSha256: sha256(JSON.stringify(outline)), ...actor(exec.agent) }
  delete state.finishedAt
  delete state.error
  let pendingWrite = Promise.resolve(), pendingPublish = Promise.resolve(), deliveredReport
  const saveState = () => {
    if (state.reportReady && state.status === 'reviewing' && ['draft', 'standard'].includes(state.qualityMode)) state.status = 'draft_reviewing'
    state.updatedAt = new Date().toISOString()
    const snapshot = deepClone(state)
    const write = pendingWrite.then(() => writeJson(path.join(dir, 'run.json'), snapshot))
    pendingWrite = write.catch(() => {})
    return write
  }
  await saveState()
  try {
    const previousReport = resume ? await readJson(path.join(dir, 'report.json'), null) : null
    const source = prepared?.source || await sourceEvidence(exec.agent, args)
    const { evidence, gaps } = source
    state.projectId = source.projectId
    // Read before prepare() writes its first snapshot. Reuse requires fresh permissions.
    const archived = resume ? await readJson(path.join(dir, 'evidence.json'), { evidence: [] }) : { evidence: [] }
    const overview = await readJson(path.join(runPath(exec.agent, args.plan_id), 'evidence.json'), { evidence: [] })
    const retrieval = await createRetrieval({ client, projectId: state.projectId, rules, outline,
      audience: args.audience, evidence, dir, signal: exec.signal, deferInitialFlush: true })
    await retrieval.prepare()
    await retrieval.restoreEvidence([...overview.evidence, ...archived.evidence])
    state.retrieval = { status: retrieval.issues.length ? 'partial' : 'ready', mode: 'chapter-only' }
    await retrieval.flush()
    const publish = async (generated, phase) => {
      const intermediate = ['draft_building', 'draft_reviewing'].includes(phase)
      await retrieval.flush()
      await writeJson(path.join(dir, 'evidence.json'), { evidence, coverage: retrieval.coverage, gaps,
        reviewItems: retrieval.issues })
      if (!intermediate) state.retrieval.status = retrieval.issues.length ? 'partial' : 'completed'
      state.outlineSha256 = sha256(JSON.stringify(generated.outline))
      const proposedTitle = String(generated.title || '产品售前解决方案').slice(0, 120)
      const titleNumbers = proposedTitle.match(/\d+(?:[.,]\d+)*(?:%|％|万|亿|年|月|日|家|人)?/gu) ?? []
      const title = titleNumbers.some(number => !evidence.some(item => item.content.includes(number)))
        ? '产品售前解决方案' : proposedTitle
      const outcomes = chapterOutcomes({ ...generated, chapterOutcomes: generated.chapterOutcomes || state.chapters })
      const incomplete = outcomes.filter(row => !['completed', 'omitted'].includes(row.status))
      const requiredGaps = incomplete.filter(row => row.required && !['pending', 'draft_unverified'].includes(row.status))
        .map(row => `${row.title}：必需章节${row.status === 'partial' ? '尚未完整' : '未成稿'}，原因见逐章运行记录`)
      const reviewStatus = intermediate ? phase : ['draft', 'standard'].includes(args.quality_mode) ? 'draft_ready'
        : generated.sections.length ? (incomplete.length ? 'partial_draft' : 'needs_human_review') : 'failed'
      const assemblyReview = { ...generated.review, ...(incomplete.length ? { passed: false,
        incompleteChapters: incomplete.map(row => row.key) } : {}),
        ...(intermediate ? { status: phase === 'draft_building' ? 'pending' : 'running', passed: false } : {}) }
      const report = { schemaVersion: 2, runId: outputId, title, qualityMode: args.quality_mode || 'strict',
        templateId: rules.template.id, outline: generated.outline, sections: generated.sections,
        chapterOutcomes: outcomes, omittedChapters: outcomes.filter(row => row.status === 'omitted'),
        choices: generated.choices, contentBalance: generated.contentBalance, validationIssues: generated.validationIssues,
        assemblyLinks: generated.assemblyLinks, reviewItems: generated.reviewItems || [], assemblyReview,
        confirmedPlan: { planId: args.plan_id, sha256: args.plan_sha256 },
        gaps: [...new Set([...gaps, ...requiredGaps, ...(generated.gaps || [])])],
        evidenceIds: evidence.map(item => item.id), ruleFingerprint: rules.fingerprint, loadedRules: rules.loaded,
        reviewStatus, generatedAt: new Date().toISOString() }
      report.contentCoverage = coverageFromReport(report)
      const chapterRecords = deliveredReport?.chapterRecords || previousReport?.chapterRecords
      if (chapterRecords) {
        report.chapterRecords = deepClone(chapterRecords)
        for (const row of outcomes) if (report.chapterRecords[row.key] && row.version > report.chapterRecords[row.key].version) {
          report.chapterRecords[row.key] = { ...report.chapterRecords[row.key], version: row.version, approvalStatus: 'pending' }
        }
      }
      const review = reviewDocument(report)
      await writeJson(path.join(dir, 'report.json'), report)
      await writeText(path.join(dir, 'report.md'), reportText(report))
      await writeJson(path.join(dir, 'review.json'), review)
      await writeText(path.join(dir, 'review.md'), reviewText(review))
      state.status = reviewStatus
      state.qualityMode = report.qualityMode
      state.sections = report.sections.length; state.evidence = evidence.length
      state.missingChapters = incomplete.filter(row => !['partial', 'draft_unverified', 'pending'].includes(row.status)).map(row => row.key)
      state.pendingChapters = outcomes.filter(row => row.status === 'pending').map(row => row.key)
      state.partialChapters = outcomes.filter(row => row.status === 'partial').map(row => row.key)
      state.omittedChapters = outcomes.filter(row => row.status === 'omitted').map(row => row.key)
      state.chapterOutcomes = outcomes
      state.contentCoverage = report.contentCoverage
      state.review = assemblyReview
      state.reportPath = path.join(dir, 'report.md'); state.jsonPath = path.join(dir, 'report.json')
      state.reviewPath = path.join(dir, 'review.md'); state.reviewJsonPath = path.join(dir, 'review.json')
      state.reportReady = true
      if (!state.firstChapterReadyAt && outcomes.some(row => row.status !== 'pending')) state.firstChapterReadyAt = new Date().toISOString()
      if (phase === 'draft_reviewing' && !state.draftReadyAt) state.draftReadyAt = new Date().toISOString()
      if (!intermediate) { state.draftReadyAt ||= new Date().toISOString(); state.finishedAt = new Date().toISOString() }
      else delete state.finishedAt
      deliveredReport = report
      await saveState()
      return report
    }
    const onDraft = (snapshot, phase) => {
      const generated = deepClone(snapshot)
      const write = pendingPublish.then(() => publish(generated, phase))
      pendingPublish = write.catch(() => {})
      return write
    }
    let generated
    try {
      generated = await generateChapters({ llm, args, exec, rules, outline, evidence, dir, state, saveState, retrieval,
        acceptedPlan: confirmed.document.plan, resume, onDraft })
    } finally { await pendingPublish; await retrieval.flush() }
    const report = await publish(generated)
    const outcomes = report.chapterOutcomes
    return { runId: outputId, status: state.status, sections: report.sections.length, evidence: evidence.length,
      choices: report.choices, planningStatus: state.planning.status, failedChapters: outcomes.filter(item => ['failed', 'cancelled'].includes(item.status)).map(item => item.title),
      partialChapters: outcomes.filter(item => item.status === 'partial').map(item => item.title),
      omittedChapters: outcomes.filter(item => item.status === 'omitted').map(item => item.title),
      assemblyReview: report.assemblyReview, reviewItemsCount: report.reviewItems.length, gapsCount: report.gaps.length,
      reviewPath: state.reviewPath, reviewJsonPath: state.reviewJsonPath,
      reportPath: path.join(dir, 'report.md'), jsonPath: path.join(dir, 'report.json'), evidencePath: path.join(dir, 'evidence.json'), retrievalPath: path.join(dir, 'retrieval.json') }
  } catch (error) {
    state.status = exec.signal?.aborted ? 'cancelled' : 'failed'; state.error = error.message
    state.finishedAt = new Date().toISOString()
    if (deliveredReport) {
      state.review = { ...state.review, status: exec.signal?.aborted ? 'cancelled' : 'partial', passed: false, error: error.message }
      deliveredReport.assemblyReview = state.review
      deliveredReport.reviewStatus = state.status
      deliveredReport.reviewItems = [...new Set([...deliveredReport.reviewItems, `后续生成或关联复核未完成，已交初稿保留：${error.message}`])]
      const review = reviewDocument(deliveredReport)
      await writeJson(path.join(dir, 'report.json'), deliveredReport)
      await writeText(path.join(dir, 'report.md'), reportText(deliveredReport))
      await writeJson(path.join(dir, 'review.json'), review)
      await writeText(path.join(dir, 'review.md'), reviewText(review))
    }
    throw error
  }
  finally { await saveState() }
}

import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { convertFile, MAX_BYTES } from './convert.js'
import { loadRules, validateOutline, flattenOutline, requestedModes } from './rules.js'
import { generateChapters } from './generation.js'
import { reportText } from './content.js'
import { createLimiter, mapConcurrent } from './scheduler.js'
export { validateDraft } from './content.js'

const sha256 = value => createHash('sha256').update(value).digest('hex')
const writeJson = (file, value) => writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 })
const rootOf = agent => path.join(agent?.session?.header?.cwd || process.cwd(), 'artifacts/material-knowledge-assembly/runs')
const runPath = (agent, runId) => {
  if (!/^[0-9a-f-]{36}$/iu.test(runId)) throw new Error('无效的 run_id')
  return path.join(rootOf(agent), runId)
}
const safeName = name => path.basename(String(name)).replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 100) || 'material'
const attachmentKey = value => /^[a-f0-9]{64}$/u.test(String(value)) ? `sha256:${value}` : String(value)
const deepClone = value => JSON.parse(JSON.stringify(value))
const retrievalSlot = createLimiter(4)

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

function localEvidence(text, file) {
  const pieces = text.split(/\n\s*\n/gu).map(item => item.trim()).filter(Boolean)
  const result = []
  let current = ''
  for (const piece of pieces) {
    if (current && current.length + piece.length > 1400) { result.push(current); current = '' }
    if (piece.length > 1400) {
      for (let pos = 0; pos < piece.length; pos += 1400) result.push(piece.slice(pos, pos + 1400))
    } else current += (current ? '\n\n' : '') + piece
  }
  if (current) result.push(current)
  return result.map((content, index) => ({ id: `M${file.index}-${index + 1}`,
    kind: 'material', source: file.name, sourceSha256: file.sha256, locator: `${file.materialPath}#${index + 1}`, content }))
}

export async function retrieve(client, projectId, rules, signal) {
  const bases = await client.visibleProjectBases(projectId, signal)
  const evidence = []
  const coverage = []
  const priority = ['product-architecture', 'scenario-solution', 'business-challenges', 'policy-trends']
  const ordered = [...priority.map(role => rules.chapters[role]).filter(Boolean), ...Object.values(rules.chapters)]
  const questions = [...new Set([
    '本项目材料的主要内容、产品能力、业务场景、客户问题与行业背景',
    '还有哪些值得纳入方案的事实、限制条件、案例、服务和企业信息',
    ...ordered.flatMap(rule => rule.extractQuestions.slice(0, 1)),
  ])]
  const prepared = await mapConcurrent(bases, baseId => retrievalSlot(async () => {
    const docs = await client.documents(baseId, signal)
    const completed = docs.filter(doc => doc.parse_status === 'completed').map(doc => String(doc.id))
    return { baseId, completed }
  }, signal), { signal })
  const jobs = []
  const byBase = new Map()
  for (const [index, result] of prepared.entries()) {
    const baseId = bases[index]
    if (result.status === 'rejected') { coverage.push({ baseId, status: 'failed', error: result.reason.message }); continue }
    const { completed } = result.value
    const item = { baseId, status: completed.length ? 'empty' : 'no_completed_documents', hits: 0, errors: [] }
    coverage.push(item); byBase.set(baseId, item)
    if (completed.length) jobs.push(...questions.map(question => ({ baseId, completed, question })))
  }
  const results = await mapConcurrent(jobs, job => retrievalSlot(async () => {
    const rows = await client.search(job.baseId, job.question, job.completed, signal)
    if (!Array.isArray(rows)) throw new Error('检索响应异常')
    return rows
  }, signal), { signal })
  const seen = new Set()
  for (const [index, result] of results.entries()) {
    const { baseId, completed, question } = jobs[index]
    const item = byBase.get(baseId)
    if (result.status === 'rejected') { item.errors.push({ question, error: result.reason.message }); continue }
    for (const row of result.value) {
      if (!row) continue
      const chunkId = String(row.chunk_id ?? row.id ?? '')
      const knowledgeId = String(row.knowledge_id ?? '')
      const content = String(row.content ?? row.matched_content ?? '').trim()
      const key = `${baseId}:${chunkId}`
      if (!chunkId || !completed.includes(knowledgeId) || !content || seen.has(key)) continue
      seen.add(key)
      item.hits++
      evidence.push({ id: `K${evidence.length + 1}`, kind: 'knowledge', knowledgeBaseId: baseId,
        knowledgeId, chunkId, source: String(row.knowledge_title || row.knowledge_filename || knowledgeId),
        locator: `chunk=${chunkId}${row.chunk_index != null ? `;index=${row.chunk_index}` : ''}`, content })
    }
  }
  for (const item of coverage) if (item.status !== 'failed' && item.status !== 'no_completed_documents') {
    const failed = item.errors.length
    item.status = failed === questions.length ? 'failed' : failed ? 'partial' : item.hits ? 'matched' : 'empty'
  }
  return { evidence, coverage, bases }
}


export async function assemble({ client, llm, args, exec }) {
  const rules = await loadRules(args.template_id || 'presales-solution')
  const outline = validateOutline(args.outline ? deepClone(args.outline) : deepClone(rules.template.sections), rules)
  requestedModes(outline, args)
  const outputId = randomUUID()
  const dir = runPath(exec.agent, outputId)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const state = { runId: outputId, status: 'collecting_evidence', startedAt: new Date().toISOString(),
    sourceRunId: args.source_run_id || null, projectId: args.project_id || null,
    ruleFingerprint: rules.fingerprint, loadedRules: rules.loaded, outlineSha256: sha256(JSON.stringify(outline)), ...actor(exec.agent) }
  let pendingWrite = Promise.resolve()
  const saveState = () => {
    state.updatedAt = new Date().toISOString()
    const snapshot = deepClone(state)
    const write = pendingWrite.then(() => writeJson(path.join(dir, 'run.json'), snapshot))
    pendingWrite = write.catch(() => {})
    return write
  }
  await saveState()
  try {
    const evidence = []
    const gaps = []
    if (args.source_run_id) {
      const sourceDir = runPath(exec.agent, args.source_run_id)
      const sourceState = JSON.parse(await readFile(path.join(sourceDir, 'run.json'), 'utf8'))
      if (sourceState.projectId && state.projectId && String(sourceState.projectId) !== String(state.projectId)) {
        throw new Error('材料所属项目与生成项目不一致，已阻止跨项目混用')
      }
      for (const [index, file] of sourceState.files.entries()) {
        if (file.status !== 'converted') { gaps.push(`${file.name}：${file.reason || file.status}`); continue }
        if (!/^materials\/[\p{L}\p{N}._-]+\.md$/u.test(file.materialPath) || file.materialPath.includes('..')) {
          gaps.push(`${file.name}：材料路径不合法`); continue
        }
        const text = await readFile(path.join(sourceDir, file.materialPath), 'utf8')
        evidence.push(...localEvidence(text, { ...file, index: index + 1 }))
      }
      if (!state.projectId && sourceState.projectId) state.projectId = sourceState.projectId
    }
    let retrieval = { evidence: [], coverage: [], bases: [] }
    if (state.projectId) {
      try { retrieval = await retrieve(client, state.projectId, rules, exec.signal) }
      catch (error) { gaps.push(`知识检索失败：${error.message}`); state.retrievalError = error.message }
    }
    evidence.push(...retrieval.evidence)
    for (const item of retrieval.coverage.filter(item => ['partial', 'failed'].includes(item.status))) {
      gaps.push(`知识库 ${item.baseId} 检索${item.status === 'partial' ? '部分' : ''}失败，已保留其他成功结果；详见 evidence.json.coverage`)
    }
    if (!evidence.length) throw new Error('没有可核对的材料或授权知识片段，未生成空稿')
    await writeJson(path.join(dir, 'evidence.json'), { evidence, coverage: retrieval.coverage, gaps })
    const generated = await generateChapters({ client, llm, args, exec, rules, outline, evidence, dir, state, saveState })
    state.outlineSha256 = sha256(JSON.stringify(generated.outline))
    const proposedTitle = String(generated.title || '产品售前解决方案').slice(0, 120)
    const titleNumbers = proposedTitle.match(/\d+(?:[.,]\d+)*(?:%|％|万|亿|年|月|日|家|人)?/gu) ?? []
    const title = titleNumbers.some(number => !evidence.some(item => item.content.includes(number)))
      ? '产品售前解决方案' : proposedTitle
    const generatedKeys = new Set(generated.sections.map(item => item.key))
    const requiredGaps = flattenOutline(generated.outline).filter(item => item.required && !generatedKeys.has(item.key))
      .map(item => `${item.title}：缺少足够资料，需补充或确认`)
    const report = { schemaVersion: 2, runId: outputId, title,
      templateId: rules.template.id, outline: generated.outline, sections: generated.sections,
      choices: generated.choices, contentBalance: generated.contentBalance, validationIssues: generated.validationIssues,
      assemblyLinks: generated.assemblyLinks, reviewItems: generated.reviewItems,
      gaps: [...new Set([...gaps, ...requiredGaps, ...generated.gaps])],
      evidenceIds: evidence.map(item => item.id), ruleFingerprint: rules.fingerprint, loadedRules: rules.loaded,
      reviewStatus: 'needs_human_review', generatedAt: new Date().toISOString() }
    await writeJson(path.join(dir, 'report.json'), report)
    await writeFile(path.join(dir, 'report.md'), reportText(report), { mode: 0o600 })
    state.status = 'needs_human_review'; state.sections = report.sections.length; state.evidence = evidence.length
    await saveState()
    return { ...state, reportPath: path.join(dir, 'report.md'), jsonPath: path.join(dir, 'report.json'), evidencePath: path.join(dir, 'evidence.json') }
  } catch (error) { state.status = exec.signal?.aborted ? 'cancelled' : 'failed'; state.error = error.message; throw error }
  finally { await saveState() }
}

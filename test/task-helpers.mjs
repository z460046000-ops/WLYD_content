import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir, hostname } from 'node:os'
import path from 'node:path'
import { confirmedArgs } from './helpers.mjs'
import { sha256, runPath } from '../src/store.js'

export const readRecord = async file => JSON.parse(await readFile(file, 'utf8'))
export async function updateRecord(file, fields) {
  const previous = await readRecord(file)
  const next = { ...previous, ...fields }
  await writeFile(file, JSON.stringify(next, null, 2))
  return next
}
export function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
export function waitControlled(signal, gate) {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    gate.promise.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}

/** Match the host jobs contract, including the owner/session authorization boundary. */
export function fakeJobs() {
  const records = new Map()
  let attached = 0, disposed = 0
  const ownerId = owner => owner?.id || owner?.session?.id
  const owned = (id, owner) => {
    const record = records.get(String(id))
    if (!record) throw new Error('job not found')
    if (ownerId(record.owner) !== ownerId(owner)) throw new Error('当前会话无权操作该后台任务')
    return record
  }
  return {
    records,
    attachController(name) {
      assert.equal(name, 'wlyd-assembly-tasks')
      attached++
      return () => { disposed++ }
    },
    start(spec) {
      assert.ok(spec.owner, 'tasks must have a session owner')
      assert.equal(spec.unowned, undefined)
      const id = randomUUID()
      const running = spec.run()
      const record = { id, owner: spec.owner, status: 'running', cancel: running.cancel }
      records.set(id, record)
      record.done = Promise.resolve(running.done).then(result => { record.status = result.status; record.result = result; return result })
      return id
    },
    get(id, owner) { return owned(id, owner) },
    kill(id, owner, reason) {
      const record = owned(id, owner)
      record.cancel(reason)
      return { id, status: 'killing' }
    },
    async settled(id) { return records.get(String(id)).done },
    get controllerCount() { return attached },
    get disposedCount() { return disposed },
  }
}

export async function taskFixture(options = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'wlyd-background-task-'))
  const sourceRunId = randomUUID()
  const agent = { id: 'test-session-owner', options: { provider: 'fake', model: 'fake' },
    session: { id: 'test-session-owner', user: { id: 'test-user' }, header: { cwd } } }
  const controller = new AbortController()
  const exec = { agent, signal: controller.signal }
  const dir = runPath(agent, sourceRunId)
  const materialFile = path.join(dir, 'materials', 'input.md')
  const content = '产品支持统一维护线索状态，销售和客服可以查看同一记录。'
  await mkdir(path.dirname(materialFile), { recursive: true })
  await writeFile(materialFile, content)
  await writeFile(path.join(dir, 'run.json'), JSON.stringify({ runId: sourceRunId, files: [
    { name: 'input.md', status: 'converted', materialPath: 'materials/input.md', contentSha256: sha256(content) },
  ] }))
  const args = await confirmedArgs({}, { source_run_id: sourceRunId, ...options }, exec)
  const llm = { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }] } }) }
  return { cwd, agent, controller, exec, args, llm, client: {}, sourceRunId, materialFile, sourceDir: dir, jobs: fakeJobs(), hostname: hostname() }
}

export async function finishFakeTask(options, extra = {}) {
  const file = path.join(runPath(options.exec.agent, options.runId), 'run.json')
  await updateRecord(file, { status: 'complete_draft', chapters: [{ key: 'business-challenges', status: 'completed' }], ...extra })
  return { runId: options.runId, status: 'complete_draft' }
}

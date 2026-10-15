import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import path from 'node:path'

/** An interrupted write never replaces the last complete checkpoint. */
export async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
  await rename(temporary, file)
}
export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT' && arguments.length > 1) return fallback; throw error }
}
export function processAlive(record) {
  if (record.host !== hostname()) return Date.parse(record.leaseUntil || '') > Date.now()
  try { process.kill(record.pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

/** Directories are acquired atomically. Old claims are retained, not deleted. */
export async function claimRun(root, key, runId, { resume = false, sessionId = null } = {}) {
  const folder = path.join(root, '.claims', key)
  await mkdir(path.dirname(folder), { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 5; attempt++) {
    const record = { runId, token: randomUUID(), pid: process.pid, host: hostname(), active: true, sessionId,
      leaseUntil: new Date(Date.now() + 45000).toISOString(), createdAt: new Date().toISOString() }
    const candidate = `${folder}.candidate-${record.token}`
    await mkdir(candidate, { mode: 0o700 })
    await atomicJson(path.join(candidate, 'claim.json'), record)
    // Publishing a complete nonempty directory avoids an empty-lock crash window.
    try { await rename(candidate, folder) }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
      const existing = await readJson(path.join(folder, 'claim.json'), null)
      if (!existing) throw new Error('同一任务正在接纳，请稍后查询，未创建重复任务')
      if (!resume || (existing.active && processAlive(existing))) return { existing }
      // A stable destination prevents a second contender from moving a new owner.
      try { await rename(folder, `${folder}.history-${existing.token}`) }
      catch (failure) { if (['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(failure.code)) continue; throw failure }
      continue
    }
    const update = async active => {
      const current = await readJson(path.join(folder, 'claim.json'))
      if (current.token !== record.token) throw new Error('运行锁已改变，停止旧任务写入')
      Object.assign(record, { active, leaseUntil: new Date(Date.now() + 45000).toISOString() })
      await atomicJson(path.join(folder, 'claim.json'), record)
    }
    return { record, renew: () => update(true), release: () => update(false) }
  }
  throw new Error('任务锁竞争，请查询已有运行后重试')
}

/** Stable idempotency pointer; explicit regenerate uses a separate key. */
export async function reserveRun(root, key, runId) {
  const folder = path.join(root, '.requests')
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const candidate = path.join(folder, `${key}.${runId}.candidate.json`)
  await atomicJson(candidate, { runId, createdAt: new Date().toISOString() })
  try {
    // The shared pointer appears only after all JSON bytes are written.
    await link(candidate, path.join(folder, key + '.json'))
    return runId
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const existing = await readJson(path.join(folder, key + '.json'))
    if (!existing.runId) throw new Error('任务接纳记录尚未完成，请稍后查询')
    return existing.runId
  }
}

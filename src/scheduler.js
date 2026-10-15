import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export function resolveGenerationConcurrency(env = process.env) {
  let local
  try {
    const file = readFileSync(path.join(env.DSH_HOME || path.join(homedir(), '.dsh'), '.env'), 'utf8')
    local = /^\s*WLYD_ASSEMBLY_CONCURRENCY\s*=\s*(.*?)\s*$/mu.exec(file)?.[1]?.replace(/^["']|["']$/gu, '')
  } catch { /* 允许不提供本地配置。 */ }
  const raw = String(env.WLYD_ASSEMBLY_CONCURRENCY ?? local ?? '').trim()
  return /^(?:[1-9]|1[0-2])$/u.test(raw) ? Number(raw) : 8
}

export const GENERATION_CONCURRENCY = resolveGenerationConcurrency()

export const abortError = signal => signal?.reason || new DOMException('任务已取消', 'AbortError')

/** A shared limit covers every model stage, including concurrent report runs. */
export function createLimiter(limit = GENERATION_CONCURRENCY) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('并发数必须为正整数')
  let active = 0
  const queue = []
  const drain = () => {
    while (active < limit && queue.length) {
      const job = queue.shift()
      job.signal?.removeEventListener('abort', job.cancel)
      if (job.signal?.aborted) { job.reject(abortError(job.signal)); continue }
      active++
      Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => { active--; drain() })
    }
  }
  return (run, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError(signal)); return }
    const job = { run, signal, resolve, reject, cancel: null }
    job.cancel = () => {
      const index = queue.indexOf(job)
      if (index >= 0) { queue.splice(index, 1); reject(abortError(signal)) }
    }
    signal?.addEventListener('abort', job.cancel, { once: true })
    queue.push(job)
    drain()
  })
}

/** Preserve input order; failures are isolated, cancellation drains active work. */
export async function mapConcurrent(items, worker, { concurrency = GENERATION_CONCURRENCY, signal } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('并发数必须为正整数')
  const results = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length && !signal?.aborted) {
      const index = next++
      try { results[index] = { status: 'fulfilled', value: await worker(items[index], index) } }
      catch (reason) { results[index] = { status: 'rejected', reason } }
    }
  }))
  if (signal?.aborted) throw abortError(signal)
  return results
}

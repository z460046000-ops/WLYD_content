import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export function configurationValue(name, env = process.env) {
  if (env[name] !== undefined) return String(env[name]).trim()
  try {
    const file = readFileSync(path.join(env.DSH_HOME || path.join(homedir(), '.dsh'), '.env'), 'utf8')
    return new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`, 'mu').exec(file)?.[1]?.trim().replace(/^["']|["']$/gu, '')
  } catch { /* 允许不提供本地配置。 */ }
}

export function resolveGenerationConcurrency(env = process.env) {
  const raw = configurationValue('WLYD_ASSEMBLY_CONCURRENCY', env) || ''
  return /^(?:[1-9]|1[0-2])$/u.test(raw) ? Number(raw) : 8
}

/** Exact route wins over provider wildcard, provider entry and default. */
export function resolveRouteConcurrency(selection, env = process.env) {
  const fallback = resolveGenerationConcurrency(env)
  try {
    const config = JSON.parse(configurationValue('WLYD_ASSEMBLY_ROUTE_CONCURRENCY', env) || '{}')
    if (!config || Array.isArray(config) || typeof config !== 'object') return fallback
    const value = config[`${selection.provider}/${selection.model}`] ?? config[`${selection.provider}/*`]
      ?? config[selection.provider] ?? config.default
    return Number.isInteger(value) && value >= 1 && value <= 12 ? Math.min(value, fallback) : fallback
  } catch { return fallback }
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
      Promise.resolve().then(job.run).then(value => {
        active--; drain(); job.resolve(value)
      }, error => { active--; drain(); job.reject(error) })
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

/** Acquire a route slot first. Waiting on a saturated route never occupies a global slot. */
export function createModelScheduler({ globalLimiter = createLimiter(), env = process.env } = {}) {
  const routes = new Map()
  return (selection, run, signal, options = {}) => {
    const concurrency = resolveRouteConcurrency(selection, options.env || env)
    const key = JSON.stringify([selection.provider, selection.model, concurrency])
    if (!routes.has(key)) routes.set(key, createLimiter(concurrency))
    return routes.get(key)(() => (options.limiter || globalLimiter)(run, signal), signal)
  }
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

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const id = value => encodeURIComponent(String(value))
const signalFor = signal => AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(60000)])

export function resolveConfig(config = {}, env = process.env) {
  let local = {}
  try {
    const file = readFileSync(path.join(env.DSH_HOME || path.join(homedir(), '.dsh'), '.env'), 'utf8')
    for (const line of file.split(/\r?\n/u)) {
      const match = /^\s*(WLYD_PLATFORM_\w+)\s*=\s*(.*?)\s*$/u.exec(line)
      if (match) local[match[1]] = match[2].replace(/^["']|["']$/gu, '')
    }
  } catch { /* 允许只使用插件配置或进程环境变量。 */ }
  const value = (field, key) => String(config[field] || env[key] || local[key] || '')
  const baseUrl = value('baseUrl', 'WLYD_PLATFORM_BASE_URL').replace(/\/+$/u, '')
  if (baseUrl && !/^https:\/\//u.test(baseUrl) && !/^http:\/\/127\.0\.0\.1(?::\d+)?$/u.test(baseUrl)) {
    throw new Error('平台地址须为 HTTPS 或本机测试地址')
  }
  return { baseUrl, email: value('email', 'WLYD_PLATFORM_EMAIL'),
    password: value('password', 'WLYD_PLATFORM_PASSWORD'), tenantId: value('tenantId', 'WLYD_PLATFORM_TENANT_ID') }
}

export class PlatformClient {
  constructor(config, fetchImpl = fetch) { this.config = config; this.fetch = fetchImpl; this.token = '' }

  async login(signal) {
    const { baseUrl, email, password, tenantId } = this.config
    if (!baseUrl || !email || !password || !tenantId) throw new Error('平台连接配置不完整')
    const response = await this.fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }), signal: signalFor(signal),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok || !payload.token) throw new Error(`平台登录失败 HTTP ${response.status}`)
    if (payload.active_tenant?.id && String(payload.active_tenant.id) !== tenantId) throw new Error('登录租户与配置不一致')
    this.token = payload.token
  }

  async request(method, route, body, signal, multipart = false) {
    if (!this.token) await this.login(signal)
    const send = () => this.fetch(this.config.baseUrl + route, {
      method, headers: { Authorization: `Bearer ${this.token}`, 'X-Tenant-ID': this.config.tenantId,
        ...(!multipart && body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : multipart ? body : JSON.stringify(body), signal: signalFor(signal),
    })
    let response = await send()
    if (response.status === 401) { this.token = ''; await this.login(signal); response = await send() }
    const payload = await response.json().catch(() => ({}))
    if (!response.ok || payload.success === false) {
      const code = typeof payload.code === 'string' || typeof payload.code === 'number' ? ` code=${payload.code}` : ''
      const requestId = response.headers.get('x-request-id')
      const error = new Error(`平台 ${method} ${route} 失败 HTTP ${response.status}${code}${requestId ? ` requestId=${requestId}` : ''}`)
      error.status = response.status
      error.code = payload.code
      error.requestId = requestId
      throw error
    }
    return { data: payload.data ?? payload, status: response.status, requestId: response.headers.get('x-request-id') }
  }

  async projects(signal) { return (await this.request('GET', '/api/v1/solutions/projects', undefined, signal)).data }
  async projectBases(projectId, signal) {
    return (await this.request('GET', `/api/v1/solutions/projects/${id(projectId)}/knowledge-bases`, undefined, signal)).data
  }
  async paged(route, signal) {
    const rows = []
    for (let page = 1; page <= 20; page++) {
      const result = (await this.request('GET', `${route}?page=${page}&page_size=50`, undefined, signal)).data
      if (!Array.isArray(result)) throw new Error('平台列表响应异常')
      rows.push(...result)
      if (result.length < 50) return rows
    }
    throw new Error('平台列表超过 1000 条，请缩小范围')
  }
  bases(signal) { return this.paged('/api/v1/knowledge-bases', signal) }
  documents(baseId, signal) { return this.paged(`/api/v1/knowledge-bases/${id(baseId)}/knowledge`, signal) }
  async visibleProjectBases(projectId, signal) {
    const projects = await this.projects(signal)
    if (!Array.isArray(projects) || !projects.some(project => String(project.id) === String(projectId))) throw new Error('当前账号不可访问目标项目')
    const [bound, visible] = await Promise.all([this.projectBases(projectId, signal), this.bases(signal)])
    if (!Array.isArray(bound)) throw new Error('项目绑定知识库响应异常')
    const visibleIds = new Set(visible.map(base => String(base.id)))
    return [...new Set(bound.map(base => String(base.knowledge_base_id ?? base.id)).filter(baseId => visibleIds.has(baseId)))]
  }
  async upload(projectId, baseId, name, markdown, signal) {
    const form = new FormData()
    form.append('file', new Blob([markdown], { type: 'text/markdown; charset=utf-8' }), name)
    const route = `/api/v1/solutions/projects/${id(projectId)}/knowledge-bases/${id(baseId)}/files`
    return this.request('POST', route, form, signal, true)
  }
  async knowledge(idValue, signal) { return (await this.request('GET', `/api/v1/knowledge/${id(idValue)}`, undefined, signal)).data }
  async search(baseId, query, documentIds, signal) {
    return (await this.request('POST', `/api/v1/knowledge-bases/${id(baseId)}/hybrid-search`, {
      query_text: query, match_count: 6, knowledge_ids: documentIds, skip_context_enrichment: true,
    }, signal)).data
  }
}

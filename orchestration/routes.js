import { configurationValue } from '../src/scheduler.js'

export function roleRoute(config, role) {
  const value = config[`${role}Route`] || configurationValue(`WLYD_ASSEMBLY_${role.toUpperCase()}_ROUTE`)
  if (!value) return undefined
  let route
  try { route = typeof value === 'string' ? JSON.parse(value) : value } catch { throw new Error(`${role}Route 必须为provider/model对象`) }
  if (typeof route?.provider !== 'string' || !route.provider.trim() || typeof route?.model !== 'string' || !route.model.trim()) throw new Error(`${role}Route 必须同时配置provider和model`)
  return { provider: route.provider, model: route.model }
}

/** Only model selection is projected; session/identity/workspace remain the original objects. */
export function roleExecution(exec, route) {
  if (!route) return exec
  const agent = Object.create(exec.agent)
  agent.options = { ...exec.agent.options, ...route }
  agent.session = Object.create(exec.agent.session || null)
  agent.session.requestHeader = () => ({ config: route })
  return { ...exec, agent }
}

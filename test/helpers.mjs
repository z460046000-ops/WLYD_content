import { planOutline, confirmOutline } from '../src/planning.js'
import { assemble } from '../src/workflow.js'

export async function confirmedArgs(client, args, exec) {
  const llm = { async *stream(request) {
    const prompt = JSON.parse(request.messages[0].content[0].text)
    const value = prompt.stage === 'extract' ? { facts: prompt.evidence.map(source => ({ text: source.content.slice(0, 160),
      evidence: [{ id: source.id, quote: source.content.slice(0, 80) }] })) }
      : { title: '测试方案', businessMode: { value: args.business_mode || 'needs-challenges' }, trendFramework: { value: args.trend_framework || 'management-business-technology' } }
    yield { type: 'text-delta', text: JSON.stringify(value) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const prepared = await planOutline({ client, llm, args, exec })
  await confirmOutline({ args: { plan_id: prepared.planId, plan_sha256: prepared.planSha256, confirmed: true }, exec })
  const { outline, business_mode, trend_framework, ...rest } = args
  return { ...rest, plan_id: prepared.planId, plan_sha256: prepared.planSha256 }
}
export async function assembleConfirmed(options) {
  return assemble({ ...options, args: await confirmedArgs(options.client, options.args, options.exec) })
}
export const completeAudit = (reviewItems = []) => ({ checks: ['problem-solution', 'capability-evidence', 'scenario-panorama', 'trend-construction', 'contradictions-orphans']
  .map(id => ({ id, status: 'pass', reason: '已核对当前完整正文与证据' })), reviewItems })

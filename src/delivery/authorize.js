import path from 'node:path'
import { runPath, sourceEvidence } from '../store.js'
import { readJson } from '../persistence.js'
import { createRetrieval } from '../retrieval.js'

/** The same current-user, material and knowledge checks apply to every output adapter. */
export async function authorizeContent(client, runId, exec) {
  const dir = runPath(exec.agent, runId), state = await readJson(path.join(dir, 'run.json'))
  if (state.actorDshId && state.actorDshId !== exec.agent.session?.user?.id) throw new Error('当前用户无权导出此文案')
  const saved = await readJson(path.join(dir, 'run-input.json'))
  if (!saved?.args || !state.projectId) throw new Error('缺少文案输入或项目记录，不能验证导出权限')
  const source = await sourceEvidence(exec.agent, saved.args)
  const evidence = (await readJson(path.join(dir, 'evidence.json'))).evidence
  if (!Array.isArray(evidence) || !evidence.some(row => row.kind === 'knowledge')) throw new Error('缺少知识库证据归档，不能验证导出权限')
  const access = createRetrieval({ client, projectId: state.projectId, evidence: source.evidence, signal: exec.signal })
  await access.restoreEvidence(evidence)
  const report = await readJson(path.join(dir, 'report.json'))
  for (const section of report.sections || []) for (const block of section.blocks || []) for (const ref of block.evidence || []) {
    if (typeof ref.quote !== 'string' || ref.quote.length < 6 || !access.evidence.some(row => row.id === ref.id && row.content.includes(ref.quote))) {
      throw new Error('正文引用不在当前授权证据归档内，不能导出')
    }
  }
  return { dir, state, report }
}

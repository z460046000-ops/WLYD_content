import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export const sha256 = value => createHash('sha256').update(value).digest('hex')
export const clone = value => JSON.parse(JSON.stringify(value))
export const rootOf = agent => path.join(agent?.session?.header?.cwd || process.cwd(), 'artifacts/material-knowledge-assembly/runs')
export function runPath(agent, id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(String(id || ''))) throw new Error('无效的 run_id')
  return path.join(rootOf(agent), id)
}
export async function sourceEvidence(agent, args) {
  const evidence = [], gaps = []
  let projectId = args.project_id || null
  if (!args.source_run_id) return { evidence, gaps, projectId }
  const dir = runPath(agent, args.source_run_id)
  const state = JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8'))
  if (!Array.isArray(state.files)) throw new Error('source_run_id 必须指向材料导入运行')
  if (projectId && state.projectId && String(projectId) !== String(state.projectId)) throw new Error('材料所属项目与生成项目不一致，已阻止跨项目混用')
  projectId ||= state.projectId || null
  for (const [index, file] of state.files.entries()) {
    if (file.status !== 'converted') { gaps.push(`${file.name}：${file.reason || file.status}`); continue }
    if (!/^materials\/[\p{L}\p{N}._-]+\.md$/u.test(file.materialPath) || file.materialPath.includes('..')) { gaps.push(`${file.name}：材料路径不合法`); continue }
    const text = await readFile(path.join(dir, file.materialPath), 'utf8')
    if (file.contentSha256 && sha256(text) !== file.contentSha256) throw new Error(`${file.name}：导入材料发生变更，请重新导入后规划`)
    // Complete, overlapping windows; no tail is discarded, full originals remain on disk.
    for (let start = 0, part = 1; start < text.length; part++) {
      const end = Math.min(start + 1800, text.length)
      evidence.push({ id: `M${index + 1}-${part}`, kind: 'material', source: file.name,
        sourceSha256: file.contentSha256 || file.sha256 || null, locator: `${file.materialPath}#${part}`,
        content: text.slice(start, end) })
      if (end === text.length) break
      start = end - 160
    }
  }
  return { evidence, gaps, projectId }
}

import path from 'node:path'
import { readJson, atomicJson } from '../persistence.js'
import { runPath } from '../store.js'
import { createSnapshot } from '../content/snapshot.js'

export async function currentDelivery(agent, runId) {
  const dir = runPath(agent, runId)
  const pointer = await readJson(path.join(dir, 'delivery.json'), null)
  if (!pointer) return null
  if (!/^[0-9a-f-]{36}$/iu.test(pointer.exportId)) throw new Error('无效的输出记录')
  const manifest = await readJson(path.join(dir, 'outputs', pointer.exportId, 'manifest.json'), null)
  if (!manifest) return null
  const report = await readJson(path.join(dir, 'report.json'))
  const stale = createSnapshot(report).sourceContentSha256 !== manifest.sourceContentSha256
  return { ...manifest, stale, ...(stale ? { note: '文案已更新，此输出基于旧版本；请仅重新生成输出物' } : {}) }
}

export const saveManifest = (dir, manifest) => atomicJson(path.join(dir, 'manifest.json'), manifest)

export function deliverySummary(manifest) {
  if (!manifest) return null
  return { exportId: manifest.exportId, runId: manifest.runId, status: manifest.status, jobId: manifest.jobId || null,
    sourceContentSha256: manifest.sourceContentSha256, stale: Boolean(manifest.stale),
    documentsReady: Boolean(manifest.documentsReady), htmlReady: manifest.html?.status === 'completed',
    ...(manifest.documents?.markdown ? { markdownPath: manifest.documents.markdown } : {}),
    ...(manifest.documents?.docx ? { docxPath: manifest.documents.docx } : {}),
    ...(manifest.html?.path ? { htmlPath: manifest.html.path } : {}),
    ...(manifest.error ? { error: String(manifest.error).slice(0, 240) } : {}),
    ...(manifest.documentErrors ? { documentErrors: manifest.documentErrors } : {}),
    ...(manifest.warnings?.length ? { warnings: manifest.warnings.slice(0, 3).map(value => String(value).slice(0, 180)) } : {}),
    ...(manifest.note ? { note: manifest.note } : {}) }
}

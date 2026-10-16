import { createHash } from 'node:crypto'
import { flattenOutline } from '../rules.js'
import { coverageFromReport } from './coverage.js'

const list = value => Array.isArray(value) ? value : []
const copy = value => structuredClone(value)
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, copy(value[key])]))
const outlineFields = ['key', 'title', 'roleId', 'required', 'goal', 'questions', 'evidenceScope', 'audience', 'mode', 'framework']
const blockFields = ['text', 'dimension', 'supportMode', 'factIds', 'evidence', 'planRefs', 'capabilityStatus', 'capabilityOwnership',
  'verification', 'referenceWarnings', 'reviewItems', 'subject', 'purpose', 'scope', 'isHypothesis', 'sourceCardIds',
  'conditions', 'limitations', 'boundaries', 'boundaryNotes']
const operational = new Set(['generatedAt', 'createdAt', 'updatedAt', 'startedAt', 'finishedAt', 'reviewFinishedAt', 'approvedAt',
  'elapsedMs', 'durationMs', 'serviceMs', 'queueMs', 'theme', 'layout', 'style', 'font', 'fontFamily', 'colors', 'color', 'animation', 'background'])
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).filter(key => !operational.has(key)).sort().map(key => [key, stable(value[key])])) : value

function contentProjection(report = {}) {
  const sections = new Map(list(report.sections).map(section => [section.key, section]))
  const outcomes = new Map(list(report.chapterOutcomes).map(row => [row.key, row]))
  const outline = nodes => list(nodes).map(node => ({ ...pick(node, outlineFields),
    ...(list(node.children).length ? { children: outline(node.children) } : {}) }))
  const normalizedOutline = outline(report.outline)
  return { schemaVersion: 1, title: String(report.title || ''), outline: normalizedOutline,
    sections: flattenOutline(normalizedOutline).map(node => {
      const section = sections.get(node.key) || {}, outcome = outcomes.get(node.key) || {}
      const record = report.chapterRecords?.[node.key] || {}
      const blocks = list(section.blocks).filter(block => typeof block?.text === 'string' && block.text.trim())
      return { key: node.key, title: section.title || node.title, roleId: section.roleId || node.roleId,
        version: record.version || outcome.version || section.version || 1,
        approvalStatus: record.approvalStatus || section.approvalStatus || 'pending',
        status: outcome.status || section.status || (blocks.length ? 'completed' : 'pending'),
        ...pick(section, ['mode', 'framework', 'inputNeeded']),
        blocks: blocks.map((block, index) => ({ id: block.id || `${node.key}-${index + 1}`, ...pick(block, blockFields) })) }
    }), choices: copy(report.choices || {}), assemblyLinks: copy(list(report.assemblyLinks)),
    assemblyReview: stable(report.assemblyReview || null), reviewStatus: report.reviewStatus || 'pending' }
}

/** A content/version fingerprint. Renderer themes and generation timestamps cannot invalidate it. */
export function snapshotHash(reportOrSnapshot) {
  return createHash('sha256').update(JSON.stringify(stable(contentProjection(reportOrSnapshot)))).digest('hex')
}

/** Read-only projection: output adapters consume it without changing report.json or writing rules. */
export function createSnapshot(report) {
  const content = contentProjection(report)
  return { ...content, runId: report.runId, coverage: coverageFromReport(report), sourceContentSha256: snapshotHash(content) }
}

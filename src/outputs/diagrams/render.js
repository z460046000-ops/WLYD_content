import { execFile } from 'node:child_process'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const engine = fileURLToPath(new URL('../../../vendor/fireworks-tech-graph/', import.meta.url))
const xml = value => String(value).replace(/[<>&"']/gu, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char])
const round = value => Math.ceil(value / 4) * 4

/** Layout is an adapter decision. Fireworks receives actual coordinates, never invented layout fields. */
export function fireworksInput(plan) {
  const groups = [...new Set(plan.nodes.map(node => node.sectionKey))], nodes = [], containers = []
  let y = 144
  for (const [groupIndex, key] of groups.entries()) {
    const groupNodes = plan.nodes.filter(node => node.sectionKey === key)
    const source = plan.sources.find(unit => unit.sectionKey === key)
    let rowY = y + 80
    const parent = `g-${groupIndex + 1}`
    for (let index = 0; index < groupNodes.length; index += 2) {
      const row = groupNodes.slice(index, index + 2)
      const height = round(Math.max(144, ...row.map(node => Math.ceil([...node.label].length / 28) * 28 + 72)))
      for (const [column, node] of row.entries()) {
        const units = plan.sources.filter(unit => node.unitIds.includes(unit.id))
        const candidate = units.some(unit => unit.supportMode === 'candidate' || unit.verification === 'unverified')
        const states = [...new Set(units.map(unit => ({ pilot: '试点', planned: '规划', proposed: '建议', existing: '现有' })[unit.capabilityStatus]).filter(Boolean))]
        const owners = [...new Set(units.map(unit => ({ 'third-party': '第三方', customer: '客户能力' })[unit.capabilityOwnership]).filter(Boolean))]
        nodes.push({ id: node.id, parent, x: 80 + column * 760, y: rowY, width: 680, height,
          label: node.label, title_size: 22, sublabel: [candidate ? '候选·待确认' : '原文提炼·待复核', ...states, ...owners].join(' / ') })
      }
      rowY += height + 60
    }
    const height = rowY - y
    containers.push({ id: parent, x: 40, y, width: 1520, height, label: source.sectionTitle || key })
    y += height + 48
  }
  return { schema_version: 1, mode: 'architecture', style: 4, semantic_profile: 'generic',
    title: plan.title, subtitle: plan.mode === 'source-overview' ? '原文摘录视图；请结合正文条件确认' : '文案提炼初稿；引用定位不代表业务已确认',
    width: 1600, height: round(y + 64), text_policy: 'strict', quality_profile: 'showcase',
    style_overrides: { font_family: 'PingFang SC, Noto Sans SC, Microsoft YaHei, sans-serif' },
    containers, nodes, arrows: plan.edges.map((edge, index) => ({ id: `e-${index + 1}`, source: edge.source,
      target: edge.target, label: edge.label, flow: 'control' })) }
}

function invoke(python, args, input, signal) {
  return new Promise((resolve, reject) => {
    const child = execFile(python, ['-B', ...args], { signal, timeout: 30_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', windowsHide: true },
      (error, stdout, stderr) => error ? reject(new Error(error.code === 'ENOENT'
        ? '未找到Python，SVG绘图需要Python 3.9+；原文档已保留'
        : `fireworks绘图或校验失败：${String(stderr || stdout || error.message).slice(0, 1200)}`, { cause: error })) : resolve({ stdout, stderr }))
    child.stdin.on('error', () => {})
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input))
  })
}

/** Render into private staging; only publish a path after the engine and XML/geometry checks pass. */
export async function renderDiagram(plan, { outputDir, python = 'python3', signal } = {}) {
  const input = fireworksInput(plan), stem = path.join(outputDir, plan.kind)
  const temporary = `${stem}.pending.svg`, target = `${stem}.svg`, reportPath = `${stem}.layout.json`
  await writeFile(`${stem}.fireworks.json`, JSON.stringify(input, null, 2), { mode: 0o600 })
  await invoke(python, [path.join(engine, 'scripts/generate-from-template.py'), 'architecture', temporary, '--report', reportPath], input, signal)
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  if (report.ok !== true) throw new Error('fireworks报告未通过，图稿和报告已保留')
  const svg = await readFile(temporary, 'utf8')
  const provenance = { sourceContentSha256: plan.sourceContentSha256, semanticStatus: plan.semanticStatus,
    mode: plan.mode, sourceBlockIds: [...new Set(plan.nodes.flatMap(node => node.sourceBlockIds))] }
  const traced = svg.replace('</svg>', `<metadata id="wlyd-source">${xml(JSON.stringify(provenance))}</metadata></svg>`)
  if (traced === svg || /<script\b|\bon\w+\s*=|(?:href|src)\s*=\s*["'](?:https?:|\/\/)/iu.test(svg)) throw new Error('SVG结构或资源检查未通过')
  await writeFile(temporary, traced, { mode: 0o600 })
  const validation = []
  for (const check of ['xml', 'markers', 'collisions', 'geometry', 'composition']) {
    await invoke(python, [path.join(engine, 'scripts/validate_svg.py'), temporary, '--check', check], undefined, signal)
    validation.push(check)
  }
  if (signal?.aborted) throw signal.reason || new Error('绘图已取消')
  await rename(temporary, target)
  return { path: target, reportPath, inputPath: `${stem}.fireworks.json`, validation,
    visualReview: 'pending', semanticStatus: 'draft_unverified' }
}

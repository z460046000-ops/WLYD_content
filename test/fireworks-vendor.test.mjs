import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../vendor/fireworks-tech-graph/', import.meta.url))
const python = process.env.PYTHON || 'python3'
const checks = ['xml', 'markers', 'collisions', 'geometry', 'composition']

test('fireworks 原件固定上游提交与逐文件摘要，裁剪范围不包含导出及安装依赖', async () => {
  const upstream = JSON.parse(await readFile(join(root, 'UPSTREAM.json'), 'utf8'))
  assert.equal(upstream.commit, '31fea364eda5f1852b1175f3d9e29ea31d22dcb4')
  assert.equal(upstream.license, 'MIT')
  assert.equal(upstream.runtime.minimumPython, '3.9')
  for (const file of upstream.files) {
    assert.equal(file.sourcePath, `skills/fireworks-tech-graph/${file.path}`)
    assert.equal(createHash('sha256').update(await readFile(join(root, file.path))).digest('hex'), file.sha256, file.path)
    assert.doesNotMatch(file.path, /(?:fixtures\/|tests\/|motion\.py|fireworks\.py|package\.json|\.(?:gif|png|jpe?g)$)/u)
  }
})

test('fireworks 使用标准库从中文 JSON 生成分组 SVG，五项检查通过且坏 SVG 被拒绝', async t => {
  const probe = spawnSync(python, ['-B', '-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3,9) else 1)'], { encoding: 'utf8' })
  if (probe.error?.code === 'ENOENT') return t.skip('本机没有 Python；未验证实际 SVG 渲染')
  assert.ifError(probe.error)
  assert.equal(probe.status, 0, 'fireworks 静态 SVG 需要 Python 3.9+')
  const temp = await mkdtemp(join(tmpdir(), 'assembly-fireworks-vendor-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const svgPath = join(temp, 'simple-zh.svg'), reportPath = join(temp, 'layout.json')
  const data = {
    schema_version: 1, mode: 'architecture', style: 4, semantic_profile: 'generic',
    title: '中文业务图验证', text_policy: 'strict', width: 960, height: 460,
    containers: [{ id: 'business', x: 48, y: 120, width: 864, height: 260, label: '业务流程', subtitle: '本地静态验证' }],
    nodes: [
      { id: 'input', parent: 'business', x: 120, y: 210, width: 260, height: 96, label: '需求受理', sublabel: '明确客户需求' },
      { id: 'output', parent: 'business', x: 580, y: 210, width: 260, height: 96, label: '方案交付', sublabel: '提供可核对结果' }
    ],
    arrows: [{ id: 'handoff', source: 'input', target: 'output', source_port: 'right', target_port: 'left', flow: 'control', label: '处理' }]
  }
  const render = spawnSync(python, ['-B', join(root, 'scripts/generate-from-template.py'), 'architecture', svgPath, '--report', reportPath],
    { input: JSON.stringify(data), encoding: 'utf8', timeout: 30000 })
  assert.ifError(render.error)
  assert.equal(render.status, 0, render.stdout + render.stderr)
  const svg = await readFile(svgPath, 'utf8'), report = JSON.parse(await readFile(reportPath, 'utf8'))
  for (const label of ['中文业务图验证', '业务流程', '本地静态验证', '需求受理', '明确客户需求', '方案交付', '提供可核对结果', '处理']) assert.ok(svg.includes(label), label)
  assert.equal(report.ok, true)
  assert.deepEqual(report.issues, [])
  assert.ok(svg.includes('data-source="input" data-target="output"'))
  for (const check of checks) {
    const result = spawnSync(python, ['-B', join(root, 'scripts/validate_svg.py'), svgPath, '--check', check], { encoding: 'utf8', timeout: 30000 })
    assert.ifError(result.error)
    assert.equal(result.status, 0, `${check}: ${result.stdout}${result.stderr}`)
    assert.equal(result.stdout, '', `${check}: 成功时标准输出应为空`)
  }
  const brokenPath = join(temp, 'broken.svg')
  await writeFile(brokenPath, '<svg>')
  const broken = spawnSync(python, ['-B', join(root, 'scripts/validate_svg.py'), brokenPath, '--check', 'xml'], { encoding: 'utf8', timeout: 30000 })
  assert.ifError(broken.error)
  assert.equal(broken.status, 1)
  assert.match(broken.stdout, /no element found/u)
})

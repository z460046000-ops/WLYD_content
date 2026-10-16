import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { enrichPanoramas } from '../src/panorama.js'
import { reviewAssembly } from '../src/review.js'
import { validateDraft } from '../src/content.js'
import { loadRules } from '../src/rules.js'
import { completeAudit } from './helpers.mjs'

const outline = [{ key: 'business', title: '业务全景', roleId: 'business-architecture' },
  { key: 'product', title: '产品全景', roleId: 'product-architecture' },
  { key: 'scene', title: '协作场景', roleId: 'scenario-solution' }]
const plan = { capabilities: [], scenarios: [{ id: 'handoff', title: '协作交接', capabilityIds: [], problemIds: [], trendIds: [] }], problems: [], trends: [] }
const block = text => ({ text, supportMode: 'candidate', evidence: [], planRefs: { capabilityIds: [], scenarioIds: ['handoff'], problemIds: [], trendIds: [] } })
async function fixture(request) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wlyd-panorama-resume-')), rules = await loadRules()
  const sections = validateDraft({ sections: outline.map(node => ({ key: node.key, blocks: [block('可考虑在协作交接过程中明确接收信息与责任主体。')] })) }, [], outline, plan).sections
  for (const node of outline) await mkdir(path.join(dir, 'chapters', node.key), { recursive: true })
  return { request, common: { author: { identity: '业务顾问' }, audience: '业务负责人' }, rules, outline, plan,
    chapters: sections.map(section => ({ section, gaps: [], validationIssues: [], reviewItems: [] })), evidence: [], dir,
    state: { chapters: outline.map(node => ({ key: node.key, path: `chapters/${node.key}/chapter.json` })) }, saveState: async () => {}, signal: new AbortController().signal }
}
const addition = () => ({ additions: [{ key: 'business', blocks: [block('可增加交接核对节点，提示责任人与接收方确认产出。')] }], reviewItems: [] })

test('全景完整结果按输入和内容指纹复用，产物与原稿均可校验', async () => {
  let calls = 0
  const options = await fixture(async () => { calls++; return addition() })
  const first = await enrichPanoramas(options)
  assert.equal(calls, 1); assert.equal(options.state.panoramaEnrichment.status, 'completed')
  const second = await enrichPanoramas(options)
  assert.equal(calls, 1)
  assert.deepEqual(second, first)
  assert.equal(options.state.panoramaEnrichment.cached, true)
  const saved = JSON.parse(await readFile(path.join(options.dir, 'panorama-enrichment.json'), 'utf8'))
  assert.match(saved.inputSha256, /^[a-f0-9]{64}$/u); assert.match(saved.resultSha256, /^[a-f0-9]{64}$/u)
  assert.ok(saved.result.chapters.length === outline.length)
  assert.ok(saved.updatedChapters[0].outputSha256)
  assert.ok((await readdir(options.dir)).every(file => !file.endsWith('.tmp')))
})

test('规则、正文、计划、目录、证据及模型变化都使全景缓存失效', async () => {
  for (const change of [
    options => { options.rules = { ...options.rules, fingerprint: 'another-rules' } },
    options => { options.chapters = structuredClone(options.chapters); options.chapters[2].section.blocks[0].text += ' 核对交接条件。' },
    options => { options.plan = { ...options.plan, title: '另一主线' } },
    options => { options.outline = options.outline.map(node => node.key === 'scene' ? { ...node, title: '交接场景' } : node) },
    options => { options.evidence = [{ id: 'extra', content: '补充的业务边界材料。' }] },
    options => { options.state.modelSelection = { provider: 'test', model: 'another-model' } },
  ]) {
    let calls = 0
    const options = await fixture(async () => { calls++; return addition() })
    await enrichPanoramas(options); change(options); await enrichPanoramas(options)
    assert.equal(calls, 2)
  }
})

test('失败或部分结果不复用；完整缓存正文或输出文件损坏时重新执行', async () => {
  for (const mode of ['failed', 'partial', 'tampered-result', 'tampered-output']) {
    let calls = 0
    const options = await fixture(async () => {
      calls++
      if (calls === 1 && mode === 'failed') throw new Error('temporary failure')
      if (calls === 1 && mode === 'partial') return { additions: [{ key: 'unknown', blocks: [block('不能写入目录外的内容。')] }] }
      return addition()
    })
    await enrichPanoramas(options)
    if (mode === 'tampered-result') {
      const file = path.join(options.dir, 'panorama-enrichment.json')
      const saved = JSON.parse(await readFile(file, 'utf8')); saved.result.chapters[0].section.blocks[0].text = '损坏的缓存内容'
      await writeFile(file, JSON.stringify(saved))
    }
    if (mode === 'tampered-output') await writeFile(path.join(options.dir, 'chapters/business/enriched.json'), '{broken')
    await enrichPanoramas(options)
    assert.equal(calls, 2)
    assert.equal(options.state.panoramaEnrichment.status, 'completed')
  }
})

test('合稿审核指纹明确绑定规则版本，即使只传作者读者也不能跨规则复用', async () => {
  let calls = 0
  const options = await fixture(async () => { calls++; return completeAudit() })
  const review = { ...options, sections: options.chapters.map(chapter => chapter.section), ruleFingerprint: 'rules-first' }
  await reviewAssembly(review)
  const firstCalls = calls
  await reviewAssembly(review)
  assert.equal(calls, firstCalls)
  review.ruleFingerprint = 'rules-second'
  await reviewAssembly(review)
  assert.equal(calls, firstCalls * 2)
  const saved = JSON.parse(await readFile(path.join(options.dir, 'consistency-review.json'), 'utf8'))
  assert.equal(saved.ruleFingerprint, 'rules-second')
})

test('全景新增段被用途回调拒绝时保留原稿并记录校验事项', async () => {
  const options = await fixture(async () => addition())
  const original = structuredClone(options.chapters)
  const seen = []
  options.validateBlock = (candidate, chapterKey) => {
    seen.push([chapterKey, candidate.text])
    throw new Error('本章用途不接受此补充')
  }
  const result = await enrichPanoramas(options)
  assert.deepEqual(result.chapters, original)
  assert.equal(seen.length, 1)
  assert.equal(seen[0][0], 'business')
  assert.equal(options.state.panoramaEnrichment.status, 'partial')
  assert.ok(result.validationIssues.some(item => item.includes('本章用途不接受此补充')))
  assert.ok(options.state.chapters.every(row => row.path.endsWith('/chapter.json')))
})

test('全景缓存追加段仍须通过用途回调，拒绝后不发新请求且恢复原稿指针', async () => {
  let calls = 0
  const options = await fixture(async () => { calls++; return addition() })
  const original = structuredClone(options.chapters)
  await enrichPanoramas(options)
  assert.equal(options.state.chapters[0].path, 'chapters/business/enriched.json')
  options.validateBlock = (candidate, chapterKey) => {
    assert.equal(chapterKey, 'business')
    assert.match(candidate.text, /交接核对节点/u)
    throw new Error('缓存段落用途不符')
  }
  const result = await enrichPanoramas(options)
  assert.equal(calls, 1)
  assert.deepEqual(result.chapters, original)
  assert.equal(options.state.panoramaEnrichment.status, 'partial')
  assert.equal(options.state.panoramaEnrichment.additions, 0)
  assert.ok(result.validationIssues.some(item => item.includes('缓存段落用途不符')))
  assert.equal(options.state.chapters[0].path, 'chapters/business/chapter.json')
})

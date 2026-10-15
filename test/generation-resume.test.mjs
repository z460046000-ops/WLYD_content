import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { generateChapters, normalizePlan } from '../src/generation.js'
import { loadRules } from '../src/rules.js'
import { completeAudit } from './helpers.mjs'

const source = { id: 'M1', kind: 'material', source: 'facts.md', sourceSha256: 'original-file', locator: 'facts.md#1',
  content: '产品支持统一线索记录，销售和客服可以围绕同一记录协作。' }
const ref = { id: 'M1', quote: '产品支持统一线索记录' }
const model = handle => ({ async *stream(request) {
  const prompt = JSON.parse(request.messages[0].content[0].text)
  const answer = await handle(prompt)
  yield { type: 'text-delta', text: JSON.stringify(answer) }
  yield { type: 'finish', reason: { kind: 'stop' } }
} })
const answer = prompt => prompt.stage === 'extract' ? { facts: [{ text: '支持统一线索记录', evidence: [ref] }] }
  : prompt.stage === 'consistency-review' ? completeAudit()
    : { sections: [{ key: prompt.chapter.key, blocks: [{ text: '可围绕统一线索记录组织销售和客服的协作流程。', supportMode: 'candidate', evidence: [] }] }] }
async function fixture() {
  const rules = await loadRules(), dir = await mkdtemp(path.join(os.tmpdir(), 'wlyd-resume-'))
  const outline = [{ key: 'one', title: '业务协作', roleId: 'delivery-service' }, { key: 'two', title: '交接流程', roleId: 'delivery-service' }]
  const evidence = [structuredClone(source)], state = {}, retrieved = []
  const acceptedPlan = normalizePlan({ title: '协作方案' }, evidence, outline)
  const options = { rules, dir, outline, evidence, state, acceptedPlan, args: { plan_id: 'confirmed-plan', plan_sha256: 'confirmed-hash' },
    exec: { agent: { options: { provider: 'fake', model: 'fake' } }, signal: new AbortController().signal },
    saveState: async () => {}, retrieval: { issues: [], forChapter: async node => { retrieved.push(node.key); return evidence } } }
  return { options, state, retrieved, dir }
}

test('续跑仅补失败章：完整章校验复用、失败章复用提取、保留请求并重新关联复核', async () => {
  const f = await fixture(), firstCalls = [], secondCalls = []
  f.options.llm = model(prompt => {
    firstCalls.push([prompt.stage, prompt.chapter?.key])
    if (prompt.stage === 'write' && prompt.chapter.key === 'two') throw Object.assign(new Error('needs authorization'), { code: 'AUTH' })
    return answer(prompt)
  })
  const initial = await generateChapters(f.options)
  assert.equal(initial.sections.length, 1)
  assert.equal(f.state.chapters.find(row => row.key === 'two').status, 'failed')
  assert.equal(firstCalls.filter(([stage, key]) => stage === 'write' && key === 'two').length, 1)
  const previousRequests = f.state.modelRequests.length
  f.options.llm = model(prompt => { secondCalls.push([prompt.stage, prompt.chapter?.key]); return answer(prompt) })
  const resumed = await generateChapters({ ...f.options, resume: true })
  assert.equal(resumed.sections.length, 2)
  assert.equal(f.state.chapters.find(row => row.key === 'one').reusedChapter, true)
  assert.equal(f.state.chapters.find(row => row.key === 'two').reusedExtraction, true)
  assert.equal(secondCalls.filter(([stage]) => stage === 'extract').length, 0)
  assert.equal(secondCalls.filter(([stage]) => stage === 'write').length, 1)
  assert.equal(secondCalls.find(([stage]) => stage === 'write')[1], 'two')
  assert.ok(secondCalls.some(([stage]) => stage === 'consistency-review'))
  assert.ok(f.state.modelRequests.length > previousRequests)
  assert.deepEqual(f.retrieved.sort(), ['one', 'two'])
})

test('损坏正文不能作为完整章，损坏提取不能作为事实卡，规则变化重新取证', async () => {
  const f = await fixture()
  f.options.llm = model(answer)
  await generateChapters(f.options)
  const chapterFile = path.join(f.dir, 'chapters/one/chapter.json')
  const chapter = JSON.parse(await readFile(chapterFile, 'utf8'))
  chapter.section.blocks = []
  await writeFile(chapterFile, JSON.stringify(chapter))
  const extractionFile = path.join(f.dir, 'chapters/two/extraction.json')
  const extraction = JSON.parse(await readFile(extractionFile, 'utf8'))
  extraction.facts[0].evidence[0].quote = '伪造不属于原文的引文'
  await writeFile(extractionFile, JSON.stringify(extraction))
  const calls = []
  f.options.llm = model(prompt => { calls.push([prompt.stage, prompt.chapter?.key]); return answer(prompt) })
  await generateChapters({ ...f.options, resume: true })
  assert.equal(f.state.chapters.find(row => row.key === 'one').reusedChapter, false)
  assert.equal(f.state.chapters.find(row => row.key === 'one').reusedExtraction, true)
  assert.equal(f.state.chapters.find(row => row.key === 'two').reusedExtraction, false)
  assert.deepEqual(calls.filter(([stage]) => stage === 'extract').map(([, key]) => key), ['two'])
  f.options.rules = { ...f.options.rules, fingerprint: 'changed-rules' }
  calls.length = 0
  await generateChapters({ ...f.options, resume: true })
  assert.equal(calls.filter(([stage]) => stage === 'extract').length, 2)
})

test('相同证据ID内容变化时不复用旧章或旧提取', async () => {
  const f = await fixture()
  f.options.llm = model(answer)
  await generateChapters(f.options)
  f.options.evidence[0].content += ' 新增边界：当前只适用于试点范围。'
  const calls = []
  f.options.llm = model(prompt => { calls.push(prompt.stage); return answer(prompt) })
  await generateChapters({ ...f.options, resume: true })
  assert.equal(calls.filter(stage => stage === 'extract').length, 2)
  assert.ok(f.state.chapters.every(row => !row.reusedChapter && !row.reusedExtraction))
})

test('撰写排队超时不会拆分为更多模型请求', async () => {
  const f = await fixture(), calls = []
  f.options.llm = model(prompt => {
    calls.push([prompt.stage, prompt.chapter?.key])
    if (prompt.stage === 'write') throw Object.assign(new Error('queue timeout'), { code: 'MODEL_QUEUE_TIMEOUT' })
    return answer(prompt)
  })
  await assert.rejects(generateChapters(f.options), /全部章节未完成/u)
  assert.equal(calls.filter(([stage]) => stage === 'write').length, 2)
})

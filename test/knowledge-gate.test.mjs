import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { generateChapters } from '../src/generation.js'
import { createRetrieval } from '../src/retrieval.js'
import { loadRules } from '../src/rules.js'
import { completeAudit } from './helpers.mjs'

test('必需章当次知识库零命中时只用知识库锚点写待确认草稿，记录部分完成', async () => {
  const rules = await loadRules()
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wlyd-kb-gate-'))
  const anchor = { id: 'Kanchor', kind: 'knowledge', knowledgeBaseId: 'B1', knowledgeId: 'D1', chunkId: 'old',
    content: '知识库中记录了统一线索协作能力。' }
  const local = { id: 'M1', kind: 'material', content: '本地材料描述了客户已经签约和交付。' }
  const evidence = [anchor, local]
  const client = { visibleProjectBases: async () => ['B1'], documents: async () => [{ id: 'D1', parse_status: 'completed' }],
    searchEvidence: async () => ({ items: [], status: 'completed', source: 'unified', partial: false }) }
  const outline = [{ key: 'service', title: '协作服务', roleId: 'delivery-service', required: true }]
  const acceptedPlan = { title: '协作服务方案', choices: { businessMode: { value: 'needs-challenges' }, trendFramework: { value: 'pest' } },
    capabilities: [{ id: 'cap-1', text: '统一线索协作', supportMode: 'candidate', evidence: [{ id: anchor.id, quote: '统一线索协作能力' }] }],
    problems: [], trends: [], scenarios: [], reviewItems: [],
    chapterGuidance: [{ key: 'service', capabilityIds: ['cap-1'], retrievalQueries: ['交付服务如何支撑统一线索协作'] }] }
  const retrieval = createRetrieval({ client, projectId: 'P1', evidence, dir, rules, outline, signal: new AbortController().signal })
  const supplied = []
  const llm = { async *stream(request) {
    const prompt = JSON.parse(request.messages[0].content[0].text)
    supplied.push(prompt)
    const value = prompt.stage === 'extract'
      ? { facts: [{ text: '可考虑统一线索协作交付方式', supportMode: 'candidate', evidence: [] }] }
      : prompt.stage === 'consistency-review' ? completeAudit()
        : { sections: [{ key: 'service', blocks: [{ text: '可考虑围绕统一线索协作安排交付服务。', supportMode: 'candidate', evidence: [] }] }] }
    yield { type: 'text-delta', text: JSON.stringify(value) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const state = {}
  const result = await generateChapters({ llm, exec: { agent: { options: { provider: 'fake', model: 'fake' } },
    signal: new AbortController().signal }, args: {}, rules, outline, evidence, dir, state, saveState: async () => {},
  retrieval, acceptedPlan })
  assert.equal(result.sections.length, 1)
  assert.equal(result.chapterOutcomes[0].status, 'partial')
  assert.equal(state.chapters[0].knowledgeHits, 0)
  assert.equal(state.chapters[0].knowledgeStatus, 'empty')
  assert.ok(state.chapters[0].knowledgeQueries > 0)
  assert.match(state.chapters[0].error, /知识库检索零命中/u)
  assert.equal(result.review.passed, false)
  assert.ok(supplied.filter(prompt => prompt.stage === 'extract' || prompt.stage === 'write')
    .every(prompt => prompt.evidence.every(row => row.id !== local.id)))
  const log = JSON.parse(await readFile(path.join(dir, 'chapters/service/retrieval.json'), 'utf8'))
  assert.equal(log.knowledgeStatus, 'empty')
  assert.deepEqual(log.planAnchors, [anchor.id])
})

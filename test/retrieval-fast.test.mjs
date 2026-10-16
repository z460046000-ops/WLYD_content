import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRetrieval } from '../src/retrieval.js'

const signal = new AbortController().signal
const node = { key: 'sales', roleId: 'scenarios', title: '客户增长', goal: '降低销售移交损耗' }
const plan = { chapterGuidance: [{ key: 'sales', focus: '线索记录到协作移交', capabilityIds: ['c1'],
  retrievalQueries: ['查找销售协作的产品原文', '查找移交确认的业务动作'] }],
capabilities: [{ id: 'c1', text: '统一线索记录', evidence: [] }] }
const response = (items = []) => ({ items, status: 'completed', source: 'unified', partial: false })
const row = (id, content, knowledgeId = 'D1') => ({ id, knowledge_id: knowledgeId, content })
const longContent = '统一线索记录支持客户经理记录跟进过程，客服接收移交并确认处理结果。'.repeat(8)

async function fixture(searchEvidence, evidence = []) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wlyd-fast-retrieval-'))
  const calls = []
  const retrieval = createRetrieval({ client: {
    visibleProjectBases: async () => ['B1'],
    documents: async () => [{ id: 'D1', parse_status: 'completed' }, { id: 'D2', parse_status: 'pending' }],
    searchEvidence: async (baseId, query, documentIds) => {
      calls.push({ baseId, query, documentIds })
      return searchEvidence(calls.length, query)
    },
  }, projectId: 'P1', evidence, dir, signal })
  return { retrieval, calls, dir, readAudit: async (key = node.key) => JSON.parse(await readFile(
    path.join(dir, 'chapters', key, 'retrieval.json'), 'utf8')) }
}

test('fast 有充分原文只查一次，合并章节目标主线和首检索指引并记录策略', async () => {
  const { retrieval, calls, readAudit } = await fixture(() => response([
    row('C1', longContent), row('C2', '未完成文档不得入选', 'D2'),
  ]))
  const selected = await retrieval.forChapter(node, plan, [], { strategy: 'fast' })
  assert.equal(calls.length, 1)
  for (const part of ['客户增长', '降低销售移交损耗', '线索记录到协作移交', '统一线索记录', '查找销售协作的产品原文']) {
    assert.ok(calls[0].query.includes(part), part)
  }
  assert.deepEqual(calls[0].documentIds, ['D1'])
  assert.equal(selected.length, 1)
  const audit = await readAudit()
  assert.equal(audit.strategy, 'fast')
  assert.equal(audit.knowledgeQueryCount, 1)
  assert.equal(audit.queries[0].attempt, 'primary')
  assert.equal(audit.queries[0].strategy, 'fast')
  assert.equal(audit.knowledgeHitCount, 1)
})

test('fast 成功但空时只补一条不同查询，旧规划锚点不冒充当前命中', async () => {
  const anchor = { id: 'Kanchor', kind: 'knowledge', knowledgeBaseId: 'B1', knowledgeId: 'D1',
    chunkId: 'old', content: '旧规划证据' }
  const anchoredPlan = { ...plan, capabilities: [{ ...plan.capabilities[0], evidence: [{ id: anchor.id }] }] }
  const local = { id: 'M1', kind: 'material', content: '本地销售材料' }
  const { retrieval, calls, readAudit } = await fixture(() => response(), [anchor, local])
  const selected = await retrieval.forChapter(node, anchoredPlan, [], { strategy: 'fast' })
  assert.equal(calls.length, 2)
  assert.notEqual(calls[0].query, calls[1].query)
  assert.ok(calls[1].query.includes('查找移交确认的业务动作'))
  assert.deepEqual(new Set(selected.map(item => item.id)), new Set(['M1', 'Kanchor']))
  const audit = await readAudit()
  assert.equal(audit.knowledgeHitCount, 0)
  assert.equal(audit.knowledgeStatus, 'empty')
  assert.deepEqual(audit.planAnchors, ['Kanchor'])
  assert.deepEqual(audit.queries.map(item => item.attempt), ['primary', 'fallback'])
  await retrieval.forChapter(node, anchoredPlan, [], { strategy: 'fast' })
  assert.equal(calls.length, 2, '重复调用复用本章相同查询，不新增网络检索')
})

test('fast 明显过少时补查一次并保留两次真命中，不重复登记相同分块', async () => {
  const { retrieval, calls, readAudit } = await fixture(count => response(count === 1 ?
    [row('C1', '线索记录。')] : [row('C1', '线索记录。'), row('C2', longContent)]))
  const selected = await retrieval.forChapter(node, plan, [], { strategy: 'fast' })
  assert.equal(calls.length, 2)
  assert.equal(selected.length, 2)
  assert.equal((await readAudit()).knowledgeHitCount, 2)
})

test('fast 接口失败、来源失败、结构异常或部分结果均不通过增加查询掩盖失败', async () => {
  const outcomes = [
    () => { throw new Error('HTTP 403') },
    () => ({ ...response(), status: 'failed', error: '检索超时' }),
    () => ({ ...response(), items: null }),
    () => ({ ...response(), partial: true }),
  ]
  for (const outcome of outcomes) {
    const { retrieval, calls, readAudit } = await fixture(outcome)
    await retrieval.forChapter(node, plan, [], { strategy: 'fast' })
    assert.equal(calls.length, 1)
    const audit = await readAudit()
    assert.equal(audit.queries.length, 1)
    if (!audit.queries[0].partial) assert.equal(audit.queries[0].status, 'failed')
  }
})

test('fast 两个章节分别检索，不共享伪命中；显式补查最多一条且一轮', async () => {
  const { retrieval, calls } = await fixture(() => response([row('C1', longContent)]))
  await retrieval.forChapter(node, plan, [], { strategy: 'fast' })
  await retrieval.forChapter({ ...node, key: 'sales-two' }, { chapterGuidance: [] }, [], { strategy: 'fast' })
  assert.equal(calls.length, 2)
  assert.equal(retrieval.chapterKnowledgeHits(node.key).length, 1)
  assert.equal(retrieval.chapterKnowledgeHits('sales-two').length, 1)
  await retrieval.forChapter(node, plan, ['产品接入范围', '其他次要问题'], { strategy: 'fast' })
  assert.equal(calls.length, 3)
  assert.ok(calls[2].query.includes('产品接入范围'))
  assert.ok(!calls[2].query.includes('其他次要问题'))
  await retrieval.forChapter(node, plan, ['不得新增第二轮'], { strategy: 'fast' })
  assert.equal(calls.length, 3)
})

test('fast 无项目权限时不发查询也不启动备用检索', async () => {
  let requests = 0
  const retrieval = createRetrieval({ client: { visibleProjectBases: async () => { throw new Error('HTTP 403') },
    searchEvidence: async () => { requests++; return response() } }, projectId: 'P1', evidence: [], signal })
  await retrieval.forChapter(node, plan, [], { strategy: 'fast' })
  assert.equal(requests, 0)
  assert.match(retrieval.issues[0], /知识库授权范围准备失败/u)
})

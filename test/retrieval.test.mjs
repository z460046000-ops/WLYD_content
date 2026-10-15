import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PlatformClient } from '../src/platform.js'
import { createRetrieval } from '../src/retrieval.js'

const signal = new AbortController().signal
const row = (id, content, knowledgeId = 'D1') => ({
  id, knowledge_id: knowledgeId, content, knowledge_title: 'CallWan 产品资料',
  chunk_index: Number(id.replace(/\D/gu, '')) || 1,
})

test('统一接口只请求 hybrid 原文，按完成文档过滤；只在 404/405 回退旧接口', async () => {
  const calls = []
  let status = 200
  const fetchImpl = async (url, request) => {
    calls.push({ url, body: JSON.parse(request.body) })
    if (url.endsWith('/retrieval/query') && status !== 200) return Response.json({ success: false }, { status })
    if (url.endsWith('/retrieval/query')) return Response.json({ success: true, data: {
      sources: { hybrid: { status: 'completed', items: [row('C1', '有效资料'), row('C2', '越权资料', 'D2')] } },
      meta: { partial: false, trace_id: 'trace-1' },
    } })
    return Response.json({ data: [row('C1', '有效资料'), row('C2', '越权资料', 'D2')] })
  }
  const client = new PlatformClient({ baseUrl: 'https://example.test', tenantId: 'T1' }, fetchImpl)
  client.token = 'test-token'
  await assert.rejects(client.searchEvidence('B1', '产品能力', [], signal), /没有可检索/u)
  const unified = await client.searchEvidence('B1', '产品能力', ['D1'], signal)
  assert.equal(unified.source, 'unified')
  assert.deepEqual(unified.items.map(item => item.id), ['C1'])
  assert.equal(unified.traceId, 'trace-1')
  assert.deepEqual(calls.at(-1).body.sources, [{ type: 'hybrid', top_k: 12 }])
  assert.deepEqual(calls.at(-1).body.query.filters.knowledge_ids, ['D1'])
  assert.equal(calls.at(-1).body.options.include_citations, true)
  status = 404
  const legacy = await client.searchEvidence('B1', '产品能力', ['D1'], signal)
  assert.equal(legacy.source, 'legacy')
  assert.deepEqual(legacy.items.map(item => item.id), ['C1'])
  assert.equal(calls.at(-1).body.match_count, 12)
  const before = calls.length
  status = 403
  await assert.rejects(client.searchEvidence('B1', '产品能力', ['D1'], signal), /HTTP 403/u)
  assert.equal(calls.length, before + 1)
})

test('统一接口来源局部失败不伪装为零命中或切换旧接口', async () => {
  const client = new PlatformClient({ baseUrl: 'https://example.test', tenantId: 'T1' }, async () =>
    Response.json({ success: true, data: { sources: { hybrid: { status: 'failed', error: { message: '向量不可用' } } },
      meta: { partial: true, trace_id: 'trace-partial' } } }))
  client.token = 'test-token'
  const result = await client.searchEvidence('B1', '问题', ['D1'], signal)
  assert.equal(result.status, 'failed')
  assert.equal(result.partial, true)
  assert.equal(result.traceId, 'trace-partial')
  assert.match(result.error, /向量不可用/u)
})

test('逐章只取相关片段与指定共享锚点，完整证据存档且来源 ID 稳定', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wlyd-retrieval-'))
  const local = [
    { id: 'M1-1', kind: 'material', source: '销售.md', content: '销售线索由客户经理录入，形成客户跟进记录。' },
    { id: 'M1-2', kind: 'material', source: '销售.md', content: '线索移交时客服接收并确认，避免跨部门重复询问。' },
    { id: 'M2-1', kind: 'material', source: '架构.md', content: '产品架构支持知识检索、问答和授权管理。' },
    { id: 'M3-1', kind: 'material', source: '介绍.md', content: '公司创立于某年，介绍企业生态与奖项。' },
  ]
  const calls = []
  const client = { visibleProjectBases: async () => ['B1'], documents: async () => [
    { id: 'D1', parse_status: 'completed', title: 'CallWan 产品资料' },
    { id: 'D2', parse_status: 'pending', title: '未完成资料' },
  ], searchEvidence: async (_base, query, documentIds) => {
    calls.push({ query, documentIds })
    return { items: [row('C1', 'CallWan 支持知识检索、智能问答与授权管理。'),
      ...(query.includes('销售') ? [row('C2', '销售线索与客服移交需要确认记录。')] : []),
      row('C3', '未完成材料不得进入正文。', 'D2')],
    status: 'completed', partial: false, traceId: 'trace-1', source: 'unified' }
  } }
  const evidence = [...local]
  const retrieval = createRetrieval({ client, projectId: 'P1', evidence, dir, signal,
    rules: { chapters: { 'business-challenges': { extractQuestions: ['销售线索协作有什么问题'] } } }, audience: '企业客户' })
  await retrieval.prepare()
  const discovery = await retrieval.discover()
  assert.ok(discovery.length < evidence.length + 4)
  const firstId = evidence.find(item => item.chunkId === 'C1').id
  const plan = { chapterGuidance: [{ key: 'sales', focus: '销售线索协作', retrievalQueries: ['销售线索如何移交'],
    capabilityIds: ['cap-1'], problemIds: [], trendIds: [], scenarioIds: [] }],
  capabilities: [{ id: 'cap-1', evidence: [{ id: firstId, quote: 'CallWan 支持知识检索' }] }] }
  const chapter = await retrieval.forChapter({ key: 'sales', roleId: 'business-challenges', title: '销售挑战' }, plan)
  assert.ok(!chapter.some(item => item.kind === 'material'))
  assert.ok(chapter.some(item => item.chunkId === 'C2'))
  assert.ok(!chapter.some(item => item.id === 'M3-1'))
  assert.ok(!evidence.some(item => item.knowledgeId === 'D2'))
  assert.deepEqual(calls.flatMap(item => item.documentIds), Array(calls.length).fill('D1'))
  assert.equal(evidence.filter(item => item.chunkId === 'C1').length, 1)
  assert.equal(evidence.find(item => item.chunkId === 'C1').id, firstId)
  assert.ok(evidence.find(item => item.chunkId === 'C1').retrievedBy.length > 1)
  const review = retrieval.selectForSections([{ key: 'sales', blocks: [
    { evidence: [{ id: firstId }], planRefs: { capabilityIds: ['cap-1'] } },
  ] }], plan)
  assert.deepEqual(review.map(item => item.id), [firstId])
  const archived = JSON.parse(await readFile(path.join(dir, 'evidence.json'), 'utf8'))
  assert.equal(archived.evidence.length, evidence.length)
  const audit = JSON.parse(await readFile(path.join(dir, 'retrieval.json'), 'utf8'))
  assert.ok(audit.queries.some(item => item.chapterKey === 'sales' && item.traceId === 'trace-1'))
  const perChapter = JSON.parse(await readFile(path.join(dir, 'chapters/sales/retrieval.json'), 'utf8'))
  assert.deepEqual(perChapter.evidenceIds, chapter.map(item => item.id))
})

test('无后台时本地多片段按章选取，补查最多一轮且不重复原查询', async () => {
  const evidence = [
    { id: 'M1-1', content: '技术平台支持 API 接入。', source: '平台.md' },
    { id: 'M2-1', content: '企业发展历史与生态伙伴。', source: '公司.md' },
    { id: 'M3-1', content: '政策趋势背景尚待确认。', source: '政策.md' },
  ]
  const retrieval = createRetrieval({ evidence, signal, rules: { chapters: { 'technical-platform': {
    extractQuestions: ['技术平台如何支撑 API 接入'], } } }, audience: '客户' })
  const discovered = await retrieval.discover()
  assert.ok(discovered.length <= evidence.length)
  const node = { key: 'technical', roleId: 'technical-platform', title: '技术平台' }
  const selected = await retrieval.forChapter(node, { chapterGuidance: [] })
  assert.deepEqual(selected.map(item => item.id), ['M1-1'])
  const supplemental = await retrieval.forChapter(node, { chapterGuidance: [] }, ['API 接口边界', 'API 接口边界'])
  assert.deepEqual(supplemental.map(item => item.id), ['M1-1'])
  assert.equal(retrieval.coverage.length, 0)
})

test('同库单次查询失败后，其他查询命中仍保留并标记局部失败', async () => {
  let count = 0
  const client = {
    visibleProjectBases: async () => ['B1'],
    documents: async () => [{ id: 'D1', parse_status: 'completed' }],
    searchEvidence: async () => {
      count++
      if (count === 1) return { items: [], status: 'failed', partial: true,
        source: 'unified', traceId: 'trace-fail', error: '检索源超时' }
      return { items: [row('C1', '可用的产品能力证据。')], status: 'completed', partial: false,
        source: 'unified', traceId: 'trace-ok' }
    },
  }
  const evidence = []
  const retrieval = createRetrieval({ client, projectId: 'P1', evidence, signal })
  const selected = await retrieval.discover()
  assert.equal(selected.length, 1)
  assert.equal(retrieval.coverage[0].status, 'partial')
  assert.equal(retrieval.coverage[0].hits, 1)
  assert.equal(retrieval.coverage[0].errors.length, 1)
  assert.equal(retrieval.issues.length, 1)
})

test('合稿复核带实际引用、场景关联原文和本地邻段，不带其他主题', () => {
  const evidence = [
    { id: 'M1-1', kind: 'material', source: '产品.md', content: '产品支持统一线索记录。' },
    { id: 'M1-2', kind: 'material', source: '产品.md', content: '该能力目前只在试点范围开放。' },
    { id: 'M2-1', kind: 'material', source: '问题.md', content: '跨部门移交记录容易丢失。' },
    { id: 'M3-1', kind: 'material', source: '趋势.md', content: '行业关注跨部门协同。' },
    { id: 'M4-1', kind: 'material', source: '公司.md', content: '企业生态合作介绍。' },
  ]
  const plan = { chapterGuidance: [], scenarios: [{ id: 's1', capabilityIds: ['c1'],
    problemIds: ['p1'], trendIds: ['t1'] }],
  capabilities: [{ id: 'c1', evidence: [{ id: 'M1-1', quote: '产品支持统一线索记录' }] }],
  problems: [{ id: 'p1', evidence: [{ id: 'M2-1', quote: '跨部门移交记录容易丢失' }] }],
  trends: [{ id: 't1', evidence: [{ id: 'M3-1', quote: '行业关注跨部门协同' }] }] }
  const retrieval = createRetrieval({ evidence, signal })
  const selected = retrieval.selectForSections([{ key: 'scenarios', blocks: [{ evidence: [],
    planRefs: { scenarioIds: ['s1'] } }] }], plan)
  assert.deepEqual(selected.map(item => item.id), ['M1-1', 'M2-1', 'M3-1', 'M1-2'])
})

test('已有知识证据按来源去重；缓存命中单独计等待，不重复计网络执行', async () => {
  const known = { id: 'Kexisting', kind: 'knowledge', knowledgeBaseId: 'B1', knowledgeId: 'D1',
    chunkId: 'C1', source: '产品', content: '产品支持统一线索记录。' }
  const evidence = [known]
  let calls = 0
  const client = { visibleProjectBases: async () => ['B1'],
    documents: async () => [{ id: 'D1', parse_status: 'completed' }],
    searchEvidence: async () => {
      calls++
      return { items: [row('C1', known.content)], status: 'completed', source: 'unified',
        partial: false, traceId: 'same-trace' }
    } }
  const retrieval = createRetrieval({ client, projectId: 'P1', evidence, signal })
  const node = { key: 'sales', roleId: 'business-challenges', title: '销售挑战' }
  await retrieval.forChapter(node, { chapterGuidance: [] })
  const firstCalls = calls
  await retrieval.forChapter(node, { chapterGuidance: [] })
  assert.equal(calls, firstCalls)
  assert.equal(evidence.length, 1)
  assert.ok(known.retrievedBy.length >= 1)
  const again = await retrieval.forChapter(node, { chapterGuidance: [] }, ['新增边界问题'])
  assert.equal(again[0].id, 'Kexisting')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wlyd-audit-'))
  const audited = createRetrieval({ client, projectId: 'P1', evidence: [], dir, signal })
  await audited.forChapter(node, { chapterGuidance: [] })
  await audited.forChapter(node, { chapterGuidance: [] })
  const log = JSON.parse(await readFile(path.join(dir, 'retrieval.json'), 'utf8'))
  assert.ok(log.queries.some(item => item.cacheHit && item.serviceMs === 0))
  assert.ok(log.queries.every(item => item.queuedAt && item.finishedAt && item.queueMs !== undefined && item.serviceMs !== undefined))
})

test('相同 chunk ID 属于不同知识库时保持不同稳定证据 ID', async () => {
  const evidence = []
  const client = { visibleProjectBases: async () => ['B1', 'B2'],
    documents: async () => [{ id: 'D1', parse_status: 'completed' }],
    searchEvidence: async () => ({ items: [row('C1', '同名分块内容。')],
      status: 'completed', source: 'unified', partial: false, traceId: null }) }
  const retrieval = createRetrieval({ client, projectId: 'P1', evidence, signal })
  await retrieval.discover()
  assert.equal(evidence.length, 2)
  assert.notEqual(evidence[0].id, evidence[1].id)
  assert.deepEqual(evidence.map(item => item.knowledgeBaseId).sort(), ['B1', 'B2'])
})

test('同名本地材料不跨文件带邻段，自定义目标参与查询', async () => {
  const evidence = [
    { id: 'M1-1', source: '资料.md', locator: 'materials/one.md#1', content: '销售线索记录需要交接确认。' },
    { id: 'M2-1', source: '资料.md', locator: 'materials/two.md#1', content: '机房空调维护注意事项。' },
  ]
  const retrieval = createRetrieval({ evidence, signal })
  const selected = await retrieval.forChapter({ key: 'custom', title: '专题', roleId: 'custom', goal: '销售线索记录' }, {})
  assert.deepEqual(selected.map(item => item.id), ['M1-1'])
  const review = retrieval.selectForSections([{ key: 'custom', blocks: [{ evidence: [{ id: 'M1-1' }] }] }], {})
  assert.deepEqual(review.map(item => item.id), ['M1-1'])
  assert.equal(retrieval.catalog().local.length, 2)
})

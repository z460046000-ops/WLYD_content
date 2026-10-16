import test from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { assembleConfirmed, completeAudit } from './helpers.mjs'
import { convertFile, MAX_BYTES } from '../src/convert.js'
import { inject } from '../src/index.js'
import { loadRules, validateOutline } from '../src/rules.js'
import { PlatformClient } from '../src/platform.js'
import { validateDraft } from '../src/workflow.js'
import { ingest, assemble } from '../src/workflow.js'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

function draftModel(draft, inspect = () => {}) {
  return { async *stream(request) {
    const prompt = JSON.parse(request.messages[0].content[0].text)
    inspect(prompt)
    const value = prompt.stage === 'plan' ? { title: draft.title }
      : prompt.stage === 'extract' ? { facts: prompt.evidence.map(source => ({ text: source.content,
        ...(source.content.includes('客户需要统一维护线索状态') ? { subject: 'customer', purpose: 'business-problem', scope: 'customer' } : {}),
        evidence: [{ id: source.id, quote: source.content.slice(0, 100) }] })), writingOutline: [] }
      : prompt.stage === 'panorama-enrichment' ? { additions: [], reviewItems: [] }
      : prompt.stage === 'consistency-review' ? completeAudit()
      : { ...draft, sections: draft.sections.filter(section => section.key === prompt.chapter.key) }
    yield { type: 'text-delta', text: JSON.stringify(value) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
}

test('完整原件可提取文本，扫描/图片/DMG 与乱码逐文件诚实标注', async () => {
  const zip = new JSZip()
  zip.file('a.md', '# 产品\n面向企业客户。')
  zip.file('b.png', Buffer.from([1, 2, 3]))
  const result = await convertFile('input.zip', await zip.generateAsync({ type: 'nodebuffer' }))
  assert.deepEqual(result.map(item => item.status), ['converted', 'needs_ocr'])
  assert.match(result[0].markdown, /面向企业客户/u)
  assert.equal((await convertFile('broken.txt', Buffer.from([0xff])))[0].status, 'failed')
  assert.equal((await convertFile('binary.md', Buffer.from(('\u0001\u0002正文\n').repeat(100))))[0].status, 'unsupported')
  assert.equal((await convertFile('image.png', Buffer.from([1])))[0].status, 'needs_ocr')
  assert.equal((await convertFile('app.dmg', Buffer.from([1])))[0].status, 'unsupported')
  assert.equal((await convertFile('scan.pdf', Buffer.from('%PDF-bad')))[0].status, 'failed')
  assert.equal(MAX_BYTES, 500 * 1024 * 1024)
  assert.equal((await convertFile('long.md', Buffer.from('有效正文'.repeat(50001))))[0].status, 'converted')
})

test('模板与章节规则独立；自定义章节必须写明目的和验收', async () => {
  const rules = await loadRules()
  assert.equal(rules.template.sections.length, 6)
  assert.ok(rules.loaded.every(item => item.sha256.length === 64))
  assert.deepEqual(validateOutline(rules.template.sections, rules), rules.template.sections)
  assert.ok(rules.chapters['delivery-service'])
  assert.equal(validateOutline([{ key: 'service', title: '实施与服务', roleId: 'delivery-service' }], rules).length, 1)
  assert.throws(() => validateOutline([{ key: 'extra', title: '新章', roleId: 'custom' }], rules), /自定义章节/u)
})

test('绑定库必须同时在当前账号可见；搜索只传完成文档', async () => {
  const calls = []
  const fakeFetch = async (url, init) => {
    const pathname = new URL(url).pathname
    calls.push({ pathname, body: init.body })
    if (pathname.endsWith('/auth/login')) return Response.json({ token: 'test-token', active_tenant: { id: 'T1' } })
    if (pathname.endsWith('/solutions/projects')) return Response.json({ data: [{ id: 'P1' }] })
    if (pathname.endsWith('/solutions/projects/P1/knowledge-bases')) return Response.json({ data: [
      { knowledge_base_id: 'K1' }, { knowledge_base_id: 'K2' },
    ] })
    if (pathname.endsWith('/knowledge-bases') || pathname.endsWith('/knowledge-bases/')) return Response.json({ data: [{ id: 'K1' }] })
    if (pathname.endsWith('/hybrid-search')) return Response.json({ data: [] })
    throw new Error(`unexpected ${pathname}`)
  }
  const client = new PlatformClient({ baseUrl: 'https://example.test', email: 'test@example.test', password: 'secret', tenantId: 'T1' }, fakeFetch)
  assert.deepEqual(await client.visibleProjectBases('P1'), ['K1'])
  await assert.rejects(client.visibleProjectBases('P2'), /不可访问/u)
  await client.search('K1', '业务问题', ['D1'])
  assert.deepEqual(JSON.parse(calls.at(-1).body).knowledge_ids, ['D1'])
  assert.equal(JSON.parse(calls.at(-1).body).match_count, 50)
})

test('上传使用本地 Markdown 文件流构造 multipart', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'wlyd-upload-stream-test-'))
  const markdownPath = path.join(cwd, 'source.md')
  await writeFile(markdownPath, '# 资料\n\n完整内容。')
  let uploaded
  const fakeFetch = async (url, init) => {
    if (url.endsWith('/auth/login')) return Response.json({ token: 'test-token', active_tenant: { id: 'T1' } })
    uploaded = init.body.get('file')
    return Response.json({ data: { id: 'D1', parse_status: 'pending' } }, { status: 202 })
  }
  const client = new PlatformClient({ baseUrl: 'https://example.test', email: 'test@example.test', password: 'secret', tenantId: 'T1' }, fakeFetch)
  const result = await client.upload('P1', 'K1', 'source.md', markdownPath)
  assert.equal(result.status, 202)
  assert.equal(uploaded.name, 'source.md')
  assert.equal(await uploaded.text(), '# 资料\n\n完整内容。')
})

test('单文件入口允许 500 MB，按文件顺序处理，超出上限逐文件失败', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'wlyd-size-test-'))
  const exec = { agent: { session: { header: { cwd } } }, signal: new AbortController().signal }
  const limits = []
  const ctx = { fs: { resolve: async value => value,
    stat: async target => ({ type: 'file', size: target === 'within.md' ? MAX_BYTES : MAX_BYTES + 1 }),
    readBytes: async (_target, _signal, max) => { limits.push(max); return Buffer.from('可读的产品资料。') },
  } }
  const client = { projects: async () => { throw new Error('平台未配置') } }
  const result = await ingest({ ctx, client, args: { files: ['within.md', 'too-large.md'] }, exec })
  assert.deepEqual(result.files.map(file => file.status), ['converted', 'failed'])
  assert.deepEqual(limits, [MAX_BYTES])
  assert.match(result.files[1].reason, /500 MB/u)
})

test('DSH 服务声明允许工作区文件读取，附件经可选服务读取', async () => {
  assert.ok(inject.includes('fs'))
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'wlyd-inject-test-'))
  const digest = 'a'.repeat(64)
  const attachment = { attachmentId: `sha256:${digest}`, name: 'attached.md', bytes: 18 }
  const agent = { session: { header: { cwd }, deriveMessages: () => [{
    source: { kind: 'user' }, content: [{ type: 'file', attachment }],
  }] } }
  const exec = { agent, signal: new AbortController().signal }
  const services = {
    fs: { resolve: async value => value, stat: async () => ({ type: 'file', size: 18 }),
      readBytes: async () => Buffer.from('工作区材料可以读取。') },
    attachments: { async *readFileStream(ref) {
      assert.equal(ref.attachmentId, attachment.attachmentId)
      yield Buffer.from('会话附件可以读取。')
    } },
  }
  const ctx = new Proxy({ get: name => services[name] }, { get(target, name) {
    if (name === 'fs' && !inject.includes('fs')) throw new Error('cannot get property "fs" without inject')
    if (name === 'attachments') throw new Error('cannot get property "attachments" without inject')
    return name in services ? services[name] : target[name]
  } })
  const client = { projects: async () => { throw new Error('平台未配置') } }
  const result = await ingest({ ctx, client, args: { files: ['local.md'], attachment_refs: [{ ...attachment, attachmentId: digest }] }, exec })
  assert.equal(result.status, 'local_only')
  assert.deepEqual(result.files.map(file => file.status), ['converted', 'converted'])
  assert.ok(result.files.every(file => file.materialPath))
})

test('宽泛命中的其他有价值材料完整存档，各阶段只传选用的相关原文', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'wlyd-retrieval-test-'))
  const exec = { agent: { session: { header: { cwd } }, options: { provider: 'fake', model: 'fake' } }, signal: new AbortController().signal }
  const queries = []
  const client = { visibleProjectBases: async () => ['K1'], documents: async () => [{ id: 'D1', parse_status: 'completed' }],
    search: async (_base, query) => {
      queries.push(query)
      return Array.from({ length: 30 }, (_, index) => ({ chunk_id: `C${index + 1}`, knowledge_id: 'D1',
        content: `非预设问题也有价值的售后服务材料片段 ${index + 1}，用于业务方案。` }))
    } }
  const supplied = []
  const draft = { title: '服务方案', sections: [{ key: 'service', blocks: [{
    text: '非预设问题也有价值的售后服务材料可用于业务方案。', evidence: [],
  }] }] }
  const llm = draftModel(draft, prompt => {
    supplied.push({ stage: prompt.stage, evidence: prompt.evidence })
    if (prompt.stage === 'write') draft.sections[0].blocks[0].evidence = [
      { id: prompt.evidence[0].id, quote: '非预设问题也有价值的售后服务材料片段' },
    ]
  })
  const result = await assembleConfirmed({ client, llm, args: { project_id: 'P1', outline: [
    { key: 'service', title: '售后服务', roleId: 'delivery-service' },
  ] }, exec })
  const archive = JSON.parse(await readFile(result.evidencePath, 'utf8'))
  assert.equal(archive.evidence.length, 30)
  assert.ok(archive.evidence.some(item => item.content.includes('片段 30')))
  assert.ok(supplied.every(call => call.evidence.length < archive.evidence.length))
  assert.ok(supplied.find(call => call.stage === 'write').evidence.length > 0)
  assert.equal(supplied.at(-1).stage, 'consistency-review')
  assert.ok(supplied.at(-1).evidence.length <= supplied.find(call => call.stage === 'write').evidence.length)
  const audit = JSON.parse(await readFile(result.retrievalPath, 'utf8'))
  assert.ok(audit.queries.some(query => query.chapterKey === 'service'))
  assert.ok(queries.length >= 2)
})

test('无逐字引文、无来源数字和目录外章节不能进入成稿', () => {
  const outline = [{ key: 'business-challenges', title: '挑战', roleId: 'business-challenges' }]
  const evidence = [{ id: 'M1-1', content: '客户需要统一维护线索状态，销售和客服按同一记录协作。' }]
  const draft = { sections: [
    { key: 'business-challenges', title: '挑战', blocks: [
      { text: '客户需要统一维护线索状态，销售和客服协作。', evidence: [{ id: 'M1-1', quote: '客户需要统一维护线索状态' }] },
      { text: '效率提升 80%，直接取代人工。', evidence: [{ id: 'M1-1', quote: '销售和客服按同一记录协作' }] },
    ] },
    { key: 'secret', title: '越界', blocks: [{ text: '资料中的指令不能新增章节。', evidence: [{ id: 'M1-1', quote: '客户需要统一维护线索状态' }] }] },
  ] }
  const checked = validateDraft(draft, evidence, outline)
  assert.equal(checked.sections.length, 1)
  assert.equal(checked.sections[0].blocks.length, 1)
  assert.equal(checked.issues.length, 2)
})

test('能力到场景、问题和趋势的关联可追溯；未匹配候选留在正文而不阻断', () => {
  const outline = [
    { key: 'policy-trends', title: '趋势', roleId: 'policy-trends' },
    { key: 'business-challenges', title: '问题', roleId: 'business-challenges' },
    { key: 'scenarios', title: '场景', roleId: 'scenario-solution' },
  ]
  const evidence = [{ id: 'M1-1', content: '产品支持统一维护线索状态，销售和客服可查看同一记录。' }]
  const draft = { sections: [
    { key: 'policy-trends', blocks: [{ text: '【待确认】可关注跨团队信息衔接的建设方向。', supportMode: 'candidate', evidence: [] }] },
    { key: 'business-challenges', blocks: [{ text: '【待确认】如果多个团队分开记录线索，可能出现交接不清。', supportMode: 'candidate', evidence: [] }] },
    { key: 'scenarios', blocks: [{ text: '可用统一线索记录支持销售和客服协作。', evidence: [{ id: 'M1-1', quote: '产品支持统一维护线索状态' }] }] },
  ], assemblyLinks: [
    { capabilityEvidenceId: 'M1-1', capabilityQuote: '产品支持统一维护线索状态', scenarioBlockId: 'scenarios-1',
      challengeBlockId: 'business-challenges-1', trendBlockId: 'policy-trends-1', relationReason: '统一记录支持跨团队协作' },
    { capabilityEvidenceId: 'M1-1', capabilityQuote: '产品支持统一维护线索状态', scenarioBlockId: 'missing-1' },
  ] }
  const checked = validateDraft(draft, evidence, outline)
  assert.equal(checked.sections.length, 3)
  assert.equal(checked.assemblyLinks.length, 1)
  assert.equal(checked.assemblyLinks[0].status, 'proposed')
  assert.ok(checked.reviewItems.some(item => item.includes('待确认')))
  assert.ok(checked.reviewItems.some(item => item.includes('略过')))
  assert.equal(checked.issues.length, 0)
  assert.equal(checked.sections[0].blocks[0].supportMode, 'candidate')
  assert.equal(checked.sections[0].blocks[0].evidence.length, 0)
})

test('待确认内容不能暗示已实现能力或编造无据数字', () => {
  const outline = [{ key: 'scenario-solution', title: '场景', roleId: 'scenario-solution' }]
  const evidence = [{ id: 'M1-1', content: '产品支持统一维护线索状态。' }]
  const draft = { sections: [{ key: 'scenario-solution', blocks: [
    { text: '可考虑通过统一记录让团队衔接业务流程。', supportMode: 'candidate', evidence: [] },
    { text: '本产品已实现自动分单与全流程闭环。', supportMode: 'candidate', evidence: [] },
    { text: '建议将处理效率提升 80%。', supportMode: 'candidate', evidence: [] },
  ] }] }
  const checked = validateDraft(draft, evidence, outline)
  assert.equal(checked.sections[0].blocks.length, 1)
  assert.match(checked.sections[0].blocks[0].text, /^【待确认·典型场景假设】/u)
  assert.equal(checked.issues.length, 2)
})

test('本地材料到报告保留来源、待确认候选与缺章；平台不可用时不伪装上传', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'wlyd-assembly-test-'))
  const agent = { session: { header: { cwd } }, options: { provider: 'fake', model: 'fake' } }
  const exec = { agent, signal: new AbortController().signal }
  const ctx = { fs: {
    resolve: async value => value,
    stat: async () => ({ type: 'file', size: 100 }),
    readBytes: async () => Buffer.from(['客户需要统一维护线索状态，销售和客服按同一记录协作。',
      ...Array.from({ length: 20 }, (_, index) => `补充材料 ${index + 1}：${'业务信息'.repeat(340)}`)].join('\n\n')),
  } }
  const client = { projects: async () => { throw new Error('平台未配置') } }
  const source = await ingest({ ctx, client, args: { files: ['客户资料.md'] }, exec })
  assert.equal(source.status, 'local_only')
  assert.equal(source.files[0].status, 'converted')
  assert.equal(source.files[0].uploadStatus, undefined)
  let materialPieces
  const llm = draftModel({ title: '线索协作方案', sections: [
    { key: 'business-challenges', title: '业务挑战', blocks: [{
      text: '客户需要统一维护线索状态，销售和客服依据同一记录协作。',
      evidence: [{ id: 'M1-1', quote: '客户需要统一维护线索状态' }],
    }] },
    { key: 'scenarios', title: '典型业务场景方案', blocks: [{
      text: '建议探索跨团队线索交接场景，具体流程请客户核对。', supportMode: 'candidate', evidence: [],
    }] },
  ], gaps: [] }, prompt => { materialPieces = prompt.evidence.length })
  const result = await assembleConfirmed({ client, llm, args: { source_run_id: source.runId }, exec })
  assert.equal(result.status, 'partial_draft')
  assert.ok(!Object.hasOwn(result, 'modelRequests'))
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
  const report = JSON.parse(await readFile(result.jsonPath, 'utf8'))
  const evidence = JSON.parse(await readFile(result.evidencePath, 'utf8'))
  assert.equal(report.sections.length, 2)
  assert.equal(report.sections[1].blocks[0].supportMode, 'candidate')
  assert.ok(report.reviewItems.some(item => item.includes('待确认')))
  assert.ok(report.gaps.some(item => item.includes('政策与趋势')))
  assert.ok(!report.gaps.some(item => item.includes('关联')))
  assert.match(await readFile(result.reportPath, 'utf8'), /【待确认·典型场景假设】/u)
  assert.equal(report.ruleFingerprint.length, 64)
  assert.ok(evidence.evidence[0].content.includes('客户需要'))
  assert.ok(evidence.evidence.length > 12)
  assert.ok(materialPieces < evidence.evidence.length)
})

test('唯一授权项目默认上传；pending 和 finalizing 均能查询到 completed', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'wlyd-upload-test-'))
  const agent = { session: { header: { cwd } } }
  const exec = { agent, signal: new AbortController().signal }
  const ctx = { fs: { resolve: async value => value,
    stat: async () => ({ type: 'file', size: 50 }),
    readBytes: async () => Buffer.from('产品用于企业客户线索协作。') } }
  const uploads = []
  let checks = 0
  const client = { projects: async () => [{ id: 'P1' }], visibleProjectBases: async () => ['K1'],
    documents: async () => [],
    upload: async (p, b, name, markdown) => { uploads.push({ p, b, name, markdown }); return { status: 202, data: { id: 'D1', parse_status: 'pending' }, requestId: 'R1' } },
    knowledge: async () => ({ parse_status: ++checks === 1 ? 'finalizing' : 'completed' }) }
  const result = await ingest({ ctx, client, args: { files: ['input.md'] }, exec })
  assert.equal(result.status, 'uploaded_or_pending')
  assert.equal(result.files[0].uploadStatus, 'pending')
  assert.equal(uploads.length, 1)
  assert.deepEqual([uploads[0].p, uploads[0].b], ['P1', 'K1'])
  const interim = await (await import('../src/workflow.js')).status({ client, runId: result.runId, agent })
  assert.equal(interim.files[0].uploadStatus, 'finalizing')
  const refreshed = await (await import('../src/workflow.js')).status({ client, runId: result.runId, agent })
  assert.equal(refreshed.files[0].uploadStatus, 'completed')
})

test('重复材料只复用目标库内摘要和大小一致的文档；真正上传失败单独标记', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'wlyd-dedup-test-'))
  const exec = { agent: { session: { header: { cwd } } }, signal: new AbortController().signal }
  const ctx = { fs: { resolve: async value => value,
    stat: async () => ({ type: 'file', size: 50 }),
    readBytes: async () => Buffer.from('产品用于企业客户线索协作。') } }
  let documents = []
  let uploads = 0
  const client = { projects: async () => [{ id: 'P1' }], visibleProjectBases: async () => ['K1'],
    documents: async () => documents,
    upload: async () => { uploads++; if (uploads > 1) throw new Error('HTTP 500')
      return { data: { id: 'D1', parse_status: 'completed' } } } }
  const first = await ingest({ ctx, client, args: { files: ['input.md'] }, exec })
  documents = [{ id: 'D1', file_hash: first.files[0].materialMd5,
    file_size: first.files[0].materialBytes, parse_status: 'completed' }]
  const reused = await ingest({ ctx, client, args: { files: ['input.md'] }, exec })
  assert.equal(reused.files[0].uploadDisposition, 'reused')
  assert.equal(reused.files[0].knowledgeId, 'D1')
  assert.equal(reused.files[0].uploadStatus, 'completed')
  assert.equal(uploads, 1)
  documents[0].file_size++
  const failed = await ingest({ ctx, client, args: { files: ['input.md'] }, exec })
  assert.equal(uploads, 2)
  assert.equal(failed.status, 'upload_failed')
  assert.equal(failed.files[0].uploadStatus, 'upload_failed')
  assert.equal(failed.files[0].status, 'converted')
})

test('多个项目时停在选择阶段；伪造会话附件不读取也不上传', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'wlyd-choice-test-'))
  const agent = { session: { header: { cwd }, deriveMessages: () => [] } }
  const exec = { agent, signal: new AbortController().signal }
  const ctx = { fs: { resolve: async value => value,
    stat: async () => ({ type: 'file', size: 50 }),
    readBytes: async () => Buffer.from('产品用于企业客户线索协作。') } }
  let uploadCalls = 0
  const client = { projects: async () => [{ id: 'P1' }, { id: 'P2' }],
    upload: async () => { uploadCalls++ } }
  const choice = await ingest({ ctx, client, args: { files: ['input.md'] }, exec })
  assert.equal(choice.status, 'needs_project_selection')
  assert.equal(uploadCalls, 0)
  const forged = await ingest({ ctx, client, args: { attachment_refs: [{ attachmentId: 'fake', name: 'x.md', bytes: 12 }] }, exec })
  assert.equal(forged.status, 'no_readable_material')
  assert.equal(forged.files[0].status, 'failed')
  assert.equal(uploadCalls, 0)
})

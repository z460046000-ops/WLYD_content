import test from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { convertFile } from '../src/convert.js'
import { loadRules, validateOutline } from '../src/rules.js'
import { PlatformClient } from '../src/platform.js'
import { validateDraft } from '../src/workflow.js'
import { ingest, assemble } from '../src/workflow.js'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

test('完整原件可提取文本，扫描/图片/DMG 与乱码逐文件诚实标注', async () => {
  const zip = new JSZip()
  zip.file('a.md', '# 产品\n面向企业客户。')
  zip.file('b.png', Buffer.from([1, 2, 3]))
  const result = await convertFile('input.zip', await zip.generateAsync({ type: 'nodebuffer' }))
  assert.deepEqual(result.map(item => item.status), ['converted', 'needs_ocr'])
  assert.match(result[0].markdown, /面向企业客户/u)
  assert.equal((await convertFile('broken.txt', Buffer.from([0xff])))[0].status, 'failed')
  assert.equal((await convertFile('image.png', Buffer.from([1])))[0].status, 'needs_ocr')
  assert.equal((await convertFile('app.dmg', Buffer.from([1])))[0].status, 'unsupported')
  assert.equal((await convertFile('scan.pdf', Buffer.from('%PDF-bad')))[0].status, 'failed')
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

test('本地材料到报告保留来源、规则哈希与缺章；平台不可用时不伪装上传', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'wlyd-assembly-test-'))
  const agent = { session: { header: { cwd } }, options: { provider: 'fake', model: 'fake' } }
  const exec = { agent, signal: new AbortController().signal }
  const ctx = { fs: {
    resolve: async value => value,
    stat: async () => ({ type: 'file', size: 100 }),
    readBytes: async () => Buffer.from('客户需要统一维护线索状态，销售和客服按同一记录协作。'),
  } }
  const client = { projects: async () => { throw new Error('平台未配置') } }
  const source = await ingest({ ctx, client, args: { files: ['input.md'] }, exec })
  assert.equal(source.status, 'local_only')
  assert.equal(source.files[0].status, 'converted')
  assert.equal(source.files[0].uploadStatus, undefined)
  const llm = { async *stream() {
    yield { type: 'text-delta', text: JSON.stringify({ title: '线索协作方案', sections: [
      { key: 'business-challenges', title: '业务挑战', blocks: [{
        text: '客户需要统一维护线索状态，销售和客服依据同一记录协作。',
        evidence: [{ id: 'M1-1', quote: '客户需要统一维护线索状态' }],
      }] },
    ], gaps: [] }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const result = await assemble({ client, llm, args: { source_run_id: source.runId }, exec })
  const report = JSON.parse(await readFile(result.jsonPath, 'utf8'))
  const evidence = JSON.parse(await readFile(result.evidencePath, 'utf8'))
  assert.equal(report.sections.length, 1)
  assert.ok(report.gaps.some(item => item.includes('政策与趋势')))
  assert.equal(report.ruleFingerprint.length, 64)
  assert.ok(evidence.evidence[0].content.includes('客户需要'))
})

test('唯一授权项目默认上传；未解析完成只记录 pending，查询后变 completed', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'wlyd-upload-test-'))
  const agent = { session: { header: { cwd } } }
  const exec = { agent, signal: new AbortController().signal }
  const ctx = { fs: { resolve: async value => value,
    stat: async () => ({ type: 'file', size: 50 }),
    readBytes: async () => Buffer.from('产品用于企业客户线索协作。') } }
  const uploads = []
  const client = { projects: async () => [{ id: 'P1' }], visibleProjectBases: async () => ['K1'],
    upload: async (p, b, name, markdown) => { uploads.push({ p, b, name, markdown }); return { status: 202, data: { id: 'D1', parse_status: 'pending' }, requestId: 'R1' } },
    knowledge: async () => ({ parse_status: 'completed' }) }
  const result = await ingest({ ctx, client, args: { files: ['input.md'] }, exec })
  assert.equal(result.status, 'uploaded_or_pending')
  assert.equal(result.files[0].uploadStatus, 'pending')
  assert.equal(uploads.length, 1)
  assert.deepEqual([uploads[0].p, uploads[0].b], ['P1', 'K1'])
  const refreshed = await (await import('../src/workflow.js')).status({ client, runId: result.runId, agent })
  assert.equal(refreshed.files[0].uploadStatus, 'completed')
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

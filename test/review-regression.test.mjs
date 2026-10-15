import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../src/index.js'
import { parametersSchema } from '../src/schema.js'
import { retrieve, status } from '../src/workflow.js'
import { loadRules } from '../src/rules.js'
import { askModel, parseModelJson } from '../src/model.js'
import { resolveGenerationConcurrency } from '../src/scheduler.js'

test('生成并发默认八路，可由进程环境或 DSH .env 配置，非法值回退默认', async () => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'wlyd-concurrency-'))
  assert.equal(resolveGenerationConcurrency({ DSH_HOME: dshHome }), 8)
  await writeFile(path.join(dshHome, '.env'), 'WLYD_ASSEMBLY_CONCURRENCY=6\n')
  assert.equal(resolveGenerationConcurrency({ DSH_HOME: dshHome }), 6)
  assert.equal(resolveGenerationConcurrency({ DSH_HOME: dshHome, WLYD_ASSEMBLY_CONCURRENCY: '10' }), 10)
  for (const value of ['0', '13', '8x', '08', '']) {
    assert.equal(resolveGenerationConcurrency({ DSH_HOME: dshHome, WLYD_ASSEMBLY_CONCURRENCY: value }), 8)
  }
})

test('模型 JSON 仅修复字符串控制字符和结构性尾随逗号，保留引文原意', async () => {
  const broken = '{"quote":"前段,}后段\n下一行\t补充","values":[1,2,],}'
  const expected = { quote: '前段,}后段\n下一行\t补充', values: [1, 2] }
  assert.deepEqual(parseModelJson(broken), expected)
  assert.deepEqual(parseModelJson(JSON.stringify(expected)), expected)
  assert.deepEqual(parseModelJson('```json\n{"value":1}\n```'), { value: 1 })
  assert.throws(() => parseModelJson('{"quote":"未结束'), SyntaxError)
  const llm = { async *stream() {
    yield { type: 'text-delta', text: broken }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  assert.deepEqual(await askModel(llm, { options: { provider: 'fake', model: 'fake' } }, undefined, { stage: 'write' }), expected)
})

test('五个官方工具均注册标准对象 schema，保留 required，且不改共享注册服务', async () => {
  const tools = []
  const register = tool => { tools.push(tool) }
  const ctx = { tools: { register } }
  apply(ctx)
  assert.equal(ctx.tools.register, register)
  assert.equal(tools.length, 5)
  for (const tool of tools) {
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.parameters.properties, 'object')
    const inspect = node => {
      if (!node || typeof node !== 'object') return
      if (Object.hasOwn(node, 'required')) assert.ok(Array.isArray(node.required))
      Object.values(node.properties || {}).forEach(inspect)
      if (node.items) inspect(node.items)
    }
    inspect(tool.parameters)
  }
  assert.deepEqual(tools.find(t => t.name.endsWith('_status')).parameters.required, ['run_id'])
  const outline = tools.find(t => t.name.endsWith('_outline'))
  const args = { template_id: 'presales-solution', business_mode: 'current-state', trend_framework: 'pest' }
  const result = await outline.execute(args)
  assert.equal(result.outline[1].title, '业务现状')
  assert.equal(result.outline[0].framework, 'pest')
  const source = { type: 'object', required: ['existing'], properties: {
    existing: { type: 'string' }, rows: { type: 'array', required: true, items: { type: 'object', properties: {
      title: { type: 'string', required: true }, description: { type: 'string' },
    } } },
  } }
  const normalized = parametersSchema(source)
  assert.deepEqual(normalized.required, ['existing', 'rows'])
  assert.deepEqual(normalized.properties.rows.items.required, ['title'])
  assert.deepEqual(parametersSchema(normalized), normalized)
  assert.equal(source.properties.rows.required, true)
})

test('跨库检索最多四路，局部失败保留成功片段，按请求顺序去重且不跨文档混用', async () => {
  let active = 0, peak = 0
  const client = { visibleProjectBases: async () => ['B1', 'B2'], documents: async () => [{ id: 'D1', parse_status: 'completed' }],
    search: async (base, query, documents) => {
      assert.deepEqual(documents, ['D1'])
      active++; peak = Math.max(peak, active)
      try {
        await delay(base === 'B1' ? 4 : 1)
        if (base === 'B1' && query.startsWith('还有哪些')) throw new Error('one query failed')
        return [{ chunk_id: 'same-id', knowledge_id: 'D1', content: '可用于产品方案的真实材料原文。' },
          { chunk_id: 'foreign', knowledge_id: 'D2', content: '不应使用未授权的文档。' }]
      } finally { active-- }
    } }
  const result = await retrieve(client, 'P1', await loadRules(), new AbortController().signal)
  assert.equal(peak, 4)
  assert.equal(result.evidence.length, 2)
  assert.deepEqual(result.evidence.map(e => [e.id, e.knowledgeBaseId]), [['K1', 'B1'], ['K2', 'B2']])
  assert.equal(result.coverage[0].status, 'partial')
  assert.equal(result.coverage[0].errors.length, 1)
  assert.equal(result.coverage[1].status, 'matched')
})

test('状态不变时不写盘，查询成功清除旧错误，终态不再请求后台', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'wlyd-status-'))
  const runId = '00000000-0000-4000-8000-000000000000'
  const dir = path.join(cwd, 'artifacts/material-knowledge-assembly/runs', runId)
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, 'run.json')
  await writeFile(file, JSON.stringify({ runId, files: [{ knowledgeId: 'D1', uploadStatus: 'pending', statusError: 'old' }] }))
  const agent = { session: { header: { cwd } } }
  const client = { knowledge: async () => ({ parse_status: 'pending' }) }
  assert.equal((await status({ client, runId, agent })).files[0].statusError, undefined)
  const before = await readFile(file, 'utf8')
  const modified = (await stat(file)).mtimeMs
  await delay(5)
  await status({ client, runId, agent })
  assert.equal(await readFile(file, 'utf8'), before)
  assert.equal((await stat(file)).mtimeMs, modified)
  client.knowledge = async () => ({ parse_status: 'completed' })
  await status({ client, runId, agent })
  client.knowledge = async () => assert.fail('terminal record was queried')
  await status({ client, runId, agent })
})

test('模型保留全部输入并透传会话思考强度，上下文超限返回可定位原因', async () => {
  const prompt = { stage: 'extract', evidence: [{ content: '原始资料'.repeat(30000) }] }
  const agent = { options: { provider: 'fake', model: 'fake', reasoningEffort: 'high' } }
  const llm = { async *stream(request) {
    assert.equal(request.reasoningEffort, 'high')
    assert.deepEqual(JSON.parse(request.messages[0].content[0].text), prompt)
    yield { type: 'text-delta', text: '{}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  await askModel(llm, agent, undefined, prompt)
  const limited = { async *stream() { throw Object.assign(new Error('maximum context length exceeded'), { code: 'context_length_exceeded' }) } }
  await assert.rejects(askModel(limited, agent, undefined, prompt), error => {
    assert.equal(error.code, 'MODEL_CONTEXT_LIMIT')
    assert.match(error.message, /未裁剪输入.*阶段=extract.*字符/u)
    return true
  })
  const finishError = { async *stream() {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'model context window exceeded' } } }
  } }
  await assert.rejects(askModel(finishError, agent, undefined, prompt), error => {
    assert.equal(error.code, 'MODEL_CONTEXT_LIMIT')
    assert.match(error.message, /model context window exceeded/u)
    return true
  })
})

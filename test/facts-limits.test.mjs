import test from 'node:test'
import assert from 'node:assert/strict'
import { collectFacts } from '../src/facts.js'

const evidence = [
  { id: 'K1', content: '第一条产品能力包括统一线索管理。' },
  { id: 'K2', content: '第二条产品能力包括业务数据关联。' },
]
const parameters = { common: {}, node: { key: 'solution' }, rule: {}, evidence, plan: {} }
const emptyFacts = { facts: [], retrievalQueries: [], gaps: [], reviewItems: [] }

test('提取遇到排队、执行、限流、鉴权和额度问题均不拆批或另层重试', async () => {
  for (const code of ['MODEL_QUEUE_TIMEOUT', 'MODEL_STAGE_TIMEOUT', 'RATE_LIMIT', 'AUTH', 'QUOTA_EXCEEDED']) {
    let calls = 0
    await assert.rejects(collectFacts({ ...parameters, request: async () => {
      calls++; throw Object.assign(new Error(code), { code })
    } }), error => error.code === code)
    assert.equal(calls, 1, code)
  }
})

test('真正输入超限拆分失败批次，单纯输出耗尽且没有正文时不拆', async () => {
  let calls = 0
  const result = await collectFacts({ ...parameters, request: async prompt => {
    calls++
    if (prompt.evidence.length > 1) throw Object.assign(new Error('context overflow'), { code: 'MODEL_CONTEXT_LIMIT' })
    return emptyFacts
  } })
  assert.equal(calls, 3)
  assert.deepEqual(result.batches.map(row => row.status), ['split', 'completed', 'completed'])
  calls = 0
  await assert.rejects(collectFacts({ ...parameters, request: async () => {
    calls++; throw Object.assign(new Error('max-tokens'), { code: 'MODEL_OUTPUT_LIMIT', outputCharacters: 0 })
  } }), error => error.code === 'MODEL_OUTPUT_LIMIT')
  assert.equal(calls, 1)
})

test('已有正文但输出耗尽时缩小该批任务，保留原始证据', async () => {
  const seen = []
  const result = await collectFacts({ ...parameters, request: async prompt => {
    seen.push(prompt.evidence.map(row => row.id))
    if (prompt.evidence.length > 1) throw Object.assign(new Error('max-tokens'), { code: 'MODEL_OUTPUT_LIMIT', outputCharacters: 24 })
    return emptyFacts
  } })
  assert.deepEqual(seen, [['K1', 'K2'], ['K1'], ['K2']])
  assert.equal(result.batches.length, 3)
})

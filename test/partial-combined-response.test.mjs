import test from 'node:test'
import assert from 'node:assert/strict'
import { partialCombinedResponse, partialCombinedProse, materializeCombined, sourceCardBatches } from '../src/combined-writing.js'

const fact = { id: 'claim-1', text: '仅在授权后试点统一交接。', sourceCardIds: ['s-original'], subject: 'product',
  purpose: 'capability', supportMode: 'sourced', capabilityStatus: 'pilot', capabilityOwnership: 'self',
  conditions: ['客户授权'], limitations: ['仍须人工确认'] }
const block = { text: '建议先核对交接，在客户授权后试点。', factIds: ['claim-1'], supportMode: 'candidate',
  planRefs: { capabilityIds: ['cap-1'] } }

test('完整响应只投影根facts和sections的完整对象，保留原事实及段落字段', () => {
  const raw = { facts: [fact, null, 'not-a-fact'], sections: [{ key: 'solution', blocks: [block, null, 'not-a-block'],
    reviewItems: [{ text: '这不是正文。' }] }], reviewItems: [{ text: '根审核话术。' }] }
  assert.deepEqual(partialCombinedResponse(JSON.stringify(raw)), { facts: [fact], sections: [{ key: 'solution', blocks: [block] }] })
  assert.deepEqual(partialCombinedResponse(`\`\`\`json\n${JSON.stringify(raw)}\n\`\`\``), partialCombinedResponse(JSON.stringify(raw)))
})

test('facts被截断时仅恢复已闭合且可独立解析的直接fact对象', () => {
  const prefix = `{"facts":[${JSON.stringify(fact)},`
  for (const tail of ['{"id":"claim-2","text":"未写完', '{"id":"claim-2","sourceCardIds":["s-original"],"text":"完整字符串但对象未关闭"']) {
    assert.deepEqual(partialCombinedResponse(prefix + tail), { facts: [fact], sections: [] })
  }
  assert.deepEqual(partialCombinedResponse('{"facts":[{"text":"只完成text字符串"'), { facts: [], sections: [] })
})

test('截断sections按各章key恢复完整block对象，不将事实或审核文字当正文', () => {
  const text = `{"facts":[${JSON.stringify(fact)}],"sections":[{"key":"solution","blocks":[${JSON.stringify(block)},` +
    '{"text":"只有完整text字段，block还未关闭","factIds":["claim-1"'
  assert.deepEqual(partialCombinedResponse(text), { facts: [fact], sections: [{ key: 'solution', blocks: [block] }] })
  const completeChapter = JSON.stringify({ key: 'earlier', blocks: [{ text: '前章完整正文。', factIds: ['claim-1'] }], reviewItems: [{ text: '前章审核话术。' }] })
  const partial = `{"sections":[${completeChapter},{"key":"later","blocks":[${JSON.stringify(block)}, {"text":"后章未完成`
  assert.deepEqual(partialCombinedResponse(partial).sections, [
    { key: 'earlier', blocks: [{ text: '前章完整正文。', factIds: ['claim-1'] }] }, { key: 'later', blocks: [block] },
  ])
})

test('仅root直接数组参与恢复，字符串、嵌套facts/sections和reviewItems不能提供正文', () => {
  const distraction = { text: '文本里包含 "facts": [{"text":"假事实"}] 和 "sections": [{"blocks":[{"text":"假正文"}]}]，以及转义\\。',
    nested: { facts: [fact], sections: [{ key: 'wrong', blocks: [{ text: '嵌套的错误正文。' }] }] } }
  const prefix = `{"reviewItems":[${JSON.stringify(distraction)}],"metadata":${JSON.stringify(distraction)},"facts":[${JSON.stringify({ ...fact, text: distraction.text })}],`
  const text = `${prefix}"sections":[{"key":"right","blocks":[${JSON.stringify({ ...block, nested: { text: '段落内的附属字段。' } })}],"reviewItems":[{"text":"未完成审核`
  const recovered = partialCombinedResponse(text)
  assert.equal(recovered.facts.length, 1)
  assert.equal(recovered.facts[0].text, distraction.text)
  assert.deepEqual(recovered.sections, [{ key: 'right', blocks: [{ ...block, nested: { text: '段落内的附属字段。' } }] }])
  assert.deepEqual(partialCombinedResponse(`{"metadata":${JSON.stringify(distraction)},"reviewItems":[{"text":"截断`), { facts: [], sections: [] })
})

test('有key原样保留；仅真正缺失key的旧响应由调用者决定是否归当前单章', () => {
  const noKey = partialCombinedResponse(`{"sections":[{"blocks":[${JSON.stringify(block)}, {"text":"未完成`)
  assert.equal(Object.hasOwn(noKey.sections[0], 'key'), false)
  assert.deepEqual(noKey.sections[0].blocks, [block])
  for (const key of [null, 12, 'other', '']) {
    const recovered = partialCombinedResponse(`{"sections":[{"blocks":[${JSON.stringify(block)}],"key":${JSON.stringify(key)},"reviewItems":[`)
    assert.equal(Object.hasOwn(recovered.sections[0], 'key'), true)
    assert.deepEqual(recovered.sections[0].key, key)
  }
  const unfinishedKey = partialCombinedResponse(`{"sections":[{"blocks":[${JSON.stringify(block)}],"key":"other-incomplete`)
  assert.equal(unfinishedKey.sections[0].key, null, '已开始但被截断的key不可被误判为旧格式无key')
  assert.deepEqual(unfinishedKey.sections[0].blocks, [block])
  assert.equal(partialCombinedProse('{"facts":[{"text":"事实不是正文"}],"sections":[{"blocks":[{"text":"旧式正文。"},{"text":"未完成').length, 1)
})

test('恢复事实仍需本批来源和用途校验，解析器不修造引用', () => {
  const source = { id: 'K-current', kind: 'knowledge', content: '客户授权后可在试点范围内统一记录销售与客服交接。' }
  const cards = sourceCardBatches([source])[0], node = { key: 'solution', title: '方案', roleId: 'solution' }
  for (const id of [cards[0].id, 'K-outside-batch']) {
    const rawFact = { ...fact, sourceCardIds: [id] }
    const recovered = partialCombinedResponse(`{"facts":[${JSON.stringify(rawFact)}],"sections":[{"key":"solution","blocks":[${JSON.stringify(block)}],"reviewItems":[`)
    assert.deepEqual(recovered.facts[0].sourceCardIds, [id])
    const materialized = materializeCombined(recovered, cards, [source], node)
    assert.equal(materialized.cards.length, id === cards[0].id ? 1 : 0)
    assert.equal(materialized.blocks.length, id === cards[0].id ? 1 : 0)
  }
})

test('非对象根、半个属性名、未进入sections的facts.text均不生成正文', () => {
  for (const text of ['', '[{"facts":[]}]', '说明：{"facts":[]}', '{"fa', '{"facts":[{"text":"完整事实"}],"sec']) {
    assert.deepEqual(partialCombinedResponse(text).sections, [])
  }
})

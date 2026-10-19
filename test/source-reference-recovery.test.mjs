import test from 'node:test'
import assert from 'node:assert/strict'
import { sourceCardBatches, materializeCombined } from '../src/combined-writing.js'
import { loadRules } from '../src/rules.js'

const node = { key: 'solution', title: '方案', roleId: 'solution' }
const source = { id: 'K-current', kind: 'knowledge', content: '试点范围内可统一记录销售和客服交接，仍须人工确认。' }
const claim = ids => ({ id: 'claim-1', text: '试点范围内可统一记录交接。', sourceCardIds: ids,
  subject: 'product', purpose: 'capability', supportMode: 'sourced', capabilityStatus: 'pilot' })
const document = fact => ({ facts: [fact], sections: [{ key: node.key,
  blocks: [{ text: '建议在试点范围内统一记录交接，仍须人工确认。', factIds: ['claim-1'], supportMode: 'candidate' }] }] })

test('正确s引用不变；唯一K仅归一化为本批一张卡，并保留完整审核记录', () => {
  const cards = sourceCardBatches([source])[0]
  const correct = materializeCombined(document(claim([cards[0].id])), cards, [source], node)
  assert.equal(correct.cards.length, 1)
  assert.deepEqual(correct.referenceAudit, { normalized: [], rejected: [] })
  const raw = document(claim([source.id])), before = structuredClone(raw)
  const compatible = materializeCombined(raw, cards, [source], node)
  assert.deepEqual(compatible.cards, correct.cards)
  assert.deepEqual(compatible.referenceAudit.normalized, [{ factAlias: 'claim-1', from: source.id, to: cards[0].id, reason: 'unique_source_evidence' }])
  assert.deepEqual(compatible.referenceAudit.rejected, [])
  assert.deepEqual(raw, before)
})

test('同K多个窗口没有唯一逐字定位时拒绝，不能选择首窗或展开全部窗口', () => {
  const long = { ...source, content: '首窗特有条件需要核对。' + '甲'.repeat(3000) + '中窗独有适用边界需要核对。' + '乙'.repeat(3000) }
  const cards = sourceCardBatches([long])[0]
  assert.ok(cards.length > 1)
  for (const fact of [claim([long.id]), { ...claim([long.id]), evidence: [{ id: long.id, quote: '甲'.repeat(20) }] }]) {
    const result = materializeCombined(document(fact), cards, [long], node)
    assert.equal(result.cards.length, 0); assert.equal(result.blocks.length, 0)
    assert.equal(result.referenceAudit.rejected[0].reason, 'ambiguous_source_reference')
    assert.deepEqual(result.referenceAudit.normalized, [])
  }
})

test('同K多个窗口可按同来源逐字引文唯一定位，绝不以概括文本猜窗口', () => {
  const quote = '中窗独有适用边界需要核对。'
  const long = { ...source, content: '甲'.repeat(3000) + quote + '乙'.repeat(3000) }
  const cards = sourceCardBatches([long])[0]
  const fact = { ...claim([long.id]), evidence: [{ id: long.id, quote }] }
  const result = materializeCombined(document(fact), cards, [long], node)
  const located = cards.filter(card => card.text.includes(quote))
  assert.equal(located.length, 1); assert.equal(result.cards.length, 1)
  assert.equal(result.referenceAudit.normalized[0].to, located[0].id)
  assert.equal(result.referenceAudit.normalized[0].reason, 'unique_quote_window')
  assert.deepEqual(result.cards[0].evidence, located[0].evidence)
  const onlySummary = materializeCombined(document({ ...claim([long.id]), text: quote }), cards, [long], node)
  assert.equal(onlySummary.cards.length, 0)
})

test('批外K即使存在于授权证据也不映射；错误引文和非法ID形状被记录', () => {
  const cards = sourceCardBatches([source])[0], outside = { id: 'K-outside', kind: 'knowledge', content: '这是其他批次的资料，不得跨批引用。' }
  const invalid = [
    [claim([outside.id]), 'unknown_source_reference'],
    [{ ...claim([source.id]), evidence: [{ id: source.id, quote: '当前窗口并不存在的原文片段。' }] }, 'source_quote_mismatch'],
    [{ ...claim([source.id]), sourceCardIds: source.id }, 'invalid_source_reference_shape'],
    [{ ...claim([source.id]), sourceCardIds: [source.id, 123] }, 'invalid_source_reference_shape'],
  ]
  for (const [fact, reason] of invalid) {
    const result = materializeCombined(document(fact), cards, [source, outside], node)
    assert.equal(result.cards.length, 0); assert.equal(result.blocks.length, 0)
    assert.equal(result.referenceAudit.rejected[0].reason, reason)
  }
})

test('引用归一化不绕过案例和企业用途、正向事实或候选边界', async () => {
  const rules = await loadRules(), cards = sourceCardBatches([source])[0]
  for (const roleId of ['customer-cases', 'company-profile']) {
    const result = materializeCombined(document(claim([source.id])), cards, [source], { ...node, roleId }, rules.chapters[roleId])
    assert.equal(result.referenceAudit.normalized.length, 1)
    assert.equal(result.cards.length, 0); assert.equal(result.blocks.length, 0)
    assert.ok(result.excludedFacts.length)
  }
})

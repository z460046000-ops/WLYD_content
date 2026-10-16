import test from 'node:test'
import assert from 'node:assert/strict'
import { sourceCardBatches, materializeCombined, partialCombinedProse } from '../src/combined-writing.js'
import { annotateDraft } from '../src/fact-cards.js'
import { loadRules } from '../src/rules.js'

const sources = [{ id: 'K1', kind: 'knowledge', source: '产品说明', locator: 'chunk=one', content: '产品支持销售和客服共同查看线索记录，目前只面向试点客户开放。' }]
const node = { key: 'service', title: '协作方案', roleId: 'delivery-service' }
const cards = sourceCardBatches(sources).flat()
const claim = (extra = {}) => ({ id: 'claim-1', text: '销售和客服可共同查看线索记录，目前处于试点阶段。',
  sourceCardIds: [cards[0].id], subject: 'product', purpose: 'capability', supportMode: 'sourced', capabilityStatus: 'pilot',
  capabilityOwnership: 'unknown', ...extra })
const document = (facts, blocks) => ({ facts, sections: [{ key: node.key, blocks }] })

test('合并响应中断只恢复sections内完整正文，不把facts或后续审核text当正文', () => {
  assert.deepEqual(partialCombinedProse('{"facts":[{"text":"只是提取事实。"}],"sec'), [])
  const prefix = '{"facts":[{"text":"含\\\"sections\\\"关键词的原文"}],"sections":[{"key":"service","blocks":['
  assert.deepEqual(partialCombinedProse(`${prefix}{"text":"已完成正文。"},{"text":"未完成`), [
    { text: '已完成正文。', supportMode: 'candidate', factIds: [] },
  ])
  assert.equal(partialCombinedProse(`${prefix}{"text":"已完成正文。"}]}],"reviewItems":[{"text":"审核话术"}]}`).length, 1)
})

test('原文卡窗口覆盖完整尾部且稳定，每批正文不超过8000字', () => {
  const content = '企业业务协作原文。'.repeat(1800) + '尾部限制：能力仍在试点中。'
  const source = [{ ...sources[0], content }]
  const batches = sourceCardBatches(source), all = batches.flat()
  assert.ok(batches.length > 1)
  assert.ok(batches.every(batch => batch.reduce((sum, card) => sum + card.text.length, 0) <= 8000))
  assert.ok(all.every(card => card.text.length <= 2400))
  assert.equal(all[0].span.start, 0)
  assert.equal(all.at(-1).span.end, content.length)
  assert.ok(all.at(-1).text.includes('尾部限制'))
  for (let i = 0; i < all.length; i++) {
    const card = all[i]
    assert.equal(card.text, content.slice(card.span.start, card.span.end))
    assert.deepEqual(card.evidence, [{ id: 'K1', quote: card.text }])
    assert.equal(card.subject, 'unknown'); assert.equal(card.purpose, 'unknown')
    assert.equal(card.source, '产品说明')
    if (i) assert.ok(card.span.start < all[i - 1].span.end)
  }
  assert.deepEqual(sourceCardBatches(source), batches)
})

test('一次提写的claim别名映射为稳定事实ID，原文由程序补齐', () => {
  const raw = document([claim()], [{ text: '试点范围内可共同查看线索记录，支持销售客服交接。', factIds: ['claim-1'],
    evidence: [{ id: 'FAKE', quote: '模型自造引用不得进入正文' }] }])
  const result = materializeCombined(raw, cards, sources, node)
  assert.equal(result.cards.length, 1)
  assert.match(result.cards[0].id, /^f-[a-f0-9]{20}$/u)
  assert.deepEqual(result.blocks[0].factIds, [result.cards[0].id])
  assert.deepEqual(result.blocks[0].evidence, cards[0].evidence)
  assert.equal(result.facts[0].semanticStatus, 'model_summary_unreviewed')
  assert.equal(result.cards[0].capabilityStatus, 'pilot')
  assert.deepEqual(materializeCombined(raw, cards, sources, node), result)
})

test('错误sourceCardId的事实被排除，其他可用段落继续保留', () => {
  const raw = document([claim(), claim({ id: 'claim-outside', sourceCardIds: ['not-in-batch'] })], [
    { text: '支持销售和客服共同查看线索记录。', factIds: ['claim-1'] },
    { text: '不能使用本批之外的事实构造引用。', factIds: ['claim-outside'] },
    { text: '未知编号只保留为待确认的用户可编辑草稿。', factIds: ['previous-batch-claim'] },
  ])
  const result = materializeCombined(raw, cards, sources, node)
  assert.equal(result.cards.length, 1)
  assert.equal(result.blocks.length, 2)
  assert.deepEqual(result.blocks[1].evidence, [])
  assert.deepEqual(result.blocks[1].factIds, [])
  assert.equal(result.blocks[1].supportMode, 'candidate')
  assert.ok(result.reviewItems.some(item => item.includes('本批以外')))
})

test('旧模型直接引用原文卡时一般章保留候选与未验证提示', () => {
  const raw = document(undefined, [{ text: '可考虑以共享记录核对销售和客服的交接责任。', factIds: [cards[0].id] }])
  const result = materializeCombined(raw, cards, sources, node)
  assert.equal(result.cards[0].purpose, 'unknown')
  assert.equal(result.cards[0].supportMode, 'candidate')
  assert.equal(result.blocks[0].supportMode, 'candidate')
  assert.ok(result.blocks[0].referenceWarnings.some(item => item.includes('尚未独立概括')))
  const checked = annotateDraft(result.blocks, result.cards, sources, node, {})
  assert.match(checked.section.blocks[0].text, /^【未验证】/u)
})

test('案例和企业章不能直接用unknown原文卡伪装正向事实，明确匹配的事实仍可写', async () => {
  const rules = await loadRules()
  for (const roleId of ['customer-cases', 'company-profile']) {
    const chapter = { ...node, roleId }
    const raw = document(undefined, [{ text: '客户已经合作且企业获得多项资质。', factIds: [cards[0].id] }])
    const result = materializeCombined(raw, cards, sources, chapter, rules.chapters[roleId])
    assert.equal(result.cards.length, 0); assert.equal(result.blocks.length, 0)
    assert.ok(result.excludedFacts.length)
  }
  const caseSources = [{ id: 'CASE', content: '甲公司在试点项目中使用统一线索记录完成销售与客服交接。' }]
  const caseCards = sourceCardBatches(caseSources).flat(), chapter = { ...node, roleId: 'customer-cases' }
  const result = materializeCombined(document([{ id: 'claim-case', text: caseSources[0].content, sourceCardIds: [caseCards[0].id],
    subject: 'customer', purpose: 'case', supportMode: 'sourced' }], [
    { text: caseSources[0].content, factIds: ['claim-case'] },
  ]), caseCards, caseSources, chapter, rules.chapters['customer-cases'])
  assert.equal(result.blocks.length, 1); assert.equal(result.cards[0].purpose, 'case')
})

test('内部事实和错用途事实退出正文，不影响其他有据内容', async () => {
  const internal = [{ id: 'INTERNAL', content: '供应商自身缺少场景诊断，存在定位不清与信任赤字。' }]
  const allSources = [...sources, ...internal], allCards = sourceCardBatches(allSources).flat()
  const rules = await loadRules(), chapter = { ...node, roleId: 'business-challenges' }
  const raw = document([claim(), { id: 'internal', text: internal[0].content, sourceCardIds: [allCards[1].id],
    subject: 'vendor-internal', purpose: 'internal', supportMode: 'sourced' }], [
    { text: '供应商自身缺少场景诊断，存在定位不清与信任赤字。', factIds: ['internal'] },
    { text: '产品试点能力不是本章的客户需求事实。', factIds: ['claim-1'] },
    { text: '可考虑确认跨团队交接中的信息同步要求。', supportMode: 'candidate', factIds: [] },
  ])
  const result = materializeCombined(raw, allCards, allSources, chapter, rules.chapters['business-challenges'])
  assert.equal(result.blocks.length, 1)
  assert.ok(result.excludedFacts.some(fact => fact.subject === 'vendor-internal'))
  assert.ok(result.excludedFacts.some(fact => fact.subject === 'product'))
})

test('legacy引文只能命中本批原文窗口，原文同一来源的未送尾部也不能引用', () => {
  const longSources = [{ id: 'LONG', content: '共享线索记录的业务说明。'.repeat(300) + '未送本批的尾部事实不得引用。' }]
  const batch = sourceCardBatches(longSources)[0].slice(0, 1)
  const raw = document(undefined, [
    { text: '可考虑围绕共享线索记录完善业务交接。', evidence: [{ id: 'LONG', quote: '共享线索记录的业务说明' }] },
    { text: '可考虑后续核对未送本批的尾部事实。', evidence: [{ id: 'LONG', quote: '未送本批的尾部事实不得引用' }] },
  ])
  const result = materializeCombined(raw, batch, longSources, node)
  assert.equal(result.blocks.length, 2)
  assert.ok(result.blocks[0].evidence.length)
  assert.deepEqual(result.blocks[1].evidence, [])
  assert.ok(result.blocks[1].referenceWarnings.some(item => item.includes('不在本批')))
})

test('重复claim别名不产生歧义引用且目录外章节不进入本章', () => {
  const raw = document([claim(), claim({ text: '另一条不同的事实。' })], [{ text: '歧义事实不能支撑本章正文。', factIds: ['claim-1'] }])
  raw.sections.push({ key: 'outside', blocks: [{ text: '目录外正文不能进入当前章节。', factIds: [cards[0].id] }] })
  const result = materializeCombined(raw, cards, sources, node)
  assert.equal(result.cards.length, 0); assert.equal(result.blocks.length, 0)
  assert.ok(result.reviewItems.some(item => item.includes('重复')))
})

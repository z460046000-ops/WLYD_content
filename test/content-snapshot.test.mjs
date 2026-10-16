import test from 'node:test'
import assert from 'node:assert/strict'
import { createSnapshot, snapshotHash } from '../src/content/snapshot.js'

function report() {
  return { schemaVersion: 2, runId: 'R1', title: '客户方案', generatedAt: '2026-10-16T01:00:00Z', reviewStatus: 'draft_ready',
    outline: [{ key: 'business', title: '业务现状', roleId: 'business-challenges', required: true, theme: 'dark',
      children: [{ key: 'scenario', title: '场景方案', roleId: 'scenario-solution', required: true }] }],
    sections: [{ key: 'business', title: '业务现状', roleId: 'business-challenges', layout: 'columns',
      blocks: [{ id: 'business-10', text: '【待确认】典型交接可能需要统一记录。', supportMode: 'candidate',
        evidence: [{ id: 'K1', quote: '销售与客服通过统一记录核对交接。' }], planRefs: { problemIds: ['P1'], capabilityIds: ['C1'] },
        capabilityStatus: 'proposed', capabilityOwnership: 'third-party', verification: 'unverified', conditions: ['仍须人工确认交接。'] }] },
      { key: 'scenario', blocks: [{ text: '建议对齐交接责任，落地方式仍须确认。', supportMode: 'candidate', evidence: [], planRefs: { capabilityIds: ['C1'] } }] }],
    chapterOutcomes: [{ key: 'business', status: 'draft_unverified', version: 2 }, { key: 'scenario', status: 'partial', version: 1 }],
    chapterRecords: { business: { version: 3, approvalStatus: 'approved', notes: [{ text: '内部评论' }], approvedAt: 'now' } },
    choices: { framework: 'pest' }, assemblyLinks: [{ scenarioBlockId: 'scenario-1', challengeBlockId: 'business-10', status: 'proposed' }],
    assemblyReview: { status: 'completed', passed: false, missingChapters: [], finishedAt: 'now' } }
}

test('文案快照保留章节版本、来源、主线和能力边界；不改原报告、稳定段落ID不重编', () => {
  const source = report(), original = structuredClone(source), snapshot = createSnapshot(source)
  assert.equal(snapshot.schemaVersion, 1); assert.equal(snapshot.runId, 'R1')
  assert.equal(snapshot.sections[0].version, 3); assert.equal(snapshot.sections[0].approvalStatus, 'approved')
  assert.equal(snapshot.sections[0].status, 'draft_unverified')
  assert.equal(snapshot.sections[0].blocks[0].id, 'business-10')
  assert.equal(snapshot.sections[1].blocks[0].id, 'scenario-1')
  assert.deepEqual(snapshot.sections[0].blocks[0].evidence, source.sections[0].blocks[0].evidence)
  assert.equal(snapshot.sections[0].blocks[0].capabilityOwnership, 'third-party')
  assert.equal(snapshot.sections[0].blocks[0].capabilityStatus, 'proposed')
  assert.deepEqual(snapshot.sections[0].blocks[0].conditions, ['仍须人工确认交接。'])
  assert.deepEqual(snapshot.assemblyLinks, source.assemblyLinks)
  assert.equal(snapshot.coverage.proseChapters, 2)
  assert.equal(snapshot.outline[0].theme, undefined); assert.equal(snapshot.sections[0].layout, undefined)
  snapshot.sections[0].blocks[0].text = '修改输出'; snapshot.assemblyLinks[0].status = 'changed'
  assert.deepEqual(source, original)
})

test('哈希不依赖时间、对象键顺序或视觉设置，同一快照投影哈希一致', () => {
  const source = report(), changed = structuredClone(source)
  changed.generatedAt = 'later'; changed.theme = 'bright'; changed.sections[0].layout = 'grid'
  changed.outline[0].theme = 'bright'; changed.chapterRecords.business.approvedAt = 'later'
  changed.assemblyReview.finishedAt = 'later'; changed.assemblyReview.theme = 'anything'
  const snapshot = createSnapshot(source)
  assert.equal(snapshot.sourceContentSha256, snapshotHash(source))
  assert.equal(snapshot.sourceContentSha256, snapshotHash(snapshot))
  assert.equal(snapshotHash(source), snapshotHash(changed))
  const reversed = Object.fromEntries(Object.entries(source).reverse())
  assert.equal(snapshotHash(reversed), snapshotHash(source))
})

test('正文、引文、章节版本、用户确认及审核结果改变，均使输出源哈希失效', () => {
  for (const change of [value => { value.sections[0].blocks[0].text += '补充条件。' },
    value => { value.sections[0].blocks[0].evidence[0].quote += '条件' },
    value => { value.chapterRecords.business.version++ },
    value => { value.chapterRecords.business.approvalStatus = 'pending' },
    value => { value.assemblyReview.status = 'partial' },
    value => { value.sections[0].blocks[0].capabilityStatus = 'pilot' }]) {
    const source = report(), changed = structuredClone(source); change(changed)
    assert.notEqual(snapshotHash(source), snapshotHash(changed))
  }
})

test('待补卡保留缺料说明，不制造演示正文或丢弃确认目录', () => {
  const source = report(); source.sections[1] = { key: 'scenario', blocks: [], inputNeeded: { reason: '取材请求未完成', questions: ['需补哪些材料？'] } }
  source.chapterOutcomes[1].status = 'needs_input'
  const snapshot = createSnapshot(source)
  assert.equal(snapshot.sections[1].inputNeeded.reason, '取材请求未完成')
  assert.deepEqual(snapshot.sections[1].blocks, [])
  assert.equal(snapshot.coverage.proseChapters, 1); assert.equal(snapshot.coverage.needsInputChapters, 1)
})

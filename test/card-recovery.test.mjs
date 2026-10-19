import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveChapterCards } from '../src/content/card-recovery.js'
import { sourceCardBatches, materializeCombined } from '../src/combined-writing.js'
import { factCards } from '../src/fact-cards.js'
import { loadRules } from '../src/rules.js'
import { createTaskService } from '../src/tasks.js'
import { chapterAction } from '../src/chapters.js'
import { runPath } from '../src/store.js'
import { taskFixture, readRecord } from './task-helpers.mjs'
import { completeAudit } from './helpers.mjs'

const node = { key: 'solution', title: '场景方案', roleId: 'scenario-solution' }
const source = { id: 'K-source', kind: 'knowledge', content: '产品在试点范围内提供统一记录，交接结果仍须人工确认。' }
function raw(ids, extra = {}) {
  return { facts: [{ id: 'claim-1', text: '试点范围内可统一记录交接。', subject: 'product', purpose: 'capability', supportMode: 'sourced', sourceCardIds: ids, ...extra }],
    sections: [{ key: node.key, blocks: [{ text: '试点范围内可统一记录交接，仍须人工确认。', factIds: ['claim-1'], supportMode: 'candidate' }] }] }
}
const write = (dir, filename, value) => writeFile(path.join(dir, filename), JSON.stringify(value))
async function fixture({ evidence = [source], cards, extraction, draft, manual = true } = {}) {
  const chapterDir = await mkdtemp(path.join(tmpdir(), 'wlyd-card-recovery-'))
  const batch = sourceCardBatches(evidence)[0]
  await write(chapterDir, 'cards.json', { cards: cards || [] })
  await write(chapterDir, 'extraction.json', extraction || { mode: 'retrieve-write', facts: [], batches: [{ batchId: '1',
    sourceCardIds: batch.map(card => card.id), evidenceIds: [...new Set(batch.map(card => card.sourceEvidenceId))] }] })
  await write(chapterDir, 'draft-1.json', draft || raw([source.id]))
  if (manual) await write(chapterDir, 'chapter.json', { version: 9, section: { key: node.key, blocks: [{ id: 'solution-7', text: '这是人工确认后的最新正文，不能被旧草稿覆盖。' }] } })
  return { chapterDir, evidence, node, rule: {}, batch }
}

test('有效非空已存卡优先且不改变卡ID；空池回退checked extraction而非直接信任raw事实', async () => {
  const cards = materializeCombined(raw([sourceCardBatches([source])[0][0].id]), sourceCardBatches([source])[0], [source], node).cards
  const stored = await fixture({ cards })
  const first = await resolveChapterCards(stored)
  assert.equal(first.source, 'stored'); assert.deepEqual(first.cards, cards); assert.equal(first.changed, false)
  const extraction = await fixture({ extraction: { facts: cards.map(({ id, ...fact }) => fact) } })
  const second = await resolveChapterCards(extraction)
  assert.equal(second.source, 'extraction'); assert.equal(second.cards.length, 1)
  const unverified = await fixture({ extraction: { facts: [{ text: '未经核对的模型事实不能成为卡片。', supportMode: 'sourced', sourceCardIds: [source.id] }] } })
  assert.equal((await resolveChapterCards(unverified)).cards.length, 0)
})

test('旧K草稿只能按原批次清单重放补卡，helper不写任何文件或覆盖人工现稿', async () => {
  const f = await fixture(), files = ['cards.json', 'extraction.json', 'draft-1.json', 'chapter.json']
  const before = await Promise.all(files.map(file => readFile(path.join(f.chapterDir, file), 'utf8')))
  const result = await resolveChapterCards(f)
  assert.equal(result.source, 'replayed'); assert.equal(result.cards.length, 1)
  assert.equal(result.referenceAudit.normalized[0].from, source.id)
  assert.deepEqual(await Promise.all(files.map(file => readFile(path.join(f.chapterDir, file), 'utf8'))), before)
})

test('卡片内容哈希被篡改、引文失效或权限证据撤回时不可直接采用', async () => {
  const original = factCards([{ text: '产品在试点范围内提供统一记录。', supportMode: 'sourced', evidence: [{ id: source.id, quote: source.content }] }])[0]
  const tampered = { ...original, text: '卡ID不变却篡改卡片内容。' }
  const f = await fixture({ cards: [tampered], extraction: {} })
  const result = await resolveChapterCards(f)
  assert.equal(result.cards.length, 0); assert.equal(result.source, 'empty')
  const noAccess = await fixture({ cards: [original] })
  assert.equal((await resolveChapterCards({ ...noAccess, evidence: [] })).cards.length, 0)
  const unsupported = factCards([{ text: '不存在于证据中的引用。', supportMode: 'sourced', evidence: [{ id: source.id, quote: '这句引文不在原文中。' }] }])
  assert.equal((await resolveChapterCards(await fixture({ cards: unsupported, extraction: {} }))).cards.length, 0)
})

test('原批次清单缺失、不匹配、批外来源不能从全库反查恢复', async () => {
  const outside = { id: 'K-outside', kind: 'knowledge', content: '其他批次的授权资料不能冒充本批输入。' }
  const f = await fixture({ draft: raw([outside.id]) })
  const rejected = await resolveChapterCards({ ...f, evidence: [source, outside] })
  assert.equal(rejected.cards.length, 0); assert.equal(rejected.referenceAudit.rejected[0].reason, 'unknown_source_reference')
  const missing = await fixture({ extraction: { mode: 'retrieve-write', facts: [] } })
  assert.equal((await resolveChapterCards(missing)).failureCode, 'recovery_manifest_missing')
  const mismatch = await fixture({ extraction: { mode: 'retrieve-write', facts: [], batches: [{ batchId: '1', sourceCardIds: ['s-unknown'], evidenceIds: [source.id] }] } })
  assert.equal((await resolveChapterCards(mismatch)).failureCode, 'recovery_manifest_mismatch')
})

test('同K多窗口没有唯一quote则不恢复，案例和企业错误用途不能升级', async () => {
  const long = { ...source, content: '甲'.repeat(6000) }
  const ambiguous = await fixture({ evidence: [long] })
  const result = await resolveChapterCards(ambiguous)
  assert.equal(result.cards.length, 0); assert.equal(result.failureCode, 'ambiguous_source_reference')
  const rules = await loadRules()
  for (const roleId of ['customer-cases', 'company-profile']) {
    const f = await fixture()
    const rejected = await resolveChapterCards({ ...f, node: { ...node, roleId }, rule: rules.chapters[roleId] })
    assert.equal(rejected.cards.length, 0)
  }
})

async function revisionFixture(t) {
  const f = await taskFixture({ quality_mode: 'draft', outline: [node] }), calls = []
  const llm = { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }] } }), async *stream(request) {
    const prompt = JSON.parse(request.messages[0].content[0].text); calls.push(prompt)
    let value
    if (prompt.stage === 'consistency-review') value = completeAudit()
    else if (prompt.stage === 'write') value = prompt.generationMode === 'retrieve-write'
      ? raw([prompt.facts[0].id]) : { sections: [{ key: node.key, blocks: [{ text: '按本次修改统一交接核对，具体范围待用户确认。',
        supportMode: 'candidate', factIds: [prompt.facts[0]?.id] }] }] }
    else assert.fail(`unexpected ${prompt.stage}`)
    yield { type: 'text-delta', text: JSON.stringify(value) }; yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const service = createTaskService({ ...f, llm }); t.after(() => service.close())
  const submitted = await service.submit(f.args, f.exec)
  assert.equal((await f.jobs.settled(submitted.jobId)).status, 'completed')
  const dir = runPath(f.agent, submitted.runId), chapterDir = path.join(dir, 'chapters', node.key)
  return { ...f, calls, llm, dir, chapterDir, runId: submitted.runId,
    revise: () => chapterAction({ client: f.client, llm, exec: f.exec, args: { run_id: submitted.runId, action: 'revise', chapter_key: node.key, expected_version: 1, instruction: '按本次修改统一交接核对' } }) }
}

test('官方revise可恢复空卡池后再修订；旧正文完整留在上一版本，不自动重放覆盖现稿', async t => {
  const f = await revisionFixture(t), reportPath = path.join(f.dir, 'report.json')
  const before = await readRecord(reportPath), evidence = (await readRecord(path.join(f.dir, 'evidence.json'))).evidence
  const extraction = await readRecord(path.join(f.chapterDir, 'extraction.json'))
  const firstId = extraction.batches[0].evidenceIds[0]
  await write(f.chapterDir, 'cards.json', { cards: [] })
  await write(f.chapterDir, 'extraction.json', { ...extraction, facts: [] })
  await write(f.chapterDir, 'draft-1.json', raw([firstId]))
  assert.ok(evidence.some(row => row.id === firstId))
  const revised = await f.revise()
  assert.equal(revised.chapter.version, 2)
  const chapter = await readRecord(path.join(f.chapterDir, 'chapter.json'))
  assert.equal(chapter.cardRecovery.source, 'replayed')
  assert.ok((await readRecord(path.join(f.chapterDir, 'cards.json'))).cards.length)
  assert.deepEqual((await readRecord(path.join(f.chapterDir, 'versions/1.json'))).section, before.sections[0])
  assert.ok(f.calls.at(-2).facts?.length || f.calls.some(call => call.stage === 'write' && !call.generationMode && call.facts.length))
  assert.ok(revised.chapter.blocks[0].evidence.length)
})

test('官方revise无法恢复卡池时不调用模型、不覆盖现稿和版本，撤权在恢复前拒绝', async t => {
  const f = await revisionFixture(t), reportPath = path.join(f.dir, 'report.json')
  const before = await readFile(reportPath, 'utf8'), oldChapter = await readFile(path.join(f.chapterDir, 'chapter.json'), 'utf8')
  await write(f.chapterDir, 'cards.json', { cards: [] }); await write(f.chapterDir, 'extraction.json', { facts: [] })
  const calls = f.calls.length
  await assert.rejects(f.revise(), error => error.code === 'CHAPTER_CARD_POOL_EMPTY' && /当前稿件和版本已保留/u.test(error.message))
  assert.equal(f.calls.length, calls)
  assert.equal(await readFile(reportPath, 'utf8'), before)
  assert.equal(await readFile(path.join(f.chapterDir, 'chapter.json'), 'utf8'), oldChapter)
  f.client.visibleProjectBases = async () => []
  await assert.rejects(f.revise(), /当前项目权限/u)
  assert.equal(f.calls.length, calls)
})

test('人工修复后的新版本只读查看不触发恢复，旧版本revise不能覆盖现稿', async t => {
  const f = await revisionFixture(t), reportPath = path.join(f.dir, 'report.json')
  const report = await readRecord(reportPath)
  report.chapterRecords = { [node.key]: { version: 7, approvalStatus: 'pending', notes: [] } }
  report.chapterOutcomes[0].version = 7
  report.sections[0].blocks[0].text = '这是人工修复并保存的现有第七版正文，旧草稿不能覆盖。'
  await write(f.dir, 'report.json', report)
  const before = await readFile(reportPath, 'utf8'), calls = f.calls.length
  const listed = await chapterAction({ client: f.client, llm: f.llm, exec: f.exec, args: { run_id: f.runId, action: 'list' } })
  assert.equal(listed.chapters[0].version, 7)
  assert.match(listed.chapters[0].blocks[0].text, /人工修复/u)
  await assert.rejects(f.revise(), /版本已改变/u)
  assert.equal(f.calls.length, calls)
  assert.equal(await readFile(reportPath, 'utf8'), before)
})

test('成功修订刷新正文诊断并保留历史原因；其他失败和已批准章节不变，整体状态不虚报完整', async t => {
  for (const otherFailed of [false, true]) {
    const f = await revisionFixture(t), report = await readRecord(path.join(f.dir, 'report.json'))
    const state = await readRecord(path.join(f.dir, 'run.json'))
    const oldReasons = ['reference_id_mismatch', 'no_prose']
    const failed = { ...report.chapterOutcomes[0], status: 'failed', error: '旧卡片契约故障',
      diagnostics: { hasProse: false, selectedFacts: 0, reasonCode: 'no_prose', reasonCodes: oldReasons } }
    report.sections[0] = { ...report.sections[0], blocks: [], inputNeeded: { reason: '旧卡片契约故障' } }
    report.chapterOutcomes[0] = failed; report.reviewStatus = 'failed'
    state.chapters[0] = structuredClone(failed); state.status = 'failed'
    if (otherFailed) {
      report.outline.push({ key: 'other', title: '其他失败章', roleId: 'technical-platform' }, { key: 'approved', title: '已确认章', roleId: 'delivery-service' })
      report.sections.push({ key: 'other', blocks: [] }, { key: 'approved', blocks: [{ id: 'approved-1', text: '这段已获用户确认，应当原样保留。', supportMode: 'candidate', evidence: [] }] })
      const other = { key: 'other', title: '其他失败章', status: 'failed', version: 3, diagnostics: { hasProse: false, reasonCode: 'model_timeout', reasonCodes: ['model_timeout'] } }
      const approved = { key: 'approved', title: '已确认章', status: 'draft_unverified', version: 4 }
      report.chapterOutcomes.push(other, approved); state.chapters.push(structuredClone(other), structuredClone(approved))
      report.chapterRecords = { approved: { version: 4, approvalStatus: 'approved', notes: [] } }
    }
    state.chapterOutcomes = structuredClone(report.chapterOutcomes)
    await write(f.dir, 'report.json', report); await write(f.dir, 'run.json', state)
    await f.revise()
    const after = await readRecord(path.join(f.dir, 'report.json')), afterState = await readRecord(path.join(f.dir, 'run.json'))
    const diagnostics = after.chapterOutcomes[0].diagnostics
    assert.equal(diagnostics.hasProse, true); assert.equal(diagnostics.selectedFacts, (await readRecord(path.join(f.chapterDir, 'cards.json'))).cards.length)
    assert.equal(diagnostics.reasonCode, null); assert.deepEqual(diagnostics.reasonCodes, [])
    assert.ok(oldReasons.every(reason => diagnostics.historicalReasonCodes.includes(reason)))
    assert.equal(after.chapterOutcomes[0].error, undefined)
    assert.ok(after.chapterOutcomes[0].historicalErrors.includes('旧卡片契约故障'))
    assert.deepEqual(afterState.chapters[0].diagnostics, diagnostics)
    assert.deepEqual(afterState.chapterOutcomes[0].diagnostics, diagnostics)
    assert.deepEqual((await readRecord(path.join(f.chapterDir, 'chapter.json'))).diagnostics, diagnostics)
    assert.equal(after.contentCoverage.chapterDiagnostics[0].reasonCode, null)
    assert.equal(after.reviewStatus, otherFailed ? 'partial_draft' : 'draft_ready')
    assert.equal(afterState.status, after.reviewStatus)
    assert.deepEqual(after.chapterOutcomes.slice(1), report.chapterOutcomes.slice(1))
    assert.deepEqual(after.sections.slice(1), report.sections.slice(1))
    if (otherFailed) assert.deepEqual(after.chapterRecords.approved, report.chapterRecords.approved)
  }
})

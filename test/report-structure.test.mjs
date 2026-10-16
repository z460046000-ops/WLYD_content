import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chapterOutcomes, reportText, reviewDocument, reviewText, validateDraft } from '../src/content.js'
import { ingest, status } from '../src/workflow.js'
import { assembleConfirmed, completeAudit } from './helpers.mjs'

const section = (key, text = '用统一记录衔接团队之间的业务交接。') => ({ key, blocks: [{ id: `${key}-1`, text,
  supportMode: 'candidate', evidence: [] }] })

test('可变目录按层级保留失败必需章和部分正文，显式省略可选案例，不追加内部审核说明', () => {
  const report = { title: '客户协作方案', outline: [
    { key: 'context', title: '运营情况', required: true },
    { key: 'solution', title: '建设方案', children: [{ key: 'handoff', title: '交接流程' }] },
    { key: 'cases', title: '行业实践', required: false },
  ], sections: [section('solution'), section('handoff')], chapterOutcomes: [
    { key: 'context', status: 'failed', error: '内部模型错误详情' },
    { key: 'solution', status: 'completed' }, { key: 'handoff', status: 'partial' },
    { key: 'cases', status: 'omitted', omissionReason: '无已交付案例证据' },
  ], reviewItems: ['内部模型审核事项'], validationIssues: ['内部校验错误'], gaps: ['材料缺项详情'] }
  const text = reportText(report)
  assert.match(text, /部分草稿/u)
  assert.match(text, /## 运营情况\n\n> 本章尚未完成/u)
  assert.match(text, /## 建设方案/u)
  assert.match(text, /### 交接流程\n\n> 本章尚未完整/u)
  assert.ok(text.includes('用统一记录衔接团队之间的业务交接。'))
  assert.doesNotMatch(text, /行业实践|内部模型错误详情|内部模型审核事项|内部校验错误|材料缺项详情|待核对的组稿关系/u)
  assert.equal(chapterOutcomes(report).filter(row => row.status === 'omitted').length, 1)
})

test('内部审核按章节归组并跨类别去重，原始记录完整保留，正常正文不删除客户话术', () => {
  const report = { runId: 'run', title: '产品粗目录管理方案', reviewStatus: 'needs_human_review',
    outline: [{ key: 'custom-chapter', title: '目录管理' }], sections: [section('custom-chapter', '客户可以维护业务目录，按职责管理不同章节。')],
    reviewItems: ['custom-chapter 的引用需要核对', 'custom-chapter  的引用需要核对', '跨章节关联需要核对'],
    validationIssues: ['custom-chapter 的引用需要核对'], gaps: ['缺少目录管理的实施边界'], assemblyReview: { passed: false } }
  const review = reviewDocument(report)
  assert.equal(review.summary.uniqueItems, 3)
  assert.equal(review.summary.sourceItems, 5)
  const repeated = review.items.find(item => item.text === 'custom-chapter 的引用需要核对')
  assert.equal(repeated.occurrences, 3)
  assert.deepEqual(repeated.categories, ['review', 'validation'])
  assert.deepEqual(review.groups.find(group => group.key === 'custom-chapter').itemIds, [repeated.id, review.items[2].id])
  assert.deepEqual(review.raw.reviewItems, report.reviewItems)
  assert.deepEqual(review.raw.validationIssues, report.validationIssues)
  assert.deepEqual(review.raw.assemblyReview, report.assemblyReview)
  assert.equal(reviewText(review).split('custom-chapter 的引用需要核对').length - 1, 1)
  assert.match(reportText(report), /客户可以维护业务目录，按职责管理不同章节/u)
  assert.match(reportText(report), /# 产品粗目录管理方案/u)
  assert.doesNotMatch(reportText(report), /部分草稿/u)
})

test('必需章不能通过错误的 omitted 或空 completed 伪装完整，可选失败也保持可见', () => {
  const report = { title: '方案', outline: [
    { key: 'required', title: '必需章节', required: true },
    { key: 'empty', title: '空章节' }, { key: 'optional', title: '可选失败章', required: false },
  ], sections: [], chapterOutcomes: [{ key: 'required', status: 'omitted' },
    { key: 'empty', status: 'completed' }, { key: 'optional', status: 'failed' }] }
  assert.deepEqual(chapterOutcomes(report).map(row => row.status), ['failed', 'failed', 'failed'])
  const text = reportText(report)
  assert.match(text, /## 必需章节/u)
  assert.match(text, /## 空章节/u)
  assert.match(text, /## 可选失败章/u)
  assert.equal(text.split('本章尚未完成').length - 1, 3)
})

test('候选内容的明确否定不误判为交付承诺，独立正向承诺和无据数字仍被拒绝', () => {
  const outline = [{ key: 'service', title: '协作方案', roleId: 'delivery-service' }]
  const draft = { sections: [{ key: 'service', blocks: [
    { text: '可探索跨团队协作流程，不能作为已交付案例使用。', supportMode: 'candidate', evidence: [] },
    { text: '可探索跨团队协作流程，不得视为客户已经交付的功能。', supportMode: 'candidate', evidence: [] },
    { text: '本产品已交付完整自动化协作流程。', supportMode: 'candidate', evidence: [] },
    { text: '不能作为已交付案例，但客户已交付完整协作流程。', supportMode: 'candidate', evidence: [] },
    { text: '可考虑统一记录，保证所有业务问题得到解决。', supportMode: 'candidate', evidence: [] },
    { text: '不能作为已交付案例，建议处理效率提升80%。', supportMode: 'candidate', evidence: [] },
  ] }] }
  const checked = validateDraft(draft, [], outline)
  assert.equal(checked.sections[0].blocks.length, 2)
  assert.equal(checked.issues.length, 4)
  assert.ok(checked.issues.includes('service 含引文未支持的数字'))
  assert.ok(checked.sections[0].blocks.every(block => block.supportMode === 'candidate' && block.text.startsWith('【待确认')))
})

test('组稿落盘时 report、run、status 同步真实缺章状态并交付独立审核文件', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'wlyd-report-structure-'))
  const agent = { options: { provider: 'fake', model: 'fake' }, session: { header: { cwd } } }
  const exec = { agent, signal: new AbortController().signal }
  const client = { projects: async () => { throw new Error('平台未配置') } }
  const ctx = { fs: { resolve: async value => value, stat: async () => ({ type: 'file', size: 50 }),
    readBytes: async () => Buffer.from('产品支持统一维护线索状态，销售和客服依据同一记录协作。') } }
  const input = await ingest({ ctx, client, args: { files: ['source.md'] }, exec })
  const outline = [{ key: 'service', title: '协作服务', roleId: 'delivery-service', required: true },
    { key: 'extra', title: '实施边界', roleId: 'delivery-service', required: true }]
  const llm = { async *stream(request) {
    const prompt = JSON.parse(request.messages[0].content[0].text)
    if (prompt.chapter?.key === 'extra') throw new Error('模拟章节服务不可用')
    const value = prompt.stage === 'extract' ? { facts: prompt.evidence.map(item => ({ text: item.content,
      evidence: [{ id: item.id, quote: item.content }] })), writingOutline: [] }
      : prompt.stage === 'consistency-review' ? completeAudit(['service：请核对客户适用范围', 'service：请核对客户适用范围'])
      : prompt.stage === 'panorama-enrichment' ? { additions: [], reviewItems: [] }
      : { sections: [section(prompt.chapter.key)], reviewItems: ['service：请核对客户适用范围'] }
    yield { type: 'text-delta', text: JSON.stringify(value) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const result = await assembleConfirmed({ client, llm, args: { source_run_id: input.runId, outline }, exec })
  const report = JSON.parse(await readFile(result.jsonPath, 'utf8'))
  const state = await status({ client, runId: result.runId, agent })
  const text = await readFile(result.reportPath, 'utf8')
  const review = JSON.parse(await readFile(result.reviewJsonPath, 'utf8'))
  assert.equal(result.status, 'partial_draft')
  assert.equal(report.reviewStatus, result.status)
  assert.equal(state.status, report.reviewStatus)
  assert.equal(report.assemblyReview.passed, false)
  assert.deepEqual(state.missingChapters, ['extra'])
  assert.deepEqual(state.chapterOutcomes, report.chapterOutcomes)
  assert.equal(state.reviewPath, result.reviewPath)
  assert.equal(state.reviewJsonPath, result.reviewJsonPath)
  assert.match(text, /## 实施边界\n\n> 本章尚未完成/u)
  assert.doesNotMatch(text, /模拟章节服务不可用|请核对客户适用范围|待补充或人工确认/u)
  assert.match(await readFile(result.reviewPath, 'utf8'), /模拟章节服务不可用|请核对客户适用范围/u)
  assert.deepEqual(review.raw.gaps, report.gaps)
  assert.ok(review.groups.find(group => group.key === 'service'))
})

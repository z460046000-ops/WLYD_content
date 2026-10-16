import test from 'node:test'
import assert from 'node:assert/strict'
import { createStatusRenderer, statusSummary } from '../orchestration/status.js'
import { roleRoute, roleExecution } from '../orchestration/routes.js'
import { resolveModelSelection, resolveWritingModel } from '../src/model.js'
import { coverageFromReport } from '../src/content/coverage.js'

const decoded = output => JSON.parse(output[0].text)
const state = overrides => ({ runId: 'run-a', actorDshId: 'user-a', kind: 'assembly-task', status: 'generating',
  progress: { total: 9, draft: 2, pending: 7 }, reportReady: false, ...overrides })

test('默认状态输出只返回摘要：3.8MB模型运行记录不进入上下文，完整详情须显式请求', () => {
  const render = createStatusRenderer()
  const raw = state({ modelRequests: [{ input: '私有模型上下文'.repeat(400000), output: '不应进入默认状态' }],
    chapters: [{ key: 'private', rawPrompt: '完整章节提示词' }], error: '错误'.repeat(300) })
  assert.ok(Buffer.byteLength(JSON.stringify(raw)) > 3_800_000)
  const output = render({}, raw), compact = decoded(output)
  assert.ok(output[0].text.length < 1600)
  assert.equal(compact.modelRequests, undefined); assert.equal(compact.chapters, undefined)
  assert.ok(!output[0].text.includes('私有模型上下文')); assert.ok(!output[0].text.includes('完整章节提示词'))
  assert.equal(compact.error.length, 240)
  const detail = decoded(render({ view: 'detail' }, raw))
  assert.equal(detail.modelRequests[0].input.length, raw.modelRequests[0].input.length)
  assert.deepEqual(detail.chapters, raw.chapters)
  assert.equal(raw.modelRequests.length, 1)
})

test('同版本与仅底层日志变化时返回极小状态；变化后只返回字段差异，删除字段显式置null', () => {
  const render = createStatusRenderer(), original = state({ reportPath: '/tmp/report.md', jsonPath: '/tmp/report.json' })
  const first = decoded(render({}, original))
  const unchanged = decoded(render({ after_revision: first.revision }, { ...original, modelRequests: [{ status: 'new trace' }], updatedAt: 'later' }))
  assert.deepEqual(unchanged, { runId: 'run-a', status: 'generating', revision: first.revision, changed: false })
  assert.ok(JSON.stringify(unchanged).length < 160)
  const changed = decoded(render({ after_revision: first.revision }, state({ status: 'draft_reviewing', reportReady: true })))
  assert.equal(changed.changed, true); assert.notEqual(changed.revision, first.revision)
  assert.equal(changed.changes.status, 'draft_reviewing'); assert.equal(changed.changes.reportReady, true)
  assert.equal(changed.changes.reportPath, null); assert.equal(changed.changes.jsonPath, null)
  assert.equal(changed.changes.progress, undefined)
  assert.equal(changed.progress, undefined)
})

test('差异历史按run与用户隔离；未知或过期revision回退到完整摘要，不拼接其他用户记录', () => {
  const render = createStatusRenderer()
  const first = decoded(render({}, state({ reportPath: '/tmp/user-a.md' })))
  const otherActor = decoded(render({ after_revision: first.revision }, state({ actorDshId: 'user-b', status: 'reviewing' })))
  assert.equal(otherActor.changes, undefined); assert.equal(otherActor.status, 'reviewing')
  assert.equal(otherActor.reportPath, undefined)
  const otherRun = decoded(render({ after_revision: first.revision }, state({ runId: 'run-b', status: 'reviewing' })))
  assert.equal(otherRun.changes, undefined); assert.equal(otherRun.runId, 'run-b')
  const unknown = decoded(render({ after_revision: 'unknown-revision' }, state({ status: 'draft_ready' })))
  assert.equal(unknown.changes, undefined); assert.equal(unknown.status, 'draft_ready'); assert.equal(unknown.changed, true)
})

test('默认状态保留真实2/9正文覆盖，不携带逐章长诊断；文件与审核状态仍可定位', () => {
  const outline = Array.from({ length: 9 }, (_, index) => ({ key: `chapter-${index}`, title: `章节${index}` }))
  const coverage = coverageFromReport({ outline, sections: outline.slice(0, 2).map(node => ({ key: node.key, blocks: [{ text: '正文内容。' }] })),
    chapterOutcomes: outline.map((node, i) => ({ key: node.key, status: i < 2 ? 'draft_unverified' : 'needs_input', diagnostics: { reasonCode: 'no_prose' } })) })
  const summary = statusSummary(state({ contentCoverage: coverage, reportReady: true, reportPath: '/tmp/report.md',
    jsonPath: '/tmp/report.json', reviewPath: '/tmp/review.md', review: { status: 'partial', passed: false, rawChecks: '不应展开' } }))
  assert.equal(summary.contentCoverage.proseChapters, 2); assert.equal(summary.contentCoverage.totalChapters, 9)
  assert.equal(summary.contentCoverage.needsInputChapters, 7); assert.equal(summary.contentCoverage.prosePercent, 22.2)
  assert.equal(summary.contentCoverage.chapterDiagnostics, undefined)
  assert.deepEqual(summary.review, { status: 'partial', passed: false }); assert.equal(summary.reportPath, '/tmp/report.md')
})

test('角色路由配置须包含provider和model，按角色独立解析，拒绝不完整及无效JSON', () => {
  const config = { writingRoute: { provider: 'writer-provider', model: 'writer-model' },
    presentationRoute: '{"provider":"slides-provider","model":"slides-model"}' }
  assert.deepEqual(roleRoute(config, 'writing'), { provider: 'writer-provider', model: 'writer-model' })
  assert.deepEqual(roleRoute(config, 'presentation'), { provider: 'slides-provider', model: 'slides-model' })
  assert.throws(() => roleRoute({ writingRoute: { model: 'orphan-model' } }, 'writing'), /同时配置provider和model/u)
  assert.throws(() => roleRoute({ writingRoute: { provider: 'x', model: ' ' } }, 'writing'), /同时配置provider和model/u)
  assert.throws(() => roleRoute({ writingRoute: '{invalid}' }, 'writing'), /provider\/model对象/u)
})

test('角色执行只投影模型选择，不改真实agent、session、用户身份和工作区', () => {
  const originalHeader = { config: { provider: 'chat-provider', model: 'chat-model', reasoningEffort: 'high' } }
  const session = { id: 'session-a', user: { id: 'user-a' }, header: { cwd: '/tmp/workspace-a' }, requestHeader: () => originalHeader }
  const agent = { id: 'agent-a', options: { provider: 'old-provider', model: 'old-model', reasoningEffort: 'high', unrelatedOption: true }, session }
  const exec = { agent, signal: new AbortController().signal, otherContext: { keep: true } }
  const projected = roleExecution(exec, { provider: 'fast-provider', model: 'fast-model' })
  assert.notEqual(projected, exec); assert.notEqual(projected.agent, agent)
  assert.notEqual(projected.agent.session, session)
  assert.equal(projected.agent.id, agent.id); assert.equal(projected.agent.session.id, session.id)
  assert.equal(projected.agent.session.user, session.user); assert.equal(projected.agent.session.header, session.header)
  assert.equal(projected.signal, exec.signal); assert.equal(projected.otherContext, exec.otherContext)
  assert.deepEqual(resolveModelSelection(projected.agent), { provider: 'fast-provider', model: 'fast-model', selectionSource: 'session-header' })
  assert.equal(agent.session, session); assert.equal(session.requestHeader(), originalHeader)
  assert.equal(agent.options.provider, 'old-provider'); assert.equal(agent.options.model, 'old-model')
  assert.equal(roleExecution(exec), exec)
})

test('显式写作/演示角色优先于会话强模型，模型能力查询也走该角色且不会改会话配置', async () => {
  const calls = [], signal = new AbortController().signal
  const agent = { options: { provider: 'chat-provider', model: 'chat-model', reasoningEffort: 'high' },
    session: { requestHeader: () => ({ config: { provider: 'chat-provider', model: 'chat-model', reasoningEffort: 'high' } }) } }
  const llm = { resolveModelInfo: async (...args) => { calls.push(args); return { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] }, defaultMaxTokens: 16384 } } }
  for (const role of [{ provider: 'write-provider', model: 'write-model' }, { provider: 'slides-provider', model: 'slides-model' }]) {
    const selection = await resolveWritingModel(llm, agent, signal, role)
    assert.equal(selection.provider, role.provider); assert.equal(selection.model, role.model)
    assert.equal(selection.selectionSource, 'plugin-role'); assert.equal(selection.reasoningEffort, 'low')
    assert.equal(selection.defaultMaxTokens, 16384)
  }
  assert.deepEqual(calls.map(([provider, model, passedSignal]) => [provider, model, passedSignal === signal]),
    [['write-provider', 'write-model', true], ['slides-provider', 'slides-model', true]])
  assert.equal(agent.options.model, 'chat-model'); assert.equal(agent.session.requestHeader().config.reasoningEffort, 'high')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createTaskService } from '../src/tasks.js'
import { rootOf, runPath, sha256 } from '../src/store.js'
import { taskFixture, deferred, waitControlled, readRecord, updateRecord, finishFakeTask } from './task-helpers.mjs'

test('后台提交快速返回，接纳后工具 signal 终止不取消任务，状态落盘可查询', async t => {
  const f = await taskFixture(), gate = deferred(), started = deferred()
  let taskSignal
  const service = createTaskService({ ...f, execute: async options => {
    taskSignal = options.exec.signal
    started.resolve()
    await waitControlled(taskSignal, gate)
    return finishFakeTask(options)
  } })
  t.after(() => service.close())
  const result = await Promise.race([service.submit(f.args, f.exec), delay(1500).then(() => 'blocked')])
  assert.notEqual(result, 'blocked', 'submit must not wait for generation')
  assert.equal(result.status, 'queued')
  assert.ok(result.runId && result.jobId)
  await started.promise
  f.controller.abort(new Error('对话工具调用结束'))
  assert.equal(taskSignal.aborted, false)
  const input = await readRecord(path.join(runPath(f.agent, result.runId), 'run-input.json'))
  assert.equal(input.schemaVersion, 1)
  assert.equal(input.planSha256, f.args.plan_sha256)
  assert.equal(input.args.source_run_id, f.sourceRunId)
  assert.equal((await readdir(path.join(rootOf(f.agent), '.requests'))).filter(name => /^[0-9a-f]{64}\.json$/u.test(name)).length, 1)
  gate.resolve()
  await f.jobs.settled(result.jobId)
  const state = await service.query(result.runId, { ...f.exec, signal: new AbortController().signal })
  assert.equal(state.status, 'complete_draft')
  assert.equal(state.progress.completed, 1)
  const claim = await readRecord(path.join(rootOf(f.agent), '.claims', result.runId, 'claim.json'))
  assert.equal(claim.active, false)
})

test('宿主 jobs.kill 负责取消并执行会话权限检查，取消结果落盘', async t => {
  const f = await taskFixture(), started = deferred(), gate = deferred()
  const service = createTaskService({ ...f, execute: async options => {
    started.resolve()
    await waitControlled(options.exec.signal, gate)
    return finishFakeTask(options)
  } })
  t.after(() => service.close())
  const result = await service.submit(f.args, f.exec)
  await started.promise
  const other = { ...f.exec, agent: { ...f.agent, id: 'other-session', session: { ...f.agent.session, id: 'other-session' } } }
  await assert.rejects(service.cancel(result.runId, other), /无权/u)
  assert.equal(f.jobs.get(result.jobId, f.agent).status, 'running')
  f.jobs.kill(result.jobId, f.agent, '用户取消')
  assert.equal((await f.jobs.settled(result.jobId)).status, 'killed')
  const state = await service.query(result.runId, f.exec)
  assert.equal(state.status, 'cancelled')
  assert.match(state.error, /用户取消/u)
  assert.equal((await service.cancel(result.runId, f.exec)).cancellation, 'already-stopped')
})

test('同工作区两个 service 同时提交相同输入，持久去重只执行一次', async t => {
  const f = await taskFixture(), gate = deferred()
  let calls = 0
  const execute = async options => { calls++; await waitControlled(options.exec.signal, gate); return finishFakeTask(options) }
  const first = createTaskService({ ...f, execute }), second = createTaskService({ ...f, execute })
  t.after(async () => { await first.close(); await second.close() })
  const [left, right] = await Promise.all([first.submit(f.args, f.exec), second.submit(f.args, f.exec)])
  assert.equal(left.runId, right.runId)
  assert.equal([left, right].filter(result => result.reused === false).length, 1)
  assert.equal(calls, 1)
  assert.equal(f.jobs.records.size, 1)
  gate.resolve()
  await f.jobs.settled(left.jobId || right.jobId)
})

test('失败后 resume 复用同一 run 和检查点，保留已完成章节并标记中断请求', async t => {
  const f = await taskFixture()
  let calls = 0
  const service = createTaskService({ ...f, execute: async options => {
    calls++
    if (calls === 1) {
      await updateRecord(path.join(runPath(f.agent, options.runId), 'run.json'), {
        chapters: [{ key: 'policy-trends', status: 'completed' }, { key: 'scenarios', status: 'failed' }],
        modelRequests: [{ stage: 'write', status: 'pending' }],
      })
      throw new Error('模拟章节失败')
    }
    assert.equal(options.resume, true)
    assert.equal(options.prepared.state.chapters[0].status, 'completed')
    assert.equal(options.prepared.state.modelRequests[0].status, 'interrupted')
    return finishFakeTask(options)
  } })
  t.after(() => service.close())
  const first = await service.submit(f.args, f.exec)
  await f.jobs.settled(first.jobId)
  assert.equal((await service.query(first.runId, f.exec)).status, 'failed')
  const resumed = await service.submit({ mode: 'resume', run_id: first.runId }, f.exec)
  assert.equal(resumed.runId, first.runId)
  assert.notEqual(resumed.jobId, first.jobId)
  await f.jobs.settled(resumed.jobId)
  const state = await service.query(first.runId, f.exec)
  assert.equal(state.resumeCount, 1)
  assert.equal(state.status, 'complete_draft')
  assert.equal(calls, 2)
})

test('恢复拒绝改变的输入、规划 hash、规则或材料，不能误用旧章节', async t => {
  const f = await taskFixture()
  let calls = 0
  const service = createTaskService({ ...f, execute: async () => { calls++; throw new Error('停在检查点') } })
  t.after(() => service.close())
  const result = await service.submit(f.args, f.exec)
  await f.jobs.settled(result.jobId)
  const resume = { mode: 'resume', run_id: result.runId }
  const otherUser = { ...f.exec, agent: { ...f.agent, session: { ...f.agent.session, user: { id: 'other-user' } } } }
  await assert.rejects(service.submit(resume, otherUser), /不能接管/u)
  await assert.rejects(service.submit({ ...resume, audience: '另一个读者' }, f.exec), /确认大纲不一致/u)
  await assert.rejects(service.submit({ ...resume, plan_sha256: 'different-hash' }, f.exec), /版本不匹配/u)
  const inputFile = path.join(runPath(f.agent, result.runId), 'run-input.json')
  const saved = await readRecord(inputFile)
  await updateRecord(inputFile, { ruleFingerprint: 'old-rules' })
  await assert.rejects(service.submit(resume, f.exec), /规则已改变/u)
  await writeFile(inputFile, JSON.stringify(saved))
  await updateRecord(inputFile, { modelSelection: { ...saved.modelSelection, model: 'changed-model' } })
  await assert.rejects(service.submit(resume, f.exec), /模型快照/u)
  await writeFile(inputFile, JSON.stringify(saved))
  const changed = '产品新增了不同的事实，应重新确认材料。'
  await writeFile(f.materialFile, changed)
  const source = await readRecord(path.join(f.sourceDir, 'run.json'))
  source.files[0].contentSha256 = sha256(changed)
  await writeFile(path.join(f.sourceDir, 'run.json'), JSON.stringify(source))
  await assert.rejects(service.submit(resume, f.exec), /输入.*已改变/u)
  assert.equal(calls, 1)
})

test('关闭 service 等待取消落盘及释放运行 claim，之后拒绝接纳', async () => {
  const f = await taskFixture(), started = deferred(), gate = deferred()
  const service = createTaskService({ ...f, execute: async options => {
    started.resolve()
    await waitControlled(options.exec.signal, gate)
    return finishFakeTask(options)
  } })
  const result = await service.submit(f.args, f.exec)
  await started.promise
  await service.close()
  const state = await readRecord(path.join(runPath(f.agent, result.runId), 'run.json'))
  assert.equal(state.status, 'cancelled')
  assert.match(state.error, /插件停止/u)
  assert.equal(f.jobs.disposedCount, 1)
  assert.equal((await readRecord(path.join(rootOf(f.agent), '.claims', result.runId, 'claim.json'))).active, false)
  await assert.rejects(service.submit(f.args, f.exec), /正在停止/u)
})

test('query 只读检查点，死进程的进行中任务显示 interrupted 与章节进度', async t => {
  const f = await taskFixture()
  const service = createTaskService({ ...f, execute: async () => { throw new Error('query must not execute') } })
  t.after(() => service.close())
  const runId = randomUUID(), dir = runPath(f.agent, runId), file = path.join(dir, 'run.json')
  await mkdir(dir, { recursive: true })
  const state = { runId, kind: 'assembly-task', status: 'generating', worker: { host: f.hostname, pid: 2147483647 },
    chapters: [{ key: 'one', status: 'completed' }, { key: 'two', status: 'failed' }, { key: 'three', status: 'writing' }] }
  await writeFile(file, JSON.stringify(state))
  const before = await readFile(file, 'utf8')
  const result = await service.query(runId, f.exec)
  assert.equal(result.status, 'interrupted')
  assert.equal(result.storedStatus, 'generating')
  assert.equal(result.progress.completed, 1)
  assert.equal(result.progress.failed, 1)
  assert.equal(result.progress.pending, 1)
  assert.equal(await readFile(file, 'utf8'), before)
  assert.equal(f.jobs.records.size, 0)
})

test('完成后的默认 start 仍复用，只有显式 regenerate 新建版本', async t => {
  const f = await taskFixture()
  let calls = 0
  const service = createTaskService({ ...f, execute: async options => { calls++; return finishFakeTask(options) } })
  t.after(() => service.close())
  const first = await service.submit(f.args, f.exec)
  await f.jobs.settled(first.jobId)
  const repeated = await service.submit(f.args, f.exec)
  assert.equal(repeated.runId, first.runId)
  assert.equal(repeated.reused, true)
  assert.equal(calls, 1)
  const newVersion = await service.submit({ ...f.args, mode: 'regenerate' }, f.exec)
  assert.notEqual(newVersion.runId, first.runId)
  await f.jobs.settled(newVersion.jobId)
  assert.equal(calls, 2)
  await assert.rejects(service.submit({ mode: 'resume' }, f.exec), /run_id/u)
  await assert.rejects(service.submit({ ...f.args, mode: 'invalid' }, f.exec), /mode/u)
  await assert.rejects(service.submit({}, f.exec), /plan_id/u)
})

test('停止期间尚未完成的模型能力查询不能在 close 后接纳新任务', async () => {
  const f = await taskFixture(), resolving = deferred(), release = deferred()
  const llm = { resolveModelInfo: async () => { resolving.resolve(); return release.promise } }
  let calls = 0
  const service = createTaskService({ ...f, llm, execute: async options => { calls++; return finishFakeTask(options) } })
  const submit = service.submit(f.args, f.exec)
  await resolving.promise
  const closed = service.close()
  release.resolve({ reasoning: { efforts: [{ id: 'low' }] } })
  await assert.rejects(submit, /停止|取消/u)
  await closed
  assert.equal(calls, 0)
  assert.equal(f.jobs.records.size, 0)
})

test('宿主拒绝接纳时保存 failed 并释放 claim，不能执行未接纳任务', async t => {
  const f = await taskFixture()
  let calls = 0
  const jobs = { ...f.jobs, start() { throw new Error('宿主正在关闭') } }
  const service = createTaskService({ ...f, jobs, execute: async () => { calls++; return {} } })
  t.after(() => service.close())
  await assert.rejects(service.submit(f.args, f.exec), /宿主正在关闭/u)
  const pointers = (await readdir(path.join(rootOf(f.agent), '.requests'))).filter(name => /^[0-9a-f]{64}\.json$/u.test(name))
  assert.equal(pointers.length, 1)
  const pointer = await readRecord(path.join(rootOf(f.agent), '.requests', pointers[0]))
  const state = await service.query(pointer.runId, f.exec)
  assert.equal(state.status, 'failed')
  assert.match(state.error, /未接纳/u)
  assert.equal((await readRecord(path.join(rootOf(f.agent), '.claims', pointer.runId, 'claim.json'))).active, false)
  assert.equal(calls, 0)
})

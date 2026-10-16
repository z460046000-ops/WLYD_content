import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { createTaskService, materialFingerprint } from '../src/tasks.js'
import { confirmedPlan } from '../src/planning.js'
import { resolveWritingModel } from '../src/model.js'
import { atomicJson, reserveRun } from '../src/persistence.js'
import { rootOf, sourceEvidence, sha256, runPath } from '../src/store.js'
import { taskFixture, readRecord, finishFakeTask } from './task-helpers.mjs'

test('旧孤儿去重指针明确返回接纳失败，不能一直冒充排队', async t => {
  const f = await taskFixture()
  const confirmed = await confirmedPlan({ args: f.args, exec: f.exec })
  const source = await sourceEvidence(f.agent, confirmed.args)
  const selection = await resolveWritingModel(f.llm, f.agent)
  const key = sha256(JSON.stringify([confirmed.document.projectId, materialFingerprint(source), f.args.plan_sha256,
    confirmed.rules.fingerprint, selection.provider, selection.model, selection.reasoningEffort || '', f.args.quality_mode, f.agent.session.user.id, '']))
  const orphan = randomUUID()
  await reserveRun(rootOf(f.agent), key, orphan)
  const service = createTaskService({ ...f, execute: () => assert.fail('orphan must not execute') })
  t.after(() => service.close())
  const result = await service.submit(f.args, f.exec)
  assert.equal(result.runId, orphan)
  assert.equal(result.status, 'admission_failed')
  assert.match(result.nextAction, /regenerate/u)
})

test('去重指针发布之前已有可恢复输入和运行记录；竞争落败候选保留去重指向', async t => {
  const f = await taskFixture()
  const service = createTaskService({ ...f, execute: finishFakeTask })
  t.after(() => service.close())
  const first = await service.submit(f.args, f.exec)
  await f.jobs.settled(first.jobId)
  const second = await service.submit(f.args, f.exec)
  assert.equal(second.runId, first.runId)
  const all = await readdir(rootOf(f.agent))
  const rows = await Promise.all(all.filter(name => /^[0-9a-f-]{36}$/u.test(name)).map(async id => {
    return readRecord(path.join(runPath(f.agent, id), 'run.json'))
  }))
  const loser = rows.find(row => row.status === 'deduplicated')
  assert.equal(loser.deduplicatedTo, first.runId)
  assert.equal((await readRecord(path.join(runPath(f.agent, loser.runId), 'run-input.json'))).schemaVersion, 1)
})

test('取得claim后初始持久化失败也释放锁，允许原run恢复', async t => {
  const f = await taskFixture()
  let inputWrites = 0
  const service = createTaskService({ ...f, execute: finishFakeTask, persist: async (file, value) => {
    if (file.endsWith('/run-input.json') && ++inputWrites === 2) throw Object.assign(new Error('模拟磁盘写入失败'), { code: 'EIO' })
    return atomicJson(file, value)
  } })
  t.after(() => service.close())
  await assert.rejects(service.submit(f.args, f.exec), /磁盘写入失败/u)
  assert.equal(f.jobs.records.size, 0)
  const keys = await readdir(path.join(rootOf(f.agent), '.claims'))
  assert.equal(keys.length, 1)
  const runId = keys[0]
  const claim = await readRecord(path.join(rootOf(f.agent), '.claims', runId, 'claim.json'))
  assert.equal(claim.active, false)
  assert.equal((await service.query(runId, f.exec)).status, 'failed')
  const resumed = await service.submit({ mode: 'resume', run_id: runId }, f.exec)
  await f.jobs.settled(resumed.jobId)
  assert.equal((await service.query(runId, f.exec)).status, 'complete_draft')
})

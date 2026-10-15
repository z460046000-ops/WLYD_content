import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { claimRun, readJson, reserveRun } from '../src/persistence.js'

test('并发发布去重索引时只得到一个完整指针', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wlyd-pointer-'))
  const ids = await Promise.all(Array.from({ length: 6 }, () => reserveRun(root, 'same-input', randomUUID())))
  assert.equal(new Set(ids).size, 1)
  assert.equal((await readJson(path.join(root, '.requests/same-input.json'))).runId, ids[0])
})

test('锁完整发布、失活后并发恢复仅一个所有者，旧记录保留', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wlyd-claim-')), id = randomUUID()
  const first = await claimRun(root, id, id)
  await first.release()
  const attempts = await Promise.all(Array.from({ length: 4 }, () => claimRun(root, id, id, { resume: true })))
  const winners = attempts.filter(row => row.record)
  assert.equal(winners.length, 1)
  const current = await readJson(path.join(root, '.claims', id, 'claim.json'))
  assert.equal(current.token, winners[0].record.token)
  assert.equal(current.active, true)
  assert.equal((await readJson(path.join(root, '.claims', `${id}.history-${first.record.token}`, 'claim.json'))).active, false)
  await winners[0].release()
})

test('完整锁目录发布可接管历史空目录，不留下无法恢复的空锁', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wlyd-empty-claim-')), id = randomUUID()
  await mkdir(path.join(root, '.claims', id), { recursive: true })
  const claim = await claimRun(root, id, id, { resume: true })
  assert.ok(claim.record.token)
  assert.equal((await readJson(path.join(root, '.claims', id, 'claim.json'))).token, claim.record.token)
  await claim.release()
})

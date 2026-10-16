import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createTaskService } from '../src/tasks.js'
import { createDeliveryService } from '../src/delivery/tasks.js'
import { taskFixture, readRecord } from './task-helpers.mjs'
import { completeAudit } from './helpers.mjs'

test('确认规划→真实组稿落盘→先MD/DOCX→独立模型提炼→上游引擎HTML整链打通', async t => {
  const f = await taskFixture({ quality_mode: 'draft', outline: [{ key: 'scene', title: '场景方案', roleId: 'scenario-solution' }] })
  f.jobs.attachController = () => () => {}
  const prompts = []
  const llm = { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }] } }),
    async *stream(request) {
      const prompt = JSON.parse(request.messages[0].content[0].text); prompts.push(prompt)
      let value
      if (prompt.stage === 'write') value = { facts: [{ id: 'claim', text: '统一记录线索状态。', subject: 'product', purpose: 'capability',
        supportMode: 'sourced', sourceCardIds: [prompt.facts[0].id] }], sections: [{ key: 'scene', blocks: [{
          text: '建议销售和客服通过统一记录核对交接，具体范围待确认。', supportMode: 'candidate', factIds: ['claim'], planRefs: {} }] }] }
      else if (prompt.stage === 'consistency-review') value = completeAudit()
      else if (prompt.stage === 'presentation') value = { slides: prompt.units.map(unit => ({ unitIds: [unit.id] })) }
      else assert.fail(`unexpected stage ${prompt.stage}`)
      yield { type: 'text-delta', text: JSON.stringify(value) }; yield { type: 'finish', reason: { kind: 'stop' } }
    } }
  const delivery = createDeliveryService({ ...f, llm })
  const tasks = createTaskService({ ...f, llm, afterComplete: (runId, exec) => delivery.submit({ run_id: runId }, exec) })
  t.after(async () => { await tasks.close(); await delivery.close() })
  const submitted = await tasks.submit(f.args, f.exec), finished = await f.jobs.settled(submitted.jobId)
  assert.equal(finished.status, 'completed')
  const result = JSON.parse(finished.output)
  assert.equal(result.delivery.documentsReady, true)
  assert.ok(result.delivery.jobId)
  assert.match(await readFile(result.delivery.markdownPath, 'utf8'), /正文覆盖：1\/1/u)
  assert.equal((await readFile(result.delivery.docxPath)).subarray(0, 2).toString(), 'PK')
  const original = await readFile(result.jsonPath, 'utf8')
  assert.equal((await f.jobs.settled(result.delivery.jobId)).status, 'completed')
  const output = await delivery.query(result.runId, f.exec)
  assert.equal(output.htmlReady, true); assert.equal(output.stale, false)
  const html = await readFile(output.htmlPath, 'utf8')
  assert.match(html, /MS\.deck\(/u); assert.match(html, /presentation-prev/u)
  assert.match(html, /待用户确认/u)
  assert.match(html, /6f7b4927bf4be7f057e58269febf52200bb1f01f/u)
  assert.equal(await readFile(result.jsonPath, 'utf8'), original)
  assert.ok(prompts.some(prompt => prompt.stage === 'presentation'))
  assert.ok(!prompts.some(prompt => prompt.stage === 'extract'))
  assert.equal((await readRecord(result.jsonPath)).contentCoverage.proseChapters, 1)
})

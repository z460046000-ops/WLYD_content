import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { buildPresentation } from '../src/outputs/html-slides/plan.js'
import { renderPresentation } from '../src/outputs/html-slides/render.js'
import { validatePresentation, validatePresentationHtml } from '../src/outputs/html-slides/validate.js'

function snapshot() {
  return { schemaVersion: 1, runId: 'test-run', title: '客户协同解决方案', sourceContentSha256: 'a'.repeat(64),
    assemblyReview: { status: 'pending', passed: false }, coverage: { proseChapters: 1, totalChapters: 2 },
    sections: [{ key: 'solution', title: '统一协同与交接', roleId: 'scenarios', status: 'draft_unverified', version: 2, approvalStatus: 'pending',
      blocks: [{ id: 'solution-1', text: '建议以统一记录支撑业务交接。在客户授权并配置第三方接口后，可试点自动同步。',
        supportMode: 'candidate', verification: 'unverified', capabilityStatus: 'pilot', capabilityOwnership: 'third-party',
        evidence: [{ id: 'e-1', quote: '在客户授权并配置第三方接口后，可试点自动同步。' }],
        planRefs: { capabilityIds: ['cap-1'], problemIds: ['problem-1'], scenarioIds: ['scenario-1'] } }] },
    { key: 'company', title: '企业与合作案例', version: 1, status: 'needs_input', approvalStatus: 'pending', blocks: [],
      inputNeeded: { reason: '未找到可核验的客户合作案例', questions: ['请补充已获授权的客户案例'] } }] }
}

test('无模型仍可独立交付原文分页；保留材料卡、版本、来源、关联与审核身份', async () => {
  const source = snapshot(), before = structuredClone(source)
  const plan = await buildPresentation({ snapshot: source })
  assert.deepEqual(source, before)
  assert.equal(plan.sourceContentSha256, source.sourceContentSha256)
  assert.equal(plan.sourceVersions[0].version, 2)
  assert.equal(plan.slides[0].mode, 'source-pagination')
  assert.equal(plan.slides[0].title, source.sections[0].title, '原文分页用章节标题，不把短句当作演示标题')
  assert.deepEqual(plan.slides[0].sourceBlockIds, ['solution-1'])
  assert.deepEqual(plan.slides[0].planRefs.problemIds, ['problem-1'])
  for (const label of ['待用户确认', '候选方案', '来源待核验', '试点中', '第三方能力']) assert.ok(plan.slides[0].boundaries.includes(label))
  assert.equal(plan.slides.at(-1).kind, 'material-card')
  assert.match(plan.warnings[0], /未完成模型精简/u)
  assert.deepEqual(validatePresentation(plan, source), [])
  assert.ok(plan.skill.commit)
  assert.match(plan.skill.hash, /^[a-f\d]{64}$/u)
})

test('模型只选择原文句段；上游幻灯片与审美规则实际投影到独立提示词', async () => {
  const calls = []
  const plan = await buildPresentation({ snapshot: snapshot(), request: async prompt => {
    calls.push(prompt)
    return { slides: prompt.units.map(unit => ({ unitIds: [unit.id] })) }
  } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].stage, 'presentation')
  assert.equal(calls[0].qualityMode, 'draft')
  assert.match(calls[0].task, /给客户展示/u)
  assert.match(calls[0].task, /按章节提取内容关键信息、精简句式，再交给 xiaoma-studio/u)
  assert.ok(calls[0].skill.guidance.some(item => item.path.endsWith('slides.md') && item.text.includes('一页一个结论')))
  assert.ok(calls[0].skill.guidance.some(item => item.path.endsWith('aesthetics.md') && item.text.includes('编辑部')))
  assert.ok(calls[0].protectedUnitIds.length)
  assert.equal(plan.warnings.length, 0)
  assert.equal(plan.slides[0].mode, 'extractive-selection')
  assert.equal(plan.slides[0].points[0].text, calls[0].units[0].text)
})

test('未知引用、额外事实、丢条件或异常均退回真实原文，不把模型失败当成功精简', async () => {
  for (const response of [() => ({ slides: [{ unitIds: ['unknown'] }] }),
    prompt => ({ slides: [{ unitIds: [prompt.units[0].id], title: '效率提升80%' }] }),
    prompt => ({ slides: [{ unitIds: [prompt.units[0].id] }] }),
    () => { throw new Error('演示模型超时') }]) {
    const source = snapshot(), plan = await buildPresentation({ snapshot: source, request: response })
    assert.equal(plan.slides[0].mode, 'source-pagination')
    assert.equal(plan.warnings.length, 1)
    const combined = plan.slides.flatMap(slide => slide.points || []).map(point => point.text).join('')
    assert.equal(combined, source.sections[0].blocks[0].text)
    assert.equal(combined.includes('80%'), false)
  }
})

test('有效句段页内逆序或跨页交叉时恢复整体原文顺序，并重新按页容量分页', async () => {
  for (const order of [[2, 1, 0, 5, 4, 3], [0, 3, 5, 1, 2, 4], [0, 1, 2, 3, 4, 5]]) {
    const source = snapshot()
    source.sections = [source.sections[0]]
    source.sections[0].blocks[0].text = Array.from({ length: 6 }, (_, index) => `第${index + 1}项${'甲'.repeat(120)}。`).join('')
    let calls = 0
    const plan = await buildPresentation({ snapshot: source, request: async ({ units }) => {
      calls++
      const ids = order.map(index => units[index].id)
      return { slides: [{ unitIds: ids.slice(0, 3) }, { unitIds: ids.slice(3) }] }
    } })
    assert.equal(calls, 1, '程序排序与分页不得增加模型调用')
    assert.deepEqual(plan.warnings, [])
    assert.ok(plan.slides.every(slide => slide.mode === 'extractive-selection'))
    assert.ok(plan.slides.every(slide => slide.points.length <= 3 && slide.points.reduce((sum, point) => sum + [...point.text].length, 0) <= 300))
    assert.equal(plan.slides.flatMap(slide => slide.points).map(point => point.text).join(''), source.sections[0].blocks[0].text)
    assert.deepEqual(validatePresentation(plan, source), [])
  }
})

test('顺序容错不接受未知或重复ID，也不接受丢失条件或整段来源', async () => {
  for (const response of [
    ({ units }) => ({ slides: [{ unitIds: [units[0].id, 'unknown'] }] }),
    ({ units }) => ({ slides: [{ unitIds: [units[0].id, units[0].id] }] }),
    ({ units }) => ({ slides: [{ unitIds: [units[0].id, units[2].id] }] }),
    ({ units }) => ({ slides: [{ unitIds: [units[1].id, units[0].id] }] }),
  ]) {
    const source = snapshot()
    source.sections = [source.sections[0]]
    source.sections[0].blocks = [
      { id: 'b1', text: '统一业务入口。在客户授权后可试点同步。', planRefs: {} },
      { id: 'b2', text: '销售和服务共享业务信息。', planRefs: {} },
    ]
    const plan = await buildPresentation({ snapshot: source, request: response })
    assert.equal(plan.slides[0].mode, 'source-pagination')
    assert.equal(plan.warnings.length, 1)
    assert.equal(plan.slides[0].title, source.sections[0].title)
    assert.deepEqual(validatePresentation(plan, source), [])
  }
})

test('长正文逐批有界；确定性退路不丢尾部，长条件句以续页保留', async () => {
  const source = snapshot()
  source.sections = [source.sections[0]]
  source.sections[0].blocks[0].text = `${'在客户授权后可试点统一记录。'.repeat(600)}${'需同时满足条件'.repeat(100)}最终尾部标记`
  const calls = []
  const plan = await buildPresentation({ snapshot: source, request: async prompt => {
    calls.push(prompt)
    throw new Error('模拟失败')
  } })
  assert.ok(calls.length > 1)
  assert.ok(calls.every(prompt => prompt.units.reduce((sum, unit) => sum + unit.text.length, 0) <= 6000))
  assert.ok(plan.slides.some(slide => slide.continuation))
  assert.equal(plan.slides.flatMap(slide => slide.points).map(point => point.text).join(''), source.sections[0].blocks[0].text)
  assert.deepEqual(validatePresentation(plan, source), [])
})

test('输出校验拒绝指纹、引用、文案、能力状态及主线篡改', async () => {
  const source = snapshot(), plan = await buildPresentation({ snapshot: source })
  for (const mutate of [copy => { copy.sourceContentSha256 = 'wrong' },
    copy => { copy.slides[0].points[0].text = '效率提升80%' },
    copy => { copy.slides[0].boundaries = [] },
    copy => { copy.slides[0].planRefs = {} },
    copy => { copy.sources[0].text = '改写原文' },
    copy => { copy.sources[0].evidence = [{ id: 'fake', quote: '伪造来源' }] },
    copy => { copy.sources[0].approvalStatus = 'approved' },
    copy => { copy.sourceVersions[0].approvalStatus = 'approved' },
    copy => { copy.assemblyReview = { status: 'completed', passed: true } }]) {
    const copy = structuredClone(plan); mutate(copy)
    assert.ok(validatePresentation(copy, source).length)
  }
})

test('缓存页不能删否定、丢条件或提升复核状态；显式conditions/limitations原样保留', async () => {
  const source = snapshot()
  source.sections[0].blocks[0].text = '不可宣称已经全面交付。只有在客户授权后才可试点。'
  source.sections[0].blocks[0].conditions = '需要客户授权'
  source.sections[0].blocks[0].limitations = ['第三方接口是否可用待确认']
  const plan = await buildPresentation({ snapshot: source })
  assert.deepEqual(plan.sources[0].conditions, ['需要客户授权', '第三方接口是否可用待确认'])
  assert.deepEqual(plan.slides[0].sourceConditions, plan.sources[0].conditions)
  for (const mutate of [copy => { copy.slides[0].points[0].text = '可宣称已经全面交付。' },
    copy => { copy.slides[0].points.pop() },
    copy => { copy.slides[0].sourceConditions = [] },
    copy => { copy.sources[0].conditions = [] }]) {
    const copy = structuredClone(plan); mutate(copy)
    assert.ok(validatePresentation(copy, source).length)
  }
})

test('HTML真实内嵌上游引擎、离线可用；用户内容转义，不能注入脚本', async () => {
  const source = snapshot()
  source.title = '</script><script>evil()</script>'
  source.sections[0].title = '<img src=x onerror=evil()>'
  source.sections[0].blocks[0].text = '候选原文<script>evil()</script>，未通过核验。'
  const plan = await buildPresentation({ snapshot: source }), html = await renderPresentation(plan, { theme: '" onload="evil()' })
  assert.deepEqual(validatePresentationHtml(html), [])
  assert.ok(html.includes('class="theme-editorial"'))
  assert.ok(html.includes('&lt;script&gt;evil()&lt;/script&gt;'))
  assert.equal(html.includes('<script>evil()</script>'), false)
  assert.ok(html.includes('工作稿 · 待用户确认与复核'))
  const runtime = await readFile(new URL('../vendor/xiaoma-studio/engine/runtime.js', import.meta.url), 'utf8')
  const deck = await readFile(new URL('../vendor/xiaoma-studio/engine/deck.js', import.meta.url), 'utf8')
  assert.ok(html.includes(runtime))
  assert.ok(html.includes(deck))
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map(match => match[1])
  assert.equal(scripts.length, 3)
  for (const script of scripts) assert.doesNotThrow(() => new vm.Script(script))
})

test('取消不降级成成功输出', async () => {
  const abort = new AbortController(); abort.abort(new Error('用户取消'))
  await assert.rejects(buildPresentation({ snapshot: snapshot(), signal: abort.signal }), /用户取消/u)
})

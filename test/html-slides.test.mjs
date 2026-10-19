import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { buildPresentation } from '../src/outputs/html-slides/plan.js'
import { renderPresentation } from '../src/outputs/html-slides/render.js'
import { presentationUnits, validatePresentation, validatePresentationHtml } from '../src/outputs/html-slides/validate.js'

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

const response = prompt => ({ slides: [{ title: '统一记录支撑协同', points: [
  { text: '统一记录支撑业务交接', sourceBlockIds: [prompt.units[0].sourceBlockId] }
] }] })

test('无模型保留完整原文分页、来源、关联和明确降级；原稿不变', async () => {
  const source = snapshot(), before = structuredClone(source), plan = await buildPresentation({ snapshot: source })
  assert.deepEqual(source, before)
  assert.equal(plan.schema, 2)
  assert.equal(plan.sourceContentSha256, source.sourceContentSha256)
  assert.equal(plan.sourceVersions[0].version, 2)
  assert.equal(plan.slides[0].mode, 'source-pagination')
  assert.equal(plan.slides[0].title, source.sections[0].title)
  assert.deepEqual(plan.slides[0].planRefs.problemIds, ['problem-1'])
  for (const label of ['待用户确认', '候选方案', '来源待核验', '试点中', '第三方能力']) assert.ok(plan.slides[0].boundaries.includes(label))
  assert.ok(plan.slides[0].caveats.some(text => text.includes('客户授权')))
  assert.equal(plan.slides.at(-1).kind, 'material-card')
  assert.match(plan.warnings[0], /未完成概括/u)
  assert.deepEqual(validatePresentation(plan, source), [])
  assert.match(plan.skill.hash, /^[a-f\d]{64}$/u)
})

test('真正概括短要点，可合并来源和省略冗余段落；不增加模型审核轮次', async () => {
  const source = snapshot(), block = source.sections[0].blocks[0]
  block.text += '统一入口便于销售和服务核对同一记录，减少多工具间的信息重复传递。'.repeat(8)
  source.sections[0].blocks.push({ id: 'redundant', text: '本段重复说明统一记录与交接方式。', planRefs: {} })
  const calls = []
  const plan = await buildPresentation({ snapshot: source, request: async prompt => { calls.push(prompt); return response(prompt) } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].stage, 'presentation'); assert.equal(calls[0].qualityMode, 'draft')
  assert.match(calls[0].task, /按章节提取内容关键信息、精简句式，再交给 xiaoma-studio/u)
  assert.ok(calls[0].budget.targetCharacters)
  assert.ok(calls[0].sourceHints.some(row => row.caveats.some(text => text.includes('客户授权'))))
  assert.equal(calls[0].protectedUnitIds, undefined)
  assert.ok(calls[0].skill.guidance.some(item => item.path.endsWith('slides.md') && item.text.includes('一页一个结论')))
  assert.ok(calls[0].skill.guidance.some(item => item.path.endsWith('aesthetics.md') && item.text.includes('编辑部')))
  assert.equal(plan.slides[0].mode, 'summary')
  assert.equal(plan.slides[0].points[0].text, '统一记录支撑业务交接')
  assert.ok(plan.summaryMetrics.outputCharacters < plan.summaryMetrics.inputCharacters * 0.4)
  assert.deepEqual(plan.summaryMetrics.omittedSourceBlockIds, [{ sectionKey: 'solution', id: 'redundant' }])
  assert.equal(plan.sources.length, 2, '未上屏段落仍存来源归档')
  assert.deepEqual(validatePresentation(plan, source), [])
})

test('两个原段可归并成一个短要点，来源与问题能力主线按所用原段继承', async () => {
  const source = snapshot()
  source.sections[0].blocks.push({ id: 'b2', text: '共享记录支撑客服交接。', planRefs: { capabilityIds: ['cap-2'], problemIds: ['problem-2'] } })
  const plan = await buildPresentation({ snapshot: source, request: async prompt => ({ slides: [{ title: '贯通业务交接',
    points: [{ text: '统一共享记录，协同销售与客服交接', sourceBlockIds: [...new Set(prompt.units.map(unit => unit.sourceBlockId))] }] }] }) })
  assert.equal(plan.slides[0].mode, 'summary')
  assert.deepEqual(plan.slides[0].sourceBlockIds, ['solution-1', 'b2'])
  assert.deepEqual(plan.slides[0].planRefs.capabilityIds, ['cap-1', 'cap-2'])
  assert.deepEqual(validatePresentation(plan, source), [])
})

test('未知来源、额外数字/名称、规划升级及模型异常只降级该批，不称概括成功', async () => {
  for (const change of [raw => { raw.slides[0].points[0].sourceBlockIds = ['unknown'] },
    raw => { raw.slides[0].points[0].text = '效率提升80%' },
    raw => { raw.slides[0].title = 'FakeCRM自动协同' },
    raw => { raw.slides[0].points[0].text = '已全面上线并大规模推广' },
    () => { throw new Error('演示模型超时') }]) {
    const source = snapshot(), plan = await buildPresentation({ snapshot: source, request: prompt => {
      const raw = response(prompt); change(raw); return raw
    } })
    assert.equal(plan.slides[0].mode, 'source-pagination')
    assert.equal(plan.summaryMetrics.summaryPages, 0)
    assert.equal(plan.warnings.length, 1)
    assert.equal(plan.slides.flatMap(slide => slide.points || []).map(point => point.text).join(''), source.sections[0].blocks[0].text)
    assert.deepEqual(validatePresentation(plan, source), [])
  }
})

test('取消逐段必选后，仍拒绝伪引用、重复来源和超长/重复要点', async () => {
  for (const change of [raw => { raw.slides[0].points[0].sourceBlockIds = ['solution-1', 'solution-1'] },
    raw => { raw.slides[0].points[0].text = '长'.repeat(91) },
    raw => { raw.slides[0].points.push(structuredClone(raw.slides[0].points[0])) }]) {
    const plan = await buildPresentation({ snapshot: snapshot(), request: prompt => { const raw = response(prompt); change(raw); return raw } })
    assert.equal(plan.slides[0].mode, 'source-pagination')
  }
})

test('长正文逐批有界，失败保留全部尾部；长句不产生一字标点卡', async () => {
  const source = snapshot(); source.sections = [source.sections[0]]
  source.sections[0].blocks[0].text = '在客户授权后可试点统一记录。'.repeat(600) + '需同时满足条件'.repeat(100) + '最终尾部标记'
  const calls = []
  const plan = await buildPresentation({ snapshot: source, request: prompt => { calls.push(prompt); throw new Error('模拟失败') } })
  assert.ok(calls.length > 1)
  assert.ok(calls.every(prompt => prompt.units.reduce((sum, unit) => sum + unit.text.length, 0) <= 6000))
  assert.ok(plan.slides.some(slide => slide.continuation))
  assert.equal(plan.slides.flatMap(slide => slide.points).map(point => point.text).join(''), source.sections[0].blocks[0].text)
  assert.deepEqual(validatePresentation(plan, source), [])
  const balanced = presentationUnits(source.sections[0], { id: 'p', text: '甲'.repeat(180) + '。' }, 0)
  assert.ok(balanced.every(unit => [...unit.text].length > 1))
})

test('新旧缓存与篡改校验：来源、条件、版本、审核身份不能被摘要改写', async () => {
  const source = snapshot(), plan = await buildPresentation({ snapshot: source, request: response })
  for (const mutate of [copy => { copy.schema = 1 }, copy => { copy.sourceContentSha256 = 'wrong' },
    copy => { copy.slides[0].points[0].text = '效率提升80%' }, copy => { copy.slides[0].caveats = [] },
    copy => { copy.slides[0].boundaries = [] }, copy => { copy.slides[0].planRefs = {} },
    copy => { copy.sources[0].text = '改写原文' }, copy => { copy.sources[0].evidence = [{ id: 'fake', quote: '伪造来源' }] },
    copy => { copy.sourceVersions[0].approvalStatus = 'approved' }, copy => { copy.assemblyReview = { status: 'completed', passed: true } },
    copy => { copy.batches[0].sourceUnitIds.pop() }, copy => { copy.slides[0].points = [null] }, copy => { copy.sources = [null] }]) {
    const copy = structuredClone(plan); mutate(copy); assert.ok(validatePresentation(copy, source).length)
  }
})

test('必要否定、显式授权条件不可在缓存中删掉；未选段无需逐段上屏', async () => {
  const source = snapshot()
  source.sections[0].blocks[0].text = '不支持自动发布。只有在客户授权后才可试点同步。'
  source.sections[0].blocks[0].conditions = '需要客户授权'
  source.sections[0].blocks[0].limitations = ['第三方接口是否可用待确认']
  const plan = await buildPresentation({ snapshot: source, request: prompt => ({ slides: [{ title: '受控同步',
    points: [{ text: '按授权开展同步试点', sourceBlockIds: [prompt.units[0].sourceBlockId] }] }] }) })
  assert.equal(plan.slides[0].mode, 'summary')
  assert.ok(plan.slides[0].caveats.some(text => text.includes('不支持自动发布')))
  assert.deepEqual(plan.slides[0].sourceConditions, ['需要客户授权', '第三方接口是否可用待确认'])
  for (const mutate of [copy => { copy.slides[0].caveats.pop() }, copy => { copy.slides[0].sourceConditions = [] },
    copy => { copy.slides[0].points[0].text = '支持自动发布' }, copy => { copy.sources[0].conditions = [] }]) {
    const copy = structuredClone(plan); mutate(copy); assert.ok(validatePresentation(copy, source).length)
  }
})

test('HTML客户正文无机械审核/来源行，标题与单点不重复；来源面板保留完整记录', async () => {
  const source = snapshot(), plan = await buildPresentation({ snapshot: source, request: prompt => ({ slides: [{
    title: '协同业务交接', points: [{ text: '协同业务交接', sourceBlockIds: [prompt.units[0].sourceBlockId] }] }] }) })
  const html = await renderPresentation(plan), page = html.match(/<section class="slide[^]*?<\/section>/u)[0]
  assert.equal((page.match(/协同业务交接/gu) || []).length, 1)
  assert.doesNotMatch(page, /待用户确认|来源待核验|依据：|待确认内容/u)
  assert.match(page, /客户授权/u)
  assert.ok(html.includes('工作稿 · 待用户确认与复核'), '审核状态仅保留来源面板')
  assert.ok(html.includes('原文与来源'))
  assert.deepEqual(validatePresentationHtml(html), [])
})

test('机械历史标签不进入分页；原文引用与真实待确认条件仍保存', async () => {
  const source = snapshot(); source.sections[0].blocks[0].text = '待确认内容。\n典型场景假设：采用统一入口。第三方接口是否可用待确认。\n依据：[来源 1]、[来源 2]'
  const plan = await buildPresentation({ snapshot: source }), all = plan.slides.flatMap(slide => slide.points || []).map(point => point.text).join('')
  assert.doesNotMatch(all, /待确认内容|依据：/u)
  assert.match(all, /典型场景假设|第三方接口是否可用待确认/u)
  assert.equal(plan.sources[0].text, source.sections[0].blocks[0].text)
})

test('历史候选标签与isHypothesis在概括和原文退路中均保留自然限定', async () => {
  for (const block of [{ id: 'legacy', text: '【待确认内容】\n平台提供统一入口。' },
    { id: 'hypothesis', text: '平台提供统一入口。', isHypothesis: true }]) {
    const source = snapshot(); source.sections = [source.sections[0]]; source.sections[0].blocks = [block]
    for (const request of [undefined, prompt => ({ slides: [{ title: '统一入口', points: [{ text: '统一入口支撑协同', sourceBlockIds: [prompt.units[0].sourceBlockId] }] }] })]) {
      const plan = await buildPresentation({ snapshot: source, request })
      assert.equal(plan.sources[0].supportMode, 'candidate')
      assert.ok(plan.slides[0].caveats.some(value => /建议方案|假设/u.test(value)))
      assert.deepEqual(validatePresentation(plan, source), [])
    }
  }
})

test('HTML内嵌本地引擎且转义内容；降级也不执行模型HTML', async () => {
  const source = snapshot(); source.title = '</script><script>evil()</script>'
  source.sections[0].title = '<img src=x onerror=evil()>'
  source.sections[0].blocks[0].text = '候选原文<script>evil()</script>，未通过核验。'
  const plan = await buildPresentation({ snapshot: source }), html = await renderPresentation(plan, { theme: '\" onload=\"evil()' })
  assert.deepEqual(validatePresentationHtml(html), [])
  assert.ok(html.includes('class="theme-editorial"'))
  assert.ok(html.includes('&lt;script&gt;evil()&lt;/script&gt;'))
  assert.equal(html.includes('<script>evil()</script>'), false)
  for (const name of ['runtime.js', 'deck.js']) assert.ok(html.includes(await readFile(new URL(`../vendor/xiaoma-studio/engine/${name}`, import.meta.url), 'utf8')))
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map(match => match[1])
  assert.equal(scripts.length, 3)
  for (const script of scripts) assert.doesNotThrow(() => new vm.Script(script))
})

test('取消不降级成成功输出', async () => {
  const abort = new AbortController(); abort.abort(new Error('用户取消'))
  await assert.rejects(buildPresentation({ snapshot: snapshot(), signal: abort.signal }), /用户取消/u)
})

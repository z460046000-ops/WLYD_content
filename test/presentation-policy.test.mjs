import test from 'node:test'
import assert from 'node:assert/strict'
import { presentationCaveats, validateSummaryText } from '../src/outputs/html-slides/summary-policy.js'

test('概括可以改写，数字、百分比与英文名称需要来自绑定原文', () => {
  const sources = [{ text: '通过 Chat GPT 整理 3 类线索，完成率为20%，一次可处理1,000条记录。' }]
  assert.deepEqual(validateSummaryText('使用 chatgpt 汇总三类线索，完成率 20 %，处理1000条记录。', sources), [])
  assert.ok(validateSummaryText('完成率提升至80%。', sources).some(issue => issue.includes('数字')))
  assert.ok(validateSummaryText('通过 NewProduct 自动决策。', sources).some(issue => issue.includes('英文名称')))
  assert.ok(validateSummaryText('增长百分之八十。', sources).some(issue => issue.includes('数字')))
  assert.ok(validateSummaryText('完成率提高20个百分点。', sources).some(issue => issue.includes('数字')))
  assert.deepEqual(validateSummaryText('集中整理线索，减少重复录入。', [{ text: '统一维护销售线索，并让销售和客服查看同一条记录，以减少反复填报。' }]), [])
})

test('拦截明显的否定反转与规划、试点能力升级，保留限制的概括可用', () => {
  const negative = [{ text: '当前不支持自动发布，产品尚未上线。' }]
  assert.ok(validateSummaryText('支持自动发布。', negative).some(issue => issue.includes('否定')))
  assert.ok(validateSummaryText('产品已全面上线。', negative).some(issue => issue.includes('提升')))
  assert.deepEqual(validateSummaryText('当前不支持自动发布，仍待上线。', negative), [])
  assert.ok(validateSummaryText('功能已正式上线。', [{ text: '统一能力入口', capabilityStatus: 'planned' }]).length)
  assert.ok(validateSummaryText('方案已全面推广。', [{ text: '在单部门试点验证协同流程。', capabilityStatus: 'pilot' }]).length)
  assert.deepEqual(validateSummaryText('规划统一能力入口。', [{ text: '规划逐步建设统一的能力入口。', capabilityStatus: 'planned' }]), [])
  assert.deepEqual(validateSummaryText('既有平台已正式上线。', [{ text: '既有平台已正式上线，新增模块仍在规划中。' }]), [], '已存在能力不能因同段其他规划被误判')
})

test('限定保留授权、试点与否定原文，不把普通例如、需要句或泛审核当保护条件', () => {
  const source = { text: '例如可统一查看线索。需要统一管理客户记录。需客户授权后试点。不支持自动发布。',
    conditions: ['需客户授权后试点'], capabilityStatus: 'pilot', boundaries: ['待用户确认', '来源待核验'], approvalStatus: 'pending' }
  const caveats = presentationCaveats(source)
  assert.ok(caveats.includes('需客户授权后试点'))
  assert.ok(caveats.some(value => value.includes('不支持自动发布')))
  assert.equal(caveats.filter(value => value.includes('需客户授权后试点')).length, 1, '正文和结构化条件应去重')
  assert.ok(caveats.every(value => !/例如|需要统一管理|待用户确认|来源待核验/u.test(value)))
  assert.deepEqual(presentationCaveats({ text: '例如可共享资料。需要统一管理客户记录。' }), [])
  const condition = `仅在客户完成授权并确认以下事项后开放试点：${'全部参与部门需要按约定完成配置并保留核对记录，'.repeat(12)}必须完成最终核对。`
  assert.ok(presentationCaveats({ text: '方案提供统一协同入口。', conditions: [condition] }).includes(condition), '长条件保留完整原文')
})

test('结构化能力状态转成自然限定，未知能力给核实提示', () => {
  assert.ok(presentationCaveats({ text: '提供协同能力。', capabilityStatus: 'planned' }).some(value => value.includes('规划')))
  assert.ok(presentationCaveats({ text: '提供协同能力。', capabilityOwnership: 'third-party' }).some(value => value.includes('第三方')))
  assert.deepEqual(presentationCaveats({ text: '提供协同能力。', capabilityStatus: 'unknown' }), ['方案能力需核实'])
  assert.deepEqual(validateSummaryText('', [{ text: '原文' }]), ['概括文本为空'])
  assert.deepEqual(validateSummaryText('概括', []), ['概括文本缺少绑定来源'])
})

test('长背景按子句去除，授权前提与其试点动作一起保留', () => {
  const background = '平台汇总客户记录并方便业务人员持续查看协作信息'.repeat(10)
  const text = `${background}，在客户授权并配置第三方接口后，可试点自动同步，业务人员可查看处理结果；不支持自动发布。`
  const caveats = presentationCaveats({ text, capabilityStatus: 'pilot' })
  assert.deepEqual(caveats, ['在客户授权并配置第三方接口后，可试点自动同步', '不支持自动发布。'])
  assert.ok(caveats.every(value => text.includes(value)), '提取的限制仍可在原文连续定位')
  assert.deepEqual(presentationCaveats({ text: '开展业务规划，例如可查看共享资料，需要统一管理客户记录。' }), [])
  assert.deepEqual(presentationCaveats({ text: '共享业务记录，客户授权是必要前提，业务人员可查看进展。' }), ['客户授权是必要前提'])
})

test('拒绝绕过授权、审批和人工审核，允许保留条件的自然概括', () => {
  const sources = [{ text: '仅当客户授权时，平台才允许共享数据。' }]
  assert.ok(validateSummaryText('客户无需授权即可共享数据。', sources).some(issue => issue.includes('授权条件')))
  assert.ok(validateSummaryText('无需审批即可发布。', [{ text: '发布前需审批。' }]).some(issue => issue.includes('审批条件')))
  assert.ok(validateSummaryText('允许绕过人审直接发布。', [{ text: '发布前须人工审核。' }]).some(issue => issue.includes('人工审核条件')))
  assert.deepEqual(validateSummaryText('获得客户授权后，可以共享数据。', sources), [])
  assert.deepEqual(validateSummaryText('无需审批即可共享记录。', [{ text: '共享记录无需审批。' }]), [])
  assert.deepEqual(validateSummaryText('不得绕过人审直接发布。', [{ text: '发布前须人工审核。' }]), [])
})

test('拒绝完全无关的新能力，允许同一业务内容的概括改写并保留假设限定', () => {
  const sources = [{ text: '平台支持统一维护线索状态。' }]
  assert.ok(validateSummaryText('平台支持自动审批合同。', sources).some(issue => issue.includes('没有明显关联')))
  assert.deepEqual(validateSummaryText('提供集中管理线索状态的能力。', sources), [])
  const caveats = presentationCaveats({ text: '建议以统一记录改善业务交接。', isHypothesis: true,
    supportMode: 'candidate', verification: 'unverified' })
  assert.ok(caveats.some(value => /假设|建议/u.test(value)))
  assert.ok(caveats.some(value => value.includes('需核实')))
  assert.ok(caveats.every(value => !value.includes('待用户确认')))
  assert.ok(validateSummaryText('方案已全面上线。', [{ text: '建议采用统一记录。', isHypothesis: true }]).some(issue => issue.includes('提升')))
})

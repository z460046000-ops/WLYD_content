import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFile } from 'node:fs/promises'
import JSZip from 'jszip'
import mammoth from 'mammoth'
import { documentView, renderMarkdown } from '../src/outputs/markdown.js'
import { renderDocx } from '../src/outputs/docx.js'
import { renderOutput } from '../src/outputs/registry.js'
import { cleanDisplayText, displayBlockText, displayIdentity } from '../src/outputs/display.js'

/** Synthetic content only; root can render this fixture without reading any customer material. */
export function documentOutputFixture({ long = false } = {}) {
  return { schemaVersion: 1, title: '示例客户解决方案', sourceContentSha256: 'a'.repeat(64),
    outline: [
      { key: 'analysis', title: '业务分析', roleId: 'business-challenges', children: [
        { key: 'challenge', title: '典型需求与边界', roleId: 'business-challenges' }
      ] },
      { key: 'solution', title: '场景解决方案', roleId: 'scenarios' },
      { key: 'case', title: '客户案例', roleId: 'customer-cases' }
    ],
    sections: [
      { key: 'solution', title: '场景解决方案', status: 'draft_unverified', version: 2, approvalStatus: 'pending', blocks: [{
        id: 's-1', text: '建议将问题归集到统一入口；是否符合客户流程仍待确认。', supportMode: 'candidate',
        verification: 'unverified', capabilityStatus: 'planned', capabilityOwnership: 'third-party',
        evidence: [{ id: 'K<&>1', quote: '规划功能依赖第三方接口，尚未上线。' }],
        planRefs: { painIds: ['pain-1'], capabilityIds: ['cap-1'] }, reviewItems: ['需要客户确认流程']
      }] },
      { key: 'analysis', title: '业务分析', status: 'completed', version: 1, approvalStatus: 'approved', blocks: [{
        id: 'a-1', text: '材料仅表明部分记录需要人工汇总，不代表所有客户均有该问题。', supportMode: 'sourced',
        evidence: [{ id: 'K2', quote: '部分记录仍由人工汇总。' }]
      }] },
      { key: 'case', title: '客户案例', status: 'needs_input', version: 1, approvalStatus: 'pending', blocks: [],
        inputNeeded: { reason: '未取得授权可用的客户案例。', questions: ['请补充案例客户与授权范围。'], nextAction: '补充材料后仅修改本章。' } },
      { key: 'challenge', title: '典型需求与边界', status: 'draft_unverified', version: 1, approvalStatus: 'pending', blocks: [{
        id: 'c-1', text: `${long ? '长段落仍须完整保留，分页不应截断内容。'.repeat(180) + '\n' : ''}特殊字符：A&B <接口> "中文" ✓。`,
        supportMode: 'candidate', evidence: [{ id: 'K2', quote: '部分记录仍由人工汇总。' }]
      }] }
    ], assemblyReview: { status: 'running', passed: false }, coverage: { bodyChapters: 3, totalChapters: 4 },
    sources: [{ id: 'K2', title: '示例资料', locator: '第 2 页' }]
  }
}

test('MD keeps complete prose and business boundaries while provenance and review records move to an appendix', () => {
  const snapshot = documentOutputFixture()
  const before = structuredClone(snapshot), markdown = renderMarkdown(snapshot)
  assert.deepEqual(snapshot, before)
  assert.match(markdown, /正文覆盖：3\/4 章；待补材料：1 章/u)
  assert.match(markdown, /关联复核尚未完成/u)
  assert.ok(markdown.indexOf('## 业务分析') < markdown.indexOf('### 典型需求与边界'))
  assert.ok(markdown.indexOf('### 典型需求与边界') < markdown.indexOf('## 场景解决方案'))
  assert.match(markdown, /用户已确认；章节版本 1/u)
  assert.match(markdown, /候选方案；未验证；能力状态：规划中；能力归属：第三方能力/u)
  for (const section of snapshot.sections) for (const block of section.blocks) assert.ok(markdown.includes(block.text))
  const [body, appendix] = markdown.split('## 来源与审核附录')
  assert.doesNotMatch(body, /依据：|\[来源\s*\d+\]|待确认内容|章节版本|正文覆盖|待用户确认|能力状态：|能力归属：/u)
  assert.match(body, /相关能力处于规划阶段；相关能力依赖第三方/u)
  assert.match(body, /是否符合客户流程仍待确认/u)
  assert.match(appendix, /段落 s-1（第 1 段）\n\n来源：来源 2/u)
  assert.match(appendix, /复核记录：需要客户确认流程/u)
  assert.match(markdown, /待补材料：?\*?\*?：?未取得授权可用的客户案例/u)
  assert.match(markdown, /请补充案例客户与授权范围/u)
  assert.match(markdown, /规划功能依赖第三方接口，尚未上线/u)
  assert.equal((markdown.match(/原始来源 ID：K2/gu) || []).length, 1)
  assert.match(markdown, /资料：示例资料/u)
})

test('DOCX is readable with Chinese and long paragraphs and matches visible Markdown content', async () => {
  const snapshot = documentOutputFixture({ long: true }), before = structuredClone(snapshot)
  const buffer = await renderDocx(snapshot)
  assert.ok(Buffer.isBuffer(buffer))
  assert.equal(buffer.subarray(0, 2).toString(), 'PK')
  assert.deepEqual(snapshot, before)
  const extracted = await mammoth.extractRawText({ buffer }), raw = extracted.value
  for (const section of snapshot.sections) for (const block of section.blocks) {
    assert.ok(raw.replace(/\s/gu, '').includes(block.text.replace(/\s/gu, '')), `missing ${block.id}`)
  }
  for (const phrase of ['正文覆盖：3/4 章', '待补材料：1 章', '关联复核尚未完成', '用户已确认', '待审初稿',
    '候选方案', '未验证', '规划中', '第三方能力', '未取得授权可用的客户案例。', '请补充案例客户与授权范围。',
    '来源与审核附录', '原始来源 ID：K<&>1', '规划功能依赖第三方接口，尚未上线。', '资料：示例资料', '位置：第 2 页']) {
    assert.ok(raw.includes(phrase), `missing ${phrase}`)
  }
  const [body, appendix] = raw.split('来源与审核附录')
  assert.doesNotMatch(body, /依据：|\[来源\s*\d+\]|待确认内容|章节版本|正文覆盖|待用户确认|能力状态：|能力归属：/u)
  assert.match(body, /相关能力处于规划阶段；相关能力依赖第三方/u)
  assert.match(appendix, /段落 s-1（第 1 段）/u)
  assert.match(appendix, /复核记录：需要客户确认流程/u)
  const zip = await JSZip.loadAsync(buffer)
  const xml = await zip.file('word/document.xml').async('string')
  const styles = await zip.file('word/styles.xml').async('string')
  const footer = await zip.file('word/footer1.xml').async('string')
  assert.match(xml, /w:pStyle w:val="Title"/u)
  assert.match(xml, /w:pStyle w:val="Heading1"/u)
  assert.match(xml, /w:pStyle w:val="Heading2"/u)
  assert.match(xml, /A&amp;B &lt;接口&gt;/u)
  assert.match(xml, /w:br/u)
  assert.match(xml, /w:pgSz w:w="11906" w:h="16838"/u)
  assert.match(xml, /w:pageBreakBefore/u)
  assert.match(styles, /w:eastAsia="Source Han Serif CN"/u)
  assert.match(styles, /w:eastAsia="Source Han Sans SC"/u)
  assert.match(styles, /w:lang w:val="zh-CN" w:eastAsia="zh-CN"/u)
  assert.match(styles, /w:color w:val="000000"/u)
  assert.match(footer, /PAGE/u)
  assert.match(footer, /NUMPAGES/u)
})

test('format registry routes document adapters and rejects unsupported formats', async () => {
  const snapshot = documentOutputFixture()
  const md = await renderOutput('md', snapshot)
  assert.equal(md.extension, 'md'); assert.equal(md.mimeType, 'text/markdown; charset=utf-8')
  assert.equal(md.content, renderMarkdown(snapshot))
  assert.equal((await renderOutput('markdown', snapshot)).content, md.content)
  const docx = await renderOutput('docx', snapshot)
  assert.equal(docx.extension, 'docx'); assert.ok(Buffer.isBuffer(docx.content))
  await assert.rejects(renderOutput('video', snapshot), /不支持的文档输出格式/u)
})

test('DOCX font families are configurable without changing manuscript text', async () => {
  const snapshot = documentOutputFixture()
  const output = await renderOutput('docx', snapshot, { fonts: { body: 'Noto Serif CJK SC', heading: 'Noto Sans CJK SC', latin: 'Liberation Sans' } })
  const zip = await JSZip.loadAsync(output.content), styles = await zip.file('word/styles.xml').async('string')
  assert.match(styles, /w:eastAsia="Noto Serif CJK SC"/u)
  assert.match(styles, /w:eastAsia="Noto Sans CJK SC"/u)
  assert.match(styles, /w:ascii="Liberation Sans"/u)
  const raw = (await mammoth.extractRawText({ buffer: output.content })).value
  assert.ok(raw.includes(snapshot.sections[0].blocks[0].text))
  await assert.rejects(renderDocx(snapshot, { fonts: { body: '\u0000invalid' } }), /有效字体名称/u)
})

test('invalid snapshots cannot silently omit chapters or sources', async () => {
  const snapshot = documentOutputFixture()
  assert.throws(() => documentView({ ...snapshot, schemaVersion: 2 }), /文案快照/u)
  assert.throws(() => documentView({ ...snapshot, sections: [...snapshot.sections, snapshot.sections[0]] }), /重复章节/u)
  assert.throws(() => documentView({ ...snapshot, sections: [...snapshot.sections, { key: 'outside', blocks: [] }] }), /目录外章节/u)
  const badRef = structuredClone(snapshot); badRef.sections[0].blocks[0].evidence = [{ quote: '无来源编号' }]
  assert.throws(() => renderMarkdown(badRef), /无效来源引用/u)
  const missingSection = structuredClone(snapshot); missingSection.sections = missingSection.sections.filter(section => section.key !== 'case')
  assert.match(renderMarkdown(missingSection), /客户案例\n\n尚未生成/u)
})

test('display cleanup removes only standalone scaffolding and keeps identities, conditions and ordinary references', () => {
  const source = ['【待确认内容】', '> **待确认内容**', '依据：[来源 1]、[来源2]',
    '【典型场景假设｜待确认内容】', '仅在客户授权后试点，不表示功能已上线，第三方接口仍待确认。',
    '依据合同约定执行，内容包含[来源1]字段。', '“待确认内容”是本次表单中的真实字段名称。'].join('\n')
  const cleaned = cleanDisplayText(source)
  assert.match(cleaned, /^【典型场景假设】/u)
  assert.ok(cleaned.includes('仅在客户授权后试点，不表示功能已上线，第三方接口仍待确认。'))
  assert.ok(cleaned.includes('依据合同约定执行，内容包含[来源1]字段。'))
  assert.ok(cleaned.includes('“待确认内容”是本次表单中的真实字段名称。'))
  assert.doesNotMatch(cleaned, /依据：|【待确认内容】|｜待确认内容/u)
  assert.equal(cleanDisplayText(cleaned), cleaned)
  assert.equal(cleanDisplayText(undefined), '')
  assert.equal(cleanDisplayText('【典型场景假设】'), '【典型场景假设】')
  assert.equal(cleanDisplayText('【典型场景假设｜待确认内容】若客户授权，可先试点。'), '【典型场景假设】若客户授权，可先试点。')
})

test('display qualifications retain candidate, planned, pilot and ownership boundaries without generic audit badges', () => {
  const planned = displayBlockText({ text: '平台接入业务数据。', supportMode: 'candidate', verification: 'unverified',
    capabilityStatus: 'planned', capabilityOwnership: 'third-party', conditions: ['仅在取得客户授权后使用。'],
    limitations: ['不支持跨主体共享。'] })
  assert.match(planned, /相关能力处于规划阶段；相关能力依赖第三方；相关内容尚需核验/u)
  assert.match(planned, /建议方案：平台接入业务数据。/u)
  assert.match(planned, /仅在取得客户授权后使用。\n不支持跨主体共享。/u)
  assert.doesNotMatch(planned, /待确认内容|能力状态：|能力归属：/u)
  const pilot = displayBlockText({ text: '共享数据用于业务协同。', capabilityStatus: 'pilot', capabilityOwnership: 'customer' })
  assert.match(pilot, /相关能力仍在试点；相关能力由客户现有系统提供/u)
  assert.ok(pilot.includes('共享数据用于业务协同。'))
  const hypothesis = displayBlockText({ text: '【典型场景假设｜待确认内容】\n若客户允许，可先验证一个业务场景。', supportMode: 'candidate' })
  assert.match(hypothesis, /^【典型场景假设】\n若客户允许/u)
  assert.doesNotMatch(hypothesis, /建议方案：/u)
  assert.match(displayBlockText({ text: '【待确认内容】建设统一入口。' }), /^建议方案：建设统一入口。/u)
  assert.match(displayBlockText({ text: '平台提供统一入口。\n未验证' }), /^相关内容尚需核验。\n平台提供统一入口。/u)
})

test('shared display identity retains legacy and structured qualifications before label cleanup', () => {
  for (const block of [
    { supportMode: 'candidate' }, { verification: 'candidate' }, { capabilityStatus: 'proposed' },
    { isHypothesis: true }, { text: '【待确认内容】\n平台提供统一入口。' },
    { text: '> **待确认内容**\r\n平台提供统一入口。' },
    { text: '【典型场景假设】平台提供统一入口。' }, { text: '典型场景假设：平台提供统一入口。' }
  ]) assert.deepEqual(displayIdentity(block), { candidate: true, unverified: false })
  for (const block of [{ verification: 'unverified' }, { text: '【未验证】\n平台提供统一入口。' },
    { text: '> **来源待核验**\n平台提供统一入口。' }]) {
    assert.deepEqual(displayIdentity(block), { candidate: false, unverified: true })
  }
  const block = { text: '【待确认内容】\n【未验证】\n平台提供统一入口。' }
  const before = structuredClone(block)
  assert.deepEqual(displayIdentity(block), { candidate: true, unverified: true })
  assert.deepEqual(block, before)
  assert.deepEqual(displayIdentity({ text: '接口是否可用仍待确认。本段解释典型场景假设字段。' }), { candidate: false, unverified: false })
  assert.deepEqual(displayIdentity(), { candidate: false, unverified: false })
})

test('legacy standalone labels disappear in MD and DOCX without changing source text or audit details', async () => {
  const snapshot = documentOutputFixture(), block = snapshot.sections[0].blocks[0]
  block.text = ['【待确认内容】', '【典型场景假设｜待确认内容】',
    '若客户授权且第三方接口可用，建议先开展试点；尚未形成正式产品能力。',
    '依据：[来源 1]、[来源 2]'].join('\n')
  block.reviewItems = [{ status: 'pending', reason: '需确认第三方接口授权' }]
  snapshot.assemblyReview = { status: 'completed', passed: false, issues: [{ reason: '缺客户确认' }] }
  const before = structuredClone(snapshot), markdown = renderMarkdown(snapshot)
  const raw = (await mammoth.extractRawText({ buffer: await renderDocx(snapshot) })).value
  for (const output of [markdown, raw]) {
    const [body, appendix] = output.split('来源与审核附录')
    assert.doesNotMatch(body, /待确认内容|依据：|\[来源\s*\d+\]/u)
    assert.match(body, /【典型场景假设】/u)
    assert.ok(body.includes('若客户授权且第三方接口可用，建议先开展试点；尚未形成正式产品能力。'))
    assert.match(appendix, /需确认第三方接口授权/u)
    assert.match(appendix, /缺客户确认/u)
    assert.match(appendix, /段落 s-1/u)
    assert.match(appendix, /原始来源 ID：K/u)
  }
  assert.deepEqual(snapshot, before)
})

// Reusable synthetic QA: DOCUMENT_OUTPUT_FIXTURE_DIR=/tmp/wlyd-docx-qa node --test test/document-outputs.test.mjs
test('optional synthetic sample for visual QA', { skip: !process.env.DOCUMENT_OUTPUT_FIXTURE_DIR }, async () => {
  const { mkdir } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const dir = process.env.DOCUMENT_OUTPUT_FIXTURE_DIR
  await mkdir(dir, { recursive: true })
  const snapshot = documentOutputFixture({ long: true })
  await writeFile(join(dir, 'synthetic-output.docx'), await renderDocx(snapshot))
  await writeFile(join(dir, 'synthetic-output.md'), renderMarkdown(snapshot))
  await writeFile(join(dir, 'synthetic-snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n')
})

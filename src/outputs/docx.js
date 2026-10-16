import { AlignmentType, Document, Footer, HeadingLevel, PageNumber, Packer, Paragraph, TextRun } from 'docx'
import { documentView } from './markdown.js'

const CHINESE_LANGUAGE = { value: 'zh-CN', eastAsia: 'zh-CN' }
const fontName = (value, fallback) => {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !value.trim() || value.length > 100 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('DOCX 字体必须为有效字体名称')
  }
  return value.trim()
}
const headingLevels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6]

function paragraph(text, options = {}) {
  const parts = String(text).split(/\r?\n/u)
  const children = parts.flatMap((part, index) => [new TextRun({ text: part, ...(index ? { break: 1 } : {}),
    ...(options.bold ? { bold: true } : {}) })])
  const { bold: _, ...properties } = options
  return new Paragraph({ children, spacing: { after: 140, line: 330 }, widowControl: true, ...properties })
}

function heading(text, depth, extra = {}) {
  return paragraph(text, { heading: headingLevels[Math.min(depth - 1, headingLevels.length - 1)],
    keepNext: true, keepLines: true, ...extra })
}

/** Deterministic export only. It does not retrieve, shorten or regenerate the source manuscript. */
export async function renderDocx(snapshot, options = {}) {
  // Use named CJK families rather than Windows-only aliases; hosts may choose installed families per export.
  const latin = fontName(options.fonts?.latin, 'Arial')
  const font = eastAsia => ({ ascii: latin, hAnsi: latin, eastAsia, cs: latin })
  const bodyFont = font(fontName(options.fonts?.body, 'Source Han Serif CN'))
  const headingFont = font(fontName(options.fonts?.heading, 'Source Han Sans SC'))
  const view = documentView(snapshot)
  const children = [paragraph(view.title, { heading: HeadingLevel.TITLE, keepNext: true, keepLines: true })]
  children.push(...view.notes.map(note => paragraph(note)))
  for (const section of view.sections) {
    children.push(heading(section.title, section.depth))
    children.push(paragraph(`${section.statusLabel}；${section.approvalLabel}${section.version === undefined ? '' : `；章节版本 ${section.version}`}。`))
    if (section.inputNeeded) {
      children.push(paragraph(`待补材料：${section.inputNeeded.reason || '尚缺本章资料'}`, { bold: true }))
      for (const question of section.inputNeeded.questions || []) children.push(paragraph(String(question), { bullet: { level: 0 } }))
      if (section.inputNeeded.nextAction) children.push(paragraph(section.inputNeeded.nextAction))
    }
    for (const block of section.blocks) {
      if (block.labels.length) children.push(paragraph(block.labels.join('；') + '。', { keepNext: true }))
      children.push(paragraph(block.text))
      if (block.sourceIndices.length) children.push(paragraph(`依据：${block.sourceIndices.map(index => `[来源 ${index}]`).join('、')}`))
    }
  }
  if (view.sources.length) {
    children.push(heading('来源附录', 1, { pageBreakBefore: true }))
    for (const source of view.sources) {
      children.push(heading(`来源 ${source.index}`, 2))
      children.push(paragraph(`原始来源 ID：${source.id}`))
      if (source.title) children.push(paragraph(`资料：${source.title}`))
      if (source.locator) children.push(paragraph(`位置：${source.locator}`))
      if (source.url) children.push(paragraph(`链接：${source.url}`))
      if (source.quote) children.push(paragraph(`原文摘录：${source.quote}`))
    }
  }
  const document = new Document({
    creator: 'WLYD material knowledge assembly', title: view.title, description: '基于固定文案版本的确定性文档输出',
    styles: {
      default: {
        document: { run: { font: bodyFont, size: 22, color: '000000', language: CHINESE_LANGUAGE },
          paragraph: { spacing: { after: 140, line: 330 } } },
        title: { run: { font: headingFont, size: 38, color: '000000', bold: true, language: CHINESE_LANGUAGE },
          paragraph: { spacing: { before: 0, after: 260 }, keepNext: true } },
        ...Object.fromEntries([1, 2, 3, 4, 5, 6].map(depth => [`heading${depth}`, {
          run: { font: headingFont, size: [30, 27, 24, 23, 22, 22][depth - 1], color: '000000', bold: true, language: CHINESE_LANGUAGE },
          paragraph: { spacing: { before: depth === 1 ? 300 : 220, after: 140 }, keepNext: true, keepLines: true }
        }]))
      }
    },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 },
      margin: { top: 1360, bottom: 1360, left: 1440, right: 1440, header: 600, footer: 650 } } },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER,
      children: [new TextRun({ children: ['第 ', PageNumber.CURRENT, ' 页 / 共 ', PageNumber.TOTAL_PAGES, ' 页'],
        font: bodyFont, size: 18, color: '000000', language: CHINESE_LANGUAGE })] })] }) }, children }]
  })
  return Packer.toBuffer(document)
}

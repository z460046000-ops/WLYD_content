import { createHash } from 'node:crypto'
import path from 'node:path'
import JSZip from 'jszip'
import mammoth from 'mammoth'
import ExcelJS from 'exceljs'
import { PDFParse } from 'pdf-parse'

export const MAX_BYTES = 500 * 1024 * 1024
const TEXT = new Set(['.md', '.markdown', '.txt', '.csv', '.json', '.xml', '.yaml', '.yml', '.log', '.html', '.htm'])
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.tiff', '.heic'])
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const clean = value => String(value).replace(/\u0000/gu, '').replace(/\r\n?/gu, '\n').trim()
const decodeXml = text => text.replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"').replace(/&apos;/gu, "'").replace(/&amp;/gu, '&')
const stripHtml = text => decodeXml(text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ').replace(/<[^>]+>/gu, ' '))

export function classify(name) {
  const ext = path.extname(name).toLowerCase()
  if (TEXT.has(ext)) return 'text'
  if (IMAGE.has(ext)) return 'image'
  if (['.docx', '.pdf', '.pptx', '.xlsx', '.zip', '.dmg'].includes(ext)) return ext.slice(1)
  return 'unsupported'
}

async function extract(name, bytes) {
  const kind = classify(name)
  if (kind === 'text') {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return path.extname(name).toLowerCase().startsWith('.htm') ? stripHtml(text) : text
  }
  if (kind === 'docx') return (await mammoth.extractRawText({ buffer: bytes })).value
  if (kind === 'pdf') {
    const parser = new PDFParse({ data: bytes })
    try { return (await parser.getText()).text || '' } finally { await parser.destroy() }
  }
  if (kind === 'pptx') {
    const zip = await JSZip.loadAsync(bytes)
    const slides = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/u.test(n))
      .sort((a, b) => Number(/slide(\d+)/u.exec(a)[1]) - Number(/slide(\d+)/u.exec(b)[1]))
    const output = []
    for (const file of slides) {
      const xml = await zip.files[file].async('string')
      const text = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu)].map(match => decodeXml(match[1])).join(' ')
      if (text.trim()) output.push(`## 第 ${/slide(\d+)/u.exec(file)[1]} 页\n\n${text}`)
    }
    return output.join('\n\n')
  }
  if (kind === 'xlsx') {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(bytes)
    const output = []
    for (const sheet of workbook.worksheets) {
      const rows = [`## 工作表：${sheet.name}`]
      sheet.eachRow((row, index) => {
        rows.push(`行 ${index}：${row.values.slice(1).map(value => {
          if (value == null) return ''
          if (typeof value === 'object') return String(value.text ?? value.result ?? JSON.stringify(value))
          return String(value)
        }).join(' | ')}`)
      })
      output.push(rows.join('\n'))
    }
    return output.join('\n\n')
  }
  return ''
}

/** 每个原件或 ZIP 内文件都独立返回状态；失败不影响同批其他文件。 */
export async function convertFile(name, bytes, options = {}, depth = 0) {
  const source = { name, kind: classify(name), bytes: bytes.length, sha256: sha256(bytes) }
  if (bytes.length > MAX_BYTES) return [{ ...source, status: 'failed', reason: '单文件超过 500 MB' }]
  if (source.kind === 'zip') {
    if (depth >= 2) return [{ ...source, status: 'failed', reason: 'ZIP 嵌套超过两层' }]
    try {
      const zip = await JSZip.loadAsync(bytes)
      const entries = Object.values(zip.files).filter(item => !item.dir && !item.name.startsWith('__MACOSX/'))
      if (entries.length > 1000) return [{ ...source, status: 'failed', reason: 'ZIP 条目超过 1000' }]
      let total = 0
      const output = []
      for (const entry of entries) {
        const size = entry._data?.uncompressedSize
        if (!Number.isSafeInteger(size) || size > MAX_BYTES || total + size > 2 * MAX_BYTES) {
          output.push({ name: `${name}!${entry.name}`, kind: classify(entry.name), status: 'failed', reason: 'ZIP 展开超限' })
          continue
        }
        total += size
        output.push(...await convertFile(`${name}!${entry.name}`, await entry.async('nodebuffer'), options, depth + 1))
      }
      return output.length ? output : [{ ...source, status: 'unsupported', reason: 'ZIP 中没有可读文件' }]
    } catch { return [{ ...source, status: 'failed', reason: 'ZIP 损坏或无法读取' }] }
  }
  if (source.kind === 'image') return [{ ...source, status: 'needs_ocr', reason: '当前未配置图片 OCR' }]
  if (source.kind === 'dmg') return [{ ...source, status: 'unsupported', reason: 'DMG 暂不只读挂载；不会运行应用' }]
  if (source.kind === 'unsupported') return [{ ...source, status: 'unsupported', reason: '未实现该格式转换' }]
  try {
    const raw = clean(await extract(name, bytes))
    if (!raw) return [{ ...source, status: source.kind === 'pdf' ? 'needs_ocr' : 'unsupported', reason: '未提取到可读正文' }]
    return [{ ...source, status: 'converted', text: raw, markdown: `# ${path.basename(name)}\n\n${raw}\n`, converterVersion: '0.1.2' }]
  } catch (error) {
    return [{ ...source, status: 'failed', reason: `转换失败：${error.message}`.slice(0, 180) }]
  }
}

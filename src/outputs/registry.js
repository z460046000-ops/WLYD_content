import { renderMarkdown } from './markdown.js'
import { renderDocx } from './docx.js'

export const DOCUMENT_FORMATS = ['md', 'docx']

/** Registry owns format routing; content rules never import an output adapter. */
export async function renderOutput(format, snapshot, options = {}) {
  if (format === 'md' || format === 'markdown') return {
    content: renderMarkdown(snapshot, options), mimeType: 'text/markdown; charset=utf-8', extension: 'md'
  }
  if (format === 'docx') return {
    content: await renderDocx(snapshot, options), mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension: 'docx'
  }
  throw new Error(`不支持的文档输出格式：${String(format)}`)
}

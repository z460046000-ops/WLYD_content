import { readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../rules/', import.meta.url))
const hash = text => createHash('sha256').update(text).digest('hex')
const safe = value => /^[a-z][a-z0-9-]*$/u.test(value)

export async function loadRules(templateId = 'presales-solution') {
  if (!safe(templateId)) throw new Error('无效的方案模板 ID')
  const files = ['global.json', 'style.json', `templates/${templateId}.json`]
  const read = async file => {
    const raw = await readFile(path.join(root, file), 'utf8')
    return { file, value: JSON.parse(raw), sha256: hash(raw) }
  }
  const [global, style, template] = await Promise.all(files.map(read))
  const roles = new Set()
  const walk = sections => {
    if (!Array.isArray(sections)) throw new Error('模板 sections 无效')
    for (const section of sections) {
      if (!safe(section.key) || !safe(section.roleId)) throw new Error('模板章节 ID 无效')
      roles.add(section.roleId)
      if (section.children) walk(section.children)
    }
  }
  walk(template.value.sections)
  const chapterFiles = (await readdir(path.join(root, 'chapters')))
    .filter(file => /^[a-z][a-z0-9-]*\.json$/u.test(file)).sort()
  const chapters = await Promise.all(chapterFiles.map(file => read(`chapters/${file}`)))
  for (const item of chapters) if (item.value.roleId !== path.basename(item.file, '.json')) throw new Error(`章节规则不匹配：${item.file}`)
  const chapterIds = new Set(chapters.map(item => item.value.roleId))
  for (const role of roles) if (!chapterIds.has(role)) throw new Error(`默认模板缺少章节规则：${role}`)
  const entries = [global, style, template, ...chapters]
  return { global: global.value, style: style.value, template: template.value,
    chapters: Object.fromEntries(chapters.map(item => [item.value.roleId, item.value])),
    loaded: entries.map(({ file, value, sha256 }) => ({ file, version: value.version, sha256 })),
    fingerprint: hash(entries.map(item => `${item.file}:${item.sha256}`).join('\n')) }
}

export function validateOutline(outline, rules) {
  if (!Array.isArray(outline) || !outline.length || outline.length > 30) throw new Error('目录必须包含 1—30 章')
  const keys = new Set()
  let count = 0
  const check = (sections, depth) => {
    if (depth > 3) throw new Error('目录最多三级')
    for (const section of sections) {
      if (++count > 60) throw new Error('目录最多 60 个章节节点')
      if (!safe(section.key) || keys.has(section.key)) throw new Error('章节 key 无效或重复')
      keys.add(section.key)
      if (!String(section.title ?? '').trim() || section.title.length > 100) throw new Error('章节标题无效')
      if (!rules.chapters[section.roleId] && section.roleId !== 'custom') throw new Error(`缺少章节规则：${section.roleId}`)
      if (section.roleId === 'custom' && !['goal', 'audience', 'questions', 'evidenceScope', 'acceptance'].every(k => section[k])) {
        throw new Error('自定义章节须说明目标、读者、问题、证据范围和验收条件')
      }
      if (section.children) check(section.children, depth + 1)
    }
  }
  check(outline, 1)
  return outline
}

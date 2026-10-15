import { PlatformClient, resolveConfig } from './platform.js'
import { ingest, status, assemble } from './workflow.js'
import { loadRules, validateOutline } from './rules.js'

export const name = 'wlyd-material-knowledge-assembly'
export const inject = ['tools', 'llm', 'fs']
const output = { schema: { type: 'object', additionalProperties: true, properties: {} },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
const card = (title, kind, rawInput = {}) => ({ card: 'generic', title, kind, rawInput })

// 智谱 coding 网关 2026-10 起要求工具 parameters 为严格标准 JSON Schema：
// 解包式 schema（属性平铺 + 内联 required:true）会导致模型恒输出空参数 {}，
// 工具能调用但永远拿不到参数。注册时统一包裹转换，一处改动覆盖全部工具。
function stdSchemaNode(node) {
  if (Array.isArray(node)) return node.map(stdSchemaNode)
  if (!node || typeof node !== 'object') return node
  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'required') continue
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      const props = {}
      const req = []
      for (const [pk, pv] of Object.entries(value)) {
        if (pv && pv.required === true) req.push(pk)
        props[pk] = stdSchemaNode(pv)
      }
      out.properties = props
      if (req.length) out.required = req
      continue
    }
    if (key === 'items' && value && typeof value === 'object') {
      out.items = stdSchemaNode(value)
      continue
    }
    out[key] = value
  }
  return out
}

function wrapParams(params) {
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value && value.required === true) required.push(key)
    properties[key] = stdSchemaNode(value)
  }
  const wrapped = { type: 'object', properties }
  if (required.length) wrapped.required = required
  return wrapped
}

export function apply(ctx, config = {}) {
  const toolsService = ctx.tools
  const rawRegister = toolsService.register.bind(toolsService)
  toolsService.register = tool => {
    if (tool && typeof tool === 'object' && tool.parameters && typeof tool.parameters === 'object'
      && tool.parameters.type !== 'object') {
      return rawRegister({ ...tool, parameters: wrapParams(tool.parameters) })
    }
    return rawRegister(tool)
  }
  const client = new PlatformClient(resolveConfig(config))

  ctx.tools.register({
    name: 'wlyd_assembly_projects',
    description: '只读列出当前平台配置账号可访问的方案项目；这不证明 DSH 用户与平台账号是同一人。',
    parameters: {}, output,
    execute: async (_args, exec) => ({ projects: await client.projects(exec.signal) }),
    presentCall: () => card('查看可用方案项目', 'read'),
  })

  ctx.tools.register({
    name: 'wlyd_assembly_ingest',
    description: '读取最多 100 个工作区文件或当前会话用户附件，逐文件转为 Markdown；唯一授权项目和绑定知识库时默认上传。多目标先返回候选，不自动选择。',
    parameters: {
      files: { type: 'array', items: { type: 'string' }, description: '工作区内材料路径' },
      attachment_refs: { type: 'array', items: { type: 'object', properties: {
        attachmentId: { type: 'string' }, name: { type: 'string' }, bytes: { type: 'number' },
      } }, description: '本次会话用户上传的附件引用' },
      project_id: { type: 'string', description: '多个可访问项目时，由用户选择的项目 ID' },
      knowledge_base_id: { type: 'string', description: '多个可见绑定知识库时，由用户选择的知识库 ID' },
    }, output,
    execute: (args, exec) => ingest({ ctx, client, args, exec }),
    presentCall: args => card('转换并同步材料', 'write', { files: args?.files?.length || 0,
      attachments: args?.attachment_refs?.length || 0, projectId: args?.project_id }),
  })

  ctx.tools.register({
    name: 'wlyd_assembly_status',
    description: '查看一次材料导入的逐文件状态，并查询已上传文档是否解析完成。',
    parameters: { run_id: { type: 'string', required: true } }, output,
    execute: (args, exec) => status({ client, runId: args.run_id, agent: exec.agent, signal: exec.signal }),
    presentCall: args => card('查看解析状态', 'read', { runId: args?.run_id }),
  })

  ctx.tools.register({
    name: 'wlyd_assembly_outline',
    description: '预览默认或修改后的方案目录及规则版本。用户可通过提示词要求增加、删除、改名或排序；生成前应展示目录让用户确认。',
    parameters: { template_id: { type: 'string' }, outline: { type: 'array', items: { type: 'object' } } }, output,
    async execute(args) {
      const rules = await loadRules(args.template_id || 'presales-solution')
      const outline = validateOutline(args.outline || rules.template.sections, rules)
      return { templateId: rules.template.id, outline, ruleFingerprint: rules.fingerprint,
        note: '这是目录预览。自定义目录请经用户确认后再传给组稿工具。' }
    },
    presentCall: () => card('预览方案目录', 'read'),
  })

  ctx.tools.register({
    name: 'wlyd_assembly_generate',
    description: '用本次转换材料及可访问项目知识库片段组装带逐字依据的售前报告。目录可编辑；若自定义目录须先经用户确认。输出 report.md/report.json/evidence.json/run.json。',
    parameters: {
      source_run_id: { type: 'string', description: '材料导入返回的 runId' },
      project_id: { type: 'string', description: '可访问的方案项目 ID' },
      template_id: { type: 'string', description: '方案模板，当前提供 presales-solution' },
      outline: { type: 'array', items: { type: 'object' }, description: '经用户确认后的项目目录实例' },
      audience: { type: 'string', description: '方案读者' },
    }, output,
    execute: (args, exec) => assemble({ client, llm: ctx.llm, args, exec }),
    presentCall: args => card('生成有据售前报告', 'write', { sourceRunId: args?.source_run_id,
      projectId: args?.project_id, templateId: args?.template_id }),
  })
}

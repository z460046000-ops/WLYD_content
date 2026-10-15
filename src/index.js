import { PlatformClient, resolveConfig } from './platform.js'
import { parametersSchema } from './schema.js'
import { ingest, status, assemble } from './workflow.js'
import { loadRules, validateOutline, requestedModes, applyModes, BUSINESS_MODES, TREND_FRAMEWORKS } from './rules.js'

export const name = 'wlyd-material-knowledge-assembly'
export const inject = ['tools', 'llm', 'fs']
const output = { schema: { type: 'object', additionalProperties: true, properties: {} },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
const card = (title, kind, rawInput = {}) => ({ card: 'generic', title, kind, rawInput })
const selectionParameters = {
  business_mode: { type: 'string', enum: BUSINESS_MODES, description: '业务分析二选一：current-state 业务现状；needs-challenges 需求挑战；auto 按材料与受众选择' },
  trend_framework: { type: 'string', enum: TREND_FRAMEWORKS, description: '趋势章二选一：pest；management-business-technology 管理/业务/技术；auto 按材料选择' },
}

export function apply(ctx, config = {}) {
  const client = new PlatformClient(resolveConfig(config))
  const register = tool => ctx.tools.register({ ...tool, parameters: parametersSchema(tool.parameters) })

  register({
    name: 'wlyd_assembly_projects',
    description: '只读列出当前平台配置账号可访问的方案项目；这不证明 DSH 用户与平台账号是同一人。',
    parameters: {}, output,
    execute: async (_args, exec) => ({ projects: await client.projects(exec.signal) }),
    presentCall: () => card('查看可用方案项目', 'read'),
  })

  register({
    name: 'wlyd_assembly_ingest',
    description: '读取最多 100 个工作区文件或当前会话用户附件，逐文件转为 Markdown；唯一授权项目和绑定知识库时默认上传。多目标先返回候选，不自动选择。',
    parameters: {
      files: { type: 'array', items: { type: 'string' }, description: '工作区内材料路径' },
      attachment_refs: { type: 'array', items: { type: 'object', properties: {
        attachmentId: { type: 'string', description: '当前会话附件的完整 ID，通常为 sha256: 加 64 位摘要' }, name: { type: 'string' }, bytes: { type: 'number' },
      } }, description: '本次会话用户上传的附件引用' },
      project_id: { type: 'string', description: '多个可访问项目时，由用户选择的项目 ID' },
      knowledge_base_id: { type: 'string', description: '多个可见绑定知识库时，由用户选择的知识库 ID' },
    }, output,
    execute: (args, exec) => ingest({ ctx, client, args, exec }),
    presentCall: args => card('转换并同步材料', 'write', { files: args?.files?.length || 0,
      attachments: args?.attachment_refs?.length || 0, projectId: args?.project_id }),
  })

  register({
    name: 'wlyd_assembly_status',
    description: '查看导入的逐文件解析状态，或生成运行的规划、逐章提取/撰写/校验进度。生成运行只读，不触发重新生成。',
    parameters: { run_id: { type: 'string', required: true } }, output,
    execute: (args, exec) => status({ client, runId: args.run_id, agent: exec.agent, signal: exec.signal }),
    presentCall: args => card('查看解析状态', 'read', { runId: args?.run_id }),
  })

  register({
    name: 'wlyd_assembly_outline',
    description: '预览默认或修改后的方案目录及规则版本。用户可通过提示词要求增加、删除、改名或排序；生成前应展示目录让用户确认。',
    parameters: { template_id: { type: 'string' }, outline: { type: 'array', items: { type: 'object' } }, ...selectionParameters }, output,
    async execute(args) {
      const rules = await loadRules(args.template_id || 'presales-solution')
      const original = validateOutline(args.outline || rules.template.sections, rules)
      const selection = requestedModes(original, args)
      const outline = applyModes(original, selection)
      return { templateId: rules.template.id, outline, ruleFingerprint: rules.fingerprint,
        selection, note: '这是目录预览。auto 在生成共享计划时依据材料二选一；用户可用参数覆盖。自定义目录请经确认后传给组稿工具。' }
    },
    presentCall: () => card('预览方案目录', 'read'),
  })

  register({
    name: 'wlyd_assembly_generate',
    description: '先制定全篇关联计划，再最多四路并行逐章提取、撰写与校验，合成带逐字依据的售前报告。业务现状/需求挑战、PEST/管理业务技术各二选一。自定义目录须先确认。保留 plan.json、逐章文件和报告；部分章节失败不丢失其他结果。',
    parameters: {
      source_run_id: { type: 'string', description: '材料导入返回的 runId' },
      project_id: { type: 'string', description: '可访问的方案项目 ID' },
      template_id: { type: 'string', description: '方案模板，当前提供 presales-solution' },
      outline: { type: 'array', items: { type: 'object' }, description: '经用户确认后的项目目录实例' },
      audience: { type: 'string', description: '方案读者' },
      ...selectionParameters,
    }, output,
    execute: (args, exec) => assemble({ client, llm: ctx.llm, args, exec }),
    presentCall: args => card('生成有据售前报告', 'write', { sourceRunId: args?.source_run_id,
      projectId: args?.project_id, templateId: args?.template_id }),
  })
}

import { PlatformClient, resolveConfig } from './platform.js'
import { parametersSchema } from './schema.js'
import { ingest, status } from './workflow.js'
import { createTaskService, observedTask } from './tasks.js'
import { createRequire } from 'node:module'
import { loadRules, validateOutline, requestedModes, applyModes, BUSINESS_MODES, TREND_FRAMEWORKS } from './rules.js'
import { planOutline, confirmOutline } from './planning.js'

export const name = 'wlyd-material-knowledge-assembly'
export const inject = ['tools', 'llm', 'fs', 'jobs']
const runtimeVersion = createRequire(import.meta.url)('../package.json').version
const output = { schema: { type: 'object', additionalProperties: true, properties: {} },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
const card = (title, kind, rawInput = {}) => ({ card: 'generic', title, kind, rawInput })
const selectionParameters = {
  business_mode: { type: 'string', enum: BUSINESS_MODES, description: '业务分析二选一：current-state 业务现状；needs-challenges 需求挑战；auto 按材料与受众选择' },
  trend_framework: { type: 'string', enum: TREND_FRAMEWORKS, description: '趋势章二选一：pest；management-business-technology 管理/业务/技术；auto 按材料选择' },
}
const authorParameters = {
  author_identity: { type: 'string', description: '作者专业身份，如人力资源顾问、金融行业顾问、营销方案作者；与读者分开' },
  domain: { type: 'string', description: '行业或业务领域' },
  objective: { type: 'string', description: '本次文章要达成的目标' },
  audience: { type: 'string', description: '目标读者' },
}

export function apply(ctx, config = {}) {
  const client = new PlatformClient(resolveConfig(config))
  const tasks = ctx.jobs ? createTaskService({ jobs: ctx.jobs, client, llm: ctx.llm }) : null
  if (tasks) ctx.effect?.(() => () => tasks.close())
  ctx.logger?.info?.(`wlyd assembly ${runtimeVersion} contract=2 jobs=${Boolean(tasks)}`)
  const register = tool => ctx.tools.register({ ...tool, parameters: parametersSchema(tool.parameters),
    execute: async (args, exec) => ({ ...await tool.execute(args, exec), runtimeVersion, contractVersion: 2 }) })

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
    description: '查看导入逐文件状态、大纲规划与确认状态，或生成运行的逐章提取/撰写/校验、全景补充及合稿必检进度。生成运行只读，不触发重新生成。',
    parameters: { run_id: { type: 'string', required: true } }, output,
    execute: async (args, exec) => tasks ? tasks.query(args.run_id, exec)
      : observedTask(await status({ client, runId: args.run_id, agent: exec.agent, signal: exec.signal })),
    presentCall: args => card('查看解析状态', 'read', { runId: args?.run_id }),
  })

  register({
    name: 'wlyd_assembly_outline',
    description: 'action=preview 仅预览模板；action=plan 按作者身份宏观检索并保存粗大纲与关联主线，返回 planId/planSha256，必须展示后等待用户确认。收到用户明确确认后才调用 action=confirm（confirmed=true）确认该版本。修改目录须重新 plan。不得自动跳过确认。',
    parameters: { action: { type: 'string', enum: ['preview', 'plan', 'confirm'] },
      project_id: { type: 'string' }, source_run_id: { type: 'string' },
      plan_id: { type: 'string' }, plan_sha256: { type: 'string' }, confirmed: { type: 'boolean' },
      template_id: { type: 'string' }, outline: { type: 'array', items: { type: 'object' } }, ...selectionParameters, ...authorParameters }, output,
    async execute(args, exec) {
      if (args.action && !['preview', 'plan', 'confirm'].includes(args.action)) throw new Error('未知 outline action，请使用 preview、plan 或 confirm')
      if (args.action === 'plan') return planOutline({ client, llm: ctx.llm, args, exec })
      if (args.action === 'confirm') return confirmOutline({ args, exec })
      const rules = await loadRules(args.template_id || 'presales-solution')
      const original = validateOutline(args.outline || rules.template.sections, rules)
      const selection = requestedModes(original, args)
      const outline = applyModes(original, selection)
      return { templateId: rules.template.id, outline, ruleFingerprint: rules.fingerprint,
        selection, note: '这是模板预览；请使用 action=plan 取得基于材料的粗大纲，展示并等待用户确认后 action=confirm。正文生成需要已确认的 plan_id 和 plan_sha256。' }
    },
    presentCall: () => card('预览方案目录', 'read'),
  })

  register({
    name: 'wlyd_assembly_generate',
    description: '只使用已确认大纲，提交宿主管理的后台组稿并立即返回 runId；用 status 查询，禁止循环重复 generate。同材料目录默认复用已有运行。mode=resume 携 run_id 接续检查点；mode=regenerate 明确重新生成。所有章节并行定向取证、提取和撰写，实际请求默认八路并受模型路由限流。合稿必检前后关联、能力证据、全景及矛盾；未查完不能通过。进程关闭后任务停止，可显式恢复。',
    parameters: {
      mode: { type: 'string', enum: ['start', 'resume', 'regenerate'], description: '默认 start；resume 接续旧运行；regenerate 明确重做' },
      run_id: { type: 'string', description: 'mode=resume 必填，使用原生成 runId；不能填导入或规划 ID' },
      plan_id: { type: 'string', description: 'start/regenerate 必填：outline action=confirm 已确认的规划 ID' },
      plan_sha256: { type: 'string', description: 'start/regenerate 必填：已确认版本 SHA-256；恢复默认读取原参数' },
      source_run_id: { type: 'string', description: '材料导入返回的 runId' },
      project_id: { type: 'string', description: '可访问的方案项目 ID' },
      template_id: { type: 'string', description: '方案模板，当前提供 presales-solution' },
      outline: { type: 'array', items: { type: 'object' }, description: '经用户确认后的项目目录实例' },
      ...authorParameters,
      ...selectionParameters,
    }, output,
    execute: (args, exec) => {
      if (!tasks) throw new Error('DSH jobs 服务未注入，无法提交后台组稿；请完整重启新版插件')
      return tasks.submit(args, exec)
    },
    presentCall: args => card('生成有据售前报告', 'write', { sourceRunId: args?.source_run_id,
      projectId: args?.project_id, templateId: args?.template_id }),
  })
  register({ name: 'wlyd_assembly_cancel', description: '明确停止当前会话的后台组稿，保留已落盘检查点。停止完成后可用 generate mode=resume 接续。',
    parameters: { run_id: { type: 'string', required: true } }, output,
    execute: (args, exec) => {
      if (!tasks) throw new Error('DSH jobs 服务不可用')
      return tasks.cancel(args.run_id, exec)
    },
    presentCall: args => card('停止后台组稿', 'write', { runId: args?.run_id }),
  })
}

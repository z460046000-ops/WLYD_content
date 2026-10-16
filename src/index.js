import { PlatformClient, resolveConfig } from './platform.js'
import { parametersSchema } from './schema.js'
import { ingest, status } from './workflow.js'
import { createTaskService, observedTask } from './tasks.js'
import { createRequire } from 'node:module'
import { loadRules, validateOutline, requestedModes, applyModes, BUSINESS_MODES, TREND_FRAMEWORKS } from './rules.js'
import { planOutline, confirmOutline } from './planning.js'
import { chapterAction } from './chapters.js'
import { QUALITY_MODES } from './fact-cards.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createDeliveryService } from './delivery/tasks.js'
import { currentDelivery, deliverySummary } from './delivery/manifest.js'
import { createStatusRenderer } from '../orchestration/status.js'
import { roleRoute, roleExecution } from '../orchestration/routes.js'

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
  const writingRoute = roleRoute(config, 'writing'), presentationRoute = roleRoute(config, 'presentation')
  const delivery = ctx.jobs ? createDeliveryService({ jobs: ctx.jobs, client, llm: ctx.llm, modelRoute: presentationRoute || writingRoute }) : null
  const tasks = ctx.jobs ? createTaskService({ jobs: ctx.jobs, client, llm: ctx.llm, modelRoute: writingRoute,
    afterComplete: (runId, exec) => delivery.submit({ run_id: runId }, exec) }) : null
  if (tasks) ctx.effect?.(() => async () => { await tasks.close(); await delivery.close() })
  const orchestrationSkill = readFileSync(new URL('../skills/wlyd-assembly-orchestrate/SKILL.md', import.meta.url), 'utf8')
  ctx.inject?.(['skills'], skillCtx => {
    skillCtx.skills.register({ name: 'wlyd-assembly-orchestrate', description: '先确认文案大纲，再交MD/DOCX和独立翻页HTML，使用宿主通知避免代理轮询',
      source: 'runtime', content: orchestrationSkill.replace(/^---\n[\s\S]*?\n---\n/u, ''),
      resourceBase: { kind: 'directory', path: fileURLToPath(new URL('../skills/wlyd-assembly-orchestrate/', import.meta.url)) } })
  })
  ctx.inject?.(['systemPrompt'], promptCtx => {
    promptCtx.systemPrompt.section({ name: 'tool:wlyd-assembly', order: promptCtx.systemPrompt.getSectionOrder('TOOL_JOBS'),
      text: '使用wlyd_assembly工具时：大纲必须由用户确认后再生成。generate提交一次后保留runId/jobId，等宿主完成通知再用job_output取结果；禁止sleep或代理循环轮询。文案完成先交MD/DOCX，独立HTML任务稍后交付；材料卡不算完整正文。需要主动查进度时status默认摘要，可传after_revision。仅改输出物用wlyd_assembly_output，不重新组稿。' })
  })
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
    description: '只读进度，默认向模型返回精简摘要和正文覆盖率；after_revision省略未变化字段，view=detail仅用于诊断。等待后台任务优先宿主完成通知和job_output wait=true，不代理轮询。',
    parameters: { run_id: { type: 'string', required: true }, view: { type: 'string', enum: ['summary', 'detail'] }, after_revision: { type: 'string' } },
    output: { ...output, render: createStatusRenderer() },
    execute: async (args, exec) => {
      const state = tasks ? await tasks.query(args.run_id, exec)
        : observedTask(await status({ client, runId: args.run_id, agent: exec.agent, signal: exec.signal }))
      if (state.actorDshId && state.actorDshId !== exec.agent.session?.user?.id) throw new Error('当前用户无权读取此运行')
      if (state.kind === 'assembly-task' && state.reportReady) state.delivery = deliverySummary(await currentDelivery(exec.agent, args.run_id))
      return state
    },
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
      if (args.action === 'plan') return planOutline({ client, llm: ctx.llm, args, exec: roleExecution(exec, writingRoute) })
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
    description: '只使用已确认大纲，提交宿主管理的组稿并立即返回runId/jobId。等宿主通知后job_output取结果，不sleep、不代理循环查status或重复generate。文案结束自动先交MD/DOCX，再提交独立翻页HTML任务。正文和材料卡分开统计。mode=resume接续，regenerate明确重做；关联必检与知识库取材继续保留。',
    parameters: {
      mode: { type: 'string', enum: ['start', 'resume', 'regenerate'], description: '默认 start；resume 接续旧运行；regenerate 明确重做' },
      quality_mode: { type: 'string', enum: QUALITY_MODES, description: '默认 draft：先出带标注初稿、每章有正文或待补卡；standard 最多一次修正；strict 保留严格验证链路' },
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
  register({ name: 'wlyd_assembly_chapter',
    description: '稿件生成后逐章迭代：list 查看版本/正文/意见；comment/question 仅记录用户意见；resolve 解决意见；revise 按要求修改本章或 block_ids，只复用本章事实卡并重查受影响关联，保留版本；approve 经用户确认定稿，reopen 经用户确认解锁。修改/定稿/解锁必传 list 返回的 expected_version。',
    parameters: { run_id: { type: 'string', required: true }, action: { type: 'string', required: true,
      enum: ['list', 'comment', 'question', 'resolve', 'revise', 'approve', 'reopen'] },
      chapter_key: { type: 'string' }, expected_version: { type: 'integer', minimum: 1 },
      text: { type: 'string', description: '评论、追问或解决说明' }, instruction: { type: 'string', description: '章节修改要求' },
      note_id: { type: 'string' }, block_ids: { type: 'array', items: { type: 'string' }, description: '可选，只修改这些段落；省略则改本章' },
      confirmed: { type: 'boolean', description: '用户明确认可定稿或解锁后才设 true' } }, output,
    execute: (args, exec) => chapterAction({ client, llm: ctx.llm, args, exec }),
    presentCall: args => card('审阅与修改章节', args?.action === 'list' ? 'read' : 'write', { runId: args?.run_id, chapterKey: args?.chapter_key, action: args?.action }),
  })
  register({ name: 'wlyd_assembly_output',
    description: '独立输出物：start从当前文案版本先导出MD/DOCX，再提炼关键点生成可自由翻页HTML；query查询产物和过期状态；cancel仅停止HTML。改主题复用同版演示稿，不检索或重写原文。HTML失败文档保留，可retry。',
    parameters: { run_id: { type: 'string', required: true }, action: { type: 'string', enum: ['start', 'query', 'cancel'] },
      format: { type: 'string', enum: ['all', 'documents', 'html'] }, theme: { type: 'string', enum: ['editorial', 'swiss', 'blueprint'] },
      retry: { type: 'boolean' }, expected_content_sha256: { type: 'string', description: '可选，防止输出期间用了非预期的文案版本' } }, output,
    execute: (args, exec) => {
      if (!delivery) throw new Error('DSH jobs服务不可用，无法托管演示输出')
      if (!args.action || args.action === 'start') return delivery.submit(args, exec)
      if (args.action === 'query') return delivery.query(args.run_id, exec)
      if (args.action === 'cancel') return delivery.cancel(args.run_id, exec)
      throw new Error('未知输出操作')
    },
    presentCall: args => card('文档与演示输出', args?.action === 'query' ? 'read' : 'write', { runId: args?.run_id, format: args?.format, theme: args?.theme }),
  })
}

---
name: wlyd-assembly-orchestrate
description: 在DSH调用材料组装插件，先确认大纲再生成文案，先交MD和DOCX，再收取独立的翻页HTML；复用宿主作业通知，避免代理轮询。
---

# 材料组装与输出编排

1. 选择当前用户可见项目，从知识库实际取材，outline action=plan。展示目录和主线，等用户明确确认后action=confirm；不得自动确认。
2. 有当前已确认planId/planSha256且目录、作者目标、材料、知识范围和权限、规则没变时可直接复用；变化则重新plan/confirm。不要仅凭项目和受众猜缓存，不能绕过工具校验。
3. generate只提交一次，记runId/jobId。DSH的tool-jobs会发完成通知；独立工作做完即可结束当前等待，通知到达后用job_output收结果。确实需要等时用job_output wait=true timeout_ms=60000，一次有界等待；不Bash sleep、不起代理循环调用status、不重开generate。
4. 用户主动查进度时才status（默认精简渲染）；保存返回revision，下次传after_revision。完整错误仅在需要诊断时view=detail，读文件时定位相应章，别把整个run或modelRequests塞进上下文。
5. 文案完成自动先导出MD/DOCX，独立HTML任务继续。先把markdownPath/docxPath交用户，HTML任务完成通知后再收htmlPath。不要因HTML还在渲染而扣留文档，也不要把needs_input卡算已生成正文。
6. 单独重试/换主题调用wlyd_assembly_output，action=start；query查看输出状态，cancel只停HTML。仅改主题会复用同版本演示稿，不重新组稿。文案变更后旧产物标stale，要重新输出；不得覆盖原文。
7. 编排会话可在DSH选择已配置快模型。写作/复核可配置writingRoute，演示提炼可配置presentationRoute；未配置时跟随原会话，不声称已切换模型或测得加速。

默认演示要求：从已交付文档提取关键点，精简为面向客户的标题与要点，使用xiaoma-studio生成方向键/按钮自由翻页、页码及全屏HTML；保留问题方案对应、来源、状态与条件。视觉规则只在输出阶段加载，不放入内容章节规则。没有事实不能凭美化补造案例、数字或资质。

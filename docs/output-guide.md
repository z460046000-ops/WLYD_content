# 文档与演示输出

源码0.10.0，未安装或重启DSH。本说明描述新包能力；实际生效须以后按用户指令切换。

## 默认流程

1. 选择知识库，`outline plan`展示粗大纲，用户确认后`confirm`。
2. `generate`只提交一次，立即保存runId/jobId；文案逐章可读，关联复核继续。
3. 文案任务结束导出固定版本MD、DOCX，返回`delivery.markdownPath/docxPath`，此时先交用户。
4. `delivery.jobId`为独立HTML作业。宿主发完成通知后`job_output`收取HTML，不扣留文档等待HTML。
5. 有`needs_input`仍交真实状态和材料卡，不把缺正文的章节算成完成。

MD/DOCX确定性导出，无额外写作调用。HTML提炼只选原文关键句，每批约6000字符、每页最多3个要点；条件、候选和能力归属保留。模型不可用或输出越界则保留原文分页并记录warning，不称已经完成精简。不会从skill引入新客户、数字、资质或功能事实。

演示主题：`editorial`、`swiss`、`blueprint`。方向键/上一页/下一页自由翻页，F或全屏按钮进入全屏，来源按钮查看原文及引用。单文件内嵌样式与引擎，无远程脚本/CDN；中文使用系统字体，DOCX建议安装思源黑体或可用中文字体。

## 单独重试或重新输出

调用`wlyd_assembly_output`：

```json
{"run_id":"真实生成runId","action":"start","format":"all","theme":"editorial"}
```

- `action=query`：只查当前产物、jobId、源文案哈希、stale，不重写正文。
- `action=cancel`：仅停止HTML作业，文档/文案保留。
- `format=documents`：只导出MD/DOCX；`all`或`html`会先确保文档存在，再生成HTML。
- 同版同主题作业/产物默认复用；失败后可重试，`retry=true`显式新建输出版本。
- 同版换主题复用已保存slides.json，不调用知识库或精简模型。
- `expected_content_sha256`可防止导出期间选错文案版本，变化就拒绝而不是默默换稿。

改正文、引文、能力边界、章节版本、确认或复核状态，旧输出会标`stale=true`；HTML进行中也不会回写report。旧任务完成输出仍标旧版本，不把较新输出指针改回去。只改主题不改变文案哈希。当前不自动重绘所有旧输出；用户选新版本输出即可。

## 文件与边界

```text
run.json / report.json            文案运行与主记录
delivery.json                     最新输出版本指针
outputs/<exportId>/
  content.json                    固定文案快照
  document.md / document.docx      文档
  slides.json                     原文映射、精简要点、主线、skill执行摘要
  presentation.html               演示
  manifest.json                   状态、路径、源版本和错误
  model-requests.json              独立演示模型指标，不混进文案请求记录
```

`src/content/`不依赖输出层；`rules/`不导入主题和动画。输出层读取快照，不能改原文。`vendor/xiaoma-studio/UPSTREAM.json`记录固定commit与逐文件SHA-256，保留MIT许可证；随包实际读取规则和引擎，不依赖开发电脑的全局skill或旧插件。

导出前重新检查用户、原始输入摘要、知识库授权、归档和正文引用；缺归档不静默放行。权限与文档版本检查并不等于后端不可变知识版本管理，原文内容的业务正确性仍需用户审阅。

HTML独立job由宿主管理，关电脑/退出DSH不会继续；取消/进程中断保留文档，`query`识别已消失作业，可重试输出。文案恢复仍用原generate resume，两条链路分别管理。

## 会话侧减少等待开销

本机DSH源码已有`tool-jobs`完成通知、`job_output`有界等待，不需重写任务平台。编排skill已随包注册，在工具可用时按以下约定使用：

- 不用Bash sleep或多代理轮询。已提交后等待宿主通知；只在用户主动查询时读status。
- 确需等一次：`job_output {job_id,wait:true,timeout_ms:60000}`；超时返回running不取消任务，也不以重复思考代替宿主等待。
- `status`返回的模型文本默认摘要，完整结构和modelRequests不进入普通查询；`after_revision`无变化仅小回复，有历史快照时返回差异。`view=detail`显式取完整记录，不用于常规编排。
- 规划只复用同输入的有效已确认planId；目录、目标、材料、权限、规则变化重新确认。没有新增自动跨知识版本缓存，不能只按项目+受众命中。
- 编排会话快路由由DSH已有模型设置选择，插件不改用户默认模型。为使文案不随会话降级，可单独配置角色路由：

```json
{"writingRoute":{"provider":"已配置提供方","model":"写作模型ID"},"presentationRoute":{"provider":"已配置提供方","model":"演示提炼模型ID"}}
```

对应环境变量`WLYD_ASSEMBLY_WRITING_ROUTE`、`WLYD_ASSEMBLY_PRESENTATION_ROUTE`值为JSON对象。角色路由查询模型声明的低思考选项；不能保证网关实际执行。MD/DOCX不调用模型。未配置角色路由时保留原会话行为，本轮没有改用户profile或宣称已切快模型。

## 仍未覆盖

真实业务知识库完整生成与模型精简、Windows/Word版式、用户演示观感尚需验收。缺事实时仍是材料卡；新诊断不能代替真实缺章根因定位。DOCX与HTML是输出物，没有图形编辑器、PPTX/PDF、海报或视频导出；后续这些适配器可复用content.json。

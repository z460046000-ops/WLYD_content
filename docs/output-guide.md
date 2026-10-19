# 文档与演示输出

源码0.11.1。2026-10-19已安装并重启当前3080（web profile），插件enabled/active；3081仍0.10.1且本次未重启。文档清理、HTML概括和手动两SVG已加载，真实模型效果仍待验收。

0.10.1修复了空卡池恢复、空章一次补写、HTML乱序容错与有效重试；程序故障显示“生成故障”，不计为待补材料。普通换主题继续复用，显式`retry=true`会重新调用演示提炼模型。

## 默认流程

1. 选择知识库，`outline plan`展示粗大纲，用户确认后`confirm`。
2. `generate`只提交一次，立即保存runId/jobId；文案逐章可读，关联复核继续。
3. 文案任务结束导出固定版本MD、DOCX，返回`delivery.markdownPath/docxPath`，此时先交用户。
4. `delivery.jobId`为独立HTML作业。宿主发完成通知后`job_output`收取HTML，不扣留文档等待HTML。
5. 有`needs_input`仍交真实状态和材料卡，不把缺正文的章节算成完成。

桥接提示词在`prompts/outputs/presentation.md`：从DOCX/Markdown中按章提取关键信息、精简句式，再交xiaoma-studio生成客户翻页HTML。实现使用与两份文档同版的内容快照，避免重新解析文件或改动原稿。

MD/DOCX确定性导出，不增加模型调用；完整正文保留，逐段“依据：[来源…]”及重复审核提示集中到末尾“来源与审核附录”，包括段落→来源映射、章节版本/确认状态、审核记录和引文。历史正文只清独立机械标签，不全局删除“未/待确认”；典型场景假设、规划、试点、第三方和需授权等含义保留，原report/content快照不变。

HTML每批约6000字符，模型一次返回`slides[{title,points[{text,sourceBlockIds}]}]`，允许概括、归并和略去次要段落。章节文案软目标约原文35%，页数按目标估算；通常短标题12–20字、要点15–35字。硬容量为标题36字、每点90字、每页3点/200字。不按固定页数截断；软目标未达标记录warning供迭代。

schema=2拒绝旧版整句计划；原文及审核身份完整留在来源面板，不在每页反复显示“待用户确认”等机械提示。来源条件用自然短句显示，原文中的实质条件不因简化被抹去。`summaryMetrics`与`batches`记录输入/可见文案字符（含必要限定）、概括/原文页数、未上屏段落与主线编号；未选编号提示审阅关联覆盖。

所用来源的数字/英文名称、否定/授权/规划边界及明显无关新能力做有限规则筛查，未做完整语义证明，不增加第二轮模型审核。模型不可用或校验失败时仅该批保留原文分页并记录warning，不称已经概括；原文退路逐字保留有效正文和尾部。重复原句可正常落盘。概括仍标`semanticStatus=draft_unverified`，实际重点和前后关系需审阅。

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

## 手动生成业务/产品两张SVG

文案任务结束后调用：

```json
{"run_id":"真实生成runId","action":"start","format":"diagrams"}
```

返回独立`jobId`，用宿主通知/`job_output`收取；查询与取消也传`format=diagrams`。不依赖HTML是否完成，保留现有文档和HTML指针。两图各有状态；`diagramsReady=true`仅表示两张SVG已通过结构检查，`semanticStatus=draft_unverified`、`visualReview=pending`仍要求本次图片人工审阅。

- 从固定文案快照选业务/产品架构章；没有该角色时，选择业务挑战/场景、技术平台等相关章。不从公司或政策章节补造架构。
- 按约6000字符分批提炼，名称须可定位原文；关系只接受同片段可定位两端与关系词的候选。材料条件、能力状态与来源保留在plan，图上显示候选/试点/第三方等状态。
- 无模型或提炼失败用原文摘录卡，长文按48字拆卡，不冒充已完成架构设计；缺少相关正文返回`needs_input`。布局/校验错误明确报失败，原文档保留。
- `retry=true`重做两图；同版完成结果复用，正文变化标`stale`。本批两图依次生成，自动并行、HTML嵌图与只重试单图待第二批。
- SVG使用固定浅色主题，`theme`仅用于HTML。实际引擎为随包的fireworks静态子集，不依赖全局skill；Python3.9+标准库即可，未接PNG/GIF/统一CLI。
- `diagramPython`或`WLYD_ASSEMBLY_DIAGRAM_PYTHON`指定Python；图模型复用`presentationRoute`，未配时依次回退`writingRoute`、会话模型。`diagram`阶段支持已有超时/预算配置，未修改本机路由。

```text
diagram-delivery.json              最新两图版本指针，与delivery.json独立
diagrams/<exportId>/
  content.json                    同版固定文案
  business.plan.json / product.plan.json  来源、条件、节点与候选关系
  business.svg / product.svg       校验后公布的两图
  *.fireworks.json / *.layout.json 引擎输入与检查报告
  manifest.json / model-requests.json  独立状态与模型记录
```

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

# DSH 材料与知识组装插件

独立 DSH/Cordis 插件。输入工作区文件或当前 DSH 会话附件，逐文件提取 Markdown；在目标项目及其绑定知识库唯一、且当前平台配置账号可访问时默认上传。按版本化章节规则，从本次材料和授权知识片段组装带引文的 `report.md`/`report.json`。本项目不依赖旧售前插件、旧文案插件或 HTML Anything。

## 项目目录

| 目录 | 用途 |
|---|---|
| `rules/global.json`、`rules/style.json` | 全局事实纪律与写法原则；不含案例事实 |
| `rules/templates/` | 方案类型的默认目录；目前只有“产品售前解决方案” |
| `rules/chapters/` | 按语义角色绑定的提取、撰写、校验和缺失规则 |
| `src/convert.js` | 格式识别、限额、逐文件转换状态 |
| `src/platform.js` | 内容中台登录、项目绑定、上传和 chunk 检索 |
| `src/workflow.js` | 导入、证据组装、模型生成、引文校验、运行记录 |
| `src/index.js` | 独立 DSH 工具注册 |
| `test/`、`docs/` | 定向测试与来源、复用、测试记录 |

未来可新增另一种方案模板，复用章节角色或增加新的角色规则。用户通过对话修改目录时，先用目录工具预览，再将确认后的目录传给生成工具；`key` 是稳定标识，`roleId` 决定规则。自定义章节须补目标、读者、问题、证据范围和验收条件。当前目录确认由对话完成，尚无平台前端专用的版本审批界面。

## 安装

需要 Node.js 22+ 和 DSH。安装包见 `releases/wlyd-dsh-material-knowledge-assembly-0.1.0.tgz`。

```bash
dsh plugin --profile <profile> add /absolute/path/to/wlyd-dsh-material-knowledge-assembly-0.1.0.tgz
dsh --profile <profile> --dump-config
```

插件 Cordis ID 为 `wlyd-material-knowledge-assembly`；工具前缀为 `wlyd_assembly_`。平台配置可放 DSH 插件 config、进程环境变量或 `$DSH_HOME/.env`：`WLYD_PLATFORM_BASE_URL`、`WLYD_PLATFORM_EMAIL`、`WLYD_PLATFORM_PASSWORD`、`WLYD_PLATFORM_TENANT_ID`。不要把凭证提交到仓库。配置账号权限与真实 DSH 用户身份尚未打通。

## 使用

1. 用 `wlyd_assembly_projects` 查看可访问项目。把文件拖入 DSH 后，调用 `wlyd_assembly_ingest`，传工作区 `files` 或当前会话的 `attachment_refs`。多项目或多知识库时指定用户选中的 ID。
2. 工具返回 `runId`。`converted` 表示本地 Markdown 已生成；`pending`/`processing` 表示后台仍在解析。用 `wlyd_assembly_status` 查询。`needs_ocr`、`unsupported`、`failed` 不能当作已入库。
3. 用 `wlyd_assembly_outline` 预览默认目录；若用户要求调整，确认修改后的目录。调用 `wlyd_assembly_generate`，传 `source_run_id`，可选传 `project_id`、`outline` 和 `audience`。
4. 每次运行写入工作区 `artifacts/material-knowledge-assembly/runs/<runId>/`，含 `materials/*.md`（导入运行）、`evidence.json`、`report.md`、`report.json`、`run.json`（生成运行）。报告状态为 `needs_human_review`，需用户核对来源、内容和缺口。

同事可复制的测试提示词：

> 请把我刚上传的产品说明文件转成 Markdown；若当前账号只有一个可访问项目和一个绑定知识库，就同步进去，否则列出选择项。解析完成后按“产品售前解决方案”默认目录预览章节。经我确认，再用本次材料和授权知识片段生成带逐字引文的报告，并告诉我哪些章节缺资料。

## 当前边界

- 支持 UTF-8 文本、DOCX、文字 PDF、PPTX、XLSX、限额 ZIP；图片与扫描 PDF 返回 `needs_ocr`。DMG 返回 `unsupported`，不挂载也不运行应用；旧 Office、音视频和链接抓取尚未实现。
- 只使用已完成解析的项目绑定知识文档；HTTP 202 仅代表上传已接收。多目标须指定，不会自动选公共库。
- 仅从可信 DSH 会话结构填 `actorDshId`；`platformUserId` 暂为空。当前平台 API 用配置账号登录，不能声称后台已按真实用户归属上传。
- 模型只通过引用 ID 与逐字引文做机器校验；语义是否被证据充分支持、案例是否可公开仍需人工审核。无可核对正文时不交付空稿。
- HTML 编辑、PPTX/PDF 输出、全景图视觉规则和“客户解决方案”模板等待后续材料，不在本版。
- 公开资料检索、逐章对话扩写/缩写、平台前端目录版本审批尚未接入；缺内容时只报告缺口，不自动补事实。

规则来源与限制见 [取样记录](docs/mvp-rule-evidence.md)、[架构与调度](docs/architecture.md)、[复用边界](docs/reuse-audit.md)、[测试记录](docs/test-record.md)。

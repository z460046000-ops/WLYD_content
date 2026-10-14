# 项目记忆

## 2026-10-14：独立 DSH 插件 MVP

- 用户优先级：先从完整 goodcase 提炼可审查的 MVP 章节规则，再复用交接包中干净的技术路径，最后搭建独立插件。整份 goodcase 可直接学习，用户无需先重排成六章。当前规则是候选方法，不是有输入输出配对的模型训练。
- 此仓库 `WLYD_content` 原先只有初始 README；本会话将其克隆为独立项目。原始参考项目只用于读资料和初步开发；未将旧插件或 goodcase 原件放进本仓库。
- 六章只绑定“产品售前解决方案”默认模板，角色规则与目录解耦。已逐页扫描自有方案 30 页文字层、DHR 149 张与 BIP 156 张幻灯片文字层，新增可选 `delivery-service` 角色，不改六章默认目录。客户解决方案默认目录、全景图视觉例子待用户提供。HTML 编辑与 PPTX/PDF 导出本版不做。
- DSH 工具 `wlyd_assembly_projects/ingest/status/outline/generate`，输出材料 Markdown、证据、报告和运行记录，规则哈希可追溯。图片与扫描 PDF 需 OCR；DMG、旧 Office、音视频和链接未打通。真实 DSH 用户身份与平台上传人未映射。
- `npm run check` 与 7 个定向测试通过；真实后端只读项目和 chunk 检索已联通。实际上传、WebUI 附件和真实模型成稿待验证。详见 `docs/test-record.md`。

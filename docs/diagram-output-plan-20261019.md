# 两张架构图与HTML并行输出方案

状态：0.11.0完成第一批手动两SVG，待安装；3081仍为0.10.1，未重启。下述并行与HTML合版是第二批目标，不表示已实现。

## 第一批实际交付

- 手动`wlyd_assembly_output format=diagrams`，从固定正文提炼两图，独立宿主job内依次渲染；不改变文案、文档或HTML。
- 共享既有授权检查；记录来源、条件、状态、文案哈希，支持过期提示、完整产物缓存和整对重试。
- 实际调用随包`vendor/fireworks-tech-graph/scripts/generate-from-template.py`的architecture路径，通过标准输入送JSON；不是完整skill/统一CLI。保留MIT、固定commit和逐文件摘要。
- 模型失败/漏片段保留短原文摘录卡；没有相关正文为needs_input。图为待复核初稿，不以词面匹配证明业务关系。
- 第二批再实现自动并行、HTML嵌图和单图重试。Python3.9+为声明最低版本，实跑3.11.3；PNG/GIF未接。


## 用户确定的职责

- **diagram-design：提炼设计规范。** 形成独立的[绘图提示词](../prompts/outputs/diagrams.md)，重点是语义、层级、对齐、留白、克制配色、连线和中文可读性。
- **fireworks-tech-graph：默认绘图引擎。** 插件把相关文案和主线转为结构化图数据，再映射至其architecture JSON，生成SVG和检查报告。
- **xiaoma-studio：整份HTML演示。** 同时提炼关键点、准备版式，最终装入两张SVG；不负责重新定义业务架构或产品功能。

每张图默认只走一次fireworks生成，不新增diagram-design重画阶段。两份完整skill的规则不同时灌入模型；按任务加载精简设计规范和必要引擎字段。

## 流程与边界

```text
知识库取材 → 粗大纲人工确认 → 全文组稿和前后关联检查
                         ↓ 固定文案快照与源版本
                         ├─ 先交MD/DOCX
                         ├─ 提取两图所需材料 → 业务图 / 产品功能图并行绘制
                         └─ HTML关键点提炼与排版
两图任务终态 + HTML版式 → 图文合版 → 翻页HTML
```

图材料只取相关章节和跨章主线，记录原段落及能力/场景编号。图数据保留完整节点、分组、关系、条件、能力状态和来源映射；绘图样例不作为产品事实。层数和分类由本次内容决定，不能把云部署、C4或RAG样例直接套作业务全景。

文案完成后自动启动输出，不新增一次全文人工确认作为必经等待；用户仍可后续改单章。各分支绑定同一文案哈希，旧任务不覆盖新稿。默认SVG，PNG是另行可选输出；动效不进入首版。

单图失败保留文档、另一图和可用文字HTML，明确缺图状态；重试只处理失败图，图补齐后只合版。文字修改后根据受影响内容重做输出，颜色变化不重新检索或重写正文。异步任务仍受DSH宿主生命周期及共享并发额度约束。

## 规范提炼方式

保留diagram-design的通用设计方法，按中文客户演示场景调整：

- 保留语义优先、层级清楚、统一对齐、适度留白、少量强调色、连线避让和实际产物检查。
- 用语义颜色角色及中文字体栈承接主题；不绑定上游特定英文字体、橙色皮肤或背景材质。
- 节点数量作为密度提示；完整图数据、功能覆盖和前后对应不因固定数量限制被删除。
- 不引入每次出图先做品牌问答、默认三套版本、动画或多轮自我改写。视觉修正保持有界，失败不阻断文档交付。

这些是本项目的适配决定，并非声称fireworks已原生实现diagram-design全部规范。[绘图提示词](../prompts/outputs/diagrams.md)已由图材料提炼阶段单独加载。

## 原生能力与依赖

fireworks完整技能目录是`skills/fireworks-tech-graph/`，统一脚本`scripts/fireworks.py`提供`validate/render/check/export-html`。architecture的SVG路径使用Python 3.9+与随包模块；PNG另需CairoSVG或rsvg-convert，GIF有额外浏览器和媒体依赖。本方案先接静态SVG。能力探测应按具体capabilities判断，不能仅凭缺少PNG渲染器导致的doctor非零退出而拒绝SVG。

实际引擎配置须按其schema映射；首版拟用通用浅色style 4，再通过白名单token适配本项目主题。不能把本项目的抽象`palette/font/layout`当成上游已经支持的同名顶层字段。

| 本项目规范 | fireworks实际接口 / 适配责任 |
|---|---|
| 背景、文字、边框、强调色、圆角 | `style`/`visual_theme`选主题，`style_overrides`覆盖实际token；其中`arrow_colors`为浅层覆盖，须保留完整键集合 |
| 中文字体、字号分级 | `style_overrides.font_family`；整图标题字号与节点`title_size`分别配置。分组/副标题/线标签并非全部可配，需核对或有明确适配，不能宣称已整体支持 |
| 层次、间距、对齐、分区、留白 | 适配层根据结构计算画布与节点/容器的坐标和尺寸；`auto_place`只补纵坐标，不等于完整自动布局 |
| 关系和正交走线 | source/target及端口、route_points、flow、虚线和线宽映射；不靠猜测布局位置生成语义关系 |
| 完整标签与版式检查 | 选择原生`text_policy: strict`和适用的`quality_profile: showcase`，检查原始报告，并实际查看中文渲染 |

字段依据为固定提交的[生成器](https://github.com/yizhiyanhua-ai/fireworks-tech-graph/blob/31fea364eda5f1852b1175f3d9e29ea31d22dcb4/scripts/generate-from-template.py)。第一批已实跑固定浅色、中文字体栈、分组和连线；任意主题、复杂跨组关系和最终HTML嵌入仍待验证。

## 实施步骤和验证

| 步骤 | 影响范围 | 最小验证 |
|---|---|---|
| 1. 固定依赖与设计投影 | vendor新引擎资源、输出提示词 | 固定commit与MIT，必要脚本齐全；只读当前图所需规则 |
| 2. 文案转图数据 | 新增outputs/diagrams材料及结构适配器 | 两图共用业务/能力编号；节点与关系回到正文；不补造无据功能 |
| 3. fireworks渲染 | 图数据映射、进程调用及SVG检查 | 实际生成两张SVG；长中文名称、分组、连线、无交叉或裁切等按实际产物核对 |
| 4. 并行任务与HTML合版 | delivery任务/manifest、HTML图页 | 两图与HTML准备有并行时间；一图失败不取消其他交付；SVG的ID、字体、尺寸与页面隔离 |
| 5. 恢复、版本与发布 | 状态、重试、文档和安装包 | 失败图单独重试；改文案标旧图过期；更新后真实模型/DSH及中文视觉验收 |

最容易出错的是：文案与图片版本不一致；概念图被误画成调用拓扑；长中文被隐藏截断；两图的SVG ID/CSS互相干扰；引擎几何通过被误报为视觉和业务正确。这些均需实际链路验证，不能以读过README替代。

## 上游依据及核对状态

2026-10-19通过官方GitHub API核对主分支，下列为本次固定快照，fireworks静态所需子集已vendor进插件；未安装到DSH：

| 来源 | 阅读快照 | 使用范围 |
|---|---|---|
| [diagram-design](https://github.com/cathrynlavery/diagram-design) | `550fd66edff058bc73056c3416b76d69cfe865ba`；[SKILL](https://github.com/cathrynlavery/diagram-design/blob/550fd66edff058bc73056c3416b76d69cfe865ba/skills/diagram-design/SKILL.md)、[style-guide](https://github.com/cathrynlavery/diagram-design/blob/550fd66edff058bc73056c3416b76d69cfe865ba/skills/diagram-design/references/style-guide.md)、[output-spec](https://github.com/cathrynlavery/diagram-design/blob/550fd66edff058bc73056c3416b76d69cfe865ba/skills/diagram-design/references/output-spec.md) | 归纳通用设计方法；[MIT许可](https://github.com/cathrynlavery/diagram-design/blob/550fd66edff058bc73056c3416b76d69cfe865ba/LICENSE) |
| [fireworks-tech-graph](https://github.com/yizhiyanhua-ai/fireworks-tech-graph/blob/main/README.zh.md) | `31fea364eda5f1852b1175f3d9e29ea31d22dcb4`；[完整SKILL](https://github.com/yizhiyanhua-ai/fireworks-tech-graph/blob/31fea364eda5f1852b1175f3d9e29ea31d22dcb4/skills/fireworks-tech-graph/SKILL.md)、[CLI](https://github.com/yizhiyanhua-ai/fireworks-tech-graph/blob/31fea364eda5f1852b1175f3d9e29ea31d22dcb4/scripts/fireworks.py) | JSON到SVG和结构/几何校验；[MIT许可](https://github.com/yizhiyanhua-ai/fireworks-tech-graph/blob/31fea364eda5f1852b1175f3d9e29ea31d22dcb4/LICENSE) |

第一批已实跑原生生成器和五项检查，保留对应版权、MIT、上游文件摘要和裁剪范围；无新增pip/npm依赖。样图只验证引擎与适配，不代表真实模型、知识库或客户验收。

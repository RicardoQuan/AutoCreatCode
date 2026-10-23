# Task 编辑器 WebUI

此目录是可单独移植的 WebUI。外部浏览器和 WinForms WebView2 加载同一份页面与脚本，界面操作保持一致。

流程图和枚举表是同一级工作区：在顶部“视图”菜单切换“流程图画布 / 枚举表工作区”；顶部“枚举表”菜单提供工作簿新建与导入。切换工作区不会关闭 Task 或清空 Sheet 编辑内容。

## 启动与移植

- 浏览器：运行 `OpenInBrowser.cmd`。启动器在 `127.0.0.1` 上开启本地静态服务，再打开浏览器；关闭页面后服务会在空闲一段时间后退出。不要直接双击 `index.html`，Monaco 需要 HTTP/HTTPS 来源来创建编辑器 Worker。
- WinForms：程序从 `EquipmentFlowEditor\index.html` 加载页面；修改 WebUI 后，重新生成/复制该静态目录即可更新内嵌版。
- 移植：整体复制 `WebEditor` 文件夹，保留 `vendor\monaco`；发布包会附带自包含的 `tools\csharpier`。仓库不携带具体机台/客户的 `Samples` 和 Task 模板，用户可以从界面导入自己的模板与项目。运行时不需要联网、安装 Node.js 或单独安装 .NET 8。
- 外部浏览器与 WebView2 的本地存储彼此独立。使用“保存项目”导出的 `*.TaskProject.json` 可以在两边打开并继续编辑。

## Task 管理与暂存

- 点击顶部“＋”或“Task 管理 → 新建 Task”，输入 C# 类名。使用模板创建 Task 时也会弹出同一命名框，并同步重命名模板中的 Task partial 类。系统同时建立 Task 主文件和方法 partial 文件的数据模型。
- 删除当前 Task 时会弹出确认框，同时删除对应流程、方法和本地项目中的编辑内容。
- “保存项目”第一次会弹出路径选择并保存项目 JSON；之后再次保存会覆盖该文件。“项目另存为”可改存到新路径。已选路径会在当前浏览器 / WebView2 来源下记住；也可用“文件 → 打开暂存项目 JSON”切换项目。
- “文件 → 生成当前 Task 源码”生成两个 `.cs` 文件：`TaskName.cs` 与 `TaskName_Methods.cs`。可以给每个 Task 指定输出目录；批量生成时默认按 Task 类名建立子目录。
- Task 模板 ZIP 可先预览，再创建 Task。为保持公开仓库中的示例通用，模板文件由使用者从界面导入，不随源码仓库发布。

## 流程图与代码生成

- 每个 Task 只对应自己的 AutoRun 画布；流程图按从上向下组织。
- 工具栏支持选择、平移、连线、开始/运行/判断/等待/报警/结束节点、撤销、重做、复制、粘贴、删除、网格、吸附、缩放和向下整理。
- Draw.io 文件可导入或导出，节点、方法绑定、分支和连线布局由当前 Task 维护。
- 生成的 Task 文件按画布节点生成 `protected enum Step`，并生成重写的 `AutoRun()`；所有开始节点枚举值为 10，所有结束节点为 9999，其他节点从 20 起递增。多个结束节点共用一个 `AutoRun` 分支；节点切换使用 `SetStep(ref StaInfo, Step.节点名, true)`，结束后复位到 0。Task 方法按分类合并到对应的 `#region`。
- 流程、方法库、硬件库和枚举生成的 `.cs` 文件会在写入前由随 WebEditor 打包的 CSharpier 1.3.0 格式化。批量生成先格式化完整个文件清单，再开始写入；成功弹框列出保存路径，并可打开每个输出目录。
- `tools\csharpier-formatter` 保存格式化助手源码；更新或重新发布它需要 .NET 8 SDK 和 NuGet 包还原。最终运行包发布在 `tools\csharpier`，包含 .NET 8 运行时。
- 生成的 `AutoRun()` 直接采用 `TaskBase_MoverStation` 的步序切换约定。导出的代码仍需在目标 C# 工程中完成构建验证后再上机。

## 方法 partial

- “新增函数”对话框可设置方法名、`private/public`、返回类型、方法分类、输入参数、`out` 参数和 `int` 状态码，并编辑方法体。编辑区使用本地打包的 Monaco Editor（VS Code 的浏览器编辑器组件），支持滚动、编辑、语法着色、括号配对、缩进、撤销重做和按当前方法/硬件名称生成的补全；右键菜单提供 CSharpier 风格的代码整理。补全不是 Roslyn 语义分析，也不会编译或运行 C#。
- Monaco 固定为 `vendor\monaco\VERSION.txt` 中的版本；使用 ESM 运行时和本地 Worker，MIT 许可和第三方声明随 `vendor\monaco\LICENSE`、`ThirdPartyNotices.txt` 一起分发。独立浏览器请运行 `OpenInBrowser.cmd`；不要直接打开 `index.html`，因为浏览器会限制 `file://` 页面启动编辑器 Worker。
- 运行时不需要 Node.js 或网络连接。维护 Monaco 版本时，在 `tools\monaco-build` 安装锁定的开发依赖后运行 `build.ps1`，重新生成 `vendor\monaco` 中的离线文件。克隆源码后，需按根目录的浏览器开发文档生成 CSharpier 格式化器。
- `void` 方法表示顺序执行，`bool` 方法使用判断图形与 `true/false` 分支，`int` 方法使用运行图形与配置的整数状态分支。
- 导入一个或多个 `.cs` 后按“文件 → 类 → 方法”显示；导入源码只解析，不编译、不执行。
- 方法只能通过拖拽加入画布或绑定节点；单击只选中方法，右键可编辑。编辑导入方法后会保留源码中已有的 C# 特性声明。

## 两套互不相通的 Region

- 方法面板中的“Region 管理”只维护当前 Task 的方法分类，并决定 `TaskName_Methods.cs` 中的方法 `#region`。可以添加、重命名和删除未使用的 Region。
- 枚举工作区中的“Region 管理”只维护当前枚举工作簿的 Region，并决定生成的 `EnumName.cs` 区块。每个 Sheet 选择自己的枚举 Region。
- 两边数据分别保存在 Task 与枚举工作簿中；修改、添加或删除一侧的 Region 不会影响另一侧。

## 枚举工作簿

- 顶部“枚举表”可新建工作簿、导入 `.xlsx/.csv/.tsv`，每个 Sheet 是一张枚举表，并选择 Input、Output、Axis、ParName 或通用枚举类型。
- 可编辑命名空间、C# 类型名、Region、成员名、显式整数值和注释；“生成 EnumName.cs”按枚举工作簿的 Region 合并输出。
- 每个 Sheet 可分别设置 Excel 文件名与 Sheet / C# 类型名；导入时也可分别编辑这两个名称。“保存 Sheet Excel”会将每个 Sheet 单独保存为一个 `.xlsx`，并弹出文件清单；“Sheet Excel 另存为”先选择保存目录，再按各 Sheet 的文件名分别生成文件。Excel 内容和文件名也会随 Task 项目 JSON 暂存。
- 当前离线表格重点支持枚举数据的导入和编辑；不承诺保留 Excel 的公式、宏、图表或复杂单元格样式。

## 硬件源码库

- 硬件面板可导入 `.cs`，按源码展示枚举资源、吸嘴工厂和工位/吸嘴绑定槽位。
- 吸嘴数量从吸嘴工厂声明读取；无法静态确定的动态数量显示为动态/未解析。
- 轴、IO、传感器和吸嘴的实际实例仍由既有 C# 机种加载流程创建。后续 Excel 入口用于 IO/轴表格与 `EnumName.cs` 枚举生成，不再用于设备流程。

## 界面

- 支持浅色/深色主题、12–20 px 字号、左右侧栏隐藏、停靠与悬浮；左右侧栏可拖到屏幕边缘停靠。
- 普通浏览器右键菜单已关闭；方法和画布节点/连线使用设备编辑操作菜单。

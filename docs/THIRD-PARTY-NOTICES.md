# 第三方组件说明

AutoCreatCode 使用以下第三方组件。组件许可只覆盖各自的组件，不改变 AutoCreatCode 项目本身的许可状态。

| 组件 | 用途 | 许可与来源 |
| --- | --- | --- |
| Monaco Editor | 浏览器内 C# 编辑器 | MIT；随 src/AutoCreatCode/WebEditor/vendor/monaco/LICENSE 和 ThirdPartyNotices.txt 分发 |
| CSharpier.Core 1.3.0 | 格式化生成的 C# 代码 | MIT；随发布包的 CSharpier.LICENSE.txt 与第三方声明分发 |
| Microsoft.Web.WebView2 1.0.4258.31 | 桌面宿主内嵌浏览器 | Microsoft WebView2 SDK；使用 Microsoft 官方 NuGet 包 |
| .NET Framework 4.8 | WinForms 桌面宿主运行环境 | Microsoft 官方离线运行库 |
| WebView2 Evergreen Runtime | WebView2 页面运行环境 | Microsoft 官方离线安装程序 |

安装包中的微软依赖由 installer/Build-Installer.ps1 从微软官方链接获取，并验证 Authenticode 签名。CSharpier 的源代码发布包包含在 src/AutoCreatCode/WebEditor/tools/csharpier-formatter。

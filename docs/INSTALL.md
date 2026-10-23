# 安装、卸载与离线依赖

## 系统要求

- 64 位 Windows 10 或 Windows 11。
- 管理员权限，用于安装缺少的系统运行库和写入程序目录。
- 安装过程不要求联网。

## 安装

从 [GitHub Releases](https://github.com/RicardoQuan/AutoCreatCode/releases) 下载 AutoCreatCode-Setup-v1.0.exe 并运行。安装包会：

1. 如果系统没有 .NET Framework 4.8 或更高版本，安装随包提供的 .NET Framework 4.8 离线运行库。
2. 如果系统没有 WebView2 Runtime，安装随包提供的 x64 Evergreen Standalone Runtime。
3. 安装 AutoCreatCode 和自包含的 CSharpier 格式化器。
4. 在桌面和开始菜单创建 AutoCreatCode 快捷方式。

安装完成后可直接使用桌面图标启动独立窗口，不会打开 CMD。程序安装在 C:\Program Files\AutoCreatCode。如果 .NET 安装程序要求重启，完成安装后请先重启 Windows 再启动程序。

## 卸载

使用“设置 → 应用 → 已安装的应用”卸载 AutoCreatCode，或运行程序目录中的卸载脚本。卸载会移除应用文件和快捷方式，不会删除通过程序保存的项目文件或 WebView2 用户数据。

## 离线依赖

安装包内含微软官方的 .NET Framework 4.8 离线安装程序和 WebView2 Evergreen Standalone Installer。安装器只有在目标电脑缺少相应运行库时才调用它们。CSharpier 以 win-x64 自包含单文件方式打包，运行时不要求额外安装 .NET 8。

WebView2 Evergreen Runtime 是共享运行库，并按微软的更新策略维护。离线安装本身不需要联网；之后的运行库更新由 Windows / Microsoft Edge 更新机制处理。

下载源和签名校验位于 installer/Build-Installer.ps1。微软的分发说明见：

- [.NET Framework 4.8 离线安装说明](https://learn.microsoft.com/en-us/dotnet/framework/whats-new/#introducing-net-framework-48)
- [WebView2 Runtime 分发说明](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)

## 浏览器版

如需浏览器中的开发模式，运行 src/AutoCreatCode/WebEditor/OpenInBrowser.cmd。浏览器版和桌面版读取同一份 WebEditor 源码；两种浏览器环境的本地存储各自独立。

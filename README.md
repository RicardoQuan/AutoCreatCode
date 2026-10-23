# AutoCreatCode

AutoCreatCode 是一个以浏览器为主要开发和优化入口的流程编辑器。HTML、CSS、JavaScript 与本地 Monaco 编辑器构成唯一的界面实现；Windows 桌面版通过轻量的 WinForms + WebView2 窗口加载同一套页面，不另做一套原生编辑器。

## 获取 V1.0

- [下载 Windows 离线安装包](https://github.com/RicardoQuan/AutoCreatCode/releases/download/v1.0/AutoCreatCode-Setup-v1.0.exe)
- [下载项目源码压缩包](https://github.com/RicardoQuan/AutoCreatCode/releases/download/v1.0/AutoCreatCode-Source-v1.0.zip)
- [查看全部版本](https://github.com/RicardoQuan/AutoCreatCode/releases)

安装包支持 64 位 Windows 10/11。首次安装时会自动补齐缺失的 .NET Framework 4.8 与 WebView2 Runtime，并创建桌面和开始菜单快捷方式。安装包离线包含这些依赖；后续安装不需要连接网络。

## 浏览器开发

从仓库克隆后，双击 src/AutoCreatCode/WebEditor/OpenInBrowser.cmd 可在浏览器中启动编辑器。WebEditor 是产品界面和功能的开发源头；修改 HTML、CSS、JavaScript 后，浏览器刷新即可查看效果。

更多说明见：

- [浏览器开发与版本更新](docs/DEVELOPMENT.md)
- [安装、卸载与离线依赖](docs/INSTALL.md)
- [第三方组件说明](docs/THIRD-PARTY-NOTICES.md)
- [版本记录](CHANGELOG.md)

## 项目结构

    src/AutoCreatCode/
      Program.cs                         Windows GUI 程序入口
      EquipmentFlowEditorForm.cs         WebView2 桌面宿主与本机文件桥接
      AutoCreatCode.csproj               桌面宿主项目
      WebEditor/                         浏览器版编辑器（界面唯一来源）
        index.html
        *.js
        *.css
        vendor/monaco/                   离线代码编辑器
        tools/csharpier-formatter/       CSharpier 打包助手源码

为保持发布项目通用，仓库不包含具体机台/客户的流程样例和方法库。编辑器仍可导入你自己的 .cs、Task 模板和项目文件。

## 许可证

本项目尚未指定开源许可证。公开仓库不代表授予复制、修改或再分发项目本身的许可。第三方组件各自的许可证见 docs/THIRD-PARTY-NOTICES.md。

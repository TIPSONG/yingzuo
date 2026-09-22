# GitHub 协作与项目跟踪

仓库：[TIPSONG/yingzuo](https://github.com/TIPSONG/yingzuo)，创建时为私有仓库。

- 开发代码与文档保存在 `main`；较大的功能改动使用独立分支和 Pull Request。
- [总览 Issue #1](https://github.com/TIPSONG/yingzuo/issues/1) 跟踪 P0–P7，阶段 Issue 记录任务、依赖、验收和实际结果。
- [里程碑](https://github.com/TIPSONG/yingzuo/milestones) 分为日常可用版、资源管理版、完整测试版。
- 开始一个阶段时记录实际范围，完成后附测试证据和已知限制；不把演示页面记为真实功能完成。
- 本地文档保存范围和估算依据，Issues 保存执行状态。范围或估时变化时同步两处。

## 本机 GitHub MCP

2026-09-22 已配置 [GitHub 官方 MCP Server](https://github.com/github/github-mcp-server) v1.12.2，官方 Windows 发布包经过 SHA-256 核对。

Codex 中的服务器名称是 `github`，启用账户上下文、仓库、Issues 和 Pull Requests 工具。启动包装器从 Windows Git Credential Manager 获取既有 GitHub 登录，只向官方服务器进程的内存环境传递令牌。源码仓库及 Codex MCP 配置不保存令牌。

这是开发设备上的配置，不是映作应用运行依赖，也不随项目仓库分发。其他设备需自行配置 GitHub 连接；已打开的 Codex 会话如未显示新工具，可重新加载 MCP 或在新会话中使用。

配置依据：[Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)、[GitHub MCP 配置文档](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md)。

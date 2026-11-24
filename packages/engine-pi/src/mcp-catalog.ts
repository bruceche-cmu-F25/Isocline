/** The connectors Zirma offers by name: remote MCP servers run by the service itself, each checked on the date
 * beside it (an unauthenticated `initialize`, and the authorization server's metadata). `oauth`: the server takes a
 * sign-in in the browser and lets a client register itself, so connecting is one click. `none`: it needs no account.
 * `token`: it takes a token the user makes at the service and pastes once; it is kept in the keychain.
 *
 * Anything else is added by address or command under "your own" in Settings.
 */
export interface McpCatalogEntry {
  id: string;
  title: string;
  url: string;
  auth: "oauth" | "none" | "token";
  about: { zh: string; en: string };
  /** For `token`: where the user makes one, and the header it is sent in (`{token}` is replaced). */
  token?: { page: string; header: string; value: string };
}

export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  // Checked 2026-11-19.
  { id: "notion", title: "Notion", url: "https://mcp.notion.com/mcp", auth: "oauth", about: { zh: "搜索、读和写你的 Notion 页面和数据库", en: "Search, read and write your Notion pages and databases" } },
  { id: "linear", title: "Linear", url: "https://mcp.linear.app/mcp", auth: "oauth", about: { zh: "查和改 issue、项目和周期", en: "Find and change issues, projects and cycles" } },
  { id: "sentry", title: "Sentry", url: "https://mcp.sentry.dev/mcp", auth: "oauth", about: { zh: "看报错、事件和发布", en: "Look into errors, events and releases" } },
  { id: "atlassian", title: "Atlassian", url: "https://mcp.atlassian.com/v1/mcp", auth: "oauth", about: { zh: "Jira 的 issue 和 Confluence 的页面", en: "Jira issues and Confluence pages" } },
  { id: "vercel", title: "Vercel", url: "https://mcp.vercel.com", auth: "oauth", about: { zh: "项目、部署和日志", en: "Projects, deployments and logs" } },
  {
    id: "github", title: "GitHub", url: "https://api.githubcopilot.com/mcp/", auth: "token",
    about: { zh: "仓库、issue 和 pull request", en: "Repositories, issues and pull requests" },
    token: { page: "https://github.com/settings/personal-access-tokens", header: "Authorization", value: "Bearer {token}" },
  },
  { id: "context7", title: "Context7", url: "https://mcp.context7.com/mcp", auth: "none", about: { zh: "各种库的最新文档和例子", en: "Up-to-date docs and examples for libraries" } },
  { id: "deepwiki", title: "DeepWiki", url: "https://mcp.deepwiki.com/mcp", auth: "none", about: { zh: "读懂公开的 GitHub 仓库", en: "Understand public GitHub repositories" } },
  { id: "huggingface", title: "Hugging Face", url: "https://huggingface.co/mcp", auth: "none", about: { zh: "找模型、数据集和论文", en: "Find models, datasets and papers" } },
];

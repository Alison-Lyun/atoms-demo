# Atoms Demo

通过自然语言创建单页应用，在同一项目内继续修改，并查看代码、保存应用数据、恢复已成功运行的代码版本。

工作台使用 Next.js 和 React。生成产物是包含 HTML、CSS、JavaScript 的单个 HTML 文档，通过受限 iframe 运行。模型调用、会话和持久化由服务端负责。

## 当前验证状态

截至 2026-09-18，**79 项单元与集成测试、类型检查、生产构建通过**。真实模型待办应用已完成首次生成、新增事项、云端保存、刷新恢复、同项目增加搜索、搜索交互及代码版本恢复；两次生成均无需自动修复。Supabase 已真实执行迁移并验证匿名会话隔离。更多应用类型与生产环境验收见下方记录。

- 在线工作台：https://atoms-demo-indol.vercel.app
- 源码：https://github.com/Alison-Lyun/atoms-demo

工作台按匿名浏览器会话保存项目；首次打开看到空工作区属于正常行为。

开发样例明确标为 fixture，只用于验证宿主预览与数据链路。完整记录和待验收步骤见 [docs/acceptance.md](docs/acceptance.md)。

## 本地启动

需要 Node.js 22 和 npm。在仓库根目录运行：

```bash
npm ci --legacy-peer-deps
cp .env.example .env.local
npm run dev
```

打开终端显示的本地地址，默认 `http://127.0.0.1:3000`。没有模型配置时仍可打开工作台；生成入口会提示配置未完成，不会用样例冒充生成结果。

在 `.env.local` 中设置模型配置，然后重启开发服务器：

```dotenv
MODEL_API_KEY=<自己的模型服务密钥>
MODEL_BASE_URL=https://your-gateway.example/v1
MODEL_NAME=<网关提供的模型标识>
MODEL_API_MODE=chat
STORAGE_MODE=local
```

上面的网关地址是占位示例，必须替换。当前适配器使用 AI SDK 的 OpenAI 兼容接口；`chat` 对接 Chat Completions，`responses` 对接 Responses API。Claude 需要经支持相应协议的网关接入，并验证结构化输出兼容性；这里没有原生 Anthropic Messages 适配器。

密钥只放在 `.env.local` 或部署平台的环境变量中。该文件已被 Git 忽略，浏览器不会收到模型密钥。完整变量模板见 [.env.example](.env.example)。

| 变量 | 用途 |
| --- | --- |
| `MODEL_API_KEY` | 服务端模型密钥；也兼容 `OPENAI_API_KEY` |
| `MODEL_BASE_URL` | 模型接口基础地址，默认 OpenAI API 地址 |
| `MODEL_NAME` | 服务提供方支持的准确模型标识 |
| `MODEL_API_MODE` | `chat` 或 `responses`，默认 `chat` |
| `STORAGE_MODE` | 本机用 `local`，云部署用 `supabase` |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 项目 URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key；兼容旧 `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| `ENABLE_DEV_FIXTURES` | 设为 `true` 才显示开发样例；生产模式禁用 |
| `MAX_GENERATIONS_PER_HOUR` | 每项目每小时的新生成任务上限，默认 20 |
| `LOCAL_DATA_DIR` | 本地数据目录，默认 `.data/` |
| `ATOMS_ALLOW_LOCAL_STORAGE` | 本机运行生产构建时显式允许文件存储；Vercel 不接受此降级 |

本地模式用 32 字节随机 HttpOnly cookie 标识会话，将 JSON 数据按会话隔离存入 `.data/`。关闭再打开应用后，同一浏览器会话仍可读取项目。清除 cookie 会失去该匿名会话的项目访问权。

## Supabase 配置

1. 创建 Supabase 项目，在 Authentication 的设置中启用 **Anonymous Sign-Ins**。
2. 在 SQL Editor 执行 [supabase/migrations/202609180001_initial.sql](supabase/migrations/202609180001_initial.sql)，也可通过 Supabase CLI 应用迁移。
3. 将 `STORAGE_MODE` 改为 `supabase`，配置项目 URL 和 publishable key。应用不使用 service-role key。
4. 重启服务，在两个独立浏览器会话中分别创建项目，验证列表及已知项目 ID 均无法跨会话访问。

五张表保存项目、消息、版本、运行状态和应用数据。表查询受 RLS 约束；写入通过校验 `auth.uid()` 的事务 RPC 提交完整快照。`expected_revision` 防止旧结果覆盖新状态，冲突返回 409。初始化与权限细节见 [supabase/README.md](supabase/README.md)。

## Vercel 部署

将本仓库导入 Vercel，选择 Next.js、Node.js 22，安装命令使用 `npm ci --legacy-peer-deps`，构建命令使用 `npm run build`。在目标环境设置模型变量，以及：

```dotenv
STORAGE_MODE=supabase
NEXT_PUBLIC_SUPABASE_URL=<自己的 Supabase 项目 URL>
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<项目的 publishable key>
ENABLE_DEV_FIXTURES=false
```

先执行数据库迁移，再部署应用。生成和预览修复路由配置了 `maxDuration=180`；部署前应确认所用运行环境允许该执行时长。构建成功只代表应用能编译，不能证明模型凭据、数据库或公网链路可用。

Vercel 环境缺少 Supabase 时，应用会明确报错，避免把临时文件系统当作持久存储。部署后按 [验收记录](docs/acceptance.md) 完成真实生成、刷新恢复、跨会话隔离和错误路径检查，再填写可访问地址。

本机查看生产构建可运行：

```bash
npm run build
ATOMS_ALLOW_LOCAL_STORAGE=true npm start
```

## 生成、保存和恢复的语义

生成过程依次经历编写、静态检查、浏览器启动验证。候选代码和候选数据先暂存；通过检查后，服务端将代码版本、应用数据和运行结果一起提交。静态检查或启动失败时最多自动修复两次，原有可用版本继续保留。模型凭据错误、限流、请求失败、取消和超时均返回明确状态。

版本恢复会复制选中的成功版本代码，创建一个新候选版本，并使用当前应用数据进行预览。当前实现没有历史数据快照，因此恢复代码不会把数据恢复到某个历史时间点。候选初始化中的合法数据写入仍会参与最终提交，旧代码对现有数据的兼容性需要业务验收。

取消以持久化状态为准。同一进程内会中止模型请求；跨实例执行中的模型请求可能继续消耗服务额度，但迟到结果不能晋升已取消任务。进程中断后的任务由已有截止时间和后续读取回收。

并发写入采用 CAS。幂等重复请求只读返回；内部状态写入最多重试三次 revision 冲突。持续冲突会返回 409 与最新快照，不会将其他活跃任务误判为模型失败。

## 检查命令

```bash
npm run typecheck
npm test
npm run build
```

浏览器测试使用 Playwright 和 Chrome：

```bash
npx playwright install chrome
npm run test:e2e
```

Playwright 配置会启动启用开发样例的本地服务器。如果已有服务器占用测试地址，应确保它以 `ENABLE_DEV_FIXTURES=true` 启动。当前 E2E 覆盖开发样例，不会调用付费模型；其验证状态单独记录。

[CI](.github/workflows/ci.yml) 在推送和 PR 上运行类型检查、单测及构建。浏览器测试暂设为手动工作流选项，执行失败会使该任务失败。

## 实现边界

- 生成产物限于自包含 HTML 应用，不支持生成 React 多文件项目、安装 npm 依赖、后端服务或容器构建。
- 预览禁止联网，数据通过 `window.appStorage` 保存；总量限制为 64 KiB、最多 100 个键、JSON 深度 20。
- iframe、CSP 和静态检查没有提供进程级 CPU 或内存配额，失控脚本仍可能影响浏览器标签页。启动验证也不能代替按钮、计算和游戏规则等功能验收。
- 本地文件锁只覆盖一个 Node 进程，多实例运行应使用 Supabase。
- 匿名会话没有账户找回或跨设备同步入口。多人协作、公开分享和项目导入尚未实现。
- 当前限流按项目计数，新建项目可以绕过；自动修复还会增加模型调用。公网开放前应增加账户/IP 限流、整体费用上限和访问控制，并配置 Supabase 匿名注册的防滥用措施。

具体调用关系和状态规则见 [docs/architecture.md](docs/architecture.md)。

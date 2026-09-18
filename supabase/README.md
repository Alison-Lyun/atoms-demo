# 云端持久化

1. 创建 Supabase 项目。在 Authentication / Providers 中开启 **Anonymous Sign-Ins**。匿名会话仍属于 `authenticated` 数据库角色，每个浏览器有独立的 `auth.uid()`。
2. 在 SQL Editor 执行 `migrations/202609180001_initial.sql`，或链接项目后运行 `supabase db push`。
3. 在部署平台配置 `STORAGE_MODE=supabase`、`NEXT_PUBLIC_SUPABASE_URL` 和 `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`，重新部署。旧项目可用 `NEXT_PUBLIC_SUPABASE_ANON_KEY`。不要配置 service-role key。
4. 先通过应用 API 创建项目，再打开另一个浏览器会话，确认无法读取第一个会话的项目。查看应用自身的持久化状态后，再做生成测试。

五张表的查询均受 RLS 保护，子表使用 `(project_id, owner_id)` 复合外键。客户端只有表的 SELECT 权限，不能直接绕过快照 RPC 写入。写 RPC 显式验证 `auth.uid()`，以项目行锁和 `expected_revision` 做比较交换；冲突返回 HTTP 409。整个项目快照（版本、消息、运行状态及数据）在同一个事务中提交。读取 RPC 是一个 SELECT，避免分表读取遇到并发提交而拼出不同时间的快照。

会话采用服务端 Supabase SSR cookies；`getUser()` 验证身份并刷新 cookies。请在开始流式响应之前调用 `getRepository()`。清除浏览器 cookies 会失去匿名项目的访问权；生产扩展应增加正式登录和匿名账户升级流程。

本地模式只供开发和单进程演示：文件位于 `.data/`（可通过 `LOCAL_DATA_DIR` 修改），按会话隔离，通过文件原子替换和进程内锁持久化。本机运行生产构建时可明确设置 `ATOMS_ALLOW_LOCAL_STORAGE=true`；Vercel 环境永远不允许本地存储降级。多进程本地部署也应使用 Supabase。

匿名 Auth 的默认限流、配额和防滥用策略需在自己的 Supabase 项目中验证；本项目没有替用户创建或配置远端资源。

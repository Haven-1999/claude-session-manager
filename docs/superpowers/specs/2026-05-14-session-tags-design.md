# Session Tag 分组功能设计

## 概述

为 Claude Session Manager 新增项目 Tag 功能，让会话按 Tag 分组管理。新建会话时选择所属 Tag，历史已有会话自动归入"未分类" Tag。

## 核心需求

1. Tag 是用户自定义标签名称，与工作目录（cwd）无关
2. 一个会话只属于一个 Tag（一对一关系）
3. Tag 需要预先管理（新增、重命名、删除）
4. 侧边栏按 Tag 分组展开/收起显示会话
5. 支持会话在 Tag 间移动（右键菜单）
6. "未分类" Tag 是一条普通 tag 数据库记录，但不可删除、不可重命名，始终排在最后
7. 删除 Tag 时让用户选择处理方式（移入未分类 / 连同删除会话）
8. 新建会话弹窗的工作目录输入框支持 Tab 键路径补齐

## 数据模型

### 新增 `tags` 表

```sql
CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
```

### `sessions` 表迁移

新增 `tag_id TEXT` 字段。

启动时迁移逻辑：
1. 检测 `sessions` 表是否有 `tag_id` 列，没有则添加
2. 检测 `tags` 表是否存在，不存在则创建
3. 确保存在一条 `name='未分类'` 的 tag 记录（id 固定为 `uncategorized`）
4. 将所有 `tag_id IS NULL` 的会话更新为指向"未分类" tag

### 类型定义扩展

```typescript
// 新增 Tag 类型
interface Tag {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: number;
}

// SessionRecord 扩展
interface SessionRecord {
  // ...existing fields
  tag_id: string;
}

// Session 扩展
interface Session {
  // ...existing fields
  tagId: string;
}

// 前端 SessionSummary 扩展
interface SessionSummary {
  // ...existing fields
  tagId: string;
}
```

## API 设计

### Tag 管理端点

| 方法 | 路径 | 说明 | 请求体/参数 | 返回 |
|------|------|------|-------------|------|
| `GET` | `/api/tags` | 获取所有 tag | - | `Tag[]`（按 sort_order 排序，未分类始终最后） |
| `POST` | `/api/tags` | 新建 tag | `{name: string}` | `Tag` |
| `PATCH` | `/api/tags/:id` | 重命名 tag | `{name: string}` | `Tag` |
| `DELETE` | `/api/tags/:id` | 删除 tag | query: `?action=move_uncategorized` 或 `?action=delete_sessions`（必填） | `204` |

约束：
- `POST /api/tags`：name 不能为空或重复
- `PATCH /api/tags/:id`：不允许重命名 id 为 `uncategorized` 的 tag
- `DELETE /api/tags/:id`：不允许删除 id 为 `uncategorized` 的 tag；`action=move_uncategorized` 时将该 tag 下会话移入未分类；`action=delete_sessions` 时连同会话一起删除

### 路径补齐端点

| 方法 | 路径 | 说明 | 请求体/参数 | 返回 |
|------|------|------|-------------|------|
| `GET` | `/api/path-completions` | 目录路径补齐 | query: `?partial=/path/to/dir` | `string[]`（匹配的目录路径列表） |

仅返回目录，不返回文件。最多返回 20 条结果。

### 现有端点扩展

- `POST /api/sessions`：body 新增 `tagId` 字段（必填）
- `PATCH /api/sessions/:id`：body 支持 `{tagId}` 字段（用于移动会话）
- `GET /api/sessions`：返回新增 `tagId` 字段

## UI 设计

### 侧边栏 - Tag 分组布局

侧边栏从扁平列表改为按 Tag 分组的展开/收起结构：

- 顶部显示 "TAGS" 标签和 "+ 管理" 按钮
- 每个 Tag 是一个可展开/收起的分组，显示 Tag 名称和会话数量计数
- 展开后显示该 Tag 下的所有会话（保持原有的状态点 + 名称 + 删除按钮）
- 第一个用户创建的 tag 默认展开
- "未分类" Tag 始终排在最后
- 底部保留 "+ 新建会话" 按钮
- Tag 分组的展开/收起状态保存在 localStorage

### Tag 内联管理模式

点击侧边栏顶部 "+ 管理" 按钮进入管理模式：

- 顶部变为 "TAG 管理" 标题和 "✕ 关闭" 按钮
- 显示新增输入框（输入名称 + "+" 按钮）
- 列出所有 tag，每个 tag 右侧有"重命名"和"删除"操作
- 重命名：点击后变为内联编辑态（输入框 + ✓/✕ 按钮）
- 删除：弹出确认框，显示 tag 下会话数量，提供"移入未分类"和"连同删除"两个选项
- "未分类" tag 显示为不可编辑状态

### 新建会话弹窗

在现有弹窗的"会话名称"和"工作目录"下方新增"所属 Tag"下拉选择器：

- 下拉列表显示所有 tag（按 sort_order 排序，未分类在最后）
- 默认选中第一个用户创建的 tag（非未分类）
- 如果没有用户创建的 tag，默认选中"未分类"

### 工作目录 Tab 补齐

新建会话弹窗中的工作目录输入框支持 Tab 键补齐：

- 按 Tab 键时阻止默认焦点切换行为
- 调用 `GET /api/path-completions?partial=<当前输入值>` 获取匹配目录
- 只有一个匹配项：直接补齐完整路径，末尾加 `/`
- 多个匹配项：补齐到公共前缀，在输入框下方短暂显示候选列表（3 秒后自动隐藏）
- 无匹配项：不操作

### 会话右键菜单

右键点击会话项弹出上下文菜单：

- **重命名**：触发内联重命名（复用现有双击重命名逻辑）
- **移动到 ▶**：子菜单列出所有其他 tag（不含当前所属 tag），点击后移动会话
- **删除**：触发删除确认（复用现有删除逻辑）

## 服务端组件变更

### MemoryService 扩展

新增方法：
- `createTag(name: string): Tag`
- `listTags(): Tag[]`
- `getTag(id: string): Tag | undefined`
- `updateTag(id: string, changes: {name?: string}): Tag`
- `deleteTag(id: string): void`
- `moveSessionsToTag(fromTagId: string, toTagId: string): void`
- `deleteSessionsByTag(tagId: string): void`
- `listDirectories(partial: string): string[]`

`createSession` 方法扩展接收 `tag_id` 参数。
`updateSession` 方法扩展支持 `tag_id` 变更。

### SessionManager 扩展

新增 Tag 管理方法（代理到 MemoryService）：
- `createTag(name)`
- `listTags()`
- `updateTag(id, name)`
- `deleteTag(id, action)` — action 为 `move_uncategorized` 或 `delete_sessions`

`createSession` 方法扩展接收 `tagId` 参数。
`moveSession(sessionId, tagId)` 方法用于移动会话。

## 前端组件变更

### SessionList 组件重构

从扁平列表重构为分组渲染：
- `render(sessions, tags, activeSessionId)` — 接收 tag 列表参数
- 按 tag 分组渲染会话
- 管理展开/收起状态
- 管理模式切换

### App 类变更

- 新增 `tags: Tag[]` 状态
- `loadSessions()` 时同时加载 tags
- `showCreateModal()` 中新增 tag 选择器和 Tab 补齐逻辑
- 新增右键菜单处理
- 新增 tag CRUD 操作方法

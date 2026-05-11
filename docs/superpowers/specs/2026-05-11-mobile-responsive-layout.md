# 移动端响应式布局设计

## 目标
让 CSM Web 界面在手机浏览器上可用：解决左栏挤压终端内容的问题，同时保证桌面端体验不变。

## 断点
- 移动端：`max-width: 767px`
- 桌面端：`min-width: 768px`（保持现有三栏布局不变）

## 布局行为

### 左栏（会话列表）
- **默认**：完全隐藏，不占宽度
- **唤出**：点击顶部栏汉堡菜单（☰），左栏从左侧滑入 overlay 抽屉
- **抽屉规格**：宽度 280px，带半透明黑色背景遮罩（`rgba(0,0,0,0.5)`）
- **关闭**：点击遮罩、点击某个会话、或点击关闭按钮后自动收起
- **z-index**：抽屉 150，遮罩 140，高于顶部栏（顶部栏保持 z-index 不变）

### 主区域（终端）
- 移动端下始终占满 100% 可用宽度
- xterm.js 通过 `FitAddon` 自动适配新的终端尺寸

### 右栏（编辑器）
- **默认**：完全隐藏
- **唤出**：点击终端中的文件路径后，编辑器从右侧滑入
- **规格**：宽度 100%（全宽），因为手机上 480px 仍然太窄
- **关闭**：点击顶部关闭按钮或按 Escape 后收起

### 顶部栏
- 移动端下 logo 文字从 "Claude Session Manager" 收缩为 "CSM"
- 最左侧新增汉堡菜单按钮（☰），`min-height: 44px` 保证触控友好
- 其他按钮保持现有样式

## CSS 变更

### 新增类
- `.mobile` — 通过 JS 在 body 上动态添加/移除
- `.sidebar.left.drawer` — 移动端下左栏变为 fixed 定位 overlay
- `.sidebar.left.drawer.open` — 滑入状态
- `.drawer-backdrop` — 遮罩层

### 新增媒体查询
```css
@media (max-width: 767px) {
  .top-bar .logo { font-size: 14px; }
  .sidebar.left {
    position: fixed;
    left: 0; top: 48px; bottom: 0;
    width: 280px;
    transform: translateX(-100%);
    transition: transform 0.2s ease;
    z-index: 150;
  }
  .sidebar.left.open { transform: translateX(0); }
  .sidebar.right { width: 100%; }
}
```

## app.ts 逻辑变更

1. **断点检测**
   - `window.addEventListener('resize')` 中检查 `window.innerWidth`
   - `< 768px` 时给 `body` 加 `.mobile` 类，否则移除
   - 初始化时执行一次检测

2. **汉堡菜单按钮**
   - HTML 中新增 `<button id="btn-menu">☰</button>`
   - 点击时：给左栏加 `.open` 类，在 body 下插入 `.drawer-backdrop`
   - 点击遮罩或选择会话时：移除 `.open`，移除遮罩

3. **编辑器打开逻辑**
   - 在移动端下，编辑器不使用现有的 `classList.remove('hidden')`（因为那只是去掉 width:0）
   - 改为添加 `.open` 类从右侧滑入（类似左栏的反向动画）
   - 按 Escape 键关闭（桌面端也可受益，不影响现有行为）

4. **无变更部分**
   - 桌面端 ≥768px 的所有布局、拖拽调整编辑器宽度、侧边栏折叠逻辑均不受影响
   - xterm.js 字体大小、主题、WebSocket 连接逻辑不变
   - 弹窗（创建会话、设置、路径确认）已在 overlay 中工作

## 测试验证点

1. 桌面端浏览器打开，确认三栏布局无任何变化
2. 手机浏览器（或 Chrome DevTools 手机模式）打开：
   - 左栏默认不可见，终端占满宽度
   - 点击 ☰ 左栏滑入，点击遮罩或会话后关闭
   - 点击终端中的文件路径，编辑器从右侧全宽滑入
   - 编辑器关闭后回到终端
3. 在桌面端和移动端之间调整浏览器宽度，布局平滑切换

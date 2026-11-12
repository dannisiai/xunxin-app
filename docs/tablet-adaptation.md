# 通用平板适配与小新大屏优化

本轮实现面向实际应用窗口，覆盖 iPad、Galaxy Tab、MatePad、小米／红米、荣耀和联想小新等平板的横竖屏、分屏及自由窗口使用方式。品牌名称不作为布局开关；屏幕物理分辨率不直接用作 CSS 尺寸。网页或 APK 发布前，这些源码改动不会自动进入已安装版本。

## 参考与取舍

- [Android 自适应标准布局](https://developer.android.com/develop/adaptive-apps/guides/canonical-layouts)：聊天和日历采用列表／详情；窗口变窄时回到单栏，保留当前内容。
- [Apple 分栏](https://developer.apple.com/design/human-interface-guidelines/split-views)、[侧栏](https://developer.apple.com/design/human-interface-guidelines/sidebars)：侧栏可以收放，内容保持合适阅读宽度，支持键盘操作。
- [WhatsApp iPad](https://blog.whatsapp.com/its-here-introducing-whatsapp-for-ipad)：参考大屏消息应用对多任务与外接输入设备的支持方向。
- [Samsung 多窗口](https://www.samsung.com/us/support/answer/ANS10002884/)、[华为自由多窗](https://consumer.huawei.com/cn/support/content/zh-cn16058372/)、[荣耀应用分屏](https://www.honor.com/cn/support/content/zh-cn15831002/)、[小米平板分屏](https://www.mi.com/uk/support/faq/details/KA-544049/)：系统可以随时改变应用窗口大小，因此不锁定横屏，也不假定窗口总占满屏幕。
- [联想小新 Pad Pro 12.7 官方资料](https://www.lenovo.com.cn/wiki/product-doc-30457.html)：针对其 16:10 大屏比例优化横屏桌面密度与阅读空间。2944×1840 是物理像素，系统显示大小、密度、系统栏和分屏会改变实际 CSS 视口；不硬编码这一分辨率。

以上参考用于布局和交互设计，不表示已经在这些品牌的每个机型上实测，也不表示网页自行实现了系统级多任务、手写笔协议或多窗口管理。

## 当前行为

| 实际内容宽度（CSS px） | 布局 |
| --- | --- |
| 小于 600 | 现有手机单栏和逐层返回；侧栏隐藏。 |
| 600–839 | 设置、角色、外观、资源、日记、剧情和阅读目录使用紧凑导航栏；用户可展开为文字侧栏。 |
| 760 起 | 聊天会话与正文、日历与日期详情并排，适用于部分平板竖屏；更窄时回到原单栏。 |
| 840 起 | 通用工作区默认展开侧栏，可收起、搜索分类，并以拖动或键盘调整宽度。 |
| 1000 起 | 聊天增加独立纵向导航栏；列表宽度仍保证右侧正文和输入空间。 |
| 1200 起 | 阅读可同时显示书架、章节目录与正文；日记在自身内容区足够宽时并排展示列表与正文。 |

聊天列表和通用侧栏分隔条支持拖动、左右方向键、Shift 加速，以及 Home／End。切换窗口宽度不会通过复制或重建两套聊天室／编辑器来适配；已访问聊天室继续沿用原有挂载机制。原有系统返回、折叠屏铰链、安全区域和键盘处理继续生效。

阅读书架保持挂载，切换窗口和回到书架时保留列表状态并更新阅读进度；删除正在阅读的书会退出该书的阅读区域。大窗口日记显示内嵌正文，小窗口使用原有详情弹窗。两种日记详情不会同时出现。

表单、菜单和正文限制最大阅读宽度；购物与游戏卡片按窗口自动增加列数；平板表单标题栏和触控入口保留足够点击区域。小新等 16:10 横屏桌面进一步按可用高度限制图标尺寸，保留已有四列六行坐标和组件摆放，避免改变用户保存的桌面布局。

## 实现入口

- `lib/tablet-layout.ts`：窗口断点、侧栏和会话列表宽度约束。
- `components/ui/adaptive-workspace.tsx`：通用导航栏、展开／收起、搜索与侧栏调宽。
- `components/ui/pane-resize-handle.tsx`：拖动与键盘分隔条。
- `styles/tablet-workspaces.css`：按内容容器切换布局，承接各应用的平板样式。
- 聊天、日历、阅读、日记与剧情组件：各自的主从内容和选择状态。

## 检查范围

本轮执行 TypeScript 编译检查、自适应表面源码约束和生产构建。内置浏览器尝试被 Work 设置的“本地浏览器已禁用”阻止，没有完成截图、实际点击、旋转、分屏和键盘遮挡的浏览器／真机验收。不能将编译成功表述为所有平板上的体验已达到主流应用同等水平。

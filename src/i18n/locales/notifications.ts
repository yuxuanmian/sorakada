export const zhNotifications = {
  region: "通知", close: "关闭通知", details: "查看详情", hide: "收起详情", copy: "复制详情", copied: "已复制", copyFailed: "复制失败，请选择详情文本复制",
  info: "提示", success: "操作成功", warning: "警告", error: "操作失败",
  operation: { save: "保存失败", saveAs: "另存为失败", open: "打开失败", reload: "重新加载失败", delete: "移入回收站失败", rename: "重命名失败", create: "创建失败", workspace: "文件夹操作失败", window: "窗口操作失败", unknown: "操作失败" },
  statistics: "保留 {{files}} 个目标的详情，共发生 {{occurrences}} 次（重复 {{repeats}} 次）",
  omitted: "已省略 {{count}} 条较旧诊断", truncated: "诊断已截断，以下为保留内容", evicted: "另有 {{count}} 条旧通知已汇总省略",
  code: "错误码", path: "路径", noTarget: "应用", recent: "最近发生：{{time}}",
} as const;
export const enNotifications = {
  region: "Notifications", close: "Dismiss notification", details: "Show details", hide: "Hide details", copy: "Copy details", copied: "Copied", copyFailed: "Copy failed; select the details to copy them",
  info: "Information", success: "Operation succeeded", warning: "Warning", error: "Operation failed",
  operation: { save: "Save failed", saveAs: "Save As failed", open: "Open failed", reload: "Reload failed", delete: "Move to Recycle Bin failed", rename: "Rename failed", create: "Create failed", workspace: "Folder operation failed", window: "Window operation failed", unknown: "Operation failed" },
  statistics: "Details retained for {{files}} targets; {{occurrences}} occurrences ({{repeats}} repeats)",
  omitted: "{{count}} older diagnostics omitted", truncated: "Diagnostic truncated; retained content follows", evicted: "{{count}} other older notifications summarised and omitted",
  code: "Code", path: "Path", noTarget: "Application", recent: "Last occurrence: {{time}}",
} as const;

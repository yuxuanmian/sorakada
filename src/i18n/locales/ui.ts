export const zhUi = {
  menu: {
    trigger: "应用菜单",
    sections: {
      file: "文件",
      edit: "编辑",
      view: "视图",
    },
    items: {
      file: {
        new: "新建",
        open: "打开...",
        openFolder: "打开文件夹...",
        closeFolder: "关闭文件夹",
        save: "保存",
        saveAs: "另存为...",
        close: "关闭",
        exit: "退出",
      },
      edit: {
        undo: "撤销",
        redo: "重做",
      },
      view: {
        explorer: "资源管理器",
        resetSidebarWidth: "重置侧边栏宽度",
        toggleEditorMotion: "平滑光标与滚动",
      },
    },
    submenus: {
      density: {
        label: "显示密度",
        compact: "紧凑",
        default: "默认",
        comfortable: "宽松",
      },
      debug: {
        label: "UI 调试",
        virtualRange: "虚拟滚动范围",
        treeRowBounds: "树节点行边界",
        largeTree: "10,000 行树",
        manyTabs: "100 个标签页",
      },
    },
  },
  topBar: {
    minimize: "最小化",
    maximize: "最大化",
    restore: "向下还原",
    close: "关闭",
    closeWindow: "关闭窗口",
  },
  footer: {
    region: "状态栏",
    encodingTitle: "编码：{{encoding}}",
    lineEndingTitle: "保存时的换行符：{{lineEnding}}",
  },
  sidebar: {
    resize: "调整侧边栏大小",
    explorer: "资源管理器",
  },
  emptyState: {
    title: "未打开文件",
    hintWithoutWorkspace: "打开文件开始编辑，或打开文件夹浏览工作区。",
    hintWithWorkspace: "打开文件开始编辑。{{workspaceName}} 在资源管理器中保持打开。",
    openFile: "打开文件",
    openFolder: "打开文件夹",
  },
  editorGroup: {
    region: "编辑器分组",
  },
  editorWorkspace: {
    region: "编辑器工作区",
  },
  tabs: {
    openDocuments: "已打开文档",
    closeTab: "关闭 {{name}}",
    newDocument: "新建文档",
    newTooltip: "新建 ({{shortcut}})",
    unsavedChanges: "未保存更改",
    modifiedOnDisk: "磁盘内容已更改",
    modifiedOnDiskTooltip: "已被其他程序在磁盘上修改",
    missingOnDisk: "磁盘文件已缺失",
    missingOnDiskTooltip: "已在磁盘上删除；保存将重新创建该文件",
  },
  tabOverview: {
    trigger: "已打开文档",
    filterAria: "过滤已打开文档",
    filterPlaceholder: "过滤文档",
    empty: "无匹配文档",
  },
  explorer: {
    region: "资源管理器",
    empty: {
      hint: "未打开文件夹。",
      openFolder: "打开文件夹",
    },
    header: {
      defaultTitle: "文件",
      locate: "定位当前文件",
      collapseAll: "全部折叠",
      more: "更多操作",
      search: {
        aria: "搜索可见文件",
        placeholder: "搜索文件",
        noMatches: "无匹配项",
        matchCount: "{{count}} 个匹配项",
      },
    },
    contextMenu: {
      newFile: "新建文件",
      newFolder: "新建文件夹",
      rename: "重命名",
      delete: "删除",
      refresh: "刷新",
      aria: "资源管理器操作",
    },
    row: {
      newFileAria: "新建文件名",
      newFolderAria: "新建文件夹名",
      renameAria: "重命名 {{name}}",
      expandAria: "展开 {{name}}",
      collapseAria: "折叠 {{name}}",
    },
    notice: {
      loading: "加载中...",
      cycle: "此链接指向其上层文件夹，因此不列出其内容。",
    },
    rootUnavailable: "无法读取此文件夹。使用刷新重试。",
    workspaceFilesAria: "工作区文件",
    debug: {
      noRows: "无数据行",
      visible: "可见 {{count}}",
      rendered: "已渲染 {{count}}",
      range: "范围 {{start}}–{{end}}",
      fixture: "固定桩",
    },
  },
  search: {
    region: "查找和替换",
    input: {
      placeholder: "搜索",
      aria: "搜索文本",
    },
    replaceInput: {
      placeholder: "替换为",
      aria: "替换文本",
    },
    caseSensitive: {
      title: "区分大小写 (Alt+C)",
      aria: "区分大小写",
    },
    regex: {
      title: "正则表达式 (Alt+R)",
      aria: "正则表达式",
    },
    prev: {
      title: "上一个 (Shift+Enter)",
      aria: "上一个匹配项",
    },
    next: {
      title: "下一个 (Enter)",
      aria: "下一个匹配项",
    },
    close: {
      title: "关闭 (Esc)",
      aria: "关闭搜索栏",
    },
    replace: {
      label: "替换",
      title: "替换当前 (Alt+P)",
    },
    replaceAll: {
      label: "全部替换",
      title: "全部替换 (Alt+A)",
    },
    matches: {
      noResults: "0 个结果",
      count: "{{count}} 个结果",
      countCapped: "{{count}}+ 个结果",
      position: "{{current}} / {{total}}",
      positionCapped: "{{current}} / {{total}}+",
    },
    errors: {
      invalidRegex: "无效的正则表达式",
    },
  },
} as const;

export const enUi = {
  menu: {
    trigger: "Application menu",
    sections: {
      file: "File",
      edit: "Edit",
      view: "View",
    },
    items: {
      file: {
        new: "New",
        open: "Open...",
        openFolder: "Open Folder...",
        closeFolder: "Close Folder",
        save: "Save",
        saveAs: "Save As...",
        close: "Close",
        exit: "Exit",
      },
      edit: {
        undo: "Undo",
        redo: "Redo",
      },
      view: {
        explorer: "Explorer",
        resetSidebarWidth: "Reset Sidebar Width",
        toggleEditorMotion: "Smooth Caret and Scrolling",
      },
    },
    submenus: {
      density: {
        label: "Density",
        compact: "Compact",
        default: "Default",
        comfortable: "Comfortable",
      },
      debug: {
        label: "UI Debug",
        virtualRange: "Virtual Range",
        treeRowBounds: "Tree Row Bounds",
        largeTree: "10,000-Row Tree",
        manyTabs: "100 Tabs",
      },
    },
  },
  topBar: {
    minimize: "Minimize",
    maximize: "Maximize",
    restore: "Restore",
    close: "Close",
    closeWindow: "Close window",
  },
  footer: {
    region: "Status",
    encodingTitle: "Encoding: {{encoding}}",
    lineEndingTitle: "Line ending on save: {{lineEnding}}",
  },
  sidebar: {
    resize: "Resize sidebar",
    explorer: "Explorer",
  },
  emptyState: {
    title: "No file is open",
    hintWithoutWorkspace: "Open a file to start editing, or open a folder to browse a Workspace.",
    hintWithWorkspace: "Open a file to start editing. {{workspaceName}} stays open in the Explorer.",
    openFile: "Open File",
    openFolder: "Open Folder",
  },
  editorGroup: {
    region: "Editor group",
  },
  editorWorkspace: {
    region: "Editor workspace",
  },
  tabs: {
    openDocuments: "Open documents",
    closeTab: "Close {{name}}",
    newDocument: "New document",
    newTooltip: "New ({{shortcut}})",
    unsavedChanges: "Unsaved changes",
    modifiedOnDisk: "Changed on disk",
    modifiedOnDiskTooltip: "Changed on disk by another program",
    missingOnDisk: "Missing on disk",
    missingOnDiskTooltip: "Deleted on disk; Save recreates the file",
  },
  tabOverview: {
    trigger: "Open documents",
    filterAria: "Filter open documents",
    filterPlaceholder: "Filter documents",
    empty: "No matching documents",
  },
  explorer: {
    region: "Explorer",
    empty: {
      hint: "No folder is open.",
      openFolder: "Open Folder",
    },
    header: {
      defaultTitle: "Files",
      locate: "Locate current file",
      collapseAll: "Collapse all",
      more: "More Explorer actions",
      search: {
        aria: "Search visible files",
        placeholder: "Search files",
        noMatches: "No matches",
        matchCount: "{{count}} matches",
      },
    },
    contextMenu: {
      newFile: "New File",
      newFolder: "New Folder",
      rename: "Rename",
      delete: "Delete",
      refresh: "Refresh",
      aria: "Explorer actions",
    },
    row: {
      newFileAria: "New file name",
      newFolderAria: "New folder name",
      renameAria: "Rename {{name}}",
      expandAria: "Expand {{name}}",
      collapseAria: "Collapse {{name}}",
    },
    notice: {
      loading: "Loading...",
      cycle: "This link points to a folder above it, so its contents are not listed.",
    },
    rootUnavailable: "This folder could not be read. Use Refresh to try again.",
    workspaceFilesAria: "Workspace files",
    debug: {
      noRows: "no rows",
      visible: "visible {{count}}",
      rendered: "rendered {{count}}",
      range: "range {{start}}–{{end}}",
      fixture: "fixture",
    },
  },
  search: {
    region: "Find and Replace",
    input: {
      placeholder: "Find",
      aria: "Search text",
    },
    replaceInput: {
      placeholder: "Replace with",
      aria: "Replace text",
    },
    caseSensitive: {
      title: "Match Case (Alt+C)",
      aria: "Match Case",
    },
    regex: {
      title: "Regular Expression (Alt+R)",
      aria: "Regular Expression",
    },
    prev: {
      title: "Previous Match (Shift+Enter)",
      aria: "Previous match",
    },
    next: {
      title: "Next Match (Enter)",
      aria: "Next match",
    },
    close: {
      title: "Close (Esc)",
      aria: "Close search bar",
    },
    replace: {
      label: "Replace",
      title: "Replace (Alt+P)",
    },
    replaceAll: {
      label: "Replace All",
      title: "Replace All (Alt+A)",
    },
    matches: {
      noResults: "0 results",
      count: "{{count}} results",
      countCapped: "{{count}}+ results",
      position: "{{current}} / {{total}}",
      positionCapped: "{{current}} / {{total}}+",
    },
    errors: {
      invalidRegex: "Invalid regular expression",
    },
  },
} as const;

export const zhDialogs = {
  title: "Sorakada", save: "保存", dontSave: "不保存", cancel: "取消", overwrite: "覆盖", discard: "丢弃更改", delete: "移入回收站", acknowledge: "知道了",
  unsaved: "是否保存对“{{name}}”的更改？",
  external: "“{{name}}”已被其他程序修改。是否使用 Sorakada 中的内容覆盖磁盘文件？",
  reload: "是否从磁盘重新加载“{{name}}”并丢弃未保存的更改？",
  trash: "是否将“{{name}}”移入回收站？", dirtyTarget: "该文件的未保存更改将丢失。", dirtyChildren: "以下文件的未保存更改将丢失：{{names}}。",
  openFile: "打开文件", saveAs: "另存为", openFolder: "打开文件夹", textFiles: "文本文件", allFiles: "所有文件",
} as const;
export const enDialogs = {
  title: "Sorakada", save: "Save", dontSave: "Don't Save", cancel: "Cancel", overwrite: "Overwrite", discard: "Discard Changes", delete: "Move to Recycle Bin", acknowledge: "OK",
  unsaved: "Save changes to “{{name}}”?",
  external: "“{{name}}” was modified by another program. Overwrite the file on disk with the content in Sorakada?",
  reload: "Reload “{{name}}” from disk and discard unsaved changes?",
  trash: "Move “{{name}}” to the Recycle Bin?", dirtyTarget: "Its unsaved changes will be lost.", dirtyChildren: "Unsaved changes in these files will be lost: {{names}}.",
  openFile: "Open File", saveAs: "Save As", openFolder: "Open Folder", textFiles: "Text files", allFiles: "All files",
} as const;

# 本地项目管理工具

一个轻量、纯前端体验的本地项目管理工具。所有数据以 JSON 原始文件保存在本地，不依赖任何第三方包。

## 启动

### 手动启动

```bash
cd /Users/jingyu/local-pm
python3 app.py
```

### 开机自动启动（macOS）

已经配置好了 `launchd` 用户级服务，登录后会自动在后台运行：

```bash
# 查看状态
launchctl list | grep com.localpm

# 手动停止
launchctl unload /Users/jingyu/Library/LaunchAgents/com.localpm.app.plist

# 手动启动
launchctl load -w /Users/jingyu/Library/LaunchAgents/com.localpm.app.plist
```

然后打开浏览器访问：http://127.0.0.1:8765

## 功能

- 新建 / 编辑 / 删除项目
- 为每个项目添加任务，设置优先级
- 点击任务文字可直接修改标题
- 勾选复选框标记完成
- 搜索项目或任务
- 导出 / 导入 JSON 数据

## 数据文件

所有数据实时写入：

```
/Users/jingyu/local-pm/data/projects.json
```

你可以直接用文本编辑器查看、备份或修改这个文件，服务会实时读取它。

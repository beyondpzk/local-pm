# 公司内网共享时间轴

正式地址：`http://10.2.60.36:8766/`。只提供时间轴、保存接口、版本历史和健康检查，不提供整个 local-pm 项目目录、项目管理主页或甘特图。

数据已从 `data/具身智能导航项目.json` 导入。运行文件位于 Linux 的 `/home/yj/timeline-service/`，与先前 SCP 的完整源码目录 `/home/yj/local-pm/` 分离。

## 使用

- 进入编辑前填写姓名，修改自动保存到服务器；顶部显示保存结果、最后修改人和时间。姓名由使用者填写，未对接公司身份认证。
- 页面每 5 秒检查服务器更新；拖动、输入、打开编辑弹窗或历史预览时暂停替换画布。
- 同时修改产生冲突时，不覆盖服务器版本；先下载本机草稿，再加载最新版本并重新应用修改。
- 顶部“历史记录”显示最近 100 个版本的姓名、时间和改动摘要，可预览、下载 JSON 或恢复。恢复操作会生成新版本，旧版本仍保留。
- 旧项目导入之前的修改人无法追溯，显示“初始导入（未记录编辑人）”。全部历史文件保留在服务器。
- “保存项目”下载当前 JSON；“保存可分享 HTML”下载独立离线副本，该副本不再同步服务器。“打开项目”会替换当前共享项目，替换前的版本保留在历史中。

## 运行和维护

Python 3.9+，仅标准库。服务通过用户级 systemd 常驻，已开启 `loginctl enable-linger yj`，无需保持 SSH 登录。

```bash
ssh linux 'systemctl --user status timeline.service'
ssh linux 'systemctl --user restart timeline.service'
ssh linux 'journalctl --user -u timeline.service -n 50 --no-pager'
```

`timeline.service` 监听 Linux 的内网地址 `10.2.60.36:8766`。任何能访问该地址的人均可查看和编辑，没有公司账号登录。机器需保持开机、联网且不休眠；若 IP 改变需同步修改 service 的 `--host` 并重启。

## 数据与备份

- `/home/yj/timeline-service/data/timeline.json`：当前版本，首次导入兼容原始项目 JSON；保存后包含 `timeline`、`revision`、`updatedBy`、`updatedAt`、`summary` 等字段。
- `/home/yj/timeline-service/data/backups/<revision>.json`：完整历史版本和修改人记录，不通过静态目录直接公开。
- 保存采用服务端互斥锁、版本检查与原子文件替换；恢复前校验当前版本，避免覆盖并发修改。
- 定期将整个 `data/` 目录复制到其他设备；从版本文件恢复时，应取其中 `timeline` 字段或通过页面下载 JSON，再导入。

## 更新程序

更新代码时不要覆盖 `data/`：

```bash
scp deploy/timeline_server.py linux:/home/yj/timeline-service/
scp static/项目进度时间轴_可编辑.html static/save-queue.js linux:/home/yj/timeline-service/web/
scp deploy/timeline.service linux:/home/yj/.config/systemd/user/
ssh linux 'systemctl --user daemon-reload && systemctl --user restart timeline.service'
```

## 测试

```bash
python3 -m unittest discover -s tests -v
node --test tests/*.test.js
```

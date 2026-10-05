# 安全中心 · Vue 前端

Vue 3 + TypeScript + Vite，监听 **10111**，通过同源 `/api` 调用主控 **10110**。数据来自主控 SQLite，没有浏览器模拟数据。

## 服务器独立部署脚本（推荐）

原生部署，不使用 Docker。支持 Ubuntu 22.04+/Debian 12+、systemd、x86_64 或 arm64。脚本自动安装 Nginx、独立的 Node.js 24 工具链和 pnpm，完成前端构建与 Nginx 配置。需要能访问软件源、nodejs.org 和 npm registry。先部署后端，再执行：

```sh
sudo mkdir -p /opt/anquan
sudo apt-get update
sudo apt-get install -y git
cd /opt/anquan
sudo git clone https://github.com/userreksai/anquan-server-web.git
cd anquan-server-web
# 同一台服务器部署前后端
sudo sh deploy/deploy.sh 127.0.0.1:10110
# 如果后端在另一台服务器，改用其内网 IP，例如：
# sudo sh deploy/deploy.sh 192.168.1.10:10110
```

访问 `http://前端服务器IP:10111`，默认账号 `admin`，密码 `admin1818.`（包含末尾英文句点）。Nginx 将 `/api` 转发到指定后端地址，并保留浏览器 Host；后端地址不要填写 `http://` 或路径。服务器需开放 TCP 10111，并能访问后端 TCP 10110。

脚本检查后端连通性、构建页面，然后部署到 `/var/www/anquan/releases/`，Nginx 配置为 `/etc/nginx/conf.d/anquan.conf`。构建失败不切换站点；配置检查或服务重载失败会恢复原配置和站点链接。旧版本目录保留。Node 安装在 `/opt/anquan-tools/`，不覆盖已有系统 Node，下载后验证[官方 SHA256](https://nodejs.org/download/release/v24.21.0/SHASUMS256.txt)。成功部署的后端地址保存在 `.deploy/master-upstream` 中，后续更新无需再次传参：

```sh
cd /opt/anquan/anquan-server-web
sudo git pull --ff-only
sudo sh deploy/deploy.sh
sudo nginx -t
sudo systemctl status nginx --no-pager
sudo tail -f /var/log/nginx/error.log
```

更换后端地址时重新带参数执行脚本。Nginx 随服务器自动启动；仅管理本站的 `anquan.conf`，保留其他站点配置。首次部署前确认没有其他服务或重复站点配置占用 10111。

## 本地开发

要求 Node.js 24、pnpm 11.19.0。

```sh
npm install --global pnpm@11.19.0
pnpm install --frozen-lockfile
pnpm dev
```

打开 `http://127.0.0.1:10111`。先启动 `anquan-server-master`，默认后端地址为 `http://127.0.0.1:10110`。如果后端不在本机，可通过环境变量设置：

```sh
API_PROXY_TARGET=http://192.0.2.10:10110 pnpm dev
```

Windows PowerShell：

```powershell
$env:API_PROXY_TARGET = 'http://192.0.2.10:10110'
pnpm dev
```

初始账号：`admin`。初始密码：`admin1818.`，末尾英文句点属于密码。登录后在侧栏“修改密码”更新。忘记密码请使用主控仓库中的 `deploy/reset-admin-password.sh`，操作主控实际使用的同一份 SQLite 数据库。

## 功能

- 安全概览：机器总数、在线机器、待处理告警、SSH 登录与累计事件。
- 机器管理：以 IP 为唯一标识，搜索 IP / 主机名 / 别名 / 备注，分页，编辑别名与备注。
- 机器详情：该机器所有事件；删除机器时明确确认，同时删除其历史记录。
- 安全事件：全部 / 告警 / SSH 登录 / 巡检分类；时间、关键字、处理状态筛选与分页。
- 文件告警：显示目标路径，完整展示变更前后值 / MD5；原始 JSON 可展开或复制。
- 登录记录：来源 IP、用户、终端、登录方式与实际登录时间。
- 处理记录：待处理 / 已处理、备注编辑与单条事件删除。
- 通知配置：多个 URL 的新增、修改、删除、启停，飞书 / 企业微信 / 通用格式，测试发送与最近投递状态。
- Cookie 会话登录、退出、过期回到登录页；改密后重新登录。
- 登录后每 15 秒刷新当前页与机器统计，保留已应用筛选、当前页码和未提交输入。切换到后台、打开编辑弹窗或已有请求执行时暂停轮询，回到前台立即刷新。
- 在线机器显示绿色状态；超过主控返回的心跳阈值未收到上报，显示红色“异常离线”，概览同步显示异常离线数量。详情展示该机器的实际超时阈值。
- 常见文件、MD5 与进程告警显示中文标题，原始消息仍完整保留在详情及原始 JSON 中。

时间均按访问者浏览器的本地时区显示；筛选时间转换为 ISO 8601 UTC 后发送到主控。默认按发生时间倒序显示。Webhooks 页面隐藏 URL 的路径和查询参数，编辑时可查看完整地址。

## 验证与构建

```sh
pnpm typecheck
pnpm build
```

构建输出在 `dist/`。`pnpm preview` 用于本地预览构建产物，并继承 `/api` 代理配置；开发联调使用 `pnpm dev`，生产环境使用下述 Nginx 部署。

## Docker / Nginx 部署

```sh
docker build -t anquan-server-web .
docker run -d --name anquan-web --network anquan -p 10111:10111 anquan-server-web
```

先创建 `anquan` Docker 网络，将主控容器以 `master` 网络别名接入该网络。推荐使用主控仓库提供的 `compose.yaml` 统一启动。Nginx 监听 `10111`，将 `/api/` 代理到 `http://master:10110`；修改 `nginx.conf` 可适配已有部署。

如果单独重建主控容器，其容器 IP 可能变化。随后执行 `docker compose restart web`，让 Nginx 重新解析 `master`，避免继续连接旧地址。

如果直接在 Linux 安装 Nginx，将 `dist/` 部署到站点根目录，把 `nginx.conf` 中的 `root` 改成实际目录，并将上游 `master:10110` 改为主控实际地址。页面和 API 应使用同一对外域名与端口，保留 HTTP Host（包括非默认端口），保证 Cookie 和来源校验正常工作。公网部署建议由现有入口配置 HTTPS。

## API 契约

所有路径以 `/api` 为前缀；发送 JSON，使用同源 Cookie。分页响应为 `{items, total, page, page_size}`；错误响应为 `{message}`。

| 功能 | 请求 |
| --- | --- |
| 登录 | `POST /auth/login`：`username,password` |
| 当前会话 | `GET /auth/me` |
| 退出 | `POST /auth/logout` |
| 修改密码 | `PUT /auth/password`：`current_password,new_password` |
| 统计 | `GET /overview` |
| 机器列表 | `GET /machines?q=&page=&page_size=` |
| 机器信息 | `GET /machines/{ip}` |
| 编辑机器 | `PATCH /machines/{ip}`：`alias,notes` |
| 删除机器和记录 | `DELETE /machines/{ip}` |
| 事件列表 | `GET /events?machine_ip=&type=&status=&q=&from=&to=&page=&page_size=` |
| 事件详情 | `GET /events/{id}` |
| 处理记录 | `PATCH /events/{id}`：`status,notes` |
| 删除事件 | `DELETE /events/{id}` |
| 通知地址列表 | `GET /webhooks`，返回数组 |
| 新增 / 编辑地址 | `POST /webhooks` / `PUT /webhooks/{id}`：`name,url,format,enabled` |
| 删除地址 | `DELETE /webhooks/{id}` |
| 立即测试发送 | `POST /webhooks/{id}/test` |

事件类型为 `alert`、`ssh_login`、`scan_summary`。处理状态为 `open`、`resolved`。通知格式为 `feishu`、`wecom`、`generic`。新密码验证与主控一致，为 UTF-8 编码后 8–72 字节。

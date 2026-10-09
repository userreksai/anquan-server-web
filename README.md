# 安全中心 · Vue 前端

## Age 配置加密

管理设置新增“Age 配置加密”。明文区默认填入带中文解释的节点 YAML，包含文件、进程、SSH 登录、上报地址和调度设置。请按每台节点修改路径和 `agent_ip`，默认示例不是通用生产配置。

页面不显示或要求填写公钥、私钥；后端和 Agent 代码内置固定配套密钥。编辑 YAML，点击加密即可复制密文或下载 `config.age`，放到 Agent 可执行文件旁边。输入变更会清除旧密文，避免下载过时配置。明文不写入浏览器持久存储，离开页面会清空编辑状态。

依赖新版 Master 的 `GET/POST /api/settings/agent-encryption` 接口和新版 Agent 的外置配置支持。生产管理页面请通过 HTTPS 访问。更新配置无需重新编译 Agent；下次启动或常驻服务重启读取新配置。二进制只内置解密私钥，无法保证对节点 root 保密。

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
- 安全事件：全部 / 告警 / SSH 登录 / 操作命令 / 巡检分类；时间、关键字、处理状态筛选与分页。
- 操作命令：显示用户、执行时间、终端及完整命令，保留来源日志；关键字可搜索用户和命令，该分类每 2 秒刷新，需要支持 `command_history` 的 Master 和已开启 `history` 的 Agent v0.6.0。
- 文件告警：显示目标路径，完整展示变更前后值 / MD5；原始 JSON 可展开或复制。
- 登录记录：来源 IP、用户、终端、登录方式与实际登录时间。
- 登录通知：Master v0.6.0 将新入库的 SSH 登录发送到所有已启用通知地址，包含机器、用户、来源 IP、终端、方式及登录时间；沿用失败重试和登录来源 ID 去重，已有数据库记录不补发。
- 处理记录：待处理 / 已处理、备注编辑与单条事件删除。
- 通知配置：多个 URL 的新增、修改、删除、启停，新增与编辑时消息格式仅支持 Lark 机器人；可测试已保存配置或编辑中的草稿，保留测试正文、HTTP 状态、业务码、耗时和错误详情。
- Cookie 会话登录、退出、过期回到登录页；改密后重新登录。
- 登录后每 15 秒刷新当前页与机器统计，保留已应用筛选、当前页码和未提交输入。切换到后台、打开编辑弹窗或已有请求执行时暂停轮询，回到前台立即刷新。
- 在线机器显示绿色状态；超过主控返回的心跳阈值未收到上报，显示红色“异常离线”，概览同步显示异常离线数量。详情展示该机器的实际超时阈值。
- 异常离线通知：新版 Master 每秒检测全部已登记机器，每次持续离线只创建一条中文告警并向已启用地址通知；重启不重复，恢复在线后再次离线再通知。页面告警标题为“机器异常离线”，模块为“机器状态”。
- 常见文件、MD5 与进程告警显示中文标题，原始消息仍完整保留在详情及原始 JSON 中。

时间均按访问者浏览器的本地时区显示；筛选时间转换为 ISO 8601 UTC 后发送到主控。默认按发生时间倒序显示。Webhooks 页面隐藏 URL 的路径和查询参数，编辑时可查看完整地址。

## 验证与构建

```sh
pnpm typecheck
pnpm test:webhooks
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

所有路径以 `/api` 为前缀；发送 JSON，使用同源 Cookie。分页响应为 `{items, total, page, page_size}`；一般错误响应为 `{message}`，Webhook 投递测试错误返回下述完整测试结果。

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
| 测试当前表单，不保存 | `POST /webhooks/test`：`name,url,format,enabled` |

事件类型为 `alert`、`ssh_login`、`command_history`、`scan_summary`。处理状态为 `open`、`resolved`。前端新增、编辑与草稿测试的通知格式固定为 `feishu`（Lark 机器人）；接口仍兼容历史配置的 `wecom`、`generic`。新密码验证与主控一致，为 UTF-8 编码后 8–72 字节。

Lark 机器人沿用接口值 `feishu`，主控发送 `{"msg_type":"text","content":{"text":"告警正文"}}`。已有其他格式的配置仍按原格式展示、启停与测试；打开编辑后，表单使用 Lark 格式，保存时更新为 `feishu`，请同时确认 URL 为 Lark 机器人的 Webhook 地址。自动发送的新告警正文包含机器 IP、主机名、时间、类型、目标、描述、变更前后值和事件 ID。暂停配置会停止自动告警投递，手动测试仍可使用。

两个测试接口均返回 `{message,success,text,format,http_status?,business_code?,duration_ms}`。`text` 是本次实际测试正文，`format` 是实际采用的格式；`http_status` 是接收端 HTTP 状态，未收到响应时省略；`business_code` 是接收端业务码，未返回时省略。投递成功响应 HTTP 200，投递失败响应 HTTP 502 并保留这些详情；表单校验失败等请求错误仍可能仅返回 `{message}`。

前端仅在完整 JSON 契约通过校验、`success=true`、接收端 HTTP 为 2xx 且返回的业务码为整数 0 时显示“接口确认成功”。飞书 / Lark 和企业微信必须返回业务码 0；通用格式可不返回业务码。空响应、HTML 页面、旧版仅有 `{message}` 的响应和自相矛盾的成功状态均不能被判为成功。该结果表示接收接口应答，群内展示情况仍以接收平台为准。

测试结果在当前页面持续显示，刷新通知列表失败不会覆盖投递结果。编辑表单内容后会提示重新测试；保存编辑或删除地址后清除原配置的测试结果。页面重新加载后会清空本次测试详情，主控保留最近投递时间与错误。

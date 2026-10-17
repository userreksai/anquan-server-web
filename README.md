# 安全中心 · Vue 前端

## Age 配置加密

管理设置提供“Agent 配置与加密”和“组件与主机策略”。明文区默认填入带中文解释的节点 YAML，包含文件、进程、SSH 登录、UDP 上报地址和调度设置。按实际节点修改路径；Agent 自动获取并上报本机出口 IP，无需填写 agent_ip。

## 组件与主机策略

页面顶部的“事件降噪与巡检保留”是独立的主控全局设置，不需要修改或下发 Agent YAML。“最低安全运行事件级别”默认选择“警告及以上（仅异常，推荐）”，普通 auditd 进程执行和 sudo 正常记录不入库、不通知；可改为全部、信息及以上、提示及以上、错误及以上或严重。SSH 登录、安全告警、操作命令及单独开启的 sudo 录制文件上传不受影响，已有历史保留。该字段为 `security_event_min_severity`，缺字段的旧版主控按警告展示，但保存需要配套更新主控。Tetragon 还可按具体事件类型多选屏蔽，并可一键屏蔽进程执行和退出、逐项取消或清空选择。默认不屏蔽任何类型；保存后，所选类型的新上报不入库、不通知，已有记录和其他来源的事件不受影响。

巡检记录（`scan_summary`）默认仅保留最近 24 小时，也可改为 12 小时。主控按事件发生时间每分钟清理到期巡检记录，已有过期记录也会清理；安全告警、SSH 登录和操作命令不受影响。设置使用已认证的 `GET/PUT /api/settings/event-policy`，读取失败时不能保存，保存失败保留编辑内容，只有服务端确认后才显示生效。事件列表顶部提供设置入口；`pnpm test:event-policy` 覆盖读取失败、服务端确认、重试、鉴权过期及卸载取消等行为。

打开“组件与主机策略”，选择基础审计预设或读取当前 YAML，填写组件表单，再点击“写入下方 YAML”。表单通过 Master 的 YAML 解析和合并接口更新 `security`，保留其他配置及已有扩展字段；数组和内核参数清单按本次表单替换。写入只更新编辑器，不会直接配置机器，之后复用原有模板、加密或选择机器下发流程。表单有未写入修改时会阻止使用旧 YAML 下发。

基础预设启用原生文件监控、auditd、sudo 录制及 SSH 失败认证检测，允许 Agent 安装所需系统包；主机策略默认 `audit`，仅检查，不直接加固。Tetragon 默认关闭，版本预设为 `v1.7.1`，勾选后可自动获取官方安装包与校验值；自定义下载源需明确 SHA-256。sudo 会话文件上传、文件文本差异、SSH 与 GRUB 加固默认关闭。sudo 高级授权以 JSON 数组表达用户、目标身份和命令，由 Agent 生成并校验 sudoers；它不会撤销其他配置中的既有 `ALL` 授权。

状态区显示每台机器最近的组件运行、安装和配置结果，以及系统发行版、架构、内核、CPU 和 BTF 信息。正常稳定只更新最新状态快照，异常、状态变化和恢复保留事件记录，已有历史记录不删除。新版 Agent 内部仍按原周期检查（默认 30 秒），下次检查发现异常、状态变化或恢复时上报，默认正常稳定约每 5 分钟发送一次快照，长检查周期按实际周期刷新；旧版 Agent 也由新版 Master 过滤重复正常历史。前端对 `status_reporting: changes_only` 按两倍 `snapshot_interval_seconds` 判断历史状态（至少 2 分钟，仅接受 1–86400 的数值整数）；旧版或无效间隔仍按 2 分钟判断，组件错误显示 Agent 的实际说明。sudo 会话文件通过已认证请求下载，尚未收齐的文件不能下载；完整文件按原文件名放回同一会话目录后使用 `sudoreplay`，初版不提供浏览器播放器。下载文件包含 IP 和会话 ID 前缀以区分来源，回放前请恢复原文件名。

事件页增加“安全运行事件”和“组件状态”筛选，详情显示来源、操作人、进程、命令、路径、会话及关联字段。正常事件显示“已记录”；`warning/error/critical` 安全运行事件显示“待处理”。计划任务开始、成功和失败来自显式包装入口 `anquan -task-run NAME -- /绝对命令 参数`；普通 cron 配置监控无法得知旧任务的执行结果。

前端依赖新版 Master 的 `POST /api/settings/security-profile/compose`、`GET /api/security/status`、`GET /api/security/sudo-sessions` 与文件下载接口，继续使用原有连接和端口。关闭安全扩展会撤回 Agent 管理的配置并恢复其保存的策略值，不卸载已安装软件包。所有高级字段仍由 Master 和 Agent 再次校验。

验收截图位于 `docs/security-components-preview.jpg`、`docs/security-status-preview.jpg`、`docs/security-event-preview.jpg`，状态与事件截图使用隔离本机 Master 的显式测试示例，不代表已在真实 Linux 节点完成验证。任务详情将 Base64 输出解码为 UTF-8 预览，显示退出码、耗时与截断标记，二进制或无效编码会给出明确说明，原始事件仍可查看。类型检查、生产构建及 `pnpm test:security` 覆盖表单解析、合并、错误保留、未写入保护和输出预览相关契约。

页面不显示或要求填写公钥、私钥；后端和 Agent 代码内置固定配套密钥。编辑 YAML，点击加密即可复制密文或下载 `config.age`，放到 Agent 可执行文件旁边。输入变更会清除旧密文，避免下载过时配置。

点击“存储模板”将当前 YAML 原文保存到 Master 数据库，并保留注释、缩进和换行。“恢复示例”每次重新读取服务器上最新保存的模板；打开页面也优先载入该模板。跨浏览器、跨设备及服务重启后可继续使用。尚未保存时回退到内置示例，内置 `setup.prom` 使用固定的 `/var/lib/node_exporter/textfile_collector/process_monitor.prom`。未点击存储的编辑仅保留在当前页面，加密操作不会更新模板。保存失败会显示错误并保留输入；空内容、超过 4 MiB 或不合法的 YAML 不能覆盖原模板。

点击“下发配置”后搜索并勾选目标机器，Master 保存任务并通过 TCP 长连接投递；离线机器重连后接收，“已应用”以 Agent 确认为准。新版 Agent 通过 ANQUAN_MASTER 连接 TCP 55556，上报本机访问主控时使用的出口 IP，TCP 配置连接和 UDP 上报使用同一机器标识；无需本地配置也可登记并等待下发。YAML 的 server 列表独立向全部目标发送 UDP，裸 IP 使用 55555，例如 server: [192.168.0.1,192.168.0.2]；空列表仅关闭 UDP，不影响配置接收。

机器详情以 Agent 上报的本机 IP 显示机器标识，并在“连接来源”单独显示 Master 接收连接或上报时观察到的来源 IP。例如 Agent 为 `172.22.0.27`、Nginx 中转为 `172.22.240.6` 时，新版 Agent 与 Master 会将前者用于机器区分和配置下发，后者显示为连接来源。经过同一中转的不同本机 IP 可以分别登记。请同时更新 Agent 和 Master；旧版 Agent 仍可能按中转来源登记，已有中转 IP 记录保留，不自动拆分旧记录。多网卡机器使用访问主控时的出口 IP，该地址可能是内网 IP。

下发弹窗和配置状态列表均支持按 IP、主机名或别名搜索，以及每页 10/25/50/100 台分页。弹窗翻页和搜索时保留全部已选机器，“选择当前页”仅作用于当前页，“清空选择”取消所有页的选择；确认按钮显示实际下发总数。修改搜索条件或每页数量回到第一页，状态刷新保留查询和页码，机器减少时自动回到有效页。

依赖新版 Master 的 `GET/POST /api/settings/agent-encryption`、`GET/POST /api/settings/agent-config-template` 接口和新版 Agent 的外置配置支持。模板保存默认使用 `POST`，避免部分入口拒绝 `PUT`；新版 Master 继续接受旧版前端的 `PUT`。请先更新支持模板 POST 的 Master，再更新前端，旧版 Master 没有该 POST 路由。浏览器继续请求管理域名的同源 `/api/`，由主控写本机数据库；如果入口连 POST 也拒绝，前端改动不能保证消除 403。生产管理页面请通过 HTTPS 访问。更新配置无需重新编译 Agent；下次启动或常驻服务重启读取新配置。二进制只内置解密私钥，无法保证对节点 root 保密。

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
sudo sh deploy/deploy.sh --local
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

### systemd 主控与本机 Nginx：修复 API 路由

主控以 `anquan-master` systemd 服务运行，数据库位于同机 `/data/anquan/anquan.db` 时，网页 API 应由本机 Nginx 转发到 `127.0.0.1:10110`。浏览器继续访问管理域名的同源 `/api/`；主控直接写本机 SQLite，不访问 Agent 的中转域名。不要把浏览器请求改成 `localhost`，那会指向使用者自己的电脑。

现有站点只需修复 API 路由时，执行以下纯本地脚本。它不会联网、安装依赖、重建网页或重启主控，保留站点 SSL、页面目录和其他 location：

```sh
cd /opt/anquan/anquan-server-web
sudo sh deploy/repair-local-api.sh
# API location 位于现有 HTTPS 站点时，明确传入该配置文件，例如：
# sudo sh deploy/repair-local-api.sh /etc/nginx/sites-available/prodsafety.conf
```

默认修改 `/etc/nginx/conf.d/anquan.conf`。脚本支持文件中唯一的独立多行 `location /api/ { ... }` 或 `location ^~ /api/ { ... }`，要求块内为单行指令且恰好一个 `proxy_pass`。只将该块上游设为 `http://127.0.0.1:10110`，将 Host 设为 `$http_host`；未设置 Host 时自动补充。多个 API 块、嵌套块、include、跨行指令或其他无法明确处理的布局会报错，原文件不变。符号链接会解析到实际配置文件后修改，链接本身保留。

写入前将备份和暂存文件放在 `/var/backups/anquan-nginx/` 的独立目录，避免它们被 `sites-enabled/*` 等 Nginx include 误加载；保留原文件 owner/mode。执行 `nginx -t` 和 `systemctl reload nginx`，校验或重载失败时恢复原配置并尝试重新加载。成功后输出备份位置。先确认本机主控确实监听 TCP 10110；这个工具用于原生同机部署，Docker web 容器仍使用 `master:10110`。

后续重新部署网页时用 `sudo sh deploy/deploy.sh --local`，显式覆盖 `.deploy/master-upstream` 曾保存的外部地址，成功后保存本地地址。无参数更新继续沿用原保存地址，兼容前后端分机部署。完整部署仍需下载构建依赖，单纯修复请用上述本地脚本。

修复后正常链路为 `浏览器 → 管理 HTTPS 入口 → 本机 Nginx → 127.0.0.1:10110 → 本机 SQLite`。所有 HTTP 代理层应保留原始 Host（包括端口）；如入口已经改写 Host，后续保留该错误值仍可能触发 403。脚本保留既有认证、访问控制等规则；若它们拒绝 PUT，或主控未配置可信管理来源，需要同时修复对应规则，不能通过关闭来源校验解决。

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
pnpm test:templates
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
| 读取 Agent 模板 | `GET /settings/agent-config-template`：返回 `{yaml: string \| null}` |
| 保存 Agent 模板 | `POST /settings/agent-config-template`：`{yaml: string}`，返回保存原文；后端保留旧 `PUT` 兼容 |
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

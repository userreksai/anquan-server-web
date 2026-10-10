export const agentConfigTemplate = `# Anqu：编辑 YAML 后点击“加密配置”，将结果保存为 config.age。
# config.age 必须与 Agent 可执行文件放在同一目录；修改配置不必重新编译。
# 单次运行下次执行生效；-service 常驻模式替换配置后重启生效。
# 直接点击加密，无需填写或管理密钥；使用配套新版 Agent 读取。
# 配置区分大小写；fils 保留约定拼写；使用空格缩进。
# 配置中的路径属于目标节点。相对路径以节点程序所在目录为基准。
# output_dir、state_file 为报告与 MD5 基线存储位置，运行用户须有写入权限。
output_dir: /usr/local/anquan
state_file: state/md5.json   # 相对于 output_dir；新模块使用 .files/.processes/.logins 后缀
timezone: Asia/Shanghai     # 报告显示时区；日常日志切割始终使用北京时间

FilesMonitoring:
  fils:
    # 不提供 MD5：第一次获取文件 MD5，之后与上次成功扫描比较。
    #- /etc/ssh/sshd_config|/etc/ssh/ssh_config
    #- /etc/ssh/sshrc
    #- /etc/hosts.allow
    - /usr/local/123/
    # 目标不存在会产生 missing 日志和告警，请按实际情况调整。
    # 两个文件分别匹配任意一个允许 MD5 即可，数量不必与路径一一对应。
    # 以下 MD5 仅演示，启用前用目标文件的 md5sum 替换：
    # - /opt/app/a.conf|/opt/app/b.conf,d41d8cd98f00b204e9800998ecf8427e,900150983cd24fb0d6963f7d28e17f72,5d41402abc4b2a76b9719d911017c592
  dir:
    - /etc/cron.d/           # 递归计算普通文件，记录新增、修改、删除
  search:
    - authorized_keys,/root|/home/|/var/
    #- id_rsa,/root|/home/|/var/
    # 搜索指定文件名并校验允许值（以下 MD5 仍需替换）：
    # - authorized_keys,/root|/home|/var,d41d8cd98f00b204e9800998ecf8427e,900150983cd24fb0d6963f7d28e17f72

ProcessMonitoring:
  exists:
    - '/usr/local/SituationAwareness-agent/situation-awareness-agent-8002'
    # 按完整命令行匹配；| 分隔同一规则的多个可选命令，任意一个运行即正常。
    # - '/usr/sbin/sshd -D'
  # 省略整个 Process 段时，只检查 exists 中列出的进程是否存在。
  # Process: {} 开启全机进程增删与实例数量变化监控。
  # 白名单只免除变化告警，不免除 exists 检查；支持完整命令精确匹配。
  # Process:
  #   whitelist:
  #     - /usr/sbin/sshd -D

history:
  enabled: true             # 补传已有命令，此后每秒增量上传；需配套支持确认应答的 Master
  path: /var/log/history.log
  timezone: Local           # 与脚本 date 使用的节点时区一致
  poll_interval_ms: 1000    # 独立于下方文件巡检间隔
  max_records: 100          # 每批上限；有积压时连续分批补传

login:
  enabled: true
  source: journal            # journal（推荐）、authlog、jsonl、wtmp
  journal_command: journalctl
  initial_lookback_hours: 24  # journal/authlog/wtmp 初次回看时长
  timeout_seconds: 10
  max_records: 1000          # 每轮处理页上限，后续轮次继续读取
  # authlog：path 填 /var/log/auth.log 或 /var/log/secure
  # jsonl：path 填每行一条成功登录记录的 JSONL 文件
  # wtmp：path 填 /var/log/wtmp，last_command 填 last
  # path: /var/log/auth.log
  # last_command: last

# server: [] 表示仅生成本地通知、日志和指标；主控 UDP 默认监听 55555。
server:
  - 8.217.222.30:55555
# 下方为当前节点示例，部署其他节点必须修改，不能多台机器共用相同 IP。
# 删除 agent_ip 时，默认使用连接主控的本地出口地址。
agent_ip: 49.7.214.217

setup:
  logs: /var/log/时间anquan.log
  prom: /var/lib/node_exporter/textfile_collector/process_monitor.prom
  interval_seconds: 300     # -service 模式首次立即执行，此后每 300 秒检查
# logs 的“时间”或 {date} 替换为北京时间 YYYYMMDD，零点换新文件。
# prom 每轮采集后原子覆盖同一个文件，不按时间创建新文件。
# 旧 prom 文件名中的“时间”/{date}/{time} 会被移除；logs 不写占位符时自动添加日期前缀。
# 巡检数据较多时需要安排保留和轮替。旧 md5/existence 配置仍可使用。
`

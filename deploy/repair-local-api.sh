#!/bin/sh
set -eu

# Repair an existing native/systemd deployment; no downloads or frontend build.
[ "$#" -le 1 ] || { echo '用法：sudo sh deploy/repair-local-api.sh [站点配置路径]' >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo '请使用 sudo 或 root 执行。' >&2; exit 1; }
for command_name in awk nginx systemctl mktemp cp mv cmp readlink install; do
    command -v "$command_name" >/dev/null 2>&1 || { echo "需要现有命令：$command_name" >&2; exit 1; }
done
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
site=${1:-/etc/nginx/conf.d/anquan.conf}
if [ -L "$site" ]; then
    site=$(readlink -f -- "$site")
fi
[ -f "$site" ] || { echo "找不到现有站点配置：$site" >&2; exit 1; }
nginx -t || { echo '现有 Nginx 配置检查失败，请先修复配置。' >&2; exit 1; }

# Keep backup/staging outside Nginx include directories (sites-enabled/* etc.).
backup_root=${ANQUAN_NGINX_BACKUP_DIR:-/var/backups/anquan-nginx}
case "$backup_root" in
    /*) ;;
    *) echo '备份目录必须为绝对路径。' >&2; exit 1 ;;
esac
install -d -m 0700 -- "$backup_root"
work_dir=$(mktemp -d "$backup_root/repair.XXXXXX")
candidate="$work_dir/candidate.conf"
backup=''
changed=false
rollback() {
    echo "恢复原配置：$backup" >&2
    cp -p -- "$backup" "$candidate" || return 1
    mv -f -- "$candidate" "$site" || return 1
    nginx -t || return 1
    systemctl reload nginx || return 1
}
cleanup() {
    result=$?
    trap - EXIT HUP INT TERM
    if [ "$changed" = true ]; then
        if ! rollback; then
            echo "原配置已保留在 $backup；恢复/重载失败，请检查 Nginx。" >&2
            result=1
        fi
    fi
    rm -f -- "$candidate"
    if [ -z "$backup" ]; then rmdir -- "$work_dir" || true; fi
    exit "$result"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

# Preserve the original owner/mode; the editor emits nothing on ambiguity.
cp -p -- "$site" "$candidate"
awk -f "$script_dir/local-api.awk" "$site" > "$candidate"
if cmp -s -- "$site" "$candidate"; then
    echo 'API 已通过 127.0.0.1:10110 连接本机主控，并保留浏览器 Host。'
    exit 0
fi
backup="$work_dir/original.conf"
cp -p -- "$site" "$backup"
changed=true
mv -f -- "$candidate" "$site"
nginx -t || { echo '修改后配置检查失败，正在回滚。' >&2; exit 1; }
systemctl reload nginx || { echo 'Nginx 重载失败，正在回滚。' >&2; exit 1; }
changed=false
echo "本机 API 路由修复完成：$site"
echo "原配置备份：$backup"
echo '请重新保存模板；如仍为 403，请检查主控可信来源及 HTTPS 入口的访问规则。'

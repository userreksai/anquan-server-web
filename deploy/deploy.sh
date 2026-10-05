#!/bin/sh
set -eu

# Native Nginx deployment on Ubuntu/Debian.
if [ "$#" -gt 1 ]; then
  echo "用法：sudo sh deploy/deploy.sh [后端IP或域名:10110]" >&2
  exit 1
fi
[ "$(id -u)" -eq 0 ] || { echo '请使用 sudo 或 root 执行。' >&2; exit 1; }
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
config_dir="$repo_dir/.deploy"
if [ "$#" -eq 1 ]; then
  upstream=$1
elif [ -f "$config_dir/master-upstream" ]; then
  upstream=$(cat "$config_dir/master-upstream")
else
  upstream=127.0.0.1:10110
fi
if ! printf '%s\n' "$upstream" | LC_ALL=C grep -Eq '^[A-Za-z0-9][A-Za-z0-9.-]*:[0-9]{1,5}$'; then
  echo '后端地址格式应为 IPv4或域名:端口，例如 192.168.1.10:10110，不带 http:// 或路径。' >&2
  exit 1
fi
port=${upstream##*:}
if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
  echo '后端端口必须在 1–65535 范围内。' >&2
  exit 1
fi
command -v apt-get >/dev/null 2>&1 || { echo '自动安装支持 Ubuntu 22.04+/Debian 12+。' >&2; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo '需要 systemd。' >&2; exit 1; }
case "$(uname -m)" in
  x86_64) arch=x64; checksum=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6 ;;
  aarch64|arm64) arch=arm64; checksum=6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2 ;;
  *) echo '只支持 x86_64 / arm64。' >&2; exit 1 ;;
esac
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl tar xz-utils coreutils libstdc++6 nginx
curl -fsS --max-time 10 "http://$upstream/healthz" >/dev/null || { echo '后端不可达，请先启动后端并检查 TCP 10110。' >&2; exit 1; }

node_dir="/opt/anquan-tools/node-v24.21.0-linux-$arch"
if [ ! -x "$node_dir/bin/node" ]; then
  [ ! -e "$node_dir" ] || { echo "工具目录不完整，请检查：$node_dir" >&2; exit 1; }
  install -d -m 0755 /opt/anquan-tools
  stage=$(mktemp -d /opt/anquan-tools/.node-install.XXXXXX)
  trap 'rm -rf "$stage"' EXIT
  trap 'exit 130' HUP INT TERM
  curl -fL --retry 3 "https://nodejs.org/download/release/v24.21.0/node-v24.21.0-linux-$arch.tar.xz" -o "$stage/archive.tar.xz"
  printf '%s  %s\n' "$checksum" "$stage/archive.tar.xz" | sha256sum -c -
  tar -xJf "$stage/archive.tar.xz" -C "$stage" --strip-components=1
  rm "$stage/archive.tar.xz"
  mv "$stage" "$node_dir"
  trap - EXIT HUP INT TERM
fi
PATH="$node_dir/bin:$PATH"
export PATH
npm install --global --prefix "$node_dir" pnpm@11.19.0
cd "$repo_dir"
CI=true pnpm install --frozen-lockfile
pnpm run build

# Keep old releases, and restore the previous config if validation/reload fails.
install -d -m 0755 /var/www/anquan /var/www/anquan/releases "$config_dir"
[ ! -e /var/www/anquan/current ] || [ -L /var/www/anquan/current ] || { echo '/var/www/anquan/current 已存在且不是符号链接，请先检查。' >&2; exit 1; }
release=$(mktemp -d /var/www/anquan/releases/release.XXXXXX)
cp -R dist/. "$release/"
chmod -R a+rX "$release"
site=/etc/nginx/conf.d/anquan.conf
had_site=false
if [ -f "$site" ]; then
  cp -p "$site" "$config_dir/nginx.previous.conf"
  had_site=true
fi
old_release=$(readlink /var/www/anquan/current || true)
sed -e "s|http://master:10110|http://$upstream|g" \
    -e 's|root /usr/share/nginx/html;|root /var/www/anquan/current;|' \
    "$repo_dir/nginx.conf" > "$config_dir/nginx.conf"
install -m 0644 "$config_dir/nginx.conf" "$site"
rollback() {
  if [ "$had_site" = true ]; then
    cp -p "$config_dir/nginx.previous.conf" "$site"
  else
    rm -f "$site"
  fi
  if [ -n "$old_release" ]; then
    ln -sfn "$old_release" /var/www/anquan/current
  else
    rm -f /var/www/anquan/current
  fi
}
if ! nginx -t; then rollback; exit 1; fi
ln -sfn "$release" /var/www/anquan/current
systemctl enable nginx
if ! systemctl reload-or-restart nginx; then
  rollback
  systemctl reload-or-restart nginx || true
  exit 1
fi
printf '%s\n' "$upstream" > "$config_dir/master-upstream"
curl -fsS --max-time 5 http://127.0.0.1:10111/ >/dev/null
echo "前端部署成功：http://前端服务器IP:10111；后端：$upstream"

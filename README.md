# Server Watcher

Server Watcher 是一个低占用的服务器资源看板，面向多用户 GPU 服务器。它提供 GPU、CPU、内存、存储、进程、用户聚合、审计日志、Web SSH 终端和自启动项目查看/管理能力。

默认监听 `0.0.0.0:33099`，适合用 frp 转发到外网访问。

## 功能

- 使用服务器现有 SSH 账号登录，不单独维护用户系统。
- 登录密码只用于当次 SSH 认证，不写入数据库或日志。
- 有网页访问时按前端选择的刷新间隔采集 GPU/CPU/内存/进程数据，支持 1 秒到 60 秒，默认 2 秒。
- 无人访问时进入低频模式，每 1 小时采集一次快照。
- 前端支持深色/浅色模式切换，并会在浏览器本地记住偏好。
- GPU 信息来自 `nvidia-smi`，包括每张卡利用率、显存、温度、功耗和进程。
- 进程页支持按用户、进程/命令、GPU 编号、CPU 阈值筛选。
- 进程操作支持 `SIGTERM` 和 `SIGKILL`，执行前需要重新输入 SSH 密码。
- Web 终端通过后端代理 SSH 到 `127.0.0.1`，权限等同于当前 Linux 用户。
- 存储空间默认每天凌晨 2 点扫描，按 `/home/<user>` 聚合，并提供用户柱形图和包含剩余空间的空间构成图。
- 自启动页汇总 `systemd`、`cron`、`pm2`、`docker`、`supervisor`。
- systemd 的 start/stop/restart/enable/disable 通过 sudo 执行，需要二次输入密码。
- 审计日志记录登录、终端、进程操作、自启动操作、采集和存储扫描。

## 架构

```text
browser
  -> React/Vite frontend
  -> Node.js backend on :33099
       -> /proc, ps, df, du, nvidia-smi
       -> localhost SSH for auth, terminal, kill, sudo systemctl
       -> data/events.jsonl and data/storage.json
```

生产运行时只有一个 Node.js 后端进程。前端构建为静态文件，由后端直接托管。推荐使用 Docker Compose 部署，把 Node 运行时、前端构建产物和后端依赖打包在同一个镜像里。

## 服务器要求

- Linux 服务器。
- Docker Engine 和 Docker Compose v2 推荐。
- NVIDIA 服务器用 Docker 部署时，需要安装 NVIDIA Container Toolkit。
- 如果不用 Docker，Node.js 18+ 或 20+ 推荐，并需要 `npm`。
- `sshd` 正常运行，并允许本机 `127.0.0.1` SSH 密码认证。
- NVIDIA 服务器需要安装 `nvidia-smi`。
- 如需 systemd 操作，登录用户需要在 sudoers 中拥有相应权限。

## 本地开发

```bash
npm run install:all
npm run build
npm start
```

访问：

```text
http://127.0.0.1:33099
```

前后端分开开发：

```bash
npm run dev:backend
npm run dev:frontend
```

Vite 开发端口是 `5173`，会代理 `/api` 和 `/ws` 到 `33099`。

## Docker 部署（推荐）

建议部署到：

```bash
cd ~/Projects
git clone https://github.com/YOUR_ORG_OR_USER/server-watcher.git gpu-watcher
cd ~/Projects/gpu-watcher
docker compose up -d --build
```

访问：

```text
http://服务器IP:33099
```

常用命令：

```bash
docker compose logs -f server-watcher
docker compose restart server-watcher
docker compose down
```

更新：

```bash
git pull
docker compose up -d --build
```

`docker-compose.yml` 默认使用：

- `network_mode: host`：容器内 SSH 到 `127.0.0.1` 等于 SSH 到宿主机。
- `pid: host`：进程表读取宿主机进程。
- `gpus: all`：允许容器调用 NVIDIA 工具。
- `/home:/home:ro`：只读扫描用户目录空间。
- `/etc`、`/lib/systemd`、`/usr/lib/systemd` 只读挂载到 `/host/...`：自启动页面可读取宿主机 unit 文件。
- `./data:/app/data`：审计日志和存储扫描结果持久化到项目目录。

镜像运行时不安装额外 apt 包。容器内没有 `ps` 时，后端会直接读取宿主机 PID namespace 下的 `/proc`，并用 `/host/etc/passwd` 映射用户名。

如果 Docker 不能看到显卡，先确认宿主机已经配置 NVIDIA Container Toolkit：

```bash
docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
```

## Node/systemd 部署

不用 Docker 时可以直接在服务器安装依赖：

```bash
bash scripts/bootstrap-server.sh
```

临时运行：

```bash
WATCHER_PORT=33099 npm start
```

安装 systemd：

```bash
bash scripts/install-systemd.sh
```

查看状态：

```bash
systemctl status server-watcher --no-pager
journalctl -u server-watcher -f
```

systemd 模板默认使用独立服务账号 `server-watcher`，项目目录为 `/opt/server-watcher`。如果你的部署账号或目录不同，先修改 [deploy/server-watcher.service](deploy/server-watcher.service) 中的：

```ini
WorkingDirectory=
User=
Group=
Environment=WATCHER_DATA_DIR=
ReadWritePaths=
```

## 环境变量

可以参考 [.env.example](.env.example)。

常用配置：

```bash
WATCHER_HOST=0.0.0.0
WATCHER_PORT=33099
WATCHER_SSH_HOST=127.0.0.1
WATCHER_SSH_PORT=22
WATCHER_STORAGE_ROOTS=/home
WATCHER_STORAGE_SCAN_HOUR=2
WATCHER_SYSTEMD_DIRS=/etc/systemd/system,/lib/systemd/system,/usr/lib/systemd/system
WATCHER_DATA_DIR=./data
WATCHER_PROCESS_LIMIT=250
```

限制允许登录的用户组：

```bash
WATCHER_ALLOWED_GROUPS=sudo,gpuwatcher
```

如果通过 HTTPS 访问，可以开启安全 Cookie：

```bash
WATCHER_SECURE_COOKIES=true
```

## frp 转发

示例：

```ini
[server-watcher]
type = tcp
local_ip = 127.0.0.1
local_port = 33099
remote_port = 33099
```

如果使用 HTTP/HTTPS 类型转发，请确保外层有 HTTPS 或访问白名单。这个系统能看到用户名、命令行和进程资源占用，不建议裸奔公开。

## SSH 登录和权限

登录流程：

1. 浏览器提交 Linux 用户名和 SSH 密码。
2. 后端尝试 SSH 到 `127.0.0.1`。
3. 登录成功后只保存 session，不保存密码。
4. Web 终端和危险操作会再次要求输入密码。

进程 kill：

- 默认执行：`kill -TERM <pid>` 或 `kill -KILL <pid>`。
- 勾选 sudo 后执行：`sudo -S kill -TERM <pid>`。
- 是否允许由 Linux 权限和 sudoers 决定。

systemd 操作：

```bash
sudo systemctl restart xxx.service
sudo systemctl stop xxx.service
sudo systemctl enable xxx.service
sudo systemctl disable xxx.service
```

## 数据文件

默认在 `data/`：

- `events.jsonl`：审计日志。
- `storage.json`：最近一次存储扫描结果。

日志超过 `WATCHER_LOG_MAX_BYTES` 会自动轮转。

## 安全建议

- 强烈建议外网访问走 HTTPS。
- 配置 `WATCHER_ALLOWED_GROUPS`，只允许指定用户组登录。
- 不要用 root 运行 server-watcher。
- 通过 sudoers 精确控制哪些用户可以 kill 其他用户进程或管理 systemd。
- frp 暴露到公网时建议叠加 IP 白名单或反向代理认证。

## 常见问题

### 登录失败

确认服务器本机能执行：

```bash
ssh your-user@127.0.0.1
```

如果服务器禁止密码登录，需要在 sshd 配置中允许本机密码认证，或后续改造为 SSH key/PAM 模式。

### 页面没有 GPU

确认运行服务的 Linux 用户能执行：

```bash
nvidia-smi
```

### 存储扫描慢

存储扫描使用 `du -sk`，默认只在凌晨 2 点跑一次。大目录手动扫描可能耗时较长，可以通过 `WATCHER_STORAGE_ROOTS` 缩小扫描范围。

### systemd 操作失败

确认当前登录用户有 sudo 权限，并且 sudoers 允许对应的 `systemctl` 操作。

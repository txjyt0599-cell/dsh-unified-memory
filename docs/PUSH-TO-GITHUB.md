# 推送到 GitHub 的正确姿势（本机实测 · 2026-10-29）

> 记录一次真实踩坑。下次要推代码时照这个来，别浪费时间。

## 本机的两个坑

### 坑 1：全局 insteadOf 把 github.com 改写成 gh-proxy

```
url.https://gh-proxy.com/https://github.com/.insteadof = https://github.com/
```

后果：**任何** github.com 的 URL 都会被改走 `gh-proxy.com`，而那是**只读镜像代理**，不支持 push 认证。

更坑的是：`git remote set-url` 设完立刻被改回去，用 `-c url...insteadOf=` 传空也盖不掉。

**解法**：直接改 `.git/config` 文件，并且运行时设 `GIT_CONFIG_GLOBAL=NUL` 让全局规则失效。

### 坑 2：github.com 直连被墙

```
curl https://github.com              → 000（超时）\ncurl -x http://127.0.0.1:7890 ...  → 200
```

所以必须走本机代理 7890。

## 正确配置（三行，都在仓库本地）

```bash
cd <仓库目录>

# 1) 远程用真实 URL（写在 .git/config 里，别用 set-url）
#    url = https://github.com/<user>/<repo>.git

# 2) 让 git 走本地代理
git config --local http.proxy http://127.0.0.1:7890
git config --local https.proxy http://127.0.0.1:7890
```

## 推送

```powershell
$env:GIT_CONFIG_GLOBAL='NUL'   # 屏蔽全局 insteadOf
$env:GIT_TERMINAL_PROMPT='1'
git push -u origin main
```

## 成功的样子

```
branch 'main' set up to track 'origin/main'.
 * [new branch]      main -> main
```

⚠️ PowerShell 会把 git 的 stderr 报成 "NativeCommandError"、退出码 1 ——
**这是误报**，看有没有 `[new branch]` 才是真的。

## 验证

```bash
git ls-remote origin      # 应看到 ef45574... refs/heads/main
```

或直接开 https://github.com/<user>/<repo> 看文件在不在。

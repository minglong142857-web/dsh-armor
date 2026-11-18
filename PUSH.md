# 推送到 GitHub

仓库已就绪：`main` 分支、51+ 文件、无密钥、无个人路径、bundle 已生成。

## 方式 A：本机直接推（推荐）

```powershell
cd D:\文档\deepseek-harness\default-workspace\dsh-armor

# 1) 先在网页上建一个空仓库（不要勾 README / .gitignore / LICENSE）
#    名字建议 dsh-armor，Public

# 2) 关联并推送（首次会弹 Git Credential Manager 登录）
git remote add origin https://github.com/<你的用户名>/dsh-armor.git
git push -u origin main
```

## 方式 B：换机器推（用 bundle）

```powershell
git clone dsh-armor.bundle dsh-armor
cd dsh-armor
git remote set-url origin https://github.com/<你的用户名>/dsh-armor.git   # clone 后 remote 指向 bundle
git remote add github https://github.com/<你的用户名>/dsh-armor.git
git push github main
```

## 方式 C：装了 gh CLI 的话

```powershell
gh auth login
gh repo create dsh-armor --public --source . --push --description "Armor-off patch pack for DeepSeek Harness + Antigravity operator-contract kit"
```

## 建仓后建议填的元信息

- **Description**：Armor-off patch pack for DeepSeek Harness (9 host patches) + Antigravity hooks/relay kit
- **Topics**：`dsh` `dsh-plugin` `deepseek-harness` `antigravity` `agent` `hooks` `mitm` `jailbreak-research`
- **License**：MIT（仓库内已有 LICENSE）

## 推送后再做的两件事

1. 把两处 `minglong142857-web` 换成你的用户名：`package.json` 的 `dsh.install.git`、README 里的 clone 示例。
2. 想发 npm：`npm publish --access public`（bin 已注册为 `dsh-armor`）。

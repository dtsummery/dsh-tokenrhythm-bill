# dsh-tokenrhythm-bill

**基元律动费用中心** —— DeepSeek Harness（DSH）插件。把 [基元律动 tokenrhythm.studio](https://tokenrhythm.studio) 的**模型清单**、**账户余额 / 用量**和**本机凭据池**放进一个可拖拽的浮层面板；选中哪条凭据，就用哪把 API Key 跑模型、用哪条 Cookie 查余额——并且能把该 Key 同步接管到 DSH 会话（新会话立即生效）。

- 侧栏位置：在「**记忆系统 / 技能中心**」两行**下方**，条目名「**基元费用**」，右侧常驻余额胶囊
- 面板页签：**余额 / 模型 / 密钥**（开启 ZCode 集成后另有 用量 / 活动）
- 凭据只存本机（`~/.dsh/tokenrhythm-bill-state.json`，0600）

---

## 一、安装

> 三种方式任选其一；**装完必须重启 DSH Desktop**，侧栏才会出现「基元费用」条目。

### 方式 1：插件市场（收录后可用）
DSH → 设置 → 插件市场 → 搜索「基元律动费用中心」或 `dsh-tokenrhythm-bill` → 一键安装。

### 方式 2：命令行 · npm（推荐，秒级）
```sh
dsh plugin --profile web add dsh-tokenrhythm-bill
```

### 方式 3：命令行 · GitHub（追新 / 自己改过）
```sh
dsh plugin --profile web add github:dtsummery/dsh-tokenrhythm-bill
```

### 更新
```sh
# npm 源：重复安装即更新
dsh plugin --profile web add dsh-tokenrhythm-bill

# GitHub 源：依赖按 commit 锁定，必须先卸再装（或 pnpm update）
dsh plugin --profile web remove dsh-tokenrhythm-bill
dsh plugin --profile web add github:dtsummery/dsh-tokenrhythm-bill
```
装完**重启 DSH** 生效。

### 卸载
```sh
dsh plugin --profile web remove dsh-tokenrhythm-bill
```

> `--profile` 换成你实际使用的 profile 名（本文档示例用 `web`）。`dsh plugin` 会同时维护该 profile `package.json` 里的 `dsh.profile.bundles` 登记，不要用裸 `pnpm add/remove` 代替。

---

## 二、首次配置（2 分钟）

1. 点侧栏「**基元费用**」条目打开面板 → 切到「**密钥**」页
2. 填 **API Key** 和/或 **Cookie**（至少一项）→ 点「**保存**」
   - **API Key**：用于拉取模型清单
   - **Cookie**：登录 [tokenrhythm.studio](https://tokenrhythm.studio) 后按 F12 → 应用 → Cookie，复制 `tr_session` 的值；**整段 Cookie 粘贴也认**（会原样保留）
   - 两者都只保存在本机
3. 在下方列表里点该条右侧的「**使用**」→ 它变成「当前」，身份切换完成
4. 回到「余额 / 模型」页签即可使用；侧栏条目右侧会常驻显示余额

> **保存**只入库、**不会**自动选用（避免误切身份）；选用统一由列表里的「使用」触发。

---

## 三、使用说明

### 余额页签
- **账户余额主卡**：总余额（千分位）、限时额度与倒计时胶囊（≤3 天转警示色）、限时占比条、冻结金额
- **当日使用**：调用次数、输入/输出/缓存 tokens、当日花费（本地 0 点起算）
- **近 7 个有记录日的花费柱状图**：悬停看当日各模型消费明细（Top 6 + 其他）
- **最近调用**列表；数据归属账号标注；每 60 秒自动刷新；临期/低余额时顶部预警条
- 会话过期时，提示条可直接跳到「密钥」页更新 Cookie，或到设置页用账号密码重新登录

### 模型页签
- 分类 chips：全部 / 文本 / 图像 / 音频 / 视频 / 向量（带计数）
- 卡片展示名称、平台状态胶囊（在线 / 测试中）、模型 ID + 来源、序列长度 / 支持模态 / 最大输出、输入·输出·缓存·图片单价（折扣时划线原价）
- **点卡片即复制模型 ID**；模型清单跟随「当前凭据」：凭据带 API Key 时用该 Key 的网关清单，否则回落到会话 Cookie 的平台清单

### 密钥页签（本机凭据池）
- **保存**：API Key 与 Cookie 两个等高输入框，至少填一项；保存只入库
- **列表**：每条**两行完整明文**展示保存的 Key 与 Cookie（长串自动换行不截断），下方一行是这条凭据**最后一次查询到的余额**与时间
- **复制**：Key 行 / Cookie 行尾各有一个「复制」；右侧「复制」把整条合成一段（Key 换行 + Cookie 原文）复制
- **使用 / 当前**：点「使用」切换身份；已选中的显示「当前」，**再点一次即停用**（清空会话并还原 DSH 会话 Key）
- **删除**：移除该条；若删的是当前使用项，同时解除它在模型与余额上的应用（之后余额不可查，除非用账号密码登录）

### 设置（面板右上角 ⚙）
- **账号管理**：添加多个「手机号 + 密码」账号，支持一键切换 / 删除；密码存本机、可明文查看。会话过期时插件会**自动重登同一账号**（无感续期）
- **入口胶囊余额**：侧栏条目右侧胶囊显示「总余额」或「限时总余额」
- **ZCode 集成**（默认关闭）：开启后读取本机 `~/.zcode/v2` 凭证，出现「用量 / 活动」页签（套餐额度展示、活动一键领取）
- **插件更新**：比对 npm 最新版本（24h 缓存），有新版时提供「复制更新命令」，只提醒不自动执行

### DSH 会话凭据接管（重要）
在密钥页点「使用」一条**带 API Key** 的凭据时，插件会把这把 Key 写进 DSH 的凭据文件：

- 文件：`~/.dsh/.credentials.yaml` → `refs.<settings.yaml 里该 provider 的 apiKeyEnv>`（本机为 `TOKENRHYTHM_API_KEY`）
- DSH 的 credentials 服务监听该文件并**热重载**，所以**之后新开的会话立刻用这把 Key，无需重启 DSH**
- 首次接管前会**备份原值**；点「当前」停用、或删除该凭据时**自动还原**
- 写入是原子写，且只改目标那一行，其它键与 `records` 段一字不动
- 只写你自己在密钥页保存的 Key；不想被接管就别点「使用」，或点「当前」撤销

---

## 四、隐私与安全

- 凭据（API Key、会话 Cookie、账号密码）只保存在**本机** `~/.dsh/tokenrhythm-bill-state.json`（0600），不上传任何服务器
- 密钥页会**原样展示**你保存的 Key / Cookie（方便核对与复制），面板其它页面只显示掩码
- 「接管 DSH 会话 Key」只写本机 `~/.dsh/.credentials.yaml`，可随时停用还原
- ZCode 凭证只在插件后台内存与 `~/.zcode/v2` 本机文件中使用；相关接口为官方未公开接口、请求头伪装成桌面端，存在被平台风控的可能，请自行斟酌

---

## 五、排障

| 现象 | 处理 |
|---|---|
| 侧栏没有「基元费用」条目 | 装完要**重启 DSH**；确认插件已安装：`dsh plugin --profile web list` |
| 密钥页值显示为掩码（`sk_tr…(49)`） | 插件后台还没换新版本：**重启 DSH** 一次即可 |
| 侧栏条目疑似引发界面卡顿/异常 | 设环境变量 `DSH_TOKENRHYTHM_NO_SIDEBAR=1` 后重启 DSH，插件会跳过侧栏条目注入（面板本体照常加载），据此二分定位 |
| 余额显示「会话已过期」 | 到「密钥」页更新该条 Cookie，或到设置页用账号密码重新登录 |
| 切换凭据后图表变 ¥0 | 余额/用量按身份隔离：切到没数据的凭据自然为空，切回原凭据即恢复 |
| 想彻底回退会话 Key | 密钥页点「当前」停用，或删除该凭据；也可直接编辑 `~/.dsh/.credentials.yaml` |

DSH 启动异常时的日志：`%APPDATA%\DSH Desktop\logs\dsh-YYYY-MM-DD.log`（同目录 `*.error.log`、`crash-evidence\active-run.json`）。

---

## 六、界面预览

> 以下截图为早期版本，仅示意整体布局；当前界面：密钥页为本机凭据池（明文 + 复制 + 使用/删除），侧栏条目名为「基元费用」。

![模型页签](image/模型.png)

![余额主卡](image/余额.png)

![设置页](image/设置.png)

![侧栏入口](image/入口.png)

---

## 七、开发

仓库内 `lib/index.js`（host 半区：路由、凭据解析、余额/用量代理）与 `lib/client.js`（浏览器半区：面板与侧栏条目）即源码本体。

```sh
# 本地修改后：推仓库 → 重装 → 重启 DSH
git push
dsh plugin --profile web remove dsh-tokenrhythm-bill
dsh plugin --profile web add github:dtsummery/dsh-tokenrhythm-bill
```

MIT License。

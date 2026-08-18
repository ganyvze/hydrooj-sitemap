## HydroOJ Sitemap 插件

### 简介

* 自动生成并维护站点的 `sitemap.xml`，供搜索引擎抓取收录
* 覆盖题目、讨论、比赛、训练计划、首页等内容，均可在后台单独开关
* 内容超过单文件上限（默认 45000 条，符合 sitemaps.org 协议 50000 条硬上限）时自动拆分为 `sitemap.xml`（索引）+ `sitemap-1.xml`、`sitemap-2.xml` …
* 仅收录未被标记为 `hidden` 的公开内容，不会泄露仅所有者/维护者可见的内容
* 支持多域（domain），可指定只生成部分域，或生成全部域
* 每日自动重新生成（可关闭），也可在后台手动点击「立即重新生成」
* 附带生成一个基础的 `/robots.txt`（如果站点已有其他插件或反向代理提供 `robots.txt`，请关闭本插件对应路由或自行处理冲突）
* 配置独立存储在插件自己的数据库集合（`sitemap.config`）中，不依赖 HydroOJ 的全局系统设置（`ctx.setting.SystemSetting`）

### 安装

```bash
cd /root/.hydro/addons
git clone https://github.com/ganyvze/hydrooj-sitemap
hydrooj addon add /root/.hydro/addons/hydrooj-sitemap
pm2 restart hydrooj
```

一键安装：

```bash
cd /root/.hydro/addons && git clone https://github.com/ganyvze/hydrooj-sitemap && hydrooj addon add /root/.hydro/addons/hydrooj-sitemap && pm2 restart hydrooj
```

### 使用

* 本插件开箱即用，默认包含题目、讨论与首页，比赛、训练计划默认关闭
* 管理页面 route：`/manage/sitemap`，默认权限为 `PRIV_MANAGE_ALL_DOMAIN`，另见控制面板「Sitemap 管理」
* Sitemap 输出：
  * `/sitemap.xml` —— 主入口。内容未超限时即为完整的 urlset；超限时为 sitemap 索引，指向 `/sitemap-1.xml` 等分片
  * `/sitemap-:n.xml` —— 分片文件，仅在内容超过单文件上限时存在
  * `/robots.txt` —— 附带生成，包含 `Sitemap:` 指令指向 `/sitemap.xml`
* 后台可配置项：
  * **站点基础 URL**：用于生成绝对 `<loc>`。留空时插件会根据请求自动识别协议与域名（不保证在所有反向代理配置下都准确，建议手动填写）
  * **包含的域**：留空为全部域，否则填写以逗号或空格分隔的域 ID
  * **包含内容**：题目 / 讨论 / 比赛 / 训练计划 / 首页，独立开关
  * **更新频率**：写入每条 `<changefreq>`
  * **单文件最大 URL 数**：超过则自动拆分为 sitemap 索引，硬上限 50000（sitemaps.org 协议限制）
  * **每日自动重新生成**：依赖 HydroOJ 的每日任务（`task/daily`）触发；若未配置「站点基础 URL」则自动生成会被跳过（因为无法确定绝对 URL），此时可仍通过访问 `/sitemap.xml` 触发即时生成，或手动点击「立即重新生成」
* 生成结果会缓存 1 小时，避免爬虫高频访问时反复全量生成；保存配置或点击「立即重新生成」会清空缓存

### 其他

* 比赛与训练计划的可见性规则较为复杂（例如按赛制、按报名状态等），本插件仅做保守判断（排除 `hidden` 与作业类比赛），如需更严格的可见性控制建议保持默认关闭
* 未直接使用 `ctx.setting.SystemSetting` 注册全局系统设置，配置改为存储在插件自身的数据库集合中，通过独立的后台页面管理

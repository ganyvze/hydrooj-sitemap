# hydrooj-plugin-sitemap

为 HydroOJ 自动生成、定时刷新并托管 `sitemap.xml`（及 `sitemap_index.xml` 分片），用于搜索引擎收录（SEO）。

## 特性

- `/sitemap.xml`：单文件模式下直接输出全部公开 URL。
- `/sitemap_index.xml` + `/sitemap_<group>_<n>.xml`：当 URL 总量超过 `maxUrlsPerFile`（默认 45000，sitemap 协议硬上限 50000）时自动拆分。
- 覆盖范围：首页 / 题库入口 / 比赛与训练入口、公开域首页、系统域与各公开域下的公开题目、公开比赛、公开训练计划。
- 严格权限过滤：仅收录**游客（uid=0）**在对应域下、对应内容类型上确实拥有查看权限的条目——底层复用 HydroOJ 官方的 `UserModel.getById(domainId, 0)` + `hasPerm()` / `ProblemModel.canViewBy()` 判断逻辑，与站点真实的匿名访问行为完全一致，不做任何自行猜测的权限规则。
- 性能：内存缓存 + TTL（`cacheTime`）+ 周期性主动重建（`rebuildIntervalMinutes`，基于 `ctx.setInterval`）+ 题目/比赛/域变更事件驱动的缓存失效（`problem/*`、`contest/*`、`domain/*`）。请求路径永远只读内存缓存，不会触发实时全表扫描。
- 容错：单个域/题目/比赛处理失败不会中断整体生成；数据库异常时返回一个格式合法的空 sitemap 而不是 500 或半截错误页；重建失败时优先返回稍微过期的旧缓存（stale-while-revalidate）。

## 安装

```bash
cd /root/.hydro/addons
git clone https://github.com/ganyvze/hydrooj-sitemap
cd hydrooj-sitemap
npm install
hydrooj addon add /root/.hydro/addons/hydrooj-sitemap
pm2 restart hydrooj
```

## 本地开发构建

```bash
cd hydrooj-plugin-sitemap
npm install
npm run build   # 编译到 dist/
```

`hydrooj addon add` 加载的是编译后的 `dist/index.js`（见 `package.json` 的 `main` 字段），发布前请确保执行过 `npm run build`。

## 配置

插件配置项在 Hydro 系统设置中以 `Config` Schema 的形式注册（对应 `src/config.ts`），可通过管理后台的插件配置界面修改，或在数据目录的 `config.yaml` 中按插件名写入对应字段（具体方式取决于所用 Hydro 版本对插件配置 UI 的支持程度，请以实际后台界面为准）。

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `siteUrl` | string | `''`（自动） | 站点根域名（含协议，末尾不带斜杠）。留空时依次尝试系统设置 `server.url`，最终回退到 `https://oirush.xyz`。 |
| `cacheTime` | number | `360` | 内存缓存 TTL，单位分钟。 |
| `rebuildIntervalMinutes` | number | `360` | 主动全量重建周期，单位分钟，建议与 `cacheTime` 保持一致或略小。 |
| `includeProblems` | boolean | `true` | 是否收录公开题目。 |
| `includeContests` | boolean | `true` | 是否收录公开比赛与训练计划。 |
| `includeDomains` | boolean | `true` | 是否收录公开域首页。 |
| `maxUrlsPerFile` | number | `45000` | 单个分片文件最大 URL 数，超出自动拆分为 index + 多分片。 |
| `changefreqHome` / `priorityHome` | string / number | `daily` / `1.0` | 首页等系统级页面的 SEO 权重。 |
| `changefreqDomain` / `priorityDomain` | string / number | `weekly` / `0.8` | 域首页的 SEO 权重。 |
| `changefreqProblem` / `priorityProblem` | string / number | `weekly` / `0.6` | 题目页的 SEO 权重。 |
| `changefreqContest` / `priorityContest` | string / number | `daily` / `0.5` | 比赛/训练页的 SEO 权重。 |

## 验证

部署后可直接访问以下地址检查输出：

- `https://your-domain/sitemap.xml`
- 若数据量较大：`https://your-domain/sitemap_index.xml`

建议在站点根目录的 `robots.txt` 中补充：

```
Sitemap: https://your-domain/sitemap.xml
```

## 架构说明（供二次开发参考）

- `src/config.ts`：`Schema`（来自 `schemastery`，而非 `hydrooj` 直接导出）定义的系统配置项与默认值。
- `src/xmlBuilder.ts`：零依赖的 sitemap XML 构建工具（`urlset` / `sitemapindex`），带 XML 转义与分片切分。
- `src/generator.ts`：核心数据抓取与权限过滤逻辑，从 `DomainModel` / `ProblemModel` / `ContestModel` / `TrainingModel` / `UserModel` 捞取公开数据并组装成 `SitemapBundle`。
- `src/cache.ts`：内存缓存管理器，负责 TTL、并发去重（防止缓存击穿）、失败降级（返回旧缓存而非报错）。
- `src/index.ts`：插件入口，负责路由注册（`/sitemap.xml`、`/sitemap_index.xml`、`/sitemap_:shard.xml`）、启动预热、`ctx.setInterval` 定时重建、以及题目/比赛/域变更事件驱动的缓存失效。

## 已知限制 / 后续可优化方向

- 若域数量、题目数量极大（数十万级），单次全量重建耗时会相应增加；当前实现是"整份替换"式重建，未来可考虑增量更新单个 URL 而非全量重新生成。
- `siteUrl` 的自动探测依赖系统设置 `server.url`，如果该项在你的 Hydro 版本/部署中未配置，请显式在插件配置中填写 `siteUrl`，避免生成的 sitemap 使用错误的兜底域名。
- 本插件的 Model 调用方式（`UserModel.getById`、`ProblemModel.canViewBy`、`getMulti` 各参数签名等）已对照 HydroOJ 5.0.4 源码核实，但不同大版本之间 Model 层 API 可能有差异；升级 Hydro 主版本后建议重新核对 `src/generator.ts` 中的 Model 调用是否仍然匹配。

import Schema from 'schemastery';

/**
 * 插件配置 Schema。
 *
 * 说明：
 * - 该 Schema 会通过 ctx.plugin() 传入的 config 参数完成注入，
 *   也可以在 Hydro 管理后台的「系统设置 -> 插件配置」中修改（取决于具体 Hydro 版本的 UI 支持）。
 * - siteUrl 若未配置，将在运行时回退为系统 server.url（若可读取到），
 *   最终兜底为需求中指定的固定域名 https://oirush.xyz。
 */
export const Config = Schema.object({
    // ------------------------- 基础站点信息 -------------------------
    siteUrl: Schema.string()
        .role('url')
        .description('站点根域名（含协议，末尾不带斜杠），例如 https://oj.example.com。留空则尝试读取系统 server.url，最终回退为 https://oirush.xyz')
        .default(''),

    // ------------------------- 缓存与刷新策略 -------------------------
    cacheTime: Schema.number()
        .min(1)
        .description('Sitemap 内存缓存时长，单位：分钟。在此时间内的重复请求直接命中缓存，不触发数据库查询；到期后由定时任务或下一次访问触发重建。')
        .default(360), // 默认 6 小时

    rebuildIntervalMinutes: Schema.number()
        .min(1)
        .description('主动全量重建 Sitemap 缓存的周期，单位：分钟。基于 ctx.setInterval 实现的定时预热任务，建议与 cacheTime 保持一致或略小，避免访问高峰期出现"缓存过期后第一个请求扛全量查询"的抖动。')
        .default(360),

    // ------------------------- 模块开关 -------------------------
    includeProblems: Schema.boolean()
        .description('是否收录公开题目（Public Problems）到 sitemap 中。')
        .default(true),

    includeContests: Schema.boolean()
        .description('是否收录公开比赛 / 训练计划（Contests / Training）到 sitemap 中。')
        .default(true),

    includeDomains: Schema.boolean()
        .description('是否收录公开域（Public Domains）首页到 sitemap 中。')
        .default(true),

    // ------------------------- 单文件分片阈值 -------------------------
    maxUrlsPerFile: Schema.number()
        .min(100)
        .max(50000)
        .description('单个 sitemap 分片文件最多包含的 URL 数量（sitemap 协议硬上限为 50000），超过将自动拆分为多个分片并生成 sitemap_index.xml。')
        .default(45000),

    // ------------------------- SEO 权重与更新频率 -------------------------
    changefreqHome: Schema.union(['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never'])
        .description('首页 / 系统级页面的 changefreq')
        .default('daily'),
    priorityHome: Schema.number().min(0).max(1)
        .description('首页 / 系统级页面的 priority')
        .default(1.0),

    changefreqDomain: Schema.union(['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never'])
        .description('域首页的 changefreq')
        .default('weekly'),
    priorityDomain: Schema.number().min(0).max(1)
        .description('域首页的 priority')
        .default(0.8),

    changefreqProblem: Schema.union(['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never'])
        .description('题目页的 changefreq')
        .default('weekly'),
    priorityProblem: Schema.number().min(0).max(1)
        .description('题目页的 priority')
        .default(0.6),

    changefreqContest: Schema.union(['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never'])
        .description('比赛 / 训练页的 changefreq')
        .default('daily'),
    priorityContest: Schema.number().min(0).max(1)
        .description('比赛 / 训练页的 priority')
        .default(0.5),
});

export type SitemapConfig = ReturnType<typeof Config>;

/** 运行时兜底域名，需求中明确指定的固定值 */
export const FALLBACK_SITE_URL = 'https://oirush.xyz';

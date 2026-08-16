import { Context, Handler } from 'hydrooj';
import { SitemapCache } from './cache';
import { Config, SitemapConfig } from './config';

export { Config };

// 供 Handler 与其他插件访问缓存实例；用 module augmentation 声明而不是 `as any`，
// 这样 ctx.sitemapCache 在整个插件内是类型安全的。
declare module 'hydrooj' {
    interface Context {
        sitemapCache: SitemapCache;
    }
}

/**
 * /sitemap.xml、/sitemap_index.xml 以及各分片文件的统一处理 Handler。
 *
 * 安全说明：
 *   - 本 Handler 不读取当前登录用户身份，也不依赖 session/cookie 判断内容，
 *     因为 sitemap 内容必须对所有匿名爬虫呈现完全一致的「公开可见」结果集，
 *     数据本身在生成阶段（generator.ts）已经严格按「游客可见」过滤完毕。
 *   - Handler 本身只做「读缓存 -> 按文件名分发 -> 输出」，不做任何权限判断，
 *     因为权限判断必须发生在数据源头（generateSitemapBundle），而不是在响应阶段，
 *     这样可以避免"缓存里混入了私有数据但响应阶段又忘记过滤"的隐患。
 */
class SitemapHandler extends Handler {
    // sitemap 是完全公开的静态资源型接口，不需要登录，也不检查任何 PRIV/PERM，
    // 显式声明以便 Hydro 的权限中间件不会对匿名请求做拦截（对应源码中
    // `if (!h.noCheckPermView && ...) h.checkPerm(PERM.PERM_VIEW)` 的放行分支）。
    noCheckPermView = true;

    async get(_domainId: string, filename = 'sitemap.xml') {
        const { sitemapCache: cache } = this.ctx;
        let bundle;
        try {
            bundle = await cache.get();
        } catch (err) {
            // 数据库异常等极端情况下的最终兜底：返回一个空的合法 XML，
            // 保证爬虫收到的始终是「格式合法」的响应，而不是 500 或半截 HTML 错误页。
            this.ctx.logger.error('[sitemap] handler fallback to empty sitemap: %s', (err as Error)?.message);
            this.response.type = 'application/xml';
            this.response.body = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>\n';
            return;
        }

        // 文件名做白名单式清洗，防止路径穿越 / 非法字符污染 Map 查找 key
        const safeName = filename.replace(/[^a-zA-Z0-9_.-]/g, '');
        const xml = bundle.files.get(safeName) ?? bundle.files.get('sitemap.xml');

        if (!xml) {
            this.response.status = 404;
            this.response.type = 'text/plain';
            this.response.body = 'sitemap file not found';
            return;
        }

        this.response.type = 'application/xml';
        // sitemap 建议由 CDN / 反向代理短暂缓存，这里附带标准 HTTP 缓存头作为双保险
        this.response.addHeader('Cache-Control', 'public, max-age=1800');
        this.response.body = xml;
    }
}

/** 分片文件 Handler：/sitemap_problems_1.xml、/sitemap_contests_2.xml 等 */
class SitemapShardHandler extends SitemapHandler {
    async get(domainId: string, shard: string) {
        await super.get(domainId, `sitemap_${shard}.xml`);
    }
}

/**
 * 插件入口。HydroOJ 加载 addon 时会调用 apply(ctx, config)，
 * config 已经由 loader 依据本文件导出的 `Config` Schema 完成校验与默认值填充
 * （参见 hydrooj/src/loader.ts 中 `ctx.setting.requestConfig` -> `ctx.plugin(plugin, config)` 的调用链），
 * 因此这里不需要再手动调用 Schema.intersect 之类的方法重复校验。
 */
export async function apply(ctx: Context, config: SitemapConfig) {
    const cache = new SitemapCache(ctx, () => config);
    ctx.sitemapCache = cache;

    // ------------------------------------------------------------------
    // 路由注册
    // ------------------------------------------------------------------
    // 主入口：/sitemap.xml
    ctx.Route('sitemap_main', '/sitemap.xml', SitemapHandler);
    // Sitemap Index 入口（数据量大时使用）：/sitemap_index.xml
    ctx.Route('sitemap_index', '/sitemap_index.xml', SitemapHandler);
    // 分片文件：/sitemap_problems_1.xml、/sitemap_contests_2.xml 等，
    // 使用路由参数捕获任意 sitemap_*.xml 文件名，交由 Handler 内部从缓存 Map 中查找。
    ctx.Route('sitemap_shard', '/sitemap_:shard.xml', SitemapShardHandler);

    // ------------------------------------------------------------------
    // 启动时预热缓存（避免上线后第一个访问 sitemap 的请求/爬虫等待全量生成）
    // ------------------------------------------------------------------
    ctx.on('ready', async () => {
        try {
            await cache.forceRebuild();
        } catch (err) {
            ctx.logger.error('[sitemap] initial warm-up failed: %s', (err as Error)?.message);
        }
    });

    // ------------------------------------------------------------------
    // 定时任务：周期性全量重建缓存。
    //
    // 说明：HydroOJ 本身没有 node-schedule 风格的 cron 表达式任务系统，
    // 内置的 ScheduleModel 是一个基于 MongoDB + worker 服务的任务队列，
    // 面向的是"延迟执行 / 按固定 interval 重排"的后台任务，接入成本较高，
    // 也并非本插件这种"进程内内存缓存刷新"场景的最佳选择。
    //
    // 这里改用 Hydro/cordis 内置的 ctx.setInterval —— 它是 TimerService 提供的
    // 标准能力，效果等价于原生 setInterval，但会在插件被卸载/热重载时自动清理，
    // 不需要手动在 dispose 事件里 clearInterval。
    // ------------------------------------------------------------------
    const intervalMs = Math.max(1, config.rebuildIntervalMinutes) * 60 * 1000;
    ctx.setInterval(async () => {
        try {
            await cache.forceRebuild();
        } catch (err) {
            ctx.logger.error('[sitemap] interval rebuild failed: %s', (err as Error)?.message);
        }
    }, intervalMs);

    // 额外挂载到 Hydro 内置的每日任务钩子（worker 服务在每天凌晨触发一次 'task/daily'），
    // 作为"低峰期强制全量刷新一次"的补充手段；即使该事件在个别版本上不存在，
    // 也不影响上面的 setInterval 主策略正常工作。
    ctx.on('task/daily' as any, async () => {
        try {
            await cache.forceRebuild();
        } catch (err) {
            ctx.logger.error('[sitemap] task/daily rebuild failed: %s', (err as Error)?.message);
        }
    });

    // ------------------------------------------------------------------
    // 事件驱动增量失效：题目 / 比赛 / 域 发生变更时主动使缓存失效，
    // 而不是等到 TTL 到期或下一次定时任务才反映最新状态。
    // 这里只做"失效"（invalidate），真正的重建仍然发生在下一次 GET 请求
    // 或下一次定时任务触发时，避免"编辑接口"本身承担一次全量数据库扫描的开销。
    //
    // 事件名均来自 hydrooj/src/service/bus.ts 中 EventMap 的真实定义，
    // 注意 problem 侧是 'problem/delete'，而 contest 侧是 'contest/del'（命名不对称，
    // 这是 Hydro 历史遗留的命名差异，此处按真实事件名精确对齐，不做臆测）。
    // ------------------------------------------------------------------
    const invalidateOnChange = () => cache.invalidate();

    ctx.on('problem/add', invalidateOnChange);
    ctx.on('problem/edit', invalidateOnChange);
    ctx.on('problem/delete', invalidateOnChange);
    ctx.on('contest/add', invalidateOnChange);
    ctx.on('contest/edit', invalidateOnChange);
    ctx.on('contest/del', invalidateOnChange);
    ctx.on('domain/create', invalidateOnChange);
    ctx.on('domain/update', invalidateOnChange);
    ctx.on('domain/delete', invalidateOnChange);

    ctx.logger.info(
        '[sitemap] plugin loaded. siteUrl=%s, cacheTime=%dmin, rebuildInterval=%dmin',
        config.siteUrl || '(auto)', config.cacheTime, config.rebuildIntervalMinutes,
    );
}

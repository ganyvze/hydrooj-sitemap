import type { Context } from 'hydrooj';
import type { SitemapConfig } from './config';
import { generateSitemapBundle, SitemapBundle } from './generator';

/**
 * Sitemap 内存缓存管理器。
 *
 * 设计目标（对应需求中的「性能与缓存机制」）：
 *   1. 严禁每次请求 /sitemap.xml 时实时全表扫描 —— 请求路径永远只读内存缓存；
 *   2. 缓存过期时间可配置（cacheTime，单位分钟）；
 *   3. 定时任务（cron）到点后主动重建缓存，避免「过期后第一个请求扛全量查询」的抖动；
 *   4. 并发保护：若缓存已过期且此时有多个请求同时到达，只触发一次真实重建，
 *      其余请求复用同一个 in-flight Promise，防止「缓存击穿」。
 */
export class SitemapCache {
    private bundle: SitemapBundle | null = null;

    private expiresAt = 0;

    /** 正在进行中的重建任务，用于请求合并，防止并发重复查询数据库 */
    private inflight: Promise<SitemapBundle> | null = null;

    constructor(private readonly ctx: Context, private readonly getConfig: () => SitemapConfig) {}

    /** 判断当前缓存是否仍然有效（存在且未过期） */
    private isFresh(): boolean {
        return !!this.bundle && Date.now() < this.expiresAt;
    }

    /**
     * 获取当前可用的 sitemap 数据。
     * - 若缓存新鲜，直接返回内存数据，零数据库开销；
     * - 若缓存过期或为空，触发（或复用）一次重建；
     * - 若重建失败但仍有「旧缓存」，宁可返回稍微过期的旧数据，也不让站点 sitemap 端点报错/空白，
     *   这是搜索引擎收录场景下常见的降级策略（stale-while-revalidate 的简化版本）。
     */
    async get(): Promise<SitemapBundle> {
        if (this.isFresh()) return this.bundle as SitemapBundle;

        if (!this.inflight) {
            this.inflight = this.rebuild();
        }

        try {
            return await this.inflight;
        } catch (err) {
            this.ctx.logger.error('[sitemap] rebuild failed: %s', (err as Error)?.message);
            if (this.bundle) {
                // 降级：返回过期但仍然合法的旧缓存，避免端点直接 500 / 空白
                return this.bundle;
            }
            throw err;
        } finally {
            this.inflight = null;
        }
    }

    /** 真正执行一次全量重建，并写入内存缓存 */
    private async rebuild(): Promise<SitemapBundle> {
        const config = this.getConfig();
        const startedAt = Date.now();
        try {
            const bundle = await generateSitemapBundle(this.ctx, config);
            this.bundle = bundle;
            this.expiresAt = Date.now() + Math.max(1, config.cacheTime) * 60 * 1000;
            const cost = Date.now() - startedAt;
            const totalFiles = bundle.files.size;
            this.ctx.logger.info(
                '[sitemap] cache rebuilt in %dms, %d file(s), expires in %d min',
                cost, totalFiles, config.cacheTime,
            );
            return bundle;
        } catch (err) {
            this.ctx.logger.error('[sitemap] generateSitemapBundle threw: %s', (err as Error)?.stack || err);
            throw err;
        }
    }

    /** 手动强制失效缓存（供管理接口 / 事件钩子调用），下一次 get() 会触发重建 */
    invalidate(): void {
        this.expiresAt = 0;
    }

    /** 立即强制重建一次（例如系统启动时预热，或管理员手动点击"重建"按钮） */
    async forceRebuild(): Promise<SitemapBundle> {
        this.invalidate();
        return this.get();
    }
}

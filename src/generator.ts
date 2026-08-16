import type { Context } from 'hydrooj';
import {
    ContestModel, DomainModel, PERM, ProblemModel, SystemModel, TrainingModel, UserModel,
} from 'hydrooj';
import type { SitemapConfig } from './config';
import { FALLBACK_SITE_URL } from './config';
import {
    buildSitemapIndexXml, buildUrlsetXml, chunk, SitemapIndexEntry, SitemapUrlEntry,
} from './xmlBuilder';

/** 生成结果：可能是单一 urlset，也可能是 index + 多个分片 */
export interface SitemapBundle {
    /** 生成时间戳，用于日志与调试 */
    generatedAt: number;
    /**
     * 各文件名 -> XML 内容的映射。
     * 若未拆分，只有一个 key：'sitemap.xml'。
     * 若拆分，则包含 'sitemap_index.xml' 以及若干 'sitemap_xxx_N.xml'。
     */
    files: Map<string, string>;
}

/** 一个逻辑分组的 URL 集合，便于按类型（problems / contests / domains ...）切片 */
interface UrlGroup {
    /** 分片文件名前缀，如 'problems' -> sitemap_problems_1.xml */
    key: string;
    entries: SitemapUrlEntry[];
}

/**
 * 内置游客用户的 uid。
 * HydroOJ 中 uid=0 是保留的匿名/游客用户，UserModel.getById(domainId, 0) 会返回
 * 该用户在指定域下、按该域实际角色配置（含域主自定义的 guest 角色权限覆盖）解析出的
 * 真实权限对象，这是判断"该内容对匿名访客是否可见"最准确、最贴近生产行为的方式，
 * 优于手工枚举/猜测权限位。
 */
const GUEST_UID = 0;

/**
 * 判断某个域（domain）是否属于「公开域」——即游客在该域下是否拥有 PERM_VIEW（查看域基础内容）权限。
 *
 * 实现说明：
 *   没有直接读取/猜测 DomainDoc 上某个 boolean 字段，而是通过 UserModel.getById(domainId, 0)
 *   获得该域下游客用户的真实权限对象（内部已正确处理了域自定义 guest 角色、内置角色兜底等逻辑），
 *   再用 hasPerm(PERM.PERM_VIEW) 判断，这样即便域主在后台自定义了 guest 角色权限，
 *   本插件也能得出与真实站点行为一致的结果。
 */
async function isDomainPublic(ctx: Context, domainId: string): Promise<boolean> {
    try {
        const guest = await UserModel.getById(domainId, GUEST_UID);
        if (!guest) return false;
        return guest.hasPerm(PERM.PERM_VIEW);
    } catch (err) {
        // 权限查询异常时，出于安全考虑（宁可漏收录，不可误收录私有域），视为不公开
        ctx.logger.warn('[sitemap] isDomainPublic check failed for domain=%s: %s', domainId, (err as Error)?.message);
        return false;
    }
}

/**
 * 判断某场比赛是否应当被收录进 sitemap。
 *
 * 关键过滤条件（参照 HydroOJ 官方 ContestListHandler 对游客的可见性判定逻辑）：
 *   1. 游客必须拥有 PERM_VIEW_CONTEST 权限（该域是否对外开放比赛列表），由调用方预先判断并传入；
 *   2. cdoc.assign 字段：若非空数组，代表该比赛被定向分配给特定用户分组可见，
 *      游客不属于任何分组，因此一律视为不可见；只有 assign 为空/未设置时才对所有人公开。
 *      这与官方 handler 中 `assign: { $size: 0 }` 的查询条件完全一致。
 * 注意：HydroOJ 的比赛文档（Tdoc）本身并没有 `hidden` 字段，比赛的"隐藏"完全通过 assign 机制实现，
 * 因此这里不做（也不应做）hidden 字段判断。
 */
function isContestGuestVisible(cdoc: { assign?: string[] }, guestHasViewContestPerm: boolean): boolean {
    if (!guestHasViewContestPerm) return false;
    if (Array.isArray(cdoc.assign) && cdoc.assign.length > 0) return false;
    return true;
}

/** 安全地将日期转换为 ISO 字符串，任何异常都返回 undefined 而不是抛出 */
function safeIsoDate(d: unknown): string | undefined {
    try {
        if (!d) return undefined;
        const date = d instanceof Date ? d : new Date(d as string | number);
        if (Number.isNaN(date.getTime())) return undefined;
        return date.toISOString();
    } catch {
        return undefined;
    }
}

/** 解析最终使用的站点根域名：配置项 > 系统 server.url > 固定兜底值 */
function resolveSiteUrl(ctx: Context, config: SitemapConfig): string {
    if (config.siteUrl && config.siteUrl.trim()) {
        return config.siteUrl.trim().replace(/\/+$/, '');
    }
    try {
        // SystemModel.get 是同步读取内存缓存（服务启动时已从数据库加载），
        // 不同版本可能未设置该项（返回 undefined），因此仍需保底到固定域名。
        const fromSystem = SystemModel.get('server.url');
        if (fromSystem && typeof fromSystem === 'string' && fromSystem.trim()) {
            return fromSystem.trim().replace(/\/+$/, '');
        }
    } catch (err) {
        ctx.logger.warn('[sitemap] failed to read server.url from SystemModel: %s', (err as Error)?.message);
    }
    return FALLBACK_SITE_URL;
}

/**
 * 枚举所有「公开域」的域 ID 列表（不含 system，system 由调用方单独处理，避免重复收录首页）。
 * 使用游标逐条判断，避免一次性把大量域文档及其角色解析结果都放进内存。
 */
async function listPublicDomainIds(ctx: Context): Promise<string[]> {
    const result: string[] = [];
    try {
        const cursor = DomainModel.getMulti({}).project({ _id: 1 });
        for await (const ddoc of cursor) {
            try {
                const domainId: string = ddoc._id;
                if (!domainId || domainId === 'system') continue;
                if (await isDomainPublic(ctx, domainId)) result.push(domainId);
            } catch (innerErr) {
                ctx.logger.warn('[sitemap] skip domain during public-domain scan: %s', (innerErr as Error)?.message);
            }
        }
    } catch (err) {
        ctx.logger.warn('[sitemap] failed to enumerate domains: %s', (err as Error)?.message);
    }
    return result;
}

/**
 * 核心生成函数：全量扫描公开数据并构建 sitemap 分片。
 * 该函数只应在定时任务 / 缓存失效时被调用一次，绝不能挂在请求路径上做同步实时查询。
 */
export async function generateSitemapBundle(ctx: Context, config: SitemapConfig): Promise<SitemapBundle> {
    const siteUrl = await resolveSiteUrl(ctx, config);
    const groups: UrlGroup[] = [];

    // ------------------------------------------------------------------
    // 1. 系统级公开页面（首页、题库入口、比赛/训练列表入口等固定路由）
    // ------------------------------------------------------------------
    const staticEntries: SitemapUrlEntry[] = [
        { loc: `${siteUrl}/`, changefreq: config.changefreqHome, priority: config.priorityHome, lastmod: safeIsoDate(new Date()) },
        { loc: `${siteUrl}/p`, changefreq: config.changefreqHome, priority: Math.max(0, config.priorityHome - 0.1) },
    ];
    if (config.includeContests) {
        staticEntries.push({ loc: `${siteUrl}/contest`, changefreq: config.changefreqHome, priority: Math.max(0, config.priorityHome - 0.1) });
        staticEntries.push({ loc: `${siteUrl}/training`, changefreq: config.changefreqHome, priority: Math.max(0, config.priorityHome - 0.1) });
    }
    groups.push({ key: 'static', entries: staticEntries });

    // 预先计算一次公开域列表，题目 / 比赛 / 训练三个模块都会复用，避免重复扫描 domain 集合
    let publicDomainIds: string[] = [];
    if (config.includeDomains || config.includeProblems || config.includeContests) {
        publicDomainIds = await listPublicDomainIds(ctx);
    }

    // ------------------------------------------------------------------
    // 2. 公开域（Public Domains）首页
    //    HydroOJ 的域内路径通过 /d/:domainId/ 前缀中间件重写实现，
    //    system 默认域已经通过 '/' 收录，这里不重复添加。
    // ------------------------------------------------------------------
    if (config.includeDomains) {
        try {
            const domainEntries: SitemapUrlEntry[] = publicDomainIds.map((domainId) => ({
                loc: `${siteUrl}/d/${encodeURIComponent(domainId)}/`,
                changefreq: config.changefreqDomain,
                priority: config.priorityDomain,
            }));
            groups.push({ key: 'domains', entries: domainEntries });
        } catch (err) {
            ctx.logger.error('[sitemap] failed to generate domain entries: %s', (err as Error)?.message);
        }
    }

    // ------------------------------------------------------------------
    // 3. 公开题目（默认系统域 + 各公开域）
    // ------------------------------------------------------------------
    if (config.includeProblems) {
        try {
            const problemEntries: SitemapUrlEntry[] = [];
            const targetDomains = ['system', ...publicDomainIds];

            for (const domainId of targetDomains) {
                try {
                    // 该域下的游客用户权限对象，用于逐题调用官方 canViewBy 判断，
                    // 这是与真实站点行为完全一致的权威判断方式（含 hidden、own、
                    // PERM_VIEW_PROBLEM_HIDDEN 等所有分支），避免自行猜测过滤条件遗漏边界情况。
                    const guest = await UserModel.getById(domainId, GUEST_UID);
                    if (!guest || !guest.hasPerm(PERM.PERM_VIEW_PROBLEM)) continue;

                    // 数据库层面先做一次粗过滤（排除 hidden），减少后续逐条 canViewBy 判断的数据量；
                    // 真正精确的可见性判断仍然依赖 ProblemModel.canViewBy。
                    const query = { hidden: { $ne: true } };
                    const projection = {
                        docId: 1, pid: 1, title: 1, hidden: 1, owner: 1, maintainer: 1, updateAt: 1,
                    } as const;
                    const pcursor = ProblemModel.getMulti(domainId, query, projection as any);
                    for await (const pdoc of pcursor) {
                        try {
                            if (!ProblemModel.canViewBy(pdoc as any, guest)) continue;
                            // 题目 URL：系统域使用 /p/:pid，其余域使用 /d/:domainId/p/:pid
                            // 优先使用别名 pid（若配置），否则使用数字 docId
                            const idPart = pdoc.pid ? encodeURIComponent(pdoc.pid) : String(pdoc.docId);
                            const path = domainId === 'system'
                                ? `${siteUrl}/p/${idPart}`
                                : `${siteUrl}/d/${encodeURIComponent(domainId)}/p/${idPart}`;
                            problemEntries.push({
                                loc: path,
                                changefreq: config.changefreqProblem,
                                priority: config.priorityProblem,
                                lastmod: safeIsoDate((pdoc as any).updateAt),
                            });
                        } catch (innerErr) {
                            ctx.logger.warn('[sitemap] skip problem due to error: %s', (innerErr as Error)?.message);
                        }
                    }
                } catch (err) {
                    // 某个域题目查询失败（例如慢查询超时、域已被删除等）不应中断整体生成
                    ctx.logger.warn('[sitemap] failed to scan problems in domain=%s: %s', domainId, (err as Error)?.message);
                }
            }
            groups.push({ key: 'problems', entries: problemEntries });
        } catch (err) {
            ctx.logger.error('[sitemap] failed to generate problem entries: %s', (err as Error)?.message);
        }
    }

    // ------------------------------------------------------------------
    // 4. 公开比赛（Contests）+ 4b. 公开训练计划（Training）
    // ------------------------------------------------------------------
    if (config.includeContests) {
        const targetDomains = ['system', ...publicDomainIds];

        try {
            const contestEntries: SitemapUrlEntry[] = [];
            for (const domainId of targetDomains) {
                try {
                    const guest = await UserModel.getById(domainId, GUEST_UID);
                    if (!guest) continue;
                    const canViewContest = guest.hasPerm(PERM.PERM_VIEW_CONTEST);
                    if (!canViewContest) continue;

                    // 仅收录未做定向分配（assign 为空）的比赛，与官方比赛列表对游客的过滤条件一致
                    const query = { assign: { $size: 0 } };
                    const ccursor = ContestModel.getMulti(domainId, query);
                    for await (const cdoc of ccursor) {
                        try {
                            if (!isContestGuestVisible(cdoc as any, canViewContest)) continue;
                            const path = domainId === 'system'
                                ? `${siteUrl}/contest/${cdoc.docId}`
                                : `${siteUrl}/d/${encodeURIComponent(domainId)}/contest/${cdoc.docId}`;
                            contestEntries.push({
                                loc: path,
                                changefreq: config.changefreqContest,
                                priority: config.priorityContest,
                                lastmod: safeIsoDate((cdoc as any).updateAt ?? cdoc.beginAt),
                            });
                        } catch (innerErr) {
                            ctx.logger.warn('[sitemap] skip contest due to error: %s', (innerErr as Error)?.message);
                        }
                    }
                } catch (err) {
                    ctx.logger.warn('[sitemap] failed to scan contests in domain=%s: %s', domainId, (err as Error)?.message);
                }
            }
            groups.push({ key: 'contests', entries: contestEntries });
        } catch (err) {
            ctx.logger.error('[sitemap] failed to generate contest entries: %s', (err as Error)?.message);
        }

        // TrainingModel 是独立集合、独立权限位（PERM_VIEW_TRAINING），
        // 且训练文档没有 assign 定向分配机制，仅由权限位控制整体可见性，因此单独处理。
        try {
            const trainingEntries: SitemapUrlEntry[] = [];
            for (const domainId of targetDomains) {
                try {
                    const guest = await UserModel.getById(domainId, GUEST_UID);
                    if (!guest || !guest.hasPerm(PERM.PERM_VIEW_TRAINING)) continue;
                    const tcursor = TrainingModel.getMulti(domainId, {});
                    for await (const tdoc of tcursor) {
                        try {
                            const path = domainId === 'system'
                                ? `${siteUrl}/training/${tdoc.docId}`
                                : `${siteUrl}/d/${encodeURIComponent(domainId)}/training/${tdoc.docId}`;
                            trainingEntries.push({
                                loc: path,
                                changefreq: config.changefreqContest,
                                priority: config.priorityContest,
                                lastmod: safeIsoDate((tdoc as any).updateAt),
                            });
                        } catch (innerErr) {
                            ctx.logger.warn('[sitemap] skip training due to error: %s', (innerErr as Error)?.message);
                        }
                    }
                } catch (err) {
                    ctx.logger.warn('[sitemap] failed to scan trainings in domain=%s: %s', domainId, (err as Error)?.message);
                }
            }
            groups.push({ key: 'trainings', entries: trainingEntries });
        } catch (err) {
            ctx.logger.error('[sitemap] failed to generate training entries: %s', (err as Error)?.message);
        }
    }

    // ------------------------------------------------------------------
    // 5. 组装输出文件：根据总量决定是否需要 sitemap index 分片
    // ------------------------------------------------------------------
    const files = new Map<string, string>();
    const totalUrls = groups.reduce((sum, g) => sum + g.entries.length, 0);
    const needSplit = totalUrls > config.maxUrlsPerFile
        || groups.some((g) => g.entries.length > config.maxUrlsPerFile);

    if (!needSplit) {
        // 单文件模式：所有条目合并进一个 urlset
        const allEntries = groups.flatMap((g) => g.entries);
        files.set('sitemap.xml', buildUrlsetXml(allEntries));
    } else {
        // 分片模式：每个分组按 maxUrlsPerFile 拆分为多个子文件，并生成 index
        const indexEntries: SitemapIndexEntry[] = [];
        for (const group of groups) {
            if (group.entries.length === 0) continue;
            const parts = chunk(group.entries, config.maxUrlsPerFile);
            parts.forEach((part, i) => {
                const filename = `sitemap_${group.key}_${i + 1}.xml`;
                files.set(filename, buildUrlsetXml(part));
                indexEntries.push({ loc: `${siteUrl}/${filename}`, lastmod: safeIsoDate(new Date()) });
            });
        }
        files.set('sitemap_index.xml', buildSitemapIndexXml(indexEntries));
    }

    return { generatedAt: Date.now(), files };
}

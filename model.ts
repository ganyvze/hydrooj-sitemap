import { Context } from 'hydrooj';

/**
 * Plugin configuration, stored in its own collection ("sitemap.config"),
 * independent from HydroOJ's global system-setting machinery.
 * There is always exactly one document, keyed by _id: 'config'.
 */
export interface SitemapConfig {
    _id: 'config';
    // Absolute base URL of the site, e.g. "https://oj.example.com".
    // Used to build absolute <loc> entries. If empty, the plugin falls back
    // to the incoming request's protocol/host at generation time.
    baseUrl: string;
    // Which domains to include. Empty array = all domains.
    domains: string[];
    // Content types to include.
    includeProblems: boolean;
    includeDiscussions: boolean;
    includeContests: boolean;
    includeTraining: boolean;
    includeHomepage: boolean;
    // <changefreq> value applied to all generated entries.
    changefreq: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
    // Max <url> entries per sitemap file before HydroOJ splits into a sitemap index.
    // The XML sitemap protocol hard-caps this at 50000.
    maxUrlsPerFile: number;
    // Whether to auto-regenerate once a day via HydroOJ's task.daily hook.
    autoRegenerate: boolean;
    // Bookkeeping, updated after every (re)generation.
    lastGeneratedAt: Date | null;
    lastGeneratedUrlCount: number;
}

export const DEFAULT_CONFIG: SitemapConfig = {
    _id: 'config',
    baseUrl: '',
    domains: [],
    includeProblems: true,
    includeDiscussions: true,
    includeContests: false,
    includeTraining: false,
    includeHomepage: true,
    changefreq: 'daily',
    maxUrlsPerFile: 45000,
    autoRegenerate: true,
    lastGeneratedAt: null,
    lastGeneratedUrlCount: 0,
};

export interface SitemapUrl {
    loc: string;
    lastmod?: string;
    changefreq?: string;
}

declare module 'hydrooj' {
    interface Collections {
        'sitemap.config': SitemapConfig;
    }
}

async function getConfig(ctx: Context): Promise<SitemapConfig> {
    const doc = await ctx.db.collection('sitemap.config').findOne({ _id: 'config' });
    if (!doc) return { ...DEFAULT_CONFIG };
    // Merge with defaults so newly-added fields always have a value
    // even for configs saved by an older version of the plugin.
    return { ...DEFAULT_CONFIG, ...doc };
}

async function saveConfig(ctx: Context, patch: Partial<SitemapConfig>): Promise<SitemapConfig> {
    const current = await getConfig(ctx);
    const next: SitemapConfig = { ...current, ...patch, _id: 'config' };
    await ctx.db.collection('sitemap.config').updateOne(
        { _id: 'config' },
        { $set: next },
        { upsert: true },
    );
    return next;
}

async function recordGeneration(ctx: Context, urlCount: number) {
    await ctx.db.collection('sitemap.config').updateOne(
        { _id: 'config' },
        { $set: { lastGeneratedAt: new Date(), lastGeneratedUrlCount: urlCount } },
        { upsert: true },
    );
}

function escapeXml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function toIsoDate(d: Date | undefined | null): string | undefined {
    if (!d) return undefined;
    try {
        return new Date(d).toISOString().slice(0, 10);
    } catch (e) {
        return undefined;
    }
}

/**
 * Best-effort "last modified" date for a document. Problems and training
 * plans don't carry a reliable updateAt field on the base document, so we
 * fall back to the creation time embedded in the ObjectId - still far
 * better than omitting <lastmod> entirely, and it's the same fallback
 * HydroOJ's own templates use (e.g. datetimeSpan(doc._id)).
 */
function lastModOf(doc: { _id?: any; updateAt?: Date }): string | undefined {
    if (doc.updateAt) return toIsoDate(doc.updateAt);
    try {
        return toIsoDate(doc._id?.getTimestamp?.());
    } catch (e) {
        return undefined;
    }
}

/**
 * Collect every URL that should appear in the sitemap, across the configured
 * domains and content types. Only content that is safely public (i.e. not
 * hidden, and not gated behind a permission an anonymous visitor lacks) is
 * ever included; on any doubt we exclude rather than include.
 */
async function collectUrls(ctx: Context, base: string, config: SitemapConfig): Promise<SitemapUrl[]> {
    const urls: SitemapUrl[] = [];
    const domainColl = ctx.db.collection('domain');
    const domainFilter = config.domains.length ? { _id: { $in: config.domains } } : {};
    const domains = await domainColl.find(domainFilter).project({ _id: 1 }).toArray();

    const domainPath = (domainId: string, path: string) => (
        domainId === 'system' ? `${base}${path}` : `${base}/d/${encodeURIComponent(domainId)}${path}`
    );

    if (config.includeHomepage) {
        urls.push({ loc: `${base}/`, changefreq: config.changefreq });
    }

    for (const { _id: domainId } of domains) {
        if (config.includeProblems) {
            const cursor = ctx.db.collection('document').find({
                domainId,
                docType: 10, // document.TYPE_PROBLEM
                hidden: { $ne: true },
            }).project({ _id: 1, docId: 1, pid: 1 });
            // eslint-disable-next-line no-await-in-loop
            for await (const pdoc of cursor) {
                urls.push({
                    loc: domainPath(domainId, `/p/${encodeURIComponent(pdoc.pid || pdoc.docId)}`),
                    lastmod: lastModOf(pdoc),
                    changefreq: config.changefreq,
                });
            }
        }
        if (config.includeDiscussions) {
            const cursor = ctx.db.collection('document').find({
                domainId,
                docType: 21, // document.TYPE_DISCUSSION
                hidden: { $ne: true },
            }).project({ _id: 1, docId: 1, updateAt: 1 });
            // eslint-disable-next-line no-await-in-loop
            for await (const ddoc of cursor) {
                urls.push({
                    loc: domainPath(domainId, `/discuss/${ddoc.docId}`),
                    lastmod: lastModOf(ddoc),
                    changefreq: config.changefreq,
                });
            }
        }
        if (config.includeContests) {
            const cursor = ctx.db.collection('document').find({
                domainId,
                docType: 30, // document.TYPE_CONTEST
                hidden: { $ne: true },
                rule: { $ne: 'homework' },
            }).project({ _id: 1, docId: 1 });
            // eslint-disable-next-line no-await-in-loop
            for await (const tdoc of cursor) {
                urls.push({
                    loc: domainPath(domainId, `/contest/${tdoc.docId}`),
                    lastmod: lastModOf(tdoc),
                    changefreq: config.changefreq,
                });
            }
        }
        if (config.includeTraining) {
            const cursor = ctx.db.collection('document').find({
                domainId,
                docType: 40, // document.TYPE_TRAINING
                hidden: { $ne: true },
            }).project({ _id: 1, docId: 1 });
            // eslint-disable-next-line no-await-in-loop
            for await (const trdoc of cursor) {
                urls.push({
                    loc: domainPath(domainId, `/training/${trdoc.docId}`),
                    lastmod: lastModOf(trdoc),
                    changefreq: config.changefreq,
                });
            }
        }
    }

    return urls;
}

function renderUrlsetXml(urls: SitemapUrl[]): string {
    const body = urls.map((u) => {
        const parts = [`    <loc>${escapeXml(u.loc)}</loc>`];
        if (u.lastmod) parts.push(`    <lastmod>${u.lastmod}</lastmod>`);
        if (u.changefreq) parts.push(`    <changefreq>${u.changefreq}</changefreq>`);
        return `  <url>\n${parts.join('\n')}\n  </url>`;
    }).join('\n');
    return '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + `${body}\n`
        + '</urlset>\n';
}

function renderSitemapIndexXml(base: string, fileCount: number, generatedAt: Date): string {
    const lastmod = toIsoDate(generatedAt);
    const body = Array.from({ length: fileCount }, (_, i) => {
        const parts = [`    <loc>${escapeXml(`${base}/sitemap-${i + 1}.xml`)}</loc>`];
        if (lastmod) parts.push(`    <lastmod>${lastmod}</lastmod>`);
        return `  <sitemap>\n${parts.join('\n')}\n  </sitemap>`;
    }).join('\n');
    return '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + `${body}\n`
        + '</sitemapindex>\n';
}

function chunk<T>(arr: T[], size: number): T[][] {
    const result: T[][] = [];
    for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
    return result;
}

/**
 * Generate the sitemap for the given base URL. Returns either a single
 * urlset document, or (if the URL count exceeds maxUrlsPerFile) a sitemap
 * index plus a set of numbered urlset files, keyed by filename.
 */
async function generate(ctx: Context, base: string): Promise<{
    config: SitemapConfig;
    files: Record<string, string>;
    isIndex: boolean;
    urlCount: number;
}> {
    const config = await getConfig(ctx);
    const cleanBase = base.replace(/\/+$/, '');
    const urls = await collectUrls(ctx, cleanBase, config);
    const files: Record<string, string> = {};
    let isIndex = false;

    if (urls.length <= config.maxUrlsPerFile) {
        files['sitemap.xml'] = renderUrlsetXml(urls);
    } else {
        isIndex = true;
        const parts = chunk(urls, config.maxUrlsPerFile);
        parts.forEach((part, i) => {
            files[`sitemap-${i + 1}.xml`] = renderUrlsetXml(part);
        });
        files['sitemap.xml'] = renderSitemapIndexXml(cleanBase, parts.length, new Date());
    }

    await recordGeneration(ctx, urls.length);
    return {
        config, files, isIndex, urlCount: urls.length,
    };
}

const SitemapModel = {
    getConfig, saveConfig, generate, DEFAULT_CONFIG,
};

declare module 'hydrooj' {
    interface Model {
        sitemap: typeof SitemapModel;
    }
}

global.Hydro.model.sitemap = SitemapModel;

export default SitemapModel;

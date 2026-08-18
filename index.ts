import {
    Context, Handler, NotFoundError, param, PRIV, Types,
} from 'hydrooj';
import { SitemapConfig } from './model';

const SitemapModel = global.Hydro.model.sitemap;

function resolveBase(handler: Handler, configured: string): string {
    if (configured) return configured.replace(/\/+$/, '');
    const req = handler.request;
    const forwardedProto = req.headers['x-forwarded-proto'];
    const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)
        || (/^(localhost|127\.|0\.0\.0\.0|::1)/.test(req.host) ? 'http' : 'https');
    const host = req.host || req.hostname;
    return `${proto}://${host}`;
}

// In-memory cache of generated files, keyed by base URL, so that repeated
// crawler hits don't force a full regeneration on every request.
// Cleared whenever the config is saved or a manual regenerate is triggered.
let cache: Record<string, { files: Record<string, string>; generatedAt: number }> = {};
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function clearCache() {
    cache = {};
}

async function getFiles(ctx: Context, base: string) {
    const hit = cache[base];
    if (hit && Date.now() - hit.generatedAt < CACHE_TTL_MS) return hit.files;
    const { files } = await SitemapModel.generate(ctx, base);
    cache[base] = { files, generatedAt: Date.now() };
    return files;
}

class SitemapXmlHandler extends Handler {
    noCheckPermView = true;

    async get() {
        const config = await SitemapModel.getConfig(this.ctx);
        const base = resolveBase(this, config.baseUrl);
        const files = await getFiles(this.ctx, base);
        this.response.body = files['sitemap.xml'];
        this.response.template = null;
        this.response.type = 'application/xml';
    }
}

class SitemapPartHandler extends Handler {
    noCheckPermView = true;

    @param('n', Types.PositiveInt)
    async get(_: string, n: number) {
        const config = await SitemapModel.getConfig(this.ctx);
        const base = resolveBase(this, config.baseUrl);
        const files = await getFiles(this.ctx, base);
        const key = `sitemap-${n}.xml`;
        if (!files[key]) throw new NotFoundError(key);
        this.response.body = files[key];
        this.response.template = null;
        this.response.type = 'application/xml';
    }
}

class RobotsTxtHandler extends Handler {
    noCheckPermView = true;

    async get() {
        const config = await SitemapModel.getConfig(this.ctx);
        const base = resolveBase(this, config.baseUrl);
        this.response.body = `User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`;
        this.response.template = null;
        this.response.type = 'text/plain';
    }
}

class SitemapManageHandler extends Handler {
    async get() {
        const config = await SitemapModel.getConfig(this.ctx);
        this.response.template = 'sitemap_manage.html';
        this.response.body = { config };
    }

    @param('baseUrl', Types.String, true)
    @param('domains', Types.Content, true)
    @param('includeProblems', Types.Boolean)
    @param('includeDiscussions', Types.Boolean)
    @param('includeContests', Types.Boolean)
    @param('includeTraining', Types.Boolean)
    @param('includeHomepage', Types.Boolean)
    @param('changefreq', Types.String, true)
    @param('maxUrlsPerFile', Types.PositiveInt, true)
    @param('autoRegenerate', Types.Boolean)
    async postSave(
        _: string,
        baseUrl = '',
        domainsRaw = '',
        includeProblems = false,
        includeDiscussions = false,
        includeContests = false,
        includeTraining = false,
        includeHomepage = false,
        changefreq = 'daily',
        maxUrlsPerFile = 45000,
        autoRegenerate = false,
    ) {
        const domains = domainsRaw.split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean);
        const patch: Partial<SitemapConfig> = {
            baseUrl: baseUrl.trim(),
            domains,
            includeProblems,
            includeDiscussions,
            includeContests,
            includeTraining,
            includeHomepage,
            changefreq: changefreq as SitemapConfig['changefreq'],
            maxUrlsPerFile: Math.min(Math.max(maxUrlsPerFile, 1), 50000),
            autoRegenerate,
        };
        await SitemapModel.saveConfig(this.ctx, patch);
        clearCache();
        this.response.redirect = this.url('sitemap_manage');
    }

    async postRegenerate() {
        const config = await SitemapModel.getConfig(this.ctx);
        const base = resolveBase(this, config.baseUrl);
        clearCache();
        await getFiles(this.ctx, base);
        this.response.redirect = this.url('sitemap_manage');
    }
}

export async function apply(ctx: Context) {
    ctx.Route('sitemap_xml', '/sitemap.xml', SitemapXmlHandler);
    ctx.Route('sitemap_part', '/sitemap-:n.xml', SitemapPartHandler);
    ctx.Route('robots_txt', '/robots.txt', RobotsTxtHandler);
    ctx.Route('sitemap_manage', '/manage/sitemap', SitemapManageHandler, PRIV.PRIV_MANAGE_ALL_DOMAIN);
    ctx.injectUI('ControlPanel', 'sitemap_manage');

    // Auto-regenerate once a day, piggybacking on HydroOJ's daily maintenance task.
    ctx.on('task/daily', async () => {
        const config = await SitemapModel.getConfig(ctx);
        if (!config.autoRegenerate) return;
        clearCache();
        const base = config.baseUrl || '';
        if (!base) return; // nothing sensible to generate without a configured base URL
        await SitemapModel.generate(ctx, base);
    });

    ctx.i18n.load('zh', {
        sitemap_manage: 'Sitemap 管理',
        'Sitemap Settings': 'Sitemap 设置',
        'Base URL': '站点基础 URL',
        'e.g. https://oj.example.com (leave empty to auto-detect from request)': '例如 https://oj.example.com（留空则根据请求自动识别）',
        'Domains to include': '包含的域',
        'Comma or space separated domain IDs, leave empty for all domains': '以逗号或空格分隔的域 ID，留空表示包含所有域',
        'Content types': '包含内容',
        Problems: '题目',
        Discussions: '讨论',
        Contests: '比赛',
        Training: '训练计划',
        Homepage: '首页',
        'Change frequency': '更新频率',
        'Max URLs per file': '单文件最大 URL 数',
        'Auto regenerate daily': '每日自动重新生成',
        Save: '保存',
        'Regenerate now': '立即重新生成',
        'Last generated at': '上次生成时间',
        'URLs in last generation': '上次生成的 URL 数',
        Never: '从未生成',
        'View sitemap.xml': '查看 sitemap.xml',
        'always': '总是',
        'hourly': '每小时',
        'daily': '每天',
        'weekly': '每周',
        'monthly': '每月',
        'yearly': '每年',
        'never': '从不',
    });
    ctx.i18n.load('en', {
        sitemap_manage: 'Sitemap Manage',
        'Sitemap Settings': 'Sitemap Settings',
        'Base URL': 'Base URL',
        'e.g. https://oj.example.com (leave empty to auto-detect from request)': 'e.g. https://oj.example.com (leave empty to auto-detect from request)',
        'Domains to include': 'Domains to include',
        'Comma or space separated domain IDs, leave empty for all domains': 'Comma or space separated domain IDs, leave empty for all domains',
        'Content types': 'Content types',
        Problems: 'Problems',
        Discussions: 'Discussions',
        Contests: 'Contests',
        Training: 'Training',
        Homepage: 'Homepage',
        'Change frequency': 'Change frequency',
        'Max URLs per file': 'Max URLs per file',
        'Auto regenerate daily': 'Auto regenerate daily',
        Save: 'Save',
        'Regenerate now': 'Regenerate now',
        'Last generated at': 'Last generated at',
        'URLs in last generation': 'URLs in last generation',
        Never: 'Never generated',
        'View sitemap.xml': 'View sitemap.xml',
    });
}

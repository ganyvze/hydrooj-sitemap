/**
 * 轻量级、零依赖的 Sitemap XML 构建器。
 *
 * 不引入第三方 `sitemap` 库的原因见 README：
 * 1) 减少插件依赖树，避免与其他 Hydro addon 产生版本冲突；
 * 2) sitemap 协议本身格式简单固定，手写更利于控制转义与流式拼接；
 * 3) 便于自行控制单文件 URL 数量上限，做分片（sitemap index）。
 */

export type ChangeFreq =
    | 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';

export interface SitemapUrlEntry {
    /** 完整 URL，必须是绝对地址 */
    loc: string;
    /** 最后修改时间，ISO 8601 字符串 */
    lastmod?: string;
    changefreq?: ChangeFreq;
    /** 0.0 ~ 1.0 */
    priority?: number;
}

export interface SitemapIndexEntry {
    loc: string;
    lastmod?: string;
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

/**
 * 对 XML 文本内容进行转义，防止特殊字符（& < > " '）破坏 XML 结构。
 * 由于 URL / 标题等内容可能来自用户输入（如题目标题作为 loc 的一部分较少见，
 * 但为了稳妥仍统一转义，防御潜在的 XML 注入问题）。
 */
export function escapeXml(input: string): string {
    return input
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/** 将 priority 规整为 sitemap 协议要求的 0.0~1.0，保留一位小数 */
function normalizePriority(p?: number): string | undefined {
    if (p === undefined || Number.isNaN(p)) return undefined;
    const clamped = Math.min(1, Math.max(0, p));
    return clamped.toFixed(1);
}

/**
 * 构建标准 <urlset> sitemap XML。
 * 单文件建议不超过 50,000 条 URL（协议硬性限制），调用方需自行分片。
 */
export function buildUrlsetXml(entries: SitemapUrlEntry[]): string {
    const body = entries.map((e) => {
        const parts: string[] = [`    <loc>${escapeXml(e.loc)}</loc>`];
        if (e.lastmod) parts.push(`    <lastmod>${escapeXml(e.lastmod)}</lastmod>`);
        if (e.changefreq) parts.push(`    <changefreq>${e.changefreq}</changefreq>`);
        const pr = normalizePriority(e.priority);
        if (pr) parts.push(`    <priority>${pr}</priority>`);
        return `  <url>\n${parts.join('\n')}\n  </url>`;
    }).join('\n');

    return `${XML_HEADER}\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

/**
 * 构建 <sitemapindex>，用于聚合多个分片子 sitemap。
 */
export function buildSitemapIndexXml(entries: SitemapIndexEntry[]): string {
    const body = entries.map((e) => {
        const parts: string[] = [`    <loc>${escapeXml(e.loc)}</loc>`];
        if (e.lastmod) parts.push(`    <lastmod>${escapeXml(e.lastmod)}</lastmod>`);
        return `  <sitemap>\n${parts.join('\n')}\n  </sitemap>`;
    }).join('\n');

    return `${XML_HEADER}\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>\n`;
}

/** 按最大数量将数组切分为多个分片，用于生成 sitemap index 的子文件 */
export function chunk<T>(arr: T[], size: number): T[][] {
    if (size <= 0) return [arr];
    const result: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
        result.push(arr.slice(i, i + size));
    }
    return result;
}

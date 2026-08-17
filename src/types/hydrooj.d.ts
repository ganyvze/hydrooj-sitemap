/**
 * 本文件为 `hydrooj` 提供一份轻量、手工维护的类型声明，替代直接从
 * `node_modules/hydrooj/src/plugin-api.ts`（原始 .ts 源码，未编译、未做类型检查）
 * 解析类型。
 *
 * 背景：hydrooj 这个 npm 包的 `main` 字段直接指向未编译的 `src/plugin-api.ts`，
 * 且该包自身的源码在其发布版本中并不能通过标准的严格 `tsc` 类型检查
 * （大量依赖如 lodash/fs-extra/ws 缺少类型声明，以及包内部本身存在类型不一致）。
 * HydroOJ 的实际运行方式是用 transpile-only 模式跑源码（不做类型检查），
 * 因此这些问题在生产环境中不会造成任何影响；但如果第三方插件用标准 `tsc`
 * 编译，并且直接 `import ... from 'hydrooj'`，TS 会被迫递归解析这条依赖链上
 * 所有文件的类型，进而把 hydrooj 自身的类型错误也报到插件的编译结果里。
 *
 * 为避免这种"背锅"，本插件不直接依赖 hydrooj 的原始类型定义，而是在此手工
 * 声明一份仅覆盖插件实际用到的 API 的类型（字段/方法签名已对照 hydrooj@5.0.4
 * 源码核实），tsconfig.json 通过 `paths` 将 `hydrooj` 重定向到本文件。
 *
 * 风险提示：若未来 HydroOJ 主版本升级导致相关 API 签名变化，需要同步更新本文件。
 */

declare module 'hydrooj' {
    // ------------------------------------------------------------------
    // Logger（来自 @cordisjs/plugin-logger 对 cordis.Context 的模块增强）
    // ------------------------------------------------------------------
    export interface Logger {
        error: (format: any, ...param: any[]) => void;
        warn: (format: any, ...param: any[]) => void;
        info: (format: any, ...param: any[]) => void;
        debug: (format: any, ...param: any[]) => void;
    }

    // ------------------------------------------------------------------
    // Handler（来自 hydrooj/src/service/server.ts）
    // ------------------------------------------------------------------
    export class Handler {
        ctx: Context;
        response: {
            type: string;
            body: any;
            status: number;
            addHeader: (name: string, value: string) => void;
        };
        request: any;
        noCheckPermView?: boolean;
        [key: string]: any;
    }

    // ------------------------------------------------------------------
    // EventMap（来自 hydrooj/src/service/bus.ts，精简为本插件用到的子集，
    // 其余事件通过索引签名兜底，避免因遗漏事件名导致编译失败）
    // ------------------------------------------------------------------
    export interface EventMap {
        ready: () => void;
        dispose: () => void;
        'problem/add': (doc: any, docId: number) => void;
        'problem/edit': (doc: any) => void;
        'problem/delete': (domainId: string, docId: number) => void;
        'contest/add': (payload: any, id: any) => void;
        'contest/edit': (payload: any) => void;
        'contest/del': (domainId: string, tid: any) => void;
        'domain/create': (ddoc: any) => void;
        'domain/update': (domainId: string, $set: any, ddoc: any) => void;
        'domain/delete': (domainId: string) => void;
        'task/daily': () => void;
        [key: string]: (...args: any[]) => any;
    }

    // ------------------------------------------------------------------
    // Context（cordis.Context 经由 hydrooj / @hydrooj/framework /
    // @cordisjs/plugin-timer / @cordisjs/plugin-logger 等模块增强后的合集，
    // 此处仅声明本插件用到的成员）
    // ------------------------------------------------------------------
    export interface Context {
        logger: Logger;
        on<K extends keyof EventMap>(name: K, listener: EventMap[K]): () => boolean;
        emit<K extends keyof EventMap>(name: K, ...args: Parameters<EventMap[K]>): void;
        parallel<K extends keyof EventMap>(name: K, ...args: Parameters<EventMap[K]>): Promise<void>;
        // @hydrooj/framework/server.ts: public Route(name, path, RouteHandler, ...permPrivChecker)
        Route: (name: string, path: string, RouteHandler: typeof Handler, ...permPrivChecker: any[]) => any;
        // @cordisjs/plugin-timer
        setInterval(callback: () => void, delay: number): () => void;
        setTimeout(callback: () => void, delay: number): () => void;
        // 允许插件通过 module augmentation 追加自定义字段（如 sitemapCache）
        [key: string]: any;
    }

    // ------------------------------------------------------------------
    // Schema：真实来源是 schemastery 包，这里不重复声明，直接从该包类型透传，
    // 供仍以 `import { Schema } from 'hydrooj'` 方式引用的历史代码兼容使用。
    // 本插件自身统一改为 `import Schema from 'schemastery'`，不依赖这一行。
    // ------------------------------------------------------------------
    export { default as Schema } from 'schemastery';

    // ------------------------------------------------------------------
    // PERM（来自 @hydrooj/common/permission.ts，均为 bigint 位掩码）
    // ------------------------------------------------------------------
    export const PERM: {
        PERM_VIEW: bigint;
        PERM_VIEW_PROBLEM: bigint;
        PERM_VIEW_CONTEST: bigint;
        PERM_VIEW_TRAINING: bigint;
        PERM_BASIC: bigint;
        PERM_DEFAULT: bigint;
        PERM_ALL: bigint;
        [key: string]: bigint;
    };

    // ------------------------------------------------------------------
    // User（来自 hydrooj/src/model/user.ts）
    // ------------------------------------------------------------------
    export class User {
        _id: number;
        hasPerm(...perms: bigint[]): boolean;
        hasPriv(...privs: number[]): boolean;
        own(doc: any, arg1?: any): boolean;
        [key: string]: any;
    }

    // ------------------------------------------------------------------
    // Mongo 风格游标（document.getMulti 返回值的最小可用子集）
    // ------------------------------------------------------------------
    export interface DocCursor<T> extends AsyncIterable<T> {
        project(spec: Record<string, 0 | 1>): DocCursor<T>;
    }

    // ------------------------------------------------------------------
    // DomainModel（来自 hydrooj/src/model/domain.ts）
    // ------------------------------------------------------------------
    export const DomainModel: {
        getMulti: (query: any) => DocCursor<{ _id: string; [key: string]: any }>;
        getRoles: (domainId: string) => Promise<Array<{ _id?: string; name?: string; perm?: any }>>;
        [key: string]: any;
    };

    // ------------------------------------------------------------------
    // ProblemModel（来自 hydrooj/src/model/problem.ts）
    // ------------------------------------------------------------------
    export const ProblemModel: {
        getMulti: (domainId: string, query: any, projection?: any) => DocCursor<{
            docId: number; pid?: string; title?: string; hidden?: boolean; updateAt?: Date; [key: string]: any;
        }>;
        canViewBy: (pdoc: any, udoc: User) => boolean;
        [key: string]: any;
    };

    // ------------------------------------------------------------------
    // ContestModel（来自 hydrooj/src/model/contest.ts）
    // ------------------------------------------------------------------
    export const ContestModel: {
        getMulti: (domainId: string, query: any) => DocCursor<{
            docId: any; assign?: string[]; updateAt?: Date; beginAt?: Date; [key: string]: any;
        }>;
        [key: string]: any;
    };

    // ------------------------------------------------------------------
    // TrainingModel（来自 hydrooj/src/model/training.ts，独立集合，不与
    // ContestModel 共享 docType）
    // ------------------------------------------------------------------
    export const TrainingModel: {
        getMulti: (domainId: string, query: any) => DocCursor<{
            docId: any; updateAt?: Date; [key: string]: any;
        }>;
        [key: string]: any;
    };

    // ------------------------------------------------------------------
    // SystemModel（来自 hydrooj/src/model/system.ts，get 为同步内存读取）
    // ------------------------------------------------------------------
    export const SystemModel: {
        get: (key: string) => any;
        [key: string]: any;
    };

    // ------------------------------------------------------------------
    // UserModel（来自 hydrooj/src/model/user.ts）
    // ------------------------------------------------------------------
    export const UserModel: {
        getById: (domainId: string, uid: number) => Promise<User>;
        [key: string]: any;
    };
}

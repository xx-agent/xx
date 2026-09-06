// src/ref/store.ts — diy.yaml / ref.lock.yaml 读写 + URL 解析
//
// 纯数据层：只做文件读写与字符串解析，不调 git、不含业务编排（编排在 impl.ts）。
// diy.yaml:    js-yaml dump（源 source 列表，版本含在字符串里）
// ref.lock.yaml: js-yaml 结构化 {version, generated, source:{key:{url,version,dir,lastSync}}}
//
// 路径语义：LockEntry.dir 存「相对 $DIY_HOME」的镜像路径（如 ref/github.com/org/repo/main），
// 跨 worktree 复用时需拼当前 home（join(runtime.home, dir)）。对齐旧 Python ref 的 ~/... 惯例。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";

// ═══════════════════════════════════════
// URL 解析
// ═══════════════════════════════════════

export interface RepoInfo {
    host: string;
    owner: string;
    repo: string;
}

/** 解析 git 仓库 URL 为 host/owner/repo；不支持的形式返回 null。 */
export function parseRepoUrl(url: string): RepoInfo | null {
    let s = url.trim();
    // 先剥尾部斜杠，再剥 .git（两者都可带结尾）
    s = s.replace(/\/+$/, "").replace(/\.git$/, "");
    let m = s.match(/^(?:https?:\/\/|git@|ssh:\/\/git@)([^/:\s]+)[:/]([^/:\s]+)\/([^/:\s]+)$/);
    if (!m) {
        // 宽松兜底：host/owner/repo 三段（不带协议）
        m = s.match(/^([^/:\s]+)\/([^/:\s]+)\/([^/:\s]+)$/);
    }
    if (!m) return null;
    return { host: m[1]!, owner: m[2]!, repo: m[3]! };
}

/** tag 判定：@ 后段形如 v1.0.0 / 纯数字 → tag（不可变，sync 不 pull）。 */
export function isTagVersion(version: string): boolean {
    return /^v?\d+(\.\d+)*$/.test(version);
}

/** 版本段兜底：null / 空 → "main"（默认分支）。 */
export function normalizeVersion(version: string | null): string {
    return version && version.trim() ? version.trim() : "main";
}

/** host/owner/repo 去重键（也用作 lock.source 的 map key）。 */
export function sourceKey(info: RepoInfo): string {
    return `${info.host}/${info.owner}/${info.repo}`;
}

/** 镜像目录相对 $DIY_HOME 的路径：ref/<host>/<owner>/<repo>/<version>。 */
export function mirrorRelDir(info: RepoInfo, version: string): string {
    return join("ref", info.host, info.owner, info.repo, version);
}

/** 把 source 串拆成 URL 解析结果；spec 保留原样由调用方处理。 */
export function parseSpec(spec: string): {
    info: RepoInfo;
    /** 纯 URL（@ 版本剥离后） */
    url: string;
    /** @ 后版本段；null = 按 main */
    version: string | null;
    key: string;
} {
    const s = spec.trim();
    let url = s;
    let version: string | null = null;
    if (s.includes("@")) {
        const sep = s.lastIndexOf("@");
        url = s.slice(0, sep);
        const v = s.slice(sep + 1);
        version = v.trim() ? v : null;
    }
    const info = parseRepoUrl(url);
    if (!info) throw new Error(`无法解析 URL: ${url}`);
    return {
        info,
        url,
        version,
        key: sourceKey(info),
    };
}

// ═══════════════════════════════════════
// diy.yaml（source 注册表 —— 只存 source 字符串列表）
// ═══════════════════════════════════════

export const DIY_YAML_TEMPLATE = `# diy-dev — 源码镜像配置
#
# dev ref add <url>  注册人工指定 source（总是下载，镜像到 $DIY_HOME/ref/）
# dev ref remove     移除注册（本地镜像保留）
# dev ref sync       批量 clone 已注册 source
#
# source 格式: https://github.com/org/repo[@branch|@tag]
#   无版本 / 分支 → clone 后 sync 时 git pull 保持最新
#   tag（v1.0.0、纯数字）→ 检出后固定，不 pull
#
# 示例：
#   https://github.com/Textualize/rich
#   https://github.com/octocat/Hello-World@v1.0.0

ref:
  source: []
`;

/** cwd 有无 diy.yaml；无则创建模板。返回 diy.yaml 路径。 */
export function ensureDiyYaml(dir: string): string {
    const p = join(dir, "diy.yaml");
    if (!existsSync(p)) {
        writeFileSync(p, DIY_YAML_TEMPLATE, "utf-8");
    }
    return p;
}

interface DiyYamlShape {
    ref?: { source?: unknown[] };
}

/** 读 diy.yaml 的 source 字符串列表（js-yaml 解析失败返回 []）。 */
export function listSpecs(dir: string): string[] {
    const p = join(dir, "diy.yaml");
    if (!existsSync(p)) return [];
    try {
        const raw = yaml.load(readFileSync(p, "utf-8")) as DiyYamlShape | null;
        const arr = raw?.ref?.source;
        if (!Array.isArray(arr)) return [];
        return arr.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
    } catch {
        return [];
    }
}

/** 追加一个 source spec（原样保留用户输入）；同 host/owner/repo 的旧条目被替换。返回写入 spec。 */
export function addSource(dir: string, spec: string): string {
    ensureDiyYaml(dir);
    const specs = listSpecs(dir);
    const { info } = parseSpec(spec);
    const key = sourceKey(info);
    const trimmed = spec.trim();

    const next = specs.filter((s) => {
        try {
            return sourceKey(parseRepoUrl(stripVersion(s))!) !== key;
        } catch {
            return true; // 解析不了的行保留，不误删
        }
    });
    next.push(trimmed);

    _writeDiyYaml(dir, next);
    return trimmed;
}

/** 按 owner/repo、完整 URL、或 diy.yaml 原字符串移除；找到返回其 spec，未找到返回 null。 */
export function removeSource(dir: string, name: string): string | null {
    ensureDiyYaml(dir);
    const specs = listSpecs(dir);
    const needle = name.trim();
    const hitIdx = specs.findIndex((s) => {
        const stripped = stripVersion(s);
        try {
            const { host, owner, repo } = parseRepoUrl(stripped)!;
            return (
                s === needle ||
                stripped === needle ||
                `${owner}/${repo}` === needle ||
                `${host}/${owner}/${repo}` === needle
            );
        } catch {
            return s === needle;
        }
    });
    if (hitIdx === -1) return null;
    const removed = specs[hitIdx]!;
    specs.splice(hitIdx, 1);
    _writeDiyYaml(dir, specs);
    return removed;
}

/** 剥离 @版本，返回纯 URL；无 @ 原样返回。 */
export function stripVersion(spec: string): string {
    const i = spec.lastIndexOf("@");
    return i === -1 ? spec : spec.slice(0, i);
}

function _writeDiyYaml(dir: string, specs: string[]): void {
    const p = join(dir, "diy.yaml");
    // 用 js-yaml dump 输出稳定结构；保留 comment 由模板文件自然携带（整体重写会丢注释，v1 接受）
    const body = yaml.dump({ ref: { source: specs } }, { indent: 2, noRefs: true, lineWidth: -1 });
    writeFileSync(p, `# diy-dev — 源码镜像配置（source 列表由 dev ref 管理）\n${body}`, "utf-8");
}

// ═══════════════════════════════════════
// ref.lock.yaml
// ═══════════════════════════════════════

export interface LockEntry {
    key: string;
    /** 纯 URL */
    url: string;
    /** @ 后版本段；null = 按 main */
    version: string | null;
    /** 相对 $DIY_HOME 的镜像目录 */
    dir: string;
    /** 最近一次 sync 完成时间（ISO）；tag 固定时 = 创建/检出时间 */
    lastSync: string;
}

export interface RefLock {
    version: number;
    generated: string;
    /** map: key(host/owner/repo) → 条目 */
    source: Record<string, LockEntry>;
}

/** 读 cwd/.diy/ref.lock.yaml；不存在或格式损坏返回 null。 */
export function loadRefLock(dir: string): RefLock | null {
    const p = join(dir, ".diy", "ref.lock.yaml");
    if (!existsSync(p)) return null;
    try {
        const raw = yaml.load(readFileSync(p, "utf-8")) as any;
        const source = raw?.source ?? {};
        const entries: Record<string, LockEntry> = {};
        for (const [k, v] of Object.entries(source ?? {})) {
            const e = v as any;
            if (!e || typeof e !== "object") continue;
            entries[k] = {
                key: e.key ?? k,
                url: String(e.url ?? ""),
                version: e.version == null ? null : String(e.version),
                dir: String(e.dir ?? ""),
                lastSync: String(e.lastSync ?? ""),
            };
        }
        return {
            version: Number(raw?.version ?? 1),
            generated: String(raw?.generated ?? ""),
            source: entries,
        };
    } catch {
        return null;
    }
}

/** 写 cwd/.diy/ref.lock.yaml（目录自动创建）。 */
export function saveRefLock(dir: string, lock: RefLock): void {
    const lockDir = join(dir, ".diy");
    mkdirSync(lockDir, { recursive: true });
    const doc = {
        version: lock.version,
        generated: lock.generated,
        source: lock.source,
    };
    const body = yaml.dump(doc, { indent: 2, noRefs: true, lineWidth: -1 });
    writeFileSync(join(lockDir, "ref.lock.yaml"), body, "utf-8");
}

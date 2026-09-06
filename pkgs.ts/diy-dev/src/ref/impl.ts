// src/ref/impl.ts — ref 域 handler 绑定（业务编排）
//
// schema 定义在 api.ts，文件/URL 数据层在 store.ts，git 子进程在 git.ts；
// 本文件把三者缝成命令语义：add 注册写 diy.yaml、sync 批量 clone/pull + 写 lock、
// list 读 lock 对齐本地目录、remove 移除注册。
// handler 全部返回结构化数据，由 CLI 宿主负责展示（本文件不做 console）。

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ServerBinding } from "@diy/rpc";
import { refApi, type RefEntry } from "./api";
import * as store from "./store";
import * as git from "./git";

/** ref 域运行时上下文：镜像根 home + 作用域 cwd */
export interface RefRuntime {
    /** 数据根（$DIY_HOME），镜像目录 $HOME/ref 落此 */
    home: string;
    /** 作用域目录（diy.yaml 所在目录；CLI 传 process.cwd()） */
    cwd: string;
}

type SyncError = { spec: string; message: string };

/** 把 ref 全部 handler 绑定到给定 ServerBinding（本地 mem transport 场景）。 */
export function bindRefHandlers(binding: ServerBinding, rt: RefRuntime): void {
    const ref = refApi.ref;

    binding.on(ref.add, async ({ input }) => {
        git.requireGit();
        // 解析 URL（含 @版本），失败抛清晰错误
        const p = store.parseSpec(input.url);
        // 预检 URL 可达（git ls-remote），不可达不加注册
        git.verifyRemoteUrl(p.url);
        const spec = store.addSource(rt.cwd, input.url);
        return {
            status: "ok",
            data: {
                name: `${p.info.owner}/${p.info.repo}`,
                spec,
            },
        };
    });

    binding.on(ref.remove, async ({ input }) => {
        git.requireGit();
        const removed = store.removeSource(rt.cwd, input.name);
        if (!removed) {
            const avail = store.listSpecs(rt.cwd);
            const list = avail.length
                ? `  现有 source:\n${avail.map((s) => `    ${s}`).join("\n")}`
                : "  （diy.yaml 无 source 注册）";
            throw new Error(`未找到匹配的 source: ${input.name}\n${list}`);
        }
        return {
            status: "ok",
            data: { removed },
        };
    });

    binding.on(ref.sync, async () => {
        git.requireGit();
        const specs = store.listSpecs(rt.cwd);
        const now = new Date().toISOString();
        const sourceMap: Record<string, store.LockEntry> = {};
        let cloned = 0;
        let pulled = 0;
        let tagSkipped = 0;
        const errors: SyncError[] = [];

        for (const spec of specs) {
            try {
                const p = store.parseSpec(spec);
                const isTag = p.version != null && store.isTagVersion(p.version);
                const norm = store.normalizeVersion(p.version);
                const rel = store.mirrorRelDir(p.info, norm);
                const dirAbs = join(rt.home, rel);

                if (!existsSync(`${dirAbs}/.git`)) {
                    // 首次 clone（含按 tag/分支检出）
                    git.cloneMirror({ dir: dirAbs, url: p.url, version: p.version });
                    cloned++;
                } else {
                    // 增量：tag 不动、分支 pull
                    const u = git.updateMirror(dirAbs, isTag);
                    if (u.updated) pulled++;
                    else tagSkipped++;
                }
                sourceMap[p.key] = {
                    key: p.key,
                    url: p.url,
                    version: p.version,
                    dir: rel,
                    lastSync: now,
                };
            } catch (e) {
                errors.push({
                    spec,
                    message: e instanceof Error ? e.message : String(e),
                });
            }
        }

        // 仅保留本次 spec 对应的条目（被 remove 的 source 在此剔除）
        store.saveRefLock(rt.cwd, { version: 1, generated: now, source: sourceMap });

        return {
            status: "ok",
            data: {
                synced: cloned + pulled,
                tagSkipped,
                total: specs.length,
                errors,
            },
        };
    });

    binding.on(ref.list, async () => {
        const lock = store.loadRefLock(rt.cwd);
        const entries: RefEntry[] = [];
        if (lock) {
            for (const key of Object.keys(lock.source).sort()) {
                const e = lock.source[key]!;
                const absDir = join(rt.home, e.dir);
                entries.push({
                    key,
                    url: e.url,
                    version: e.version,
                    dir: absDir,
                    exists: existsSync(absDir),
                    lastSync: lock.generated ? e.lastSync : null,
                });
            }
        }
        return entries;
    });
}

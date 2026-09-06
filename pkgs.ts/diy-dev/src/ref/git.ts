// src/ref/git.ts — git 子进程封装（clone / checkout / pull）
//
// 外部命令防御：requireGit() 在调用前检查 git 存在，缺失给安装提示而非裸报错。
// 为同步阻塞调用（CLI 本地进程，行为确定性优先于并发）。
// 镜像目录作为「只读源码快照」，完整 clone 后显式检出目标 ref，避免浅历史不可达。
//
// clone 后 ref 检出策略：
//   - 无版本 / main → 保持默认分支 HEAD（track origin/默认分支，后续可 pull）
//   - 显式 tag（semver，如 v1.0.0）→ fetch 单 tag + checkout（detached HEAD）
//   - 显式分支名（develop/feat.x 等）→ checkout -B <v> origin/<v>（本地 track，后续可 pull）

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { isTagVersion } from "./store";

export interface GitRunResult {
    ok: boolean;
    stdout: string;
    stderr: string;
}

function run(args: string[], cwd?: string): GitRunResult {
    const r = spawnSync("git", args, {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    return {
        ok: r.status === 0,
        stdout: (r.stdout ?? "").trim(),
        stderr: (r.stderr ?? "").trim(),
    };
}

/** 检查 git 命令可用；缺失 throw 带安装提示的错误。 */
export function requireGit(): void {
    if (!run(["--version"]).ok) {
        throw new Error("缺少外部命令: git\n  安装 git 后重试：brew install git");
    }
}

/**
 * 校验 URL 是可达的 git 仓库（git ls-remote --heads）。
 * 仅供 add 阶段预检；不解析 URL 归属，不可达即 throw。
 */
export function verifyRemoteUrl(url: string): void {
    const res = run(["ls-remote", "--heads", "--", url]);
    if (!res.ok) {
        const why = res.stderr || res.stdout || "git ls-remote 请求失败";
        throw new Error(`URL 无法访问或不是 git 仓库: ${url}\n  ${why}`);
    }
}

export interface MirrorOpts {
    /** 镜像目标目录（绝对路径） */
    dir: string;
    /** 仓库 URL（https / git@ssh 均可） */
    url: string;
    /**
     * 目标 ref：@ 后段。null/空 → 保持默认分支 HEAD；
     * tag（v1.0.0 / 纯数字）→ 检出 tag；其余看作分支名检出。
     */
    version: string | null;
}

/**
 * clone 到 dir 并按 version 检出 ref。
 * 目录已含 git 仓库则跳过（交由 updateMirror 增量处理）。
 */
export function cloneMirror(opts: MirrorOpts): void {
    const url = opts.url.trim();
    if (url.length === 0) throw new Error("git URL 为空");
    if (existsSync(`${opts.dir}/.git`)) return;

    mkdirSync(dirname(opts.dir), { recursive: true });

    const cl = run(["clone", url, opts.dir]);
    if (!cl.ok) {
        try {
            rmSync(opts.dir, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
        throw new Error(`clone 失败: ${cl.stderr || cl.stdout || "git clone 失败"}`);
    }

    const v = (opts.version ?? "").trim();
    if (v.length === 0 || v === "main") return; // 保持默认分支（track，可 pull）

    if (isTagVersion(v)) {
        // fetch 单 tag（含 commit）到本地 tag ref，再 detached checkout
        if (!run(["-C", opts.dir, "fetch", "origin", "tag", v]).ok) {
            throw new Error(`拉取 tag '${v}' 失败，请确认仓库存在该 tag`);
        }
        const co = run(["-C", opts.dir, "checkout", v]);
        if (!co.ok) throw new Error(`checkout '${v}' 失败: ${co.stderr || ""}`);
    } else {
        // 分支：fetch 并建本地 tracking 分支（origin/v 已在 clone 时拉取全部 heads）
        const originRef = `origin/${v}`;
        if (!existsSync(`${opts.dir}/.git/refs/remotes/${originRef}`)) {
            const f = run(["-C", opts.dir, "fetch", "origin", v]);
            if (!f.ok) throw new Error(`拉取分支 '${v}' 失败，请确认仓库存在该分支`);
        }
        const co = run(["-C", opts.dir, "checkout", "-B", v, originRef]);
        if (!co.ok) throw new Error(`checkout '${v}' 失败: ${co.stderr || ""}`);
    }
}

export interface UpdateOutcome {
    /** true=已执行 pull/更新；false=tag 固定未动 */
    updated: boolean;
    note?: string;
}

/**
 * 更新已有镜像，对齐增量策略：
 *   - tag（不可变）→ 不 pull
 *   - 分支 / 无版本（track 默认分支）→ git pull --ff-only 快进到远端最新
 */
export function updateMirror(dir: string, isTag: boolean): UpdateOutcome {
    if (isTag) {
        return { updated: false, note: "tag 固定，跳过 pull" };
    }
    const res = run(["-C", dir, "pull", "--ff-only", "origin"]);
    if (!res.ok) {
        const why = res.stderr || res.stdout || "git pull 失败";
        throw new Error(`git pull 失败（${dir}）: ${why}`);
    }
    return { updated: true };
}

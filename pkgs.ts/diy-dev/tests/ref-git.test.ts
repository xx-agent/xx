/**
 * ref-git.test.ts — git 子进程封装单测（clone / checkout / pull）
 *
 * 用测试内自建本地 git 仓库构造 src（含默认分支、tag v1.0.0、分支 develop），
 * 全部离线，不触网。cloneMirror 直接收 url 参数（不经 parseRepoUrl），可喂本地路径。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { cloneMirror, updateMirror, requireGit } from "../src/ref/git";

let root: string;
let src: string;

/** 跑 git 命令并断言成功 */
function g(args: string[], cwd?: string): string {
    const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
    if (r.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    }
    return (r.stdout ?? "").trim();
}

/** 构造 src 仓库：master 分支一个提交 + tag v1.0.0 + 分支 develop 一个提交 */
function buildSrcRepo(): void {
    g(["init", "-b", "master", src]);
    g(["config", "user.email", "t@t"], src);
    g(["config", "user.name", "t"], src);
    writeFileSync(join(src, "a.txt"), "1", "utf-8");
    g(["add", "."], src);
    g(["commit", "-m", "c1"], src);
    g(["tag", "v1.0.0"], src);
    g(["checkout", "-b", "develop"], src);
    writeFileSync(join(src, "a.txt"), "2", "utf-8");
    g(["add", "."], src);
    g(["commit", "-m", "c2"], src);
    g(["checkout", "master"], src);
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "refgit-"));
    src = join(root, "src");
    requireGit();
    buildSrcRepo();
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("cloneMirror", () => {
    it("无版本 → clone 默认分支 HEAD（master）", () => {
        const dir = join(root, "main");
        cloneMirror({ dir, url: src, version: null });
        expect(existsSync(`${dir}/.git`)).toBe(true);
        expect(g(["symbolic-ref", "--short", "HEAD"], dir)).toBe("master");
        expect(existsSync(join(dir, "a.txt"))).toBe(true);
    });

    it("tag 版本 → detached at tag", () => {
        const dir = join(root, "v1.0.0");
        cloneMirror({ dir, url: src, version: "v1.0.0" });
        const head = g(["rev-parse", "HEAD"], dir);
        const tag = g(["rev-parse", "v1.0.0"], src);
        expect(head).toBe(tag);
        // detached：无当前分支
        const { status } = spawnSync("git", ["symbolic-ref", "-q", "HEAD"], {
            cwd: dir,
            encoding: "utf-8",
        });
        expect(status).not.toBe(0);
    });

    it("分支版本 → 检出为本地 tracking 分支", () => {
        const dir = join(root, "develop");
        cloneMirror({ dir, url: src, version: "develop" });
        expect(g(["symbolic-ref", "--short", "HEAD"], dir)).toBe("develop");
        // develop 上 a.txt 应为 "2"（develop 的提交内容）
        const { readFileSync } = require("node:fs") as typeof import("node:fs");
        expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("2");
    });

    it("目录已含 git 仓库 → 跳过（幂等）", () => {
        const dir = join(root, "main");
        cloneMirror({ dir, url: src, version: null });
        // 第二次调用不应重建（保持原 HEAD）
        const headBefore = g(["rev-parse", "HEAD"], dir);
        cloneMirror({ dir, url: src, version: null });
        expect(g(["rev-parse", "HEAD"], dir)).toBe(headBefore);
    });
});

describe("updateMirror", () => {
    it("分支 → pull 返回 updated:true（无远端变化也是成功）", () => {
        const dir = join(root, "main");
        cloneMirror({ dir, url: src, version: null });
        const out = updateMirror(dir, false);
        expect(out.updated).toBe(true);
    });

    it("tag → 跳过返回 updated:false + note", () => {
        const dir = join(root, "tag");
        cloneMirror({ dir, url: src, version: "v1.0.0" });
        const out = updateMirror(dir, true);
        expect(out.updated).toBe(false);
        expect(out.note).toContain("tag");
    });

    it("分支 pull 拉到 src 的新提交", () => {
        const dir = join(root, "main");
        cloneMirror({ dir, url: src, version: null });
        // src 新增一个提交
        writeFileSync(join(src, "b.txt"), "new", "utf-8");
        g(["add", "."], src);
        g(["commit", "-m", "c3"], src);
        const before = g(["rev-parse", "HEAD"], dir);
        updateMirror(dir, false);
        const after = g(["rev-parse", "HEAD"], dir);
        expect(after).not.toBe(before);
        expect(existsSync(join(dir, "b.txt"))).toBe(true);
    });
});
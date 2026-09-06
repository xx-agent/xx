/**
 * ref-store.test.ts — store 数据层单测（URL 解析 / spec 拆解 / diy.yaml / lock）
 *
 * 纯逻辑 + tmpdir 文件操作，不触网、不调 git。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    parseRepoUrl,
    parseSpec,
    isTagVersion,
    normalizeVersion,
    mirrorRelDir,
    addSource,
    removeSource,
    listSpecs,
    loadRefLock,
    saveRefLock,
} from "../src/ref/store";

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "refstore-"));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("parseRepoUrl", () => {
    it("解析 https URL", () => {
        expect(parseRepoUrl("https://github.com/org/repo")).toEqual({
            host: "github.com",
            owner: "org",
            repo: "repo",
        });
    });

    it("剥离 .git 与尾部斜杠", () => {
        expect(parseRepoUrl("https://github.com/org/repo.git/")).toEqual({
            host: "github.com",
            owner: "org",
            repo: "repo",
        });
    });

    it("解析 git@ ssh 形式", () => {
        expect(parseRepoUrl("git@github.com:org/repo.git")?.host).toBe("github.com");
        expect(parseRepoUrl("git@github.com:org/repo.git")?.owner).toBe("org");
    });

    it("无法解析时返回 null", () => {
        expect(parseRepoUrl("not a url")).toBeNull();
    });
});

describe("parseSpec / 版本判定", () => {
    it("剥离 @ 版本", () => {
        const p = parseSpec("https://github.com/org/repo@v1.0.0");
        expect(p.url).toBe("https://github.com/org/repo");
        expect(p.version).toBe("v1.0.0");
        expect(p.key).toBe("github.com/org/repo");
    });

    it("无版本 → version null", () => {
        expect(parseSpec("https://github.com/org/repo").version).toBeNull();
    });

    it("isTagVersion: v前缀/纯数字为 tag，分支名不是", () => {
        expect(isTagVersion("v1.0.0")).toBe(true);
        expect(isTagVersion("4.9.8")).toBe(true);
        expect(isTagVersion("main")).toBe(false);
        expect(isTagVersion("develop")).toBe(false);
        expect(isTagVersion("diy-v0.1.8")).toBe(false);
    });

    it("normalizeVersion 兜底 main", () => {
        expect(normalizeVersion(null)).toBe("main");
        expect(normalizeVersion("  ")).toBe("main");
        expect(normalizeVersion("develop")).toBe("develop");
    });

    it("mirrorRelDir 相对 home 路径", () => {
        const { info } = parseSpec("https://github.com/org/repo");
        expect(mirrorRelDir(info, "main")).toBe("ref/github.com/org/repo/main");
    });
});

describe("diy.yaml source 读写", () => {
    it("add 保留原始 URL 串", () => {
        const spec = addSource(dir, "https://github.com/org/repo");
        expect(spec).toBe("https://github.com/org/repo");
        expect(listSpecs(dir)).toEqual(["https://github.com/org/repo"]);
    });

    it("同 host/owner/repo 替换（含版本变化）", () => {
        addSource(dir, "https://github.com/org/repo");
        const spec = addSource(dir, "https://github.com/org/repo@v2.0.0");
        expect(spec).toBe("https://github.com/org/repo@v2.0.0");
        expect(listSpecs(dir)).toEqual(["https://github.com/org/repo@v2.0.0"]);
    });

    it("不同 owner/repo 并存", () => {
        addSource(dir, "https://github.com/a/x");
        addSource(dir, "https://github.com/b/y");
        expect(listSpecs(dir)).toHaveLength(2);
    });

    it("remove 按 owner/repo 匹配并保留原始串", () => {
        addSource(dir, "https://github.com/org/repo@v1.0.0");
        const removed = removeSource(dir, "org/repo");
        expect(removed).toBe("https://github.com/org/repo@v1.0.0");
        expect(listSpecs(dir)).toEqual([]);
        expect(removeSource(dir, "org/repo")).toBeNull();
    });

    it("remove 未匹配返回 null 且不改文件", () => {
        addSource(dir, "https://github.com/a/x");
        expect(removeSource(dir, "zzz")).toBeNull();
        const raw = readFileSync(join(dir, "diy.yaml"), "utf-8");
        expect(raw).toContain("https://github.com/a/x");
    });
});

describe("ref.lock.yaml 往返", () => {
    it("save 后 load 结构一致", () => {
        const now = new Date().toISOString();
        saveRefLock(dir, {
            version: 1,
            generated: now,
            source: {
                "github.com/org/repo": {
                    key: "github.com/org/repo",
                    url: "https://github.com/org/repo",
                    version: null,
                    dir: "ref/github.com/org/repo/main",
                    lastSync: now,
                },
            },
        });
        const lock = loadRefLock(dir)!;
        expect(lock.generated).toBe(now);
        expect(lock.source["github.com/org/repo"]!.dir).toBe("ref/github.com/org/repo/main");
    });

    it("无 lock 文件返回 null", () => {
        expect(loadRefLock(dir)).toBeNull();
    });

    it("损坏 YAML 返回 null 不抛", () => {
        const { writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
        mkdirSync(join(dir, ".diy"), { recursive: true });
        writeFileSync(join(dir, ".diy", "ref.lock.yaml"), "::: 坏 yaml\n- x", "utf-8");
        expect(loadRefLock(dir)).toBeNull();
    });
});
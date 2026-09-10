// src/runtime.ts — 运行时配置统一组装点
//
// 契约（对齐 diy-app/src/runtime.ts 的环境变量契约，本包只需 home）：
//   DIY_HOME   数据根（镜像目录 $DIY_HOME/ref 落此）；缺省 ~/.diy
//
// 入口脚本（bin/dev / dev script / 测试）只负责注入环境变量，业务侧统一在此读取。

import { homedir } from "node:os";
import { join } from "node:path";

export interface RuntimeConfig {
    /** 数据根（镜像目录 $DIY_HOME/ref） */
    home: string;
}

export function readRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
    return {
        home: env.DIY_HOME || join(homedir(), ".diy"),
    };
}

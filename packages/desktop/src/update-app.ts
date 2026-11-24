/** Development only (run from the source tree): puts the last commit into the installed Zirma.app from the menu
 * bar, the same as `npm run install:mac` (scripts/install-mac.ts) — typecheck and tests first, then the app is
 * replaced and reopened. Uncommitted changes never go in. What it printed is kept in a log beside the node's.
 */
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Locale } from "@zirma/ui/i18n";

export const UPDATE_LOG = join(homedir(), "Library", "Logs", "Zirma", "install-mac.log");

const TEXT: Record<Locale, Record<"menu" | "running" | "title" | "detail" | "go" | "cancel" | "done" | "failed", string>> = {
  zh: {
    menu: "更新 App 版…",
    running: "正在更新 App 版…",
    title: "把 {commit} 装进 Zirma.app？",
    detail: "只装已提交的代码：{subject}\n没提交的改动不会进去。先跑类型检查和测试，通过了才替换，几分钟后 App 版会重新打开。",
    go: "更新",
    cancel: "取消",
    done: "App 版已更新到 {commit}",
    failed: "App 版没有更新：{reason}",
  },
  en: {
    menu: "Update the App Version…",
    running: "Updating the app version…",
    title: "Install {commit} into Zirma.app?",
    detail: "Only committed code goes in: {subject}\nUncommitted changes stay out. Typecheck and tests run first; the app is replaced only if they pass, and reopens in a few minutes.",
    go: "Update",
    cancel: "Cancel",
    done: "The app version is now {commit}",
    failed: "The app version was not updated: {reason}",
  },
};

export function updateText(locale: Locale, key: keyof (typeof TEXT)["en"], vars: Record<string, string> = {}): string {
  return Object.entries(vars).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), TEXT[locale][key]);
}

/** The commit that would be installed. */
export function lastCommit(root: string): { commit: string; subject: string } {
  const [commit = "", subject = ""] = execFileSync("git", ["log", "-1", "--format=%h%x00%s"], { cwd: root, encoding: "utf8" }).trim().split("\0");
  return { commit, subject };
}

/** Runs the install; resolves with the last line it printed when it failed, or null when it worked. */
export function installApp(root: string): Promise<string | null> {
  mkdirSync(dirname(UPDATE_LOG), { recursive: true });
  const log = createWriteStream(UPDATE_LOG);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve) => {
    let last = "";
    const child = spawn("npm", ["run", "install:mac"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    const keep = (chunk: Buffer) => {
      log.write(chunk);
      const lines = chunk.toString().split("\n").map((line) => line.trim()).filter(Boolean);
      if (lines.length) last = lines[lines.length - 1]!;
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (error) => { log.end(); resolve(error.message); });
    child.on("close", (code) => { log.end(); resolve(code === 0 ? null : last.slice(0, 200) || `exit ${code}`); });
  });
}

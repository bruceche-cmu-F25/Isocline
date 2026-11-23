/** Alfred's skills: folders of instructions (the Agent Skills format, a `SKILL.md` with a name and a description) in
 * `<data>/skills/`, which every engine session is told about (worker.ts). The home node lists them, switches one off
 * or on, removes one, and adds one in two ways: copied from another agent's folder on this Mac, or downloaded from
 * skills.sh (after pi-web's Settings › Skills, github.com/agegr/pi-web, which runs `npx skills`; Alfred asks the site's own download route
 * instead, so nothing is run).
 *
 * Off is the format's own `disable-model-invocation: true` in the skill's frontmatter: the skill stays on disk and
 * Alfred is not told about it. A change moves `<data>/skills.rev`, and warm sessions open anew on their next turn.
 */
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { loadSkillsFromDir, parseFrontmatter, stripFrontmatter, type Skill } from "@earendil-works/pi-coding-agent";
import type { FoundSkill, SkillContent, SkillInfo, SkillSearchResult, SkillsResponse, SkillUpdatesResponse } from "@alfred/protocol";

export class SkillError extends Error {
  override name = "SkillError";
  readonly code: "invalid" | "not_found" | "exists" | "too_large" | "unreachable";
  constructor(code: SkillError["code"], message: string) { super(message); this.code = code; }
}

export interface SkillsOptions {
  dataDir: string;
  /** The user's home folder, where other agents keep their skills. */
  home?: string;
  /** skills.sh, or a stand-in for it. */
  api?: string;
  fetcher?: typeof fetch;
  log?: (message: string) => void;
  /** A skill was added, removed, updated, or switched; recorded as a core event by the caller. */
  onChange?: (kind: "added" | "removed" | "updated" | "enabled" | "disabled", name: string) => void;
}

/** Where other agents on this machine keep their skills, from the home folder. Earlier wins when two hold one name. */
const PLACES = [".agents/skills", ".claude/skills", ".pi/agent/skills", ".codex/skills"];
const DEFAULT_API = "https://skills.sh";
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SOURCE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_CONTENT = 1024 * 1024;
/** A copied folder, and a download: instructions and small scripts, not a project. */
const MAX_COPY = 50 * 1024 * 1024;
const MAX_DOWNLOAD = 10 * 1024 * 1024;
const MAX_FILES = 500;
const TIMEOUT_MS = 20_000;
const SKIPPED = new Set([".git", "node_modules", ".DS_Store"]);

/** What `<data>/skill-sources.json` keeps for a skill that came from skills.sh. */
interface Source { package: string; hash: string; at: number }

const KEY = "disable-model-invocation";
const KEY_LINE = `[ \\t]*(?:${KEY}|"${KEY}"|'${KEY}')[ \\t]*:`;
const NEWLINE = "\\r\\n|\\n|\\r";

function frontmatterBlock(content: string): { start: number; end: number; newline: string } | undefined {
  const opening = new RegExp(`^\\uFEFF?---[ \\t]*(${NEWLINE})`).exec(content);
  if (!opening) return undefined;
  // Pi closes the frontmatter at the first line that starts with ---.
  const closing = new RegExp(`(^|${NEWLINE})---`).exec(content.slice(opening[0].length));
  if (!closing) return undefined;
  return { start: opening[0].length, end: opening[0].length + closing.index + closing[1].length, newline: opening[1] };
}

/** The skill's text with `disable-model-invocation` set or taken out: one line changes, the rest of the frontmatter
 * keeps its formatting. The key is found by being there, not by being true: a second key beside an explicit `false`
 * would make the file unreadable, and the skill would disappear. Adapted from pi-web's lib/skill-frontmatter.ts (https://github.com/agegr/pi-web, MIT, © 2026 agegr;
 * see THIRD-PARTY-NOTICES.md). */
export function setSkillDisabled(content: string, disable: boolean): string {
  const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
  const has = Object.prototype.hasOwnProperty.call(frontmatter, KEY);
  if (!disable && !has) return content;
  const block = frontmatterBlock(content);
  const odd = () => new SkillError("invalid", "This skill's frontmatter is written in a way Alfred cannot edit");
  if (!block) throw odd();
  const head = content.slice(block.start, block.end);
  if (!has) return content.slice(0, block.start) + `${KEY}: true${block.newline}` + content.slice(block.start);
  const line = disable ? new RegExp(`(^|${NEWLINE})(${KEY_LINE})[^\\r\\n]*`) : new RegExp(`(^|${NEWLINE})${KEY_LINE}[^\\r\\n]*(?:${NEWLINE}|$)`);
  if (!line.test(head)) throw odd();
  return content.slice(0, block.start) + head.replace(line, disable ? "$1$2 true" : "$1") + content.slice(block.end);
}

const inside = (root: string, path: string) => { const rel = relative(root, path); return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel); };

function sizeOf(path: string, budget: { bytes: number; files: number }): void {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) if (!SKIPPED.has(entry)) sizeOf(join(path, entry), budget);
    return;
  }
  budget.bytes += stat.size;
  budget.files += 1;
  if (budget.bytes > MAX_COPY || budget.files > 5000) throw new SkillError("too_large", "This skill's folder is too large to copy (over 50 MB)");
}

export class Skills {
  readonly #options: SkillsOptions;
  readonly #dir: string;
  readonly #api: string;
  readonly #fetch: typeof fetch;

  constructor(options: SkillsOptions) {
    this.#options = options;
    this.#dir = join(options.dataDir, "skills");
    this.#api = (options.api ?? DEFAULT_API).replace(/\/+$/, "");
    this.#fetch = options.fetcher ?? fetch;
    mkdirSync(this.#dir, { recursive: true });
  }

  #sources(): Record<string, Source> {
    try {
      const value: unknown = JSON.parse(readFileSync(join(this.#options.dataDir, "skill-sources.json"), "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, Source> : {};
    } catch { return {}; }
  }
  #saveSources(sources: Record<string, Source>): void {
    writeFileSync(join(this.#options.dataDir, "skill-sources.json"), `${JSON.stringify(sources, null, 2)}\n`);
  }
  /** Every engine session opens anew on its next turn (a worker compares this stamp with the one it opened with). */
  #stamp(): void {
    try { writeFileSync(join(this.#options.dataDir, "skills.rev"), `${Date.now()}-${randomBytes(4).toString("hex")}`); } catch { /* sessions pick it up when they next open */ }
  }

  /** A skill's id: its folder under the skills folder, or its file when it is a single Markdown file there. */
  #idOf(skill: Skill): string {
    return relative(this.#dir, basename(skill.filePath) === "SKILL.md" ? skill.baseDir : skill.filePath).split(sep).join("/");
  }
  #loaded(): { skills: Array<{ id: string; skill: Skill }>; problems: string[] } {
    const { skills, diagnostics } = loadSkillsFromDir({ dir: this.#dir, source: "alfred" });
    return {
      skills: skills.map((skill) => ({ id: this.#idOf(skill), skill })).filter((item) => item.id && !item.id.startsWith("..")),
      problems: diagnostics.map((item) => `${item.path ? `${relative(this.#dir, item.path)}: ` : ""}${item.message}`),
    };
  }
  #info(id: string, skill: Skill, sources = this.#sources()): SkillInfo {
    const source = sources[id];
    return {
      id, name: skill.name, description: skill.description, enabled: !skill.disableModelInvocation,
      ...(source ? { source: { package: source.package, url: `${DEFAULT_API}/${source.package}` } } : {}),
    };
  }
  #find(id: string): { id: string; skill: Skill } {
    const found = this.#loaded().skills.find((item) => item.id === id);
    if (!found) throw new SkillError("not_found", "No such skill");
    return found;
  }

  /** Skills in other agents' folders that Alfred does not have (by name). */
  #found(mine: Set<string>): FoundSkill[] {
    const home = this.#options.home ?? homedir();
    const seen = new Set(mine);
    const found: FoundSkill[] = [];
    for (const place of PLACES) {
      const dir = join(home, place);
      if (!existsSync(dir)) continue;
      let skills: Skill[] = [];
      try { ({ skills } = loadSkillsFromDir({ dir, source: "found" })); } catch { continue; }
      for (const skill of skills) {
        if (seen.has(skill.name)) continue;
        seen.add(skill.name);
        found.push({ name: skill.name, description: skill.description, path: basename(skill.filePath) === "SKILL.md" ? skill.baseDir : skill.filePath, place: `~/${place}` });
      }
    }
    return found.sort((a, b) => a.name.localeCompare(b.name));
  }

  list(): SkillsResponse {
    const { skills, problems } = this.#loaded();
    const sources = this.#sources();
    return {
      skills: skills.map(({ id, skill }) => this.#info(id, skill, sources)).sort((a, b) => a.name.localeCompare(b.name)),
      found: this.#found(new Set(skills.map((item) => item.skill.name))),
      problems,
    };
  }

  #instructions(skill: Skill): string {
    if (statSync(skill.filePath).size > MAX_CONTENT) throw new SkillError("too_large", "This skill's instructions are larger than 1 MB");
    return stripFrontmatter(readFileSync(skill.filePath, "utf8")).trim();
  }

  content(id: string): SkillContent {
    return { content: this.#instructions(this.#find(id).skill) };
  }

  /** Expand only the command at the start of the user's own Code message. Look up the enabled copy
   * in Alfred each time so a skill added or switched since the session opened takes effect. */
  expandCommand(text: string): string {
    const command = /^\/skill:(\S+)(?:\s+|$)/u.exec(text);
    if (!command) return text;
    const name = command[1];
    const entry = this.#loaded().skills.find(({ skill }) => skill.name === name && !skill.disableModelInvocation);
    if (!entry) throw new SkillError("not_found", `Skill "${name}" is not installed and enabled in Alfred.`);
    const { skill } = entry;
    const instructions = this.#instructions(skill);
    const request = text.slice(command[0].length);
    return `The user selected the ${JSON.stringify(name)} skill. Its relative paths are under ${JSON.stringify(skill.baseDir)}.\n<skill>\n${instructions}\n</skill>${request ? `\n\n${request}` : ""}`;
  }

  setEnabled(id: string, enabled: boolean): SkillInfo {
    const { skill } = this.#find(id);
    const text = readFileSync(skill.filePath, "utf8");
    const next = setSkillDisabled(text, !enabled);
    if (next !== text) {
      writeFileSync(skill.filePath, next);
      this.#stamp();
      this.#options.onChange?.(enabled ? "enabled" : "disabled", skill.name);
    }
    return this.#info(id, { ...skill, disableModelInvocation: !enabled });
  }

  remove(id: string): void {
    const { skill } = this.#find(id);
    const target = basename(skill.filePath) === "SKILL.md" ? skill.baseDir : skill.filePath;
    // Never the skills folder itself, and nothing outside it.
    if (!inside(this.#dir, target)) throw new SkillError("invalid", "Not one of Alfred's skills");
    rmSync(target, { recursive: true, force: true });
    const sources = this.#sources();
    if (sources[id]) { delete sources[id]; this.#saveSources(sources); }
    this.#stamp();
    this.#options.onChange?.("removed", skill.name);
  }

  /** Copies a skill found on this Mac into Alfred's folder. `path` is one that `list` named, nothing else. */
  addFound(path: string): SkillInfo {
    const { skills } = this.#loaded();
    const candidate = this.#found(new Set(skills.map((item) => item.skill.name))).find((item) => item.path === path);
    if (!candidate) throw new SkillError("not_found", "No such skill on this Mac, or Alfred already has one with its name");
    const name = basename(path);
    if (!NAME.test(name.replace(/\.md$/i, ""))) throw new SkillError("invalid", "This skill's folder name has characters Alfred does not take");
    const target = join(this.#dir, name);
    if (existsSync(target)) throw new SkillError("exists", `Alfred already has a skill in “${name}”`);
    sizeOf(path, { bytes: 0, files: 0 });
    // Links are followed: the copy is Alfred's own, whole, and stays when the other agent's folder changes.
    cpSync(path, target, { recursive: true, dereference: true, filter: (from) => !SKIPPED.has(basename(from)) });
    this.#stamp();
    this.#options.onChange?.("added", candidate.name);
    return this.#info(...this.#entry(name));
  }
  #entry(id: string): [string, Skill] { const found = this.#find(id); return [found.id, found.skill]; }

  async #json(path: string): Promise<unknown> {
    let response: Response;
    try { response = await this.#fetch(`${this.#api}${path}`, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) }); }
    catch (error) { throw new SkillError("unreachable", `skills.sh could not be reached: ${error instanceof Error ? error.message : String(error)}`); }
    if (!response.ok) throw new SkillError("unreachable", `skills.sh answered ${response.status}`);
    return response.json();
  }

  async search(query: string): Promise<SkillSearchResult[]> {
    const text = query.trim().slice(0, 200);
    if (!text) throw new SkillError("invalid", "Say what to look for");
    const data = await this.#json(`/api/search?q=${encodeURIComponent(text)}&limit=30`) as { skills?: Array<{ id?: unknown; source?: unknown; skillId?: unknown; name?: unknown; installs?: unknown }> };
    const have = new Set(Object.values(this.#sources()).map((source) => source.package));
    const names = new Set(this.#loaded().skills.map((item) => item.skill.name));
    const results: SkillSearchResult[] = [];
    for (const item of Array.isArray(data.skills) ? data.skills : []) {
      const source = typeof item.source === "string" ? item.source.trim() : "";
      const slug = typeof item.skillId === "string" && item.skillId ? item.skillId : typeof item.name === "string" ? item.name : "";
      if (!SOURCE.test(source) || !NAME.test(slug)) continue;
      const pkg = `${source}/${slug}`;
      const name = typeof item.name === "string" && item.name ? item.name : slug;
      results.push({ package: pkg, name, source, installs: typeof item.installs === "number" && item.installs > 0 ? Math.floor(item.installs) : 0, url: `${DEFAULT_API}/${pkg}`, added: have.has(pkg) || names.has(name) });
    }
    return results.sort((a, b) => b.installs - a.installs);
  }

  async #download(pkg: string): Promise<{ hash: string; files: Array<{ path: string; contents: string }> }> {
    const [owner, repo, slug, ...rest] = pkg.split("/");
    if (rest.length || !SOURCE.test(`${owner}/${repo}`) || !NAME.test(slug ?? "")) throw new SkillError("invalid", "A skill from skills.sh is owner/repo/skill");
    const data = await this.#json(`/api/download/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(slug)}`) as { hash?: unknown; files?: unknown };
    if (!Array.isArray(data.files) || data.files.length === 0) throw new SkillError("unreachable", "skills.sh has no files for this skill");
    if (data.files.length > MAX_FILES) throw new SkillError("too_large", "This skill has too many files");
    const files: Array<{ path: string; contents: string }> = [];
    let bytes = 0;
    for (const file of data.files as Array<{ path?: unknown; contents?: unknown }>) {
      if (typeof file.path !== "string" || typeof file.contents !== "string") throw new SkillError("invalid", "skills.sh sent a file Alfred cannot read");
      // A path stays inside the skill's folder: no root, no drive, no `..`, nothing hidden at the top that is Alfred's.
      const parts = file.path.split("/");
      if (!file.path || file.path.startsWith("/") || /[\\\0:]/.test(file.path) || parts.some((part) => part === "" || part === "." || part === ".." || part === ".git")) throw new SkillError("invalid", `skills.sh sent a file outside the skill: ${file.path.slice(0, 80)}`);
      bytes += Buffer.byteLength(file.contents);
      if (bytes > MAX_DOWNLOAD) throw new SkillError("too_large", "This skill is larger than 10 MB");
      files.push({ path: file.path, contents: file.contents });
    }
    if (!files.some((file) => file.path === "SKILL.md")) throw new SkillError("invalid", "This download has no SKILL.md");
    return { hash: typeof data.hash === "string" ? data.hash : "", files };
  }

  /** Writes a download into a folder beside the skills folder, then puts it in place in one move. */
  #place(id: string, files: Array<{ path: string; contents: string }>, replace: boolean): void {
    const target = join(this.#dir, id);
    if (!replace && existsSync(target)) throw new SkillError("exists", `Alfred already has a skill in “${id}”`);
    const incoming = join(this.#options.dataDir, `skill-incoming-${randomBytes(4).toString("hex")}`);
    try {
      for (const file of files) {
        const path = join(incoming, ...file.path.split("/"));
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, file.contents);
      }
      const old = replace && existsSync(target) ? `${incoming}-old` : null;
      if (old) renameSync(target, old);
      try { renameSync(incoming, target); }
      catch (error) { if (old) renameSync(old, target); throw error; }
      if (old) rmSync(old, { recursive: true, force: true });
    } finally {
      rmSync(incoming, { recursive: true, force: true });
    }
  }

  /** Downloads `owner/repo/skill` from skills.sh into Alfred's folder. */
  async install(pkg: string): Promise<SkillInfo> {
    const download = await this.#download(pkg);
    const id = pkg.split("/")[2];
    this.#place(id, download.files, false);
    let entry: [string, Skill];
    try { entry = this.#entry(id); }
    catch { rmSync(join(this.#dir, id), { recursive: true, force: true }); throw new SkillError("invalid", "The download is not a skill Alfred can read (its SKILL.md needs a description)"); }
    this.#saveSources({ ...this.#sources(), [id]: { package: pkg, hash: download.hash, at: Date.now() } });
    this.#stamp();
    this.#options.onChange?.("added", entry[1].name);
    return this.#info(...entry);
  }

  /** Which of the skills from skills.sh have another version there now. */
  async updates(): Promise<SkillUpdatesResponse> {
    const sources = this.#sources();
    const mine = new Set(this.#loaded().skills.map((item) => item.id));
    const updates: string[] = [], failed: string[] = [];
    await Promise.all(Object.entries(sources).filter(([id]) => mine.has(id)).map(async ([id, source]) => {
      try { if ((await this.#download(source.package)).hash !== source.hash) updates.push(id); }
      catch (error) { failed.push(id); this.#options.log?.(`skill ${id}: update check failed: ${error instanceof Error ? error.message : String(error)}`); }
    }));
    return { updates: updates.sort(), failed: failed.sort() };
  }

  /** Downloads a skill again from where it came, keeping whether it was switched off. */
  async update(id: string): Promise<SkillInfo> {
    const before = this.#find(id);
    const source = this.#sources()[id];
    if (!source) throw new SkillError("invalid", "This skill did not come from skills.sh");
    const download = await this.#download(source.package);
    const skillFile = download.files.find((file) => file.path === "SKILL.md")!;
    if (before.skill.disableModelInvocation) skillFile.contents = setSkillDisabled(skillFile.contents, true);
    this.#place(id, download.files, true);
    this.#saveSources({ ...this.#sources(), [id]: { ...source, hash: download.hash, at: Date.now() } });
    this.#stamp();
    const entry = this.#entry(id);
    this.#options.onChange?.("updated", entry[1].name);
    return this.#info(...entry);
  }
}

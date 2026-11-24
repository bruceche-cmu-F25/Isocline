/** Builds Zirma.app (and a disk image to hand out) from this checkout, without a packaging dependency: it takes
 * the Electron.app that `npm install` already put in node_modules, renames it Zirma, and puts the app's sources and
 * only its production dependencies inside, as plain files (no asar: the home node is started from these files by
 * launchd, and node-pty and sharp load native code from them).
 *
 *   npm run package:mac            → dist/mac/Zirma.app and dist/mac/Zirma-<version>-<arch>.dmg
 *   npm run package:mac -- --no-dmg
 *   npm run package:mac -- --allow-uncommitted   (a trial build; never the one to use every day)
 *
 * The app is production (core stage.ts), so it is built only from committed code: the commit goes into its
 * Info.plist (ZirmaCommit), and uncommitted changes to what goes inside stop the build.
 *
 * The app is signed ad hoc, not with a Developer ID, and not notarized: on another Mac, the first open is
 * right-click → Open (or System Settings → Privacy & Security → Open Anyway).
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { appIconPixels } from "../packages/desktop/src/icon-art.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string; homepage?: string; description?: string; license?: string };
const version = pkg.version ?? "0.0.0";
const name = "Zirma";
// A bundle id from who publishes it, so a fork gets its own: github.com/<owner>/… → io.github.<owner>.zirma.
const where = /github\.com\/([^/]+)\//.exec(pkg.homepage ?? "");
const bundleId = (where ? `io.github.${where[1]}.zirma` : "org.zirma.desktop").toLowerCase().replace(/[^a-z0-9.-]/g, "-");
const arch = process.arch;
const out = join(root, "dist", "mac");
const appPath = join(out, `${name}.app`);
const contents = join(appPath, "Contents");
const appDir = join(contents, "Resources", "app");
const run = (command: string, args: string[], options: { cwd?: string } = {}) =>
  execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 << 20, ...options });
const plist = (file: string, ...commands: string[]) => { for (const command of commands) run("/usr/libexec/PlistBuddy", ["-c", command, file]); };
/** Sets a string in an Info.plist, adding the key when the bundle left it out. */
const put = (file: string, key: string, value: string) => {
  const quoted = `"${value.replace(/"/g, '\\"')}"`;
  try { plist(file, `Set :${key} ${quoted}`); } catch { plist(file, `Add :${key} string ${quoted}`); }
};
const step = (text: string) => console.log(`▸ ${text}`);

if (process.platform !== "darwin") throw new Error("Zirma.app is built on a Mac.");

// Production runs what was committed, not whatever the working tree holds today.
const SHIPPED = ["packages", "modules", "package.json", "package-lock.json", "LICENSE", "THIRD-PARTY-NOTICES.md"];
const uncommitted = run("git", ["status", "--porcelain", "--", ...SHIPPED], { cwd: root }).split("\n").filter(Boolean);
if (uncommitted.length && !process.argv.includes("--allow-uncommitted")) {
  console.error(`Uncommitted changes would go into the app:\n${uncommitted.slice(0, 12).join("\n")}${uncommitted.length > 12 ? `\n… and ${uncommitted.length - 12} more` : ""}`);
  console.error("Commit them (or stash them) first. For a trial build only: npm run package:mac -- --allow-uncommitted");
  process.exit(1);
}
const commit = run("git", ["rev-parse", "--short", "HEAD"], { cwd: root }).trim() + (uncommitted.length ? "-uncommitted" : "");

step("Building the interface");
run("npm", ["run", "build:ui"], { cwd: root });

step("Copying Electron");
rmSync(appPath, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
run("/usr/bin/ditto", [join(root, "node_modules", "electron", "dist", "Electron.app"), appPath]);
rmSync(join(contents, "Resources", "default_app.asar"), { force: true });
rmSync(join(contents, "Resources", "electron.icns"), { force: true });

step("Renaming it Zirma");
// Electron finds its helpers by the main executable's name ("<name> Helper (Renderer).app"), so all are renamed together.
run("/bin/mv", [join(contents, "MacOS", "Electron"), join(contents, "MacOS", name)]);
const frameworks = join(contents, "Frameworks");
for (const helper of readdirSync(frameworks).filter((entry) => /^Electron Helper.*\.app$/.test(entry))) {
  const renamed = helper.replace(/^Electron/, name);
  const kind = /\((.+)\)/.exec(helper)?.[1]?.toLowerCase();
  run("/bin/mv", [join(frameworks, helper), join(frameworks, renamed)]);
  const exe = helper.replace(/\.app$/, ""), newExe = renamed.replace(/\.app$/, "");
  run("/bin/mv", [join(frameworks, renamed, "Contents", "MacOS", exe), join(frameworks, renamed, "Contents", "MacOS", newExe)]);
  const helperInfo = join(frameworks, renamed, "Contents", "Info.plist");
  put(helperInfo, "CFBundleExecutable", newExe);
  put(helperInfo, "CFBundleName", newExe);
  put(helperInfo, "CFBundleIdentifier", `${bundleId}.helper${kind ? `.${kind}` : ""}`);
}
const info = join(contents, "Info.plist");
for (const [key, value] of Object.entries({
  CFBundleExecutable: name, CFBundleName: name, CFBundleDisplayName: name, CFBundleIdentifier: bundleId,
  CFBundleShortVersionString: version, CFBundleVersion: version, CFBundleIconFile: `${name}.icns`, ZirmaCommit: commit,
  LSApplicationCategoryType: "public.app-category.productivity",
  // What macOS shows when Zirma first asks: the microphone is for dictation, and nothing else is used.
  NSMicrophoneUsageDescription: "Zirma listens only while you hold its figure, press the talk shortcut or use a microphone button, to turn what you say into text.",
})) put(info, key, value);
for (const key of ["ElectronAsarIntegrity", "NSCameraUsageDescription", "NSBluetoothPeripheralUsageDescription", "NSBluetoothAlwaysUsageDescription", "NSAudioCaptureUsageDescription"]) {
  try { plist(info, `Delete :${key}`); } catch { /* already gone */ }
}

step("Drawing the icon");
const iconset = join(out, `${name}.iconset`);
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset);
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const pixels = size * scale;
    await sharp(Buffer.from(appIconPixels(pixels)), { raw: { width: pixels, height: pixels, channels: 4 } })
      .png().toFile(join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`));
  }
}
run("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", join(contents, "Resources", `${name}.icns`)]);
rmSync(iconset, { recursive: true, force: true });

step("Copying Zirma's sources");
mkdirSync(appDir, { recursive: true });
writeFileSync(join(appDir, "package.json"), JSON.stringify({
  name: "zirma", productName: name, version, description: pkg.description, license: pkg.license, homepage: pkg.homepage,
  type: "module", main: "packages/desktop/src/main.ts", commit,
}, null, 2) + "\n");
for (const file of ["LICENSE", "THIRD-PARTY-NOTICES.md"]) cpSync(join(root, file), join(appDir, file));
/** What each workspace package needs at run time: its manifest and sources, never its tests. */
const RUNTIME: Record<string, string[]> = { "packages/ui": ["dist", "src"], "packages/server": ["src", "voice"] };
const workspaces = ["packages", "modules"].flatMap((group) => readdirSync(join(root, group)).map((entry) => `${group}/${entry}`))
  .filter((dir) => existsSync(join(root, dir, "package.json")));
for (const dir of workspaces) {
  mkdirSync(join(appDir, dir), { recursive: true });
  cpSync(join(root, dir, "package.json"), join(appDir, dir, "package.json"));
  for (const part of RUNTIME[dir] ?? ["src"]) {
    if (existsSync(join(root, dir, part))) cpSync(join(root, dir, part), join(appDir, dir, part), { recursive: true, verbatimSymlinks: true });
  }
}

step("Copying production dependencies");
// npm's own answer to "what does this need to run" (dev dependencies, Electron itself among them, left out).
const needed = run("npm", ["ls", "--omit=dev", "--all", "--parseable"], { cwd: root }).split("\n")
  .map((line) => line.trim()).filter((line) => line.startsWith(join(root, "node_modules") + "/"))
  .map((line) => relative(root, line));
// Only the top of each package: a package's own nested node_modules come with it.
const tops = new Set(needed.map((path) => {
  const parts = path.split("/");
  return parts.slice(0, parts[1]!.startsWith("@") ? 3 : 2).join("/");
}));
let copied = 0;
for (const top of [...tops].sort()) {
  const source = join(root, top), target = join(appDir, top);
  mkdirSync(dirname(target), { recursive: true });
  const link = lstatSync(source, { throwIfNoEntry: false });
  if (!link) continue;
  // A workspace package is a link to its folder in the workspace; it stays one, pointing at the copy inside the app.
  if (link.isSymbolicLink()) {
    const workspace = workspaces.find((dir) => join(root, dir) === realpathSync(source));
    if (!workspace) throw new Error(`${top} links outside the workspace`);
    symlinkSync(relative(dirname(target), join(appDir, workspace)), target);
  } else {
    run("/usr/bin/ditto", [source, target]);
    copied++;
  }
}
console.log(`  ${copied} packages`);

step("Signing (ad hoc)");
run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath]);
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);

const size = run("/usr/bin/du", ["-sh", appPath]).split("\t")[0];
console.log(`✓ ${relative(root, appPath)} (${size}, ${version}, ${arch}, ${bundleId})`);

if (!process.argv.includes("--no-dmg")) {
  step("Making the disk image");
  const stage = join(out, "dmg");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage);
  run("/usr/bin/ditto", [appPath, join(stage, `${name}.app`)]);
  symlinkSync("/Applications", join(stage, "Applications"));
  const dmg = join(out, `${name}-${version}-${arch}.dmg`);
  rmSync(dmg, { force: true });
  run("/usr/bin/hdiutil", ["create", "-volname", name, "-srcfolder", stage, "-format", "UDZO", "-ov", dmg]);
  rmSync(stage, { recursive: true, force: true });
  console.log(`✓ ${relative(root, dmg)} (${run("/usr/bin/du", ["-sh", dmg]).split("\t")[0]})`);
}

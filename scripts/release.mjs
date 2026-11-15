// Publish a new version of Rewatch so every installed copy updates itself.
//
//   node scripts/release.mjs --version 0.2.1 "What is new in a sentence"
//
// It sets the version number, builds the installer, signs it with the key in
// .secrets/updater.key, uploads it to rewatch.ggwp.no and announces it there. The
// version's interface goes up beside it as one signed file: installed apps whose native
// part (everything in src-tauri) is the same as this build's take just that, without a
// restart, and the rest take the installer. Installed apps pick it up within six hours,
// or at once with Settings > Updates > Check now. Options:
//   --skip-build   use the installer that is already built
//   --again        publish over a version number that is already out (avoid: apps
//                  that already have that version will not take it again)
//   --native-id    only print the native part's fingerprint as it is now

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://rewatch.ggwp.no";
const BUCKET = "rewatch-releases";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const versionAt = argv.indexOf("--version");
const wanted = versionAt >= 0 ? argv[versionAt + 1] : null;
const notes = argv.filter((a, i) => !a.startsWith("--") && i !== versionAt + 1).join(" ").trim();

function stop(message) {
  console.error(`\nStopped: ${message}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
  if (r.status !== 0) stop(`${cmd} ${args.slice(0, 3).join(" ")} failed.`);
}

// The native part's fingerprint: every file in src-tauri that goes into the program, with
// the version number taken out (it changes every release), and the versions of the
// @tauri-apps packages the interface reaches it through. Built into the program (see
// update::native_id). A later build with the same fingerprint differs only in its
// interface, and installed copies of this one take that without a restart.
function nativeId() {
  const hash = createHash("sha256");
  const base = join(root, "src-tauri");
  const walk = (rel) => {
    for (const name of readdirSync(join(base, rel)).sort()) {
      const path = rel ? `${rel}/${name}` : name;
      if (path === "target" || path === "gen") continue;
      const info = statSync(join(base, path));
      if (info.isDirectory()) {
        walk(path);
        continue;
      }
      hash.update(`${path}\n`);
      // FFmpeg (over 100 MB): its size tells builds apart.
      if (info.size > 8 * 1024 * 1024) {
        hash.update(`${info.size}\n`);
        continue;
      }
      // Bytes as they are, apart from line endings, which git may change.
      let text = readFileSync(join(base, path), "latin1").replace(/\r\n/g, "\n");
      if (path === "tauri.conf.json") text = text.replace(/"version": "[^"]+"/, '"version": ""');
      if (path === "Cargo.toml") text = text.replace(/^version = "[^"]+"/m, 'version = ""');
      if (path === "Cargo.lock") text = text.replace(/(name = "rewatch"\nversion = )"[^"]+"/, '$1""');
      hash.update(text, "latin1");
    }
  };
  walk("");
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  for (const [path, pkg] of Object.entries(lock.packages ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (/^node_modules\/@tauri-apps\/(api|plugin-[^/]+)$/.test(path)) hash.update(`${path} ${pkg.version}\n`);
  }
  return hash.digest("hex").slice(0, 32);
}

function edit(file, pattern, replacement) {
  const path = join(root, file);
  const before = readFileSync(path, "utf8");
  const after = before.replace(pattern, replacement);
  if (before === after && !pattern.test(after)) stop(`could not find the version in ${file}`);
  writeFileSync(path, after);
}

// `--native-id` only says what the fingerprint is now.
if (flag("--native-id")) {
  console.log(nativeId());
  process.exit(0);
}

// ---- version number, in the three places that carry it
if (wanted) {
  if (!/^\d+\.\d+\.\d+$/.test(wanted)) stop("the version must look like 0.2.1");
  edit("src-tauri/tauri.conf.json", /"version": "[^"]+"/, `"version": "${wanted}"`);
  edit("package.json", /"version": "[^"]+"/, `"version": "${wanted}"`);
  edit("src-tauri/Cargo.toml", /^version = "[^"]+"/m, `version = "${wanted}"`);
}
const version = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8")).version;
const name = `Rewatch_${version}_x64-setup.exe`;
const outDir = join(root, "src-tauri/target/release/bundle/nsis");
const installer = join(outDir, name);
const key = join(root, ".secrets/updater.key");
const tauri = join(root, "node_modules/@tauri-apps/cli/tauri.js");
if (!existsSync(key)) stop("the signing key .secrets/updater.key is missing. Without it installed apps refuse the update.");

const published = await fetch(`${SITE}/latest.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
if (published?.version === version && !flag("--again")) {
  stop(`version ${version} is already published. Pass --version with a higher number.`);
}

// ---- build, sign
// After the version is set: the fingerprint leaves the number out, but reads the files.
const native = nativeId();
if (!flag("--skip-build")) run(process.execPath, [tauri, "build"], { env: { ...process.env, REWATCH_NATIVE_ID: native } });
if (!existsSync(installer)) stop(`${installer} does not exist. Build first.`);
// The key has no password; the empty one still has to be passed or the tool asks for it.
run(process.execPath, [tauri, "signer", "sign", "-f", key, "-p", "", installer]);
const signature = readFileSync(`${installer}.sig`, "utf8").trim();

// ---- the interface on its own, written by the program that was just built
const uiName = `Rewatch_${version}_ui.json`;
const uiFile = join(outDir, uiName);
const exe = join(root, "src-tauri/target/release/rewatch.exe");
// A program too old to know --ui-bundle would open its window instead; the time limit ends that.
const packed = spawnSync(exe, ["--ui-bundle", uiFile], { cwd: root, encoding: "utf8", timeout: 60000 });
let ui = null;
if (packed.status === 0 && existsSync(uiFile)) {
  const made = JSON.parse(readFileSync(uiFile, "utf8"));
  if (made.version !== version) stop(`the interface file says version ${made.version}, not ${version}. Build again.`);
  if (made.native !== native) {
    console.warn(`\nNote: src-tauri changed since the build (fingerprint ${made.native}, now ${native}). The interface goes out for the build's.`);
  }
  run(process.execPath, [tauri, "signer", "sign", "-f", key, "-p", "", uiFile]);
  ui = { native: made.native, url: `${SITE}/download/${uiName}`, signature: readFileSync(`${uiFile}.sig`, "utf8").trim() };
  const before = published?.ui?.native;
  console.log(
    `\nNative part ${made.native}: ${before === made.native ? `the same as ${published.version}'s, so apps on it update without a restart` : "changed, so installed apps take the installer and restart"}.`,
  );
} else {
  console.warn(`\nNo interface-only update this time (${(packed.stdout || packed.stderr || String(packed.error ?? "")).trim()}). Installed apps take the installer.`);
}

// ---- upload the installer and the interface first, the announcement last
const latest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: { "windows-x86_64": { signature, url: `${SITE}/download/${name}` } },
  ...(ui ? { ui } : {}),
};
const latestFile = join(outDir, "latest.json");
writeFileSync(latestFile, JSON.stringify(latest, null, 1));
// The Cloudflare account id lives outside the repository.
const accountFile = join(root, ".secrets/cloudflare-account-id");
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || (existsSync(accountFile) ? readFileSync(accountFile, "utf8").trim() : "");
const wranglerEnv = accountId ? { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId } : process.env;
const put = (object, file, type) =>
  run("npx", ["--yes", "wrangler@4", "r2", "object", "put", `${BUCKET}/${object}`, `--file="${file}"`, `--content-type=${type}`, "--remote"], {
    shell: true,
    cwd: join(root, "updates-site"),
    env: wranglerEnv,
  });
put(name, installer, "application/octet-stream");
if (ui) {
  put(uiName, uiFile, "application/json");
  // Apps go for it as soon as it's announced, so it must be served first.
  const served = await fetch(ui.url, { method: "HEAD" }).then((r) => r.ok).catch(() => false);
  if (!served) stop(`${ui.url} is not served. Deploy the site first (npx wrangler deploy in updates-site/), then run this again with --skip-build.`);
}
put("latest.json", latestFile, "application/json");

// ---- check what the site now says
const seen = await fetch(`${SITE}/latest.json`).then((r) => r.json()).catch(() => null);
if (seen?.version !== version) stop(`uploaded, but ${SITE}/latest.json announces ${seen?.version ?? "nothing"}.`);
console.log(`\nPublished ${version}. Download page: ${SITE}  Direct link: ${SITE}/download/latest`);

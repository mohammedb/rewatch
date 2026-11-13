// Publish a new version of Rewatch so every installed copy updates itself.
//
//   node scripts/release.mjs --version 0.2.1 "What is new in a sentence"
//
// It sets the version number, builds the installer, signs it with the key in
// .secrets/updater.key, uploads it to rewatch.ggwp.no and announces it there.
// Installed apps pick it up within six hours, or at once with Settings > Updates >
// Check now. Options:
//   --skip-build   use the installer that is already built
//   --again        publish over a version number that is already out (avoid: apps
//                  that already have that version will not take it again)

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

function edit(file, pattern, replacement) {
  const path = join(root, file);
  const before = readFileSync(path, "utf8");
  const after = before.replace(pattern, replacement);
  if (before === after && !pattern.test(after)) stop(`could not find the version in ${file}`);
  writeFileSync(path, after);
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
if (!flag("--skip-build")) run(process.execPath, [tauri, "build"]);
if (!existsSync(installer)) stop(`${installer} does not exist. Build first.`);
// The key has no password; the empty one still has to be passed or the tool asks for it.
run(process.execPath, [tauri, "signer", "sign", "-f", key, "-p", "", installer]);
const signature = readFileSync(`${installer}.sig`, "utf8").trim();

// ---- upload the installer first, the announcement last
const latest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: { "windows-x86_64": { signature, url: `${SITE}/download/${name}` } },
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
put("latest.json", latestFile, "application/json");

// ---- check what the site now says
const seen = await fetch(`${SITE}/latest.json`).then((r) => r.json()).catch(() => null);
if (seen?.version !== version) stop(`uploaded, but ${SITE}/latest.json announces ${seen?.version ?? "nothing"}.`);
console.log(`\nPublished ${version}. Download page: ${SITE}  Direct link: ${SITE}/download/latest`);

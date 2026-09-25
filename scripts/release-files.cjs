const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/**
 * After a build: make sure release/latest.yml describes the new installer
 * (electron-builder writes it only when a GitHub repo is set in brand.json)
 * and print the files to attach to a GitHub release. The updater reads
 * latest.yml from the release to find the installer and check its hash.
 */

const root = path.join(__dirname, "..");
const brand = require(path.join(root, "brand.json"));
const { version } = require(path.join(root, "package.json"));
const dir = path.join(root, "release");
const base = brand.name.replace(/[^\w.-]+/g, "-");
const setup = `${base}-Setup-${version}.exe`;
const portable = `${base}-${version}-portable.exe`;

const setupPath = path.join(dir, setup);
if (!fs.existsSync(setupPath)) {
  console.error(`no installer at ${setupPath}`);
  process.exit(1);
}

const data = fs.readFileSync(setupPath);
const sha512 = crypto.createHash("sha512").update(data).digest("base64");
const yml = [
  `version: ${version}`,
  "files:",
  `  - url: ${setup}`,
  `    sha512: ${sha512}`,
  `    size: ${data.length}`,
  `path: ${setup}`,
  `sha512: ${sha512}`,
  `releaseDate: '${new Date().toISOString()}'`,
  "",
].join("\n");
fs.writeFileSync(path.join(dir, "latest.yml"), yml);

const upload = [setup, `${setup}.blockmap`, portable, "latest.yml"].filter((f) => fs.existsSync(path.join(dir, f)));
console.log(`\nrelease v${version}: attach these files from release/ to a GitHub release tagged v${version}`);
for (const f of upload) console.log(`  ${f}`);
if (!brand.updateRepo) console.log("\nbrand.json has no updateRepo: installed copies will not look for updates");

// dist/ is only the web part before packing: it is inside the installer now
fs.rmSync(path.join(root, "dist"), { recursive: true, force: true });
fs.rmSync(path.join(dir, "builder-debug.yml"), { force: true });

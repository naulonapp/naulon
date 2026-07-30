/**
 * Build the WordPress plugin's update manifest — the document a publisher's site fetches to
 * learn that a new version exists.
 *
 * The plugin is not on wordpress.org, so nothing publishes its version for it. This script is
 * that publisher, and it derives EVERY field from the plugin's own files: the headers in
 * `naulon.php` and the sections in `readme.txt`. Nothing here is typed by hand per release, which
 * is the whole point — a manifest with its own copy of the version is a second source of truth,
 * and the release that shipped as 0.1.0 twice is what this repo already learned about those.
 *
 * The consumer is `plugins/naulon/includes/class-naulon-updater.php`. It re-validates whatever it
 * receives (a version it can compare, a package on the pinned release host) because a manifest
 * travels over the network and this script's honesty is not evidence of the document's. The two
 * halves are checked against each other in CI: this script's output is fed to that class's
 * validator, so a field either side renames cannot pass unnoticed.
 *
 *   node scripts/wp-update-manifest.mjs                  # print the manifest
 *   node scripts/wp-update-manifest.mjs --out=x.json     # write it
 *   node scripts/wp-update-manifest.mjs --check          # assert every invariant, print nothing
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DIR = resolve(REPO, "plugins/naulon");

/**
 * `releases/latest/download/<asset>` is GitHub's version-free redirector: it always resolves to
 * the newest published release. Both the zip and this manifest are served through it, so a
 * release adds no URL anywhere that needs bumping — and the plugin can pin the download host as
 * a constant instead of trusting whatever a manifest names.
 */
const RELEASES = "https://github.com/naulonapp/naulon/releases";
const PACKAGE = `${RELEASES}/latest/download/naulon.zip`;

/**
 * Listing art lives in `.wordpress-org/`, which `.distignore` deliberately keeps OUT of the
 * shipped zip (it belongs in the wordpress.org SVN `/assets`, never in the plugin). The update
 * row and the details modal still want it, so it is served raw from the default branch — pinned
 * to `main` rather than a tag so an image URL cannot 404 for a site running an older version.
 */
const ART = "https://raw.githubusercontent.com/naulonapp/naulon/main/plugins/naulon/.wordpress-org";

const read = (file) => readFileSync(resolve(PLUGIN_DIR, file), "utf8");

/** A `Header: value` line from the plugin file's docblock. */
function header(php, name) {
  const m = php.match(new RegExp(`^\\s*\\*\\s*${name}:\\s*(.+?)\\s*$`, "m"));
  return m ? m[1] : "";
}

/** A `Header: value` line from readme.txt's preamble. */
function readmeField(readme, name) {
  const m = readme.match(new RegExp(`^${name}:\\s*(.+?)\\s*$`, "m"));
  return m ? m[1] : "";
}

/**
 * The body of a `== Name ==` section, up to the next one.
 *
 * Deliberately NOT multiline: under `m` the `$` in the lookahead matches every end-of-LINE, so a
 * lazy body stops after the first one and every section comes out one line long. Anchoring the
 * heading with `(?:^|\n)` instead buys the same start-of-line match without that.
 */
function section(readme, name) {
  const m = readme.match(new RegExp(`(?:^|\\n)== ${name} ==[ \\t]*\\n([\\s\\S]*?)(?=\\n== |$)`));
  return m ? m[1].trim() : "";
}

/**
 * wordpress.org readme markup → the HTML the details modal renders. Deliberately small: bold,
 * inline code, `= x =` headings and `*` lists are the only markup this readme uses, and a general
 * Markdown renderer would be a dependency plus a surface where the modal could render something
 * the readme does not say. If the readme grows syntax, extend this — do not reach for a library.
 */
function toHtml(text) {
  const inline = (s) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`(.+?)`/g, "<code>$1</code>");

  const out = [];
  let list = null;

  const closeList = () => {
    if (list) {
      out.push(`<ul>${list.join("")}</ul>`);
      list = null;
    }
  };

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) {
      closeList();
      continue;
    }
    const heading = line.match(/^=\s*(.+?)\s*=$/);
    if (heading) {
      closeList();
      out.push(`<h4>${inline(heading[1])}</h4>`);
      continue;
    }
    const item = line.match(/^\*\s+(.*)$/);
    if (item) {
      (list ??= []).push(`<li>${inline(item[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();

  return out.join("\n");
}

/**
 * The `= <version> =` block under `== Upgrade Notice ==`, flattened to one line — core renders it
 * inline in the update notice, where a newline is just a wider gap. Same no-`m` reason as
 * `section()`: the terminating lookahead must mean end of STRING, not end of line.
 */
function upgradeNotice(readme, version) {
  const body = section(readme, "Upgrade Notice");
  const escaped = version.replace(/\./g, "\\.");
  const m = body.match(new RegExp(`(?:^|\\n)=\\s*${escaped}\\s*=[ \\t]*\\n([\\s\\S]*?)(?=\\n=\\s|$)`));
  return m ? m[1].trim().replace(/\s*\n\s*/g, " ") : "";
}

/**
 * When the plugin last changed, not when this script ran — so re-running it on the same commit
 * produces the same manifest. Falls back to now outside a git checkout (a tarball build).
 */
function lastUpdated() {
  try {
    return execFileSync(
      "git",
      ["log", "-1", "--format=%cd", "--date=format:%Y-%m-%d %H:%M:%S", "--", "plugins/naulon"],
      { cwd: REPO, encoding: "utf8" },
    ).trim();
  } catch {
    return new Date().toISOString().slice(0, 19).replace("T", " ");
  }
}

export function build() {
  const php = read("naulon.php");
  const readme = read("readme.txt");

  const version = header(php, "Version");
  const updateUri = header(php, "Update URI");

  return {
    // Our own contract with the plugin, not a wordpress.org shape. Bumped only if a field's
    // MEANING changes; the plugin ignores keys it does not know, so additions are free.
    schema: "naulon-wp-update/1",
    name: header(php, "Plugin Name"),
    slug: "naulon",
    plugin: "naulon/naulon.php",
    version,
    // `url` is where "View details" points when the modal is unavailable; `homepage` is the
    // plugin's own page in the modal. Both come from the headers so they cannot contradict them.
    url: updateUri,
    homepage: header(php, "Plugin URI"),
    author: `<a href="${header(php, "Plugin URI")}">${header(php, "Author")}</a>`,
    requires: header(php, "Requires at least"),
    requires_php: header(php, "Requires PHP"),
    tested: readmeField(readme, "Tested up to"),
    last_updated: lastUpdated(),
    package: PACKAGE,
    upgrade_notice: upgradeNotice(readme, version),
    icons: {
      "1x": `${ART}/icon-128x128.png`,
      "2x": `${ART}/icon-256x256.png`,
      svg: `${ART}/icon.svg`,
    },
    banners: {
      low: `${ART}/banner-772x250.png`,
      high: `${ART}/banner-1544x500.png`,
    },
    sections: {
      description: toHtml(section(readme, "Description")),
      changelog: toHtml(section(readme, "Changelog")),
    },
  };
}

/**
 * Every way this manifest can be wrong while still being valid JSON. `--check` runs in CI on
 * every push, so a readme edit that silently empties a section fails there rather than shipping a
 * details modal with a blank changelog.
 */
function check(manifest) {
  const php = read("naulon.php");
  const readme = read("readme.txt");
  const problems = [];

  const require = (path, value) => {
    if (!value) problems.push(`${path} is empty`);
  };

  require("name", manifest.name);
  require("version", manifest.version);
  require("requires", manifest.requires);
  require("requires_php", manifest.requires_php);
  require("tested", manifest.tested);
  require("last_updated", manifest.last_updated);
  require("upgrade_notice", manifest.upgrade_notice);
  require("sections.description", manifest.sections.description);
  require("sections.changelog", manifest.sections.changelog);

  // The plugin's validator rejects a version it cannot compare and a package off the release
  // host. Asserting the same two things here means CI fails at the generator rather than leaving
  // a rejected manifest to look like "no update available" on every site.
  if (!/^\d+(\.\d+){0,3}(-[A-Za-z0-9.]+)?$/.test(manifest.version)) {
    problems.push(`version "${manifest.version}" is not comparable`);
  }
  if (!manifest.package.startsWith(`${RELEASES}/`)) {
    problems.push(`package "${manifest.package}" is not on the release host`);
  }

  // The constant registers the update filter; the header decides which filter core calls. Drift
  // between them is a silent no-update, so it is checked on both sides (see UpdaterTest).
  const constant = php.match(/define\(\s*'NAULON_UPDATE_URI',\s*'([^']+)'/);
  if (!constant || constant[1] !== manifest.url) {
    problems.push(`Update URI header (${manifest.url}) and NAULON_UPDATE_URI (${constant?.[1]}) disagree`);
  }

  if (readmeField(readme, "Stable tag") !== manifest.version) {
    problems.push(`readme Stable tag (${readmeField(readme, "Stable tag")}) is not ${manifest.version}`);
  }
  if (!manifest.sections.changelog.includes(`<h4>${manifest.version}</h4>`)) {
    problems.push(`changelog has no entry for ${manifest.version}`);
  }

  if (problems.length) {
    console.error(`wp-update-manifest: ${problems.length} problem(s)`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.error(`wp-update-manifest: ok — ${manifest.name} ${manifest.version}`);
}

const manifest = build();
const out = process.argv.find((a) => a.startsWith("--out="));

if (process.argv.includes("--check")) {
  check(manifest);
} else if (out) {
  writeFileSync(out.slice("--out=".length), `${JSON.stringify(manifest, null, 2)}\n`);
} else {
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

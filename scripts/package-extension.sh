#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXTENSION_DIR="$ROOT_DIR/extension"
OUTPUT_DIR="$ROOT_DIR/outputs"
VERSION="$(node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(m.version)' "$EXTENSION_DIR/manifest.json")"
TARGET="$OUTPUT_DIR/AutoFlow-Studio-v${VERSION}.zip"

mkdir -p "$OUTPUT_DIR"
rm -f "$TARGET"
(
  cd "$EXTENSION_DIR"
  zip -qr "$TARGET" . -x '*.DS_Store'
)

node - "$TARGET" "$EXTENSION_DIR/manifest.json" <<'NODE'
const fs = require("fs");
const { execFileSync } = require("child_process");
const [archive, manifestPath] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const listed = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" })
  .trim().split(/\r?\n/).filter(Boolean).sort();
const required = ["manifest.json", "shared.js", "content.js", "service-worker.js", "panel.html", "panel.css", "panel.js", "icons/icon16.png", "icons/icon32.png", "icons/icon48.png", "icons/icon128.png"];
for (const file of required) {
  if (!listed.includes(file)) throw new Error(`打包缺少 ${file}`);
}
const packagedManifest = JSON.parse(execFileSync("unzip", ["-p", archive, "manifest.json"], { encoding: "utf8" }));
if (packagedManifest.version !== manifest.version) throw new Error("ZIP 内外版本不一致");
if (packagedManifest.version !== "2.7.0") {
  // Version changes are intentional; this check only guards accidental empty values.
  if (!/^\d+\.\d+\.\d+$/.test(packagedManifest.version)) throw new Error("manifest 版本格式无效");
}
console.log(`已生成 ${archive}（${listed.length} 个文件，版本 ${packagedManifest.version}）`);
NODE

const fs = require("node:fs");
const path = require("node:path");

// These signatures identify the three decoded "使用声明" payloads found in
// released APKs, including their encoded form that a text search cannot see.
const signatures = [
    /20351\s*,\s*9641\s*,\s*-7224\s*,\s*3358/,
    /20166\s*,\s*37011\s*,\s*30757\s*,\s*25169/,
    /20344\s*,\s*29966\s*,\s*22709\s*,\s*26218/,
    /offline_push_revamp_notice_2026_08_v1/,
];
let scanned = 0;
const matches = [];
function scan(directory) {
    if (!fs.statSync(directory).isDirectory()) throw new Error(`Missing build directory: ${directory}`);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) scan(file);
        else if (file.endsWith(".js")) {
            scanned++;
            const source = fs.readFileSync(file, "utf8");
            if (signatures.some(pattern => pattern.test(source))) matches.push(file);
        }
    }
}
for (const directory of process.argv.slice(2).length ? process.argv.slice(2) : [".next/static"]) scan(directory);
if (!scanned) throw new Error("No compiled application scripts were checked");
if (matches.length) throw new Error(`Upstream popup remains in compiled application: ${matches.join(", ")}`);
console.log(`Checked ${scanned} compiled scripts: no known upstream popup payloads`);

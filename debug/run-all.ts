/**
 * Run all regime diagnostics in sequence.
 */
import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const scripts = [
  "01-regime-token-coverage.ts", // gitleaks:allow -- diagnostic filename, not a credential
  "02-regime-attribution.ts",
  "03-regime-timeline-density.ts",
  "04-regime-strategy-coverage.ts",
  "05-regime-config-check.ts",
  "06-markov-proof.ts"
];

console.log(`\n${"═".repeat(80)}`);
console.log("REGIME DIAGNOSTIC SUITE");
console.log(`${"═".repeat(80)}`);
console.log(`\nRunning ${scripts.length} diagnostics...\n`);

const results: Array<{ script: string; success: boolean }> = [];

for (const script of scripts) {
  console.log(`\n${"▓".repeat(80)}`);
  console.log(`Running: ${script}`);
  console.log(`${"▓".repeat(80)}`);

  try {
    execSync(`npx tsx ${path.join(__dirname, script)}`, {
      encoding: "utf-8",
      cwd: path.join(__dirname, ".."),
      stdio: "inherit"
    });
    results.push({ script, success: true });
  } catch (error) {
    results.push({ script, success: false });
  }
}

console.log(`\n${"═".repeat(80)}`);
console.log("SUMMARY");
console.log(`${"═".repeat(80)}`);

let passed = 0;
let failed = 0;
for (const r of results) {
  if (r.success) {
    console.log(`✅ ${r.script}`);
    passed++;
  } else {
    console.log(`❌ ${r.script}`);
    failed++;
  }
}

console.log(`\n${"─".repeat(40)}`);
console.log(`Passed: ${passed}/${results.length}`);
console.log(`Failed: ${failed}/${results.length}`);
console.log(`${"─".repeat(40)}\n`);

#!/usr/bin/env tsx
import { renderDoctorText, runDoctor, parseDoctorArgs } from "./lib/doctor.js";
import { stableJsonStringify } from "./lib/io.js";

function main(): void {
  const args = parseDoctorArgs();
  const result = runDoctor(args);

  if (args.json) {
    process.stdout.write(stableJsonStringify(result) + "\n");
  } else {
    process.stdout.write(renderDoctorText(result) + "\n");
  }

  if (result.overallVerdict === "fail") {
    process.exitCode = 1;
  }
}

main();


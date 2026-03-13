#!/usr/bin/env node

import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";
const pnpmBin = isWindows ? "pnpm.cmd" : "pnpm";
const nodeBin = process.execPath;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(`${command} ${args.join(" ")} exited with ${code ?? "null"}${signal ? ` (signal=${signal})` : ""}`),
      );
    });
  });
}

let exitCode = 0;

try {
  await run(nodeBin, ["scripts/prepare-e2e-runtime.mjs"]);
  await run(pnpmBin, ["exec", "playwright", "test", "--config", "playwright.config.ts", ...process.argv.slice(2)]);
} catch (error) {
  exitCode = 1;
  console.error(String(error));
} finally {
  try {
    await run(nodeBin, ["scripts/prepare-e2e-runtime.mjs"]);
  } catch (error) {
    exitCode = 1;
    console.error(String(error));
  }
}

process.exit(exitCode);

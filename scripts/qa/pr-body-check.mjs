#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const TEMPLATE_PATH = path.resolve(".github", "pull_request_template.md");

function parseArgs(argv) {
  const args = [...argv];
  const result = {
    file: "",
    eventPath: process.env.GITHUB_EVENT_PATH || "",
    eventName: process.env.GITHUB_EVENT_NAME || "",
    baseRef: process.env.GITHUB_BASE_REF || "",
    mode: "file",
  };

  while (args.length > 0) {
    const token = args.shift();
    if (token === "--file" && args[0]) {
      result.file = args.shift();
      result.mode = "file";
      continue;
    }
    if (token === "--ci") {
      result.mode = "ci";
      continue;
    }
    if (token === "--event-path" && args[0]) {
      result.eventPath = args.shift();
      result.mode = "ci";
      continue;
    }
    if (token === "--event-name" && args[0]) {
      result.eventName = args.shift();
      result.mode = "ci";
      continue;
    }
    if (token === "--base-ref" && args[0]) {
      result.baseRef = args.shift();
      continue;
    }
    if (token === "--help" || token === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return result;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/qa/pr-body-check.mjs --file <path>",
      "  node scripts/qa/pr-body-check.mjs --ci [--event-path <path>] [--event-name <name>] [--base-ref <branch>]",
      "",
    ].join("\n"),
  );
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function readTemplateHeadings(templateText) {
  return templateText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^##\s+/.test(line));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function headingPattern(heading) {
  return new RegExp(`^${escapeRegex(heading)}\\s*$`, "m");
}

function findHeadingPosition(body, heading) {
  const match = body.match(headingPattern(heading));
  return match?.index ?? -1;
}

function sectionContent(body, heading, headings) {
  const start = findHeadingPosition(body, heading);
  if (start < 0) return null;

  const startMatch = body.slice(start).match(headingPattern(heading));
  if (!startMatch) return null;

  const bodyStart = start + startMatch[0].length;
  const remaining = body.slice(bodyStart);
  const nextStarts = headings
    .filter((candidate) => candidate !== heading)
    .map((candidate) => {
      const match = remaining.match(new RegExp(`\\n${escapeRegex(candidate)}\\s*$`, "m"));
      return match?.index ?? -1;
    })
    .filter((index) => index >= 0);

  const end = nextStarts.length > 0 ? bodyStart + Math.min(...nextStarts) : body.length;
  return body.slice(bodyStart, end).trim();
}

function listCheckboxLines(sectionText) {
  return sectionText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^- \[[ xX]\]\s+/.test(line));
}

function stripComments(sectionText) {
  return sectionText.replace(/<!--[\s\S]*?-->/g, "").trim();
}

function loadCiPayload(eventPath) {
  if (!eventPath) return null;
  if (!fs.existsSync(eventPath)) return null;
  try {
    return JSON.parse(readText(eventPath));
  } catch {
    return null;
  }
}

function resolveBodyFromCi({ eventPath, eventName, baseRef }) {
  if (eventName && eventName !== "pull_request") {
    return { skipped: true, reason: `event '${eventName}' has no pull request body` };
  }

  const payload = loadCiPayload(eventPath);
  const pr = payload?.pull_request;
  if (!pr || typeof pr.body !== "string") {
    return { skipped: true, reason: "pull_request payload/body not found" };
  }

  const resolvedBaseRef =
    (typeof pr.base?.ref === "string" && pr.base.ref.trim()) || (typeof baseRef === "string" ? baseRef.trim() : "");

  return {
    skipped: false,
    body: pr.body,
    baseRef: resolvedBaseRef,
  };
}

function validatePrBody({ body, baseRef, headings }) {
  const errors = [];
  const positions = [];

  for (const heading of headings) {
    const position = findHeadingPosition(body, heading);
    if (position < 0) {
      errors.push(`Missing required section: ${heading}`);
      continue;
    }
    positions.push({ heading, position });
  }

  for (let index = 1; index < positions.length; index += 1) {
    if (positions[index - 1].position > positions[index].position) {
      errors.push("Sections are out of order compared to .github/pull_request_template.md");
      break;
    }
  }

  if (/<!--[\s\S]*?-->/.test(body)) {
    errors.push("PR body still contains template placeholder comments.");
  }

  const relatedIssue = sectionContent(body, "## Related Issue", headings);
  if (relatedIssue !== null && !stripComments(relatedIssue)) {
    errors.push("Section must not be empty: ## Related Issue");
  }

  const checklist = sectionContent(body, "## Checklist", headings);
  if (checklist !== null && listCheckboxLines(checklist).length === 0) {
    errors.push("Section must include at least one checkbox item: ## Checklist");
  }

  if ((baseRef || "").trim() === "main") {
    const hotfix = sectionContent(body, "## Hotfix Rationale (required only when base is `main`)", headings);
    if (hotfix !== null && !stripComments(hotfix)) {
      errors.push("Hotfix rationale is required when the base branch is main.");
    }
  }

  return errors;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const templateText = readText(TEMPLATE_PATH);
  const headings = readTemplateHeadings(templateText);
  if (headings.length === 0) {
    throw new Error(`No required headings found in ${TEMPLATE_PATH}`);
  }

  if (args.mode === "ci") {
    const ciInput = resolveBodyFromCi(args);
    if (ciInput.skipped) {
      process.stdout.write(`[pr-body-check] skipped: ${ciInput.reason}\n`);
      return;
    }

    const errors = validatePrBody({
      body: ciInput.body,
      baseRef: ciInput.baseRef,
      headings,
    });

    if (errors.length > 0) {
      process.stderr.write("[pr-body-check] validation failed:\n");
      for (const error of errors) {
        process.stderr.write(`- ${error}\n`);
      }
      process.exit(1);
    }

    process.stdout.write("[pr-body-check] PR body format OK\n");
    return;
  }

  if (!args.file) {
    throw new Error("Missing required argument: --file <path>");
  }

  const filePath = path.resolve(args.file);
  const body = readText(filePath);
  const errors = validatePrBody({
    body,
    baseRef: args.baseRef,
    headings,
  });

  if (errors.length > 0) {
    process.stderr.write("[pr-body-check] validation failed:\n");
    for (const error of errors) {
      process.stderr.write(`- ${error}\n`);
    }
    process.exit(1);
  }

  process.stdout.write("[pr-body-check] PR body format OK\n");
}

main();

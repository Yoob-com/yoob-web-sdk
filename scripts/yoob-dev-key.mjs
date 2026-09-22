#!/usr/bin/env node
// Gets a Yoob sandbox API key for SDK contributors: members of the Yoob-com GitHub organization.
//
//   node scripts/yoob-dev-key.mjs
//
// Proves membership with your own GitHub token (from `gh auth token`, or GITHUB_TOKEN), asks api2.yoob.com for a
// sandbox key (free 5-minute sessions, an hour a day) and saves it to ~/.config/yoob/contributor.key, readable only
// by you. The example token server reads it from there, so nothing secret ever sits in this repository. Running this
// again replaces the key.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const api = process.env.YOOB_API_BASE ?? "https://api2.yoob.com";
const out = path.join(os.homedir(), ".config", "yoob", "contributor.key");
let token = process.env.GITHUB_TOKEN;
if (!token) {
  try { token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim(); }
  catch { console.error("Sign in to GitHub first: `gh auth login` (or set GITHUB_TOKEN)."); process.exit(1); }
}
const response = await fetch(`${api}/api/v1/dev/contributor-key`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
const body = await response.json().catch(() => ({}));
if (response.status !== 201 || typeof body.api_key !== "string") {
  console.error(`No key (HTTP ${response.status}): ${body.error ?? "unexpected response"}`);
  if (body.code === "not_a_member") console.error("Ask an owner of github.com/Yoob-com to add you, then run this again.");
  process.exit(1);
}
fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
fs.writeFileSync(out, body.api_key + "\n", { mode: 0o600 });
fs.chmodSync(out, 0o600);
console.log(`Sandbox key for @${body.login} saved to ${out} (${body.api_key.slice(0, 14)}…).`);
console.log("Start the example backend with: npm run token-server, then npm run demo");

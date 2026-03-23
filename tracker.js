#!/usr/bin/env node

/**
 * YC Startup Tracker — v2
 *
 * What's new vs v1:
 *   [1] Resilience   — retry logic, per-company fault isolation, graceful degradation
 *   [2] Prompting    — structured, anti-buzzword, intentional prompt engineering
 *   [3] Data layer   — snapshot stores timestamps + batch metadata, not just slugs
 *   [4] Email design — hot-space tags, notable-founder highlights, delightful layout
 *   [5] CLI flags    — --dry-run (console only), --force (re-send even if nothing new)
 *
 * Run manually:  node tracker.js
 * Dry run:       node tracker.js --dry-run
 * Force send:    node tracker.js --force
 * Cron (9am):    0 9 * * * cd /path/to/yc-tracker && npm start >> tracker.log 2>&1
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── CLI FLAGS ────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run"); // print to console, skip email
const FORCE   = args.includes("--force");   // send even if no new companies (tests last 5)

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  gmail: {
    user:        process.env.GMAIL_USER,
    appPassword: process.env.GMAIL_APP_PASSWORD,
  },
  recipient:       process.env.NOTIFY_EMAIL || process.env.GMAIL_USER,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  snapshotFile:    path.join(__dirname, "seen_companies.json"),
  apiUrl:          "https://yc-oss.github.io/api/companies/all.json",
  maxEnrich:       30,    // cap per-run to keep latency reasonable
  retryAttempts:   3,     // how many times to retry a failed fetch
  retryDelayMs:    1200,  // base delay between retries (multiplied by attempt #)
};

// Parse YC batch string (e.g. "Winter 2025", "S24") into a sortable number
function batchScore(b) {
  if (!b) return 0;
  // "Winter 2025" / "Summer 2024" / "Fall 2023" format
  const long = b.match(/^(Winter|Summer|Fall)\s+(\d{4})$/i);
  if (long) {
    const year = parseInt(long[2], 10);
    const season = long[1][0].toUpperCase() === "W" ? 1 : long[1][0].toUpperCase() === "S" ? 2 : 3;
    return year * 10 + season;
  }
  // "W25" / "S24" short format
  const short = b.match(/^([SWF])(\d{2,4})$/i);
  if (short) {
    const year = parseInt(short[2].length === 2 ? `20${short[2]}` : short[2], 10);
    const season = short[1].toUpperCase() === "W" ? 1 : short[1].toUpperCase() === "S" ? 2 : 3;
    return year * 10 + season;
  }
  return 0;
}

// Tags/spaces that earn a hot badge in the email
const HOT_SPACES = new Set([
  "ai", "artificial intelligence", "machine learning", "ml",
  "healthcare", "health", "biotech", "climate", "developer tools",
  "devtools", "security", "fintech", "defense",
]);

// Employer names that trigger a ⭐ highlight on founder pills
const NOTABLE_EMPLOYERS = new Set([
  "google", "meta", "apple", "amazon", "microsoft", "openai", "anthropic",
  "stripe", "airbnb", "uber", "palantir", "spacex", "deepmind",
  "stanford", "mit", "harvard", "caltech",
]);

// ─── LOGGER ──────────────────────────────────────────────────────────────────
const ts    = () => new Date().toISOString();
const log   = {
  info:  (...a) => console.log( `[${ts()}] INFO  `, ...a),
  warn:  (...a) => console.warn( `[${ts()}] WARN  `, ...a),
  error: (...a) => console.error(`[${ts()}] ERROR `, ...a),
  ok:    (...a) => console.log( `[${ts()}] OK    `, ...a),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── [1] RESILIENCE: fetch with exponential-backoff retry ────────────────────
async function fetchWithRetry(url, label = url) {
  let lastErr;
  for (let attempt = 1; attempt <= CONFIG.retryAttempts; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      const delay = CONFIG.retryDelayMs * attempt;
      log.warn(`${label} — attempt ${attempt}/${CONFIG.retryAttempts} failed: ${err.message}. Retrying in ${delay}ms...`);
      if (attempt < CONFIG.retryAttempts) await sleep(delay);
    }
  }
  log.error(`${label} — all ${CONFIG.retryAttempts} attempts failed. Returning null.`);
  return null;
}

// ─── YC API ──────────────────────────────────────────────────────────────────
async function fetchYCCompanies() {
  const data = await fetchWithRetry(CONFIG.apiUrl, "YC companies API");
  if (!data) throw new Error("YC API unavailable after all retries — aborting run.");
  return data;
}

// Per-company detail (has long_description + founders[]). Returns null on failure.
async function fetchCompanyDetail(company) {
  if (!company.api) return null;
  return fetchWithRetry(company.api, company.name);
}

// ─── [2] PROMPTING: structured, intentional, anti-buzzword ───────────────────
function buildSummaryPrompt(company, detail) {
  const longDesc = (detail?.long_description || company.long_description || "").slice(0, 1200);
  const founders = detail?.founders || [];

  const founderLines = founders.map((f) => {
    const name = [f.first_name, f.last_name].filter(Boolean).join(" ");
    const role = f.title || "";
    const bio  = (f.bio  || "").slice(0, 200);
    return `- ${name}${role ? ` (${role})` : ""}${bio ? `: ${bio}` : ""}`;
  }).join("\n");

  return `
You are writing a 2-sentence entry for a daily YC startup digest. The reader is a technical founder who values precision and hates hype.

COMPANY DATA:
Name: ${company.name}
One-liner: ${company.one_liner || "(none)"}
Description: ${longDesc || "(none)"}
${founderLines ? `Founders:\n${founderLines}` : "Founders: (unknown)"}

YOUR TASK — write exactly 2 sentences, nothing more:
  Sentence 1 — WHAT: Explain in plain English what the product does and who uses it. Be concrete. Mention the actual mechanism if space allows (e.g. "connects X to Y via Z", "automates W by doing V").
  Sentence 2 — WHO: Name the founders. If their background is available, surface the single most relevant detail in under 8 words (e.g. "ex-Stripe infra lead", "Stanford ML PhD"). If no background is known, say "Background unknown."

RULES — violating any is a failure:
  - Banned words: revolutionary, innovative, game-changing, cutting-edge, leverages, utilizes, harnesses, transformative, disruptive, reimagines, pioneering, seamlessly, robust, scalable, ecosystem
  - No em-dashes (— or --)
  - Do not open either sentence with the company name
  - No bullet points, no headers, no preamble, no sign-off
  - Output ONLY the 2 sentences
`.trim();
}

async function generateSummary(company, detail) {
  if (!CONFIG.anthropicApiKey) return null;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         CONFIG.anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 220,
        messages:   [{ role: "user", content: buildSummaryPrompt(company, detail) }],
      }),
    });

    if (res.status === 429) {
      log.warn(`${company.name} — Claude rate limited. Using fallback.`);
      return null;
    }
    if (!res.ok) {
      log.warn(`${company.name} — Claude HTTP ${res.status}. Using fallback.`);
      return null;
    }

    const data = await res.json();
    return data?.content?.[0]?.text?.trim() || null;

  } catch (err) {
    log.warn(`${company.name} — Claude call failed (${err.message}). Using fallback.`);
    return null;
  }
}

// ─── ENRICHMENT PIPELINE ─────────────────────────────────────────────────────
// Each company is enriched independently. A failure on one never blocks the rest.
async function enrichCompanies(companies) {
  const enriched  = [];
  const toEnrich  = companies.slice(0, CONFIG.maxEnrich);

  for (const c of toEnrich) {
    process.stdout.write(`  ${c.name}... `);
    try {
      const detail  = await fetchCompanyDetail(c);
      const summary = await generateSummary(c, detail);
      enriched.push({ ...c, detail, summary, founders: detail?.founders || [] });
      process.stdout.write("✓\n");
    } catch (err) {
      // Belt-and-suspenders: catch anything unexpected, log, continue
      log.warn(`Unexpected error enriching ${c.name}: ${err.message}`);
      enriched.push({ ...c, detail: null, summary: null, founders: [] });
    }
    await sleep(300);
  }

  // Companies beyond maxEnrich get basic info only
  for (const c of companies.slice(CONFIG.maxEnrich)) {
    enriched.push({ ...c, detail: null, summary: null, founders: [] });
  }

  return enriched;
}

// ─── [3] DATA LAYER: timestamped snapshot ────────────────────────────────────
// Schema: { slugs: { [id]: { firstSeen: ISO, batch: string } }, lastRun: ISO }

function loadSnapshot() {
  if (!fs.existsSync(CONFIG.snapshotFile)) return { slugs: {}, lastRun: null };
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG.snapshotFile, "utf8"));
    // Backwards-compat: old format was a plain array of ids
    if (Array.isArray(raw)) {
      const slugs = {};
      for (const id of raw) slugs[id] = { firstSeen: null, batch: null };
      return { slugs, lastRun: null };
    }
    return raw;
  } catch (err) {
    log.warn(`Snapshot read failed (${err.message}). Starting fresh.`);
    return { slugs: {}, lastRun: null };
  }
}

function saveSnapshot(snapshot) {
  // Atomic write via temp file — avoids corruption if process is killed mid-write
  const tmp = CONFIG.snapshotFile + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
  fs.renameSync(tmp, CONFIG.snapshotFile);
}

// ─── [4] EMAIL ────────────────────────────────────────────────────────────────

function isHotSpace(c) {
  const haystack = [
    ...(c.tags || []),
    ...(c.industries || []),
    c.industry || "",
  ].map((s) => s.toLowerCase());
  return haystack.some((s) => HOT_SPACES.has(s));
}

function isNotableFounder(f) {
  const bio = (f.bio || "").toLowerCase();
  return [...NOTABLE_EMPLOYERS].some((emp) => bio.includes(emp));
}

function buildFounderPill(f) {
  const name    = [f.first_name, f.last_name].filter(Boolean).join(" ");
  const notable = isNotableFounder(f);
  const label   = notable ? `${name} *` : name;
  const inner   = f.linkedin_url
    ? `<a href="${f.linkedin_url}" style="color:inherit;text-decoration:none;">${label}</a>`
    : label;
  return `<span style="display:inline-block;background:${notable ? "#fff7ed" : "#f6f6f6"};border:1px solid ${notable ? "#f26522" : "#e2e2e2"};border-radius:20px;padding:4px 12px;font-size:12px;color:${notable ? "#c2410c" : "#3c3c3c"};margin:2px 4px 2px 0;font-family:'Inter','Helvetica Neue',Helvetica,Arial,sans-serif;">${inner}</span>`;
}

function buildCard(c) {
  const hot      = isHotSpace(c);
  const batch    = c.batch || "Unknown batch";
  const tags     = (c.tags || []).slice(0, 3);
  const hotBadge = hot ? `<span style="display:inline-block;background:#fff7ed;border:1px solid #fed7aa;border-radius:20px;padding:2px 8px;font-size:10px;color:#c2410c;margin-left:8px;font-family:'Inter','Helvetica Neue',Helvetica,Arial,sans-serif;font-weight:500;">Hot Space</span>` : "";

  const tagPills = tags.map(t =>
    `<span style="display:inline-block;background:#f6f6f6;border-radius:20px;padding:2px 10px;font-size:11px;color:#6b6b6b;margin:2px 4px 2px 0;font-family:'Inter','Helvetica Neue',Helvetica,Arial,sans-serif;">${t}</span>`
  ).join("");

  const website  = c.website
    ? `<a href="${c.website}" style="color:#f26522;text-decoration:none;font-size:13px;font-family:'Inter','Helvetica Neue',Helvetica,Arial,sans-serif;font-weight:500;">${c.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}</a>`
    : "";
  const ycLink   = `<a href="${c.url}" style="color:#6b6b6b;text-decoration:none;font-size:13px;font-family:'Inter','Helvetica Neue',Helvetica,Arial,sans-serif;">YC Profile</a>`;

  const founderPills = c.founders?.length
    ? c.founders.map(buildFounderPill).join("")
    : "";

  const summaryText = c.summary
    || (c.detail?.long_description ? c.detail.long_description.slice(0, 280) + "..." : null)
    || c.one_liner
    || "No description available.";
  const summaryLabel = c.summary ? "AI SUMMARY" : "DESCRIPTION";

  return `
<div style="border:1px solid #e5e5e5;border-radius:8px;margin-bottom:16px;overflow:hidden;background:#ffffff;">

  <div style="padding:20px 24px 16px;">
    <div>
      <span style="font-family:'Inter','Helvetica Neue',Helvetica,Arial,sans-serif;font-size:18px;font-weight:600;color:#0a0a0a;">${c.name}</span>${hotBadge}
      <span style="font-size:12px;color:#9a9a9a;margin-left:10px;font-family:'Inter','Helvetica Neue',Helvetica,Arial,sans-serif;font-weight:400;">${batch}</span>
    </div>
    <div style="font-size:14px;color:#6b6b6b;font-family:'Inter','Helvetica Neue',Helvetica,Arial,sans-serif;margin-top:6px;line-height:1.5;">${c.one_liner || ""}</div>
    ${tagPills ? `<div style="margin-top:10px;">${tagPills}</div>` : ""}
  </div>

  <div style="padding:0 24px 16px;">
    <div style="font-size:11px;letter-spacing:1.5px;color:#f26522;font-family:'Inter','Helvetica Neue',Helvetica,Arial,sans-serif;text-transform:uppercase;font-weight:600;margin-bottom:8px;">${summaryLabel}</div>
    <div style="font-size:14px;color:#3c3c3c;font-family:'Inter','Helvetica Neue',Helvetica,Arial,sans-serif;line-height:1.7;">${summaryText}</div>
  </div>

  ${founderPills ? `
  <div style="padding:0 24px 16px;">
    <div style="font-size:11px;letter-spacing:1.5px;color:#f26522;font-family:'Inter','Helvetica Neue',Helvetica,Arial,sans-serif;text-transform:uppercase;font-weight:600;margin-bottom:8px;">FOUNDERS</div>
    <div>${founderPills}</div>
  </div>` : ""}

  <div style="padding:12px 24px 16px;border-top:1px solid #f0f0f0;display:flex;gap:20px;align-items:center;">
    ${website}
    ${ycLink}
  </div>

</div>`;
}

function buildEmailHTML(companies, snapshot, isDigest = false) {
  const today   = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  const lastRun = snapshot.lastRun
    ? `Last checked ${new Date(snapshot.lastRun).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
    : "First notification";
  const hotCount = companies.filter(isHotSpace).length;
  const hotLine  = hotCount > 0
    ? `<span style="color:#f26522;font-weight:600;">${hotCount} in hot spaces</span>&nbsp;&nbsp;&middot;&nbsp;&nbsp;`
    : "";

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background:#f7f7f7;">
<div style="max-width:640px;margin:0 auto;padding:40px 16px 48px;">

  <div style="margin-bottom:32px;">
    <div style="font-family:'Inter','Helvetica Neue',Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:2px;color:#f26522;text-transform:uppercase;font-weight:600;margin-bottom:12px;">YC Tracker &middot; ${today}</div>
    <div style="font-family:'Inter','Helvetica Neue',Helvetica,Arial,sans-serif;font-size:28px;color:#0a0a0a;font-weight:700;line-height:1.3;">
      ${isDigest
        ? `${companies.length} recent startup${companies.length !== 1 ? "s" : ""} worth watching`
        : `${companies.length} new startup${companies.length !== 1 ? "s" : ""} just landed on YC`}
    </div>
    <div style="font-family:'Inter','Helvetica Neue',Helvetica,Arial,sans-serif;font-size:13px;color:#9a9a9a;margin-top:8px;">
      ${hotLine}${lastRun}
    </div>
  </div>

  <div style="height:2px;background:linear-gradient(to right,#f26522,#fed7aa);border-radius:2px;margin-bottom:28px;"></div>

  ${companies.map(buildCard).join("")}

  <div style="margin-top:12px;padding:16px 20px;background:#ffffff;border:1px solid #e5e5e5;border-radius:8px;font-family:'Inter','Helvetica Neue',Helvetica,Arial,sans-serif;font-size:12px;color:#9a9a9a;line-height:2;">
    <span style="color:#f26522;font-weight:600;">Hot Space</span> = AI / Healthcare / Climate / DevTools&nbsp;&nbsp;&middot;&nbsp;&nbsp;<span style="font-weight:500;">*</span> = Notable founder (ex-FAANG, top research lab, or top university)
  </div>

  <div style="margin-top:24px;font-family:'Inter','Helvetica Neue',Helvetica,Arial,sans-serif;font-size:11px;color:#c0c0c0;text-align:center;letter-spacing:0.5px;">
    Data from yc-oss.github.io/api&nbsp;&nbsp;&middot;&nbsp;&nbsp;Summaries by Claude&nbsp;&nbsp;&middot;&nbsp;&nbsp;Updates daily
  </div>

</div>
</body>
</html>`;
}

// ─── DRY RUN OUTPUT ───────────────────────────────────────────────────────────
function printDryRun(companies) {
  console.log("\n" + "─".repeat(60));
  console.log(`DRY RUN — ${companies.length} companies (no email sent)`);
  console.log("─".repeat(60));
  for (const c of companies) {
    const hot      = isHotSpace(c) ? " 🔥" : "";
    const notable  = c.founders?.some(isNotableFounder) ? " ⭐" : "";
    const names    = c.founders?.map((f) => [f.first_name, f.last_name].filter(Boolean).join(" ")).join(", ") || "(unknown)";
    console.log(`\n▶ ${c.name} [${c.batch || "?"}]${hot}${notable}`);
    console.log(`  ${c.one_liner || "(no one-liner)"}`);
    if (c.summary) console.log(`  SUMMARY: ${c.summary}`);
    console.log(`  FOUNDERS: ${names}`);
    if (c.website) console.log(`  ${c.website}`);
  }
  console.log("\n" + "─".repeat(60) + "\n");
}

// ─── EMAIL SEND ───────────────────────────────────────────────────────────────
async function sendEmail(companies, snapshot, isDigest = false) {
  const { user, appPassword } = CONFIG.gmail;
  if (!user || !appPassword) {
    throw new Error("Missing Gmail credentials. Set GMAIL_USER and GMAIL_APP_PASSWORD in .env.");
  }
  const transporter = nodemailer.createTransport({ service: "gmail", auth: { user, pass: appPassword } });
  const plainText = companies.map(c => {
    const names = c.founders?.map(f => [f.first_name, f.last_name].filter(Boolean).join(" ")).join(", ") || "(unknown)";
    return `${c.name} [${c.batch || "?"}]\n${c.one_liner || ""}\n${c.summary || ""}\nFounders: ${names}\n${c.website || ""}`;
  }).join("\n\n");

  await transporter.sendMail({
    from:    `"YC Tracker" <${user}>`,
    to:      CONFIG.recipient,
    subject: isDigest
      ? `YC Digest - ${companies.length} recent startup${companies.length !== 1 ? "s" : ""} - ${new Date().toLocaleDateString()}`
      : `${companies.length} new YC startup${companies.length !== 1 ? "s" : ""} - ${new Date().toLocaleDateString()}`,
    text:    plainText,
    html:    buildEmailHTML(companies, snapshot, isDigest),
  });
  log.ok(`Email sent to ${CONFIG.recipient} (${companies.length} companies).`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  log.info(`YC Tracker v2 starting${DRY_RUN ? " [DRY RUN]" : ""}${FORCE ? " [FORCE]" : ""}...`);

  if (!CONFIG.anthropicApiKey) {
    log.warn("ANTHROPIC_API_KEY not set — summaries will fall back to raw descriptions.");
  }

  // [1] Fetch — throws only if YC API is completely down after all retries
  const companies = await fetchYCCompanies();
  log.info(`Fetched ${companies.length} companies from YC API.`);

  // [3] Load timestamped snapshot
  const snapshot   = loadSnapshot();
  const isFirstRun = Object.keys(snapshot.slugs).length === 0;
  const now        = new Date().toISOString();

  // Sort all companies by batch (newest first) for picking recents
  const byRecency = [...companies].sort((a, b) => batchScore(b.batch) - batchScore(a.batch));

  // Diff
  const trulyNew = companies.filter((c) => !snapshot.slugs[c.slug || c.name]);
  const newCompanies = trulyNew.length > 0
    ? trulyNew
    : byRecency.slice(0, 5); // no new ones — pick 5 most recent as a digest

  // Update snapshot before sending — so a mail failure won't cause double-sends
  const updatedSlugs = { ...snapshot.slugs };
  for (const c of companies) {
    const id = c.slug || c.name;
    if (!updatedSlugs[id]) {
      updatedSlugs[id] = { firstSeen: now, batch: c.batch || null };
    }
  }
  saveSnapshot({ slugs: updatedSlugs, lastRun: now });
  log.info(`Snapshot saved (${Object.keys(updatedSlugs).length} total companies tracked).`);

  if (isFirstRun && !FORCE) {
    log.info("First run — snapshot saved. Run again tomorrow to start receiving emails.");
    return;
  }

  const isDigest = trulyNew.length === 0;
  if (isDigest) log.info("No new companies — sending digest of recent startups.");

  // Enrich
  log.info(`Enriching ${Math.min(newCompanies.length, CONFIG.maxEnrich)} companies...`);
  const enriched = await enrichCompanies(newCompanies);
  const aiCount  = enriched.filter((c) => c.summary).length;
  log.info(`Done. AI summaries: ${aiCount}/${enriched.length}.`);

  // [5] Output
  if (DRY_RUN) {
    printDryRun(enriched);
  } else {
    await sendEmail(enriched, snapshot, isDigest);
  }
}

main().catch((err) => {
  log.error(err.message);
  process.exit(1);
});

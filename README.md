# YC Startup Tracker

Get emailed every time a new startup appears on the YC company directory — with an AI-generated summary of what they build and who's behind it.

Powered by the [yc-oss public API](https://github.com/yc-oss/api) (updates daily) and Claude (for summaries).

---

## What you get in each email

For every new company:
- **Name, batch, tags**
- **One-liner** from YC
- **AI summary** — 2 sentences: what it does (plain English) + who built it (founders + background)
- **Founder pills** — linked to their LinkedIn profiles when available
- **Links** — company website + YC profile

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create your `.env` file

```bash
cp .env.example .env
```

Open `.env` and fill in all three credentials.

### 3. Get a Gmail App Password

You need an **App Password**, not your real Gmail password.

1. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
2. Select **"Mail"** + **"Mac"** (or any device)
3. Copy the 16-character password into `.env` as `GMAIL_APP_PASSWORD`

> ⚠️ **2-Step Verification** must be enabled on your Google account first.

### 4. Get an Anthropic API key

1. Go to [console.anthropic.com](https://console.anthropic.com/)
2. Create an API key and paste it into `.env` as `ANTHROPIC_API_KEY`

The summaries use `claude-haiku` — extremely fast and cheap (fractions of a cent per company).

If you skip this, the email will fall back to raw descriptions from YC.

### 5. First run

```bash
npm start
```

The first run saves a snapshot of all ~5,000 existing YC companies and **does not send an email**. Every subsequent run emails you only the newly added ones.

### 6. Schedule daily runs with cron

```bash
crontab -e
```

Add this line to run every day at 9 AM:

```
0 9 * * * cd /path/to/yc-tracker && npm start >> tracker.log 2>&1
```

Replace `/path/to/yc-tracker` with your actual folder path.

---

## How it works

1. Fetches all companies from `https://yc-oss.github.io/api/companies/all.json`
2. Compares against `seen_companies.json` snapshot to find new entries
3. For each new company, fetches its individual profile (long description, founders)
4. Sends each company's data to Claude Haiku → 2-sentence plain-English summary
5. Builds a formatted email digest and sends via Gmail
6. Saves updated snapshot

---

## Files

| File | Purpose |
|------|---------|
| `tracker.js` | Main script |
| `.env` | Your credentials (never commit this) |
| `seen_companies.json` | Auto-generated snapshot (gitignore this) |
| `tracker.log` | Cron output log |

---

## .gitignore

Already included — `.env`, `seen_companies.json`, `tracker.log`, and `node_modules/` are all ignored.

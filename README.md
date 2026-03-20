YC Startup Tracker
I kept discovering YC companies randomly on LinkedIn and wanted a better way to stay on top of what's being built. This script polls the YC directory daily, detects new companies, summarizes them with Claude, and emails me a clean digest every morning. No algorithm, no noise, just signal.
What you get in each email
For every new company: name, batch, tags, a plain-English AI summary of what it does and who built it, founder names linked to LinkedIn, and links to the website and YC profile.
Tech stack
Node.js · Claude Haiku · GitHub Actions · Nodemailer · yc-oss public API
Why it's built the way it is
Retry logic on every API call. Per-company fault isolation so one failure never blocks the rest. Snapshot saved before email send to prevent duplicates. Structured prompt engineering to keep summaries jargon-free.
Setup

npm install
cp .env.example .env and fill in your Gmail App Password, Gmail address, and Anthropic API key
npm start — first run saves a snapshot, no email sent
Every run after that emails you only new companies

Deploy on GitHub Actions
Add your credentials as repo secrets and the included workflow runs automatically at 9am daily — no laptop required.

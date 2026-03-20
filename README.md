# YC Startup Tracker

I was constantly discovering YC startups by accident, through LinkedIn posts, retweets, and random rabbit holes.
There was no single place to just see what’s new, cleanly.
So I built one: a daily email with only new YC companies, no noise, no algorithm.This script polls the YC directory daily, detects new companies, summarizes them with Claude, and emails me a clean digest every morning. No algorithm, no noise, just signal.

## What you get in each email

For every new company: name, batch, tags, a plain-English AI summary of what it does and who built it, founder names linked to LinkedIn, and links to the website and YC profile.

## Tech stack

Node.js · Claude Haiku · GitHub Actions · Nodemailer · yc-oss public API

## Why it's built the way it is

- Retry logic on every API call
- Per-company fault isolation so one failure never blocks the rest
- Snapshot saved before email send to prevent duplicates
- Structured prompt engineering to keep summaries jargon-free

## Setup

1. `npm install`
2. `cp .env.example .env` and fill in your Gmail App Password, Gmail address, and Anthropic API key
3. `npm start` — first run saves a snapshot, no email sent
4. Every run after that emails you only new companies

## Deploy on GitHub Actions

Add your credentials as repo secrets and the included workflow runs automatically at 9am daily — no laptop required.

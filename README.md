# Cloudflare Browser Rendering Telegram Bot

A high-performance, edge-native Telegram bot built on Cloudflare Workers that interfaces directly with the **Cloudflare Browser Rendering API**. This bot allows users to initiate, configure, and monitor web crawls directly from Telegram, leveraging Cloudflare's infrastructure to extract Markdown, HTML, and JSON from targeted web properties.

Built strictly for the `workerd` V8 isolate runtime, it utilizes Cloudflare KV for state management and user configurations, and Cloudflare R2 for robust artifact storage and delivery.

## 🚀 Features

* **Serverless Edge Architecture:** Runs entirely on Cloudflare Workers with zero Node.js server dependencies.
* **Telegram Webhook Integration:** Instant, event-driven message handling via Telegram's Webhook API.
* **Interactive Configuration:** Real-time settings management using Telegram Inline Keyboards. Configure:
  * Crawl Limit (10, 50, 100, 500)
  * Click Depth (1, 2, 5, 10)
  * Headless Browser Rendering (ON/OFF)
  * Output Formats (HTML, Markdown, JSON)
  * External Links & Subdomain Inclusion
* **Asynchronous Job Polling:** Uses background tasks to check job status via `/status` and compile multipart response data.
* **R2 Object Storage Integration:** Combines complex crawl results into a unified Markdown file, stored persistently in an R2 bucket, and delivered to Telegram as a native document to bypass message length limits.
* **Custom JSON Overrides:** Supports raw JSON payload injections for advanced scraping configurations.

## 🛠️ Prerequisites

* [Node.js](https://nodejs.org/) & `npm`
* A Cloudflare account with a Workers Paid plan (required for the Browser Rendering API).
* A Telegram Bot Token (obtained via [@BotFather](https://t.me/botfather)).
* Cloudflare Global API Key or scoped API Token with `Browser Rendering` permissions.

## 🏗️ Architecture & Resources

This project strictly utilizes Cloudflare native primitives:

* **Compute:** Cloudflare Workers (ESM, V8 Isolate)
* **Storage (State):** Cloudflare KV (`CRAWL_KV`) - Stores user-specific chat settings and recent job IDs.
* **Storage (Artifacts):** Cloudflare R2 (`MY_BUCKET`) - Temporarily stores aggregated crawl results (`crawled_content_<jobId>.md`) before dispatching to Telegram.

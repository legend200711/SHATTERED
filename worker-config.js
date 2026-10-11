/**
 * worker-config.js — Cloudflare Worker API base URL for SHATTERED
 *
 * Set workerBaseUrl to the URL of your deployed Cloudflare Worker.
 *
 * Steps:
 *   1. Deploy the Worker:  wrangler deploy
 *   2. Copy the resulting URL (e.g. https://shattered-pwa.YOUR_SUBDOMAIN.workers.dev)
 *   3. Replace the placeholder below with that URL — no trailing slash.
 *
 * If you are using Cloudflare Pages with a Worker bound to it (same project),
 * the Worker URL is the same as your Pages URL:
 *   e.g. https://shattered.pages.dev
 *
 * For local development:  http://localhost:8787
 */
export const workerConfig = {
  workerBaseUrl: "https://shattered-pwa.nthntjrn.workers.dev",
};

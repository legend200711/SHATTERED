// Minimal passthrough Worker — all requests are served from the
// static assets binding. This file is required by wrangler when
// "main" is set, but no custom request logic is needed for the PWA.
export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};

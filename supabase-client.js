"use strict";

(() => {
  const config = window.KANVAS_SUPABASE_CONFIG || {};
  const configured = typeof config.url === "string" && /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(config.url)
    && typeof config.anonKey === "string" && config.anonKey.length > 20;
  window.kanvasSupabase = {
    configured,
    client: configured && window.supabase?.createClient
      ? window.supabase.createClient(config.url, config.anonKey)
      : null,
    configurationError: configured && !window.supabase?.createClient
      ? "Supabase could not load. Check your internet connection and reload."
      : !configured ? "Add your Supabase project URL and public anon key to supabase-config.js first." : "",
  };
})();

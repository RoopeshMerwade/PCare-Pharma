const { createClient } = require('@supabase/supabase-js');
const config = require('./env'); // validates env at require time — fail fast

// Service key used ONLY on the backend — gives admin access, bypasses RLS
// NEVER send this to the frontend.
// IMPORTANT: never call .auth.signInWithPassword()/refreshSession()/updateUser()
// on this client. supabase-js stores the resulting session on the instance and
// sends that user's token on every later request, silently dropping service_role
// (queries then hit RLS) and leaking one request's identity into others.
// Use createAuthClient() for auth operations instead.
const supabase = createClient(
  config.supabase.url,
  config.supabase.serviceKey,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// Short-lived, per-request client for auth operations. Each call gets its own
// instance so a sign-in can never mutate shared state.
function createAuthClient() {
  return createClient(
    config.supabase.url,
    config.supabase.anonKey,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

module.exports = { supabase, createAuthClient };

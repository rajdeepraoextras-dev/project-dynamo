/* Project Dynamo — Supabase connection.
 *
 * NOTE ON SECURITY: this key is a *publishable* key and is visible to anyone who
 * opens this page. The dynamo_tasks table is deliberately open to the anon role,
 * so anyone who has this file can read and write every task. That is the setup
 * you asked for. If this page ever goes on the public internet, switch to
 * Supabase Auth and per-user RLS policies instead.
 */
window.DYNAMO_CONFIG = {
  supabaseUrl: 'https://enyesotijvpsymyyvthw.supabase.co',
  supabaseKey: 'sb_publishable_MGeIiu15d-yKpTu0SgkyzA_7dWbH3tp',
  table: 'dynamo_tasks'
};

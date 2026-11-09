import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const isSupabaseConfigured = Boolean(
  supabaseUrl
    && supabaseAnonKey
    && !supabaseUrl.includes('your-project-ref')
    && !supabaseAnonKey.includes('your-public-anon-key'),
)

export const supabase = createClient(
  supabaseUrl || 'https://missing-project.supabase.co',
  supabaseAnonKey || 'missing-anon-key',
  {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
  },
  },
)

let anonymousSessionPromise

export async function ensureAnonymousSession() {
  if (!isSupabaseConfigured) throw new Error('Configure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local.')
  const { data: { session } } = await supabase.auth.getSession()
  if (session) {
    if (session.access_token) await supabase.realtime.setAuth(session.access_token)
    return session
  }

  if (!anonymousSessionPromise) {
    anonymousSessionPromise = supabase.auth.signInAnonymously().then(({ data, error }) => {
      if (error) throw error
      return data.session
    }).finally(() => { anonymousSessionPromise = null })
  }
  const anonymousSession = await anonymousSessionPromise
  if (anonymousSession?.access_token) await supabase.realtime.setAuth(anonymousSession.access_token)
  return anonymousSession
}

export async function apiCall(action, data = {}) {
  const { data: result, error } = await supabase.functions.invoke('qroom-api', {
    body: { action, ...data },
  })

  if (error) {
    let message = error.message
    try {
      const details = await error.context?.json()
      if (details?.error) message = details.error
    } catch {
      // The function response was not JSON; keep the SDK error.
    }
    throw new Error(message || 'The Supabase API request failed.')
  }
  if (result?.ok === false) throw new Error(result.error || 'The Supabase API request failed.')
  return result
}

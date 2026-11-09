import { createClient } from 'npm:@supabase/supabase-js@2'
import { timingSafeEqual } from 'node:crypto'

const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('CORS_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const adminPin = Deno.env.get('ADMIN_PIN')!
const pinIndexSecret = Deno.env.get('PIN_INDEX_SECRET')!

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const publicClient = createClient(supabaseUrl, anonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

type Actor = { userId: string; role: 'admin' | 'moderator'; moderatorId: string | null; name: string }

function respond(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return error.message
  }
  return 'Unexpected API error.'
}

function equalSecret(actual: string, expected: string) {
  const left = new TextEncoder().encode(actual)
  const right = new TextEncoder().encode(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function randomPin() {
  const values = new Uint8Array(8)
  crypto.getRandomValues(values)
  let number = 0n
  for (const byte of values) number = (number << 8n) | BigInt(byte)
  number %= 1_000_000n
  return number.toString().padStart(6, '0')
}

async function pinDigest(pin: string) {
  if (pinIndexSecret.length < 32) throw new Error('PIN_INDEX_SECRET must be configured with at least 32 characters.')
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pinIndexSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(pin))
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('')
}

async function authenticatedUser(request: Request) {
  const authorization = request.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) throw new Error('Sign in before using this action.')
  const token = authorization.slice(7)
  const { data, error } = await publicClient.auth.getUser(token)
  if (error || !data.user) throw new Error('Your session is invalid or expired. Sign in again.')
  return { user: data.user, token }
}

async function getActor(userId: string): Promise<Actor | null> {
  const { data: session, error } = await admin
    .from('user_sessions')
    .select('role, moderator_id, expires_at')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  if (!session || new Date(session.expires_at).getTime() <= Date.now()) return null

  if (session.role === 'admin') {
    return { userId, role: 'admin', moderatorId: null, name: 'Admin' }
  }

  const { data: moderator, error: moderatorError } = await admin
    .from('moderators')
    .select('id, name, active')
    .eq('id', session.moderator_id)
    .maybeSingle()
  if (moderatorError) throw moderatorError
  if (!moderator?.active) return null
  return { userId, role: 'moderator', moderatorId: moderator.id, name: moderator.name }
}

async function requireActor(userId: string, allowed: Actor['role'][]): Promise<Actor> {
  const actor = await getActor(userId)
  if (!actor || !allowed.includes(actor.role)) throw new Error('You are not authorized for this action.')
  return actor
}

async function checkLoginRateLimit(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  const clientIp = request.headers.get('cf-connecting-ip') || forwarded || 'unknown'
  const fingerprint = await pinDigest(clientIp)
  const { data, error } = await admin.rpc('qroom_begin_pin_login', { p_fingerprint: fingerprint })
  if (error) throw error
  const result = Array.isArray(data) ? data[0] : data
  if (!result?.allowed) throw new Error(`Too many PIN attempts. Try again in ${result?.retry_after_seconds ?? 900} seconds.`)
  return fingerprint
}

async function loginAdmin(request: Request, data: Record<string, unknown>, userId: string) {
  const fingerprint = await checkLoginRateLimit(request)
  const pin = String(data.pin ?? '')
  if (!/^\d{6}$/.test(pin) || !adminPin || !equalSecret(pin, adminPin)) {
    await admin.rpc('qroom_record_pin_failure', { p_fingerprint: fingerprint })
    throw new Error('Invalid admin PIN.')
  }
  const { error } = await admin.from('user_sessions').upsert({
    user_id: userId,
    role: 'admin',
    moderator_id: null,
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  })
  if (error) throw error
  const { error: clearError } = await admin.rpc('qroom_clear_pin_failures', { p_fingerprint: fingerprint })
  if (clearError) throw clearError
  const { error: logError } = await admin.from('activity_logs').insert({ action: 'admin.login', actor_name: 'Admin' })
  if (logError) throw logError
  return { role: 'admin', name: 'Admin' }
}

async function loginModerator(request: Request, data: Record<string, unknown>, userId: string) {
  const fingerprint = await checkLoginRateLimit(request)
  const pin = String(data.pin ?? '')
  if (!/^\d{6}$/.test(pin)) {
    await admin.rpc('qroom_record_pin_failure', { p_fingerprint: fingerprint })
    throw new Error('PIN must contain exactly 6 digits.')
  }
  const digest = await pinDigest(pin)
  const { data: rows, error } = await admin.rpc('qroom_login_moderator', {
    p_user_id: userId,
    p_pin: pin,
    p_pin_digest: digest,
  })
  if (error) throw error
  const moderator = Array.isArray(rows) ? rows[0] : rows
  if (!moderator?.moderator_id) {
    await admin.rpc('qroom_record_pin_failure', { p_fingerprint: fingerprint })
    throw new Error('Invalid or inactive moderator PIN.')
  }
  const { error: clearError } = await admin.rpc('qroom_clear_pin_failures', { p_fingerprint: fingerprint })
  if (clearError) throw clearError
  return { role: 'moderator', name: moderator.moderator_name }
}

async function createModerator(data: Record<string, unknown>, actor: Actor) {
  const name = String(data.name ?? '').trim()
  if (!name || name.length > 80) throw new Error('Enter a moderator name between 1 and 80 characters.')
  const { data: existingModerators, error: lookupError } = await admin.from('moderators').select('name')
  if (lookupError) throw lookupError
  if ((existingModerators ?? []).some(moderator => moderator.name.trim().toLowerCase() === name.toLowerCase())) {
    throw new Error('A moderator with this name already exists.')
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const pin = randomPin()
    const digest = await pinDigest(pin)
    const { data: result, error } = await admin.rpc('qroom_create_moderator', {
      p_actor_id: actor.userId,
      p_name: name,
      p_pin: pin,
      p_pin_digest: digest,
    })
    if (!error) {
      const moderator = Array.isArray(result) ? result[0] : result
      return { id: moderator.id, name: moderator.name, pin }
    }
    const errorContext = `${error.message} ${error.details ?? ''} ${error.hint ?? ''}`
    if (errorContext.includes('moderators_name_unique_idx')) {
      throw new Error('A moderator with this name already exists.')
    }
    if (error.code !== '23505') throw error
  }
  throw new Error('Could not allocate a unique PIN. Please try again.')
}

async function updateModerator(data: Record<string, unknown>, actor: Actor) {
  const moderatorId = String(data.moderatorId ?? '')
  if (!moderatorId) throw new Error('Moderator ID is required.')
  if (!data.generatePin && typeof data.active !== 'boolean') {
    throw new Error('Specify whether the moderator should be active.')
  }
  let pin: string | null = null
  let digest: string | null = null
  if (data.generatePin) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      pin = randomPin()
      digest = await pinDigest(pin)
      const { data: result, error } = await admin.rpc('qroom_update_moderator', {
        p_actor_id: actor.userId,
        p_moderator_id: moderatorId,
        p_active: null,
        p_pin: pin,
        p_pin_digest: digest,
      })
      if (!error) {
        const moderator = Array.isArray(result) ? result[0] : result
        return { moderator, pin }
      }
      if (error.code !== '23505') throw error
    }
    throw new Error('Could not allocate a unique PIN. Please try again.')
  }

  const { data: result, error } = await admin.rpc('qroom_update_moderator', {
    p_actor_id: actor.userId,
    p_moderator_id: moderatorId,
    p_active: Boolean(data.active),
    p_pin: null,
    p_pin_digest: null,
  })
  if (error) throw error
  return { moderator: Array.isArray(result) ? result[0] : result, pin }
}

async function listAdminData() {
  const [moderatorsResult, logsResult] = await Promise.all([
    admin.from('moderators').select('id, name, active, created_at').order('created_at', { ascending: false }),
    admin.from('activity_logs').select('id, action, actor_name, moderator_name, question_id, created_at').order('created_at', { ascending: false }).limit(100),
  ])
  if (moderatorsResult.error) throw moderatorsResult.error
  if (logsResult.error) throw logsResult.error
  return {
    moderators: (moderatorsResult.data ?? []).map(moderator => ({ ...moderator, hasPin: true })),
    logs: (logsResult.data ?? []).map(log => ({ ...log, createdAt: log.created_at })),
  }
}

async function markQuestionAnswered(data: Record<string, unknown>, actor: Actor) {
  const { error } = await admin.rpc('qroom_mark_answered', {
    p_user_id: actor.userId,
    p_question_id: String(data.questionId ?? ''),
  })
  if (error) throw error
  return { success: true }
}

async function reopenQuestion(data: Record<string, unknown>, actor: Actor) {
  if (actor.role !== 'admin') throw new Error('Only admins can reopen questions.')
  const { error } = await admin.rpc('qroom_reopen_question', {
    p_user_id: actor.userId,
    p_question_id: String(data.questionId ?? ''),
  })
  if (error) throw error
  return { success: true }
}

async function handleAction(request: Request, action: string, data: Record<string, unknown>, userId: string) {
  if (action === 'loginAdmin') return loginAdmin(request, data, userId)
  if (action === 'loginModerator') return loginModerator(request, data, userId)
  if (action === 'logout') {
    const { error } = await admin.from('user_sessions').delete().eq('user_id', userId)
    if (error) throw error
    return { success: true }
  }
  if (action === 'getSession') {
    const actor = await getActor(userId)
    return actor ? { role: actor.role, name: actor.name } : { role: null, name: null }
  }

  if (action === 'createModerator') {
    const actor = await requireActor(userId, ['admin'])
    return createModerator(data, actor)
  }
  if (action === 'updateModerator') {
    const actor = await requireActor(userId, ['admin'])
    return updateModerator(data, actor)
  }
  if (action === 'deleteModerator') {
    const actor = await requireActor(userId, ['admin'])
    const moderatorId = String(data.moderatorId ?? '')
    if (!moderatorId) throw new Error('Moderator ID is required.')
    const { error } = await admin.rpc('qroom_delete_moderator', {
      p_actor_id: actor.userId,
      p_moderator_id: moderatorId,
    })
    if (error) throw error
    return { success: true }
  }
  if (action === 'deleteAllQuestions') {
    const actor = await requireActor(userId, ['admin'])
    const { data: deleted, error } = await admin.rpc('qroom_delete_all_questions', {
      p_actor_id: actor.userId,
    })
    if (error) throw error
    return { deleted }
  }
  if (action === 'updateAllModerators') {
    const actor = await requireActor(userId, ['admin'])
    if (typeof data.active !== 'boolean') throw new Error('Active status is required.')
    const { data: updated, error } = await admin.rpc('qroom_update_all_moderators', {
      p_actor_id: actor.userId,
      p_active: Boolean(data.active),
    })
    if (error) throw error
    return { updated }
  }
  if (action === 'listAdminData') {
    await requireActor(userId, ['admin'])
    return listAdminData()
  }
  if (action === 'markQuestionAnswered') {
    const actor = await requireActor(userId, ['admin', 'moderator'])
    return markQuestionAnswered(data, actor)
  }
  if (action === 'reopenQuestion') {
    const actor = await requireActor(userId, ['admin'])
    return reopenQuestion(data, actor)
  }
  throw new Error('Unknown API action.')
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return respond({ ok: false, error: 'Method not allowed.' }, 405)

  try {
    const { user } = await authenticatedUser(request)
    const body = await request.json()
    const result = await handleAction(request, String(body.action ?? ''), body, user.id)
    return respond({ ok: true, ...result })
  } catch (error) {
    console.error('qroom-api error:', error)
    return respond({ ok: false, error: getErrorMessage(error) }, 400)
  }
})

import { getMyProfile, updateMyProfile } from './profile'

export type StatsTeam = 'red' | 'blue'
export type StatsMember = {
  user_id: string
  team: StatsTeam | null
  role: 'owner' | 'player' | 'spectator'
}

export type PlayerStats = {
  games_played: number
  times_won: number
  times_lost: number
  teammate_counts: Record<string, number>
  teammate_names: Record<string, string>
  processed_game_ids: string[]
  updated_at: string
}

const STATS_KEY = 'player_stats_v1'
const MAX_PROCESSED_GAMES = 400

function toFiniteInt(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : 0
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.floor(n))
}

function toStringMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!k) continue
    const val = String(raw ?? '').trim()
    if (val) out[k] = val
  }
  return out
}

function toCountMap(v: unknown): Record<string, number> {
  if (!v || typeof v !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!k) continue
    const n = toFiniteInt(raw)
    if (n > 0) out[k] = n
  }
  return out
}

function toProcessedIds(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const raw of v) {
    const id = String(raw ?? '').trim()
    if (id && !out.includes(id)) out.push(id)
  }
  return out.slice(-MAX_PROCESSED_GAMES)
}

export function normalizePlayerStats(raw: unknown): PlayerStats {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    games_played: toFiniteInt(obj.games_played),
    times_won: toFiniteInt(obj.times_won),
    times_lost: toFiniteInt(obj.times_lost),
    teammate_counts: toCountMap(obj.teammate_counts),
    teammate_names: toStringMap(obj.teammate_names),
    processed_game_ids: toProcessedIds(obj.processed_game_ids),
    updated_at: typeof obj.updated_at === 'string' ? obj.updated_at : ''
  }
}

export function readPlayerStatsFromPreferences(preferences: Record<string, unknown> | null | undefined): PlayerStats {
  const source = (preferences ?? {}) as Record<string, unknown>
  return normalizePlayerStats(source[STATS_KEY])
}

export function getWinLossRatio(stats: PlayerStats): string {
  if (stats.times_lost === 0) {
    if (stats.times_won === 0) return '0.00'
    return `${stats.times_won.toFixed(2)}`
  }
  return (stats.times_won / stats.times_lost).toFixed(2)
}

export function getMostTeammate(stats: PlayerStats): { userId: string; name: string; games: number } | null {
  let bestId = ''
  let bestCount = 0
  for (const [uid, count] of Object.entries(stats.teammate_counts)) {
    if (count > bestCount) {
      bestCount = count
      bestId = uid
    }
  }
  if (!bestId || bestCount <= 0) return null
  return {
    userId: bestId,
    name: stats.teammate_names[bestId] ?? bestId.slice(0, 8),
    games: bestCount
  }
}

export async function recordFinishedGameStats(params: {
  gameId: string
  winnerTeam: StatsTeam
  myUserId: string
  myTeam: StatsTeam
  members: StatsMember[]
  profileNameByUserId?: Record<string, string>
}): Promise<void> {
  const gameId = String(params.gameId ?? '').trim()
  if (!gameId) return

  const profile = await getMyProfile()
  const prefs = (profile.preferences ?? {}) as Record<string, unknown>
  const stats = readPlayerStatsFromPreferences(prefs)
  if (stats.processed_game_ids.includes(gameId)) return

  const teammates = params.members.filter(
    (m) => m.user_id !== params.myUserId && m.team === params.myTeam && (m.role === 'owner' || m.role === 'player')
  )

  const next: PlayerStats = {
    ...stats,
    games_played: stats.games_played + 1,
    times_won: stats.times_won + (params.winnerTeam === params.myTeam ? 1 : 0),
    times_lost: stats.times_lost + (params.winnerTeam === params.myTeam ? 0 : 1),
    teammate_counts: { ...stats.teammate_counts },
    teammate_names: { ...stats.teammate_names },
    processed_game_ids: [...stats.processed_game_ids, gameId].slice(-MAX_PROCESSED_GAMES),
    updated_at: new Date().toISOString()
  }

  for (const mate of teammates) {
    next.teammate_counts[mate.user_id] = (next.teammate_counts[mate.user_id] ?? 0) + 1
    const nameFromGame = String(params.profileNameByUserId?.[mate.user_id] ?? '').trim()
    if (nameFromGame) next.teammate_names[mate.user_id] = nameFromGame
  }

  const mergedPreferences: Record<string, unknown> = {
    ...prefs,
    [STATS_KEY]: next
  }

  await updateMyProfile({
    display_name: profile.display_name,
    bio: profile.bio ?? '',
    avatar_url: profile.avatar_url,
    preferences: mergedPreferences
  })
}

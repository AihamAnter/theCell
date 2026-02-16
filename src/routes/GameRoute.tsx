import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import {
  loadGame,
  loadGameCards,
  revealCard,
  setClue,
  endTurn,
  loadSpymasterKey,
  type Game,
  type GameCard,
  type SpymasterKeyRow,
  type CardColor
} from '../lib/games'
import { restartLobby, stopPlaying } from '../lib/lobbyActions'
import { useDiceOption, useHelperAction, type DiceOption, type HelperAction } from '../lib/powers'
import { getLobbyById, joinLobby, joinLobbyAsSpectator } from '../lib/lobbies'
import { getLobbyProfiles } from '../lib/publicProfiles'

type LoadState = 'loading' | 'ready' | 'error'

type LobbyMemberLite = {
  user_id: string
  team: 'red' | 'blue' | null
  is_spymaster: boolean
  role: 'owner' | 'player' | 'spectator'
  is_ready: boolean
  last_seen_at: string
}

type CenterNoticeTone = 'info' | 'turn' | 'win'
type HintGuess = { word: string; correct: boolean }
type HintTrack = { id: string; clue: string; number: number; words: HintGuess[] }

function supaErr(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const e = err as any
    const msg = typeof e.message === 'string' ? e.message : 'Unknown error'
    const details = typeof e.details === 'string' ? e.details : ''
    const hint = typeof e.hint === 'string' ? e.hint : ''
    const code = typeof e.code === 'string' ? e.code : ''
    const extra = [code && `code=${code}`, details && `details=${details}`, hint && `hint=${hint}`]
      .filter(Boolean)
      .join(' | ')
    return extra ? `${msg} (${extra})` : msg
  }
  return 'Unknown error'
}

function keyColorText(c: CardColor): string {
  if (c === 'assassin') return 'A'
  if (c === 'neutral') return 'N'
  if (c === 'red') return 'R'
  return 'B'
}

function clampInt(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min
  return Math.max(min, Math.min(max, n))
}

function formatMMSS(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const mm = Math.floor(s / 60)
  const ss = s % 60
  return `${mm}:${ss.toString().padStart(2, '0')}`
}

function shortId(id: string): string {
  if (!id) return 'â€”'
  return `${id.slice(0, 4)}â€¦${id.slice(-4)}`
}

function displayNameOrFallback(name: string | undefined, fallback: string): string {
  const clean = String(name ?? '').trim()
  return clean || fallback
}

function teamLabel(t: 'red' | 'blue' | null): string {
  if (t === 'red') return 'Red'
  if (t === 'blue') return 'Blue'
  return 'â€”'
}

function clearLastLobbyMemory() {
  try {
    localStorage.removeItem('oneclue_last_lobby_code')
    localStorage.removeItem('oneclue_last_lobby_role')
  } catch {
    // ignore
  }
}

async function findLatestOpenLobbyCodeByOwner(ownerId: string, excludeLobbyId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('lobbies')
    .select('id,code,status,created_at')
    .eq('owner_id', ownerId)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(5)

  if (error) throw error
  const rows = (data ?? []) as Array<{ id: string; code: string; status: string; created_at: string }>
  const row = rows.find((r) => r.id !== excludeLobbyId) ?? null
  return row?.code?.trim()?.toUpperCase() ?? null
}

type PeekRow = { pos: number; color: string; at?: string }

function getPeeks(state: any, team: 'red' | 'blue' | null): PeekRow[] {
  if (!team) return []
  const arr = state?.helpers?.peeks?.[team]
  if (!Array.isArray(arr)) return []
  return arr
    .map((x: any) => ({
      pos: typeof x?.pos === 'number' ? x.pos : Number(x?.pos),
      color: String(x?.color ?? ''),
      at: typeof x?.at === 'string' ? x.at : undefined
    }))
    .filter((x: PeekRow) => Number.isFinite(x.pos) && x.color.length > 0)
}

function getStreak(state: any, team: 'red' | 'blue' | null): number {
  if (!team) return 0
  const v = state?.streak?.[team]
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : 0
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0
}

function diceUsedThisTurn(state: any): boolean {
  const tn = Number(state?.turn_no ?? 0)
  const used = Number(state?.dice?.used_turn_no ?? -1)
  return Number.isFinite(tn) && Number.isFinite(used) && tn === used
}

function timeCutHalfAppliesNow(state: any, currentTurnTeam: 'red' | 'blue' | null): boolean {
  if (!currentTurnTeam) return false
  const mode = state?.helpers?.time_cut_mode?.[currentTurnTeam]
  return mode === 'half'
}

export default function GameRoute() {
  const { id } = useParams()
  const navigate = useNavigate()

  const gameId = useMemo(() => (id ?? '').trim(), [id])

  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)

  const [game, setGame] = useState<Game | null>(null)
  const [cards, setCards] = useState<GameCard[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  const [myTeam, setMyTeam] = useState<'red' | 'blue' | null>(null)
  const [amSpymaster, setAmSpymaster] = useState(false)
  const [myUserId, setMyUserId] = useState<string | null>(null)

  const [clueWord, setClueWord] = useState('')
  const [clueNumber, setClueNumber] = useState(1)

  const [keyRows, setKeyRows] = useState<SpymasterKeyRow[]>([])
  const keyMap = useMemo(() => {
    const m = new Map<number, CardColor>()
    for (const r of keyRows) m.set(r.pos, r.color)
    return m
  }, [keyRows])

  const [members, setMembers] = useState<LobbyMemberLite[]>([])
  const [profileNameByUserId, setProfileNameByUserId] = useState<Record<string, string>>({})
  const [revealFxByPos, setRevealFxByPos] = useState<Record<number, 'correct' | 'incorrect' | 'assassin'>>({})
  const [pendingRevealPos, setPendingRevealPos] = useState<number | null>(null)
  const [centerNotice, setCenterNotice] = useState<{ id: number; text: string; tone: CenterNoticeTone } | null>(null)
  const [remainingBase, setRemainingBase] = useState<{ red: number; blue: number } | null>(null)
  const [teamHintLog, setTeamHintLog] = useState<{ red: HintTrack[]; blue: HintTrack[] }>({ red: [], blue: [] })
  const [roundCorrectStreak, setRoundCorrectStreak] = useState(0)
  const [rolledDiceOption, setRolledDiceOption] = useState<DiceOption | null>(null)
  const [peekFlash, setPeekFlash] = useState<{ pos: number; color: string } | null>(null)
  const [showWinTrail, setShowWinTrail] = useState(false)
  const prevRevealedRef = useRef<Map<number, boolean>>(new Map())
  const fxTimeoutsRef = useRef<number[]>([])
  const suspenseTimeoutRef = useRef<number | null>(null)
  const noticeTimeoutRef = useRef<number | null>(null)
  const peekFlashTimeoutRef = useRef<number | null>(null)
  const prevGameRef = useRef<Game | null>(null)
  const prevForcedWinnerRef = useRef<'red' | 'blue' | null>(null)
  const autoEndTurnRef = useRef<{ sig: string; inFlight: boolean }>({ sig: '', inFlight: false })
  const guessesTransitionRef = useRef<{ turnSig: string; prev: number | null }>({ turnSig: '', prev: null })
  const didAutoRedirectRef = useRef(false)

  // timer (client-only)
  const TURN_SECONDS = 180
  const [turnLeft, setTurnLeft] = useState<number>(TURN_SECONDS)
  const lastTurnSigRef = useRef<string>('')
  const timeCutAppliedRef = useRef<boolean>(false)

  async function refreshMembers(lobbyId: string) {
    const { data, error } = await supabase
      .from('lobby_members')
      .select('user_id,team,is_spymaster,role,is_ready,last_seen_at')
      .eq('lobby_id', lobbyId)
      .order('joined_at', { ascending: true })

    if (!error) setMembers((data ?? []) as LobbyMemberLite[])

    try {
      const profs = await getLobbyProfiles(lobbyId)
      const map: Record<string, string> = {}
      for (const p of profs) {
        const uid = String(p.user_id ?? '').trim()
        const n = String(p.display_name ?? '').trim()
        if (uid && n) map[uid] = n
      }
      setProfileNameByUserId(map)
    } catch (err) {
      console.warn('[game] get_lobby_profiles failed, using fallback names:', err)
      setProfileNameByUserId({})
    }
  }

  const amOwner = useMemo(() => {
    if (!myUserId) return false
    return members.some((m) => m.user_id === myUserId && m.role === 'owner')
  }, [members, myUserId])

  const myPeeks = useMemo(() => getPeeks(game?.state as any, myTeam), [game?.state, myTeam])
  const myStreak = useMemo(() => getStreak(game?.state as any, myTeam), [game?.state, myTeam])
  const memberTeamById = useMemo(() => {
    const out = new Map<string, 'red' | 'blue' | null>()
    for (const m of members) out.set(m.user_id, m.team)
    return out
  }, [members])
  const revealedCounts = useMemo(() => {
    let red = 0
    let blue = 0
    for (const c of cards) {
      if (!c.revealed || !c.revealed_color) continue
      if (c.revealed_color === 'red') red += 1
      if (c.revealed_color === 'blue') blue += 1
    }
    return { red, blue }
  }, [cards])

  // dice unlock rule: 3 correct reveals in the current round
  const diceUnlocked = roundCorrectStreak >= 3 || myStreak >= 3
  const diceUsed = useMemo(() => diceUsedThisTurn(game?.state as any), [game?.state])

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        setState('loading')
        setError(null)

        if (!gameId) throw new Error('Missing game id')

        const g = await loadGame(gameId)
        const c = await loadGameCards(gameId)

        const { data: sessionData, error: sessionErr } = await supabase.auth.getSession()
        if (sessionErr) throw sessionErr

        const uid = sessionData.session?.user?.id ?? null
        if (!uid) throw new Error('No session')
        setMyUserId(uid)

        const { data: lm, error: lmErr } = await supabase
          .from('lobby_members')
          .select('team,is_spymaster')
          .eq('lobby_id', g.lobby_id)
          .eq('user_id', uid)
          .single()

        if (lmErr) throw lmErr

        await refreshMembers(g.lobby_id)

        if (cancelled) return
        setGame(g)
        setCards(c)
        setMyTeam((lm?.team ?? null) as 'red' | 'blue' | null)
        setAmSpymaster(Boolean(lm?.is_spymaster))
        setClueWord(g.clue_word ?? '')
        setClueNumber(g.clue_number ?? 1)
        setState('ready')
      } catch (err) {
        console.error('[game] load failed:', err)
        if (!cancelled) {
          setError(err instanceof Error ? err.message : supaErr(err))
          setState('error')
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [gameId])

  useEffect(() => {
    setRemainingBase(null)
  }, [gameId])

  useEffect(() => {
    return () => {
      fxTimeoutsRef.current.forEach((t) => window.clearTimeout(t))
      fxTimeoutsRef.current = []
      if (suspenseTimeoutRef.current !== null) {
        window.clearTimeout(suspenseTimeoutRef.current)
        suspenseTimeoutRef.current = null
      }
      if (noticeTimeoutRef.current !== null) {
        window.clearTimeout(noticeTimeoutRef.current)
        noticeTimeoutRef.current = null
      }
      if (peekFlashTimeoutRef.current !== null) {
        window.clearTimeout(peekFlashTimeoutRef.current)
        peekFlashTimeoutRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!gameId) return
    if (!game?.lobby_id) return

    const lobbyId = game.lobby_id

    const channel = supabase
      .channel(`lobby:${lobbyId}`, { config: { private: true } })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games', filter: `id=eq.${gameId}` }, async () => {
        const g = await loadGame(gameId)
        setGame(g)
        setClueWord(g.clue_word ?? '')
        setClueNumber(g.clue_number ?? 1)
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_cards', filter: `game_id=eq.${gameId}` }, async () => {
        const [c, g] = await Promise.all([loadGameCards(gameId), loadGame(gameId)])
        setCards(c)
        setGame(g)
        setClueWord(g.clue_word ?? '')
        setClueNumber(g.clue_number ?? 1)
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lobby_members', filter: `lobby_id=eq.${lobbyId}` }, async () => {
        await refreshMembers(lobbyId)
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'lobbies', filter: `id=eq.${lobbyId}` }, async () => {
        try {
          const updatedLobby = await getLobbyById(lobbyId)
          if (didAutoRedirectRef.current) return

          const myRole = members.find((m) => m.user_id === myUserId)?.role ?? 'player'
          const goToNewestOpenLobby = async () => {
            const newCode = await findLatestOpenLobbyCodeByOwner(updatedLobby.owner_id, lobbyId)
            if (!newCode) return false
            if (myRole === 'spectator') {
              await joinLobbyAsSpectator(newCode)
              didAutoRedirectRef.current = true
              showCenterNotice('Lobby Restarted', 'info', 1800)
              window.setTimeout(() => navigate(`/lobby/${newCode}?spectate=1`, { replace: true }), 250)
              return true
            }
            await joinLobby(newCode)
            didAutoRedirectRef.current = true
            showCenterNotice('Lobby Restarted', 'info', 1800)
            window.setTimeout(() => navigate(`/lobby/${newCode}`, { replace: true }), 250)
            return true
          }

          if (updatedLobby.status === 'closed') {
            const moved = await goToNewestOpenLobby()
            if (!moved) {
              didAutoRedirectRef.current = true
              showCenterNotice('Lobby Closed', 'info', 1800)
              window.setTimeout(() => navigate('/', { replace: true }), 250)
            }
            return
          }

          if (updatedLobby.status === 'open') {
            const moved = await goToNewestOpenLobby()
            if (!moved) {
              didAutoRedirectRef.current = true
              showCenterNotice('Lobby Open', 'info', 1600)
              window.setTimeout(() => navigate(`/lobby/${updatedLobby.code}`, { replace: true }), 250)
            }
            return
          }
        } catch (err) {
          console.error('[game] lobby status refresh failed:', err)
        }
      })
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [gameId, game?.lobby_id, members, myUserId, navigate])

  useEffect(() => {
    if (!cards.length) return

    const next = new Map<number, boolean>()
    const updates: Array<{ pos: number; tone: 'correct' | 'incorrect' | 'assassin' }> = []
    const newlyRevealed: GameCard[] = []

    for (const c of cards) {
      const wasRevealed = prevRevealedRef.current.get(c.pos) ?? c.revealed
      next.set(c.pos, c.revealed)
      if (!wasRevealed && c.revealed) {
        newlyRevealed.push(c)
        const expectedTeam = game?.current_turn_team ?? myTeam
        const tone: 'correct' | 'incorrect' | 'assassin' =
          c.revealed_color === 'assassin'
            ? 'assassin'
            : expectedTeam !== null && c.revealed_color === expectedTeam
              ? 'correct'
              : 'incorrect'
        updates.push({ pos: c.pos, tone })
      }
    }

    prevRevealedRef.current = next

    if (updates.length > 0) {
      setRevealFxByPos((prev) => {
        const out = { ...prev }
        for (const u of updates) out[u.pos] = u.tone
        return out
      })

      for (const u of updates) {
        const timer = window.setTimeout(() => {
          setRevealFxByPos((prev) => {
            const out = { ...prev }
            delete out[u.pos]
            return out
          })
          fxTimeoutsRef.current = fxTimeoutsRef.current.filter((x) => x !== timer)
        }, 1250)
        fxTimeoutsRef.current.push(timer)
      }
    }

    if (newlyRevealed.length === 0) return

    for (const c of newlyRevealed) {
      const actorTeam = c.revealed_by ? memberTeamById.get(c.revealed_by) ?? null : null
      if (!actorTeam) continue
      const isCorrect = c.revealed_color === actorTeam
      setTeamHintLog((prev) => {
        const arr = [...prev[actorTeam]]
        if (arr.length === 0) {
          const fallback: HintTrack = {
            id: `${actorTeam}-fallback-${Date.now()}`,
            clue: String(game?.clue_word ?? '—'),
            number: Number(game?.clue_number ?? 0),
            words: [{ word: c.word, correct: isCorrect }]
          }
          return { ...prev, [actorTeam]: [fallback] }
        }
        const last = arr[arr.length - 1]
        if (!last.words.some((w) => w.word === c.word)) last.words = [...last.words, { word: c.word, correct: isCorrect }]
        arr[arr.length - 1] = last
        return { ...prev, [actorTeam]: arr.slice(-6) }
      })

    }
  }, [cards, myTeam, game?.current_turn_team, game?.clue_word, game?.clue_number, memberTeamById])

  useEffect(() => {
    if (!game) return
    if (remainingBase) return

    // Infer stable totals so counters can still move from card reveals even if game remaining fields lag.
    const inferredRed = clampInt((game.red_remaining ?? 0) + revealedCounts.red, 0, 99)
    const inferredBlue = clampInt((game.blue_remaining ?? 0) + revealedCounts.blue, 0, 99)
    setRemainingBase({ red: inferredRed, blue: inferredBlue })
  }, [game, remainingBase, revealedCounts.red, revealedCounts.blue])

  function showCenterNotice(text: string, tone: CenterNoticeTone = 'info', ms = 1700) {
    if (noticeTimeoutRef.current !== null) {
      window.clearTimeout(noticeTimeoutRef.current)
      noticeTimeoutRef.current = null
    }
    setCenterNotice({ id: Date.now(), text, tone })
    noticeTimeoutRef.current = window.setTimeout(() => {
      setCenterNotice((prev) => (prev?.text === text ? null : prev))
      noticeTimeoutRef.current = null
    }, ms)
  }

  useEffect(() => {
    if (!game) return
    const prev = prevGameRef.current
    prevGameRef.current = game
    if (!prev) return

    if (prev.current_turn_team !== game.current_turn_team && game.current_turn_team) {
      showCenterNotice(`${teamLabel(game.current_turn_team)} Team Turn`, 'turn', 1700)
    }

    const prevClue = (prev.clue_word ?? '').trim()
    const nextClue = (game.clue_word ?? '').trim()
    if ((prevClue !== nextClue || prev.clue_number !== game.clue_number) && nextClue && game.current_turn_team) {
      const tn = Number((game.state as any)?.turn_no ?? 0)
      const hintId = `${game.current_turn_team}-${tn}-${nextClue}-${String(game.clue_number ?? 0)}`
      setTeamHintLog((logs) => {
        const team = game.current_turn_team as 'red' | 'blue'
        if (!team) return logs
        const arr = [...logs[team]]
        if (arr.some((x) => x.id === hintId)) return logs
        arr.push({ id: hintId, clue: nextClue, number: Number(game.clue_number ?? 0), words: [] })
        return { ...logs, [team]: arr.slice(-6) }
      })
      showCenterNotice(`Clue: ${nextClue} (${String(game.clue_number ?? '—')})`, 'info', 2200)
    }

    if (prev.status !== game.status) {
      if (game.status === 'finished') {
        if (game.winning_team) {
          showCenterNotice(`${teamLabel(game.winning_team)} Team Wins`, 'win', 2600)
        } else {
          showCenterNotice('Game Finished', 'win', 2200)
        }
      } else if (game.status === 'abandoned') {
        showCenterNotice('Game Abandoned', 'info', 2200)
      }
    }

    if (prev.winning_team !== game.winning_team && game.winning_team) {
      showCenterNotice(`${teamLabel(game.winning_team)} Team Wins`, 'win', 2600)
    }
  }, [game])

  useEffect(() => {
    if (!game?.clue_word || !game.current_turn_team) return
    const clue = game.clue_word.trim()
    if (!clue) return
    const tn = Number((game.state as any)?.turn_no ?? 0)
    const hintId = `${game.current_turn_team}-${tn}-${clue}-${String(game.clue_number ?? 0)}`
    setTeamHintLog((logs) => {
      const team = game.current_turn_team as 'red' | 'blue'
      const arr = [...logs[team]]
      if (arr.some((x) => x.id === hintId)) return logs
      arr.push({ id: hintId, clue, number: Number(game.clue_number ?? 0), words: [] })
      return { ...logs, [team]: arr.slice(-6) }
    })
  }, [game?.clue_word, game?.clue_number, game?.current_turn_team, game?.state])

  useEffect(() => {
    if (!game) return
    const blueNow = clampInt((remainingBase?.blue ?? ((game.blue_remaining ?? 0) + revealedCounts.blue)) - revealedCounts.blue, 0, 99)
    const redNow = clampInt((remainingBase?.red ?? ((game.red_remaining ?? 0) + revealedCounts.red)) - revealedCounts.red, 0, 99)
    const winner: 'red' | 'blue' | null = blueNow === 0 ? 'blue' : redNow === 0 ? 'red' : null

    if (!winner) {
      prevForcedWinnerRef.current = null
      return
    }
    if (prevForcedWinnerRef.current === winner) return
    prevForcedWinnerRef.current = winner
    showCenterNotice(`${teamLabel(winner)} Team Wins`, 'win', 2600)
  }, [game, remainingBase, revealedCounts.blue, revealedCounts.red])

  useEffect(() => {
    let cancelled = false
    if (!amSpymaster || !gameId) return

    ;(async () => {
      try {
        const rows = await loadSpymasterKey(gameId)
        if (!cancelled) setKeyRows(rows)
      } catch (err) {
        console.error('[game] key load failed:', err)
        if (!cancelled) alert(supaErr(err))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [amSpymaster, gameId])

  // reset timer on new turn signature
  useEffect(() => {
    if (!game) return
    const sig = `${game.current_turn_team ?? 'x'}|${game.clue_word ?? ''}|${game.clue_number ?? ''}|${(game.state as any)?.turn_no ?? ''}`
    if (sig !== lastTurnSigRef.current) {
      lastTurnSigRef.current = sig
      setTurnLeft(TURN_SECONDS)
      timeCutAppliedRef.current = false
      setRoundCorrectStreak(0)
      setRolledDiceOption(null)
    }
  }, [game?.current_turn_team, game?.clue_word, game?.clue_number, game?.state])

  // ticking timer
  useEffect(() => {
    if (state !== 'ready') return
    if (!game) return
    const blueNow = clampInt((remainingBase?.blue ?? ((game.blue_remaining ?? 0) + revealedCounts.blue)) - revealedCounts.blue, 0, 99)
    const redNow = clampInt((remainingBase?.red ?? ((game.red_remaining ?? 0) + revealedCounts.red)) - revealedCounts.red, 0, 99)
    const winner: 'red' | 'blue' | null = game.winning_team ?? (blueNow === 0 ? 'blue' : redNow === 0 ? 'red' : null)
    const localStatus = game.status === 'active' && winner ? 'finished' : game.status
    if (localStatus !== 'active') return

    const id = window.setInterval(() => setTurnLeft((prev) => Math.max(0, prev - 1)), 1000)
    return () => window.clearInterval(id)
  }, [state, game, remainingBase, revealedCounts.blue, revealedCounts.red])

  // auto-change turn when timer reaches 0
  useEffect(() => {
    if (!gameId || !game) return
    if (turnLeft > 0) return
    if (game.status !== 'active') return
    const blueNow = clampInt((remainingBase?.blue ?? ((game.blue_remaining ?? 0) + revealedCounts.blue)) - revealedCounts.blue, 0, 99)
    const redNow = clampInt((remainingBase?.red ?? ((game.red_remaining ?? 0) + revealedCounts.red)) - revealedCounts.red, 0, 99)
    const winner: 'red' | 'blue' | null = game.winning_team ?? (blueNow === 0 ? 'blue' : redNow === 0 ? 'red' : null)
    if (winner) return

    const turnSig = `${game.current_turn_team ?? 'x'}|${(game.state as any)?.turn_no ?? ''}`
    if (autoEndTurnRef.current.sig === turnSig) return
    if (autoEndTurnRef.current.inFlight) return

    autoEndTurnRef.current.inFlight = true
    autoEndTurnRef.current.sig = turnSig

    ;(async () => {
      try {
        await endTurn(gameId)
      } catch (err) {
        console.warn('[game] timer auto end_turn skipped:', err)
      } finally {
        autoEndTurnRef.current.inFlight = false
      }
    })()
  }, [gameId, game, turnLeft, remainingBase, revealedCounts.blue, revealedCounts.red])

  // auto-change turn when guesses are exhausted
  useEffect(() => {
    if (!gameId || !game) return
    if (game.status !== 'active') return
    const gr = Number(game.guesses_remaining ?? -1)

    const turnSig = `${game.current_turn_team ?? 'x'}|${(game.state as any)?.turn_no ?? ''}`
    if (guessesTransitionRef.current.turnSig !== turnSig) {
      guessesTransitionRef.current = { turnSig, prev: Number.isFinite(gr) ? gr : null }
      return
    }

    const prev = guessesTransitionRef.current.prev
    guessesTransitionRef.current.prev = Number.isFinite(gr) ? gr : null

    // Only auto-end on a real transition (e.g. 1 -> 0), not on stable 0 states.
    if (!Number.isFinite(gr) || gr > 0) return
    if (prev === null || prev <= 0) return
    if (autoEndTurnRef.current.sig === turnSig) return
    if (autoEndTurnRef.current.inFlight) return

    autoEndTurnRef.current.inFlight = true
    autoEndTurnRef.current.sig = turnSig

    ;(async () => {
      try {
        await endTurn(gameId)
      } catch (err) {
        console.warn('[game] guesses auto end_turn skipped:', err)
      } finally {
        autoEndTurnRef.current.inFlight = false
      }
    })()
  }, [gameId, game])

  // apply time cut (half) once at start of the target teamâ€™s turn
  useEffect(() => {
    if (!game) return
    if (!game.current_turn_team) return

    const st: any = game.state
    if (!timeCutAppliedRef.current && timeCutHalfAppliesNow(st, game.current_turn_team)) {
      timeCutAppliedRef.current = true
      setTurnLeft((prev) => Math.max(0, Math.floor(prev / 2)))
    }
  }, [game?.state, game?.current_turn_team])

  async function handleReveal(pos: number) {
    if (!gameId) return
    if (!isGameActive) return
    if (pillCount <= 0) return
    if (pendingRevealPos !== null || busy !== null) return
    try {
      setPendingRevealPos(pos)
      await new Promise<void>((resolve) => {
        suspenseTimeoutRef.current = window.setTimeout(() => {
          suspenseTimeoutRef.current = null
          resolve()
        }, 500)
      })
      const res = await revealCard(gameId, pos)
      if (myTeam && game?.current_turn_team === myTeam) {
        const isCorrect = res.revealed_color === myTeam
        setRoundCorrectStreak((prev) => (isCorrect ? prev + 1 : 0))
      }
      setGame((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          status: res.game_status,
          current_turn_team: res.current_turn,
          winning_team: res.winning_team,
          guesses_remaining: res.guesses_remaining,
          red_remaining: res.red_remaining,
          blue_remaining: res.blue_remaining
        }
      })
    } catch (err) {
      console.error('[game] reveal failed:', err)
      alert(supaErr(err))
    } finally {
      setPendingRevealPos(null)
    }
  }

  async function handleSetClue() {
    if (!gameId) return
    try {
      setBusy('Setting clueâ€¦')
      await setClue(gameId, clueWord, clueNumber)
    } catch (err) {
      console.error('[game] set clue failed:', err)
      alert(supaErr(err))
    } finally {
      setBusy(null)
    }
  }

  async function handleEndTurn() {
    if (!gameId) return
    try {
      setBusy('Ending turnâ€¦')
      await endTurn(gameId)
    } catch (err) {
      console.error('[game] end turn failed:', err)
      alert(supaErr(err))
    } finally {
      setBusy(null)
    }
  }

  async function handleStopPlaying() {
    if (!game?.lobby_id) return
    try {
      setBusy('Leavingâ€¦')
      await stopPlaying(game.lobby_id)
      clearLastLobbyMemory()
      navigate('/', { replace: true })
    } catch (err) {
      console.error('[game] stop playing failed:', err)
      alert(supaErr(err))
    } finally {
      setBusy(null)
    }
  }

  async function handleRestart() {
    if (!game?.lobby_id) return
    try {
      setBusy('Restartingâ€¦')
      const code = await restartLobby(game.lobby_id)
      navigate(`/settings/${code}`)
    } catch (err) {
      console.error('[game] restart failed:', err)
      alert(supaErr(err))
    } finally {
      setBusy(null)
    }
  }

  async function runDice(option: DiceOption) {
    if (!gameId) return
    if (!isGameActive) return
    try {
      setBusy('Using diceâ€¦')

      // options needing positions
      if (option === 'sabotage_reassign' || option === 'steal_reassign') {
        const posStr = window.prompt('Enter the target position (0-24):')
        if (posStr === null) return
        const pos = Number(posStr)
        if (!Number.isFinite(pos)) return alert('invalid pos')
        const res = await useDiceOption(gameId, option, { pos })
        alert(JSON.stringify(res, null, 2))
        return
      }

      if (option === 'swap') {
        const aStr = window.prompt('Enter pos_a (your team unrevealed) 0-24:')
        if (aStr === null) return
        const bStr = window.prompt('Enter pos_b (any unrevealed) 0-24:')
        if (bStr === null) return
        const pos_a = Number(aStr)
        const pos_b = Number(bStr)
        if (!Number.isFinite(pos_a) || !Number.isFinite(pos_b)) return alert('invalid positions')
        const res = await useDiceOption(gameId, option, { pos_a, pos_b })
        alert(JSON.stringify(res, null, 2))
        return
      }

      // simple options
      const res = await useDiceOption(gameId, option, {})
      alert(JSON.stringify(res, null, 2))
    } catch (err) {
      console.error('[dice] failed:', err)
      alert(supaErr(err))
    } finally {
      setBusy(null)
    }
  }

  function diceOptionLabel(option: DiceOption): string {
    if (option === 'double_hint') return 'Double Hint'
    if (option === 'sabotage_reassign') return 'Sabotage Reassign'
    if (option === 'steal_reassign') return 'Steal Reassign'
    if (option === 'shield') return 'Shield'
    if (option === 'cancel') return 'Cancel'
    return 'Swap'
  }

  async function handleRollDice() {
    if (!isGameActive || !diceUnlocked || diceUsed || busy !== null) return
    const options: DiceOption[] = ['double_hint', 'sabotage_reassign', 'steal_reassign', 'shield', 'cancel', 'swap']
    const option = options[Math.floor(Math.random() * options.length)]
    setRolledDiceOption(option)
    showCenterNotice(`Dice: ${diceOptionLabel(option)}`, 'info', 1500)
    await runDice(option)
  }

  async function runHelper(action: HelperAction) {
    if (!gameId) return
    if (!isGameActive) return
    try {
      setBusy('Using helperâ€¦')
      const res = await useHelperAction(gameId, action, {})
      if (action === 'random_peek') {
        const pos = Number(res.pos)
        const color = String(res.color ?? '').toUpperCase()
        if (Number.isFinite(pos)) {
          setPeekFlash({ pos, color })
          if (peekFlashTimeoutRef.current !== null) window.clearTimeout(peekFlashTimeoutRef.current)
          peekFlashTimeoutRef.current = window.setTimeout(() => {
            setPeekFlash(null)
            peekFlashTimeoutRef.current = null
          }, 1000)
        }
        showCenterNotice(`Peek: ${color}`, 'info', 1300)
      } else if (action === 'time_cut') {
        alert(`Time Cut applied to ${String(res.team).toUpperCase()} (half)`)
      } else {
        alert('Shuffle unrevealed done')
      }
    } catch (err) {
      console.error('[helper] failed:', err)
      alert(supaErr(err))
    } finally {
      setBusy(null)
    }
  }

  const pillCount = clampInt(game?.guesses_remaining ?? 0, 0, 99)
  const blueLeft = clampInt((remainingBase?.blue ?? ((game?.blue_remaining ?? 0) + revealedCounts.blue)) - revealedCounts.blue, 0, 99)
  const redLeft = clampInt((remainingBase?.red ?? ((game?.red_remaining ?? 0) + revealedCounts.red)) - revealedCounts.red, 0, 99)
  const forcedWinner: 'red' | 'blue' | null = blueLeft === 0 ? 'blue' : redLeft === 0 ? 'red' : null
  const effectiveWinner: 'red' | 'blue' | null = game?.winning_team ?? forcedWinner
  const effectiveStatus = game?.status === 'active' && forcedWinner ? 'finished' : game?.status
  const isGameActive = effectiveStatus === 'active'

  const isMyTurn = game?.current_turn_team !== null && myTeam === game?.current_turn_team
  const hasClue = game?.guesses_remaining !== null && game?.guesses_remaining !== undefined
  const canOperate = !amSpymaster && isMyTurn && isGameActive && hasClue && pillCount > 0
  const canEndTurnOperate = !amSpymaster && isMyTurn && isGameActive && hasClue
  const canSpymaster = amSpymaster && isMyTurn && isGameActive

  useEffect(() => {
    if (isGameActive) setShowWinTrail(false)
  }, [isGameActive])

  const playable = members.filter((m) => m.role === 'owner' || m.role === 'player')
  const redTeam = playable.filter((m) => m.team === 'red')
  const blueTeam = playable.filter((m) => m.team === 'blue')

  function memberDisplayName(userId: string, index: number): string {
    return displayNameOrFallback(profileNameByUserId[userId], `Player ${index + 1}`)
  }

  const bg =
    'radial-gradient(900px 520px at 50% 10%, rgba(255,255,255,0.08), rgba(0,0,0,0) 60%), #000'
  const panel = 'rgba(0,0,0,0.35)'
  const border = '1px solid rgba(255,255,255,0.10)'

  function cardBg(c: GameCard, hidden?: CardColor): string {
    if (c.revealed && c.revealed_color) {
      if (c.revealed_color === 'blue') return 'linear-gradient(180deg, rgba(70,80,255,0.45), rgba(20,22,40,0.92))'
      if (c.revealed_color === 'red') return 'linear-gradient(180deg, rgba(255,95,95,0.35), rgba(40,18,18,0.95))'
      if (c.revealed_color === 'assassin') return 'linear-gradient(180deg, rgba(170,176,190,0.34), rgba(22,24,30,0.96))'
      return 'linear-gradient(180deg, rgba(255,255,255,0.10), rgba(10,10,12,0.96))'
    }
    if (hidden) {
      if (hidden === 'blue') return 'linear-gradient(180deg, rgba(70,80,255,0.30), rgba(10,10,12,0.96))'
      if (hidden === 'red') return 'linear-gradient(180deg, rgba(255,95,95,0.22), rgba(10,10,12,0.96))'
      if (hidden === 'assassin') return 'linear-gradient(180deg, rgba(170,176,190,0.30), rgba(22,24,30,0.96))'
      return 'linear-gradient(180deg, rgba(255,255,255,0.06), rgba(10,10,12,0.96))'
    }
    return 'linear-gradient(180deg, rgba(255,255,255,0.04), rgba(10,10,12,0.92))'
  }

  function fxClassFor(pos: number): string {
    const tone = revealFxByPos[pos]
    if (!tone) return ''
    if (tone === 'assassin') return 'oc-card-fx-assassin'
    if (tone === 'correct') return 'oc-card-fx-correct'
    return 'oc-card-fx-incorrect'
  }

  return (
    <div style={{ minHeight: '100vh', background: bg, color: '#fff', display: 'grid', placeItems: 'center', padding: 18 }}>
      <style>{`
        .oc-stage{
          isolation:isolate;
        }
        .oc-stage::before{
          content:'';
          position:absolute;
          inset:-28%;
          pointer-events:none;
          background:
            radial-gradient(44% 30% at 18% 22%, rgba(255,120,120,0.14), rgba(0,0,0,0) 62%),
            radial-gradient(42% 28% at 82% 18%, rgba(90,120,255,0.18), rgba(0,0,0,0) 64%),
            radial-gradient(55% 40% at 50% 84%, rgba(255,225,120,0.08), rgba(0,0,0,0) 68%);
          mix-blend-mode:screen;
          animation: oc-ambient-swirl 12s ease-in-out infinite alternate;
          z-index:0;
        }

        .oc-card{
          transform-origin: 50% 62%;
        }
        .oc-card.oc-card-interactive:hover{
          animation: oc-suspense-hover 0.55s ease forwards;
        }
        .oc-card.oc-card-pending{
          animation: oc-suspense-breathe 0.5s cubic-bezier(.2,.75,.2,1) forwards;
        }
        .oc-card.oc-card-peek{
          box-shadow: 0 0 30px rgba(255,225,120,0.42), 0 10px 26px rgba(0,0,0,0.55), inset 0 0 0 2px rgba(255,225,120,0.65);
          filter: saturate(1.2) brightness(1.12);
        }

        .oc-card-fx-correct{
          animation: oc-impact-team 1.2s cubic-bezier(.2,.78,.2,1);
        }
        .oc-card-fx-incorrect{
          animation: oc-impact-enemy 1s cubic-bezier(.36,.07,.19,.97);
        }
        .oc-card-fx-assassin{
          animation: oc-impact-assassin 1.25s cubic-bezier(.2,.78,.2,1);
        }

        .oc-card .oc-word{
          transition: letter-spacing .28s ease, transform .28s ease;
        }
        .oc-card.oc-card-interactive:hover .oc-word{
          letter-spacing: 1.2px;
          transform: scale(1.03);
        }

        @keyframes oc-ambient-swirl{
          0%{ transform: translate3d(-2%, -1%, 0) scale(1); opacity:.62; }
          100%{ transform: translate3d(2.5%, 2%, 0) scale(1.08); opacity:.94; }
        }
        @keyframes oc-suspense-breathe{
          0%{ transform: translateY(0) scale(1); filter: brightness(1); }
          34%{ transform: translateY(-2px) scale(1.018); filter: brightness(1.08); }
          70%{ transform: translateY(1px) scale(1.01); filter: brightness(1.03); }
          100%{ transform: translateY(0) scale(1); filter: brightness(1); }
        }
        @keyframes oc-suspense-hover{
          0%{ transform: translateY(0) scale(1); filter: brightness(1); }
          45%{ transform: translateY(-3px) scale(1.03); filter: brightness(1.18); }
          100%{ transform: translateY(-1px) scale(1.02); filter: brightness(1.1); }
        }
        @keyframes oc-impact-team{
          0%{ transform: scale(1); filter: brightness(1); }
          28%{ transform: scale(1.09); filter: brightness(1.28); }
          58%{ transform: scale(.97); filter: brightness(.96); }
          100%{ transform: scale(1); filter: brightness(1); }
        }
        @keyframes oc-impact-enemy{
          0%{ transform: translateX(0); filter: brightness(1); }
          20%{ transform: translateX(-8px); filter: brightness(1.16); }
          40%{ transform: translateX(8px); }
          60%{ transform: translateX(-6px); }
          80%{ transform: translateX(5px); }
          100%{ transform: translateX(0); filter: brightness(1); }
        }
        @keyframes oc-impact-assassin{
          0%{ transform: scale(1); filter: brightness(1); box-shadow: 0 10px 26px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(0,0,0,0.50); }
          22%{ transform: scale(1.11); filter: brightness(1.45); box-shadow: 0 0 46px rgba(255,196,96,0.35), 0 10px 26px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(0,0,0,0.50); }
          52%{ transform: scale(.95); filter: brightness(.86); }
          78%{ transform: scale(1.04); filter: brightness(1.18); }
          100%{ transform: scale(1); filter: brightness(1); box-shadow: 0 10px 26px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(0,0,0,0.50); }
        }

        .oc-center-notice{
          position: absolute;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%);
          z-index: 9;
          pointer-events: none;
          padding: 18px 24px;
          border-radius: 18px;
          border: 1px solid rgba(255,255,255,0.20);
          background: linear-gradient(180deg, rgba(0,0,0,0.84), rgba(0,0,0,0.68));
          color: rgba(255,255,255,0.96);
          font-weight: 1000;
          letter-spacing: 0.8px;
          text-transform: uppercase;
          box-shadow: 0 26px 60px rgba(0,0,0,0.64);
          animation: oc-notice-in .42s cubic-bezier(.2,.78,.2,1), oc-notice-pulse .9s ease-in-out;
          white-space: nowrap;
        }
        .oc-center-notice.turn{
          border-color: rgba(170,255,255,0.44);
          box-shadow: 0 0 30px rgba(90,170,255,0.28), 0 26px 60px rgba(0,0,0,0.64);
        }
        .oc-center-notice.win{
          border-color: rgba(255,216,120,0.55);
          box-shadow: 0 0 38px rgba(255,216,120,0.35), 0 26px 60px rgba(0,0,0,0.64);
        }
        @keyframes oc-notice-in{
          0%{ opacity: 0; transform: translate(-50%, -50%) scale(0.9); }
          100%{ opacity: 1; transform: translate(-50%, -50%) scale(1); }
        }
        @keyframes oc-notice-pulse{
          0%{ filter: brightness(1); }
          50%{ filter: brightness(1.2); }
          100%{ filter: brightness(1); }
        }
        .oc-win-overlay{
          position:absolute;
          inset:0;
          z-index:8;
          display:grid;
          place-items:center;
          background: rgba(0,0,0,0.36);
          pointer-events:auto;
        }
        .oc-win-card{
          min-width: min(560px, 92vw);
          border-radius: 18px;
          border: 1px solid rgba(255,255,255,0.18);
          background: linear-gradient(180deg, rgba(0,0,0,0.86), rgba(0,0,0,0.72));
          box-shadow: 0 30px 70px rgba(0,0,0,0.68);
          padding: 18px;
          display:grid;
          gap: 12px;
        }
        .oc-win-title{
          text-align:center;
          font-size: clamp(24px, 4vw, 42px);
          font-weight: 1000;
          letter-spacing: .06em;
          text-transform: uppercase;
          animation: oc-win-float 2.2s ease-in-out infinite;
        }
        @keyframes oc-win-float{
          0%{ transform: translateY(0px); filter: brightness(1); }
          50%{ transform: translateY(-8px); filter: brightness(1.18); }
          100%{ transform: translateY(0px); filter: brightness(1); }
        }
        .oc-game-layout{
          display:grid;
          grid-template-columns: 250px 1fr 250px;
          gap: 12px;
          align-items: start;
        }
        .oc-team-panel{
          border-radius: 18px;
          padding: 12px;
          border: 1px solid rgba(255,255,255,0.16);
          box-shadow: inset 0 0 0 1px rgba(0,0,0,0.42), 0 14px 34px rgba(0,0,0,0.45);
        }
        .oc-team-panel.red{
          border-color: rgba(255,95,95,0.35);
          background: linear-gradient(180deg, rgba(255,95,95,0.14), rgba(0,0,0,0.28));
        }
        .oc-team-panel.blue{
          border-color: rgba(90,140,255,0.38);
          background: linear-gradient(180deg, rgba(90,140,255,0.16), rgba(0,0,0,0.30));
        }
        .oc-member{
          border-radius: 12px;
          padding: 10px;
          border: 1px solid rgba(255,255,255,0.14);
          background: rgba(0,0,0,0.34);
          display: grid;
          gap: 6px;
        }
        @media (max-width: 1120px){
          .oc-game-layout{
            grid-template-columns: 1fr;
          }
        }
      `}</style>
      <div
        className="oc-stage"
        style={{
          width: 'min(1040px, 100%)',
          borderRadius: 26,
          border,
          background: 'linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.015))',
          boxShadow: '0 24px 80px rgba(0,0,0,0.75)',
          padding: 16,
          position: 'relative',
          overflow: 'hidden'
        }}
      >
        <div style={{ position: 'absolute', inset: 10, borderRadius: 18, border: '1px solid rgba(255,255,255,0.06)', pointerEvents: 'none' }} />

        {/* top counters */}
        <div style={{ position: 'relative', zIndex: 2, display: 'flex', justifyContent: 'center', gap: 12, paddingTop: 6, paddingBottom: 14 }}>
          <div style={{ width: 42, height: 42, borderRadius: 999, display: 'grid', placeItems: 'center', fontWeight: 900, border: '1px solid rgba(255,255,255,0.16)', background: 'rgba(120,110,255,0.26)' }} title="Blue remaining">
            {blueLeft}
          </div>

          <div
            style={{
              height: 42,
              minWidth: 140,
              borderRadius: 999,
              padding: '0 12px',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              border: '1px solid rgba(170,255,255,0.40)',
              background: 'rgba(200,255,255,0.10)'
            }}
            title="Guesses / Timer"
          >
            <div style={{ width: 34, height: 28, borderRadius: 999, display: 'grid', placeItems: 'center', fontWeight: 900, background: 'rgba(255,255,255,0.16)' }}>
              {pillCount}
            </div>
            <div style={{ fontWeight: 900, opacity: 0.95 }}>{formatMMSS(turnLeft)}</div>
          </div>

          <div style={{ width: 42, height: 42, borderRadius: 999, display: 'grid', placeItems: 'center', fontWeight: 900, border: '1px solid rgba(255,255,255,0.16)', background: 'rgba(255,95,95,0.22)' }} title="Red remaining">
            {redLeft}
          </div>
        </div>

        <div style={{ position: 'relative', zIndex: 2, padding: '0 10px 10px' }}>
          {state === 'loading' && <div style={{ padding: 12 }}>Loadingâ€¦</div>}
          {state === 'error' && (
            <div style={{ padding: 12, borderRadius: 14, border: '1px solid rgba(255,90,90,0.45)', background: panel }}>
              Error: {error}
            </div>
          )}

          {state === 'ready' && game && (
            <>
              {/* header */}
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ opacity: 0.92, fontWeight: 900 }}>
                    Clue: <span style={{ opacity: 1 }}>{game.clue_word ?? 'â€”'}</span>
                    {game.clue_number !== null ? <span style={{ opacity: 0.85 }}> ({game.clue_number})</span> : null}
                  </div>
                  <div style={{ opacity: 0.78, fontWeight: 800, fontSize: 12 }}>
                    You: {teamLabel(myTeam)} â€¢ {amSpymaster ? 'Spymaster' : 'Operative'} â€¢ streak: {myStreak}
                    {!isGameActive && effectiveWinner ? <span> â€¢ Winner: {teamLabel(effectiveWinner)}</span> : null}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  {amSpymaster && (
                    <div style={{ padding: '8px 10px', borderRadius: 999, border, background: panel, fontWeight: 900, opacity: 0.9 }}>
                      Key: auto visible
                    </div>
                  )}

                  {canEndTurnOperate && (
                    <button onClick={handleEndTurn} disabled={busy !== null} style={{ padding: '10px 14px', borderRadius: 999, border, background: 'rgba(255,255,255,0.10)', color: 'rgba(255,255,255,0.95)', fontWeight: 900, cursor: 'pointer' }}>
                      End turn
                    </button>
                  )}

                  <button onClick={handleStopPlaying} disabled={busy !== null} style={{ padding: '10px 14px', borderRadius: 999, border, background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.90)', fontWeight: 900, cursor: 'pointer' }}>
                    Stop playing
                  </button>

                  {amOwner && (
                    <button onClick={handleRestart} disabled={busy !== null} style={{ padding: '10px 14px', borderRadius: 999, border: '1px solid rgba(170,255,255,0.35)', background: 'rgba(200,255,255,0.10)', color: 'rgba(255,255,255,0.95)', fontWeight: 900, cursor: 'pointer' }}>
                      Restart
                    </button>
                  )}
                </div>
              </div>

              {/* layout */}
              <div className="oc-game-layout">
                <div className="oc-team-panel red">
                  <div style={{ fontWeight: 1000, marginBottom: 10, color: 'rgba(255,220,220,0.98)' }}>Red Team</div>
                  <div style={{ display: 'grid', gap: 8 }}>
                    {redTeam.length === 0 ? (
                      <div style={{ fontSize: 12, opacity: 0.75, fontWeight: 800 }}>No players</div>
                    ) : (
                      redTeam.map((m, idx) => {
                        const you = m.user_id === myUserId
                        return (
                          <div key={`red-${m.user_id}`} className="oc-member">
                            <div style={{ fontWeight: 900 }}>
                              {you ? `You (${memberDisplayName(m.user_id, idx)})` : memberDisplayName(m.user_id, idx)}
                            </div>
                            <div style={{ fontSize: 11, opacity: 0.7 }}>{shortId(m.user_id)}</div>
                            <div style={{ fontSize: 12, opacity: 0.86 }}>
                              {m.is_spymaster ? 'Spymaster' : 'Operative'}
                            </div>
                          </div>
                        )
                      })
                    )}
                  </div>
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.12)' }}>
                    <div style={{ fontSize: 12, opacity: 0.78, fontWeight: 900, marginBottom: 6 }}>Hint Trail</div>
                    <div style={{ display: 'grid', gap: 6 }}>
                      {teamHintLog.red.length === 0 ? (
                        <div style={{ fontSize: 12, opacity: 0.72 }}>—</div>
                      ) : (
                        teamHintLog.red.slice(-3).reverse().map((h) => (
                          <div key={h.id} style={{ fontSize: 12, opacity: 0.9 }}>
                            <b>{h.clue}</b> ({h.number}){' '}
                            {h.words.length
                              ? `• ${h.words.map((w) => `${w.word} ${w.correct ? '✓' : '✗'}`).join(', ')}`
                              : '• no reveals yet'}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>

                <div>
                  {canSpymaster && (
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12, padding: 12, borderRadius: 18, border, background: panel }}>
                      <input
                        value={clueWord}
                        onChange={(e) => setClueWord(e.target.value)}
                        placeholder="clue word"
                        style={{ flex: '1 1 220px', padding: '12px 12px', borderRadius: 14, border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(0,0,0,0.35)', color: 'rgba(255,255,255,0.92)', fontWeight: 900, outline: 'none' }}
                      />
                      <input
                        type="number"
                        value={clueNumber}
                        onChange={(e) => setClueNumber(Number(e.target.value))}
                        min={0}
                        max={9}
                        style={{ width: 110, padding: '12px 12px', borderRadius: 14, border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(0,0,0,0.35)', color: 'rgba(255,255,255,0.92)', fontWeight: 900, outline: 'none' }}
                      />
                      <button onClick={handleSetClue} disabled={busy !== null || clueWord.trim().length === 0} style={{ padding: '12px 16px', borderRadius: 14, border: '1px solid rgba(170,255,255,0.35)', background: 'rgba(200,255,255,0.10)', color: 'rgba(255,255,255,0.95)', fontWeight: 900, cursor: 'pointer' }}>
                        Set clue
                      </button>
                    </div>
                  )}

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 10 }}>
                    {cards.map((c, idx) => {
                      const hidden = amSpymaster ? keyMap.get(c.pos) : undefined
                      const corner = hidden ? keyColorText(hidden) : null
                      const fxClass = fxClassFor(c.pos)
                      const pendingClass = pendingRevealPos === c.pos ? 'oc-card-pending' : ''
                      const peekClass = peekFlash?.pos === c.pos ? 'oc-card-peek' : ''
                      const interactiveClass = !c.revealed ? 'oc-card-interactive' : ''
                      const revealedClass = c.revealed ? 'oc-card-is-revealed' : ''
                      return (
                        <button
                          key={c.pos}
                          className={`oc-card ${interactiveClass} ${pendingClass} ${peekClass} ${revealedClass} ${fxClass}`.trim()}
                          onClick={() => handleReveal(c.pos)}
                          disabled={busy !== null || pendingRevealPos !== null || c.revealed || !isGameActive}
                          style={{
                            position: 'relative',
                            height: 92,
                            borderRadius: 16,
                            border: '1px solid rgba(255,255,255,0.10)',
                            background: cardBg(c, hidden),
                            boxShadow: '0 10px 26px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(0,0,0,0.50)',
                            color: 'rgba(240,244,255,0.92)',
                            cursor: c.revealed || pendingRevealPos !== null || !isGameActive ? 'not-allowed' : 'pointer',
                            overflow: 'hidden',
                            animationDelay: `${idx * 55}ms`
                          }}
                          title={c.word}
                        >
                          {corner && (
                            <div style={{ position: 'absolute', right: 10, top: 10, width: 22, height: 22, borderRadius: 999, display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 900, border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(0,0,0,0.25)', opacity: 0.9 }}>
                              {corner}
                            </div>
                          )}
                          {peekFlash?.pos === c.pos && (
                            <div style={{ position: 'absolute', left: 8, top: 8, padding: '2px 6px', borderRadius: 8, border: '1px solid rgba(255,225,120,0.78)', background: 'rgba(255,225,120,0.24)', color: 'rgba(255,245,185,0.98)', fontSize: 11, fontWeight: 900 }}>
                              {peekFlash.color || 'PEEK'}
                            </div>
                          )}
                          <div className="oc-word" style={{ height: '100%', display: 'grid', placeItems: 'center', padding: '0 10px', textAlign: 'center', fontWeight: 900, letterSpacing: 0.3, textTransform: 'uppercase', opacity: c.revealed ? 0.85 : 0.95 }}>
                            {c.word}
                          </div>
                        </button>
                      )
                    })}
                  </div>

                  <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div style={{ padding: 12, borderRadius: 18, border, background: panel }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                        <div style={{ fontWeight: 900 }}>Dice</div>
                        <div style={{ fontSize: 12, opacity: 0.75, fontWeight: 800 }}>
                          {diceUnlocked ? (diceUsed ? 'Used turn' : 'Ready') : `Streak ${roundCorrectStreak}/3`}
                        </div>
                      </div>

                      <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
                        <button disabled={!isGameActive || !diceUnlocked || diceUsed || busy !== null} onClick={handleRollDice} style={{ padding: '10px 12px', borderRadius: 14, border, background: 'rgba(255,255,255,0.06)', color: '#fff', fontWeight: 900, cursor: 'pointer', opacity: !isGameActive || !diceUnlocked || diceUsed ? 0.55 : 1 }}>
                          Roll Dice
                        </button>
                        <div style={{ fontSize: 12, opacity: 0.82, fontWeight: 800 }}>
                          {rolledDiceOption ? `Last roll: ${diceOptionLabel(rolledDiceOption)}` : 'Roll to get a random dice power.'}
                        </div>
                      </div>
                    </div>

                    <div style={{ padding: 12, borderRadius: 18, border, background: panel }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                      <div style={{ fontWeight: 900 }}>Helper Actions</div>
                      <div style={{ fontSize: 12, opacity: 0.75, fontWeight: 800 }}>each once per game</div>
                    </div>

                    <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
                      <button disabled={!isGameActive || busy !== null} onClick={() => runHelper('time_cut')} style={{ padding: '10px 12px', borderRadius: 14, border, background: 'rgba(255,255,255,0.06)', color: '#fff', fontWeight: 900, cursor: 'pointer', opacity: !isGameActive ? 0.55 : 1 }}>
                        Time Cut
                      </button>
                      <button disabled={!isGameActive || busy !== null} onClick={() => runHelper('random_peek')} style={{ padding: '10px 12px', borderRadius: 14, border, background: 'rgba(255,255,255,0.06)', color: '#fff', fontWeight: 900, cursor: 'pointer', opacity: !isGameActive ? 0.55 : 1 }}>
                        Random Peek
                      </button>
                      <button disabled={!isGameActive || busy !== null} onClick={() => runHelper('shuffle_unrevealed')} style={{ padding: '10px 12px', borderRadius: 14, border, background: 'rgba(255,255,255,0.06)', color: '#fff', fontWeight: 900, cursor: 'pointer', opacity: !isGameActive ? 0.55 : 1 }}>
                        Card Shuffle
                      </button>
                    </div>
                    <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.10)' }}>
                      <div style={{ fontWeight: 900, marginBottom: 8 }}>Your Peeks</div>
                      {myPeeks.length === 0 ? (
                        <div style={{ fontSize: 12, opacity: 0.75, fontWeight: 800 }}>â€”</div>
                      ) : (
                        <div style={{ display: 'grid', gap: 6 }}>
                          {myPeeks.slice(-5).reverse().map((p, idx) => (
                            <div key={`${p.pos}-${idx}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12, opacity: 0.9, fontWeight: 900 }}>
                              <span>pos {p.pos}</span>
                              <span>{p.color.toUpperCase()}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                </div>

                <div className="oc-team-panel blue">
                  <div style={{ fontWeight: 1000, marginBottom: 10, color: 'rgba(220,230,255,0.98)' }}>Blue Team</div>
                  <div style={{ display: 'grid', gap: 8 }}>
                    {blueTeam.length === 0 ? (
                      <div style={{ fontSize: 12, opacity: 0.75, fontWeight: 800 }}>No players</div>
                    ) : (
                      blueTeam.map((m, idx) => {
                        const you = m.user_id === myUserId
                        return (
                          <div key={`blue-${m.user_id}`} className="oc-member">
                            <div style={{ fontWeight: 900 }}>
                              {you ? `You (${memberDisplayName(m.user_id, idx)})` : memberDisplayName(m.user_id, idx)}
                            </div>
                            <div style={{ fontSize: 11, opacity: 0.7 }}>{shortId(m.user_id)}</div>
                            <div style={{ fontSize: 12, opacity: 0.86 }}>
                              {m.is_spymaster ? 'Spymaster' : 'Operative'}
                            </div>
                          </div>
                        )
                      })
                    )}
                  </div>
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.12)' }}>
                    <div style={{ fontSize: 12, opacity: 0.78, fontWeight: 900, marginBottom: 6 }}>Hint Trail</div>
                    <div style={{ display: 'grid', gap: 6 }}>
                      {teamHintLog.blue.length === 0 ? (
                        <div style={{ fontSize: 12, opacity: 0.72 }}>—</div>
                      ) : (
                        teamHintLog.blue.slice(-3).reverse().map((h) => (
                          <div key={h.id} style={{ fontSize: 12, opacity: 0.9 }}>
                            <b>{h.clue}</b> ({h.number}){' '}
                            {h.words.length
                              ? `• ${h.words.map((w) => `${w.word} ${w.correct ? '✓' : '✗'}`).join(', ')}`
                              : '• no reveals yet'}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {!isGameActive && effectiveWinner && (
          <div className="oc-win-overlay">
            <div className="oc-win-card">
              <div className="oc-win-title">{teamLabel(effectiveWinner)} Team Wins</div>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
                {amOwner ? (
                  <button
                    onClick={handleRestart}
                    disabled={busy !== null}
                    style={{ padding: '10px 14px', borderRadius: 12, border: '1px solid rgba(170,255,255,0.42)', background: 'rgba(200,255,255,0.12)', color: '#fff', fontWeight: 900, cursor: 'pointer' }}
                  >
                    Start New Lobby
                  </button>
                ) : (
                  <div style={{ opacity: 0.82, fontWeight: 800, paddingTop: 8 }}>Waiting for owner to start new lobby</div>
                )}
                <button
                  onClick={() => setShowWinTrail((v) => !v)}
                  style={{ padding: '10px 14px', borderRadius: 12, border: '1px solid rgba(255,255,255,0.24)', background: 'rgba(255,255,255,0.10)', color: '#fff', fontWeight: 900, cursor: 'pointer' }}
                >
                  {showWinTrail ? 'Hide Hint Trail' : 'Read Hint Trail'}
                </button>
              </div>

              {showWinTrail && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div style={{ padding: 10, borderRadius: 12, border: '1px solid rgba(255,95,95,0.34)', background: 'rgba(255,95,95,0.10)' }}>
                    <div style={{ fontWeight: 900, marginBottom: 6 }}>Red Trail</div>
                    {teamHintLog.red.length === 0 ? (
                      <div style={{ fontSize: 12, opacity: 0.74 }}>—</div>
                    ) : (
                      teamHintLog.red.slice(-6).reverse().map((h) => (
                        <div key={`win-r-${h.id}`} style={{ fontSize: 12, marginBottom: 4 }}>
                          <b>{h.clue}</b> ({h.number}){' '}
                          {h.words.length ? `• ${h.words.map((w) => `${w.word} ${w.correct ? '✓' : '✗'}`).join(', ')}` : '• no reveals yet'}
                        </div>
                      ))
                    )}
                  </div>
                  <div style={{ padding: 10, borderRadius: 12, border: '1px solid rgba(90,140,255,0.36)', background: 'rgba(90,140,255,0.10)' }}>
                    <div style={{ fontWeight: 900, marginBottom: 6 }}>Blue Trail</div>
                    {teamHintLog.blue.length === 0 ? (
                      <div style={{ fontSize: 12, opacity: 0.74 }}>—</div>
                    ) : (
                      teamHintLog.blue.slice(-6).reverse().map((h) => (
                        <div key={`win-b-${h.id}`} style={{ fontSize: 12, marginBottom: 4 }}>
                          <b>{h.clue}</b> ({h.number}){' '}
                          {h.words.length ? `• ${h.words.map((w) => `${w.word} ${w.correct ? '✓' : '✗'}`).join(', ')}` : '• no reveals yet'}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {centerNotice && (
          <div className={`oc-center-notice ${centerNotice.tone}`} key={centerNotice.id}>
            {centerNotice.text}
          </div>
        )}

        {busy && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,0.60)', zIndex: 10 }}>
            <div style={{ padding: 16, borderRadius: 14, border, background: 'rgba(0,0,0,0.35)', fontWeight: 900 }}>{busy}</div>
          </div>
        )}
      </div>
    </div>
  )
}


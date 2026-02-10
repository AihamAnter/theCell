import { useEffect, useState } from 'react'
import type { Lobby } from '../lib/lobbies'
import { loadLobbyForSettings, saveLobbySettings, type LobbySettingsForm } from '../lib/lobbySettings'
import { supabase } from '../lib/supabaseClient'

type Props = {
  lobbyCode: string
  onBackToHome: () => void
  onBackToGame: () => void
}

type LoadState = 'loading' | 'ready' | 'saving' | 'error'

function supaErr(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const e = err as any
    const msg = typeof e.message === 'string' ? e.message : 'Unknown error'
    const details = typeof e.details === 'string' ? e.details : ''
    const hint = typeof e.hint === 'string' ? e.hint : ''
    const code = typeof e.code === 'string' ? e.code : ''
    const extra = [code && `code=${code}`, details && `details=${details}`, hint && `hint=${hint}`].filter(Boolean).join(' | ')
    return extra ? `${msg} (${extra})` : msg
  }
  return 'Unknown error'
}

export default function SettingsPage({ lobbyCode, onBackToHome, onBackToGame }: Props) {
  const code = lobbyCode.trim().toUpperCase()

  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)

  const [lobby, setLobby] = useState<Lobby | null>(null)
  const [isOwner, setIsOwner] = useState(false)

  const [form, setForm] = useState<LobbySettingsForm>({
    name: 'Lobby',
    mode: 'classic',
    maxPlayers: 8,
    boardSize: 25
  })

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        setState('loading')
        setError(null)

        if (!code) throw new Error('Missing lobby code')

        const l = await loadLobbyForSettings(code)
        if (cancelled) return
        setLobby(l)

        const { data: sessionData, error: sessionErr } = await supabase.auth.getSession()
        if (sessionErr) throw sessionErr

        const uid = sessionData.session?.user?.id ?? null
        setIsOwner(uid !== null && uid === l.owner_id)

        const mode = (l.settings?.mode === 'powers' ? 'powers' : 'classic') as 'classic' | 'powers'

        setForm({
          name: l.name ?? 'Lobby',
          mode,
          maxPlayers: l.max_players ?? 8,
          boardSize: l.board_size ?? 25
        })

        setState('ready')
      } catch (err) {
        console.error('[settings] load failed:', err)
        if (!cancelled) {
          setError(err instanceof Error ? err.message : supaErr(err))
          setState('error')
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [code])

  async function handleSave() {
    if (!lobby) return
    try {
      setState('saving')
      setError(null)

      await saveLobbySettings(lobby.id, form)

      const refreshed = await loadLobbyForSettings(code)
      setLobby(refreshed)

      setState('ready')
    } catch (err) {
      console.error('[settings] save failed:', err)
      setError(err instanceof Error ? err.message : supaErr(err))
      setState('error')
    }
  }

  return (
    <div style={{ minHeight: '100vh', padding: 16, background: '#0b0b0f', color: '#fff' }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button onClick={onBackToHome}>Back Home</button>
        <button onClick={onBackToGame}>Back Lobby</button>
      </div>

      <h2 style={{ marginBottom: 8 }}>Settings</h2>

      {state === 'loading' && <p>Loading…</p>}

      {error && (
        <div style={{ marginTop: 12, padding: 12, border: '1px solid #ff4d4f', borderRadius: 8 }}>
          <p style={{ margin: 0 }}>Error: {error}</p>
        </div>
      )}

      {lobby && (
        <div style={{ marginTop: 12, padding: 12, border: '1px solid #2a2a35', borderRadius: 8, maxWidth: 520 }}>
          <p style={{ marginTop: 0, opacity: 0.9 }}>
            Lobby: <b>{lobby.code}</b> • Owner: <b>{isOwner ? 'you' : 'no'}</b>
          </p>

          <div style={{ display: 'grid', gap: 10 }}>
            <label style={{ display: 'grid', gap: 6 }}>
              <span>Name</span>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                style={{ padding: 10, borderRadius: 8, border: '1px solid #2a2a35', background: '#111118', color: '#fff' }}
                disabled={!isOwner || state === 'saving'}
              />
            </label>

            <label style={{ display: 'grid', gap: 6 }}>
              <span>Mode</span>
              <select
                value={form.mode}
                onChange={(e) => setForm({ ...form, mode: e.target.value as 'classic' | 'powers' })}
                style={{ padding: 10, borderRadius: 8, border: '1px solid #2a2a35', background: '#111118', color: '#fff' }}
                disabled={!isOwner || state === 'saving'}
              >
                <option value="classic">classic</option>
                <option value="powers">powers</option>
              </select>
            </label>

            <label style={{ display: 'grid', gap: 6 }}>
              <span>Max players (2..32)</span>
              <input
                type="number"
                value={form.maxPlayers}
                onChange={(e) => setForm({ ...form, maxPlayers: Number(e.target.value) })}
                style={{ padding: 10, borderRadius: 8, border: '1px solid #2a2a35', background: '#111118', color: '#fff' }}
                disabled={!isOwner || state === 'saving'}
              />
            </label>

            <label style={{ display: 'grid', gap: 6 }}>
              <span>Board size (9..100)</span>
              <input
                type="number"
                value={form.boardSize}
                onChange={(e) => setForm({ ...form, boardSize: Number(e.target.value) })}
                style={{ padding: 10, borderRadius: 8, border: '1px solid #2a2a35', background: '#111118', color: '#fff' }}
                disabled={!isOwner || state === 'saving'}
              />
            </label>

            {!isOwner && (
              <div style={{ padding: 10, borderRadius: 8, border: '1px solid #2a2a35', opacity: 0.85 }}>
                Only the lobby owner can edit settings.
              </div>
            )}

            <button onClick={handleSave} disabled={!isOwner || state === 'saving'} style={{ padding: 10, borderRadius: 8 }}>
              {state === 'saving' ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

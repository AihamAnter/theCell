import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { createLobby, joinLobby } from '../lib/lobbies'

type LoadState = 'loading' | 'ready' | 'error'

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

function readStr(key: string): string {
  try {
    return (localStorage.getItem(key) ?? '').trim()
  } catch {
    return ''
  }
}

function writeStr(key: string, val: string) {
  try {
    localStorage.setItem(key, (val ?? '').trim())
  } catch {
    // ignore
  }
}

function clearKey(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

export default function HomeRoute() {
  const navigate = useNavigate()

  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)

  const [joinCode, setJoinCode] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const lastLobbyCode = useMemo(() => readStr('oneclue_last_lobby_code'), [])

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        setState('loading')
        setError(null)

        const { data, error: sessionErr } = await supabase.auth.getSession()
        if (sessionErr) throw sessionErr
        if (!data.session?.user?.id) throw new Error('No session')

        setState('ready')

        // auto rejoin if we have one
        if (lastLobbyCode) {
          // small delay so UI paints
          setTimeout(() => {
            if (!cancelled) navigate(`/lobby/${lastLobbyCode}`)
          }, 10)
        }
      } catch (err) {
        console.error('[home] failed:', err)
        if (!cancelled) {
          setError(err instanceof Error ? err.message : supaErr(err))
          setState('error')
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [navigate, lastLobbyCode])

  async function handleCreate() {
    try {
      setBusy('Creating lobby…')
      const { lobbyCode } = await createLobby()
      writeStr('oneclue_last_lobby_code', lobbyCode)
      navigate(`/lobby/${lobbyCode}`)
    } catch (err) {
      console.error('[home] create failed:', err)
      alert(err instanceof Error ? err.message : supaErr(err))
    } finally {
      setBusy(null)
    }
  }

  async function handleJoin() {
    const code = joinCode.trim().toUpperCase()
    if (!code) return

    try {
      setBusy('Joining lobby…')
      await joinLobby(code)
      writeStr('oneclue_last_lobby_code', code)
      navigate(`/lobby/${code}`)
    } catch (err) {
      console.error('[home] join failed:', err)
      alert(err instanceof Error ? err.message : supaErr(err))
    } finally {
      setBusy(null)
    }
  }

  function handleForgetLast() {
    clearKey('oneclue_last_lobby_code')
    alert('Forgot last lobby.')
    // don't navigate; user stays on home
  }

  if (state === 'loading') {
    return (
      <div style={{ minHeight: '100vh', background: '#0b0b0f', color: '#fff', padding: 16 }}>
        <h2 style={{ marginTop: 0 }}>OneClue</h2>
        <p>Loading…</p>
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div style={{ minHeight: '100vh', background: '#0b0b0f', color: '#fff', padding: 16 }}>
        <h2 style={{ marginTop: 0 }}>OneClue</h2>
        <div style={{ padding: 12, border: '1px solid #ff4d4f', borderRadius: 10 }}>
          <div style={{ fontWeight: 900 }}>Error</div>
          <div style={{ marginTop: 6, opacity: 0.9 }}>{error}</div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: '#0b0b0f', color: '#fff', padding: 16 }}>
      <h2 style={{ marginTop: 0 }}>OneClue</h2>

      {lastLobbyCode && (
        <div style={{ marginTop: 10, padding: 12, border: '1px solid #2a2a35', borderRadius: 12, background: '#111118' }}>
          <div style={{ fontWeight: 900 }}>Last lobby</div>
          <div style={{ marginTop: 6, opacity: 0.9 }}>
            Code: <b>{lastLobbyCode}</b>
          </div>
          <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => navigate(`/lobby/${lastLobbyCode}`)}>Rejoin</button>
            <button onClick={handleForgetLast}>Forget</button>
          </div>
        </div>
      )}

      <div style={{ marginTop: 12, padding: 12, border: '1px solid #2a2a35', borderRadius: 12, background: '#111118' }}>
        <div style={{ fontWeight: 900 }}>Create</div>
        <div style={{ marginTop: 10 }}>
          <button onClick={handleCreate} disabled={busy !== null}>
            Create lobby
          </button>
        </div>
      </div>

      <div style={{ marginTop: 12, padding: 12, border: '1px solid #2a2a35', borderRadius: 12, background: '#111118' }}>
        <div style={{ fontWeight: 900 }}>Join</div>
        <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
            placeholder="LOBBY CODE"
            style={{
              padding: 10,
              borderRadius: 10,
              border: '1px solid #2a2a35',
              background: '#0d0d14',
              color: '#fff',
              fontFamily: 'monospace',
              letterSpacing: 1,
              width: 200
            }}
          />
          <button onClick={handleJoin} disabled={busy !== null || joinCode.trim().length === 0}>
            Join
          </button>
        </div>
      </div>

      {busy && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'grid',
            placeItems: 'center',
            color: '#fff',
            zIndex: 9999
          }}
        >
          <div style={{ padding: 16, borderRadius: 12, border: '1px solid #2a2a35', background: '#111118' }}>{busy}</div>
        </div>
      )}
    </div>
  )
}

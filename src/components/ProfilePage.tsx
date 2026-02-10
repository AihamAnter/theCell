import { useEffect, useState } from 'react'
import { getMyProfile, updateMyProfile, type Profile } from '../lib/profile'

type Props = {
  onBackToHome: () => void
  onBackToGame: () => void
}

type LoadState = 'idle' | 'loading' | 'ready' | 'saving' | 'error'

export default function ProfilePage({ onBackToHome, onBackToGame }: Props) {
  const [state, setState] = useState<LoadState>('idle')
  const [error, setError] = useState<string | null>(null)

  const [profile, setProfile] = useState<Profile | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [bio, setBio] = useState('')

  useEffect(() => {
    let cancelled = false
    setState('loading')
    setError(null)

    ;(async () => {
      try {
        const p = await getMyProfile()
        if (cancelled) return
        setProfile(p)
        setDisplayName(p.display_name ?? '')
        setBio(p.bio ?? '')
        setState('ready')
      } catch (err) {
        console.error('[profile] load failed:', err)
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load profile')
          setState('error')
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  const canSave = state === 'ready' && displayName.trim().length > 0

  async function handleSave() {
    try {
      setState('saving')
      setError(null)
      await updateMyProfile({ display_name: displayName, bio })
      const updated = await getMyProfile()
      setProfile(updated)
      setState('ready')
    } catch (err) {
      console.error('[profile] save failed:', err)
      setError(err instanceof Error ? err.message : 'Failed to save profile')
      setState('error')
    }
  }

  return (
    <div style={{ minHeight: '100vh', padding: 16, background: '#0b0b0f', color: '#fff' }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button onClick={onBackToHome}>Back Home</button>
        <button onClick={onBackToGame}>Back Game</button>
      </div>

      <h2 style={{ marginBottom: 8 }}>Profile</h2>

      {state === 'loading' && <p>Loading…</p>}

      {error && (
        <div style={{ marginTop: 12, padding: 12, border: '1px solid #ff4d4f', borderRadius: 8 }}>
          <p style={{ margin: 0 }}>Error: {error}</p>
        </div>
      )}

      {profile && (
        <div style={{ marginTop: 12, padding: 12, border: '1px solid #2a2a35', borderRadius: 8 }}>
          <p style={{ marginTop: 0, opacity: 0.8 }}>
            User ID: <span style={{ fontFamily: 'monospace' }}>{profile.user_id}</span>
          </p>

          <div style={{ display: 'grid', gap: 10, maxWidth: 520 }}>
            <label style={{ display: 'grid', gap: 6 }}>
              <span>Display name</span>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your name"
                style={{ padding: 10, borderRadius: 8, border: '1px solid #2a2a35', background: '#111118', color: '#fff' }}
              />
            </label>

            <label style={{ display: 'grid', gap: 6 }}>
              <span>Bio</span>
              <textarea
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder="Short bio"
                rows={4}
                style={{ padding: 10, borderRadius: 8, border: '1px solid #2a2a35', background: '#111118', color: '#fff' }}
              />
            </label>

            <button onClick={handleSave} disabled={!canSave} style={{ padding: 10, borderRadius: 8 }}>
              {state === 'saving' ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

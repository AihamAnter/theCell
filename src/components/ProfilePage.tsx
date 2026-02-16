import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import i18n from '../i18n'
import { getMyProfile, updateMyProfile, type Profile } from '../lib/profile'
import { getMostTeammate, getWinLossRatio, readPlayerStatsFromPreferences, type PlayerStats } from '../lib/playerStats'

type Props = {
  onBackToHome: () => void
  onBackToGame: () => void
}

type LoadState = 'loading' | 'ready' | 'saving' | 'error'

type ProfilePrefs = {
  username?: string
  language?: string
  region?: string
  teamColor?: 'Blue' | 'Red' | 'Auto' | string
  showOnline?: boolean
  allowInvites?: boolean
  publicProfile?: boolean
  emailUpdates?: boolean
  gameAlerts?: boolean
  darkPanels?: boolean
}

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function asStr(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}

function downloadJson(filename: string, obj: unknown) {
  const text = JSON.stringify(obj, null, 2)
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)

  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()

  URL.revokeObjectURL(url)
}

export default function ProfilePage({ onBackToHome, onBackToGame }: Props) {
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [profile, setProfile] = useState<Profile | null>(null)
  const [stats, setStats] = useState<PlayerStats | null>(null)
  const [email, setEmail] = useState<string>('')

  // Basic Info
  const [displayName, setDisplayName] = useState('')
  const [username, setUsername] = useState('')
  const [bio, setBio] = useState('')
  const [avatarUrl, setAvatarUrl] = useState('')

  // Preferences
  const [language, setLanguage] = useState<'Arabic' | 'English'>('English')
  void i18n.changeLanguage(language === 'Arabic' ? 'ar' : 'en')

  const [region, setRegion] = useState<'Middle East' | 'Europe' | 'North America'>('Middle East')
  const [teamColor, setTeamColor] = useState<'Blue' | 'Red' | 'Auto'>('Auto')
  const [darkPanels, setDarkPanels] = useState(true)

  // Privacy
  const [publicProfile, setPublicProfile] = useState(false)
  const [showOnline, setShowOnline] = useState(true)
  const [allowInvites, setAllowInvites] = useState(true)

  // Notifications
  const [emailUpdates, setEmailUpdates] = useState(true)
  const [gameAlerts, setGameAlerts] = useState(true)

  const canSave = useMemo(() => {
    if (state !== 'ready') return false
    return displayName.trim().length > 0
  }, [state, displayName])

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        setState('loading')
        setError(null)
        setNotice(null)

        const { data: sessionData, error: sessionErr } = await supabase.auth.getSession()
        if (sessionErr) throw sessionErr

        const sessionEmail = sessionData.session?.user?.email ?? ''
        if (!cancelled) setEmail(sessionEmail)

        const p = await getMyProfile()
        if (cancelled) return

        const prefs = (p.preferences ?? {}) as ProfilePrefs

        setProfile(p)
        setStats(readPlayerStatsFromPreferences(p.preferences))
        setDisplayName(p.display_name ?? '')
        setBio(p.bio ?? '')
        setAvatarUrl(p.avatar_url ?? '')

        setUsername(asStr(prefs.username, ''))
        setLanguage((asStr(prefs.language, 'English') as any) === 'Arabic' ? 'Arabic' : 'English')
        void i18n.changeLanguage(
  (asStr(prefs.language, 'English') as any) === 'Arabic' ? 'ar' : 'en'
)

        setRegion((asStr(prefs.region, 'Middle East') as any) || 'Middle East')
        setTeamColor((asStr(prefs.teamColor, 'Auto') as any) || 'Auto')

        setDarkPanels(asBool(prefs.darkPanels, true))

        setPublicProfile(asBool(prefs.publicProfile, false))
        setShowOnline(asBool(prefs.showOnline, true))
        setAllowInvites(asBool(prefs.allowInvites, true))

        setEmailUpdates(asBool(prefs.emailUpdates, true))
        setGameAlerts(asBool(prefs.gameAlerts, true))

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

  async function handleSave() {
    if (!profile) return
    if (!canSave) return

    try {
      setState('saving')
      setError(null)
      setNotice(null)

      const nextPrefs: ProfilePrefs = {
        ...(profile.preferences ?? {}),
        username: username.trim() || undefined,
        language,
        region,
        teamColor,
        darkPanels,
        publicProfile,
        showOnline,
        allowInvites,
        emailUpdates,
        gameAlerts
      }

      await updateMyProfile({
        display_name: displayName,
        bio,
        avatar_url: avatarUrl,
        preferences: nextPrefs as Record<string, unknown>
      })

      const updated = await getMyProfile()
      setProfile(updated)
      setStats(readPlayerStatsFromPreferences(updated.preferences))
      setNotice('Saved')
      setState('ready')
    } catch (err) {
      console.error('[profile] save failed:', err)
      setError(err instanceof Error ? err.message : 'Failed to save profile')
      setState('error')
    }
  }

  async function handleChangePassword() {
    const p1 = window.prompt('New password:')
    if (!p1) return
    const p2 = window.prompt('Repeat new password:')
    if (!p2) return
    if (p1 !== p2) {
      setNotice('Passwords do not match')
      return
    }
    if (p1.length < 8) {
      setNotice('Password must be at least 8 characters')
      return
    }

    try {
      setNotice(null)
      const { error } = await supabase.auth.updateUser({ password: p1 })
      if (error) throw error
      setNotice('Password updated')
    } catch (err) {
      console.error('[profile] change password failed:', err)
      setNotice(err instanceof Error ? err.message : 'Failed to change password')
    }
  }

  async function handleActiveSession() {
    try {
      const { data, error } = await supabase.auth.getSession()
      if (error) throw error
      const s = data.session
      if (!s) {
        setNotice('No active session')
        return
      }
      const exp = s.expires_at ? new Date(s.expires_at * 1000).toISOString() : 'unknown'
      setNotice(`Signed in as: ${s.user?.email ?? 'unknown'} | expires: ${exp}`)
    } catch (err) {
      console.error('[profile] session read failed:', err)
      setNotice(err instanceof Error ? err.message : 'Failed to read session')
    }
  }

  function handleExport() {
    const payload = {
      exported_at: new Date().toISOString(),
      email,
      profile: profile ?? null
    }
    downloadJson('oneclue-profile-export.json', payload)
  }

  const mostTeammate = useMemo(() => (stats ? getMostTeammate(stats) : null), [stats])
  const winLossRatio = useMemo(() => (stats ? getWinLossRatio(stats) : '0.00'), [stats])

  return (
    <div className="profileScene">
      <div className="profileFrame">
        <header className="profileHeader">
          <div>
            <div className="profileEyebrow">Account Center</div>
            <h1 className="profileTitle">Profile</h1>
            <p className="profileSubtitle">Manage identity, game preferences, privacy, and account security.</p>
            {profile && (
              <p className="profileSubtitle" style={{ marginTop: 8, opacity: 0.85 }}>
                User ID: <span style={{ fontFamily: 'monospace' }}>{profile.user_id}</span>
              </p>
            )}
            {notice && (
              <p className="profileSubtitle" style={{ marginTop: 8, opacity: 0.95 }}>
                {notice}
              </p>
            )}
          </div>

          <div className="profileHeaderActions">
            <button className="homeBtnGhost" type="button" onClick={onBackToHome}>
              Back To Lobby
            </button>
            <button className="homeBtnPrimary" type="button" onClick={onBackToGame}>
              Return To Game
            </button>
          </div>
        </header>

        {state === 'loading' && <p className="profileSubtitle">Loading…</p>}

        {state === 'error' && error && (
          <div style={{ padding: 12, borderRadius: 12, border: '1px solid rgba(226,59,59,.35)', background: 'rgba(0,0,0,.25)' }}>
            <p style={{ margin: 0, fontWeight: 900 }}>Error</p>
            <p style={{ margin: '6px 0 0 0', opacity: 0.9 }}>{error}</p>
          </div>
        )}

        {profile && (
          <div className="profileGrid">
            <section className="profileCard">
              <h2>Basic Info</h2>
              <div className="profileFields">
                <label>
                  Display Name
                  <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Your name" />
                </label>

                <label>
                  Username
                  <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="nickname" />
                </label>

                <label>
                  Email
                  <input value={email} disabled placeholder="email" />
                </label>

                <label>
                  Avatar URL
                  <input value={avatarUrl} onChange={(e) => setAvatarUrl(e.target.value)} placeholder="https://…" />
                </label>

                <label className="isWide">
                  Bio
                  <textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={3} placeholder="Short bio" />
                </label>
              </div>
            </section>

            <section className="profileCard">
              <h2>Game Preferences</h2>
              <div className="profileFields">
                <label>
                  Language
                  <select
  value={language}
  onChange={(e) => {
    const v = e.target.value as any
    setLanguage(v)
    void i18n.changeLanguage(v === 'Arabic' ? 'ar' : 'en')
  }}
>
                    
                    <option>Arabic</option>
                    <option>English</option>
                  </select>
                </label>

                <label>
                  Region
                  <select value={region} onChange={(e) => setRegion(e.target.value as any)}>
                    <option>Middle East</option>
                    <option>Europe</option>
                    <option>North America</option>
                  </select>
                </label>

                <label>
                  Preferred Team
                  <select value={teamColor} onChange={(e) => setTeamColor(e.target.value as any)}>
                    <option>Blue</option>
                    <option>Red</option>
                    <option>Auto</option>
                  </select>
                </label>

                <label className="toggleRow">
                  <span>Use Dark Panels</span>
                  <input type="checkbox" checked={darkPanels} onChange={(e) => setDarkPanels(e.target.checked)} />
                </label>
              </div>
            </section>

            <section className="profileCard">
              <h2>Privacy</h2>
              <div className="profileToggles">
                <label className="toggleRow">
                  <span>Public Profile</span>
                  <input type="checkbox" checked={publicProfile} onChange={(e) => setPublicProfile(e.target.checked)} />
                </label>
                <label className="toggleRow">
                  <span>Show Online Status</span>
                  <input type="checkbox" checked={showOnline} onChange={(e) => setShowOnline(e.target.checked)} />
                </label>
                <label className="toggleRow">
                  <span>Allow Lobby Invites</span>
                  <input type="checkbox" checked={allowInvites} onChange={(e) => setAllowInvites(e.target.checked)} />
                </label>
              </div>
            </section>

            <section className="profileCard">
              <h2>Notifications</h2>
              <div className="profileToggles">
                <label className="toggleRow">
                  <span>Email Updates</span>
                  <input type="checkbox" checked={emailUpdates} onChange={(e) => setEmailUpdates(e.target.checked)} />
                </label>
                <label className="toggleRow">
                  <span>Game Alerts</span>
                  <input type="checkbox" checked={gameAlerts} onChange={(e) => setGameAlerts(e.target.checked)} />
                </label>
              </div>
            </section>

            <section className="profileCard">
              <h2>Game Statistics</h2>
              <div className="profileFields">
                <label>
                  Games Played
                  <input value={String(stats?.games_played ?? 0)} disabled />
                </label>
                <label>
                  Times Won
                  <input value={String(stats?.times_won ?? 0)} disabled />
                </label>
                <label>
                  Times Lost
                  <input value={String(stats?.times_lost ?? 0)} disabled />
                </label>
                <label>
                  Win/Loss Ratio
                  <input value={winLossRatio} disabled />
                </label>
                <label className="isWide">
                  Most Teammate
                  <input
                    value={
                      mostTeammate ? `${mostTeammate.name} (${mostTeammate.games} games)` : 'No teammate data yet'
                    }
                    disabled
                  />
                </label>
              </div>
            </section>

            <section className="profileCard">
              <h2>Security</h2>
              <div className="profileBtnStack">
                <button className="homeBtnGhost" type="button" onClick={handleChangePassword}>
                  Change Password
                </button>
                <button
                  className="homeBtnGhost"
                  type="button"
                  onClick={() => setNotice('2FA needs Supabase MFA setup. We can add it later with MFA enrollment APIs.')}
                >
                  Manage 2FA
                </button>
                <button className="homeBtnGhost" type="button" onClick={handleActiveSession}>
                  Active Session
                </button>
              </div>
            </section>

            <section className="profileCard">
              <h2>Account Actions</h2>
              <div className="profileBtnStack">
                <button className="homeBtnPrimary" type="button" onClick={handleSave} disabled={!canSave || state === 'saving'}>
                  {state === 'saving' ? 'Saving…' : 'Save Changes'}
                </button>
                <button className="homeBtnGhost" type="button" onClick={handleExport}>
                  Export Data
                </button>
                <button
                  className="profileDanger"
                  type="button"
                  onClick={() =>
                    setNotice(
                      'Delete Account needs a server-side admin action (Supabase auth user deletion). If you want it, we can add an RPC/Edge Function later.'
                    )
                  }
                >
                  Delete Account
                </button>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  )
}

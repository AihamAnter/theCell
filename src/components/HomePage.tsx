import { useState } from 'react'
import { useTranslation } from 'react-i18next'

type HomePageProps = {
  onJoinLobby: (code: string) => void
  onSpectateLobby: (code: string) => void
  onCreateLobby: (mode: 'classic' | 'powers') => void
  onQuickMatch: () => void
  onOpenProfile: () => void
  onOpenSettings: () => void
  lastLobbyCode?: string | null
  onRejoinLast?: () => void
  onForgetLast?: () => void
  authEmail?: string | null
  isAnonymousUser?: boolean
  authBusy?: boolean
  onSignIn?: (email: string, password: string) => void
  onCreateAccount?: (email: string, password: string) => void
  onContinueAsGuest?: () => void
  onLogout?: () => void
}

export default function HomePage({
  onJoinLobby,
  onSpectateLobby,
  onCreateLobby,
  onQuickMatch,
  onOpenProfile,
  onOpenSettings,
  lastLobbyCode,
  onRejoinLast,
  onForgetLast,
  authEmail,
  isAnonymousUser = true,
  authBusy = false,
  onSignIn,
  onCreateAccount,
  onContinueAsGuest,
  onLogout
}: HomePageProps) {
  const [lobbyCode, setLobbyCode] = useState<string>('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  return (
    <div className="homeScene">
      <div className="homeFrame">
        <div className="homeHeader">
          <div className="homeEyebrow">Classic 5x5 Social Deduction</div>
          <h1 className="homeTitle">OneClue Lobby Hub</h1>
          <p className="homeSubtitle">Run private matches, jump into quick games, or spectate friends live.</p>
          <div className="homeHeroChips">
            <span className="homeHeroChip">25 Card Grid</span>
            <span className="homeHeroChip">Team Strategy</span>
            <span className="homeHeroChip">Live Lobby Sync</span>
          </div>
        </div>

        <div className="homeTopCards">
          <section className="homeCard homeCardFeature" aria-label="Account">
            <h2>Account</h2>
            {!isAnonymousUser ? (
              <>
                <p>
                  Signed in as <b>{authEmail || 'account user'}</b>
                </p>
                <div className="homeBtnStack">
                  <button className="homeBtnGhost" type="button" onClick={onLogout} disabled={authBusy}>
                    Logout
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>Play as guest or sign in with email/password to keep long-term stats.</p>
                <div className="homeJoinRow">
                  <input
                    className="homeInput"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="EMAIL"
                    aria-label="Email"
                  />
                </div>
                <div className="homeJoinRow" style={{ marginTop: 8 }}>
                  <input
                    className="homeInput"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="PASSWORD"
                    aria-label="Password"
                  />
                </div>
                <div className="homeBtnStack" style={{ marginTop: 10 }}>
                  <button
                    className="homeBtnPrimary"
                    type="button"
                    onClick={() => onSignIn?.(email, password)}
                    disabled={authBusy || !email.trim() || !password.trim()}
                  >
                    Login
                  </button>
                  <button
                    className="homeBtnGhost"
                    type="button"
                    onClick={() => onCreateAccount?.(email, password)}
                    disabled={authBusy || !email.trim() || !password.trim()}
                  >
                    Create Account
                  </button>
                  <button className="homeBtnGhost" type="button" onClick={onContinueAsGuest} disabled={authBusy}>
                    Continue as Guest
                  </button>
                </div>
              </>
            )}
          </section>

          {lastLobbyCode && onRejoinLast && onForgetLast && (
            <section className="homeCard homeCardFeature" aria-label="Last lobby">
              <h2>Last Lobby</h2>
              <p>
                Code: <b>{lastLobbyCode}</b>
              </p>
              <div className="homeBtnStack">
                <button className="homeBtnPrimary" type="button" onClick={onRejoinLast}>
                  Rejoin
                </button>
                <button className="homeBtnGhost" type="button" onClick={onForgetLast}>
                  Forget
                </button>
              </div>
            </section>
          )}
        </div>

        <div className="homeGrid">
          <section className="homeCard homeCardJoin" aria-label="Join lobby">
            <h2>Join Lobby</h2>
            <p>Enter a lobby code to join your team instantly.</p>
            <div className="homeJoinRow">
              <input
                className="homeInput"
                type="text"
                value={lobbyCode}
                onChange={(e) => setLobbyCode(e.target.value.toUpperCase())}
                placeholder="ROOM CODE"
                aria-label="Lobby code"
              />
              <button
                className="homeBtnPrimary"
                type="button"
                onClick={() => onJoinLobby(lobbyCode.trim())}
                disabled={!lobbyCode.trim()}
              >
                Join
              </button>
            </div>

            <div style={{ marginTop: 10 }}>
              <button
                className="homeBtnGhost"
                type="button"
                onClick={() => onSpectateLobby(lobbyCode.trim())}
                disabled={!lobbyCode.trim()}
              >
                Spectate Lobby
              </button>
            </div>
          </section>

          <section className="homeCard homeCardCreate" aria-label="Create lobby">
            <h2>Create Lobby</h2>
            <p>Create a new room and invite players with a code.</p>
            <div className="homeBtnStack">
              <button className="homeBtnPrimary" type="button" onClick={() => onCreateLobby('classic')}>
                Create Classic Lobby
              </button>
              <button className="homeBtnGhost" type="button" onClick={() => onCreateLobby('powers')}>
                Create Powers Lobby
              </button>
            </div>
          </section>

          <section className="homeCard homeCardQuick" aria-label="Other options">
            <h2>Other Options</h2>
            <p>Quick actions for players who want to jump in fast.</p>
            <div className="homeBtnStack">
              <button className="homeBtnGhost" type="button" onClick={onQuickMatch}>
                Quick Match
              </button>
              <button className="homeBtnGhost" type="button" onClick={onOpenSettings}>
                Open Settings
              </button>
              <button className="homeBtnGhost" type="button" onClick={onOpenProfile}>
                Profile
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

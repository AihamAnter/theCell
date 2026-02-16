import { useState } from 'react'

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
  onForgetLast
}: HomePageProps) {
  const [lobbyCode, setLobbyCode] = useState<string>('')

  return (
    <div className="homeScene">
      <div className="homeFrame">
        <div className="homeHeader">
          <div className="homeEyebrow">Classic 5x5</div>
          <h1 className="homeTitle">Lobby</h1>
          <p className="homeSubtitle">Join a room, create one, or pick another option to start playing.</p>
        </div>

        {lastLobbyCode && onRejoinLast && onForgetLast && (
          <section className="homeCard" aria-label="Last lobby" style={{ marginBottom: 14 }}>
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

        <div className="homeGrid">
          <section className="homeCard" aria-label="Join lobby">
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

          <section className="homeCard" aria-label="Create lobby">
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

          <section className="homeCard" aria-label="Other options">
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

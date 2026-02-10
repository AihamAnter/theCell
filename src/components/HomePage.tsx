import { useState } from 'react'

type HomePageProps = {
  onJoinLobby: (code: string) => void
  onCreateLobby: (mode: 'classic' | 'powers') => void
  onOpenProfile: () => void
  onOpenSettings: () => void
}

export default function HomePage({ onJoinLobby, onCreateLobby, onOpenProfile, onOpenSettings }: HomePageProps) {
  const [lobbyCode, setLobbyCode] = useState<string>('')

  return (
    <div className="homeScene">
      <div className="homeFrame">
        <div className="homeHeader">
          <div className="homeEyebrow">Classic 5x5</div>
          <h1 className="homeTitle">Lobby</h1>
          <p className="homeSubtitle">Join a room, create one, or pick another option to start playing.</p>
        </div>

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
            <h2>Other</h2>
            <p>Manage your profile or change settings.</p>
            <div className="homeBtnStack">
              <button className="homeBtnPrimary" type="button" onClick={onOpenProfile}>
                Profile
              </button>
              <button className="homeBtnGhost" type="button" onClick={onOpenSettings}>
                Settings
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

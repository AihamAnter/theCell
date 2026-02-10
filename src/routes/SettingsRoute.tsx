import { useNavigate, useParams } from 'react-router-dom'
import SettingsPage from '../components/SettingsPage'

export default function SettingsRoute() {
  const navigate = useNavigate()
  const { code } = useParams()
  const lobbyCode = (code ?? '').trim().toUpperCase()

  return (
    <SettingsPage
      lobbyCode={lobbyCode}
      onBackToHome={() => navigate('/')}
      onBackToGame={() => navigate(lobbyCode ? `/lobby/${lobbyCode}` : '/')}
    />
  )
}

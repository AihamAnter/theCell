import { useNavigate } from 'react-router-dom'
import ProfilePage from '../components/ProfilePage'

export default function ProfileRoute() {
  const navigate = useNavigate()

  return <ProfilePage onBackToHome={() => navigate('/')} onBackToGame={() => navigate('/')} />
}

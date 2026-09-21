import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { AdminPage } from './pages/AdminPage';
import { LoginPage } from './pages/LoginPage';
import { QueuePage } from './pages/QueuePage';
import { ReviewPage } from './pages/ReviewPage';

export function App() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="boot">Loading session…</div>;
  if (!user && location.pathname !== '/login') return <Navigate to="/login" replace />;
  if (user && location.pathname === '/login') return <Navigate to="/queue" replace />;
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/queue" element={<QueuePage />} />
      <Route path="/reviews/:executionId" element={<ReviewPage />} />
      <Route path="/admin" element={user?.role === 'administrator' ? <AdminPage /> : <Navigate to="/queue" replace />} />
      <Route path="*" element={<Navigate to="/queue" replace />} />
    </Routes>
  );
}

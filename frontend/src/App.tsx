import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { LangProvider, useI18n } from './lib/i18n.tsx';
import { StoreProvider, useStore } from './lib/store.tsx';
import { OwlChat } from './owl/OwlChat.tsx';
import { Login } from './screens/Login.tsx';
import { MapScreen } from './screens/MapScreen.tsx';

function Routed() {
  const { loading, error, content, view } = useStore();
  const { t } = useI18n();
  if (loading) return <p className="center muted">{t('Loading …')}</p>;
  if (error && !content) {
    return (
      <div className="center">
        <p className="error">{t(error)}</p>
        <button className="btn secondary" onClick={() => location.reload()}>{t('Reload')}</button>
      </div>
    );
  }
  return (
    <Routes>
      <Route path="/" element={view ? <Navigate to="/map" replace /> : <Login />} />
      <Route path="/map" element={<MapScreen />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <LangProvider>
      <StoreProvider>
        <BrowserRouter>
          <Routed />
          <OwlChat />
        </BrowserRouter>
      </StoreProvider>
    </LangProvider>
  );
}

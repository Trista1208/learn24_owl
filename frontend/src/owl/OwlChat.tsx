import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { api } from '../lib/api.ts';
import { useI18n } from '../lib/i18n.tsx';

type Speaker = 'owl' | 'user';
interface Bubble { role: Speaker; text: string; ui?: boolean }

const GREETING = 'Hi! I’m Owl, your mentor. I explain, show you the way, and help with the next step.';
const CHIPS = ['Where do I find the next step?', 'Explain it really simply', 'I feel unsure'];

function OwlFace({ look, mood }: { look: { x: number; y: number }; mood: 'idle' | 'think' | 'happy' }) {
  return (
    <svg className={`owl-face mood-${mood}`} viewBox="0 0 64 64" aria-hidden="true">
      <path className="ear left" fill="#E23B2F" d="M18.5 28 25 9.5 31.5 27z" />
      <path className="ear right" fill="#E23B2F" d="M45.5 28 39 9.5 32.5 27z" />
      <circle cx="32" cy="36.5" r="18" fill="#E23B2F" />
      <ellipse cx="24.2" cy="35.2" rx="6.4" ry="7.2" fill="#ffffff" />
      <ellipse cx="39.8" cy="35.2" rx="6.4" ry="7.2" fill="#ffffff" />
      <g className="pupils" style={{ transform: `translate(${look.x}px, ${look.y}px)` }}>
        <circle cx="25.4" cy="36.4" r="2.7" fill="#1A1212" />
        <circle cx="41" cy="36.4" r="2.7" fill="#1A1212" />
      </g>
      <g className="lids">
        <ellipse cx="24.2" cy="35.2" rx="6.6" ry="7.4" fill="#E23B2F" />
        <ellipse cx="39.8" cy="35.2" rx="6.6" ry="7.4" fill="#E23B2F" />
      </g>
    </svg>
  );
}

export function OwlChat() {
  const { t, lang } = useI18n();
  const [open, setOpen] = useState(false);
  const [peek, setPeek] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [mood, setMood] = useState<'idle' | 'think' | 'happy'>('idle');
  const [look, setLook] = useState({ x: 0, y: 0 });
  const [messages, setMessages] = useState<Bubble[]>([{ role: 'owl', text: GREETING, ui: true }]);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const seen = sessionStorage.getItem('owl.peek');
    if (seen) return;
    const show = setTimeout(() => setPeek(true), 1200);
    const hide = setTimeout(() => setPeek(false), 8000);
    return () => { clearTimeout(show); clearTimeout(hide); };
  }, []);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy, open]);

  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.max(-2.2, Math.min(2.2, (e.clientX - (r.left + r.width / 2)) / 18));
    const y = Math.max(-1.6, Math.min(1.6, (e.clientY - (r.top + r.height / 2)) / 22));
    setLook({ x, y });
  };

  const send = async (raw: string) => {
    const next = raw.trim();
    if (!next || busy) return;
    setText('');
    setPeek(false);
    sessionStorage.setItem('owl.peek', '1');
    const history = [...messages, { role: 'user' as const, text: next }];
    setMessages(history);
    setBusy(true);
    setMood('think');
    const heading = document.querySelector('main h1, h1')?.textContent ?? '';
    try {
      const reply = await api.owlChat({
        lang,
        where: `${location.pathname} ${heading}`.replace(/\s+/g, ' ').trim(),
        messages: history.map((m) => ({ role: m.role === 'owl' ? 'assistant' as const : 'user' as const, text: m.ui ? t(m.text) : m.text })),
      });
      setMessages((cur) => [...cur, { role: 'owl', text: reply.text }]);
      setMood('happy');
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Owl is quiet just now.';
      setMessages((cur) => [...cur, { role: 'owl', text: message, ui: true }]);
      setMood('idle');
    } finally {
      setBusy(false);
      setTimeout(() => setMood('idle'), 1600);
    }
  };

  return (
    <div className={`owl-chat${open ? ' open' : ''}`} onMouseMove={onMove} onMouseLeave={() => setLook({ x: 0, y: 0 })}>
      {open && (
        <section className="owl-panel" role="dialog" aria-label={t('Owl')}>
          <header>
            <OwlFace look={look} mood={mood} />
            <div>
              <strong>{t('Owl')}</strong>
              <span>{t('Your mentor')}</span>
            </div>
            <button type="button" className="owl-x" onClick={() => setOpen(false)} aria-label={t('Close')}>×</button>
          </header>
          <div className="owl-log" ref={scroller}>
            {messages.map((m, i) => <p key={i} className={`owl-bubble ${m.role}`}>{m.ui ? t(m.text) : m.text}</p>)}
            {busy && <p className="owl-bubble owl typing" aria-label={t('Owl is writing')}>…</p>}
          </div>
          <div className="owl-chips">
            {CHIPS.map((c) => <button key={c} type="button" disabled={busy} onClick={() => void send(t(c))}>{t(c)}</button>)}
          </div>
          <form onSubmit={(e) => { e.preventDefault(); void send(text); }}>
            <input
              value={text}
              maxLength={800}
              placeholder={t('Ask Owl …')}
              aria-label={t('Message to Owl')}
              onChange={(e) => setText(e.target.value)}
            />
            <button type="submit" disabled={busy || text.trim().length === 0} aria-label={t('Send')}>↑</button>
          </form>
        </section>
      )}
      {!open && peek && <p className="owl-peek">{t('Psst … ask me something.')}</p>}
      <button
        type="button"
        className={`owl-fab mood-${mood}`}
        aria-expanded={open}
        aria-label={open ? t('Close Owl') : t('Talk to Owl')}
        onClick={() => { setOpen((v) => !v); setPeek(false); sessionStorage.setItem('owl.peek', '1'); }}
      >
        <OwlFace look={look} mood={mood} />
      </button>
    </div>
  );
}

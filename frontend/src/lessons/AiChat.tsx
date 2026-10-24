import { useI18n } from '../lib/i18n.tsx';
// Learning with the AI: tutor, role play or prompt lab. Replies come from the model, or prepared ones without it.
import { useEffect, useRef, useState } from 'react';
import type { AiChatLesson, Answer, ChatTurn } from '@l45/shared';
import { SOURCE_LABEL } from '@l45/shared';
import { api } from '../lib/api.ts';
import { LessonProgress } from './LessonActivity.tsx';

const KIND_NOTE: Record<AiChatLesson['content']['kind'], string> = {
  tutor: 'The AI asks questions and does not give away a finished solution.',
  roleplay: 'The AI plays a role. Write as you would at work.',
  'prompt-lab': 'The AI follows your brief literally. What you leave open, it fills with assumptions.',
};

export function AiChat({ lesson, sessionId, nodeId, onComplete }: { lesson: AiChatLesson; sessionId: string; nodeId: string; onComplete: (a: Answer) => Promise<void> }) {
  const { t: ui } = useI18n();
  const c = lesson.content;
  const [turns, setTurns] = useState<ChatTurn[]>([{ role: 'ai', text: c.opening, source: 'prepared' }]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const learnerTurns = turns.filter((t) => t.role === 'learner').length;

  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [turns.length]);

  const send = async () => {
    const msg = text.trim();
    if (!msg || busy) return;
    const next: ChatTurn[] = [...turns, { role: 'learner', text: msg }];
    setTurns(next);
    setText('');
    setBusy(true);
    try {
      const reply = await api.chat(sessionId, nodeId, next);
      setTurns([...next, { role: 'ai', text: reply.text, source: reply.source }]);
    } catch (e) {
      setTurns([...next, { role: 'ai', text: `No answer: ${e instanceof Error ? e.message : String(e)}`, source: 'prepared' }]);
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setBusy(true);
    try {
      await onComplete({ type: 'ai-chat', turns });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <LessonProgress completed={learnerTurns} total={c.minTurns} label={ui("Your contributions")} detail={`${Math.min(learnerTurns, c.minTurns)} / ${c.minTurns}`} />
      <div className="goal"><strong>{ui("Your goal:")}</strong> {c.goal}</div>
      <details className="chat-how"><summary>{ui("How the conversation works")}</summary><p>{ui(KIND_NOTE[c.kind])}</p></details>
      <div className={c.material ? 'two-col chat-layout' : 'chat-layout'}>
        {c.material && (
          <details className="card source chat-material"><summary>{ui("View the material")}</summary>
            <h3>{c.material.title} {lesson.source === 'model' && <span className="tag model">{ui("Invented example")}</span>}</h3>
            <ul>{c.material.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
          </details>
        )}
        <div className="chat">
          <div className="chat-log" ref={log} role="log" aria-label={ui("Conversation with the AI")} aria-live="polite">
            {turns.map((t, i) => (
              <div key={i} className={`bubble ${t.role}`}>
                <span className="who">{t.role === 'ai' ? ui('AI') : ui('You')}</span>
                <span className="txt">{t.text}</span>
                {t.role === 'ai' && t.source && t.source !== 'model' && i > 0 && <span className={`tag ${t.source}`}>{ui(SOURCE_LABEL[t.source])}</span>}
              </div>
            ))}
            {busy && <div className="bubble ai typing">…</div>}

          </div>
          <form className="composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={c.kind === 'prompt-lab' ? ui('Your brief to the AI …') : ui('Your answer …')}
              aria-label={ui("Message")}
              rows={2}
              disabled={busy}
            />
            <button className="btn primary" disabled={busy || !text.trim()}>{ui("Send")}</button>
          </form>
        </div>
      </div>
      <div className="actions activity-actions">
        <button className="btn primary" disabled={busy || learnerTurns < c.minTurns} onClick={finish}>{ui("Done")}</button>
      </div>
    </>
  );
}

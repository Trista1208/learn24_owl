import { useI18n } from '../lib/i18n.tsx';
import { ButtonLabel } from '../lib/ButtonLabel.tsx';
// Lessons with a first check: after a first mistake the learner chooses a hint or looks again (rule R6).
import { useRef, useState, type ReactNode } from 'react';
import type { Answer, MarkEvidenceLesson, MockPart, MockSiteLesson, PartialCheck, Source } from '@l45/shared';
import { SOURCE_LABEL } from '@l45/shared';
import { api } from '../lib/api.ts';
import { LessonProgress, QuestionCard } from './LessonActivity.tsx';
import { Icon } from '../lib/icons.tsx';

type Mark = 'belegt' | 'erfunden';
const MARK_LABEL: Record<Mark, string> = { belegt: 'In the note', erfunden: 'Invented' };

interface Ctx {
  sessionId: string;
  nodeId: string;
  onComplete: (a: Answer) => Promise<void>;
}

function useCheckFlow({ sessionId, nodeId, onComplete }: Ctx) {
  const [check, setCheck] = useState<PartialCheck | null>(null);
  const [checks, setChecks] = useState(0);
  const [hint, setHint] = useState<{ text: string; source: Source } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const run = async (answer: Answer) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      if (checks === 0) {
        const c = await api.check(sessionId, nodeId, answer);
        if (!c.complete) {
          setCheck(c);
          setChecks(1);
          return;
        }
      }
      await onComplete(answer);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const askHint = async (answer: Answer) => {
    setBusy(true);
    try {
      setHint(await api.hint(sessionId, nodeId, answer));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return { check, checks, hint, busy, error, run, askHint, dismiss: () => setCheck(null) };
}

function HelpBox({ check, hint, onHint, onRetry, busy }: { check: PartialCheck; hint: { text: string; source: Source } | null; onHint: () => void; onRetry: () => void; busy: boolean }) {
  const { t: ui } = useI18n();
  return (
    <div className="helpbox" role="status">
      <p><strong>{check.message}</strong></p>
      {!hint ? (
        <>
          <div className="row">
            <button className="btn secondary" onClick={onHint} disabled={busy}>{ui("Hint")}</button>
            <button className="btn quiet" onClick={onRetry}>{ui("Watch again")}</button>
          </div>
        </>
      ) : (
        <p className="bubble ai">{hint.text} {hint.source !== 'model' && <span className={`tag ${hint.source}`}>{ui(SOURCE_LABEL[hint.source])}</span>}</p>
      )}
    </div>
  );
}

// --- Check an AI summary ---------------------------------------------------------------------


export function MarkEvidence({ lesson, ...ctx }: { lesson: MarkEvidenceLesson } & Ctx) {
  const { t: ui } = useI18n();
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const [index, setIndex] = useState(0);
  const item = lesson.content.summary[index];
  return <div className="evidence-activity">
    <LessonProgress completed={Object.keys(marks).length} total={lesson.content.summary.length} label={ui("Your fact check")} />
    <div className="evidence-workspace">
      <details className="evidence-source" open><summary><Icon name="book" size={17} />{lesson.content.noteTitle}</summary><ul>{lesson.content.note.map((line, i) => <li key={i}>{line}</li>)}</ul></details>
      <QuestionCard key={item.id} prompt={item.text} options={[MARK_LABEL.belegt, MARK_LABEL.erfunden]} index={index} total={lesson.content.summary.length}
        check={(option) => ({ type: 'mark-evidence', itemId: item.id, mark: option === 0 ? 'belegt' : 'erfunden' })}
        continueLabel={index + 1 === lesson.content.summary.length ? ui('Finish lesson') : ui('Next sentence')} onContinue={async (option) => {
          const next: Record<string, Mark> = { ...marks, [item.id]: option === 0 ? 'belegt' : 'erfunden' };
          setMarks(next);
          if (index + 1 === lesson.content.summary.length) await ctx.onComplete({ type: 'mark-evidence', marks: next });
          else setIndex(index + 1);
        }} />
    </div>
  </div>;
}

// --- Inspect a website or mail ------------------------------------------------------------------


export function MockSite({ lesson, ...ctx }: { lesson: MockSiteLesson } & Ctx) {
  const { t: ui } = useI18n();
  const mail = lesson.content.mail ?? [];
  const site = lesson.content.site;
  const [step, setStep] = useState<'mail' | 'site' | 'verdict'>(mail.length ? 'mail' : 'site');
  const [marked, setMarked] = useState<string[]>([]);
  const [verdict, setVerdict] = useState<'phishing' | 'echt' | null>(null);
  const [showTarget, setShowTarget] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const flow = useCheckFlow(ctx);
  const answer: Answer = { type: 'mock-site', marked, verdict };
  const steps = mail.length ? ['mail', 'site', 'verdict'] : ['site', 'verdict'];
  const stepIndex = steps.indexOf(step);
  const go = (next: typeof step) => { setStep(next); requestAnimationFrame(() => heading.current?.focus({ preventScroll: true })); };
  const toggle = (id: string) => setMarked(marked.includes(id) ? marked.filter((x) => x !== id) : [...marked, id]);
  const of = (parts: MockPart[], kind: MockPart['kind']) => parts.filter((p) => p.kind === kind);
  const hot = (p: MockPart, cls = '', body: ReactNode = p.text) => <button key={p.id} type="button" className={`hot ${cls}`} aria-pressed={marked.includes(p.id)} onClick={() => toggle(p.id)}>{body}{marked.includes(p.id) && <span className="inspection-check" aria-hidden="true"><Icon name="check" size={14} /></span>}</button>;

  return <div className="inspection-activity">
    <LessonProgress completed={step === 'verdict' && verdict ? steps.length : stepIndex} total={steps.length} label={ui("Your security check")} detail={`Step ${stepIndex + 1} / ${steps.length}`} />
    <div className="inspection-heading"><h3 ref={heading} tabIndex={-1}>{step === 'mail' ? ui('What do you notice in the email?') : step === 'site' ? ui('Now check the website.') : ui('What is your verdict?')}</h3><span key={marked.length} className="marked-counter" role="status"><Icon name="target" size={15} />{marked.length} {ui("marked")}</span></div>
    <div className="inspection-navigation" role="group" aria-label={ui("Choose a step")}>
      {mail.length > 0 && <button className="btn quiet small" aria-pressed={step === 'mail'} onClick={() => go('mail')}>{ui("1 · Email")}</button>}
      <button className="btn quiet small" aria-pressed={step === 'site'} onClick={() => go('site')}>{mail.length ? 2 : 1} {ui("· Website")}</button>
      <button className="btn quiet small" aria-pressed={step === 'verdict'} onClick={() => go('verdict')}>{steps.length} {ui("· Verdict")}</button>
    </div>
    {step === 'mail' ? <div className="mock"><div className="mock-bar">{ui("Inbox")}</div><div className="mock-body">
      {of(mail, 'from').map((p) => hot(p, '', <>{ui("From:")} {p.text}</>))}
      {of(mail, 'subject').map((p) => hot(p, 'subject', <>{ui("Subject:")} {p.text}</>))}<hr />
      {of(mail, 'greeting').map((p) => hot(p))}{of(mail, 'paragraph').map((p) => hot(p))}
      {of(mail, 'link').map((p) => <div key={p.id}>{hot(p, 'linkpart')}<button type="button" className="linkbtn small" onClick={() => setShowTarget(!showTarget)}><ButtonLabel variants={['Hide the link target', 'See where the link goes']}>{showTarget ? ui('Hide the link target') : ui('See where the link goes')}</ButtonLabel></button>{showTarget && <div className="small target">{ui("The link goes to:")} {p.linkTarget}</div>}</div>)}
      {of(mail, 'signature').map((p) => hot(p))}
    </div></div> : step === 'site' ? <div className="mock"><div className="mock-bar"><span aria-hidden="true">🔒</span>{of(site, 'url').map((p) => hot(p, 'url'))}</div><div className="mock-body">
      {of(site, 'logo').map((p) => hot(p, 'logo'))}{of(site, 'heading').map((p) => hot(p, '', <strong>{p.text}</strong>))}
      {of(site, 'field').map((p) => hot(p, '', <span className="fields">{p.text.split(' · ').map((f) => <span key={f}>{f}</span>)}</span>))}
      {of(site, 'button').map((p) => hot(p, '', <span className="mbutton">{p.text}</span>))}{of(site, 'footer').map((p) => hot(p, 'footer'))}
    </div></div> : <div className="inspection-verdict"><span className="finish-disc"><Icon name="globe" size={28} /></span><div className="choices" role="group" aria-label={ui("Decision")}><button className="choice" disabled={flow.busy} aria-pressed={verdict === 'phishing'} onClick={() => { setVerdict('phishing'); void flow.run({ type: 'mock-site', marked, verdict: 'phishing' }); }}>{ui("Scam (phishing)")}</button><button className="choice" disabled={flow.busy} aria-pressed={verdict === 'echt'} onClick={() => { setVerdict('echt'); void flow.run({ type: 'mock-site', marked, verdict: 'echt' }); }}>{ui("Real")}</button></div></div>}
    {flow.error && <p className="error" role="alert">{ui(flow.error)}</p>}
    {flow.check && step === 'verdict' && <HelpBox check={flow.check} hint={flow.hint} busy={flow.busy} onHint={() => void flow.askHint(answer)} onRetry={() => { flow.dismiss(); go(mail.length ? 'mail' : 'site'); }} />}
    <div className="activity-actions"><span className="small muted">{step !== 'verdict' && ui('Mark the suspicious spots.')}</span>
      {step === 'verdict' ? (flow.check || flow.error) && <button className="btn primary" disabled={!verdict || flow.busy} onClick={() => void flow.run(answer)}><ButtonLabel variants={['On to the website', 'To the verdict', 'Checking …', 'Try again', 'Finish']}>{flow.busy ? ui('Checking …') : flow.error ? ui('Try again') : ui('Finish')}</ButtonLabel><Icon name="check" size={17} /></button>
        : <button className="btn primary" onClick={() => go(step === 'mail' ? 'site' : 'verdict')}><ButtonLabel variants={['On to the website', 'To the verdict', 'Checking …', 'Try again', 'Finish']}>{step === 'mail' ? ui('On to the website') : ui('To the verdict')}</ButtonLabel><Icon name="chevron" size={17} /></button>}
    </div>
    <details className="exercise-disclaimer"><summary>{ui("About this practice example")}</summary><p>{lesson.content.disclaimer}</p></details>
  </div>;
}

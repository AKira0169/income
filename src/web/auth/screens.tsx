/* auth/screens.tsx — sign in, sign up, recover, verify, security.

   Each is a thin wrapper around FlowForm: start (or resume, from ?flow=) the
   right Kratos flow, draw it, and decide what "done" means. The flow id is
   written into the address so a reload resumes the same flow rather than
   throwing away what Kratos already knows (a code just sent, a TOTP secret just
   shown). Visually these borrow the app's existing sheets; the redesign is
   phase 2. */

import { useEffect, useState } from 'preact/hooks';
import { go, navigate, search } from '../state/route.ts';
import type { AuthRoute } from '../state/route.ts';
import { Toast, toast } from '../ui/components/Toast.tsx';
import { FlowForm } from './FlowForm.tsx';
import { createFlow, destination, errorMessage, getFlow } from './kratos.ts';
import type { Flow, FlowKind, Outcome } from './kratos.ts';
import { checkSession } from './session.ts';

const param = (name: string): string => new URLSearchParams(search.peek()).get(name) ?? '';

/** In-app addresses are routed, Kratos's own (/auth/…) are loaded, anything else goes home. */
function follow(to: string): void {
  const where = destination(to, location.origin);
  if (where.kind === 'route') navigate(where.path);
  else if (where.kind === 'load') location.assign(where.href);
  else go({});
}

function useFlow(kind: FlowKind, params: Record<string, string> = {}) {
  const [flow, setFlow] = useState<Flow | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const start = async (resume: boolean): Promise<void> => {
    const id = resume ? param('flow') : '';
    const outcome = id ? await getFlow(kind, id) : await createFlow(kind, params);
    if (outcome.kind === 'flow') {
      setFlow(outcome.flow);
      history.replaceState(null, '', `${location.pathname}?flow=${encodeURIComponent(outcome.flow.id)}`);
    } else if (outcome.kind === 'redirect') {
      follow(outcome.to);
    } else if (outcome.kind === 'restart' && id) {
      await start(false);
    } else {
      setProblem(outcome.kind === 'restart' ? outcome.reason : 'The sign-in service gave an unexpected answer.');
    }
  };

  useEffect(() => {
    void start(true).catch(() => setProblem('Could not reach the sign-in service.'));
  }, []);

  /** Everything except "done" is handled the same way on every screen. */
  const handle = (outcome: Outcome, onDone: (body: unknown) => void): void => {
    if (outcome.kind === 'flow') setFlow(outcome.flow);
    else if (outcome.kind === 'redirect') follow(outcome.to);
    else if (outcome.kind === 'restart') { toast(outcome.reason); void start(false); }
    else onDone(outcome.body);
  };

  return { flow, setFlow, problem, handle };
}

function Link({ to, children }: { to: string; children: preact.ComponentChildren }) {
  return <a href={to} onClick={(e) => { e.preventDefault(); navigate(to); }}>{children}</a>;
}

function AuthShell({ title, children, links }: {
  title: string; children: preact.ComponentChildren; links?: preact.ComponentChildren;
}) {
  return (
    <main class="auth">
      <div class="sheet auth-card">
        <h1>{title}</h1>
        {children}
        {links ? <p class="auth-links">{links}</p> : null}
      </div>
      <Toast />
    </main>
  );
}

const Problem = ({ text }: { text: string | null }) =>
  text ? <p class="auth-message is-error">{text}</p> : null;

const Loading = () => <p class="muted">Loading…</p>;

/** After a flow ends in a session: into the app, or wherever we were sent from. */
async function enterApp(returnTo: string): Promise<void> {
  const signedIn = await checkSession({ followRedirect: true });
  if (!signedIn) return;
  if (returnTo) follow(returnTo);
  else go({});
}

export function Login() {
  const returnTo = param('return_to');
  const { flow, problem, handle } = useFlow('login', { aal: param('aal'), refresh: param('refresh'), return_to: returnTo });
  const second = flow?.requested_aal === 'aal2' || param('aal') === 'aal2';
  return (
    <AuthShell
      title={second ? 'Enter your authentication code' : 'Sign in'}
      links={<><Link to="/registration">Create an account</Link> · <Link to="/recovery">Forgot your password?</Link></>}
    >
      <Problem text={problem} />
      {flow ? <FlowForm flow={flow} onOutcome={(o) => handle(o, () => void enterApp(returnTo))} /> : <Loading />}
    </AuthShell>
  );
}

export function Registration() {
  const { flow, problem, handle } = useFlow('registration');
  return (
    <AuthShell title="Create your account" links={<>Already have one? <Link to="/login">Sign in</Link></>}>
      <Problem text={problem} />
      {flow ? <FlowForm flow={flow} onOutcome={(o) => handle(o, () => void enterApp(''))} /> : <Loading />}
    </AuthShell>
  );
}

/* A correct recovery code answers with a redirect to the security screen,
   signed in, to choose a new password — FlowForm's redirect handling covers it. */
export function Recovery() {
  const { flow, problem, handle } = useFlow('recovery');
  return (
    <AuthShell title="Recover your account" links={<Link to="/login">Back to sign in</Link>}>
      <Problem text={problem} />
      {flow ? <FlowForm flow={flow} onOutcome={(o) => handle(o, () => go({}))} /> : <Loading />}
    </AuthShell>
  );
}

export function Verification() {
  const { flow, problem, handle } = useFlow('verification');
  const passed = flow?.state === 'passed_challenge';
  useEffect(() => { if (passed) void checkSession({ followRedirect: false }); }, [passed]);
  return (
    <AuthShell title="Verify your email" links={<Link to="/">Back to the app</Link>}>
      <Problem text={problem} />
      {flow ? <FlowForm flow={flow} onOutcome={(o) => handle(o, () => go({}))} /> : <Loading />}
    </AuthShell>
  );
}

export function SecuritySettings() {
  const { flow, setFlow, problem, handle } = useFlow('settings');
  useEffect(() => { if (flow?.state === 'success') void checkSession({ followRedirect: false }); }, [flow?.state]);
  const section = (title: string, groups: readonly string[]) => flow ? (
    <section class="auth-section">
      <h2>{title}</h2>
      <FlowForm flow={flow} groups={groups} onOutcome={(o) => handle(o, () => setFlow(flow))} />
    </section>
  ) : null;
  return (
    <AuthShell title="Security" links={<Link to="/">Back to the app</Link>}>
      <Problem text={problem} />
      {flow ? null : <Loading />}
      {section('Password', ['password'])}
      {section('Authenticator app (2FA)', ['totp'])}
      {section('Backup codes', ['lookup_secret'])}
    </AuthShell>
  );
}

export function AuthError() {
  const [message, setMessage] = useState('Something went wrong while signing in.');
  useEffect(() => {
    const id = param('id');
    if (id) void errorMessage(id).then(setMessage).catch(() => {});
  }, []);
  return (
    <AuthShell title="Sign-in problem" links={<Link to="/login">Back to sign in</Link>}>
      <p class="auth-message is-error">{message}</p>
    </AuthShell>
  );
}

/** Keyed on the query string, so /login → /login?aal=aal2 starts a new flow. */
export function AuthScreen({ route }: { route: AuthRoute }) {
  const key = `${route}${search.value}`;
  switch (route) {
    case 'login': return <Login key={key} />;
    case 'registration': return <Registration key={key} />;
    case 'recovery': return <Recovery key={key} />;
    case 'verification': return <Verification key={key} />;
    case 'settings/security': return <SecuritySettings key={key} />;
    case 'error': return <AuthError key={key} />;
  }
}

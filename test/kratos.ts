/* Kratos client test: what each answer from a browser flow means for the
   screen, and that a form is sent the way Kratos's JSON API reads it.

   Run:  node test/kratos.ts */

import {
  bodyFromForm, createFlow, destination, logout, outcomeOf, submitFlow, whoami
} from '../src/web/auth/kratos.ts';
import type { Flow, UiNode } from '../src/web/auth/kratos.ts';
import { check, finish, title } from './support/check.ts';

const flow: Flow = { id: 'f1', ui: { action: 'https://app.test/auth/self-service/login?flow=f1', method: 'POST', nodes: [] } };
const node = (name: string, type: string, value: unknown = '', group = 'password'): UiNode => ({
  type: 'input', group, attributes: { node_type: 'input', name, type, value }, messages: [], meta: {}
});

title('what an answer means');
check('a flow comes back to be drawn again', outcomeOf(400, flow), { kind: 'flow', flow });
check('so does a settings flow that succeeded', outcomeOf(200, { ...flow, state: 'success' }).kind, 'flow');
check('a session means done', outcomeOf(200, { session: { id: 's' } }).kind, 'done');
check('422 means go somewhere else',
  outcomeOf(422, { error: { id: 'browser_location_change_required' }, redirect_browser_to: 'https://app.test/settings/security?flow=x' }),
  { kind: 'redirect', to: 'https://app.test/settings/security?flow=x' });
check('an expired flow starts again', outcomeOf(410, { error: { id: 'self_service_flow_expired', message: 'expired' } }),
  { kind: 'restart', reason: 'expired' });
check('a CSRF failure starts again', outcomeOf(403, { error: { id: 'security_csrf_violation', reason: 'csrf' } }).kind, 'restart');
check('a refresh demand goes where it says',
  outcomeOf(403, { error: { id: 'session_refresh_required' }, redirect_browser_to: '/auth/self-service/login/browser?refresh=true' }).kind, 'redirect');
check('already signed in means the app', outcomeOf(400, { error: { id: 'session_already_available' } }), { kind: 'redirect', to: '/' });
check('no session for settings means sign in', outcomeOf(401, { error: { id: 'session_inactive' } }), { kind: 'redirect', to: '/login' });

title('a form as Kratos reads it');
const nodes = [node('csrf_token', 'hidden', 'tok', 'default'), node('traits.email', 'email'), node('password', 'password'),
  node('method', 'submit', 'password'), node('lookup_secret_reveal', 'submit', true, 'lookup_secret'), node('remember', 'checkbox', false)];
check('dotted names become nested objects, the button pressed is included',
  bodyFromForm(nodes, [['csrf_token', 'tok'], ['traits.email', 'a@b.c'], ['password', 'pw'], ['remember', 'true']],
    { name: 'method', value: 'password' }),
  { csrf_token: 'tok', traits: { email: 'a@b.c' }, password: 'pw', remember: true, method: 'password' });
check('a button keeps its value\'s type', bodyFromForm(nodes, [['csrf_token', 'tok']], { name: 'lookup_secret_reveal', value: 'true' }),
  { csrf_token: 'tok', lookup_secret_reveal: true });

title('requests');
const sent: { url: string; init: RequestInit | undefined }[] = [];
let answer: { status: number; body: unknown } = { status: 200, body: flow };
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  sent.push({ url: String(input), init });
  return new Response(JSON.stringify(answer.body), { status: answer.status });
}) as typeof fetch;

await createFlow('login', { aal: 'aal2', return_to: '' });
check('a flow is created under /auth, empty parameters dropped', sent[0]?.url, '/auth/self-service/login/browser?aal=aal2');
check('as JSON, with the cookies', [new Headers(sent[0]?.init?.headers).get('accept'), sent[0]?.init?.credentials], ['application/json', 'include']);
await submitFlow(flow, { method: 'password' });
check('a submit goes to the flow\'s own action', [sent[1]?.url, sent[1]?.init?.method, sent[1]?.init?.body],
  [flow.ui.action, 'POST', '{"method":"password"}']);
answer = { status: 401, body: { error: { id: 'session_inactive' } } };
check('no session', (await whoami()).kind, 'none');
answer = { status: 403, body: { error: { id: 'session_aal2_required' }, redirect_browser_to: 'https://app.test/auth/self-service/login/browser?aal=aal2' } };
check('a second factor owed is a redirect', await whoami(),
  { kind: 'redirect', to: 'https://app.test/auth/self-service/login/browser?aal=aal2' });
sent.length = 0;
answer = { status: 200, body: { logout_token: 'lt', logout_url: 'x' } };
await logout();
check('logging out fetches a token, then spends it',
  sent.map((s) => s.url), ['/auth/self-service/logout/browser', '/auth/self-service/logout?token=lt']);

title('where a redirect may go');
const ORIGIN = 'https://app.test';
check('an app path is routed in place', destination('/bills/2026-07?x=1', ORIGIN), { kind: 'route', path: '/bills/2026-07?x=1' });
check('a full same-origin URL too', destination('https://app.test/settings/security?flow=f', ORIGIN), { kind: 'route', path: '/settings/security?flow=f' });
check('a Kratos address is a real page load', destination('https://app.test/auth/self-service/login/browser?aal=aal2', ORIGIN),
  { kind: 'load', href: 'https://app.test/auth/self-service/login/browser?aal=aal2' });
check('javascript: is never followed', destination('javascript:alert(1)', ORIGIN), { kind: 'home' });
check('nor data:', destination('data:text/html,hi', ORIGIN), { kind: 'home' });
check('nor another site', destination('https://evil.test/login', ORIGIN), { kind: 'home' });
check('nor a protocol-relative one', destination('//evil.test/x', ORIGIN), { kind: 'home' });

finish();

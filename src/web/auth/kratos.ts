/* auth/kratos.ts — the browser's side of Ory Kratos.

   Everything goes through /auth on our own origin (Caddy strips the prefix and
   forwards to Kratos), so the session cookie is first-party and no CORS is
   involved. These are Kratos's *browser* flows answered as JSON: the CSRF token
   arrives as a hidden node in the flow and as a cookie, and both go back on
   submit.

   outcomeOf() is the whole protocol in one place: a flow (drawn again — with
   errors on a 400, with a success message on a settings 200), done (a login or
   registration that produced a session), a redirect (422, or a refresh or a
   second factor demanded), or start again (expired, CSRF). */

export const KRATOS = '/auth';

export type FlowKind = 'login' | 'registration' | 'recovery' | 'verification' | 'settings';

export interface UiText {
  id: number;
  text: string;
  type: 'info' | 'error' | 'success';
  context?: Record<string, unknown>;
}

export interface UiNodeAttributes {
  node_type: 'input' | 'img' | 'text' | 'a' | 'script';
  name?: string;
  type?: string;
  value?: unknown;
  required?: boolean;
  disabled?: boolean;
  autocomplete?: string;
  pattern?: string;
  id?: string;
  src?: string;
  width?: number;
  height?: number;
  text?: UiText;
  href?: string;
  title?: UiText;
}

export interface UiNode {
  type: 'input' | 'img' | 'text' | 'a' | 'script';
  group: string;
  attributes: UiNodeAttributes;
  messages: UiText[];
  meta: { label?: UiText };
}

export interface Flow {
  id: string;
  state?: string;
  requested_aal?: string;
  return_to?: string;
  ui: { action: string; method: string; nodes: UiNode[]; messages?: UiText[] };
}

export interface Session {
  id: string;
  active: boolean;
  identity: {
    id: string;
    traits: { email?: string; name?: string };
    verifiable_addresses?: { value: string; verified: boolean }[];
  };
}

export type Outcome =
  | { kind: 'flow'; flow: Flow }
  | { kind: 'done'; body: unknown }
  | { kind: 'redirect'; to: string }
  | { kind: 'restart'; reason: string };

export type WhoAmI = { kind: 'session'; session: Session } | { kind: 'none' } | { kind: 'redirect'; to: string };

interface KratosError {
  error?: { id?: string; message?: string; reason?: string };
  redirect_browser_to?: string;
}

async function send(url: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url, { ...init, headers, credentials: 'include' });
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* an error page from a proxy */ }
  return { status: res.status, body };
}

const isFlow = (body: unknown): body is Flow =>
  !!body && typeof body === 'object' && 'ui' in body && 'id' in body;

export function outcomeOf(status: number, body: unknown): Outcome {
  if (isFlow(body)) return { kind: 'flow', flow: body };
  const err = (body ?? {}) as KratosError;
  if (err.redirect_browser_to) return { kind: 'redirect', to: err.redirect_browser_to };
  if (err.error?.id === 'session_already_available') return { kind: 'redirect', to: '/' };
  if (status === 401) return { kind: 'redirect', to: '/login' };
  if (status >= 200 && status < 300) return { kind: 'done', body };
  return { kind: 'restart', reason: err.error?.message ?? err.error?.reason ?? `The sign-in service answered ${status}.` };
}

export async function createFlow(kind: FlowKind, params: Record<string, string> = {}): Promise<Outcome> {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
  const { status, body } = await send(`${KRATOS}/self-service/${kind}/browser${query ? `?${query}` : ''}`);
  return outcomeOf(status, body);
}

export async function getFlow(kind: FlowKind, id: string): Promise<Outcome> {
  const { status, body } = await send(`${KRATOS}/self-service/${kind}/flows?id=${encodeURIComponent(id)}`);
  return outcomeOf(status, body);
}

export async function submitFlow(flow: Flow, body: Record<string, unknown>): Promise<Outcome> {
  const answer = await send(flow.ui.action, { method: flow.ui.method.toUpperCase(), body: JSON.stringify(body) });
  return outcomeOf(answer.status, answer.body);
}

/* 403 here is a session that still owes its second factor: Kratos says where
   to go to give it. */
export async function whoami(): Promise<WhoAmI> {
  const { status, body } = await send(`${KRATOS}/sessions/whoami`);
  if (status === 200) return { kind: 'session', session: body as Session };
  if (status === 403) {
    return { kind: 'redirect', to: (body as KratosError | null)?.redirect_browser_to ?? '/login?aal=aal2' };
  }
  return { kind: 'none' };
}

export async function logout(): Promise<void> {
  const { status, body } = await send(`${KRATOS}/self-service/logout/browser`);
  const token = status === 200 ? (body as { logout_token?: string } | null)?.logout_token : undefined;
  if (token) await send(`${KRATOS}/self-service/logout?token=${encodeURIComponent(token)}`);
}

export async function errorMessage(id: string): Promise<string> {
  const { body } = await send(`${KRATOS}/self-service/errors?id=${encodeURIComponent(id)}`);
  return (body as KratosError | null)?.error?.message ?? 'Something went wrong while signing in.';
}

/* Kratos names fields with dots (traits.email) and reads JSON as nested
   objects, so the names are unfolded. The button that was pressed is part of
   the answer — it says which method — and keeps its value's real type: a
   `lookup_secret_reveal: true` sent as "true" would be refused. */
export function bodyFromForm(
  nodes: readonly UiNode[],
  entries: Iterable<[string, FormDataEntryValue]>,
  pressed: { name: string; value: string } | null
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (name: string, value: unknown): void => {
    const parts = name.split('.');
    let at = out;
    for (const part of parts.slice(0, -1)) {
      at = (at[part] ??= {}) as Record<string, unknown>;
    }
    at[parts[parts.length - 1]!] = value;
  };
  const checkboxes = new Set(nodes.filter((n) => n.attributes.type === 'checkbox').map((n) => n.attributes.name));
  for (const [name, value] of entries) {
    put(name, checkboxes.has(name) ? value === 'true' : typeof value === 'string' ? value : value.name);
  }
  if (pressed?.name) {
    const button = nodes.find((n) => n.attributes.name === pressed.name && String(n.attributes.value ?? '') === pressed.value);
    put(pressed.name, button ? button.attributes.value : pressed.value);
  }
  return out;
}

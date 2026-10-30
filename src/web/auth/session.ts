/* auth/session.ts — who is signed in, according to Kratos.

   `undefined` while the question is out, `null` when the answer is nobody.
   The api never decides this on its own: any 401 from it means the session has
   gone (expired, or ended in another tab), and the person is sent to sign in. */

import { signal } from '@preact/signals';
import { onUnauthorized } from '../state/api.ts';
import { resetApp } from '../state/boot.ts';
import { authRoute, navigate } from '../state/route.ts';
import { logout, whoami } from './kratos.ts';
import type { Session } from './kratos.ts';

export const session = signal<Session | null | undefined>(undefined);

export const emailOf = (s: Session | null | undefined): string => s?.identity.traits.email ?? '';

/* A session that still owes its second factor is sent to give it — but not
   from a sign-in screen, where the redirect would land right back here. */
export async function checkSession(options: { followRedirect?: boolean } = {}): Promise<Session | null> {
  const follow = options.followRedirect ?? authRoute.peek() === null;
  const answer = await whoami().catch((): { kind: 'none' } => ({ kind: 'none' }));
  if (answer.kind === 'redirect' && follow) {
    location.assign(answer.to);
    return null;
  }
  session.value = answer.kind === 'session' ? answer.session : null;
  return session.value;
}

export async function signOut(): Promise<void> {
  await logout();
  session.value = null;
  resetApp();
  navigate('/login');
}

onUnauthorized(() => {
  if (session.peek() === null) return;
  session.value = null;
  resetApp();
  navigate('/login');
});

/* server/kratos.ts — the one question the api asks Kratos: whose session is
   this? The browser's cookie is forwarded as-is to the public port inside the
   compose network; Kratos answers 200 with the session, or 401 (none) or 403
   (a second factor is still owed). Only a 200 with an active session counts. */

export interface Identity {
  id: string;
  email: string;
  verified: boolean;
}

interface WhoamiBody {
  active?: boolean;
  identity?: {
    id: string;
    traits?: { email?: string };
    verifiable_addresses?: { value: string; verified: boolean }[];
  };
}

export function kratosWhoami(publicUrl: string, fetchImpl: typeof fetch = fetch) {
  const url = new URL('/sessions/whoami', publicUrl).toString();
  return async (cookieHeader: string): Promise<Identity | null> => {
    // A Kratos that hangs must not hang every request behind it.
    const res = await fetchImpl(url, {
      headers: { cookie: cookieHeader, accept: 'application/json' }, signal: AbortSignal.timeout(3000)
    });
    if (res.status !== 200) return null;
    const body = await res.json() as WhoamiBody;
    if (!body.active || !body.identity) return null;
    const email = body.identity.traits?.email ?? '';
    const verified = (body.identity.verifiable_addresses ?? []).some((a) => a.value === email && a.verified);
    return { id: body.identity.id, email, verified };
  };
}

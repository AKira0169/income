/* test/support/ids.ts — make uid() predictable, so that calling a domain
   function directly and calling it through the api create records with the
   same ids and the two states can be compared whole.

   uid() takes the first 12 characters of crypto.randomUUID(); the counter is
   at the front so those 12 differ. The api runs in this same process
   (app.request), so it sees the same stub. Nothing else in the request path
   calls randomUUID — the request id deliberately uses randomBytes.

   A comparison marks the counter, makes the direct call, and rewinds to the
   mark before the api call — never back to zero, which would hand out ids
   that earlier records already hold. */

let n = 0;

export function deterministicIds(): void {
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    configurable: true,
    writable: true,
    value: () => `${String(++n).padStart(8, '0')}-0000-4000-8000-000000000000`
  });
}

export const markIds = (): number => n;

export const rewindIds = (mark: number): void => { n = mark; };

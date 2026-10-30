/* test/support/check.ts — the one assertion every suite uses: compare as JSON,
   print ok/FAIL, count failures, exit non-zero at the end. Same contract as the
   check() written inline in the older suites. */

let failures = 0;

export function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log(`  FAIL ${label}\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`);
  } else console.log(`  ok   ${label}`);
}

export const title = (text: string): void => console.log(`\n${text}:`);

export function finish(): never {
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

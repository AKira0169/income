/* Every write is a request now, and a request can fail. A call to an action
   that nobody awaits fails silently — the screen keeps showing what was typed
   and nothing says it was never saved. So every call to an action in the UI
   is either awaited (and its failure reaches a form, which says so) or handed
   to act() (which says so itself).

   Run:  node test/await-actions.ts */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, finish, title } from './support/check.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const ACTIONS = ['upsert', 'remove', 'updateSettings', 'replaceState', 'clearAll', 'importJSON',
  'generateBills', 'generateIncome', 'catchUp', 'linkGeneratedTo', 'saveGoal', 'moveGoal',
  'borrow', 'repay', 'reconcile', 'refresh'];
const CALL = new RegExp(`(?<![\\w.])(${ACTIONS.join('|')})\\(`, 'g');
const ALLOWED = /(await |act\(\(\) => |return )$/;

const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []);

/** Comments blanked out, line breaks kept, so line numbers stay true. */
const code = (text: string): string => text
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|\s)\/\/.*$/gm, '$1');

title('every write in the UI is awaited or handed to act()');
const offenders: string[] = [];
for (const file of files(join(root, 'src', 'web', 'ui'))) {
  code(readFileSync(file, 'utf8')).split('\n').forEach((line, i) => {
    for (const match of line.matchAll(CALL)) {
      if (!ALLOWED.test(line.slice(0, match.index))) {
        offenders.push(`${relative(root, file)}:${i + 1}: ${line.trim()}`);
      }
    }
  });
}
check('no fire-and-forget writes', offenders, []);

finish();

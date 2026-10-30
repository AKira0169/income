/* Route test: the address bar is the route. Tabs and months live in the path
   now (/bills/2026-07), beside the sign-in screens (/login), and
   /settings/security is a screen of its own even though /settings/<month> is
   the Settings tab.

   Run:  node test/route.ts */

import { parsePath, pathFor } from '../src/web/state/route.ts';
import { check, finish, title } from './support/check.ts';

title('paths');
check('a tab and a month', parsePath('/bills/2026-07'), { auth: null, tab: 'bills', period: '2026-07' });
check('a sign-in screen', parsePath('/login'), { auth: 'login', tab: null, period: null });
check('a trailing slash is the same screen', parsePath('/registration/'), { auth: 'registration', tab: null, period: null });
check('security settings are an auth screen', parsePath('/settings/security'), { auth: 'settings/security', tab: null, period: null });
check('the Settings tab in a month is not', parsePath('/settings/2026-07'), { auth: null, tab: 'settings', period: '2026-07' });
check('a tab with no month keeps the month on screen', parsePath('/gold'), { auth: null, tab: 'gold', period: null });
check('the root changes nothing', parsePath('/'), { auth: null, tab: null, period: null });
check('nonsense changes nothing', parsePath('/nope/13-2026'), { auth: null, tab: null, period: null });
check('building a path', pathFor('savings', '2026-08'), '/savings/2026-08');

finish();

/* Currency exponents: how many minor units a currency's major unit holds.
   Phase 3 stores amounts per currency; the map has to exist now so the schema
   and the import path agree on what "minor units" means.

   Run:  node test/currency.ts */

import { CURRENCY_EXPONENT, currencyExponent } from '../src/domain/money.ts';
import { check, finish, title } from './support/check.ts';

title('currency exponents');
check('the default is two decimals', currencyExponent('EGP'), 2);
check('an unknown code is two decimals', currencyExponent('XYZ'), 2);
check('an empty code is two decimals', currencyExponent(''), 2);
check('yen has none', currencyExponent('JPY'), 0);
check('the dinars and the rial have three',
  ['KWD', 'BHD', 'OMR'].map(currencyExponent), [3, 3, 3]);
check('lower case is read the same', currencyExponent('jpy'), 0);
check('the map lists only the exceptions', Object.keys(CURRENCY_EXPONENT).sort(), ['BHD', 'JPY', 'KWD', 'OMR']);

finish();

/* ui/form-defaults.ts — the old no-argument shape of the two account defaults.

   The functions themselves are selectors and live in domain/selectors.ts now.
   These wrappers exist only for the legacy screens, which have no state to hand
   them. They go with those screens. */

import { defaultSavingsAccount as pick, lastAccountFor as last } from '../domain/selectors.ts';
import { state } from '../store.ts';
import type { CollectionKey, Id } from '../domain/types.ts';

export const lastAccountFor = (collection: CollectionKey): Id | '' => last(state, collection);
export const defaultSavingsAccount = (): Id | '' => pick(state);

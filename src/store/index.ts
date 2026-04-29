import { create } from "zustand";

import { createAccountSlice } from "./slices/account";
import { createEmailsSlice } from "./slices/emails";
import { createSendersSlice } from "./slices/senders";
import { createUiSlice } from "./slices/ui";
import type { AppStore } from "./types";

/**
 * Root app store. Composed from per-domain slices so each slice can be
 * developed and tested in isolation without losing the single-store
 * benefits (one subscription, one snapshot).
 *
 * Slices today are scaffolding stubs; they fill in incrementally as
 * follow-on tasks migrate state out of `src/App.tsx`. Add new slices by
 * appending another spread to this object and another `&` to `AppStore`.
 *
 * Selector usage is preferred over destructuring the whole store —
 * `const senders = useAppStore((s) => s.senders)` — to keep re-render
 * scope tight.
 */
export const useAppStore = create<AppStore>()((...a) => ({
  ...createAccountSlice(...a),
  ...createSendersSlice(...a),
  ...createEmailsSlice(...a),
  ...createUiSlice(...a),
}));

export type { AppStore, AppStateCreator } from "./types";
export type { AccountSlice } from "./slices/account";
export type { SendersSlice } from "./slices/senders";
export type { EmailsSlice } from "./slices/emails";
export type { UiSlice } from "./slices/ui";

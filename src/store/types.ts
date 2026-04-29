import type { StateCreator } from "zustand";

import type { AccountSlice } from "./slices/account";
import type { EmailsSlice } from "./slices/emails";
import type { SendersSlice } from "./slices/senders";
import type { UiSlice } from "./slices/ui";

/**
 * Composed shape of the app store. Each slice contributes its own keyed
 * surface; the intersection is what `useAppStore` exposes to consumers.
 *
 * Slice migration is incremental — slices start empty (`{}`) and pick up
 * fields one task at a time as state moves out of `App.tsx`. Order of
 * intersection does not matter; collisions across slices are a bug.
 */
export type AppStore = AccountSlice & SendersSlice & EmailsSlice & UiSlice;

/**
 * Helper for typing a slice creator. Use as:
 *
 * ```ts
 * export const createFooSlice: AppStateCreator<FooSlice> = (set, get) => ({ ... });
 * ```
 *
 * The four type parameters lock the slice into the composed `AppStore` so
 * `set`/`get` see fields from sibling slices. Middleware mutators stay
 * empty until the store actually adopts a middleware.
 */
export type AppStateCreator<Slice> = StateCreator<AppStore, [], [], Slice>;

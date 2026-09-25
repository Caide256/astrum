import { useSyncExternalStore } from "react";

type Listener = () => void;

/** A minimal store: read with useStore, change with set. */
export function createStore<T extends object>(initial: T) {
  let state = initial;
  const listeners = new Set<Listener>();

  const store = {
    get: () => state,
    set(patch: Partial<T> | ((prev: T) => Partial<T>)) {
      const next = typeof patch === "function" ? patch(state) : patch;
      state = { ...state, ...next };
      listeners.forEach((l) => l());
    },
    subscribe(l: Listener) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
  return store;
}

export type Store<T extends object> = ReturnType<typeof createStore<T>>;

export function useStore<T extends object, S>(store: Store<T>, select: (s: T) => S): S {
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.get()),
    () => select(store.get()),
  );
}

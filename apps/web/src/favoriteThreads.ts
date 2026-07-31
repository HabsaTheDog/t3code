import * as Schema from "effect/Schema";
import { useCallback, useMemo } from "react";

import { useLocalStorage } from "./hooks/useLocalStorage";

export const FAVORITE_THREADS_STORAGE_KEY = "t3code:favorite-threads:v1";

const FavoriteThreadKeysSchema = Schema.Array(Schema.String);
const EMPTY_FAVORITE_THREAD_KEYS: string[] = [];

export function useFavoriteThreads() {
  const [favoriteThreadKeys, setFavoriteThreadKeys] = useLocalStorage(
    FAVORITE_THREADS_STORAGE_KEY,
    EMPTY_FAVORITE_THREAD_KEYS,
    FavoriteThreadKeysSchema,
  );
  const favoriteThreadKeySet = useMemo(() => new Set(favoriteThreadKeys), [favoriteThreadKeys]);
  const toggleFavoriteThread = useCallback(
    (threadKey: string) => {
      setFavoriteThreadKeys((current) =>
        current.includes(threadKey)
          ? current.filter((key) => key !== threadKey)
          : [...current, threadKey],
      );
    },
    [setFavoriteThreadKeys],
  );

  return { favoriteThreadKeySet, toggleFavoriteThread };
}

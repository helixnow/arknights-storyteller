import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "@/services/api";
import type { CharacterIndex } from "@/types/story";

interface CharacterContextValue extends CharacterIndex {
  /** 按 name / charId 反向查找。优先 exact match，失败时尝试清洗掉空白/标点后再查。 */
  resolveCharId: (name: string | null | undefined) => string | null;
  /** 按 charId 取中文名。用于后端回填失败时的显示兜底。 */
  resolveName: (charId: string | null | undefined) => string | null;
  loaded: boolean;
}

const EMPTY: CharacterContextValue = {
  charIdToName: {},
  nameToCharId: {},
  resolveCharId: () => null,
  resolveName: () => null,
  loaded: false,
};

const CharacterContext = createContext<CharacterContextValue>(EMPTY);

export function CharacterResolverProvider({ children }: { children: ReactNode }) {
  const [index, setIndex] = useState<CharacterIndex>({
    charIdToName: {},
    nameToCharId: {},
  });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getCharacterIndex()
      .then((idx) => {
        if (cancelled) return;
        setIndex(idx);
        setLoaded(true);
      })
      .catch((err) => {
        console.warn("[CharacterResolver] get index failed", err);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo<CharacterContextValue>(() => {
    const nameMap = index.nameToCharId ?? {};
    const idMap = index.charIdToName ?? {};
    const simplify = (s: string) => s.trim().replace(/[\s·‧•・]+/g, "");
    const simplifiedNameMap = new Map<string, string>();
    Object.entries(nameMap).forEach(([k, v]) => {
      const key = simplify(k);
      if (key && !simplifiedNameMap.has(key)) simplifiedNameMap.set(key, v);
    });
    return {
      charIdToName: idMap,
      nameToCharId: nameMap,
      loaded,
      resolveCharId: (name) => {
        if (!name) return null;
        const trimmed = name.trim();
        if (!trimmed) return null;
        if (trimmed.startsWith("char_")) return trimmed.split("#")[0];
        return nameMap[trimmed] ?? simplifiedNameMap.get(simplify(trimmed)) ?? null;
      },
      resolveName: (charId) => {
        if (!charId) return null;
        const key = charId.split("#")[0];
        return idMap[key] ?? null;
      },
    };
  }, [index, loaded]);

  return <CharacterContext.Provider value={value}>{children}</CharacterContext.Provider>;
}

export function useCharacterResolver(): CharacterContextValue {
  return useContext(CharacterContext);
}

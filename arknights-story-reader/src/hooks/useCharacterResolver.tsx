import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "@/services/api";
import { setGlobalCharacterIndex } from "@/hooks/useAsset";
import type { CharacterIndex } from "@/types/story";

interface CharacterContextValue extends CharacterIndex {
  /** 按 name / charId 反向查找。优先 exact match，失败时尝试清洗掉空白/标点后再查。 */
  resolveCharId: (name: string | null | undefined) => string | null;
  /** 按 charId 取中文名。用于后端回填失败时的显示兜底。 */
  resolveName: (charId: string | null | undefined) => string | null;
  loaded: boolean;
  /** 索引里到底有没有东西。数据没同步时 loaded 也会是 true，但映射是空的。 */
  hasIndex: boolean;
  /** 手动重新拉一次索引，供"重新载入"这类按钮使用。 */
  refresh: () => Promise<void>;
}

const EMPTY: CharacterContextValue = {
  charIdToName: {},
  nameToCharId: {},
  resolveCharId: () => null,
  resolveName: () => null,
  loaded: false,
  hasIndex: false,
  refresh: async () => {},
};

const CharacterContext = createContext<CharacterContextValue>(EMPTY);
const EMPTY_INDEX: CharacterIndex = {
  charIdToName: {},
  nameToCharId: {},
};

export function CharacterResolverProvider({ children }: { children: ReactNode }) {
  const [index, setIndex] = useState<CharacterIndex>(EMPTY_INDEX);
  const [loaded, setLoaded] = useState(false);
  const mountedRef = useRef(true);
  // 同步完成、手动重试可能在几百毫秒内连着触发几次 refresh。只认最后一次
  // 发出的请求，否则先发后到的旧响应会把新索引盖回去。
  const runIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const runId = ++runIdRef.current;
    const isCurrent = () => mountedRef.current && runId === runIdRef.current;
    try {
      const idx = await api.getCharacterIndex();
      if (!isCurrent()) return;
      setIndex(idx);
      // 注入到全局，让 useAsset 的本地 URL 解析能用上真正的 charId 映射
      setGlobalCharacterIndex(idx);
    } catch {
      // 数据没同步时拿不到索引：头像退化成首字缩写，不影响阅读。
    } finally {
      if (isCurrent()) setLoaded(true);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    // 首次启动时数据可能还没同步，此时索引是空的。同步完成后重新拉一次，
    // 否则头像要等到下次冷启动才出得来。
    const handler = () => {
      // 数据目录已经原子换包，旧 name→charId 从这一刻起就不再可信。后端
      // 解析十几 MB 表格期间先退回无索引态；若刷新失败也不能继续拿旧包
      // 映射生成头像 URL。refresh 同步递增 runId，旧在途响应随后会被挡掉。
      setIndex(EMPTY_INDEX);
      setGlobalCharacterIndex(null);
      setLoaded(false);
      void refresh();
    };
    window.addEventListener("app:data-updated", handler);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("app:data-updated", handler);
    };
  }, [refresh]);

  const maps = useMemo(() => {
    const nameMap = index.nameToCharId ?? {};
    const idMap = index.charIdToName ?? {};
    const hasIndex = Object.keys(nameMap).length > 0 || Object.keys(idMap).length > 0;
    const simplify = (s: string) => s.trim().replace(/[\s·‧•・]+/g, "");
    const simplifiedNameMap = new Map<string, string>();
    Object.entries(nameMap).forEach(([k, v]) => {
      const key = simplify(k);
      if (key && !simplifiedNameMap.has(key)) simplifiedNameMap.set(key, v);
    });
    // `char_{num}_{alias}` 里的 alias（小写英文）映射。干员密录的
    // storyTxt 形如 `obt/memory/story_{alias}_N_M`，没有 char_ 前缀也
    // 不是中文名/appellation —— 直接从已有的 charIds 反推即可。
    const aliasMap = new Map<string, string>();
    Object.keys(idMap).forEach((cid) => {
      const match = cid.match(/^char_\d+_(.+?)(?:#.*)?$/);
      if (match) {
        const alias = match[1].toLowerCase();
        if (!aliasMap.has(alias)) aliasMap.set(alias, cid);
      }
    });
    // 人物面板一次要解析几百个名字，命中结果（含 miss）缓存起来。
    const resolved = new Map<string, string | null>();
    const resolveCharId = (name: string | null | undefined): string | null => {
      if (!name) return null;
      const trimmed = name.trim();
      if (!trimmed) return null;
      const cached = resolved.get(trimmed);
      if (cached !== undefined) return cached;
      let out: string | null;
      if (trimmed.startsWith("char_")) {
        out = trimmed.split("#")[0];
      } else {
        out =
          nameMap[trimmed] ??
          simplifiedNameMap.get(simplify(trimmed)) ??
          // 兜底尝试 alias（存 charId 小写英文片段），覆盖干员密录这类
          // 只有 `story_{alias}_` 的路径。
          aliasMap.get(trimmed.toLowerCase()) ??
          null;
      }
      resolved.set(trimmed, out);
      return out;
    };
    return {
      charIdToName: idMap,
      nameToCharId: nameMap,
      hasIndex,
      resolveCharId,
      resolveName: (charId: string | null | undefined): string | null => {
        if (!charId) return null;
        return idMap[charId.split("#")[0]] ?? null;
      },
    };
  }, [index]);

  const value = useMemo<CharacterContextValue>(
    () => ({ ...maps, loaded, refresh }),
    [maps, loaded, refresh]
  );

  return <CharacterContext.Provider value={value}>{children}</CharacterContext.Provider>;
}

export function useCharacterResolver(): CharacterContextValue {
  return useContext(CharacterContext);
}

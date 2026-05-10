import { memo, type CSSProperties } from "react";
import { AssetImage } from "@/components/AssetImage";
import { useCharacterResolver } from "@/hooks/useCharacterResolver";
import { cn } from "@/lib/utils";

interface CharacterAvatarProps {
  /** 中文名或 charId 都可以。两者任一有值即可。 */
  name?: string | null;
  charId?: string | null;
  size?: number;
  className?: string;
  style?: CSSProperties;
  /** `soft`=默认淡化 tint；`none`=彩色；`mono`=更强的主题色融合。 */
  tint?: "soft" | "none" | "mono";
  /** monogram 内显示的字（不传则取 name 前两字）。 */
  label?: string;
}

function CharacterAvatarImpl({
  name,
  charId,
  size = 40,
  className,
  style,
  tint = "none",
  label,
}: CharacterAvatarProps) {
  const resolver = useCharacterResolver();
  const resolvedId = charId ?? resolver.resolveCharId(name);
  const resolvedName = name ?? (charId ? resolver.resolveName(charId) : null);
  const token = resolvedId ?? name ?? null;
  const initials =
    label ??
    (resolvedName ?? "?")
      .replace(/[^\p{L}\p{N}]/gu, "")
      .slice(0, 2);

  return (
    <AssetImage
      kind="avatar"
      token={token}
      alt={resolvedName ?? name ?? ""}
      // 默认不给头像加 CSS filter。`filter: saturate/brightness` 每个元素
      // 都会生成独立的合成层，一屏 100+ 头像时滚动会严重掉帧。tint=none
      // 让头像保持彩色——这也更符合"看清楚谁是谁"的直觉。
      tint={tint === "mono" ? "tint" : tint === "soft" ? "soft" : "none"}
      className={cn(
        "character-avatar rounded-full ring-1 ring-[hsl(var(--color-border)/0.8)]",
        className
      )}
      style={{ width: size, height: size, ...style }}
      fallback={
        <div
          className="character-avatar-monogram flex h-full w-full items-center justify-center rounded-full bg-[hsl(var(--color-secondary))] text-[hsl(var(--color-muted-foreground))] text-xs font-semibold tracking-wide select-none"
          aria-hidden="true"
        >
          {initials || "?"}
        </div>
      }
    />
  );
}

/**
 * 用 `React.memo` 包一层。父组件（CharactersPanel）state 变化时，400+ 个
 * 头像只要 props 不变就不会重新渲染——滚动、搜索、选中等操作的刷新面
 * 大幅减小。
 */
export const CharacterAvatar = memo(CharacterAvatarImpl);
CharacterAvatar.displayName = "CharacterAvatar";

import { type CSSProperties } from "react";
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

export function CharacterAvatar({
  name,
  charId,
  size = 40,
  className,
  style,
  tint = "soft",
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
      tint={tint === "mono" ? "tint" : tint === "soft" ? "soft" : "none"}
      className={cn("character-avatar rounded-full ring-1 ring-[hsl(var(--color-border)/0.8)]", className)}
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

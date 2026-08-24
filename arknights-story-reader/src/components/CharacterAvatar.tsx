import { memo, type CSSProperties } from "react";
import { AssetImage } from "@/components/AssetImage";
import { useCharacterResolver } from "@/hooks/useCharacterResolver";
import { hasNpcAvatarOverride } from "@/lib/assetUrls";
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
  const cleanName = name?.trim() || null;
  const cleanCharId = charId?.trim() || null;
  // 既支持真正的 charId（char_xxx），也支持名字 / 内部 alias（如
  // 干员密录路径里的 `kroos`、`amgoat`）。charId 解析失败时必须再用
  // name 解析一次——密录路径里的 alias 与 charId 尾段对不上时，卡片
  // 标题里的干员名还能把头像救回来；之前 `resolveCharId(charId) ?? charId`
  // 把解析不出的原始 alias 当结果返回，name 这条救援路径永远走不到。
  // 两侧都失败才保留原始 charId 作为 monogram 兜底 token。
  const resolvedId =
    (cleanCharId ? resolver.resolveCharId(cleanCharId) : null) ??
    resolver.resolveCharId(cleanName) ??
    cleanCharId ??
    null;
  // 空字符串 / 纯空白不是有效显示名，不能挡住 charId → 中文名的回填。
  const resolvedName = cleanName ?? (resolvedId ? resolver.resolveName(resolvedId) : null);

  // NPC 覆盖名（普瑞赛斯等）不在干员表里，随台词传来的 charId 只可能是
  // 解析器「[Dialog(name=...)] 只写显示名就继承上一条 [Character] 立绘」
  // 的启发式误配的别人的 id。charId 是 char_ 前缀时总能解析成功，若不在
  // 这里让覆盖名优先，NPC 的台词就会顶着上一位干员的头像。
  const npcName = cleanName && hasNpcAvatarOverride(cleanName) ? cleanName : null;
  const token = npcName ?? resolvedId ?? cleanName ?? null;
  // 名字里可能出现增补平面字符（生僻汉字等），`String#slice` 按 UTF-16
  // 单元切会把代理对劈成两半、渲染成 "�"。先清洗掉标点再按码点取前两个。
  const initials =
    label ??
    Array.from((resolvedName ?? "").replace(/[^\p{L}\p{N}]/gu, ""))
      .slice(0, 2)
      .join("");

  return (
    <AssetImage
      kind="avatar"
      token={token}
      alt={resolvedName ?? ""}
      // 默认不给头像加 CSS filter。`filter: saturate/brightness` 每个元素
      // 都会生成独立的合成层，一屏 100+ 头像时滚动会严重掉帧。tint=none
      // 让头像保持彩色——这也更符合"看清楚谁是谁"的直觉。
      tint={tint === "mono" ? "tint" : tint === "soft" ? "soft" : "none"}
      className={cn(
        // `shrink-0`：头像常放在 flex 行里（人物卡片、剧情导览的角色行），
        // 名字过长时不能把头像压扁。
        "character-avatar shrink-0 rounded-full ring-1 ring-[hsl(var(--color-border)/0.8)]",
        className
      )}
      // min 宽高双向钉死：flex 行里防压扁靠 minWidth，flex 列里防压瘪靠
      // minHeight——图片加载前后盒子尺寸永远不变，不产生布局位移。
      style={{ width: size, height: size, minWidth: size, minHeight: size, ...style }}
      fallback={
        <div
          className="character-avatar-monogram flex h-full w-full items-center justify-center rounded-full bg-[hsl(var(--color-secondary))] text-[hsl(var(--color-muted-foreground))] font-semibold tracking-wide select-none"
          style={{ fontSize: Math.max(9, Math.round(size * 0.34)) }}
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

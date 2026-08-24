import type { StoryEntry } from "@/types/story";

export type FavoriteGroupType = "chapter" | "activity" | "memory" | "other";

export interface FavoriteGroup {
  id: string;
  name: string;
  type: FavoriteGroupType;
  storyIds: string[];
  stories: Record<string, StoryEntry>;
  excludedStoryIds?: string[];
}

export interface FavoriteGroupPayload {
  id: string;
  name: string;
  type?: FavoriteGroupType;
  stories: StoryEntry[];
}

export interface CatalogGroupSnapshot {
  id: string;
  name: string;
  type: FavoriteGroupType;
  stories: StoryEntry[];
}

export type FavoriteStoryMap = Record<string, StoryEntry>;

export interface FavoritesState {
  stories: FavoriteStoryMap;
  groups: Record<string, FavoriteGroup>;
}

export const EMPTY_FAVORITES: FavoritesState = { stories: {}, groups: {} };

export function sanitizeFavoriteStoryMap(input: unknown): FavoriteStoryMap {
  if (!input || typeof input !== "object") return {};
  const sanitized: FavoriteStoryMap = {};
  for (const value of Object.values(input as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const story = value as StoryEntry;
    if (typeof story.storyId !== "string" || !story.storyId) continue;
    // storyId is authoritative. A corrupt map key must not create a ghost
    // favorite that cannot be looked up or removed by its actual ID.
    sanitized[story.storyId] = story;
  }
  return sanitized;
}

export function sanitizeFavoriteGroupMap(input: unknown): Record<string, FavoriteGroup> {
  if (!input || typeof input !== "object") return {};
  const groups: Record<string, FavoriteGroup> = {};
  for (const [groupId, value] of Object.entries(input as Record<string, unknown>)) {
    if (!groupId || !value || typeof value !== "object") continue;
    const raw = value as Partial<FavoriteGroup>;
    const allStories = sanitizeFavoriteStoryMap(raw.stories);
    const storedIds = Array.isArray(raw.storyIds)
      ? raw.storyIds.filter(
          (id): id is string =>
            typeof id === "string" && Object.prototype.hasOwnProperty.call(allStories, id)
        )
      : [];
    const storyIds = Array.from(new Set(storedIds.length > 0 ? storedIds : Object.keys(allStories)));
    if (storyIds.length === 0) continue;

    const stories: FavoriteStoryMap = {};
    storyIds.forEach((id) => {
      stories[id] = allStories[id];
    });
    const excludedStoryIds = Array.isArray(raw.excludedStoryIds)
      ? Array.from(
          new Set(
            raw.excludedStoryIds.filter(
              (id): id is string => typeof id === "string" && id.length > 0
            )
          )
        )
      : [];
    const type: FavoriteGroupType =
      raw.type === "chapter" ||
      raw.type === "activity" ||
      raw.type === "memory" ||
      raw.type === "other"
        ? raw.type
        : "other";
    groups[groupId] = {
      id: groupId,
      name: typeof raw.name === "string" && raw.name ? raw.name : groupId,
      type,
      storyIds,
      stories,
      ...(excludedStoryIds.length > 0 ? { excludedStoryIds } : {}),
    };
  }
  return groups;
}

export function parseFavoritesStorage(raw: string | null): FavoritesState {
  if (!raw) return EMPTY_FAVORITES;
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") return EMPTY_FAVORITES;
  const state = parsed as Partial<FavoritesState>;
  if ("stories" in state || "groups" in state) {
    return {
      stories: sanitizeFavoriteStoryMap(state.stories),
      groups: sanitizeFavoriteGroupMap(state.groups),
    };
  }
  // Legacy shape: the root object was the standalone story map.
  return { stories: sanitizeFavoriteStoryMap(parsed), groups: {} };
}

export function serializeFavoritesState(state: FavoritesState): string {
  return JSON.stringify(state);
}

export function collectFavoriteGroupStoryIds(
  groups: Record<string, FavoriteGroup>
): Set<string> {
  const ids = new Set<string>();
  for (const group of Object.values(groups)) {
    group.storyIds.forEach((id) => ids.add(id));
  }
  return ids;
}

function sameEntry(a: StoryEntry, b: StoryEntry): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export function reconcileFavoritesState(
  previous: FavoritesState,
  catalog: { entries: StoryEntry[]; groups: CatalogGroupSnapshot[] }
): FavoritesState {
  const freshById = new Map<string, StoryEntry>();
  for (const entry of catalog.entries) {
    if (entry && typeof entry === "object" && typeof entry.storyId === "string" && entry.storyId) {
      freshById.set(entry.storyId, entry);
    }
  }
  // Empty/failed catalog reads are not evidence that every favorite vanished.
  if (freshById.size === 0) return previous;

  const freshGroups = new Map<string, CatalogGroupSnapshot>();
  for (const group of catalog.groups) {
    if (group && typeof group.id === "string" && group.id && group.stories.length > 0) {
      freshGroups.set(group.id, group);
    }
  }

  const refreshMap = (stored: FavoriteStoryMap): FavoriteStoryMap | null => {
    let changed = false;
    const next: FavoriteStoryMap = {};
    for (const [id, story] of Object.entries(stored)) {
      const fresh = freshById.get(id);
      if (fresh && !sameEntry(fresh, story)) {
        next[id] = fresh;
        changed = true;
      } else {
        next[id] = story;
      }
    }
    return changed ? next : null;
  };

  const refreshedStories = refreshMap(previous.stories);
  let groupsChanged = false;
  const nextGroups: Record<string, FavoriteGroup> = {};
  for (const [groupId, group] of Object.entries(previous.groups)) {
    const catalogGroup = freshGroups.get(groupId);
    if (!catalogGroup) {
      const refreshed = refreshMap(group.stories);
      nextGroups[groupId] = refreshed ? { ...group, stories: refreshed } : group;
      groupsChanged ||= refreshed !== null;
      continue;
    }

    const excluded = new Set(group.excludedStoryIds ?? []);
    const stories: FavoriteStoryMap = {};
    const storyIds: string[] = [];
    for (const story of catalogGroup.stories) {
      if (!story || typeof story.storyId !== "string" || excluded.has(story.storyId)) continue;
      if (stories[story.storyId]) continue;
      stories[story.storyId] = story;
      storyIds.push(story.storyId);
    }
    if (storyIds.length === 0) {
      groupsChanged = true;
      continue;
    }
    const sameMembers =
      storyIds.length === group.storyIds.length &&
      storyIds.every((id, index) => id === group.storyIds[index]) &&
      storyIds.every(
        (id) => Boolean(group.stories[id]) && sameEntry(stories[id], group.stories[id])
      );
    if (sameMembers && catalogGroup.name === group.name && catalogGroup.type === group.type) {
      nextGroups[groupId] = group;
      continue;
    }
    nextGroups[groupId] = {
      id: groupId,
      name: catalogGroup.name,
      type: catalogGroup.type,
      storyIds,
      stories,
      ...(group.excludedStoryIds?.length
        ? { excludedStoryIds: group.excludedStoryIds }
        : {}),
    };
    groupsChanged = true;
  }

  if (!refreshedStories && !groupsChanged) return previous;
  return {
    stories: refreshedStories ?? previous.stories,
    groups: groupsChanged ? nextGroups : previous.groups,
  };
}

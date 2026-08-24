/**
 * 人物统计收到数据更新时的纯状态转移。
 *
 * epoch 每次都递增，使更新前启动的扫描失去发布 / 落盘资格；只有确实有扫描
 * 在途时才排一个 force，避免面板不可见且空闲时回来后无意义地连续扫两遍。
 */
export interface CharacterStatsRefreshPlan {
  nextEpoch: number;
  queueForcedRefresh: boolean;
  deferUntilVisible: boolean;
}

export function planCharacterStatsDataUpdate(
  currentEpoch: number,
  scanInFlight: boolean,
  panelActive: boolean
): CharacterStatsRefreshPlan {
  return {
    nextEpoch: currentEpoch + 1,
    queueForcedRefresh: scanInFlight,
    deferUntilVisible: !panelActive,
  };
}

/** 发布 UI、写统计缓存前都必须仍属于当前数据目录代际。 */
export function isCharacterStatsEpochCurrent(
  runEpoch: number,
  currentEpoch: number
): boolean {
  return runEpoch === currentEpoch;
}

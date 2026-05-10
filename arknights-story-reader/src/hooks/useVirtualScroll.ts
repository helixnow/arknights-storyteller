import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

export interface VirtualItem {
  index: number;
  start: number;
  size: number;
}

interface UseVirtualScrollOptions {
  itemCount: number;
  estimatedItemSize: number | ((index: number) => number);
  overscan?: number;
  enabled?: boolean;
}

interface UseVirtualScrollResult {
  virtualItems: VirtualItem[];
  totalSize: number;
  scrollToIndex: (index: number, align?: "start" | "center" | "end") => void;
  measureElement: (index: number, element: HTMLElement) => void;
}

/**
 * 轻量级虚拟滚动 hook，仅渲染可视窗口内的项，大幅降低长列表 DOM 开销
 */
export function useVirtualScroll(
  scrollContainerRef: React.RefObject<HTMLElement | null>,
  options: UseVirtualScrollOptions
): UseVirtualScrollResult {
  const { itemCount, estimatedItemSize, overscan = 3, enabled = true } = options;

  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const measurementsRef = useRef<Map<number, number>>(new Map());
  // 跟踪测量版本，确保 useMemo 在测量变更后重新计算
  const [measurementsVersion, setMeasurementsVersion] = useState(0);

  // 计算每项的累计位置
  const { items, totalSize } = useMemo(() => {
    if (!enabled || itemCount === 0) {
      return { items: [], totalSize: 0 };
    }

    const items: VirtualItem[] = [];
    let runningOffset = 0;
    const getEstimatedSize = typeof estimatedItemSize === "function" 
      ? estimatedItemSize 
      : () => estimatedItemSize;

    for (let i = 0; i < itemCount; i++) {
      const size = measurementsRef.current.get(i) ?? getEstimatedSize(i);
      items.push({
        index: i,
        start: runningOffset,
        size,
      });
      runningOffset += size;
    }

    return { items, totalSize: runningOffset };
  }, [itemCount, estimatedItemSize, enabled, measurementsVersion]);

  // 计算可见范围
  const virtualItems = useMemo(() => {
    if (!enabled || items.length === 0 || containerHeight === 0) {
      return items;
    }

    const viewportStart = scrollTop;
    const viewportEnd = scrollTop + containerHeight;

    let startIndex = 0;
    let endIndex = items.length - 1;

    // 二分查找可见起点
    let low = 0;
    let high = items.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const item = items[mid];
      if (item.start + item.size < viewportStart) {
        low = mid + 1;
      } else {
        high = mid - 1;
        startIndex = mid;
      }
    }

    // 找到终点
    for (let i = startIndex; i < items.length; i++) {
      const item = items[i];
      if (item.start > viewportEnd) {
        endIndex = i - 1;
        break;
      }
    }

    // 添加 overscan 缓冲区
    const rangeStart = Math.max(0, startIndex - overscan);
    const rangeEnd = Math.min(items.length - 1, endIndex + overscan);

    return items.slice(rangeStart, rangeEnd + 1);
  }, [enabled, items, scrollTop, containerHeight, overscan]);

  // 监听滚动位置
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !enabled) return;

    let frame = 0;
    const handleScroll = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setScrollTop(container.scrollTop);
      });
    };

    handleScroll();
    container.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      container.removeEventListener("scroll", handleScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scrollContainerRef, enabled]);

  // 监听容器尺寸变化
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !enabled) return;

    const updateHeight = () => {
      setContainerHeight(container.clientHeight);
    };

    updateHeight();

    const resizeObserver = new ResizeObserver(updateHeight);
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, [scrollContainerRef, enabled]);

  // 测量实际元素尺寸
  const measureElement = (index: number, element: HTMLElement) => {
    if (!enabled) return;
    
    const currentSize = measurementsRef.current.get(index);
    const newSize = element.offsetHeight;

    if (currentSize !== newSize) {
      measurementsRef.current.set(index, newSize);
      // 触发重新计算
      setMeasurementsVersion((v) => v + 1);
    }
  };

  // 滚动到指定索引
  const scrollToIndex = (index: number, align: "start" | "center" | "end" = "start") => {
    const container = scrollContainerRef.current;
    if (!container || !enabled || index < 0 || index >= items.length) return;

    const item = items[index];
    if (!item) return;

    let targetScrollTop = item.start;

    if (align === "center") {
      targetScrollTop = item.start - containerHeight / 2 + item.size / 2;
    } else if (align === "end") {
      targetScrollTop = item.start + item.size - containerHeight;
    }

    targetScrollTop = Math.max(0, Math.min(targetScrollTop, totalSize - containerHeight));

    container.scrollTo({
      top: targetScrollTop,
      behavior: "smooth",
    });
  };

  return {
    virtualItems,
    totalSize,
    scrollToIndex,
    measureElement,
  };
}


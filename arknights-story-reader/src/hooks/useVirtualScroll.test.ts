import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVirtualScroll } from './useVirtualScroll';

describe('useVirtualScroll', () => {
  let containerRef: React.RefObject<HTMLDivElement>;
  let mockContainer: Partial<HTMLDivElement>;

  beforeEach(() => {
    mockContainer = {
      clientHeight: 600,
      scrollTop: 0,
      scrollHeight: 10000,
      scrollTo: vi.fn() as unknown as HTMLDivElement['scrollTo'],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    
    containerRef = {
      current: mockContainer as HTMLDivElement,
    };
  });

  it('应该返回虚拟项列表', () => {
    const { result } = renderHook(() =>
      useVirtualScroll(containerRef, {
        itemCount: 100,
        estimatedItemSize: 100,
        enabled: true,
      })
    );

    expect(result.current.virtualItems).toBeDefined();
    expect(result.current.totalSize).toBe(10000); // 100 items * 100px
  });

  it('禁用时应该返回空虚拟项', () => {
    const { result } = renderHook(() =>
      useVirtualScroll(containerRef, {
        itemCount: 100,
        estimatedItemSize: 100,
        enabled: false,
      })
    );

    expect(result.current.virtualItems).toEqual([]);
    expect(result.current.totalSize).toBe(0);
  });

  it('应该支持动态高度估算函数', () => {
    const estimateSize = (index: number) => {
      if (index % 2 === 0) return 80;  // 偶数项短
      return 120; // 奇数项长
    };

    const { result } = renderHook(() =>
      useVirtualScroll(containerRef, {
        itemCount: 10,
        estimatedItemSize: estimateSize,
        enabled: true,
      })
    );

    const totalSize = result.current.totalSize;
    // 5 * 80 + 5 * 120 = 1000
    expect(totalSize).toBe(1000);
  });

  it('测量元素后应该更新虚拟项高度', () => {
    const { result } = renderHook(() =>
      useVirtualScroll(containerRef, {
        itemCount: 10,
        estimatedItemSize: 100,
        enabled: true,
      })
    );

    const initialTotalSize = result.current.totalSize;
    expect(initialTotalSize).toBe(1000); // 10 * 100

    // 模拟测量第 0 项实际高度为 150
    const mockElement = { offsetHeight: 150 } as HTMLElement;
    
    act(() => {
      result.current.measureElement(0, mockElement);
    });

    const newTotalSize = result.current.totalSize;
    // 150 + 9 * 100 = 1050
    expect(newTotalSize).toBe(1050);
  });

  it('scrollToIndex 应该调用容器的 scrollTo', () => {
    const { result } = renderHook(() =>
      useVirtualScroll(containerRef, {
        itemCount: 100,
        estimatedItemSize: 100,
        enabled: true,
      })
    );

    act(() => {
      result.current.scrollToIndex(10, 'start');
    });

    expect(mockContainer.scrollTo).toHaveBeenCalledWith({
      top: 1000, // index 10 * 100px
      behavior: 'smooth',
    });
  });

  it('overscan 应该增加缓冲区', () => {
    // 容器高度 600，每项 100，可见 6 项
    // overscan=3，应该渲染 6 + 3*2 = 12 项
    const { result } = renderHook(() =>
      useVirtualScroll(containerRef, {
        itemCount: 100,
        estimatedItemSize: 100,
        overscan: 3,
        enabled: true,
      })
    );

    // 模拟滚动到顶部
    act(() => {
      if (mockContainer.scrollTop !== undefined) {
        mockContainer.scrollTop = 0;
      }
    });

    // 虚拟项应该包含可见+缓冲
    // 实际数量取决于 scrollTop 和容器高度的计算
    expect(result.current.virtualItems.length).toBeGreaterThan(6);
    expect(result.current.virtualItems.length).toBeLessThanOrEqual(12);
  });
});


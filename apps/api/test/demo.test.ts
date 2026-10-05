import {describe,expect,it} from 'vitest';
import {demoMetricPoints} from '../src/demo.js';

describe('demo workspace metrics',()=>{
  it('generates a full day of quarter-hour samples',()=>{
    const points=demoMetricPoints(28,0);
    expect(points).toHaveLength(96);
    expect(points[0].minutesAgo).toBe(1425);
    expect(points.at(-1)?.minutesAgo).toBe(0);
  });

  it('keeps simulated utilization within operational bounds',()=>{
    const points=demoMetricPoints(80,3);
    for(const point of points){
      expect(point.cpu).toBeGreaterThanOrEqual(2);
      expect(point.cpu).toBeLessThanOrEqual(92);
      expect(point.memory).toBeGreaterThanOrEqual(10);
      expect(point.memory).toBeLessThanOrEqual(94);
      expect(point.disk).toBeLessThanOrEqual(89);
      expect(point.load).toBeGreaterThanOrEqual(0.1);
    }
  });

  it('varies samples instead of returning static placeholder values',()=>{
    const points=demoMetricPoints(28,1);
    expect(new Set(points.map(point=>point.cpu.toFixed(2))).size).toBeGreaterThan(20);
  });
});

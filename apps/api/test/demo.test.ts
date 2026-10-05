import assert from 'node:assert/strict';
import test from 'node:test';
import {demoMetricPoints} from '../src/demo.js';

test('demo workspace metrics generate a full day of quarter-hour samples',()=>{
  const points=demoMetricPoints(28,0);
  assert.equal(points.length,96);
  assert.equal(points[0]?.minutesAgo,1425);
  assert.equal(points.at(-1)?.minutesAgo,0);
});

test('demo workspace metrics stay within operational bounds',()=>{
  const points=demoMetricPoints(80,3);
  for(const point of points){
    assert.ok(point.cpu>=2);
    assert.ok(point.cpu<=92);
    assert.ok(point.memory>=10);
    assert.ok(point.memory<=94);
    assert.ok(point.disk<=89);
    assert.ok(point.load>=0.1);
  }
});

test('demo workspace metrics vary instead of returning static placeholder values',()=>{
  const points=demoMetricPoints(28,1);
  assert.ok(new Set(points.map(point=>point.cpu.toFixed(2))).size>20);
});

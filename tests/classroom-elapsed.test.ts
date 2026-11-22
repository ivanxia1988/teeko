import test from 'node:test';
import assert from 'node:assert/strict';
import { ClassroomElapsedClock } from '../lib/classroom-elapsed';

test('elapsed display follows monotonic time between authoritative snapshots and freezes offline',()=>{
 const clock=new ClassroomElapsedClock();clock.synchronize(28,600,100);clock.setRunning(true,100);
 assert.equal(clock.read(2100),30);clock.synchronize(29,600,2200);assert.equal(Math.floor(clock.read(2200)),30);
 clock.setRunning(false,3200);assert.equal(Math.floor(clock.read(9999)),31);
 clock.synchronize(32,600,10000);clock.setRunning(true,10000);assert.equal(Math.floor(clock.read(11000)),33);
});
test('elapsed display never passes the server time limit and does not count preflight',()=>{
 const clock=new ClassroomElapsedClock();clock.synchronize(28,30,100);
 assert.equal(clock.read(5000),28);clock.setRunning(true,5000);assert.equal(clock.read(10000),30);
});

test('paused authoritative totals replace a provisional display before resuming',()=>{
 const clock=new ClassroomElapsedClock();clock.synchronize(28,600,0);clock.setRunning(true,0);assert.equal(clock.read(3000),31);
 clock.synchronize(30,600,3000,false);clock.setRunning(false,3000);assert.equal(clock.read(9000),30);
 clock.setRunning(true,9000);assert.equal(clock.read(10000),31);
});

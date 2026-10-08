import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initSync, TemporalDsp } from '../public/dsp/pulseframe_dsp.js';
const {memory}=initSync({module:readFileSync(new URL('../public/dsp/pulseframe_dsp_bg.wasm',import.meta.url))});

for(const rate of [44100,48000]) {
  test(`compiled experimental detector reports clicks, bounded tempo and causal timing at ${rate} Hz`,()=>{
    const detector=new TemporalDsp(rate),events=[],tempos=[];
    const duration=10,period=Math.round(rate*.5);
    try {
      for(let end=512;end<=rate*duration;end+=512) {
        const input=new Float32Array(memory.buffer,detector.input_ptr(),2048);
        for(let n=0;n<input.length;n++) {
          const index=end-2048+n,phase=(index-rate)%period;
          input[n]=index>=rate&&phase>=0&&phase<128 ? .8*Math.exp(-phase/20)*(phase%2?-1:1) : 0;
        }
        detector.observe(end);
        const output=new Float64Array(memory.buffer,detector.output_ptr(),7);
        assert.ok([...output].every(Number.isFinite));assert.ok(output[5]>=0&&output[5]<=1);
        if(output[1]>=0) {assert.ok(output[1]<=end/rate);events.push(output[1]);}
        if(output[3]>0) tempos.push(output[3]);
      }
      assert.equal(events.length,18);
      for(let i=0;i<events.length;i++) assert.ok(Math.abs(events[i]-(1+i*.5))<.035,`click ${i} at ${events[i]}`);
      assert.ok(tempos.length>0);assert.ok(Math.abs(tempos.at(-1)-120)<3||Math.abs(tempos.at(-1)-60)<3);
      detector.observe(512); // A seek restarts history rather than inventing a beat.
      const reset=new Float64Array(memory.buffer,detector.output_ptr(),7);
      assert.deepEqual([...reset].slice(0,6),[0,-1,0,0,0,0]);
    } finally {detector.free();}
  });
}

test('compiled temporal warmup and DC/silence never manufacture tempo',()=>{
  const detector=new TemporalDsp(48000);
  try {
    for(const value of [0,.25]) {
      detector.reset();
      for(let hop=1;hop<=500;hop++) {
        new Float32Array(memory.buffer,detector.input_ptr(),2048).fill(value);
        detector.observe(hop*512);
        const metrics=new Float64Array(memory.buffer,detector.output_ptr(),7);
        assert.equal(metrics[1],-1);assert.equal(metrics[3],0);assert.equal(metrics[5],0);
      }
    }
  } finally {detector.free();}
});

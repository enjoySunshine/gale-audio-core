/*!
 * Node-runnable tests for the sample-locked storm scene in examples/3d.
 *
 * Run: node tests/js/scene.test.js
 *
 * These tests drive the real src/howler.core.js, src/plugins/howler.spatial.js
 * and src/plugins/howler.scene.js against a mock AudioContext that records
 * source scheduling and node wiring. They verify the guarantees the 3D demo
 * relies on: one shared integer scene sample, sample-exact pause/resume
 * (including across a >30s context suspension), audio-clock-only lead time,
 * late triggers anchoring at the current sample, scene rate scaling, the
 * three mixer buses, spatial distance attenuation and single-buffer memory.
 */

'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var mock = require('./webaudio-mock.js');

mock.install();

function load(rel) {
  var code = fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
  vm.runInThisContext(code, {filename: rel});
}

load('src/howler.core.js');
load('src/plugins/howler.spatial.js');
load('src/plugins/howler.scene.js');

// ---------------------------------------------------------------------------
// Tiny test harness.
// ---------------------------------------------------------------------------
var passed = 0;
var failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log('  ok - ' + msg);
  } else {
    failed++;
    console.error('  FAIL - ' + msg);
  }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + ' (expected ' + expected + ', got ' + actual + ')');
}
function approx(actual, expected, eps, msg) {
  ok(Math.abs(actual - expected) <= eps,
    msg + ' (expected ~' + expected + ', got ' + actual + ')');
}

// The AudioContext is created lazily by the first Howl construction.
/* eslint-disable no-new */
new Howl({src: [global.TEST_WAV_DATA_URI]});
/* eslint-enable no-new */
var ctx = Howler.ctx;
var RATE = ctx.sampleRate;

function tick(seconds) {
  ctx.tick(seconds);
}

function flush() {
  return new Promise(function(resolve) {
    setTimeout(resolve, 0);
  });
}

function makeHowl(sprite) {
  return new Howl({
    src: [global.TEST_WAV_DATA_URI],
    sprite: sprite || {
      lightning: [2000, 4147],
      rain: [8000, 9962, true],
      thunder: [19000, 13858],
      music: [34000, 31994, true]
    },
    volume: 1
  });
}

function whenLoaded(howl) {
  if (howl._state === 'loaded') {
    return Promise.resolve();
  }
  return new Promise(function(resolve) {
    howl.once('load', resolve);
  }).then(flush);
}

function makeScene(howl) {
  var scene = new Howler.Scene({
    howl: howl,
    lead: 0.25,
    buses: {rain: 0.2, storm: 1, speaker: 1}
  });
  scenes.push(scene);
  return scene;
}

var scenes = [];

function activeSources() {
  return ctx.sources.filter(function(s) { return !s.stopped; });
}

function voicesOnBus(howl, busName) {
  return howl._sounds.filter(function(s) { return s._bus === busName; });
}

var tests = [];
function test(name, fn) {
  tests.push({name: name, fn: fn});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('1. One decoded buffer shared by every voice (no 4x memory)', function() {
  ctx.resetRecords();
  var howl = makeHowl();
  var scene = makeScene(howl);

  scene.start([
    {sprite: 'rain', bus: 'rain', loop: true, volume: 1},
    {sprite: 'music', bus: 'speaker', loop: true, volume: 1,
      pos: [1, 1, -0.5], pannerAttr: {refDistance: 0.8, rolloffFactor: 2.5, distanceModel: 'exponential'}}
  ]);

  return whenLoaded(howl).then(function() {
    var buffers = {};
    ctx.sources.forEach(function(s) {
      buffers[s.buffer] = true;
    });
    eq(Object.keys(buffers).length, 1, 'all sources reference the same AudioBuffer');
    var decoded = howl._sounds[0]._node.bufferSource.buffer;
    ok(ctx.sources.every(function(s) { return s.buffer === decoded; }),
      'every source uses the single buffer decoded for the Howl');
  });
});

test('2. Lead time is audio-clock only; sample stays at 0 while waiting', function() {
  ctx.resetRecords();
  var howl = makeHowl();
  return whenLoaded(howl).then(function() {
    var scene = makeScene(howl);
    var startCtxTime = ctx.currentTime;
    scene.start([{sprite: 'rain', bus: 'rain', loop: true}]);

    eq(scene.sample(), 0, 'scene sample is 0 immediately after start call');
    eq(scene.sample(), 0, 'scene sample remains 0 inside the lead window');

    var src = ctx.sources[ctx.sources.length - 1];
    approx(src.started[0], startCtxTime + 0.25, 1e-9,
      'first source is scheduled at currentTime + 250ms on the audio clock');
  });
});

test('3. Scene sample is an integer advancing at the audio clock', function() {
  ctx.resetRecords();
  var howl = makeHowl();
  return whenLoaded(howl).then(function() {
    var scene = makeScene(howl);
    scene.start([{sprite: 'rain', bus: 'rain', loop: true}]);

    // 0.25s lead: no scene samples accrue until the scheduled start time.
    tick(0.25);
    eq(scene.sample(), 0, 'sample stays 0 up to the end of the lead window');

    tick(1.0);
    var s1 = scene.sample();
    ok(Number.isInteger(s1), 'sample is an integer after 1s of playback');
    approx(s1, RATE, 1, 'sample ~= sampleRate after 1s of playback');

    tick(0.5);
    var s2 = scene.sample();
    ok(Number.isInteger(s2), 'sample stays an integer after another 0.5s');
    ok(s2 > s1, 'sample advances monotonically');
  });
});

test('4. All initial voices start at the same audio time and anchor sample', function() {
  ctx.resetRecords();
  var howl = makeHowl();
  return whenLoaded(howl).then(function() {
    var scene = makeScene(howl);
    scene.start([
      {sprite: 'rain', bus: 'rain', loop: true},
      {sprite: 'music', bus: 'speaker', loop: true,
        pos: [2, 2, -0.5], pannerAttr: {refDistance: 0.8, rolloffFactor: 2.5, distanceModel: 'exponential'}}
    ]);

    var recent = ctx.sources.slice(-2);
    eq(recent[0].started[0], recent[1].started[0],
      'rain and speaker start at identical audio time');
    approx(recent[0].started[1], 8, 1e-9, 'rain starts at sprite offset 8000ms');
    approx(recent[1].started[1], 34, 1e-9, 'music starts at sprite offset 34000ms');
  });
});

test('5. Pause freezes the sample; resume continues from the same integer', function() {
  ctx.resetRecords();
  var howl = makeHowl();
  return whenLoaded(howl).then(function() {
    var scene = makeScene(howl);
    scene.start([{sprite: 'rain', bus: 'rain', loop: true}]);

    tick(0.25 + 2);
    var atPause = scene.sample();
    scene.pause();
    eq(scene.sample(), atPause, 'sample frozen at pause');

    tick(10);
    eq(scene.sample(), atPause, 'sample does not move while paused');

    scene.resume();
    eq(scene.sample(), atPause, 'resume begins at the exact paused sample');

    tick(1);
    ok(scene.sample() > atPause, 'sample advances again after resume');
    ok(Number.isInteger(scene.sample()), 'resumed sample is still an integer');
  });
});

test('6. Pause/resume preserves rain loop offset (no loop reset, no drift)', function() {
  ctx.resetRecords();
  var howl = makeHowl();
  return whenLoaded(howl).then(function() {
    var scene = makeScene(howl);
    scene.start([{sprite: 'rain', bus: 'rain', loop: true}]);

    tick(2);
    scene.pause();
    var rainVoice = voicesOnBus(howl, 'rain')[0];
    var pausedOffset = rainVoice._offset;

    tick(5);
    scene.resume();
    var src = ctx.sources[ctx.sources.length - 1];

    approx(src.started[1], pausedOffset / RATE, 1.5 / RATE,
      'resumed source restarts at the captured buffer offset, not the loop start');
    ok(pausedOffset >= 8 * RATE && pausedOffset <= 17.962 * RATE,
      'captured offset lies inside the rain sprite window');
  });
});

test('7. More than 30 seconds paused: suspended wait is not played back', function() {
  ctx.resetRecords();
  var howl = makeHowl();
  return whenLoaded(howl).then(function() {
    var scene = makeScene(howl);
    scene.start([{sprite: 'rain', bus: 'rain', loop: true}]);

    tick(0.25 + 1);
    var atPause = scene.sample();
    scene.pause();

    // Simulate Howler's 30-second auto-suspend: the context stops advancing.
    ctx.state = 'suspended';
    tick(45);
    eq(ctx.state, 'suspended', 'mock clock does not advance while suspended');
    eq(scene.sample(), atPause, 'no samples consumed during long suspension');

    scene.resume();

    // The context resume is asynchronous (as in real browsers); wait for the
    // scene's restart polling to run once the context is running again.
    return new Promise(function(resolve) {
      setTimeout(resolve, 60);
    }).then(function() {
      eq(ctx.state, 'running', 'context is running again after resume');
      eq(scene.sample(), atPause, 'resume still on the original sample after >30s');
      tick(1);
      approx(scene.sample(), atPause + RATE, 1, 'only post-resume audio time is counted');
    });
  });
});

test('8. Late thunder trigger anchors at the current sample, never pulls back', function() {
  ctx.resetRecords();
  var howl = makeHowl();
  return whenLoaded(howl).then(function() {
    var scene = makeScene(howl);
    scene.start([{sprite: 'rain', bus: 'rain', loop: true}]);

    tick(3);
    var before = scene.sample();
    var id = scene.play({sprite: 'thunder', bus: 'storm', pos: [1, 1, -0.5]});
    var after = scene.sample();

    eq(before, after, 'triggering thunder does not move the scene sample');
    ok(id > 1000, 'play returns a Howler sound id');

    var thunderSrc = ctx.sources[ctx.sources.length - 1];
    approx(thunderSrc.started[0], ctx.currentTime, 1e-9,
      'thunder starts at the current audio time (current scene sample)');
    approx(thunderSrc.started[1], 19, 1e-9, 'thunder starts at its 19000ms sprite offset');
  });
});

test('9. Repositioning a live thunder voice does not restart or jump the sample', function() {
  ctx.resetRecords();
  var howl = makeHowl();
  return whenLoaded(howl).then(function() {
    var scene = makeScene(howl);
    scene.start([{sprite: 'rain', bus: 'rain', loop: true}]);
    var id = scene.play({sprite: 'thunder', bus: 'storm', pos: [0, 0, -0.5]});

    var sampleBefore = scene.sample();
    var sourceCount = ctx.sources.length;
    scene.setPos(id, 1.25, -0.75, -0.5);
    var sampleAfter = scene.sample();

    eq(sampleBefore, sampleAfter, 'scene sample unchanged after repositioning');
    eq(ctx.sources.length, sourceCount, 'no new BufferSource created on setPos (no restart)');

    var voice = scene._voices[id];
    eq(voice._panner.positionX.value, 1.25, 'panner x updated in place');
    eq(voice._panner.positionY.value, -0.75, 'panner y updated in place');
  });
});

test('10. Scene rate 1.5 speeds loops together and scales the sample clock', function() {
  ctx.resetRecords();
  var howl = makeHowl();
  return whenLoaded(howl).then(function() {
    var scene = makeScene(howl);
    scene.start([
      {sprite: 'rain', bus: 'rain', loop: true},
      {sprite: 'music', bus: 'speaker', loop: true,
        pos: [1, 1, -0.5], pannerAttr: {refDistance: 0.8, rolloffFactor: 2.5, distanceModel: 'exponential'}}
    ]);

    tick(1);
    var anchor = scene.sample();
    scene.rate(1.5);
    eq(scene.sample(), anchor, 'rate change re-anchors without a sample jump');

    tick(1);
    approx(scene.sample(), anchor + RATE * 1.5, 1,
      'scene sample advances at 1.5x per audio second');

    var rates = activeSources().map(function(s) { return s.playbackRate.value; });
    ok(rates.every(function(r) { return r === 1.5; }),
      'rain and speaker source rates both become 1.5 (' + rates.join(', ') + ')');
  });
});

test('11. Lightning per-voice rate does not affect the scene sample', function() {
  ctx.resetRecords();
  var howl = makeHowl();
  return whenLoaded(howl).then(function() {
    var scene = makeScene(howl);
    scene.start([{sprite: 'rain', bus: 'rain', loop: true}]);

    tick(1);
    var before = scene.sample();
    scene.play({sprite: 'lightning', bus: 'storm', rate: 0.83, pos: [0.5, -0.5, -0.5]});
    var after = scene.sample();
    eq(before, after, 'lightning trigger leaves the scene sample untouched');

    var lightningSrc = ctx.sources[ctx.sources.length - 1];
    approx(lightningSrc.playbackRate.value, 0.83, 1e-9,
      'lightning keeps its own random rate multiplier');

    tick(1);
    approx(scene.sample(), after + RATE, 1, 'scene clock still advances at 1x');
  });
});

test('11b. Rate change while paused applies on resume without moving the sample', function() {
  ctx.resetRecords();
  var howl = makeHowl();
  return whenLoaded(howl).then(function() {
    var scene = makeScene(howl);
    scene.start([{sprite: 'rain', bus: 'rain', loop: true}]);

    tick(0.25 + 1);
    var atPause = scene.sample();
    scene.pause();
    scene.rate(1.5);
    eq(scene.sample(), atPause, 'rate change during pause keeps the frozen sample');

    scene.resume();
    eq(scene.sample(), atPause, 'resume still on the paused sample');
    tick(1);
    approx(scene.sample(), atPause + RATE * 1.5, 1,
      'after resume the clock advances at the new 1.5x rate');

    var rainSrc = activeSources()[0];
    eq(rainSrc.playbackRate.value, 1.5, 'rain source rate is 1.5 after resume');
  });
});

test('11c. Pause/resume after a rate change keeps rain and speaker in lockstep', function() {
  ctx.resetRecords();
  var howl = makeHowl();
  return whenLoaded(howl).then(function() {
    var scene = makeScene(howl);
    scene.start([
      {sprite: 'rain', bus: 'rain', loop: true},
      {sprite: 'music', bus: 'speaker', loop: true,
        pos: [1, 1, -0.5], pannerAttr: {refDistance: 0.8, rolloffFactor: 2.5, distanceModel: 'exponential'}}
    ]);

    tick(0.25 + 1);
    scene.rate(1.5);
    tick(1);
    scene.pause();
    var frozen = scene.sample();

    var rain = voicesOnBus(howl, 'rain')[0];
    var music = voicesOnBus(howl, 'speaker')[0];
    var rainOffset = rain._offset;
    var musicOffset = music._offset;

    tick(3);
    scene.resume();

    var rainSrc = ctx.sources.filter(function(s) { return !s.stopped; })[0];
    var all = ctx.sources.filter(function(s) { return !s.stopped; });
    eq(all.length, 2, 'both looped voices restarted');
    approx(rainSrc.started[1], rainOffset / RATE, 1.5 / RATE,
      'rain resumes from its captured loop offset');
    ok(all.every(function(s) { return s.started[0] === all[0].started[0]; }),
      'rain and speaker restart at the same audio time');
    eq(scene.sample(), frozen, 'scene sample resumes at the frozen value');
  });
});

test('12. Three mixer buses route independently; zeroing one does not touch the sample', function() {
  ctx.resetRecords();
  var howl = makeHowl();
  return whenLoaded(howl).then(function() {
    var scene = makeScene(howl);
    scene.start([
      {sprite: 'rain', bus: 'rain', loop: true},
      {sprite: 'music', bus: 'speaker', loop: true,
        pos: [3, 3, -0.5], pannerAttr: {refDistance: 0.8, rolloffFactor: 2.5, distanceModel: 'exponential'}}
    ]);
    scene.play({sprite: 'thunder', bus: 'storm', pos: [1, 1, -0.5]});

    eq(Object.keys(scene._buses).length, 3, 'three mixer buses exist');

    var rainVoice = voicesOnBus(howl, 'rain')[0];
    ok(rainVoice._node.connections[0] === scene._buses.rain.node, 'rain routes to rain bus');
    ok(scene._buses.rain.node.connections[0] === Howler.masterGain,
      'rain bus reaches master gain');

    var sampleBefore = scene.sample();
    scene.busVolume('storm', 0);
    var sampleAfter = scene.sample();
    eq(sampleBefore, sampleAfter, 'muting the storm bus does not move the scene sample');
    eq(scene._buses.storm.node.gain.value, 0, 'storm bus gain is 0');
    eq(scene._buses.rain.node.gain.value, 0.2, 'rain bus gain unchanged');
    eq(scene._buses.speaker.node.gain.value, 1, 'speaker bus gain unchanged');
  });
});

test('13. Rain is never spatially attenuated; speaker uses exponential rolloff', function() {
  ctx.resetRecords();
  var howl = makeHowl();
  return whenLoaded(howl).then(function() {
    var scene = makeScene(howl);

    // Move the listener far away from the sources.
    Howler.pos(10, 10, -0.5);

    scene.start([
      {sprite: 'rain', bus: 'rain', loop: true},
      {sprite: 'music', bus: 'speaker', loop: true,
        pos: [0, 0, -0.5], pannerAttr: {refDistance: 0.8, rolloffFactor: 2.5, distanceModel: 'exponential'}}
    ]);

    var rainVoice = voicesOnBus(howl, 'rain')[0];
    ok(!rainVoice._panner, 'rain has no panner node');
    approx(scene.loudness('rain'), 0.2, 1e-9,
      'rain loudness is just its bus volume (no distance gain)');

    var speakerVoice = voicesOnBus(howl, 'speaker')[0];
    eq(speakerVoice._panner.distanceModel, 'exponential', 'speaker panner is exponential');
    eq(speakerVoice._panner.refDistance, 0.8, 'speaker refDistance 0.8');
    eq(speakerVoice._panner.rolloffFactor, 2.5, 'speaker rolloffFactor 2.5');

    var distance = Math.sqrt(100 + 100);
    var expected = Math.pow(distance / 0.8, -2.5);
    approx(scene.loudness('speaker'), expected, 1e-9,
      'speaker loudness follows exponential distance attenuation');

    // Walking toward the speaker raises its loudness while rain stays fixed.
    Howler.pos(0, 0, -0.5);
    approx(scene.loudness('speaker'), 1, 1e-9, 'speaker is full scale at the reference point');
    approx(scene.loudness('rain'), 0.2, 1e-9, 'rain loudness unaffected by listener movement');
  });
});

test('14. Howler master volume scales every scene bus and non-scene sounds', function() {
  ctx.resetRecords();
  var howl = makeHowl();
  return whenLoaded(howl).then(function() {
    var scene = makeScene(howl);
    scene.start([{sprite: 'rain', bus: 'rain', loop: true}]);

    Howler.volume(0.5);
    approx(scene.loudness('rain'), 0.2 * 0.5, 1e-9, 'rain loudness includes master gain');
    Howler.volume(1);
    approx(scene.loudness('rain'), 0.2, 1e-9, 'master gain restored');
    eq(Howler.masterGain.gain.value, 1, 'master gain node reflects Howler.volume');
  });
});

test('15. Looped sources use native loop points and never rebuild on loop boundaries', function() {
  ctx.resetRecords();
  var howl = makeHowl();
  return whenLoaded(howl).then(function() {
    var scene = makeScene(howl);
    scene.start([{sprite: 'rain', bus: 'rain', loop: true}]);

    var rainVoice = voicesOnBus(howl, 'rain')[0];
    var src = rainVoice._src;
    eq(src.loop, true, 'rain BufferSource looping is enabled natively');
    approx(src.loopStart, 8, 1e-9, 'loopStart at 8000ms');
    approx(src.loopEnd, 17.962, 1e-9, 'loopEnd at 17962ms');

    // Advance well past several rain loop cycles (9.962s each).
    tick(40);
    eq(rainVoice._src, src, 'the same source keeps playing across loop wraps');
    ok(scene.sample() > 3 * 9.962 * RATE, 'scene sample advanced through multiple loops');
  });
});

test('16. Non-scene Howl playback still works through the unchanged core API', function() {
  ctx.resetRecords();
  var other = new Howl({src: [global.TEST_WAV_DATA_URI]});

  return whenLoaded(other).then(function() {
    var id = other.play();
    ok(typeof id === 'number', 'plain Howl.play returns an id');
    ok(other.playing(id), 'plain Howl sound is playing');

    other.pause(id);
    ok(!other.playing(id), 'plain Howl pause works');
    other.play(id);
    ok(other.playing(id), 'plain Howl resume works');

    other.rate(1.5, id);
    var snd = other._soundById(id);
    eq(snd._rate, 1.5, 'plain Howl rate change works');
    eq(snd._node.bufferSource.playbackRate.value, 1.5, 'plain source rate applied');

    other.volume(0.3, id);
    approx(snd._volume, 0.3, 1e-9, 'plain Howl volume works');
    other.stop(id);
    ok(!other.playing(id), 'plain Howl stop works');
  });
});

test('17. html5:true sounds keep the HTML5 Audio path (no Web Audio nodes)', function() {
  ctx.resetRecords();
  var html5 = new Howl({src: [global.TEST_WAV_DATA_URI], html5: true});

  return whenLoaded(html5).then(function() {
    ok(html5._webAudio === false, 'html5 Howl is not on Web Audio');
    var id = html5.play();
    ok(typeof id === 'number', 'html5 Howl.play returns an id');
    html5.pause(id);
    html5.play(id);
    html5.stop(id);
    ok(true, 'html5 play/pause/resume/stop run without error');
  });
});

test('18. Spatial plugin stereo/pos API remains intact for standalone sounds', function() {
  ctx.resetRecords();
  var other = new Howl({src: [global.TEST_WAV_DATA_URI]});

  return whenLoaded(other).then(function() {
    var id = other.play();
    other.stereo(-0.5, id);
    var snd = other._soundById(id);
    ok(!!snd._panner, 'stereo creates a panner through the spatial plugin');
    var panValue = snd._panner.pan ? snd._panner.pan.value : snd._panner.positionX.value;
    approx(panValue, -0.5, 1e-9, 'stereo pan value applied');

    other.pos(2, 3, -0.5, id);
    eq(snd._panner.positionX.value, 2, '3D position x applied via spatial plugin');
    eq(snd._panner.positionY.value, 3, '3D position y applied via spatial plugin');
    other.stop(id);
  });
});

test('19. Context suspension during playback (Howler auto-suspend) burns no samples', function() {
  ctx.resetRecords();
  var howl = makeHowl();
  return whenLoaded(howl).then(function() {
    var scene = makeScene(howl);
    scene.start([{sprite: 'rain', bus: 'rain', loop: true}]);

    tick(0.25 + 2);
    var beforeSuspend = scene.sample();

    // The browser suspends the context (Howler does this after 30s idle);
    // the audio clock simply stops while suspended.
    ctx.state = 'suspended';
    tick(35);
    eq(scene.sample(), beforeSuspend, 'scene sample frozen while context is suspended');

    ctx.state = 'running';
    tick(1);
    approx(scene.sample(), beforeSuspend + RATE, 1,
      'clock resumes seamlessly with no drift after the suspended gap');
  });
});

function delay(ms) {
  return new Promise(function(resolve) {
    setTimeout(resolve, ms);
  });
}

test('20. One-shot thunder ends exactly at its sprite end scene sample', function() {
  ctx.resetRecords();
  var howl = makeHowl();
  return whenLoaded(howl).then(function() {
    var scene = makeScene(howl);
    scene.start([{sprite: 'rain', bus: 'rain', loop: true}]);

    tick(0.25);
    var id = scene.play({sprite: 'thunder', bus: 'storm', pos: [1, 1, -0.5]});
    var voice = scene._voices[id];
    var spanSamples = Math.round(13.858 * RATE);
    eq(voice._endSample, spanSamples, 'thunder end sample equals its sprite length');

    // Just before the end, the source is still alive.
    tick((voice._endSample - 1) / RATE);
    eq(scene.sample(), voice._endSample - 1, 'one sample before the thunder end point');
    ok(!voice._ended, 'thunder still playing one sample before its end point');

    // Cross the end sample, then let the scanner run.
    tick(2 / RATE);
    return delay(80).then(function() {
      ok(voice._ended, 'thunder ended at the scene end sample');
      ok(!scene._voices[id], 'ended thunder removed from the scene');
      ok(!scene._buses.storm.voices[id], 'ended thunder removed from its bus');
    });
  });
});

test('21. A one-shot voice does not end while the scene is paused', function() {
  ctx.resetRecords();
  var howl = makeHowl();
  return whenLoaded(howl).then(function() {
    var scene = makeScene(howl);
    scene.start([{sprite: 'rain', bus: 'rain', loop: true}]);

    tick(0.25);
    var id = scene.play({sprite: 'lightning', bus: 'storm', pos: [1, 1, -0.5]});
    var voice = scene._voices[id];

    // Advance most of the way, then pause before the end sample.
    tick(3);
    scene.pause();
    var frozen = scene.sample();
    ok(frozen < voice._endSample, 'paused before the lightning end sample');

    // A lot of wall/audio time passes while paused; the end is not reached.
    tick(30);
    return delay(80).then(function() {
      ok(!voice._ended, 'lightning stays alive across the paused gap');
      scene.resume();
      tick((voice._endSample - frozen) / RATE + 0.01);
      return delay(80);
    }).then(function() {
      ok(voice._ended, 'lightning ends at its end sample after resume');
    });
  });
});

test('22. Lightning per-voice rate moves only its own end sample, not the scene', function() {
  ctx.resetRecords();
  var howl = makeHowl();
  return whenLoaded(howl).then(function() {
    var scene = makeScene(howl);
    scene.start([{sprite: 'rain', bus: 'rain', loop: true}]);

    tick(0.25);
    var normalId = scene.play({sprite: 'lightning', bus: 'storm', pos: [1, 1, -0.5]});
    var slowId = scene.play({sprite: 'lightning', bus: 'storm', rate: 0.5, pos: [-1, -1, -0.5]});

    var normal = scene._voices[normalId];
    var slow = scene._voices[slowId];
    var baseSpan = Math.round(4.147 * RATE);

    eq(normal._endSample, baseSpan, 'rate-1 lightning end sample is its sprite length');
    eq(slow._endSample, Math.round(baseSpan / 0.5),
      'rate-0.5 lightning end sample doubles (it consumes scene samples slower)');

    tick(5);
    var sample = scene.sample();
    ok(sample > normal._endSample, 'scene clock runs independently of the voice rates');
    return delay(80).then(function() {
      ok(normal._ended, 'the rate-1 lightning has ended');
      ok(!slow._ended, 'the rate-0.5 lightning is still playing at the same scene sample');
    });
  });
});

test('23. start() waits for a running context without consuming the lead', function() {
  ctx.resetRecords();
  var howl = makeHowl();
  return whenLoaded(howl).then(function() {
    var scene = makeScene(howl);
    ctx.state = 'suspended';

    scene.start([{sprite: 'rain', bus: 'rain', loop: true}]);
    eq(scene.sample(), 0, 'no samples while the context is suspended');
    eq(ctx.sources.length, 0, 'no sources scheduled while the context is suspended');

    ctx.state = 'running';
    return delay(60).then(function() {
      ok(scene._started, 'scene begins once the context is running');
      eq(ctx.sources.length, 1, 'rain source scheduled after the context resumes');
      approx(ctx.sources[0].started[0], ctx.currentTime + 0.25, 1e-9,
        'the full 250ms lead is still applied once running');
    });
  });
});

test('24. start() during decode keeps the scene sample at 0 until loaded', function() {
  ctx.resetRecords();
  var howl = new Howl({
    src: [global.TEST_WAV_DATA_URI],
    sprite: {rain: [8000, 9962, true]}
  });
  var scene = makeScene(howl);

  scene.start([{sprite: 'rain', bus: 'rain', loop: true}]);
  eq(howl._state === 'loading' || howl._state === 'loaded', true,
    'howl is loading or just loaded');
  eq(scene.sample(), 0, 'sample stays 0 while the file is decoding');
  ok(!scene._started || scene.sample() === 0, 'scene has not advanced pre-load');

  return whenLoaded(howl).then(function() {
    ok(scene._started, 'scene starts automatically on the load event');
    eq(ctx.sources.length, 1, 'rain source scheduled after decode');
    eq(scene.sample(), 0, 'sample begins at 0 once loaded (decode time never counted)');
  });
});

// ---------------------------------------------------------------------------
// Sequential runner.
// ---------------------------------------------------------------------------
function run(i) {
  if (i >= tests.length) {
    // Release scene intervals/nodes so the Node process can exit cleanly.
    scenes.forEach(function(scene) {
      scene.dispose();
    });
    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    process.exitCode = failed ? 1 : 0;
    return;
  }

  console.log('\n' + (i + 1) + '. ' + tests[i].name);
  Promise.resolve()
    .then(tests[i].fn)
    .catch(function(err) {
      failed++;
      console.error('  FAIL - threw: ' + (err && err.stack ? err.stack : err));
    })
    .then(function() {
      run(i + 1);
    });
}

run(0);

/*!
 * Minimal Web Audio / browser mocks used to exercise howler.core.js,
 * howler.spatial.js and howler.scene.js under Node, where no AudioContext
 * exists. The mocks record node wiring, scheduled starts/stops and parameter
 * changes so the scene scheduler's sample-locking behavior can be asserted
 * deterministically.
 */

'use strict';

function MockAudioParam(value) {
  this.value = value;
  this.calls = [];
}
MockAudioParam.prototype.setValueAtTime = function(v, t) {
  this.value = v;
  this.calls.push(['setValueAtTime', v, t]);
};
MockAudioParam.prototype.setTargetAtTime = function(v, t, c) {
  this.value = v;
  this.calls.push(['setTargetAtTime', v, t, c]);
};
MockAudioParam.prototype.linearRampToValueAtTime = function(v, t) {
  this.value = v;
  this.calls.push(['linearRampToValueAtTime', v, t]);
};
MockAudioParam.prototype.cancelScheduledValues = function() {
  this.calls.push(['cancelScheduledValues']);
};

function MockNode(ctx) {
  this.ctx = ctx;
  this.connections = [];
  this.disconnected = false;
}
MockNode.prototype.connect = function(node) {
  this.connections.push(node);
  return node;
};
MockNode.prototype.disconnect = function() {
  this.connections = [];
  this.disconnected = true;
};

function MockGainNode(ctx) {
  MockNode.call(this, ctx);
  this.gain = new MockAudioParam(1);
}
MockGainNode.prototype = Object.create(MockNode.prototype);

function MockStereoPannerNode(ctx) {
  MockNode.call(this, ctx);
  this.pan = new MockAudioParam(0);
}
MockStereoPannerNode.prototype = Object.create(MockNode.prototype);

function MockBufferSource(ctx) {
  MockNode.call(this, ctx);
  this.buffer = null;
  this.loop = false;
  this.loopStart = 0;
  this.loopEnd = 0;
  this.playbackRate = new MockAudioParam(1);
  this.started = null;   // [when, offset, duration]
  this.stopped = false;
  this.onended = null;
}
MockBufferSource.prototype = Object.create(MockNode.prototype);
MockBufferSource.prototype.start = function(when, offset, duration) {
  this.started = [when, offset, typeof duration === 'undefined' ? null : duration];
  this.ctx.sources.push(this);
};
MockBufferSource.prototype.noteGrainOn = function(when, offset, duration) {
  this.start(when, offset, duration);
};
MockBufferSource.prototype.stop = function() {
  this.stopped = true;
  if (this.onended) {
    var fn = this.onended;
    this.onended = null;
    fn();
  }
};
MockBufferSource.prototype.noteOff = function() {
  this.stop();
};

function MockPannerNode(ctx) {
  MockNode.call(this, ctx);
  this.coneInnerAngle = 360;
  this.coneOuterAngle = 360;
  this.coneOuterGain = 0;
  this.distanceModel = 'inverse';
  this.maxDistance = 10000;
  this.panningModel = 'HRTF';
  this.refDistance = 1;
  this.rolloffFactor = 1;
  this.positionX = new MockAudioParam(0);
  this.positionY = new MockAudioParam(0);
  this.positionZ = new MockAudioParam(0);
  this.orientationX = new MockAudioParam(1);
  this.orientationY = new MockAudioParam(0);
  this.orientationZ = new MockAudioParam(0);
}
MockPannerNode.prototype = Object.create(MockNode.prototype);
MockPannerNode.prototype.setPosition = function(x, y, z) {
  this.positionX.value = x;
  this.positionY.value = y;
  this.positionZ.value = z;
};
MockPannerNode.prototype.setOrientation = function(x, y, z) {
  this.orientationX.value = x;
  this.orientationY.value = y;
  this.orientationZ.value = z;
};

function MockListener() {
  this.positionX = new MockAudioParam(0);
  this.positionY = new MockAudioParam(0);
  this.positionZ = new MockAudioParam(0);
  this.forwardX = new MockAudioParam(0);
  this.forwardY = new MockAudioParam(0);
  this.forwardZ = new MockAudioParam(-1);
  this.upX = new MockAudioParam(0);
  this.upY = new MockAudioParam(1);
  this.upZ = new MockAudioParam(0);
}
MockListener.prototype.setPosition = function(x, y, z) {
  this.positionX.value = x;
  this.positionY.value = y;
  this.positionZ.value = z;
};
MockListener.prototype.setOrientation = function(x, y, z, ux, uy, uz) {
  this.forwardX.value = x;
  this.forwardY.value = y;
  this.forwardZ.value = z;
  this.upX.value = ux;
  this.upY.value = uy;
  this.upZ.value = uz;
};

function MockAudioContext(sampleRate) {
  this.sampleRate = sampleRate || 44100;
  this.state = 'running';
  this.currentTime = 0;
  this.listener = new MockListener();
  this.destination = new MockNode(this);
  this.sources = [];
  this.gainNodes = [];
  this.panners = [];
}
MockAudioContext.prototype.createGain = function() {
  var node = new MockGainNode(this);
  this.gainNodes.push(node);
  return node;
};
MockAudioContext.prototype.createGainNode = function() {
  return this.createGain();
};
MockAudioContext.prototype.createBufferSource = function() {
  return new MockBufferSource(this);
};
MockAudioContext.prototype.createPanner = function() {
  var node = new MockPannerNode(this);
  this.panners.push(node);
  return node;
};
MockAudioContext.prototype.createStereoPanner = function() {
  return new MockStereoPannerNode(this);
};
MockAudioContext.prototype.createBuffer = function(channels, length, rate) {
  return {numberOfChannels: channels, length: length, sampleRate: rate};
};
MockAudioContext.prototype.decodeAudioData = function(buffer) {
  var self = this;
  return Promise.resolve(self.createBuffer(2, Math.floor(buffer.byteLength / 4), self.sampleRate));
};
MockAudioContext.prototype.resume = function() {
  this.state = 'running';
  return Promise.resolve();
};
MockAudioContext.prototype.suspend = function() {
  this.state = 'suspended';
  return Promise.resolve();
};
MockAudioContext.prototype.close = function() {
  this.state = 'closed';
  return Promise.resolve();
};

/**
 * Advance the mock audio clock by seconds. Real AudioContext time only moves
 * while the context is running, so suspended time simply does not advance.
 */
MockAudioContext.prototype.tick = function(seconds) {
  if (this.state === 'running') {
    this.currentTime += seconds;
  }
};

/**
 * Clear recorded nodes/sources without rebuilding the context, so each test
 * starts from a known wiring state while keeping the same sampleRate.
 */
MockAudioContext.prototype.resetRecords = function() {
  this.sources = [];
  this.gainNodes = [];
  this.panners = [];
};

function install() {
  // Node 22 exposes read-only globals (navigator, window-less); define them
  // explicitly so the Howler browser code finds a familiar environment.
  var sandbox = global;
  Object.defineProperty(sandbox, 'window', {value: sandbox, configurable: true, writable: true});
  Object.defineProperty(sandbox, 'navigator', {
    value: {userAgent: 'node', vendor: '', platform: 'Linux', appVersion: ''},
    configurable: true,
    writable: true
  });
  sandbox.document = {
    addEventListener: function() {},
    removeEventListener: function() {},
    createElement: function() { return {}; },
    getElementById: function() { return null; }
  };
  sandbox.location = {protocol: 'http:', href: 'http://localhost/'};
  Object.defineProperty(sandbox, 'innerWidth', {value: 1024, configurable: true});
  Object.defineProperty(sandbox, 'innerHeight', {value: 768, configurable: true});
  sandbox.AudioContext = MockAudioContext;
  sandbox.webkitAudioContext = MockAudioContext;
  sandbox.Audio = function() {
    var listeners = {};
    var node = {
      addEventListener: function(name, fn) {
        (listeners[name] = listeners[name] || []).push(fn);
      },
      removeEventListener: function(name, fn) {
        if (listeners[name]) {
          listeners[name] = listeners[name].filter(function(f) { return f !== fn; });
        }
      },
      load: function() {
        // Asynchronously behave like a buffered HTML5 Audio element.
        setTimeout(function() {
          node.readyState = 4;
          node.duration = 10;
          (listeners.canplaythrough || []).forEach(function(fn) { fn(); });
        }, 0);
      },
      play: function() {
        node.paused = false;
        return Promise.resolve();
      },
      pause: function() {
        node.paused = true;
      },
      canPlayType: function(type) {
        // Howler's codec check treats anything other than '' as supported.
        return type.indexOf('wav') >= 0 ? 'maybe' : '';
      },
      volume: 1,
      muted: false,
      paused: true,
      readyState: 0,
      currentTime: 0,
      duration: NaN,
      src: '',
      preload: 'auto',
      ended: false
    };
    return node;
  };
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.atob = function(str) {
    return Buffer.from(str, 'base64').toString('binary');
  };

  // A tiny valid-looking WAV so the data-URI decode path in core is exercised.
  var wav = Buffer.alloc(44 + 8);
  wav.write('RIFF', 0);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(44100, 24);
  wav.write('data', 36);
  sandbox.TEST_WAV_DATA_URI = 'data:audio/wav;base64,' + wav.toString('base64');

  return MockAudioContext;
}

module.exports = {
  install: install,
  MockAudioContext: MockAudioContext
};

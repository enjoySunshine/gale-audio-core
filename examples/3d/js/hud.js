/*!
 *  Howler.js 3D Sound Demo
 *  howlerjs.com
 *
 *  (c) 2013-2020, James Simpson of GoldFire Studios
 *  goldfirestudios.com
 *
 *  MIT License
 */

'use strict';

/**
 * Heads-up display for the sample-locked storm scene. It only reads scene
 * state; walking, the map and the ray-cast rendering are untouched.
 */
var Hud = function() {
  var self = this;

  this.el = {
    sample: document.getElementById('hud-sample'),
    state: document.getElementById('hud-state'),
    rain: document.getElementById('hud-rain'),
    thunder: document.getElementById('hud-thunder'),
    lightning: document.getElementById('hud-lightning'),
    speaker: document.getElementById('hud-speaker'),
    pause: document.getElementById('hud-pause'),
    rainBus: document.getElementById('hud-rain-bus'),
    stormBus: document.getElementById('hud-storm-bus'),
    speakerBus: document.getElementById('hud-speaker-bus'),
    rainBusVal: document.getElementById('hud-rain-bus-val'),
    stormBusVal: document.getElementById('hud-storm-bus-val'),
    speakerBusVal: document.getElementById('hud-speaker-bus-val'),
    rate: document.getElementById('hud-rate')
  };

  this.scene = game.audio.scene;

  // Enable the transport controls once the decoded scene is running.
  var enable = function() {
    self.el.pause.disabled = false;
    self.el.rainBus.disabled = false;
    self.el.stormBus.disabled = false;
    self.el.speakerBus.disabled = false;
    self.el.rate.disabled = false;
  };

  if (this.scene.running) {
    enable();
  } else {
    this.scene.options.onstart = (function(prev) {
      return function() {
        if (prev) {
          prev();
        }
        enable();
      };
    })(this.scene.options.onstart);
  }

  this.el.pause.addEventListener('click', function() {
    if (self.scene.paused) {
      self.scene.resume();
    } else {
      self.scene.pause();
    }
  }, false);

  this._bindBus(this.el.rainBus, 'rain', this.el.rainBusVal);
  this._bindBus(this.el.stormBus, 'storm', this.el.stormBusVal);
  this._bindBus(this.el.speakerBus, 'speaker', this.el.speakerBusVal);

  // Cycle the scene rate. 1.5 is explicitly exercised; 1 returns to normal.
  this.el.rate.addEventListener('click', function() {
    var next = self.scene.sceneRate === 1 ? 1.5 : 1;
    self.scene.setSceneRate(next);
    self.el.rate.innerHTML = next.toFixed(1) + 'x';
  }, false);

  requestAnimationFrame(this.tick.bind(this));
};
Hud.prototype = {
  /**
   * Wire one mix-bus slider to the scene's bus gain. A bus at 0 only silences
   * that bus; the scene sample and the other buses are unaffected.
   */
  _bindBus: function(input, busName, label) {
    var self = this;
    input.addEventListener('input', function() {
      var vol = parseFloat(input.value);
      self.scene.busVolume(busName, vol);
      label.innerHTML = vol.toFixed(2);
    }, false);
  },

  /**
   * Read the scene every animation frame and render the numeric readout.
   * While paused every value simply stops changing and resumes at the same
   * sample.
   */
  tick: function() {
    var scene = this.scene;

    this.el.sample.innerHTML = String(scene.sample());

    if (!scene.running) {
      this.el.state.innerHTML = '等待解码 LOADING';
    } else if (scene.paused) {
      this.el.state.innerHTML = '暂停 PAUSED';
      this.el.pause.innerHTML = '继续 RESUME';
    } else {
      this.el.state.innerHTML = '播放 RUNNING';
      this.el.pause.innerHTML = '暂停 PAUSE';
    }

    scene.updateLoudness();
    this.el.rain.innerHTML = scene.loudness.rain.toFixed(4);
    this.el.thunder.innerHTML = scene.loudness.thunder.toFixed(4);
    this.el.lightning.innerHTML = scene.loudness.lightning.toFixed(4);
    this.el.speaker.innerHTML = scene.loudness.speaker.toFixed(4);

    requestAnimationFrame(this.tick.bind(this));
  }
};

var hud = new Hud();

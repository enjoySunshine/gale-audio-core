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
 * On-screen readout of the shared scene sample position and the four voice
 * loudness values, plus a pause button and the three mixer bus / scene rate
 * controls. All values are plain numbers that update with the scene so they
 * can be read while recording the screen.
 * @param {Game} game
 */
var Hud = function(game) {
  this.game = game;
  this.paused = false;

  var panel = document.createElement('div');
  panel.id = 'hud';
  panel.innerHTML =
    '<div class="hud-row"><span class="hud-label">SCENE SAMPLE</span>' +
      '<span class="hud-value" id="hud-sample">0</span></div>' +
    '<div class="hud-row"><span class="hud-label">RAIN</span>' +
      '<span class="hud-value" id="hud-rain">0.0000</span></div>' +
    '<div class="hud-row"><span class="hud-label">THUNDER</span>' +
      '<span class="hud-value" id="hud-thunder">0.0000</span></div>' +
    '<div class="hud-row"><span class="hud-label">LIGHTNING</span>' +
      '<span class="hud-value" id="hud-lightning">0.0000</span></div>' +
    '<div class="hud-row"><span class="hud-label">SPEAKER</span>' +
      '<span class="hud-value" id="hud-speaker">0.0000</span></div>' +
    '<button id="hud-pause" type="button">PAUSE</button>' +
    '<div class="hud-control"><label>RAIN BUS<input type="range" id="hud-bus-rain" min="0" max="1" step="0.01" value="0.2"></label></div>' +
    '<div class="hud-control"><label>STORM BUS<input type="range" id="hud-bus-storm" min="0" max="1" step="0.01" value="1"></label></div>' +
    '<div class="hud-control"><label>SPEAKER BUS<input type="range" id="hud-bus-speaker" min="0" max="1" step="0.01" value="1"></label></div>' +
    '<div class="hud-control"><label>SCENE RATE<input type="range" id="hud-rate" min="0.5" max="2" step="0.1" value="1"></label>' +
      '<span class="hud-value" id="hud-rate-value">1.0</span></div>';
  document.body.appendChild(panel);

  this.el = {
    sample: document.getElementById('hud-sample'),
    rain: document.getElementById('hud-rain'),
    thunder: document.getElementById('hud-thunder'),
    lightning: document.getElementById('hud-lightning'),
    speaker: document.getElementById('hud-speaker'),
    pause: document.getElementById('hud-pause'),
    busRain: document.getElementById('hud-bus-rain'),
    busStorm: document.getElementById('hud-bus-storm'),
    busSpeaker: document.getElementById('hud-bus-speaker'),
    rate: document.getElementById('hud-rate'),
    rateValue: document.getElementById('hud-rate-value')
  };

  this._bind();
};
Hud.prototype = {
  /**
   * Wire up the pause button and the mixer/rate sliders.
   */
  _bind: function() {
    var self = this;
    var audio = this.game.audio;

    this.el.pause.addEventListener('click', function() {
      self.paused = !self.paused;
      if (self.paused) {
        audio.pause();
        self.el.pause.innerHTML = 'RESUME';
      } else {
        audio.resume();
        self.el.pause.innerHTML = 'PAUSE';
      }
    }, false);

    this.el.busRain.addEventListener('input', function() {
      audio.busVolume('rain', parseFloat(this.value));
    }, false);
    this.el.busStorm.addEventListener('input', function() {
      audio.busVolume('storm', parseFloat(this.value));
    }, false);
    this.el.busSpeaker.addEventListener('input', function() {
      audio.busVolume('speaker', parseFloat(this.value));
    }, false);
    this.el.rate.addEventListener('input', function() {
      var rate = parseFloat(this.value);
      audio.rate(rate);
      self.el.rateValue.innerHTML = rate.toFixed(1);
    }, false);
  },

  /**
   * Refresh the numeric readout from the scene. The sample is shown as an
   * integer; while paused it stays on exactly the same number and continues
   * from that number on resume.
   */
  update: function() {
    var audio = this.game.audio;
    var levels = audio.levels();

    this.el.sample.innerHTML = String(audio.sample());
    this.el.rain.innerHTML = levels.rain.toFixed(4);
    this.el.thunder.innerHTML = levels.thunder.toFixed(4);
    this.el.lightning.innerHTML = levels.lightning.toFixed(4);
    this.el.speaker.innerHTML = levels.speaker.toFixed(4);
  }
};

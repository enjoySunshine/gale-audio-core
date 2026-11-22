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
 * Setup and control all of the game's audio.
 *
 * The four storm voices (rain, thunder, lightning, music/speaker) are all
 * scheduled through one HowlerScene on the single shared AudioContext. They
 * share one integer scene sample position, one decoded sprite buffer and
 * three mixer buses (rain / storm / speaker).
 */
var Sound = function() {
  var self = this;

  // The single decoded sprite buffer is shared by every voice.
  this.sound = new Howl({
    src: ['./assets/sprite.webm', './assets/sprite.mp3'],
    sprite: {
      lightning: [2000, 4147],
      rain: [8000, 9962, true],
      thunder: [19000, 13858],
      music: [34000, 31994, true]
    },
    volume: 1
  });

  // Three mixer buses. Rain stays dry (no panner), thunder and lightning share
  // the storm bus, and the speaker gets its own bus with the spatial rolloff.
  this.scene = new Howler.Scene({
    howl: this.sound,
    lead: 0.25,
    buses: {
      rain: 0.2,
      storm: 1,
      speaker: 1
    }
  });

  // Keep track of the currently active thunder voice.
  this._thunderId = null;
  this._nextThunderAt = null;

  // Speaker tiles are registered by Map.setup() before begin() is called, so
  // every speaker loop and the rain loop are scheduled together at sample 0.
  this._pendingSpeakers = [];

  this.scene.on('play', function() {
    self._scheduleThunder();
  });
};
Sound.prototype = {
  /**
   * Start the storm. Rain and every registered speaker begin together at
   * scene sample 0, scheduled 250ms ahead on the audio clock. Wall-clock time
   * spent decoding or waiting for the context to run does not consume the
   * lead, and the scene sample stays at 0 until the start time is reached.
   */
  begin: function() {
    var initial = [{sprite: 'rain', bus: 'rain', loop: true, volume: 1}];

    this._pendingSpeakers.forEach(function(opts) {
      initial.push(opts);
    });

    this.scene.start(initial);
  },

  /**
   * The shared scene position as an integer number of AudioContext samples.
   * @return {Number}
   */
  sample: function() {
    return this.scene.sample();
  },

  /**
   * Current post-attenuation loudness of each of the four displayed voices.
   * Values include bus gain and the Howler master gain, matching what is
   * actually rendered to the destination. Thunder and lightning share the
   * storm bus but are reported as their own per-voice loudness values.
   * @return {Object}
   */
  levels: function() {
    return {
      rain: this.scene.loudness('rain'),
      thunder: this._thunderId ? this.scene.voiceLoudness(this._thunderId) : 0,
      lightning: this._lightningId ? this.scene.voiceLoudness(this._lightningId) : 0,
      speaker: this.scene.loudness('speaker')
    };
  },

  /**
   * Pause the whole storm at its current scene sample. Looped rain and music
   * keep their buffer offsets; resume continues from the same integer sample.
   */
  pause: function() {
    this.scene.pause();
  },

  /**
   * Resume every still-active voice from the paused sample.
   */
  resume: function() {
    this.scene.resume();
  },

  /**
   * Get/set the scene-wide rate. Rain and music loops speed up together and
   * the scene sample advances at the new rate; per-voice lightning rates are
   * not affected (they are applied as their own multiplier on top).
   * @param  {Number} rate
   * @return {Number}
   */
  rate: function(rate) {
    if (typeof rate === 'number') {
      this.scene.rate(rate);
      return this;
    }
    return this.scene.rate();
  },

  /**
   * Get/set one of the three mixer bus volumes.
   * @param  {String} name Bus name: 'rain', 'storm' or 'speaker'.
   * @param  {Number} vol  (optional) 0.0 to 1.0.
   * @return {Number}
   */
  busVolume: function(name, vol) {
    return this.scene.busVolume(name, vol);
  },

  /**
   * Schedule the next thunder clap using scene time, so its trigger lands on
   * the current scene sample rather than wall-clock time.
   */
  _scheduleThunder: function() {
    var self = this;

    // Original cadence: 5 to 20 seconds of scene time between claps.
    var delaySamples = Math.round((5000 + Math.random() * 15000) / 1000 * Howler.ctx.sampleRate);
    self._nextThunderAt = self.sample() + delaySamples;
  },

  /**
   * Called every animation frame; fires thunder when its scene-sample trigger
   * point is reached. Nothing is scheduled while the scene is paused.
   */
  update: function() {
    var self = this;

    if (self.scene.paused() || self._nextThunderAt === null || self.sample() < self._nextThunderAt) {
      return;
    }

    self._nextThunderAt = null;
    self.thunder();
    self._scheduleThunder();
  },

  /**
   * Play a thunder sound in a random position on the storm bus.
   */
  thunder: function() {
    if (this.scene.paused()) {
      return;
    }

    var x = Math.round(100 * (2 - (Math.random() * 4))) / 100;
    var y = Math.round(100 * (2 - (Math.random() * 4))) / 100;

    // The trigger is anchored at the current scene sample; it can never pull
    // the scene clock backwards.
    this._thunderId = this.scene.play({
      sprite: 'thunder',
      bus: 'storm',
      volume: 1,
      pos: [x, y, -0.5]
    });
  },

  /**
   * Play lightning in a random location with a random rate/pitch. The random
   * rate is per-voice only; it never moves the shared scene sample.
   */
  lightning: function() {
    if (this.scene.paused()) {
      return;
    }

    var x = Math.round(100 * (2.5 - (Math.random() * 5))) / 100;
    var y = Math.round(100 * (2.5 - (Math.random() * 5))) / 100;
    var rate = Math.round(100 * (0.4 + (Math.random() * 1.25))) / 100;

    this._lightningId = this.scene.play({
      sprite: 'lightning',
      bus: 'storm',
      volume: 1,
      rate: rate,
      pos: [x, y, -0.5]
    });
  },

  /**
   * Register a speaker in 3D space to play music from. Called from Map.setup()
   * before the scene begins, so the music loop starts with the rain at sample
   * 0 and keeps looping without ever resetting the shared scene sample.
   * @param  {Number} x x-tile position of speaker.
   * @param  {Number} y y-tile position of speaker.
   */
  speaker: function(x, y) {
    this._pendingSpeakers.push({
      sprite: 'music',
      bus: 'speaker',
      loop: true,
      volume: 1,
      pos: [x + 0.5, y + 0.5, -0.5],
      pannerAttr: {
        panningModel: 'HRTF',
        refDistance: 0.8,
        rolloffFactor: 2.5,
        distanceModel: 'exponential'
      }
    });
  }
};

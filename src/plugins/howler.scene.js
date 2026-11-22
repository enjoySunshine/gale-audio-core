/*!
 *  Howler.js Scene Plugin - Sample-locked multi-voice scheduling on a shared
 *  AudioContext clock, with mixer buses and spatial panning.
 *
 *  howler.js v2.2.4
 *  howlerjs.com
 *
 *  (c) 2013-2020, James Simpson of GoldFire Studios
 *  goldfirestudios.com
 *
 *  MIT License
 */

(function() {

  'use strict';

  /**
   * A Scene locks every voice it schedules onto one integer sample position
   * derived from the shared Howler AudioContext. All timing is measured on the
   * audio clock, so suspending the context (or pausing the scene) never burns
   * samples and every voice resumes from the exact same sample.
   *
   * @param {Object} options
   *   howl  {Howl}   A loaded (or loading) Web Audio Howl whose decoded buffer
   *                   is shared by every voice.
   *   buses {Object} Named mixer buses, e.g. {rain: 1, storm: 0.8, speaker: 1}.
   *                  Each becomes a GainNode wired into Howler.masterGain.
   *   lead  {Number} Lead time in audio-clock seconds before the first voices
   *                  are started (defaults to 0.25). Only audio-clock time
   *                  after the context is running counts; wall-clock time spent
   *                  decoding or waiting for the context does not.
   */
  var HowlerScene = function(options) {
    var self = this;
    options = options || {};

    self._howl = options.howl;
    if (!Howler.ctx) {
      // Howler.volume() lazily creates the shared AudioContext.
      Howler.volume(Howler.volume());
    }
    self._ctx = Howler.ctx;
    self._rate = Howler.ctx.sampleRate;
    self._lead = typeof options.lead === 'number' ? options.lead : 0.25;

    // Scene clock state. The position is always an integer number of
    // AudioContext samples and is shared by every voice.
    self._running = false;
    self._paused = false;
    self._started = false;
    self._pauseSample = 0;
    self._anchorSample = 0;   // Scene sample corresponding to _anchorCtx.
    self._anchorCtx = 0;      // AudioContext.currentTime of the anchor.
    self._anchorRate = 1;     // Scene rate in effect at the anchor.
    self._sceneRate = 1;

    // Mixer buses: name -> {gain, volume, voices}.
    self._buses = {};

    // Voices keyed by their Howler Sound id.
    self._voices = {};

    // Scene-level event listeners.
    self._events = {play: [], pause: [], resume: [], end: [], rate: []};

    // Build the mixer buses on the shared context, downstream of the
    // Howler master gain so Howler.volume() still scales everything.
    var buses = options.buses || {};
    Object.keys(buses).forEach(function(name) {
      var node = Howler.ctx.createGain();
      node.gain.setValueAtTime(buses[name], Howler.ctx.currentTime);
      node.connect(Howler.masterGain);
      self._buses[name] = {node: node, volume: buses[name], voices: {}};
    });
  };

  HowlerScene.prototype = {
    /**
     * Current scene position as an integer number of AudioContext samples.
     * While decoding, waiting on the context, paused or inside the lead time
     * the position stays at (or freezes at) a whole sample.
     * @return {Number}
     */
    sample: function() {
      var self = this;

      if (!self._running || self._paused || !self._started) {
        return self._pauseSample;
      }

      var elapsed = (self._ctx.currentTime - self._anchorCtx) * self._anchorRate;
      var pos = Math.floor(self._anchorSample + elapsed * self._rate);
      return Math.max(0, pos);
    },

    /**
     * Whether the scene has begun and is currently paused.
     * @return {Boolean}
     */
    paused: function() {
      return !!(this._started && this._paused);
    },

    /**
     * Get/set the scene playback rate. Changing it re-anchors the scene sample
     * (the integer never jumps) and every active voice's source rate is scaled
     * together, so looped rain and music speed up together.
     * @param  {Number} rate (optional) New scene rate (e.g. 1.5).
     * @return {Number/HowlerScene}
     */
    rate: function(rate) {
      var self = this;

      if (typeof rate !== 'number') {
        return self._sceneRate;
      }

      if (self._started && self._running && !self._paused) {
        // Re-anchor at the current integer sample so the clock does not jump.
        self._anchorSample = self.sample();
        self._anchorCtx = self._ctx.currentTime;
        self._anchorRate = rate;
      }
      // While paused the anchor rate is refreshed by resume(), so changing
      // the scene rate here cannot move the frozen scene sample.

      self._sceneRate = rate;

      // Apply the combined rate (voice rate * scene rate) to every source.
      Object.keys(self._voices).forEach(function(id) {
        var voice = self._voices[id];
        if (voice._src && !voice._ended) {
          voice._src.playbackRate.setValueAtTime(self._effectiveRate(voice), self._ctx.currentTime);
        }
      });

      self._emit('rate', rate);
      return self;
    },

    /**
     * Get/set a mixer bus volume. A zero volume only touches the bus gain node;
     * no scene sample or voice offset is changed.
     * @param  {String} name Bus name.
     * @param  {Number} vol  (optional) 0.0 to 1.0.
     * @return {Number/HowlerScene}
     */
    busVolume: function(name, vol) {
      var self = this;
      var bus = self._buses[name];
      if (!bus) {
        return typeof vol === 'number' ? self : 0;
      }

      if (typeof vol === 'number') {
        bus.volume = vol;
        bus.node.gain.setValueAtTime(vol, self._ctx.currentTime);
        return self;
      }

      return bus.volume;
    },

    /**
     * Begin the scene. The initial voices are scheduled to start at
     * currentTime + lead on the audio clock. Wall-clock time spent before the
     * context is running (decoding, autoplay unlock wait) does not consume any
     * of the lead and the scene sample stays at 0 until start time.
     * @param  {Array} initial Voices to start at scene sample 0.
     * @return {HowlerScene}
     */
    start: function(initial) {
      var self = this;

      if (self._started) {
        return self;
      }

      var begin = function() {
        if (self._started) {
          return;
        }

        // Only audio-clock time after the context is actually running counts.
        // Ask Howler to unlock/resume the shared context (no-op when it is
        // already running) and wait until the audio clock is moving.
        if (self._ctx.state !== 'running') {
          Howler._autoResume();
          setTimeout(begin, 25);
          return;
        }

        self._started = true;
        self._running = true;
        self._paused = false;
        self._pauseSample = 0;
        self._anchorSample = 0;
        self._anchorRate = self._sceneRate;
        self._anchorCtx = self._ctx.currentTime + self._lead;

        (initial || []).forEach(function(opts) {
          self.play(opts);
        });

        self._emit('play');
      };

      if (self._howl._state === 'loaded') {
        begin();
      } else {
        // While the file is still decoding the scene sample remains at 0.
        self._howl.once('load', begin);
      }

      return self;
    },

    /**
     * Pause every voice at the current scene sample. Each voice's exact buffer
     * offset is captured before its source is stopped, so loops never reset and
     * a later resume continues from the same sample. Context suspension (e.g.
     * Howler's 30-second auto-suspend) freezes the audio clock and therefore
     * cannot consume any of the wait.
     * @return {HowlerScene}
     */
    pause: function() {
      var self = this;

      if (!self._running || self._paused) {
        return self;
      }

      var sample = self.sample();
      self._pauseSample = sample;
      self._paused = true;

      Object.keys(self._voices).forEach(function(id) {
        var voice = self._voices[id];
        if (!voice._src || voice._ended) {
          return;
        }

        // Capture this voice's exact offset in source-buffer samples.
        voice._offset = self._voiceOffset(voice, sample);
        voice._paused = true;
        voice._suppressEnd = true;
        try {
          voice._src.stop(0);
        } catch (e) {}
        voice._suppressEnd = false;
        self._howl._cleanBuffer(voice._node);
      });

      self._emit('pause', sample);
      return self;
    },

    /**
     * Resume every voice from the sample captured at pause. All sources are
     * (re)started at the same audio-clock position, keeping the four voices
     * locked to the same scene sample.
     * @return {HowlerScene}
     */
    resume: function() {
      var self = this;

      if (!self._paused) {
        return self;
      }

      var restart = function() {
        if (!self._paused) {
          return;
        }

        // A suspended context (e.g. Howler's 30-second auto-suspend) must be
        // resumed before sources can be scheduled; poll until it is running.
        if (self._ctx.state !== 'running') {
          if (typeof self._ctx.resume === 'function') {
            self._ctx.resume();
          }
          setTimeout(restart, 25);
          return;
        }

        var sample = self._pauseSample;
        // Re-anchor at "now" on the same integer sample. No lead is added
        // here: the 250ms lead only applies to the initial scene start, so
        // resume reads exactly the paused sample until audio time advances.
        self._anchorSample = sample;
        self._anchorCtx = self._ctx.currentTime;
        self._anchorRate = self._sceneRate;
        self._paused = false;
        self._running = true;

        Object.keys(self._voices).forEach(function(id) {
          var voice = self._voices[id];
          if (voice._ended) {
            return;
          }

          self._startSource(voice, voice._offset || 0, self._ctx.currentTime);
          voice._paused = false;
        });

        self._emit('resume', sample);
      };

      // Make sure the shared context is woken first; this also covers Howler's
      // automatic suspension after 30 seconds of silence.
      Howler._autoResume();
      restart();

      return self;
    },

    /**
     * Stop every voice, clear the end scanner and disconnect the mixer buses.
     * The shared AudioContext and the Howl's decoded buffer are left untouched,
     * so other Howl sounds keep playing unchanged.
     * @return {HowlerScene}
     */
    dispose: function() {
      var self = this;

      self.stop();

      if (self._scanner) {
        clearInterval(self._scanner);
        self._scanner = null;
      }

      Object.keys(self._buses).forEach(function(name) {
        try {
          self._buses[name].node.disconnect(0);
        } catch (e) {}
      });
      self._buses = {};
      self._voices = {};
      self._running = false;
      self._started = false;

      return self;
    },

    /**
     * Stop and release one voice (or every voice on a bus).
     * @param  {Number} id Howler Sound id of the voice to stop.
     * @return {HowlerScene}
     */
    stop: function(id) {
      var self = this;
      var ids = typeof id === 'number' ? [id] : Object.keys(self._voices);

      ids.forEach(function(key) {
        var voice = self._voices[key];
        if (!voice) {
          return;
        }

        if (voice._src) {
          voice._suppressEnd = true;
          try {
            voice._src.stop(0);
          } catch (e) {}
          voice._suppressEnd = false;
          self._howl._cleanBuffer(voice._node);
        }

        voice._paused = true;
        voice._ended = true;
        voice._src = null;
        delete self._voices[key];
        if (self._buses[voice._bus]) {
          delete self._buses[voice._bus].voices[key];
        }
      });

      return self;
    },

    /**
     * Schedule a sprite voice onto the scene clock. The voice is anchored at
     * the scene's current integer sample when this is called, so a late trigger
     * (thunder/lightning) never pulls the scene clock backwards.
     *
     * @param  {Object} opts
     *   sprite   {String}  Sprite name on the Howl.
     *   bus      {String}  Mixer bus to route the voice through.
     *   rate     {Number}  Per-voice rate multiplier (defaults to 1). The
     *                      effective rate is this * scene rate.
     *   loop     {Boolean} Override the sprite's loop flag.
     *   volume   {Number}  Voice gain (defaults to 1).
     *   pos      {Array}   [x, y, z] spatial position; creates a panner.
     *   pannerAttr {Object} PannerNode attributes for a positioned voice.
     * @return {Number} The Howler Sound id of the scheduled voice.
     */
    play: function(opts) {
      var self = this;
      var spriteDef = self._howl._sprite[opts.sprite];
      if (!spriteDef) {
        return null;
      }

      var voice = self._obtainVoice(opts.bus);
      var sprite = opts.sprite;
      var loop = typeof opts.loop === 'boolean' ? opts.loop : !!spriteDef[2];
      var rate = typeof opts.rate === 'number' ? opts.rate : 1;
      var volume = typeof opts.volume === 'number' ? opts.volume : 1;

      voice._sprite = sprite;
      voice._start = spriteDef[0] / 1000;
      voice._stop = (spriteDef[0] + spriteDef[1]) / 1000;
      voice._loop = loop;
      voice._rate = rate;
      voice._ended = false;
      voice._paused = false;
      voice._volume = volume;

      // Spatial panner (optional). Rain has no position and stays dry.
      if (opts.pos) {
        self._ensurePanner(voice, opts.pos, opts.pannerAttr);
      }

      var anchorSample = self.sample();
      var offset = Math.floor(voice._start * self._rate);

      voice._anchorSample = anchorSample;
      voice._anchorOffset = offset;
      voice._offset = offset;

      // One-shot voices remember the scene sample at which their sprite
      // window ends. The source itself is started without a fixed duration so
      // that rate changes and pause/resume cannot truncate it; the scanner
      // stops it precisely at this scene sample.
      if (!loop) {
        var spanSamples = Math.round((voice._stop - voice._start) * self._rate);
        voice._endSample = anchorSample + Math.round(spanSamples / self._rateOf(voice));
      } else {
        voice._endSample = null;
      }

      var when = self._whenForSample(anchorSample);
      self._startSource(voice, offset, when);

      self._voices[voice._id] = voice;
      self._buses[opts.bus].voices[voice._id] = voice;
      self._ensureScanner();

      return voice._id;
    },

    /**
     * Update the spatial position of a live voice without restarting it.
     * The panner node is reused, so the scene sample and every other voice
     * (rain, music loops) remain exactly where they were.
     * @param  {Number} id Voice sound id.
     * @param  {Number} x
     * @param  {Number} y
     * @param  {Number} z
     * @return {HowlerScene}
     */
    setPos: function(id, x, y, z) {
      var self = this;
      var voice = self._voices[id];
      if (!voice || !voice._panner) {
        return self;
      }

      voice._pos = [x, y, z];
      if (typeof voice._panner.positionX !== 'undefined') {
        voice._panner.positionX.setValueAtTime(x, self._ctx.currentTime);
        voice._panner.positionY.setValueAtTime(y, self._ctx.currentTime);
        voice._panner.positionZ.setValueAtTime(z, self._ctx.currentTime);
      } else {
        voice._panner.setPosition(x, y, z);
      }

      return self;
    },

    /**
     * Update panner attributes on a live voice (e.g. speaker rolloff).
     * @param  {Number} id   Voice sound id.
     * @param  {Object} attrs PannerNode attributes.
     * @return {HowlerScene}
     */
    setPannerAttr: function(id, attrs) {
      var self = this;
      var voice = self._voices[id];
      if (!voice || !voice._panner) {
        return self;
      }

      Object.keys(attrs).forEach(function(key) {
        voice._panner[key] = attrs[key];
        voice._pannerAttr[key] = attrs[key];
      });

      return self;
    },

    /**
     * Effective post-attenuation loudness of a bus right now. Positioned voices
     * include their panner's distance gain; voices without a panner (rain) are
     * never attenuated spatially. For buses with several voices (speakers) the
     * loudest voice is reported. The value includes the bus gain and the Howler
     * master gain, so it matches what is actually sent to the destination.
     * @param  {String} name Bus name.
     * @return {Number}
     */
    loudness: function(name) {
      var self = this;
      var bus = self._buses[name];
      if (!bus) {
        return 0;
      }

      var maxVoice = 0;
      Object.keys(bus.voices).forEach(function(id) {
        var voice = bus.voices[id];
        if (voice._ended || voice._paused) {
          return;
        }

        var gain = voice._volume;
        if (voice._panner) {
          gain *= self._distanceGain(voice);
        }
        if (gain > maxVoice) {
          maxVoice = gain;
        }
      });

      return maxVoice * bus.volume * Howler.volume();
    },

    /**
     * Effective post-attenuation loudness of one specific voice, including its
     * panner distance gain, its bus gain and the Howler master gain.
     * @param  {Number} id Voice sound id.
     * @return {Number}
     */
    voiceLoudness: function(id) {
      var self = this;
      var voice = self._voices[id];
      if (!voice || voice._ended || voice._paused) {
        return 0;
      }

      var gain = voice._volume;
      if (voice._panner) {
        gain *= self._distanceGain(voice);
      }

      var bus = self._buses[voice._bus];
      return gain * (bus ? bus.volume : 1) * Howler.volume();
    },

    /**
     * Register a scene event listener ('play', 'pause', 'resume', 'end', 'rate').
     * @param  {String}   event
     * @param  {Function} fn
     * @return {HowlerScene}
     */
    on: function(event, fn) {
      if (this._events[event] && typeof fn === 'function') {
        this._events[event].push(fn);
      }
      return this;
    },

    /**
     * Emit a scene event to all registered listeners.
     * @param  {String} event
     * @param  {*}      data
     * @return {HowlerScene}
     */
    _emit: function(event, data) {
      var self = this;
      if (!self._events[event]) {
        return self;
      }

      self._events[event].forEach(function(fn) {
        fn(data);
      });

      return self;
    },

    /**
     * Get an inactive Howler Sound from the Howl's pool and route its gain node
     * into the requested mixer bus. No new AudioBuffer is ever created; every
     * Sound references the single buffer decoded for the Howl's source.
     * @param  {String} busName
     * @return {Sound}
     */
    _obtainVoice: function(busName) {
      var self = this;
      var voice = self._howl._inactiveSound();

      // A recycled Sound may carry a panner from a previous spatial voice.
      // Drop it so non-spatial voices (rain) never inherit one, and so a new
      // spatial voice gets a panner with the correct attributes.
      if (voice._panner) {
        try {
          voice._panner.disconnect(0);
        } catch (e) {}
        voice._panner = undefined;
        voice._pannerAttr = undefined;
        voice._pos = undefined;
      }

      // Route voice gain node into the mixer bus instead of the master gain.
      voice._node.disconnect(0);
      voice._node.connect(self._buses[busName].node);
      voice._bus = busName;

      return voice;
    },

    /**
     * Create (or reuse) the PannerNode for a voice. The node is kept across
     * source rebuilds so mid-playback position changes never restart audio.
     * @param  {Sound}  voice
     * @param  {Array}  pos [x, y, z]
     * @param  {Object} pannerAttr
     */
    _ensurePanner: function(voice, pos, pannerAttr) {
      var self = this;

      if (!voice._panner) {
        var panner = Howler.ctx.createPanner();
        var defaults = {
          coneInnerAngle: 360,
          coneOuterAngle: 360,
          coneOuterGain: 0,
          distanceModel: 'inverse',
          maxDistance: 10000,
          panningModel: 'HRTF',
          refDistance: 1,
          rolloffFactor: 1
        };

        Object.keys(defaults).forEach(function(key) {
          var attr = pannerAttr || {};
          panner[key] = typeof attr[key] !== 'undefined' ? attr[key] : defaults[key];
        });

        panner.connect(voice._node);
        voice._panner = panner;
        voice._pannerAttr = pannerAttr || defaults;
      }

      voice._pos = [pos[0], pos[1], pos[2]];
      if (typeof voice._panner.positionX !== 'undefined') {
        voice._panner.positionX.setValueAtTime(pos[0], self._ctx.currentTime);
        voice._panner.positionY.setValueAtTime(pos[1], self._ctx.currentTime);
        voice._panner.positionZ.setValueAtTime(pos[2], self._ctx.currentTime);
      } else {
        voice._panner.setPosition(pos[0], pos[1], pos[2]);
      }
    },

    /**
     * Create a BufferSource for a voice through the Howl's standard buffer
     * refresh (which honors an existing panner connection) and start it at an
     * explicit audio-clock time with an explicit buffer offset.
     * @param  {Sound}  voice
     * @param  {Number} offsetSamples Source-buffer offset in whole samples.
     * @param  {Number} when          AudioContext time to start at.
     */
    _startSource: function(voice, offsetSamples, when) {
      var self = this;

      self._howl._refreshBuffer(voice);

      var src = voice._node.bufferSource;
      src.loop = voice._loop;
      if (voice._loop) {
        src.loopStart = voice._start;
        src.loopEnd = voice._stop;
      }

      var offsetSecs = offsetSamples / self._rate;

      voice._node.gain.setValueAtTime(voice._volume, self._ctx.currentTime);

      // Effective source rate is the voice multiplier times the scene rate.
      src.playbackRate.setValueAtTime(self._effectiveRate(voice), self._ctx.currentTime);

      src.onended = function() {
        // Suppressed while the scene itself is stopping/rebuilding the source.
        if (voice._suppressEnd) {
          return;
        }

        voice._ended = true;
        voice._paused = true;
        if (voice._src === src) {
          voice._src = null;
        }
        if (self._buses[voice._bus]) {
          delete self._buses[voice._bus].voices[voice._id];
        }
        delete self._voices[voice._id];
        self._emit('end', voice._id);
      };

      // No duration argument: looped sources wrap natively, and one-shot
      // sources are stopped by the scanner at their sprite end sample. That
      // keeps the end correct across rate changes and pause/resume.
      src.start(when, offsetSecs);

      voice._src = src;
    },

    /**
     * Start the scene-time scanner that ends one-shot voices exactly at their
     * sprite end sample. A single interval shared by all voices is driven by
     * the scene sample, so pausing the scene (or suspending the context) simply
     * prevents any end point from being reached early.
     */
    _ensureScanner: function() {
      var self = this;

      if (self._scanner) {
        return;
      }

      // 25ms keeps the one-shot cutoff well inside the gaps between sprite
      // regions while the scene sample itself stays sample-exact.
      self._scanner = setInterval(function() {
        if (!self._started || self._paused) {
          return;
        }

        var now = self.sample();
        Object.keys(self._voices).forEach(function(id) {
          var voice = self._voices[id];
          if (voice._loop || voice._ended || voice._endSample === null) {
            return;
          }

          if (now >= voice._endSample) {
            voice._suppressEnd = false;
            if (voice._src) {
              try {
                voice._src.stop(0);
              } catch (e) {}
            }
          }
        });
      }, 50);
    },

    /**
     * AudioContext time at which a given scene sample will be reached under
     * the current anchor and scene rate.
     * @param  {Number} sample
     * @return {Number}
     */
    _whenForSample: function(sample) {
      var self = this;
      return self._anchorCtx + ((sample - self._anchorSample) / self._rate) / self._anchorRate;
    },

    /**
     * A voice's exact source-buffer offset (whole samples) at a scene sample,
     * wrapping for looped voices so rain/music loops never reset the scene.
     * @param  {Sound}  voice
     * @param  {Number} sample
     * @return {Number}
     */
    _voiceOffset: function(voice, sample) {
      var self = this;
      var startSample = Math.floor(voice._start * self._rate);
      var spanSample = Math.round((voice._stop - voice._start) * self._rate);

      // Source samples advanced per scene sample = effective rate / scene rate,
      // i.e. the voice's own multiplier (the scene rate cancels out).
      var relSample = Math.round((sample - voice._anchorSample) * self._rateOf(voice));
      var delta = relSample + (voice._anchorOffset - startSample);

      if (voice._loop) {
        // Wrap inside the sprite window; the scene sample itself is untouched.
        var wrapped = ((delta % spanSample) + spanSample) % spanSample;
        return startSample + wrapped;
      }

      return voice._anchorOffset + relSample;
    },

    /**
     * The per-voice rate multiplier associated with a voice.
     * @param  {Sound} voice
     * @return {Number}
     */
    _rateOf: function(voice) {
      return typeof voice._rate === 'number' ? voice._rate : 1;
    },

    /**
     * The effective AudioBufferSource rate for a voice: its own multiplier
     * combined with the current scene rate.
     * @param  {Sound} voice
     * @return {Number}
     */
    _effectiveRate: function(voice) {
      return this._rateOf(voice) * this._sceneRate;
    },

    /**
     * Distance attenuation applied by a voice's panner, following the Web Audio
     * PannerNode distance models. This mirrors the gain the browser applies so
     * the displayed loudness matches the audio that is actually rendered.
     * @param  {Sound} voice
     * @return {Number}
     */
    _distanceGain: function(voice) {
      var self = this;
      var listener = Howler._pos || [0, 0, 0];
      var pos = voice._pos || [0, 0, 0];
      var dx = pos[0] - listener[0];
      var dy = pos[1] - listener[1];
      var dz = pos[2] - listener[2];
      var distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

      var attr = voice._pannerAttr || {};
      var model = attr.distanceModel || 'inverse';
      var ref = typeof attr.refDistance === 'number' ? attr.refDistance : 1;
      var rolloff = typeof attr.rolloffFactor === 'number' ? attr.rolloffFactor : 1;
      var max = typeof attr.maxDistance === 'number' ? attr.maxDistance : 10000;

      var gain;
      if (model === 'linear') {
        if (distance <= ref) {
          gain = 1;
        } else if (distance >= max) {
          gain = 0;
        } else {
          gain = 1 - rolloff * ((distance - ref) / (max - ref));
        }
        gain = Math.min(1, Math.max(0, gain));
      } else if (model === 'exponential') {
        gain = Math.pow(Math.max(distance, ref) / ref, -rolloff);
      } else {
        gain = ref / (ref + rolloff * Math.max(distance - ref, 0));
      }

      return gain;
    }
  };

  // Expose the scene controller on the shared Howler global.
  Howler.Scene = HowlerScene;

  // Module systems.
  if (typeof define === 'function' && define.amd) {
    define([], function() {
      return HowlerScene;
    });
  }

  if (typeof exports !== 'undefined') {
    exports.HowlerScene = HowlerScene;
  }

  if (typeof global !== 'undefined') {
    global.HowlerScene = HowlerScene;
  } else if (typeof window !== 'undefined') {
    window.HowlerScene = HowlerScene;
  }
})();
